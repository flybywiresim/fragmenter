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

export type InstallManifest = DistributionManifest

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
}
