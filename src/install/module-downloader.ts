/* eslint-disable no-useless-constructor */

import urljoin from 'url-join';
import path from 'path';
import { promisify } from 'util';
import fs from 'fs-extra';
import EventEmitter from 'events';
import Axios from 'axios';
import { FileDownloader } from './file-downloader';
import { DistributionModule, DistributionModuleFile } from '../types';
import TypedEventEmitter from '../typed-emitter';
import { FragmenterError } from '../errors';
import { FragmenterContext, FragmenterOperation } from '../core';

export interface ModuleDownloaderProgress {
    loaded: number,
    total: number,
    partLoaded: number,
    partTotal: number,
    partIndex: number,
    numParts: number,
}

export interface ModuleDownloaderEvents {
    'progress': (progress: ModuleDownloaderProgress) => void,
    'downloadInterrupted': (fromUserAction: boolean) => void,
    'error': (error: Error) => void,
}

export class ModuleDownloader extends (EventEmitter as new () => TypedEventEmitter<ModuleDownloaderEvents>) {
    constructor(
        private readonly ctx: FragmenterContext,
        private readonly baseUrl: string,
        private readonly module: DistributionModule,
        private readonly file: DistributionModuleFile,
        private readonly moduleIndex: number,
        private readonly retryCount: number,
        private readonly fullModuleHash: string,
    ) {
        // eslint-disable-next-line constructor-super
        super();
    }

    private probedModuleFileSize: number;

    async startDownload(destDir: string): Promise<boolean> {
        this.ctx.currentPhase = { op: FragmenterOperation.InstallModuleDownload, module: this.module, moduleIndex: this.moduleIndex };

        this.probedModuleFileSize = await this.probeModuleCompleteFileSize(this.file);

        const moduleSplitFileCount = this.file.splitFileCount;

        if (Number.isFinite(moduleSplitFileCount) && moduleSplitFileCount > 0) {
            this.ctx.logInfo(`[ModuleDownloader] Downloading module file '${this.module.name}' in ${moduleSplitFileCount} parts`);

            await this.downloadModuleFileParts(destDir, this.file);

            this.ctx.logTrace(`[ModuleDownloader] Done downloading module file '${this.module.name}'`);

            return this.mergeModuleFileParts(destDir, this.file);
        } else {
            this.ctx.logInfo(`[ModuleDownloader] Downloading module file '${this.module.name}'`);

            const ret = await this.downloadModuleFile(destDir, this.file);

            this.ctx.logTrace(`[ModuleDownloader] Done downloading module file '${this.module.name}'`);

            return ret;
        }
    }

    private async probeModuleCompleteFileSize(file: DistributionModuleFile) {
        const filePath = file.path;

        const url = urljoin(this.baseUrl, filePath);

        let headers;
        try {
            headers = (await Axios.head(url)).headers;

            const length = parseInt(headers['content-length']);

            if (Number.isFinite(length)) {
                return length;
            }
        } catch (e) {
            this.ctx.logWarn(`[ModuleDownloader] Could not probe module complete file size: ${e.message}`);

            // TODO register error in context
        }

        return undefined;
    }

    private async downloadModuleFile(destDir: string, file: DistributionModuleFile): Promise<boolean> {
        const fileUrl = urljoin(this.baseUrl, file.path);

        let url = `${fileUrl}?moduleHash=${file.hash.substring(0, 8)}&fullHash=${this.fullModuleHash.substring(0, 8)}`;

        if (this.retryCount) {
            url += `&retry=${this.retryCount}`;
        }

        const downloader = new FileDownloader(this.ctx, url, this.retryCount > 0);

        // eslint-disable-next-line no-loop-func
        downloader.on('progress', (loaded) => {
            this.emit('progress', {
                loaded,
                total: this.probedModuleFileSize ?? file.completeFileSize,
                partLoaded: undefined,
                partTotal: undefined,
                partIndex: undefined,
                numParts: undefined,
            });
        });

        downloader.on('downloadInterrupted', (fromUserAction) => {
            this.emit('downloadInterrupted', fromUserAction);
        });

        const filePath = path.join(destDir, `${this.module.name}.zip`);
        const fileDir = path.dirname(filePath);

        try {
            await fs.promises.opendir(fileDir);
        } catch (e) {
            await fs.promises.mkdir(fileDir);
        }

        try {
            const { error } = await downloader.download(filePath);

            if (error) {
                throw error;
            }

            return true;
        } catch (e) {
            this.ctx.logError(`[ModuleDownloader] module download at '${url}' failed`, e.message);

            if (this.ctx.unrecoverableErrorEncountered) {
                this.ctx.logInfo('[ModuleDownloader] file download error was unrecoverable - abandoning module download');
            }

            try {
                await fs.access(filePath);
                await promisify(fs.rm)(filePath);
            } catch (e) {
                // noop
            }

            throw e;
        }
    }

