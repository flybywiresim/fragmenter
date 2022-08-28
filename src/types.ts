import { ModuleDecompressorProgress } from './install/module-decompressor';

export interface Base {
    hash: string;
    splitFileCount?: number;
    completeFileSize?: number;
    completeFileSizeUncompressed?: number;
    files: string[];
}

export interface BuildManifest {
    baseDir: string;
    outDir: string;
    packOptions?: PackOptions;
    modules: Module[];
}

export interface DistributionManifest {
    modules: DistributionModule[];
    base: Base;
    fullHash: string;
    fullSplitFileCount?: number;
    fullCompleteFileSize?: number;
    fullCompleteFileSizeUncompressed?: number;
}

export interface InstallManifest extends DistributionManifest {
    source: string;
}

export interface InstallInfo {
    changed: boolean;
    manifest: InstallManifest;
}

export interface Module {
    name: string;
    sourceDir: string;
}

export interface DistributionModule extends Module {
    hash: string;
    splitFileCount?: number;
    completeFileSize?: number;
    completeFileSizeUncompressed?: number;
}

export interface CrcInfo {
    hash: string;
}

export interface UpdateInfo {
    needsUpdate: boolean;
    isFreshInstall: boolean;
    baseChanged: boolean;

    addedModules: DistributionModule[];
    removedModules: DistributionModule[];
    updatedModules: DistributionModule[];
    unchangedModules: DistributionModule[];

    /**
     * Download size in bytes of the update, if available
     */
    downloadSize?: number;

    /**
     * Required disk space to perform the update, if available
     */
    requiredDiskSpace?: number;

    distributionManifest: DistributionManifest;
    existingManifest?: InstallManifest;
}

/**
 * Download progress for a single zip file.
 */
export interface DownloadProgress {
    total: number;
    loaded: number;
    percent: number;
    partTotal?: number;
    partLoaded?: number;
    partPercent?: number;
    partIndex?: number;
    numParts?: number;
}

/**
 * Copy progress for a single module.
 */
export interface CopyProgress {
    total: number;
    moved: number;
}

/**
 * Basic options passed to all Fragmenter commands
 */
export interface BaseCommandOptions {
    /**
     * Whether to force using cache busting.
     *
     * Defaults to `false`.
     */
    forceCacheBust: boolean,

    /**
     * Whether to produce `console.log` and/or `console.error` outputs.
     *
     * Defaults to `true`.
     */
    useConsoleLog: boolean,

    /**
     * Whether to log `trace` outputs.
     *
     * Defaults to `false`,
     */
    logTrace: boolean,
}

export type PackOptions = Partial<BaseCommandOptions> & {
    /**
     * Specifies both the cutoff point at which to split large zip files, and the max size of each split part.
     *
     * -1 indicates no splitting.
     *
     * Defaults to `DEFAULT_SPLIT_FILE_SIZE`, which is 1 GB.
     */
    splitFileSize?: number,

    /**
     * Whether to keep complete files after they were split.
     *
     * Defaults to `true`.
     */
    keepCompleteModulesAfterSplit?: boolean,
}

/**
 * Options passed to a {@link FragmenterUpdateChecker}
 */
export type NeedsUpdateOptions = Partial<BaseCommandOptions & {}>;

export interface FragmenterUpdateCheckerEvents {
    'error': (err: any) => void;
    'logInfo': (module: Module | null, ...messageBits: any[]) => void;
    'logWarn': (module: Module | null, ...messageBits: any[]) => void;
    'logError': (module: Module | null, ...messageBits: any[]) => void;
}

export interface FragmenterInstallerEvents {
    'error': (err: any) => void;
    'backupStarted': () => void;
    'backupFinished': () => void;
    'downloadStarted': (module: Module) => void;
    'downloadProgress': (module: Module, progress: DownloadProgress) => void;
    'downloadInterrupted': (module: Module, fromUserAction: boolean) => void;
    'downloadFinished': (module: Module) => void;
    'unzipStarted': (module: Module) => void;
    'unzipProgress': (module: Module, progress: ModuleDecompressorProgress) => void;
    'unzipFinished': (module: Module) => void;
    'copyStarted': (module: Module) => void;
    'copyProgress': (module: Module, progress: CopyProgress) => void;
    'copyFinished': (module: Module) => void;
    'retryScheduled': (module: Module, retryCount: number, waitSeconds: number) => void;
    'retryStarted': (module: Module, retryCount: number) => void;
    'fullDownload': () => void;
    'modularUpdate': () => void;
    'cancelled': () => void;
    'logInfo': (module: Module | null, ...messageBits: any[]) => void;
    'logWarn': (module: Module | null, ...messageBits: any[]) => void;
    'logError': (module: Module | null, ...messageBits: any[]) => void;
}
