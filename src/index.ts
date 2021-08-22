import fs from 'fs-extra';
import AdmZip from 'adm-zip';
import path from 'path';
import urljoin from 'url-join';
import * as util from 'util';
import EventEmitter from 'events';
import {
    CrcInfo,
    FragmenterInstallerEvents,
    InstallInfo,
    InstallManifest, InstallOptions,
    Module,
} from './types';
import TypedEventEmitter from './typed-emitter';
import { BASE_FILE, FULL_FILE, INSTALL_MANIFEST, SINGLE_MODULE_MANIFEST } from './constants';
import { needsUpdate } from './checks';

export * from './types';
export * from './packer';
export * from './checks';

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
        const validateCrc = (targetCrc: string, zipFile: AdmZip): boolean => {
            console.log('[FRAGMENT] Validating file CRC');
            const moduleFile: CrcInfo = JSON.parse(zipFile.readAsText(SINGLE_MODULE_MANIFEST));
            console.log('[FRAGMENT] CRC should be', targetCrc, 'and is', moduleFile.hash);

            return targetCrc === moduleFile.hash;
        };

        const validateCrcOrThrow = (targetCrc: string, zipFile: AdmZip): void => {
            if (!validateCrc(targetCrc, zipFile)) {
                console.log('[FRAGMENT] CRC wasn\'t correct');
                throw new Error('Invalid CRC');
            }
        };

        const downloadFile = async (file: string, module: Module, retryCount: number, crc: string, fullCrc: string): Promise<Buffer> => {
            console.log('[FRAGMENT] Downloading file', file);
            let url = urljoin(this.source, file);
            url += `?moduleHash=${crc.substr(0, 7)}&fullHash=${fullCrc.substr(0, 7)}`;

            if (retryCount) {
                url += `&retry=${retryCount}`;
            }

            if (options?.forceCacheBust) {
                url += `&forcedBust=${options.forceCacheBust}`;
            }

            if (retryCount || options?.forceCacheBust) {
                url += `&cache=${Math.random() * 999999999}`;
            }

            console.log('[FRAGMENT] Downloading from', url);
            const response = await fetch(url, { signal });
            const reader = response.body.getReader();
            const contentLength = +response.headers.get('Content-Length');

            let receivedLength = 0;
            const chunks = [];

            // eslint-disable-next-line no-constant-condition
            while (true) {
                const { done, value } = await reader.read();

                if (done || signal.aborted) {
                    break;
                }

                chunks.push(value);
                receivedLength += value.length;

                this.emit('downloadProgress', module, {
                    total: contentLength,
                    loaded: receivedLength,
                    percent: Math.floor((receivedLength / contentLength) * 100),
                });
            }

            const chunksAll = new Uint8Array(receivedLength);
            let position = 0;
            for (const chunk of chunks) {
                chunksAll.set(chunk, position);
                position += chunk.length;
            }

            console.log('[FRAGMENT] Finished downloading file', file);
            return Buffer.from(chunksAll);
        };

        const downloadAndInstall = async (file: string, destDir: string, module: Module, crc: string, fullCrc: string) => {
            let retryCount = 0;

            while (retryCount < 5 && !signal.aborted) {
                try {
                    this.emit('downloadStarted', module);
                    const loadedFile = await downloadFile(file, module, retryCount, crc, fullCrc);
                    this.emit('downloadFinished', module);

                    const zipFile = new AdmZip(loadedFile);

                    validateCrcOrThrow(crc, zipFile);
                    console.log('[FRAGMENT] CRC was correct');

                    if (signal.aborted) {
                        return;
                    }

                    console.log('[FRAGMENT] Extracting ZIP to', destDir);
                    this.emit('unzipStarted', module);
                    await util.promisify(zipFile.extractAllToAsync)(destDir, false);
                    this.emit('unzipFinished', module);
                    console.log('[FRAGMENT] Finished extracting ZIP to', destDir);
                    return;
                } catch (e) {
                    console.error(e);
                    retryCount++;
                    if (signal.aborted) {
                        throw new Error('User aborted');
                    }

                    console.error('[FRAGMENT] Retrying in', 2 ** retryCount, 'seconds');
                    this.emit('retryScheduled', module, retryCount, 2 ** retryCount);
                    // eslint-disable-next-line no-loop-func
                    await new Promise((r) => setTimeout(r, (2 ** retryCount) * 1_000));
                    this.emit('retryStarted', module, retryCount);
                }
            }

            this.emit('error', `Error while downloading ${module.name} module`);
            throw new Error(`Error while downloading ${module.name} module`);
        };

        const done = (manifest: InstallManifest): InstallInfo => {
            const canceled = signal.aborted;
            if (!canceled) {
                const manifestPath = path.join(this.destDir, INSTALL_MANIFEST);

                console.log('Writing install manifest', manifest, 'to', manifestPath);
                fs.writeJSONSync(manifestPath, manifest);
                console.log('Finished writing install manifest', manifest, 'to', manifestPath);
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

        // Get modules to update
        console.log('[FRAGMENT] Finding modules to update');
        const updateInfo = await needsUpdate(
            this.source,
            this.destDir,
            { forceCacheBust: options?.forceCacheBust || options?.forceManifestCacheBust },
        );
        console.log('[FRAGMENT] Update info', updateInfo);

        const allUpdated = updateInfo.updatedModules.length + updateInfo.removedModules.length
            === updateInfo.existingManifest?.modules.length;
        if (allUpdated) {
            console.log('[FRAGMENT] All modules scheduled for updating');
        }

        // Do fresh install using the full zip file if needed
        if (updateInfo.isFreshInstall || options?.forceFreshInstall || allUpdated) {
            console.log('[FRAGMENT] Performing fresh install');
            this.emit('fullDownload');

            if (fs.existsSync(this.destDir)) {
                console.log('[FRAGMENT] Cleaning destination directory', this.destDir);
                fs.rmdirSync(this.destDir, { recursive: true });
                fs.mkdirSync(this.destDir);
            }

            await downloadAndInstall(FULL_FILE, this.destDir, {
                name: 'Full',
                sourceDir: '.',
            }, updateInfo.distributionManifest.fullHash, updateInfo.distributionManifest.fullHash);
            return done({ ...updateInfo.distributionManifest, source: this.source });
        }

        // Get existing manifest
        const installManifestPath = path.join(this.destDir, INSTALL_MANIFEST);
        const oldInstallManifest: InstallManifest = await fs.readJSON(installManifestPath);
        console.log('[FRAGMENT] Found existing manifest', oldInstallManifest);

        // Exit when no update is needed
        if (!updateInfo.needsUpdate) {
            console.log('[FRAGMENT] No update needed');
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
            console.log('[FRAGMENT] Updating base files');
            oldInstallManifest.base.files.forEach((file) => {
                const fullPath = path.join(this.destDir, file);
                if (fs.existsSync(fullPath)) {
                    fs.removeSync(fullPath);
                }
            });

            await downloadAndInstall(BASE_FILE, this.destDir, {
                name: 'Base',
                sourceDir: '.',
            }, updateInfo.distributionManifest.base.hash, updateInfo.distributionManifest.fullHash);
            newInstallManifest.base = updateInfo.distributionManifest.base;
        } else {
            console.log('[FRAGMENT] No base update needed');
            newInstallManifest.base = oldInstallManifest.base;
        }

        newInstallManifest.modules = oldInstallManifest.modules;

        // Delete removed and updated modules
        console.log('[FRAGMENT] Removing changed and removed modules', [...updateInfo.removedModules, ...updateInfo.updatedModules]);
        for (const module of [...updateInfo.removedModules, ...updateInfo.updatedModules]) {
            console.log('[FRAGMENT] Removing module', module);
            const fullPath = path.join(this.destDir, module.sourceDir);
            if (fs.existsSync(fullPath)) {
                fs.rmdirSync(fullPath, { recursive: true });
                console.log('[FRAGMENT] Removed module', module);
            } else {
                console.warn('[FRAGMENT] Module', module, 'marked for removal not found');
            }
            newInstallManifest.modules.splice(newInstallManifest.modules.findIndex((m) => m.name === module.name), 1);
        }

        // Install updated and added modules
        console.log('[FRAGMENT] Installing changed and added modules', [...updateInfo.updatedModules, ...updateInfo.addedModules]);
        for (const module of [...updateInfo.updatedModules, ...updateInfo.addedModules]) {
            const newModule = updateInfo.distributionManifest.modules.find((m) => m.name === module.name);
            console.log('[FRAGMENT] Installing new module', newModule);
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
    }
}
