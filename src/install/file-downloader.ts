import EventEmitter from 'events';
import fs from 'fs-extra';
import Axios, { AxiosResponse } from 'axios';
import stream from 'stream';
import { Buffer } from 'buffer';
import TypedEventEmitter from '../typed-emitter';
import { StreamDownloader } from './stream-downloader';
import { timer } from '../utils';
import { FragmenterError, FragmenterErrorCode } from '../errors';
import { FragmenterContext } from '../core';

export interface FileDownloaderEvents {
    'progress': (loaded: number, total: number | undefined) => void,
    'downloadInterrupted': (fromUserAction: boolean) => void,
    'error': (error: Error) => void,
}

export interface FileDownloaderResult {
    bytesDownloaded: number,
    error?: FragmenterError,
}

export class FileDownloader extends (EventEmitter as new () => TypedEventEmitter<FileDownloaderEvents>) {
    constructor(
        private readonly ctx: FragmenterContext,
        private readonly fileUrl: string,
        private readonly forceCacheBust: boolean,
    ) {
        // eslint-disable-next-line constructor-super
        super();
    }

    async download(dest: string): Promise<FileDownloaderResult> {
        let url = this.fileUrl;

        if (this.forceCacheBust || this.ctx.options.forceCacheBust) {
            url += `&cache=${Math.round(Math.random() * 999999999)}`;
        }

        this.ctx.logInfo(`[FileDownloader] Downloading file at '${url}'`);

        const ret: FileDownloaderResult = {
            bytesDownloaded: 0,
            error: undefined,
        };

        const headData = await FileDownloader.getHeaders(url);

        let fileSize: number | undefined;
        const contentLength = parseInt(headData.headers['content-length']);

        if (!Number.isFinite(contentLength)) {
            // todo warn
        } else {
            fileSize = contentLength;
        }

        const serverSupportsRanges = headData.headers['accept-ranges']?.includes('bytes') ?? false;
        if (!serverSupportsRanges) {
            this.ctx.logWarn('[FileDownloader] Server does not seem to support byte ranges - file download retries will be less less efficient');
        }

        const fileStreamDownloader = new StreamDownloader(this.ctx, url);

        let loadedBytes = 0;
        let retryCount = 0;

        if (serverSupportsRanges) {
            fileStreamDownloader.on('progress', (progress) => {
                this.emit('progress', loadedBytes + progress, fileSize);
            });

            fileStreamDownloader.on('error', (error) => {
                this.emit('error', error);
            });

            const fileChunks: Buffer[] = [];

            while (retryCount < 5) {
                const { buffers, error } = await fileStreamDownloader.downloadFrom(loadedBytes);

                fileChunks.push(...buffers);

                loadedBytes = fileChunks.reduce((acc, buf) => acc + buf.length, 0);

                if (loadedBytes >= fileSize) {
                    break;
                } else {
                    if (this.ctx.signal.aborted) {
                        throw FragmenterError.create(FragmenterErrorCode.UserAborted, 'AbortSignal triggered');
                    }

                    const downloadPercentage = Math.round((loadedBytes / fileSize) * 100);

                    if (this.ctx.unrecoverableErrorEncountered) {
                        this.ctx.logError('[FileDownloader] stream download error was unrecoverable - abandoning file download');

                        ret.error = error;
                        break;
                    }

                    this.emit('downloadInterrupted', false);

                    if (error) {
                        this.emit('error', error);
                    }

                    this.ctx.logInfo(`[FileDownloader] file not entirely downloaded (${downloadPercentage}%, ${loadedBytes}/${fileSize}) - retrying in ${2 ** retryCount}s`);
                }

                retryCount++;

                await timer(2 ** retryCount * 1_000);
            }

            if (loadedBytes < fileSize) {
                if (!ret.error) {
                    ret.error = FragmenterError.create(
                        FragmenterErrorCode.MaxModuleRetries,
                        'File not entirely downloaded - max number of download resumes reached or unrecoverable error detected',
                    );
                }
            }

            await fs.writeFile(dest, Buffer.concat(fileChunks));
        } else {
            fileStreamDownloader.on('progress', (progress) => {
                this.emit('progress', progress, fileSize);
            });

            const fileChunks: Buffer[] = [];

            while (retryCount < 5) {
                fileChunks.length = 0; // We are not downloading ranges, so reset the file chunks

                const { buffers, error } = await fileStreamDownloader.downloadFrom(0);

                fileChunks.push(...buffers);

                loadedBytes = fileChunks.reduce((acc, buf) => acc + buf.length, 0);

                if (loadedBytes >= fileSize) {
                    break;
                } else {
                    const downloadPercentage = Math.round((loadedBytes / fileSize) * 100);

                    this.ctx.logInfo(`[FileDownloader] file not entirely downloaded (${downloadPercentage}%, ${loadedBytes}/${fileSize}) - retrying in ${2 ** retryCount}s`);

                    if (this.ctx.unrecoverableErrorEncountered) {
                        ret.error = error;
                        break;
                    }
                }

                retryCount++;

                await timer(2 ** retryCount * 1_000);
            }

            if (loadedBytes < fileSize) {
                if (!ret.error) {
                    ret.error = FragmenterError.create(
                        FragmenterErrorCode.MaxModuleRetries,
                        'File not entirely downloaded - max number of download restarts reached',
                    );
                }
            }

            await fs.writeFile(dest, Buffer.concat(fileChunks));
        }

        ret.bytesDownloaded = loadedBytes;
        return ret;
    }

    private static async getHeaders(url: string): Promise<AxiosResponse<stream.Readable>> {
        return Axios.head(url);
    }
}
