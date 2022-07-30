import EventEmitter from 'events';
import { Unzip } from 'zip-lib';
import Axios, { AxiosResponseHeaders } from 'axios';
import urljoin from 'url-join';
import { promisify } from 'util';
import stream from 'stream';
import path from 'path';
import fs from 'fs-extra';
import * as os from 'os';
import { BASE_FILE, FULL_FILE, INSTALL_MANIFEST, SINGLE_MODULE_MANIFEST } from './constants';
import { DistributionModule, FragmenterInstallerEvents, InstallInfo, InstallManifest, InstallOptions, Module } from './types';
import TypedEventEmitter from './typed-emitter';
import { getLoggerSettingsFromOptions } from './log';
import { FragmenterUpdateChecker } from './checks';
import { FragmenterError, FragmenterErrorCode } from './errors';

const DEFAULT_TEMP_DIRECTORY_PREFIX = 'fbw-fragmenter-temp';

export class FragmenterInstaller extends (EventEmitter as new () => TypedEventEmitter<FragmenterInstallerEvents>) {
    private readonly tempDir: string;

    private readonly logInfo: (module: Module | null, ...bits: any[]) => void;

    private readonly logWarn: (module: Module | null, ...bits: any[]) => void;

    private readonly logError: (module: Module | null, ...bits: any[]) => void;

    /**
     * @param source Base URL of the artifact server.
     * @param destDir Directory to install into.
     * @param signal Abort signal
     * @param options Advanced options for the install.
     */
    constructor(
        private source: string,
        private destDir: string,
        private signal: AbortSignal,
        private options?: InstallOptions,
    ) {
        // eslint-disable-next-line constructor-super
        super();

        this.tempDir = this.options?.temporaryDirectory ?? path.join(os.tmpdir(), `${DEFAULT_TEMP_DIRECTORY_PREFIX}-${(Math.random() * 1_000_000).toFixed(0)}`);

        const [useInfoConsoleLog, useWarnConsoleLog, useErrorConsoleLog] = getLoggerSettingsFromOptions(this.options);

        this.logInfo = (module: Module | null, ...bits: any[]) => {
            if (useInfoConsoleLog) {
                console.log('[FRAGMENT]', ...bits);
            }
            this.emit('logInfo', module, ...bits);
        };

        this.logWarn = (module: Module | null, ...bits: any[]) => {
            if (useWarnConsoleLog) {
                console.warn('[FRAGMENT]', ...bits);
            }
            this.emit('logWarn', module, ...bits);
        };

        this.logError = (module: Module | null, ...bits: any[]) => {
            if (useErrorConsoleLog) {
                console.error('[FRAGMENT]', ...bits);
            }
            this.emit('logError', module, ...bits);
        };
    }

    private async cleanupTempDir(): Promise<void> {
        console.log(null, 'Cleaning up temp directory');

        try {
            // Cleanup
            if (fs.existsSync(this.tempDir)) {
                await promisify(fs.rm)(this.tempDir, { recursive: true });
            }
        } catch (e) {
            this.emit('error', '[FRAGMENT] Error while cleaning up temp directory');
        }
    }

    /**
     * Install or update the newest available version.
     */
    public async install(): Promise<InstallInfo> {
        try {
            const info = await this.doInstall();

            this.cleanupTempDir().then();

            return info;
        } catch (e) {
            this.cleanupTempDir().then();

            if (e instanceof FragmenterError) {
                throw e;
            } else {
                throw FragmenterError.createFromError(e);
            }
        }
    }

