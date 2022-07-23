export interface Base {
    hash: string;
    files: string[];
}

export interface BuildManifest {
    baseDir: string;
    outDir: string;
    modules: Module[];
}

export interface DistributionManifest {
    modules: DistributionModule[];
    base: Base;
    fullHash: string;
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
     * Specify `false` to disable both and instead only emit `logInfo`, `logWarn` and `logError` events.
     * Specify an object of form `{ info: boolean, error: boolean }` to do so for specific levels.
     *
     * Defaults to `true`.
     */
    useConsoleLog: boolean | { info: boolean, warn: boolean, error: boolean },
}

/**
 * Options passed to a {@link FragmenterInstaller}
 */
export type InstallOptions = Partial<BaseCommandOptions & {
    /**
     * Provides a custom temporary directory for use when extracting compressed modules.
     *
     * **Warning:** if this is specified, the caller must make sure the provided directory is unique.
     *
     * Defaults to a randomised directory in `os.tmpdir()`.
     */
    temporaryDirectory: string,

    /**
     * Maximum amount of retries when downloading a module fails.
     *
     * Defaults to `5`.
     */
    maxModuleRetries: number,

    /**
     * Whether to force a fresh install.
     *
     * Defaults to `false`.
     */
    forceFreshInstall: boolean,

    /**
     * Whether to force using cache busting for the manifest.
     *
     * Defaults to `false`.
     */
    forceManifestCacheBust: boolean,

    /**
     * Disables falling back to a full module download after exhausting the max amount of module retries.
     *
     * Defaults to `false`.
     */
    disableFallbackToFull: boolean,
}>;

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
    'downloadStarted': (module: Module) => void;
    'downloadProgress': (module: Module, progress: DownloadProgress) => void;
    'downloadFinished': (module: Module) => void;
    'unzipStarted': (module: Module) => void;
    'unzipFinished': (module: Module) => void;
    'copyStarted': (module: Module) => void;
    'copyFinished': (module: Module) => void;
    'retryScheduled': (module: Module, retryCount: number, waitSeconds: number) => void;
    'retryStarted': (module: Module, retryCount: number) => void;
    'fullDownload': () => void;
    'logInfo': (module: Module | null, ...messageBits: any[]) => void;
    'logWarn': (module: Module | null, ...messageBits: any[]) => void;
    'logError': (module: Module | null, ...messageBits: any[]) => void;
}
