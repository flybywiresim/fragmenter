import { ModuleDecompressorProgress } from './install/module-decompressor';

export interface Base {
    hash: string;
    splitFileCount?: number;
    completeFileSize?: number;
    completeFileSizeUncompressed?: number;
    files: string[];
}

export interface BuildManifest {
    version: string;
    baseDir: string;
    outDir: string;
    packOptions?: PackOptions;
    modules: Module[];
}

export interface DistributionManifest {
    version?: string;
    modules: DistributionModule[];
    base: Base;
    fullHash: string;
    fullSplitFileCount?: number;
    fullCompleteFileSize?: number;
    fullCompleteFileSizeUncompressed?: number;
}

interface InstalledData {
    hash: string;
}

export type InstalledSimpleModule = Omit<SimpleModule, 'sourceDir'> & InstalledData

interface AlternativesInstalledData extends InstalledData {
    installedAlternativeKey: string;
}

export type InstalledAlternativesModule = (Omit<AlternativesModule, 'alternatives'>) & AlternativesInstalledData;

export type InstalledModule = InstalledSimpleModule | InstalledAlternativesModule;

export interface InstallManifest extends Omit<DistributionManifest, 'modules'> {
    source: string;
    modules: InstalledModule[],
}

export interface InstallInfo {
    changed: boolean;
    manifest: InstallManifest;
}

export interface BaseModule {
    kind: string;
    name: string;
    destDir: string;
}

export interface SimpleModule extends BaseModule {
    kind: 'simple';
    sourceDir: string;
}

export interface ModuleAlternative {
    key: string;
    name: string;
    sourceDir: string;
}

export interface AlternativesModule extends BaseModule {
    kind: 'alternatives';
    alternatives: ModuleAlternative[];
}

export type Module = SimpleModule | AlternativesModule;

export interface DistributionModuleFile {
    key: string;
    path: string;
    hash: string;
    compression: 'zip';
    splitFileCount: number;
    completeFileSize: number;
    completeFileSizeUncompressed: number;
}

interface DistributionData {
    downloadFiles: DistributionModuleFile[],
}

export type DistributionSimpleModule = Omit<SimpleModule, 'sourceDir'> & DistributionData;

export type DistributionAlternativesModule = (Omit<AlternativesModule, 'alternatives' & { alternatives: Omit<ModuleAlternative, any> }>) & DistributionData;

export type DistributionModule = DistributionSimpleModule | DistributionAlternativesModule;

export interface CrcInfo {
    hash: string;
}

export interface UpdateModule extends BaseModule {
    fileToDownload: DistributionModuleFile,
}

export interface UpdateInfo {
    needsUpdate: boolean;
    isFreshInstall: boolean;
    baseChanged: boolean;
    willFullyReDownload: boolean;

    addedModules: UpdateModule[];
    removedModules: InstalledModule[];
    updatedModules: UpdateModule[];
    unchangedModules: InstalledModule[];

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

    /**
     * The user agent to use for HTTP requests.
     *
     * Defaults to the Axios user agent.
     */
    userAgent?: string,
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
export type NeedsUpdateOptions = Partial<BaseCommandOptions & {
    /**
     * A map of module names to the alternative file to download.
     *
     * Every module of `alternative` kind must have an entry in this map, otherwise an error will be thrown.
     */
    moduleAlternativesMap: Map<string, string>,

    /**
     * The ratio at which to force a full install. Default turns this behaviour off; 0.5 means more than half of total modules updated or added leads to a full install.
     */
    forceFullInstallRatio: number,
}>;

export interface FragmenterUpdateCheckerEvents {
    'error': (err: any) => void;
    'logInfo': (module: BaseModule | null, ...messageBits: any[]) => void;
    'logWarn': (module: BaseModule | null, ...messageBits: any[]) => void;
    'logError': (module: BaseModule | null, ...messageBits: any[]) => void;
}

export interface FragmenterInstallerEvents {
    'error': (err: any) => void;
    'backupStarted': () => void;
    'backupFinished': () => void;
    'downloadStarted': (module: BaseModule) => void;
    'downloadProgress': (module: BaseModule, progress: DownloadProgress) => void;
    'downloadInterrupted': (module: BaseModule, fromUserAction: boolean) => void;
    'downloadFinished': (module: BaseModule) => void;
    'unzipStarted': (module: BaseModule) => void;
    'unzipProgress': (module: BaseModule, progress: ModuleDecompressorProgress) => void;
    'unzipFinished': (module: BaseModule) => void;
    'copyStarted': (module: BaseModule) => void;
    'copyProgress': (module: BaseModule, progress: CopyProgress) => void;
    'copyFinished': (module: BaseModule) => void;
    'retryScheduled': (module: BaseModule, retryCount: number, waitSeconds: number) => void;
    'retryStarted': (module: BaseModule, retryCount: number) => void;
    'fullDownload': () => void;
    'modularUpdate': () => void;
    'cancelled': () => void;
    'logInfo': (module: BaseModule | null, ...messageBits: any[]) => void;
    'logWarn': (module: BaseModule | null, ...messageBits: any[]) => void;
    'logError': (module: BaseModule | null, ...messageBits: any[]) => void;
}
