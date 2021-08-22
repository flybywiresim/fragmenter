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

export type InstallOptions = Partial<{
    forceFreshInstall: boolean,
    forceCacheBust: boolean,
    forceManifestCacheBust: boolean,
}>;

export interface NeedsUpdateOptions {
    forceCacheBust: boolean,
}

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
