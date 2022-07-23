import EventEmitter from 'events';
import { Unzip } from 'zip-lib';
import Axios from 'axios';
import urljoin from 'url-join';
import util, { promisify } from 'util';
import stream from 'stream';
import path from 'path';
import fs from 'fs-extra';
import * as os from 'os';
import { BASE_FILE, FULL_FILE, INSTALL_MANIFEST, SINGLE_MODULE_MANIFEST } from './constants';
import { DistributionModule, FragmenterInstallerEvents, InstallInfo, InstallManifest, InstallOptions, Module } from './types';
import TypedEventEmitter from './typed-emitter';
import { getLoggerSettingsFromOptions } from './log';
import { FragmenterUpdateChecker } from './checks';

export class FragmenterInstaller extends (EventEmitter as new () => TypedEventEmitter<FragmenterInstallerEvents>) {
    /**
     * @param source Base URL of the artifact server.
     * @param destDir Directory to install into.
     */
    constructor(private source: string, private destDir: string) {
        // eslint-disable-next-line constructor-super
        super();
    }

    /**
     * Install or update the newest available version.
     * @param options Advanced options for the install.
     * @param signal Abort signal
     */
    public async install(signal: AbortSignal, options?: InstallOptions): Promise<InstallInfo> {
        const [useInfoConsoleLog, useWarnConsoleLog, useErrorConsoleLog] = getLoggerSettingsFromOptions(options);

        const tempFolder = path.join(os.tmpdir(), `fbw-fragmenter-temp-${(Math.random() * 100_000).toFixed(0)}`);

        const logInfo = (module: Module | null, ...bits: any[]) => {
            if (useInfoConsoleLog) {
                console.log('[FRAGMENT]', ...bits);
            }
            this.emit('logInfo', module, ...bits);
        };

        const logWarn = (module: Module | null, ...bits: any[]) => {
            if (useWarnConsoleLog) {
                console.warn('[FRAGMENT]', ...bits);
            }
            this.emit('logWarn', module, ...bits);
        };

        const logError = (module: Module | null, ...bits: any[]) => {
            if (useErrorConsoleLog) {
                console.error('[FRAGMENT]', ...bits);
            }
            this.emit('logError', module, ...bits);
        };

        const validateCrc = (module: Module, targetCrc: string, actualCrc: string): boolean => {
            logInfo(module, 'Validating file CRC');
            logInfo(module, 'CRC should be', targetCrc, 'and is', actualCrc);

            return targetCrc === actualCrc;
        };

        const getUrlStream = async (url: string) => Axios.get(url, { responseType: 'stream' });

        const downloadFile = async (file: string, module: Module, retryCount: number, crc: string, fullCrc: string, tempFolder: string): Promise<string> => {
            logInfo(module, 'Downloading file', file);

            let url = urljoin(this.source, file);
            url += `?moduleHash=${crc.substring(0, 7)}&fullHash=${fullCrc.substring(0, 7)}`;

            if (retryCount) {
                url += `&retry=${retryCount}`;
            }

            if (options?.forceCacheBust) {
                url += `&forcedBust=${options.forceCacheBust}`;
            }

            if (retryCount || options?.forceCacheBust) {
                url += `&cache=${Math.random() * 999999999}`;
            }

            logInfo(module, 'Downloading from', url);

            const destPath = path.join(tempFolder, file);

            const writeStream = fs.createWriteStream(destPath);
            const readStream = await getUrlStream(url);

            await util.promisify(stream.pipeline)(readStream.data, writeStream);

            logInfo(module, 'Finished downloading file', file);

            return destPath;
        };

        const downloadAndInstall = async (file: string, destDir: string, module: Module, crc: string, fullCrc: string) => {
            let loadedFilePath: string;
            let tempExtractDir: string;

            const cleanup = async () => {
                try {
                    // Cleanup
                    if (fs.existsSync(loadedFilePath)) {
                        await promisify(fs.rm)(loadedFilePath);
                    }
                    if (fs.existsSync(tempExtractDir)) {
                        await promisify(fs.rm)(tempExtractDir, { recursive: true });
                    }
                } catch (e) {
                    this.emit('error', '[FRAGMENT] Error while cleaning up');
                }
            };

            let retryCount = 0;
            while (retryCount < 5 && !signal.aborted) {
                try {
                    this.emit('downloadStarted', module);

                    await fs.mkdir(tempFolder);

                    loadedFilePath = await downloadFile(file, module, retryCount, crc, fullCrc, tempFolder);

                    this.emit('downloadFinished', module);

                    logInfo(module, 'CRC was correct');

                    if (signal.aborted) {
                        return;
                    }

                    logInfo(module, 'Extracting ZIP to', destDir);

                    this.emit('unzipStarted', module);

                    // Extract zip file to temp directory
                    tempExtractDir = path.join(tempFolder, `extract-${path.parse(loadedFilePath).name}`);
                    const unzip = new Unzip();
                    await unzip.extract(loadedFilePath, tempExtractDir);

                    // Validate the CRC
                    const moduleJson = JSON.parse(fs.readFileSync(path.join(tempExtractDir, SINGLE_MODULE_MANIFEST)).toString()) as DistributionModule;
                    const actualCrc = moduleJson.hash;

                    if (actualCrc === undefined) {
                        throw new Error('module.json did not contain hash');
                    }

                    if (!validateCrc(module, crc, actualCrc)) {
                        logError(module, 'CRC wasn\'t correct');
                        throw new Error('Invalid CRC');
                    }

                    // Copy over extracted files to destination
                    await fs.copy(tempExtractDir, destDir);

                    this.emit('unzipFinished', module);

                    logInfo(module, 'Finished extracting ZIP to', destDir);

                    // Cleanup after ourselves

                    await cleanup();

                    return;
                } catch (e) {
                    logError(module, e);
                    retryCount++;
                    if (signal.aborted) {
                        throw new Error('User aborted');
                    }

                    logError(module, 'Retrying in', 2 ** retryCount, 'seconds');

                    this.emit('retryScheduled', module, retryCount, 2 ** retryCount);

                    // eslint-disable-next-line no-loop-func
                    await new Promise((r) => setTimeout(r, (2 ** retryCount) * 1_000));

                    this.emit('retryStarted', module, retryCount);
                }

                // Cleanup after ourselves

                await cleanup();
            }

            this.emit('error', `[FRAGMENT] Error while downloading ${module.name} module`);
            throw new Error(`[FRAGMENT] Error while downloading ${module.name} module`);
        };

        const done = (manifest: InstallManifest): InstallInfo => {
            const canceled = signal.aborted;

            if (!canceled) {
                const manifestPath = path.join(this.destDir, INSTALL_MANIFEST);

                logInfo(null, 'Writing install manifest', manifest, 'to', manifestPath);

                fs.writeJSONSync(manifestPath, manifest);

                logInfo(null, 'Finished writing install manifest', manifest, 'to', manifestPath);
            }

            return {
                changed: !canceled,
                manifest,
            };
        };

        // Create destination directory

        if (!fs.existsSync(this.destDir)) {
            fs.mkdirSync(this.destDir, { recursive: true });
        }

        logInfo(null, 'Finding modules to update');

        // Get modules to update

        const updateChecker = new FragmenterUpdateChecker();

        const updateInfo = await updateChecker.needsUpdate(
            this.source,
            this.destDir,
            { forceCacheBust: options?.forceCacheBust || options?.forceManifestCacheBust, useConsoleLog: options?.useConsoleLog ?? true },
        );

        logInfo(null, 'Update info', updateInfo);

        const allUpdated = updateInfo.updatedModules.length + updateInfo.removedModules.length === updateInfo.existingManifest?.modules.length;

        if (allUpdated) {
            logInfo(null, 'All modules scheduled for updating');
        }

        // Do fresh install using the full zip file if needed
        const fullInstall = async () => {
            logInfo(null, 'Performing fresh install');

            this.emit('fullDownload');

            if (fs.existsSync(this.destDir)) {
                logInfo(null, 'Cleaning destination directory', this.destDir);

                await promisify(fs.rm)(this.destDir, { recursive: true });
                await promisify(fs.mkdir)(this.destDir);
            }

            // TODO maybe we don't want to delete until we are sure the download went well - would need a 'staging' state of some sort
            await downloadAndInstall(FULL_FILE, this.destDir, {
                name: 'Full',
                sourceDir: '.',
            }, updateInfo.distributionManifest.fullHash, updateInfo.distributionManifest.fullHash);

            return done({ ...updateInfo.distributionManifest, source: this.source });
        };

        if (updateInfo.isFreshInstall || options?.forceFreshInstall || allUpdated) {
            return fullInstall();
        }

        // Get existing manifest
        const installManifestPath = path.join(this.destDir, INSTALL_MANIFEST);
        const oldInstallManifest: InstallManifest = await fs.readJSON(installManifestPath);

        logInfo(null, 'Found existing manifest', oldInstallManifest);

        // Exit when no update is needed
        if (!updateInfo.needsUpdate) {
            logInfo(null, 'No update needed');

            return {
                changed: false,
                manifest: oldInstallManifest,
            };
        }

        const newInstallManifest: InstallManifest = {
            modules: [],
            base: {
                hash: '',
                files: [],
            },
            fullHash: '',
            source: this.source,
        };

        // Delete all old base files and install new base files
        if (updateInfo.baseChanged) {
            try {
                logInfo(null, 'Updating base files');

                for (const file of oldInstallManifest.base.files) {
                    const fullPath = path.join(this.destDir, file);
                    if (fs.existsSync(fullPath)) {
                        fs.removeSync(fullPath);
                    }
                }

                await downloadAndInstall(BASE_FILE, this.destDir, {
                    name: 'Base',
                    sourceDir: '.',
                }, updateInfo.distributionManifest.base.hash, updateInfo.distributionManifest.fullHash);

                newInstallManifest.base = updateInfo.distributionManifest.base;
            } catch (error) {
                if (error.message.includes('Error while downloading') && !options.disableFallbackToFull) {
                    logError(error.message);
                    return fullInstall();
                }

                throw new Error(error.message);
            }
        } else {
            logInfo(null, 'No base update needed');

            newInstallManifest.base = oldInstallManifest.base;
        }

        newInstallManifest.modules = oldInstallManifest.modules;

        // Delete removed and updated modules
        logInfo(null, 'Removing changed and removed modules', [...updateInfo.removedModules, ...updateInfo.updatedModules]);

        for (const module of [...updateInfo.removedModules, ...updateInfo.updatedModules]) {
            logInfo(null, 'Removing module', module);

            const fullPath = path.join(this.destDir, module.sourceDir);

            if (fs.existsSync(fullPath)) {
                fs.rmdirSync(fullPath, { recursive: true });

                logInfo(null, 'Removed module', module);
            } else {
                logWarn(null, 'Module', module, 'marked for removal not found');
            }
            newInstallManifest.modules.splice(newInstallManifest.modules.findIndex((m) => m.name === module.name), 1);
        }

        // Install updated and added modules
        try {
            logInfo(null, 'Installing changed and added modules', [...updateInfo.updatedModules, ...updateInfo.addedModules]);

            for (const module of [...updateInfo.updatedModules, ...updateInfo.addedModules]) {
                const newModule = updateInfo.distributionManifest.modules.find((m) => m.name === module.name);

                logInfo(null, 'Installing new module', newModule);

                await downloadAndInstall(
                    `${newModule.name}.zip`,
                    path.join(this.destDir, newModule.sourceDir),
                    newModule,
                    newModule.hash,
                    updateInfo.distributionManifest.fullHash,
                );
                newInstallManifest.modules.push(newModule);
            }

            newInstallManifest.fullHash = updateInfo.distributionManifest.fullHash;

            return done(newInstallManifest);
        } catch (error) {
            if (error.message.includes('Error while downloading') && !options.disableFallbackToFull) {
                console.error(error.message);
                return fullInstall();
            }
            throw new Error(error.message);
        }
    }
}
