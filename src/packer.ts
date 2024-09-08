import fs from 'fs-extra';
import { Zip } from 'zip-lib';
import SplitFile from 'split-file';
import path from 'path';
import readRecurse from 'fs-readdir-recursive';
import hasha from 'hasha';
import {
    BuildManifest,
    CrcInfo,
    DistributionManifest, PackOptions,
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

    const moduleNames: string[] = [''];
    buildManifest.modules.forEach((module) => {
        if (moduleNames.includes(module.name)) {
            throw new Error(`Module name '${module.name}' is set for more than one module. Each module must have a unique name!`);
        }
        moduleNames.push(module.name);
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
            const sourcePath = path.join(tempDir, module.sourceDir);
            const zipDest = path.join(buildManifest.outDir, `${module.name}.zip`);

            const [hash, splitFileCount, completeFileSize, completeFileSizeUncompressed] = await zipAndDelete(sourcePath, zipDest);

            distributionManifest.modules.push({
                ...module,
                hash,
                splitFileCount,
                completeFileSize,
                completeFileSizeUncompressed,
            });
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