    private async doInstall(): Promise<InstallInfo> {
        const createTempDirIfNeeded = async () => {
            try {
                if (!fs.existsSync(this.tempDir)) {
                    await fs.mkdir(this.tempDir);
                }
            } catch (e) {
                this.emit('error', '[FRAGMENT] Error while creating temp directory');
            }
        };

        const done = (manifest: InstallManifest): InstallInfo => {
            const canceled = this.signal.aborted;

            if (!canceled) {
                const manifestPath = path.join(this.destDir, INSTALL_MANIFEST);

                this.logInfo(null, 'Writing install manifest', manifest, 'to', manifestPath);

                fs.writeJSONSync(manifestPath, manifest);

                this.logInfo(null, 'Finished writing install manifest', manifest, 'to', manifestPath);
            }

            return {
                changed: !canceled,
                manifest,
            };
        };

        this.logInfo(null, 'Finding modules to update');

        // Get modules to update

        const updateChecker = new FragmenterUpdateChecker();

        const updateInfo = await updateChecker.needsUpdate(
            this.source,
            this.destDir,
            { forceCacheBust: this.options?.forceCacheBust || this.options?.forceManifestCacheBust, useConsoleLog: this.options?.useConsoleLog ?? true },
        );

        this.logInfo(null, 'Update info', updateInfo);

        const allUpdated = updateInfo.updatedModules.length + updateInfo.removedModules.length === updateInfo.existingManifest?.modules.length;

        if (allUpdated) {
            this.logInfo(null, 'All modules scheduled for updating');
        }

        // Do fresh install using the full zip file if needed
        const fullInstall = async () => {
            this.logInfo(null, 'Performing fresh install');

            this.emit('fullDownload');

            // TODO maybe we don't want to delete until we are sure the download went well - would need a 'staging' state of some sort (current handled in installer)
            if (fs.existsSync(this.destDir)) {
                this.logInfo(null, 'Cleaning destination directory', this.destDir);

                await promisify(fs.rm)(this.destDir, { recursive: true });
                await promisify(fs.mkdir)(this.destDir);
            }

            await createTempDirIfNeeded();

            await this.downloadAndInstallModuleFile(FULL_FILE, this.destDir, {
                name: 'Full',
                sourceDir: '.',
                hash: updateInfo.distributionManifest.fullHash,
                splitFileCount: updateInfo.distributionManifest.fullSplitFileCount,
            }, updateInfo.distributionManifest.fullHash);

            return done({ ...updateInfo.distributionManifest, source: this.source });
        };

        if (updateInfo.isFreshInstall || this.options?.forceFreshInstall || allUpdated) {
            return fullInstall();
        }

        // Get existing manifest
        const installManifestPath = path.join(this.destDir, INSTALL_MANIFEST);
        const oldInstallManifest: InstallManifest = await fs.readJSON(installManifestPath);

        this.logInfo(null, 'Found existing manifest', oldInstallManifest);

        // Exit when no update is needed
        if (!updateInfo.needsUpdate) {
            this.logInfo(null, 'No update needed');

            return {
                changed: false,
                manifest: oldInstallManifest,
            };
        }

        await createTempDirIfNeeded();

        const newInstallManifest: InstallManifest = {
            modules: [],
            base: {
                hash: '',
                files: [],
                splitFileCount: 0,
            },
            fullHash: '',
            fullSplitFileCount: 0,
            source: this.source,
        };

        // Delete all old base files and install new base files
        if (updateInfo.baseChanged) {
            try {
                this.logInfo(null, 'Updating base files');

                for (const file of oldInstallManifest.base.files) {
                    const fullPath = path.join(this.destDir, file);
                    if (fs.existsSync(fullPath)) {
                        fs.removeSync(fullPath);
                    }
                }

                await this.downloadAndInstallModuleFile(BASE_FILE, this.destDir, {
                    name: 'Base',
                    sourceDir: '.',
                    hash: updateInfo.distributionManifest.base.hash,
                    splitFileCount: updateInfo.distributionManifest.base.splitFileCount,
                }, updateInfo.distributionManifest.fullHash);

                newInstallManifest.base = updateInfo.distributionManifest.base;
            } catch (error) {
                const isMaxRetriesReached = error instanceof FragmenterError && error.code === FragmenterErrorCode.MaxModuleRetries;

                if (isMaxRetriesReached && !this.options?.disableFallbackToFull) {
                    return fullInstall();
                }

                throw error;
            }
        } else {
            this.logInfo(null, 'No base update needed');

            newInstallManifest.base = oldInstallManifest.base;
        }

        newInstallManifest.modules = oldInstallManifest.modules;

        // Delete removed and updated modules
        this.logInfo(null, 'Removing changed and removed modules', [...updateInfo.removedModules, ...updateInfo.updatedModules]);

        for (const module of [...updateInfo.removedModules, ...updateInfo.updatedModules]) {
            this.logInfo(null, 'Removing module', module);

            const fullPath = path.join(this.destDir, module.sourceDir);

            if (fs.existsSync(fullPath)) {
                fs.rmSync(fullPath, { recursive: true });

                this.logInfo(null, 'Removed module', module);
            } else {
                this.logWarn(null, 'Module', module, 'marked for removal not found');
            }

            newInstallManifest.modules.splice(newInstallManifest.modules.findIndex((m) => m.name === module.name), 1);
        }

        // Install updated and added modules
        try {
            this.logInfo(null, 'Installing changed and added modules', [...updateInfo.updatedModules, ...updateInfo.addedModules]);

            for (const module of [...updateInfo.updatedModules, ...updateInfo.addedModules]) {
                const newModule = updateInfo.distributionManifest.modules.find((m) => m.name === module.name);

                this.logInfo(null, 'Installing new module', newModule);

                newInstallManifest.modules.push(newModule);

                await this.downloadAndInstallModuleFile(
                    `${newModule.name}.zip`,
                    path.join(this.destDir, newModule.sourceDir),
                    newModule,
                    updateInfo.distributionManifest.fullHash,
                );
            }

            newInstallManifest.fullHash = updateInfo.distributionManifest.fullHash;

            return done(newInstallManifest);
        } catch (error) {
            const isMaxRetriesReached = error instanceof FragmenterError && error.code === FragmenterErrorCode.MaxModuleRetries;

            if (isMaxRetriesReached && !this.options?.disableFallbackToFull) {
                return fullInstall();
            }

            throw error;
        }
    }

