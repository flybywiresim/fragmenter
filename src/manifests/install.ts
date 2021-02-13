import { DistributionManifest } from './distribution';

export type InstallManifest = DistributionManifest

export interface InstallInfo {
    changed: boolean;
    manifest: InstallManifest;
}