    private async downloadModuleFileParts(destDir: string, file: DistributionModuleFile): Promise<boolean> {
        const numParts = file.splitFileCount;

        let totalLoaded = 0;
        for (let i = 0; i < numParts; i++) {
            this.ctx.logTrace(`[ModuleDownloader] downloading module part #${i + 1}`);

            const partIndexString = (i + 1).toString()
                .padStart(numParts.toString().length, '0');
            const partFileSuffix = `sf-part${partIndexString}`;
            const partFilePath = `${file.path}.${partFileSuffix}`;

            const partUrl = urljoin(this.baseUrl, partFilePath);

            let url = `${partUrl}?moduleHash=${file.hash.substring(0, 8)}&fullHash=${this.fullModuleHash.substring(0, 8)}&partIndex=${i}`;

            if (this.retryCount) {
                url += `&retry=${this.retryCount}`;
            }

            const partDownloader = new FileDownloader(this.ctx, url, this.retryCount > 0);

            // eslint-disable-next-line no-loop-func
            partDownloader.on('progress', (loaded, total) => {
                this.emit('progress', {
                    loaded: totalLoaded + loaded,
                    total: this.probedModuleFileSize ?? file.completeFileSize,
                    partLoaded: loaded,
                    partTotal: total,
                    partIndex: i,
                    numParts: file.splitFileCount,
                });
            });

            partDownloader.on('downloadInterrupted', (fromUserAction) => {
                this.emit('downloadInterrupted', fromUserAction);
            });

            partDownloader.on('error', (error) => {
                this.emit('error', error);
            });

            const filePath = path.join(destDir, `${this.module.name}.zip.fg-tmp${partIndexString}`);
            const filePathDir = path.dirname(filePath);

            try {
                await fs.promises.opendir(filePathDir);
            } catch (e) {
                await fs.promises.mkdir(filePathDir);
            }

            try {
                const { bytesDownloaded, error } = await partDownloader.download(filePath);

                if (error) {
                    throw error;
                }

                totalLoaded += bytesDownloaded;
            } catch (e) {
                this.ctx.logError(`[ModuleDownloader] part download at '${url}' failed`, e.message);

                if (this.ctx.unrecoverableErrorEncountered) {
                    this.ctx.logError('[ModuleDownloader] file download error was unrecoverable - abandoning module download');
                }

                try {
                    await promisify(fs.rm)(filePath);
                } catch (e) {
                    // noop
                }

                throw e;
            }
        }

        return true;
    }

    private async mergeModuleFileParts(destDir: string, file: DistributionModuleFile): Promise<boolean> {
        this.ctx.logInfo(`[ModuleDownloader] Merging ${file.splitFileCount} file parts for module '${this.module.name}'`);

        const numParts = file.splitFileCount;

        for (let i = 0; i < numParts; i++) {
            const completeModuleFileWriteStream = fs.createWriteStream(path.join(destDir, `${this.module.name}.zip`), { flags: 'a' });

            const partIndexString = (i + 1).toString()
                .padStart(numParts.toString().length, '0');
            const filePath = path.join(destDir, `${this.module.name}.zip.fg-tmp${partIndexString}`);

            try {
                await fs.access(filePath);
            } catch (e) {
                this.ctx.logError(`[ModuleDownloader] Could not find module file part #${i + 1} at '${filePath}' - it must not have been downloaded correctly`);
                return false;
            }

            const partFileReadStream = fs.createReadStream(filePath);

            try {
                await new Promise((resolve, reject) => {
                    completeModuleFileWriteStream.on('close', resolve);

                    partFileReadStream.on('error', (e) => reject(FragmenterError.createFromError(e)));
                    completeModuleFileWriteStream.on('error', (e) => reject(FragmenterError.createFromError(e)));

                    partFileReadStream.pipe(completeModuleFileWriteStream);
                });
            } catch (e) {
                this.ctx.logError('[ModuleDownloader] File merge failed:', e.message);

                throw e;
            } finally {
                partFileReadStream.destroy();
                completeModuleFileWriteStream.destroy();
            }

            this.ctx.logTrace(`[ModuleDownloader] Merged file part #${i + 1}`);

            await promisify(fs.rm)(filePath);
        }

        return true;
    }
}
