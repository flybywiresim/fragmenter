import fs from 'fs-extra';
import AdmZip from 'adm-zip';
import path from 'path';
// eslint-disable-next-line import/no-unresolved
import readRecurse from 'fs-readdir-recursive';
// eslint-disable-next-line import/no-unresolved
import hasha from 'hasha';
import urljoin from 'url-join';
import * as util from 'util';
import EventEmitter from 'events';
import {
    BuildManifest,
    CrcInfo,
    DistributionManifest,
    InstallInfo,
    InstallManifest,
    Module,
    UpdateInfo,
} from './manifests';
import TypedEventEmitter from './typed-emitter';

/**
 * Download progress for a single zip file.
 */
export interface DownloadProgress {
    total: number;
    loaded: number;
    percent: number;
}

export type InstallOptions = Partial<{
    forceFreshInstall: boolean,
    forceCacheBust: boolean,
    forceManifestCacheBust: boolean,
}>;

export interface NeedsUpdateOptions {
    forceCacheBust: boolean,
}

const SINGLE_MODULE_MANIFEST = 'module.json';
const MODULES_MANIFEST = 'modules.json';
const INSTALL_MANIFEST = 'install.json';
const FULL_FILE = 'full.zip';
const BASE_FILE = 'base.zip';

/**
 * Build the individual zip files with the provided spec.
 * @param buildManifest Specification for the source, destination and modules to build.
 */
export const pack = async (buildManifest: BuildManifest): Promise<DistributionManifest> => {
    const generateHashFromPath = (absolutePath: string, baseDir: string): string => {
        // The hash is undefined if the path doesn't exist.
        if (!fs.existsSync(absolutePath)) return undefined;

        const stats = fs.statSync(absolutePath);
        if (stats.isFile()) return hasha(path.relative(absolutePath, baseDir) + hasha.fromFileSync(absolutePath));
        return generateHashFromPaths(fs.readdirSync(absolutePath).map((i) => path.join(absolutePath, i)), baseDir);
    };

    const generateHashFromPaths = (absolutePaths: string[], baseDir: string): string => hasha(absolutePaths.map((p) => hasha(path.basename(p) + generateHashFromPath(p, baseDir))).join(''));

    const zip = async (sourcePath: string, zipDest: string): Promise<string> => {
        console.log('Calculating CRC', { source: sourcePath, dest: zipDest });
        const filesInModule = readRecurse(sourcePath).map((i) => path.resolve(sourcePath, i));

        const crcInfo: CrcInfo = { hash: generateHashFromPaths(filesInModule, sourcePath) };
        await fs.writeJSON(path.join(sourcePath, SINGLE_MODULE_MANIFEST), crcInfo);

        console.log('Creating ZIP', { source: sourcePath, dest: zipDest });
        const zip = new AdmZip();
        zip.addLocalFolder(sourcePath);
        zip.writeZip(zipDest);
        console.log('Done writing zip', zipDest);

        return crcInfo.hash;
    };

    const zipAndDelete = async (sourcePath: string, zipDest: string): Promise<string> => {
        const crc = await zip(sourcePath, zipDest);
        fs.rmdirSync(sourcePath, { recursive: true });

        return crc;
    };

    const toUnixPath = (path: string): string => {
        const isExtendedLengthPath = /^\\\\\?\\/.test(path);
        // eslint-disable-next-line no-control-regex
        const hasNonAscii = /[^\u0000-\u0080]+/.test(path);

        if (isExtendedLengthPath || hasNonAscii) {
            return path;
        }

        return path.replace(/\\/g, '/');
    };

    // Manifest validation: Nested modules are not supported yet
    buildManifest.modules.forEach((moduleA) => {
        if (['base', 'full'].includes(moduleA.name.toLowerCase())) {
            throw new Error(`'${moduleA.name}' is a reserved module name`);
        }

        buildManifest.modules.forEach((moduleB) => {
            if (moduleA !== moduleB) {
                const pathDiff = path.relative(moduleA.sourceDir, moduleB.sourceDir);

                if (!pathDiff.startsWith('..')) {
                    throw new Error(`Module '${moduleA.name}' contains '${moduleB.name}'. Modules within modules are not supported yet!`);
                }
            }
        });
    });

    if (!fs.existsSync(buildManifest.baseDir)) {
        throw new Error('Base directory does not exist');
    }

    if (fs.existsSync(buildManifest.outDir)) {
        fs.rmdirSync(buildManifest.outDir, { recursive: true });
    }
    fs.mkdirSync(buildManifest.outDir, { recursive: true });

    // Create a temp dir with all required files
    const tempDir = await fs.mkdtemp('fbw-build-');

    // Trap everything to ensure a proper cleanup of the temp directory
    try {
        fs.copySync(buildManifest.baseDir, tempDir);

        const distributionManifest: DistributionManifest = {
            modules: [],
            base: {
                hash: '',
                files: [],
            },
            fullHash: '',
        };

        // Create full zip
        console.log('Creating full ZIP');
        distributionManifest.fullHash = await zip(tempDir, path.join(buildManifest.outDir, FULL_FILE));

        // Zip Modules
        console.log('Creating module ZIPs');
        for (const module of buildManifest.modules) {
            const sourcePath = path.join(tempDir, module.sourceDir);
            const zipDest = path.join(buildManifest.outDir, `${module.name}.zip`);

            const hash = await zipAndDelete(sourcePath, zipDest);
            distributionManifest.modules.push({
                ...module,
                hash,
            });
        }

        // Zip the rest
        console.log('Creating base ZIP');
        distributionManifest.base.files = readRecurse(tempDir).map(toUnixPath);
        const zipDest = path.join(buildManifest.outDir, BASE_FILE);
        distributionManifest.base.hash = await zipAndDelete(tempDir, zipDest);

        await fs.writeJSON(path.join(buildManifest.outDir, MODULES_MANIFEST), distributionManifest);
        return distributionManifest;
    } catch (e) {
        await fs.rmdirSync(tempDir, { recursive: true });
        throw e;
    }
};

