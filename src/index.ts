import { BuildManifest } from './manifests/build';
import fs from 'fs-extra';
import AdmZip from 'adm-zip';
import path from 'path';
import crc from 'crc';
import { DistributionManifest } from './manifests/distribution';
import readRecurse from 'fs-readdir-recursive';
import { InstallInfo, InstallManifest } from './manifests/install';
import axios from 'axios';
import { UpdateInfo } from './manifests/updateInfo';
import { Stream } from 'stream';
import { CrcInfo } from './manifests/module';

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

export const build = async (buildManifest: BuildManifest): Promise<DistributionManifest> => {
    const zip = async (sourcePath: string, zipDest: string): Promise<string> => {
        console.log('Calculating CRC', { source: sourcePath, dest: zipDest });
        const filesInModule = readRecurse(sourcePath);
        let crcValue = 0;

        for (const file of filesInModule) {
            crcValue = crc.crc32(await fs.readFile(path.join(sourcePath, file)), crcValue);
        }

        const crcInfo: CrcInfo = {
            crc32: crcValue.toString(16),
        };
        await fs.writeJSON(path.join(sourcePath, SINGLE_MODULE_MANIFEST), crcInfo);

        console.log('Creating ZIP', { source: sourcePath, dest: zipDest });
        const zip = new AdmZip();
        zip.addLocalFolder(sourcePath);
        zip.writeZip(zipDest);

        return crcInfo.crc32;
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
    await fs.mkdir(buildManifest.outDir, { recursive: true });

    // Create a temp dir with all required files
    const tempDir = await fs.mkdtemp('fbw-build-');

    // Trap everything to ensure a proper cleanup of the temp directory
    try {
        fs.copySync(buildManifest.baseDir, tempDir);

        const distributionManifest: DistributionManifest = {
            modules: [],
            base: {
                crc32: '',
                files: [],
            },
            fullCrc32: ''
        };

        // Create full zip
        console.log('Creating full ZIP');
        distributionManifest.fullCrc32 = await zip(tempDir, path.join(buildManifest.outDir, FULL_FILE));

        // Zip Modules
        console.log('Creating module ZIPs');
        await Promise.all(buildManifest.modules.map(async module => {
            const sourcePath = path.join(tempDir, module.sourceDir);
            const zipDest = path.join(buildManifest.outDir, `${module.name}.zip`);

            const crc32 = await zipAndDelete(sourcePath, zipDest);
            distributionManifest.modules.push({
                ...module,
                crc32,
            });
        }));

        // Zip the rest
        console.log('Creating base ZIP');
        distributionManifest.base.files = readRecurse(tempDir).map(toUnixPath);
        const zipDest = path.join(buildManifest.outDir, BASE_FILE);
        distributionManifest.base.crc32 = await zipAndDelete(tempDir, zipDest);

        await fs.writeJSON(path.join(buildManifest.outDir, MODULES_MANIFEST), distributionManifest);
        return distributionManifest;
    } catch (e) {
        await fs.rmdirSync(tempDir, { recursive: true });
        throw e;
    }
};

export const needsUpdate = async (source: string, destDir: string): Promise<UpdateInfo> => {
    if (!fs.existsSync(destDir)) {
        throw new Error('Destination directory does not exist!');
    }

    const installManifestPath = path.join(destDir, INSTALL_MANIFEST);
    let existingInstall: InstallManifest;

    const distribution: DistributionManifest = (await axios.get(new URL(MODULES_MANIFEST, source).href)).data;
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

    if (existingInstall.base.crc32 !== distribution.base.crc32) {
        console.log('Base CRC does not match. Update needed.');
        updateInfo.needsUpdate = true;
        updateInfo.baseChanged = true;
    }

    updateInfo.addedModules = distribution.modules.filter(e => !existingInstall.modules.find(f => e.name === f.name));
    updateInfo.removedModules = existingInstall.modules.filter(e => !distribution.modules.find(f => e.name === f.name));
    updateInfo.updatedModules = existingInstall.modules.filter(e =>
        !distribution.modules.find(f => e.crc32 === f.crc32)
        && !updateInfo.addedModules.includes(e)
        && !updateInfo.removedModules.includes(e));

    if (updateInfo.addedModules.length > 0 || updateInfo.removedModules.length > 0 || updateInfo.updatedModules.length > 0) {
        updateInfo.needsUpdate = true;
    }

    return updateInfo;
};

export const install = async (source: string, destDir: string, onDownloadProgress: DownloadProgressCallback = () => { return; }): Promise<InstallInfo> => {
    const client = axios.create({
        baseURL: source
    });

    const validateCrc = (targetCrc: string, zipFile: AdmZip): boolean => {
        console.log('Validating file CRC');
        const moduleFile: CrcInfo = JSON.parse(zipFile.readAsText(SINGLE_MODULE_MANIFEST));
        return targetCrc === moduleFile.crc32;
    };

    const downloadFile = async (file: string, onDownloadProgress: DownloadProgressCallback): Promise<Buffer> => {
        return new Promise<Buffer>((resolve, reject) => {
            client.get<Stream>(file, { responseType: 'stream' })
                .then(response => {
                    const totalLength = parseInt(response.headers['content-length']);
                    let loaded = 0;

                    const allChunks = new Uint8Array(totalLength);

                    response.data.on('data', chunk => {
                        allChunks.set(chunk, loaded);
                        loaded += chunk.length;

                        onDownloadProgress({
                            file,
                            total: totalLength,
                            loaded: loaded,
                            percent: Math.floor(loaded / totalLength * 100),
                        });
                    });

                    response.data.once('close', () => {
                        resolve(Buffer.from(allChunks));
                    });
                })
                .catch(e => reject(e));
        });
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
    if (updateInfo.isFreshInstall) {
        await downloadAndInstall(FULL_FILE, destDir, updateInfo.distributionManifest.fullCrc32, onDownloadProgress);
        return done(updateInfo.distributionManifest);
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
            crc32: '',
            files: [],
        },
        fullCrc32: ''
    };

    // Delete all old base files and install new base files
    if (updateInfo.baseChanged) {
        console.log('Updating base files');
        oldInstallManifest.base.files.forEach(file => {
            const fullPath = path.join(destDir, file);
            if (fs.existsSync(fullPath)) {
                fs.rmSync(fullPath);
            }
        });

        await downloadAndInstall(BASE_FILE, destDir, updateInfo.distributionManifest.base.crc32, onDownloadProgress);
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
            newModule.crc32,
            onDownloadProgress
        );
        newInstallManifest.modules.push(newModule);
    }

    newInstallManifest.fullCrc32 = updateInfo.distributionManifest.fullCrc32;
    return done(newInstallManifest);
};
