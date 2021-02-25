import fs from 'fs-extra';
import AdmZip from 'adm-zip';
import path from 'path';
import readRecurse from 'fs-readdir-recursive';
import hasha from 'hasha';
import { BuildManifest, CrcInfo, DistributionManifest, InstallInfo, InstallManifest, UpdateInfo } from './manifests';
import urljoin from 'url-join';

/**
 * Download progress for a single zip file.
 */
export interface DownloadProgress {
    file: string;
    total: number;
    loaded: number;
    percent: number;
}

// eslint-disable-next-line no-unused-vars
export type DownloadProgressCallback = (_: DownloadProgress) => void;

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
    const generateHashFromPath = (absolutePath: string): string => {
        // The hash is undefined if the path doesn't exist.
        if (!fs.existsSync(absolutePath)) return undefined;

        const stats = fs.statSync(absolutePath);
        if (stats.isFile()) return hasha(path.basename(absolutePath) + hasha.fromFileSync(absolutePath));
        return generateHashFromPaths(fs.readdirSync(absolutePath).map((i) => path.join(absolutePath, i)));
    };

    const generateHashFromPaths = (absolutePaths: string[]): string =>
        hasha(absolutePaths.map((p) => hasha(path.basename(p) + generateHashFromPath(p))).join(''));

    const zip = async (sourcePath: string, zipDest: string): Promise<string> => {
        console.log('Calculating CRC', { source: sourcePath, dest: zipDest });
        const filesInModule = readRecurse(sourcePath);

        const crcInfo: CrcInfo = {
            hash: generateHashFromPaths(filesInModule),
        };
        await fs.writeJSON(path.join(sourcePath, SINGLE_MODULE_MANIFEST), crcInfo);

        console.log('Creating ZIP', { source: sourcePath, dest: zipDest });
        const zip = new AdmZip();
        zip.addLocalFolder(sourcePath);
        zip.writeZip(zipDest);

        return crcInfo.hash;
    };

    const zipAndDelete = async (sourcePath: string, zipDest: string): Promise<string> => {
        console.log('Creating ZIP ', { source: sourcePath, dest: zipDest });
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
    buildManifest.modules.forEach(moduleA => {
        if (['base', 'full'].includes(moduleA.name.toLowerCase())) {
            throw new Error(`'${moduleA.name}' is a reserved module name`);
        }

        buildManifest.modules.forEach(moduleB => {
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
            fullHash: ''
        };

        // Create full zip
        console.log('Creating full ZIP');
        distributionManifest.fullHash = await zip(tempDir, path.join(buildManifest.outDir, FULL_FILE));

        // Zip Modules
        console.log('Creating module ZIPs');
        await Promise.all(buildManifest.modules.map(async module => {
            const sourcePath = path.join(tempDir, module.sourceDir);
            const zipDest = path.join(buildManifest.outDir, `${module.name}.zip`);

            const crc32 = await zipAndDelete(sourcePath, zipDest);
            distributionManifest.modules.push({
                ...module,
                hash: crc32,
            });
        }));

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
 * Check, whether a destination directory is up to date or needs to be updated.
 * @param source Base URL of the artifact server.
 * @param destDir Directory to validate.
 */
export const needsUpdate = async (source: string, destDir: string): Promise<UpdateInfo> => {
    if (!fs.existsSync(destDir)) {
        throw new Error('Destination directory does not exist!');
    }

    const installManifestPath = path.join(destDir, INSTALL_MANIFEST);
    let existingInstall: InstallManifest;

    const distribution: DistributionManifest = (await fetch(urljoin(source, MODULES_MANIFEST)).then(response => response.json()));
    const updateInfo: UpdateInfo = {
        needsUpdate: false,
        isFreshInstall: false,
        baseChanged: false,
        distributionManifest: distribution,

        addedModules: [],
        removedModules: [],
        updatedModules: [],
    };

    if (fs.existsSync(installManifestPath)) {
        existingInstall = await fs.readJSON(installManifestPath);
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

    updateInfo.addedModules = distribution.modules.filter(e => !existingInstall.modules.find(f => e.name === f.name));
    updateInfo.removedModules = existingInstall.modules.filter(e => !distribution.modules.find(f => e.name === f.name));
    updateInfo.updatedModules = existingInstall.modules.filter(e =>
        !distribution.modules.find(f => e.hash === f.hash)
        && !updateInfo.addedModules.includes(e)
        && !updateInfo.removedModules.includes(e));

    if (updateInfo.addedModules.length > 0 || updateInfo.removedModules.length > 0 || updateInfo.updatedModules.length > 0) {
        updateInfo.needsUpdate = true;
    }

    return updateInfo;
};

/**
 * Install or update the newest available version.
 * @param source Base URL of the artifact server.
 * @param destDir Directory to install into.
 * @param onDownloadProgress Callback for progress events. The percentage resets to 0 for every file downloaded.
 * @param forceFreshInstall Force a fresh install.
 */
export const install = async (source: string, destDir: string, forceFreshInstall: boolean, onDownloadProgress: DownloadProgressCallback = () => {
    return;
}): Promise<InstallInfo> => {

    const validateCrc = (targetCrc: string, zipFile: AdmZip): boolean => {
        console.log('Validating file CRC');
        const moduleFile: CrcInfo = JSON.parse(zipFile.readAsText(SINGLE_MODULE_MANIFEST));
        return targetCrc === moduleFile.hash;
    };

    const downloadFile = async (file: string, onDownloadProgress: DownloadProgressCallback): Promise<Buffer> => {
        const response = await fetch(urljoin(source, file));
        const reader = response.body.getReader();
        const contentLength = +response.headers.get('Content-Length');

        let receivedLength = 0;
        const chunks = [];

        // eslint-disable-next-line no-constant-condition
        while(true) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            chunks.push(value);
            receivedLength += value.length;

            onDownloadProgress({
                file,
                total: contentLength,
                loaded: receivedLength,
                percent: Math.floor(receivedLength / contentLength * 100),
            });
        }

        const chunksAll = new Uint8Array(receivedLength);
        let position = 0;
        for(const chunk of chunks) {
            chunksAll.set(chunk, position);
            position += chunk.length;
        }

        return Buffer.from(chunksAll);
    };

    const downloadAndInstall = async (file: string, destDir: string, crc: string, onDownloadProgress: DownloadProgressCallback) => {
        const loadedFile = await downloadFile(file, onDownloadProgress);

        const zipFile = new AdmZip(loadedFile);
        const crcMatch = validateCrc(crc, zipFile);

        if (!crcMatch) {
            throw new Error('File CRC does not match');
        }

        console.log('Extracting ZIP to', destDir);
        await zipFile.extractAllToAsync(destDir);
    };

    const done = (manifest: InstallManifest): InstallInfo => {
        fs.writeJSONSync(path.join(destDir, INSTALL_MANIFEST), manifest);
        return {
            changed: true,
            manifest: manifest,
        };
    };

    // Create destination directory
    if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
    }

    // Get modules to update
    const updateInfo = await needsUpdate(source, destDir);
    console.log('Update info', updateInfo);

    // Do fresh install using the full zip file if needed
    if (updateInfo.isFreshInstall || forceFreshInstall) {
        if (fs.existsSync(destDir)) {
            fs.rmdirSync(destDir, { recursive: true });
            fs.mkdirSync(destDir);
        }

        await downloadAndInstall(FULL_FILE, destDir, updateInfo.distributionManifest.fullHash, onDownloadProgress);
        return done({ ...updateInfo.distributionManifest, source });
    }

    // Get existing manifest
    const installManifestPath = path.join(destDir, INSTALL_MANIFEST);
    const oldInstallManifest: InstallManifest = await fs.readJSON(installManifestPath);

    // Exit when no update is needed
    if (!updateInfo.needsUpdate) {
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
        source
    };

    // Delete all old base files and install new base files
    if (updateInfo.baseChanged) {
        console.log('Updating base files');
        oldInstallManifest.base.files.forEach(file => {
            const fullPath = path.join(destDir, file);
            if (fs.existsSync(fullPath)) {
                fs.removeSync(fullPath);
            }
        });

        await downloadAndInstall(BASE_FILE, destDir, updateInfo.distributionManifest.base.hash, onDownloadProgress);
        newInstallManifest.base = updateInfo.distributionManifest.base;
    } else {
        newInstallManifest.base = oldInstallManifest.base;
    }

    newInstallManifest.modules = oldInstallManifest.modules;

    // Delete removed and updated modules
    for (const module of [...updateInfo.removedModules, ...updateInfo.updatedModules]) {
        const fullPath = path.join(destDir, module.sourceDir);
        if (fs.existsSync(fullPath)) {
            fs.rmdirSync(fullPath, { recursive: true });
        }
        newInstallManifest.modules.splice(newInstallManifest.modules.findIndex(m => m.name === module.name), 1);
    }

    // Install updated and added modules
    for (const module of [...updateInfo.updatedModules, ...updateInfo.addedModules]) {
        const newModule = updateInfo.distributionManifest.modules.find(m => m.name === module.name);
        await downloadAndInstall(
            `${module.name}.zip`,
            path.join(destDir, module.sourceDir),
            newModule.hash,
            onDownloadProgress
        );
        newInstallManifest.modules.push(newModule);
    }

    newInstallManifest.fullHash = updateInfo.distributionManifest.fullHash;
    return done(newInstallManifest);
};