/**
 * Get the current install manifest.
 * @param destDir Directory to search.
 */
export const getCurrentInstall = (destDir: string): InstallManifest => {
    const installManifestPath = path.join(destDir, INSTALL_MANIFEST);
    return fs.readJSONSync(installManifestPath);
};

/**
 * Check, whether a destination directory is up to date or needs to be updated.
 * @param source Base URL of the artifact server.
 * @param destDir Directory to validate.
 * @param options Advanced options for the check.
 */
export const needsUpdate = async (source: string, destDir: string, options?: NeedsUpdateOptions): Promise<UpdateInfo> => {
    if (!fs.existsSync(destDir)) {
        throw new Error('Destination directory does not exist!');
    }

    const installManifestPath = path.join(destDir, INSTALL_MANIFEST);
    let existingInstall: InstallManifest;

    let url = urljoin(source, MODULES_MANIFEST);
    if (options?.forceCacheBust) {
        url += `?cache=${Math.random() * 999999999}`;
    }

    console.log('Downloading module info from', url);
    const distribution: DistributionManifest = (await fetch(url).then((response) => response.json()));
    const updateInfo: UpdateInfo = {
        needsUpdate: false,
        isFreshInstall: false,
        baseChanged: false,
        distributionManifest: distribution,
        existingManifest: undefined,

        addedModules: [],
        removedModules: [],
        updatedModules: [],
    };

    if (fs.existsSync(installManifestPath)) {
        existingInstall = await fs.readJSON(installManifestPath);
        updateInfo.existingManifest = existingInstall;
        console.log('Existing install', existingInstall);
    } else {
        console.log('No existing install found. Update needed.');
        updateInfo.needsUpdate = true;
        updateInfo.isFreshInstall = true;
        updateInfo.addedModules = distribution.modules;
        updateInfo.baseChanged = true;
        return updateInfo;
    }

    if (existingInstall.base.hash !== distribution.base.hash) {
        console.log('Base CRC does not match. Update needed.');
        updateInfo.needsUpdate = true;
        updateInfo.baseChanged = true;
    }

    updateInfo.addedModules = distribution.modules.filter((e) => !existingInstall.modules.find((f) => e.name === f.name));
    updateInfo.removedModules = existingInstall.modules.filter((e) => !distribution.modules.find((f) => e.name === f.name));
    updateInfo.updatedModules = existingInstall.modules.filter((e) => !distribution.modules.find((f) => e.hash === f.hash)
        && !updateInfo.addedModules.includes(e)
        && !updateInfo.removedModules.includes(e));

    if (updateInfo.addedModules.length > 0 || updateInfo.removedModules.length > 0 || updateInfo.updatedModules.length > 0) {
        updateInfo.needsUpdate = true;
    }

    return updateInfo;
};