    /**
     * Gets a download stream from an URL
     *
     * @param url the URL
     */
    private async getUrlStream(url: string) {
        const stream = (await Axios.get<stream.Readable>(url, { responseType: 'stream', signal: this.signal }));

        // eslint-disable-next-line no-undef
        this.signal.addEventListener('abort', () => {
            stream.data.destroy();
        });

        return stream;
    }

    /**
     * Gets headers from a url using a HEAD request
     *
     * @param url the URL
     */
    private async getUrlHead(url: string): Promise<AxiosResponseHeaders> {
        const data = await Axios.head(url);

        return data.headers;
    }

    /**
     * Download a file and return the destination path
     *
     * @param file       the name of the module file to download, appended to the end of the base URL
     * @param module     the module object for the file
     * @param retryCount the current amount of retries we are on
     * @param crc        the declared module crc
     * @param fullCrc    the declared module crc of the full module
     * @param tempFolder the temporary folder to download into
     */
    private async downloadModuleFile(file: string, module: DistributionModule, retryCount: number, crc: string, fullCrc: string, tempFolder: string): Promise<string> {
        this.logInfo(module, 'Downloading file', file, 'into temporary directory', tempFolder);

        const makeUrl = (fileUrl: string) => {
            let url = fileUrl;

            url += `?moduleHash=${crc.substring(0, 7)}&fullHash=${fullCrc.substring(0, 7)}`;

            if (retryCount) {
                url += `&retry=${retryCount}`;
            }

            if (this.options?.forceCacheBust) {
                url += `&forcedBust=${this.options.forceCacheBust}`;
            }

            if (retryCount || this.options?.forceCacheBust) {
                url += `&cache=${Math.random() * 999999999}`;
            }

            return url;
        };

        const destPath = path.join(tempFolder, file);

        if (module.splitFileCount > 1) {
            this.logInfo(module, `Downloading file ${file} in ${module.splitFileCount} parts`);

            // Attempt to get the size of the complete module
            const fullFileUrl = makeUrl(urljoin(this.source, file));

            let headers;
            let completeModuleSize: number;
            try {
                headers = await this.getUrlHead(fullFileUrl);

                completeModuleSize = parseInt(headers['content-length']);
            } catch (e) {
                this.logWarn(module, `Could not make HEAD request to ${fullFileUrl} to get total module size. See exception below`);
                this.logError(module, e);
            }

            let completeLoaded = 0;
            for (let i = 0; i < module.splitFileCount; i++) {
                this.logInfo(module, `Downloading module part ${i + 1}/${module.splitFileCount}`);

                const paddedPartIndex = (i + 1).toString().padStart(module.splitFileCount.toString().length, '0');
                const fileSuffix = `.sf-part${paddedPartIndex}`;
                const baseFilePartUrl = urljoin(this.source, file) + fileSuffix;
                const downloadUrl = makeUrl(baseFilePartUrl);

                this.logInfo(module, `Downloading from ${downloadUrl}`);

                const writeStream = fs.createWriteStream(destPath, { flags: 'a' });

                const response = await this.getUrlStream(makeUrl(baseFilePartUrl));

                let loaded = 0;
                const partSize = parseInt(response.headers['content-length']);

                if (Number.isNaN(completeModuleSize) || Number.isNaN(partSize)) {
                    this.logWarn(module, 'Server did not return Content-Length header - no download progress will be reported');
                }

                let lastPercent = -1;
                let lastCompletePercent = -1;

                // eslint-disable-next-line no-loop-func
                response.data.on('data', (buffer: Buffer) => {
                    if (!Number.isNaN(completeModuleSize) && !Number.isNaN(partSize)) {
                        loaded += buffer.length;
                        completeLoaded += buffer.length;

                        const percent = Math.floor((loaded / partSize) * 100);
                        const completePercent = Math.floor((completeLoaded / completeModuleSize) * 100);

                        if (lastPercent !== percent || lastCompletePercent !== completePercent) {
                            this.emit('downloadProgress',
                                module,
                                {
                                    loaded: completeLoaded,
                                    total: completeModuleSize,
                                    percent: completePercent,
                                    partLoaded: loaded,
                                    partTotal: partSize,
                                    partPercent: percent,
                                    partIndex: i,
                                    numParts: module.splitFileCount,
                                });
                        }

                        lastPercent = percent;
                        lastCompletePercent = completePercent;
                    }
                });

                response.data.pipe(writeStream);

                response.data.on('close', () => {
                    if (this.signal.aborted) {
                        this.logError(module, 'AbortSignal triggered');
                        throw FragmenterError.create(FragmenterErrorCode.UserAborted, 'AbortSignal triggered during download');
                    }
                });

                await new Promise<void>((resolve) => {
                    response.data.on('end', () => {
                        resolve();
                    });
                });

                this.logInfo(module, `Finished downloading file part ${i + 1}/${module.splitFileCount}`);
            }

            this.logInfo(module, `Finished downloading file ${file}`);
        } else {
            const writeStream = fs.createWriteStream(destPath);

            const baseFilePartUrl = urljoin(this.source, file);
            const downloadUrl = makeUrl(baseFilePartUrl);

            const response = await this.getUrlStream(downloadUrl);

            let loaded = 0;
            const total = parseInt(response.headers['content-length']);

            if (Number.isNaN(total)) {
                this.logWarn(module, 'Server did not return Content-Length header - no download progress will be reported');
            }

            let lastPercent = -1;

            response.data.on('data', (buffer: Buffer) => {
                if (!Number.isNaN(total)) {
                    loaded += buffer.length;

                    const percent = Math.floor((loaded / total) * 100);

                    if (lastPercent !== percent) {
                        this.emit('downloadProgress', module, { loaded, total, percent });
                    }

                    lastPercent = percent;
                }
            });

            response.data.pipe(writeStream);

            response.data.on('close', () => {
                if (this.signal.aborted) {
                    this.logError(module, 'AbortSignal triggered');
                    throw FragmenterError.create(FragmenterErrorCode.UserAborted, 'AbortSignal triggered during download');
                }
            });

            await promisify(response.data.on)('end');

            this.logInfo(module, 'Finished downloading file', file);
        }

        return destPath;
    }

