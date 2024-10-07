import fs from 'fs-extra';
import { Zip } from 'zip-lib';
import SplitFile from 'split-file';
import path from 'path';
import readRecurse from 'fs-readdir-recursive';
import commonAncestorPath from 'common-ancestor-path';
import hasha from 'hasha';
import {
    BuildManifest,
    CrcInfo,
    DistributionManifest, DistributionModuleFile, PackOptions,
} from './types';
import { BASE_FILE, FULL_FILE, MODULES_MANIFEST, SINGLE_MODULE_MANIFEST, DEFAULT_SPLIT_FILE_SIZE } from './constants';

/**
 * Build the individual zip files with the provided spec.
 * @param buildManifest Specification for the source, destination and modules to build.
 */
export async function pack(buildManifest: BuildManifest): Promise<DistributionManifest> {
    const options: PackOptions = {
        useConsoleLog: true,

        forceCacheBust: false,

        splitFileSize: DEFAULT_SPLIT_FILE_SIZE,

        keepCompleteModulesAfterSplit: true,
    };

    if (buildManifest.packOptions) {
        Object.assign(options, buildManifest.packOptions);
    }

    const generateHashFromPath = async (absolutePath: string, baseDir: string): Promise<string> => {
        // The hash is undefined if the path doesn't exist.
        if (!fs.existsSync(absolutePath)) {
            return undefined;
        }

        const stats = fs.statSync(absolutePath);

        if (stats.isFile()) {
            const relativePath = path.relative(absolutePath, baseDir);
            const normalizedPath = relativePath.replace(/\\/g, '/');

            return hasha(normalizedPath + await hasha.fromStream(fs.createReadStream(absolutePath)));
        } else {
            const directoryPaths = fs.readdirSync(absolutePath)
                .map((i) => path.join(absolutePath, i));

            return generateHashFromPaths(directoryPaths, baseDir);
        }
    };

    const generateHashFromPaths = async (absolutePaths: string[], baseDir: string): Promise<string> => {
        const paths = [];
        for (const absolutePath of absolutePaths) {
            const baseName = path.basename(absolutePath);
            const contentsHash = await generateHashFromPath(absolutePath, baseDir);

            paths.push(hasha(baseName + contentsHash));
        }

        return hasha(paths.join(''));
    };

    const zip = async (sourcePath: string, zipDest: string): Promise<[crc: string, splitFileCount: number, completeModuleSize: number, completeFileSizeUncompressed: number]> => {
        console.log('[FRAGMENT] Calculating CRC', {
            source: sourcePath,
            dest: zipDest,
        });

        const filesInModule = readRecurse(sourcePath)
            .map((i) => path.resolve(sourcePath, i));

        const crcInfo: CrcInfo = { hash: await generateHashFromPaths(filesInModule, sourcePath) };
        await fs.writeJSON(path.join(sourcePath, SINGLE_MODULE_MANIFEST), crcInfo);

        console.log('[FRAGMENT] Creating ZIP', {
            source: sourcePath,
            dest: zipDest,
        });

        const zip = new Zip();
        await zip.addFolder(sourcePath);
        await zip.archive(zipDest);

        const zipStat = await fs.stat(zipDest);

        const doSplit = options.splitFileSize > 0 && zipStat.size > options.splitFileSize;

        let splitFileCount = 0;
        if (doSplit) {
            console.log(`[FRAGMENT] Splitting file ${path.parse(zipDest).base} because it is larger than 1GB`);

            const files = await SplitFile.splitFileBySize(zipDest, options.splitFileSize);

            console.log(`[FRAGMENT] Split file ${path.parse(zipDest).base} into ${files.length} parts`);

            splitFileCount = files.length;

            if (!options.keepCompleteModulesAfterSplit) {
                fs.rmSync(zipDest);
            }
        }

        console.log('[FRAGMENT] Done writing zip', zipDest);

        const sizeUncompressed = filesInModule.reduce<number>((accu, path) => accu + fs.statSync(path).size, 0);

        return [crcInfo.hash, splitFileCount, zipStat.size, sizeUncompressed];
    };

    const zipAndDelete = async (sourcePath: string, zipDest: string): Promise<[crc: string, splitFileCount: number, completeModuleSize: number, completeFileSizeUncompressed: number]> => {
        const res = await zip(sourcePath, zipDest);

        fs.rmdirSync(sourcePath, { recursive: true });

        return res;
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

    // Manifest validation
    for (const moduleA of buildManifest.modules) {
        // Check for reserved module names
        if (['base', 'full'].includes(moduleA.name.toLowerCase())) {
            throw new Error(`'${moduleA.name}' is a reserved module name`);
        }

        // Check for garbage paths
        if ('kind' in moduleA && moduleA.kind === 'alternatives') {
            for (const alternative of moduleA.alternatives) {
                if (path.normalize(alternative.sourceDir).indexOf('..') !== -1) {
                    throw new Error(`module '${moduleA.name}' alternative '${alternative.key}' contains a backtrack`);
                }
            }
        } else if (path.normalize(moduleA.sourceDir).indexOf('..') !== -1) {
            throw new Error(`module '${moduleA.name}' contains a backtrack`);
        }

        // Check for alternatives modules without a common ancestor
        if ('kind' in moduleA && moduleA.kind === 'alternatives') {
            const commonAlternativesSourceDir = commonAncestorPath(...moduleA.alternatives.map((it) => it.sourceDir));

            if (!commonAlternativesSourceDir) {
                throw new Error(`alternatives for module '${moduleA.name}' must all have a sourceDir that share a common ancestor`);
            }
        }

        // Nested modules are not supported yet
        for (const moduleB of buildManifest.modules) {
            if (moduleA !== moduleB) {
                let moduleASourceDir: string;
                if ('kind' in moduleA && moduleA.kind === 'alternatives') {
                    moduleASourceDir = commonAncestorPath(...moduleA.alternatives.map((it) => it.sourceDir));
                } else {
                    moduleASourceDir = moduleA.sourceDir;
                }

                let moduleBSourceDir: string;
                if ('kind' in moduleB && moduleB.kind === 'alternatives') {
                    moduleBSourceDir = commonAncestorPath(...moduleB.alternatives.map((it) => it.sourceDir));
                } else {
                    moduleBSourceDir = moduleB.sourceDir;
                }

                const pathDiff = path.relative(moduleASourceDir, moduleBSourceDir);

                if (!pathDiff.startsWith('..')) {
                    throw new Error(`Module '${moduleA.name}' contains '${moduleB.name}'. Modules within modules are not supported yet!`);
                }
            }
        }
    }

    const moduleNames: string[] = [''];
    for (const module of buildManifest.modules) {
        if (moduleNames.includes(module.name)) {
            throw new Error(`Module name '${module.name}' is set for more than one module. Each module must have a unique name!`);
        }
        moduleNames.push(module.name);
    }

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
            version: buildManifest.version,
            modules: [],
            base: {
                hash: '',
                files: [],
                splitFileCount: 0,
                completeFileSize: 0,
                completeFileSizeUncompressed: 0,
            },
            fullHash: '',
            fullSplitFileCount: 0,
            fullCompleteFileSize: 0,
            fullCompleteFileSizeUncompressed: 0,
        };

        // Create full zip
        console.log('[FRAGMENT] Creating full ZIP');

        [
            distributionManifest.fullHash,
            distributionManifest.fullSplitFileCount,
            distributionManifest.fullCompleteFileSize,
            distributionManifest.fullCompleteFileSizeUncompressed,
        ] = await zip(tempDir, path.join(buildManifest.outDir, FULL_FILE));

        // Zip Modules
        console.log('[FRAGMENT] Creating module ZIPs');

        for (const module of buildManifest.modules) {
            const files: DistributionModuleFile[] = [];

            if ('kind' in module && module.kind === 'alternatives') {
                for (const alternative of module.alternatives) {
                    const sourcePath = path.join(tempDir, alternative.sourceDir);
                    const moduleFilePath = `${module.name}/${alternative.key}.zip`;
                    const zipDest = path.join(buildManifest.outDir, moduleFilePath);

                    const [hash, splitFileCount, completeFileSize, completeFileSizeUncompressed] = await zipAndDelete(sourcePath, zipDest);

                    files.push({
                        key: alternative.key,
                        path: moduleFilePath,
                        hash,
                        compression: 'zip',
                        splitFileCount,
                        completeFileSize,
                        completeFileSizeUncompressed,
                    });
                }
            } else {
                const sourcePath = path.join(tempDir, module.sourceDir);
                const moduleFilePath = `${module.name}.zip`;
                const zipDest = path.join(buildManifest.outDir, moduleFilePath);

                const [hash, splitFileCount, completeFileSize, completeFileSizeUncompressed] = await zipAndDelete(sourcePath, zipDest);

                files.push({
                    key: 'main',
                    path: moduleFilePath,
                    hash,
                    compression: 'zip',
                    splitFileCount,
                    completeFileSize,
                    completeFileSizeUncompressed,
                });
            }

            if (module.kind === 'alternatives') {
                for (const alternative of module.alternatives) {
                    delete alternative.sourceDir;
                }
            } else {
                delete module.sourceDir;
            }

            distributionManifest.modules.push({ ...module, downloadFiles: files });
        }

        // Zip the rest
        console.log('[FRAGMENT] Creating base ZIP');

        distributionManifest.base.files = readRecurse(tempDir)
            .map(toUnixPath);

        const zipDest = path.join(buildManifest.outDir, BASE_FILE);

        [
            distributionManifest.base.hash,
            distributionManifest.base.splitFileCount,
            distributionManifest.base.completeFileSize,
            distributionManifest.base.completeFileSizeUncompressed,
        ] = await zipAndDelete(tempDir, zipDest);

        await fs.writeJSON(path.join(buildManifest.outDir, MODULES_MANIFEST), distributionManifest);

        return distributionManifest;
    } catch (e) {
        await fs.rmdirSync(tempDir, { recursive: true });
        throw e;
    }
}