export interface FragmenterInstallerEvents {
    'error': (err: any) => void;
    'downloadStarted': (module: Module) => void;
    'downloadProgress': (module: Module, progress: DownloadProgress) => void;
    'downloadFinished': (module: Module) => void;
    'unzipStarted': (module: Module) => void;
    'unzipFinished': (module: Module) => void;
    'retryScheduled': (module: Module, retryCount: number, waitSeconds: number) => void;
    'retryStarted': (module: Module, retryCount: number) => void;
    'fullDownload': () => void;
}

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
            console.log('Validating file CRC');
            const moduleFile: CrcInfo = JSON.parse(zipFile.readAsText(SINGLE_MODULE_MANIFEST));
            console.log('CRC should be', targetCrc, 'and is', moduleFile.hash);

            return targetCrc === moduleFile.hash;
        };

        const validateCrcOrThrow = (targetCrc: string, zipFile: AdmZip): void => {
            if (!validateCrc(targetCrc, zipFile)) {
                console.log('CRC wasn\'t correct');
                throw new Error('Invalid CRC');
            }
        };

        const downloadFile = async (file: string, module: Module, retryCount: number, crc: string, fullCrc: string): Promise<Buffer> => {
            console.log('Downloading file', file);
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

            console.log('Downloading from', url);
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

            console.log('Finished downloading file', file);
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
                    console.log('CRC was correct');

                    if (signal.aborted) {
                        return;
                    }

                    console.log('Extracting ZIP to', destDir);
                    this.emit('unzipStarted', module);
                    await util.promisify(zipFile.extractAllToAsync)(destDir, false);
                    this.emit('unzipFinished', module);
                    console.log('Finished extracting ZIP to', destDir);
                    return;
                } catch (e) {
                    console.error(e);
                    retryCount++;
                    if (signal.aborted) {
                        return;
                    }

                    console.error('Retrying in', 2 ** retryCount, 'seconds');
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
        console.log('Finding modules to update');
        const updateInfo = await needsUpdate(
            this.source,
            this.destDir,
            { forceCacheBust: options?.forceCacheBust || options?.forceManifestCacheBust },
        );
        console.log('Update info', updateInfo);

        const allUpdated = updateInfo.updatedModules.length + updateInfo.removedModules.length
            === updateInfo.existingManifest?.modules.length;
        if (allUpdated) {
            console.log('All modules scheduled for updating');
        }

        // Do fresh install using the full zip file if needed
        if (updateInfo.isFreshInstall || options?.forceFreshInstall || allUpdated) {
            console.log('Performing fresh install');
            this.emit('fullDownload');

            if (fs.existsSync(this.destDir)) {
                console.log('Cleaning destination directory', this.destDir);
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
        console.log('Found existing manifest', oldInstallManifest);

        // Exit when no update is needed
        if (!updateInfo.needsUpdate) {
            console.log('No update needed');
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
            console.log('Updating base files');
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
            console.log('No base update needed');
            newInstallManifest.base = oldInstallManifest.base;
        }

        newInstallManifest.modules = oldInstallManifest.modules;

        // Delete removed and updated modules
        console.log('Removing changed and removed modules', [...updateInfo.removedModules, ...updateInfo.updatedModules]);
        for (const module of [...updateInfo.removedModules, ...updateInfo.updatedModules]) {
            console.log('Removing module', module);
            const fullPath = path.join(this.destDir, module.sourceDir);
            if (fs.existsSync(fullPath)) {
                fs.rmdirSync(fullPath, { recursive: true });
                console.log('Removed module', module);
            } else {
                console.warn('Module', module, 'marked for removal not found');
            }
            newInstallManifest.modules.splice(newInstallManifest.modules.findIndex((m) => m.name === module.name), 1);
        }

        // Install updated and added modules
        console.log('Installing changed and added modules', [...updateInfo.updatedModules, ...updateInfo.addedModules]);
        for (const module of [...updateInfo.updatedModules, ...updateInfo.addedModules]) {
            const newModule = updateInfo.distributionManifest.modules.find((m) => m.name === module.name);
            console.log('Installing new module', newModule);
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