    private validateCrc(module: Module, targetCrc: string, actualCrc: string): boolean {
        this.logInfo(module, 'Validating file CRC');
        this.logInfo(module, 'CRC should be', targetCrc, 'and is', actualCrc);

        return targetCrc === actualCrc;
    }

    private async downloadAndInstallModuleFile(file: string, destDir: string, module: DistributionModule, fullCrc: string) {
        let moduleZipPath: string;
        let tempExtractDir: string;

        let retryCount = 0;
        while (retryCount < 5 && !this.signal.aborted) {
            try {
                this.emit('downloadStarted', module);

                moduleZipPath = await this.downloadModuleFile(file, module, retryCount, module.hash, fullCrc, this.tempDir);

                if (retryCount === 0) {
                    throw new Error('bruh fake error');
                }

                this.emit('downloadFinished', module);

                if (this.signal.aborted) {
                    return;
                }

                this.emit('unzipStarted', module);

                // Extract zip file to temp directory
                tempExtractDir = path.join(this.tempDir, `extract-${path.parse(moduleZipPath).name}`);

                this.logInfo(module, 'Extracting ZIP to', tempExtractDir);

                const unzip = new Unzip();
                await unzip.extract(moduleZipPath, tempExtractDir);

                // Validate the CRC
                const moduleJson = JSON.parse(fs.readFileSync(path.join(tempExtractDir, SINGLE_MODULE_MANIFEST)).toString()) as DistributionModule;
                const actualCrc = moduleJson.hash;

                if (actualCrc === undefined) {
                    throw FragmenterError.create(FragmenterErrorCode.ModuleJsonInvalid, 'module.json did not contain hash');
                }

                if (!this.validateCrc(module, module.hash, actualCrc)) {
                    throw FragmenterError.create(
                        FragmenterErrorCode.ModuleCrcMismatch,
                        `module CRC incorrect: should be '${module.hash.substring(0, 8)}...' and was '${actualCrc.substring(0, 8)}..'`,
                    );
                } else {
                    this.logInfo(module, 'CRC was correct');
                }

                this.emit('unzipFinished', module);
                this.logInfo(module, 'Finished extracting ZIP to', tempExtractDir);

                // Copy over extracted files to destination

                this.emit('copyStarted', module);
                this.logInfo(module, 'Copying files to', destDir);

                await fs.copy(tempExtractDir, destDir, { recursive: true });

                this.emit('copyFinished', module);
                this.logInfo(module, 'Finished copying files to', destDir);

                return;
            } catch (e) {
                if (e instanceof FragmenterError && e.code === FragmenterErrorCode.UserAborted) {
                    throw e;
                } else if (this.signal.aborted) {
                    this.logError(module, 'AbortSignal triggered');

                    throw FragmenterError.create(
                        FragmenterErrorCode.UserAborted,
                        'AbortSignal triggered after retry scheduled',
                    );
                } else {
                    this.emit('error', e);
                }

                // Cleanup after ourselves for the next retry

                if (fs.existsSync(moduleZipPath)) {
                    fs.rmSync(moduleZipPath);
                }

                if (fs.existsSync(tempExtractDir)) {
                    fs.rmSync(tempExtractDir, { recursive: true });
                }

                retryCount++;

                const retryIn = 2 ** retryCount;

                this.emit('retryScheduled', module, retryCount, retryIn);
                this.logError(module, 'Retrying in', retryIn, 'seconds');

                // eslint-disable-next-line no-loop-func
                await new Promise((r) => setTimeout(r, retryIn * 1_000));

                this.emit('retryStarted', module, retryCount);
            }
        }

        throw FragmenterError.create(
            FragmenterErrorCode.MaxModuleRetries,
            `max number of retries reached for module '${module.name}'`,
        );
    }
}
