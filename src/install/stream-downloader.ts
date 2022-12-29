import EventEmitter from 'events';
import fs from 'fs-extra';
import Axios, { AxiosRequestHeaders, AxiosResponse } from 'axios';
import stream from 'stream';
import TypedEventEmitter from '../typed-emitter';
import { FragmenterError, FragmenterErrorCode, UnrecoverableErrors } from '../errors';
import { FragmenterContext } from '../core';

export interface StreamDownloaderEvents {
    'progress': (loaded: number) => void,
    'error': (error: any) => void,
}

export interface StreamDownloaderResult {
    bytesWritten: number,
    error?: FragmenterError,
}

export class StreamDownloader extends (EventEmitter as new () => TypedEventEmitter<StreamDownloaderEvents>) {
    constructor(
        private readonly ctx: FragmenterContext,
        private readonly downloadUrl: string,
    ) {
        // eslint-disable-next-line constructor-super
        super();
    }

    async downloadFrom(startIndex: number, writeStream: fs.WriteStream): Promise<StreamDownloaderResult> {
        const ret: StreamDownloaderResult = {
            bytesWritten: 0,
            error: undefined,
        };

        this.ctx.logTrace(`[StreamDownloader] streaming file bytes(${startIndex}-) at '${this.downloadUrl}'`);

        let downloadStream: AxiosResponse<stream.Readable>;
        try {
            // TODO add cache-busting parameters
            downloadStream = await this.getReadStream(startIndex, this.downloadUrl);
        } catch (e) {
            this.emit('error', e);

            this.ctx.logError('[StreamDownloader] File streaming could not be started:', e.message);

            writeStream.destroy();

            // todo warn

            return {
                bytesWritten: 0,
                error: FragmenterError.createFromError(e),
            };
        }

        try {
            await new Promise((resolve, reject) => {
                writeStream.on('close', resolve);

                downloadStream.data.on('close', () => {
                    if (this.ctx.signal.aborted) {
                        reject(FragmenterError.create(FragmenterErrorCode.UserAborted, 'AbortSignal triggered'));
                    }
                });

                downloadStream.data.on('data', (buffer: Buffer) => {
                    ret.bytesWritten += buffer.length;

                    this.emit('progress', ret.bytesWritten);
                });

                downloadStream.data.on('error', (e) => {
                    this.ctx.logError('[StreamDownloader] download stream interrupted:', e.message);

                    reject(FragmenterError.createFromError(e));
                });

                writeStream.on('error', (e) => {
                    this.ctx.logError('[StreamDownloader] write stream interrupted:', e.message);

                    reject(FragmenterError.createFromError(e));
                });

                downloadStream.data.pipe(writeStream);
            });
        } catch (e) {
            ret.error = e;

            if (FragmenterError.isFragmenterError(e) && UnrecoverableErrors.includes(e.code)) {
                this.ctx.logError(`[StreamDownloader] stream download error is unrecoverable (${FragmenterErrorCode[e.code]}) - not trying to resume the download`);

                this.ctx.unrecoverableErrorEncountered = true;
            }
        } finally {
            downloadStream.data.destroy();
            writeStream.destroy();
        }

        return ret;
    }

    private async getReadStream(startIndex: number, url: string): Promise<AxiosResponse<stream.Readable>> {
        const headers: AxiosRequestHeaders = {};

        if (startIndex !== 0) {
            headers.Range = `bytes=${startIndex}-`;
        }

        const response = await Axios.get(url, {
            headers,
            responseType: 'stream',
            signal: this.ctx.signal,
        });

        this.ctx.signal.addEventListener('abort', () => {
            response.data.destroy();
        });

        return response;
    }
}
