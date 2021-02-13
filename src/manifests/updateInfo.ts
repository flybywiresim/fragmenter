import { DistributionModule } from './module';
import { DistributionManifest } from './distribution';

export interface UpdateInfo {
    needsUpdate: boolean;
    isFreshInstall: boolean;
    baseChanged: boolean;

    addedModules: DistributionModule[];
    removedModules: DistributionModule[];
    updatedModules: DistributionModule[];

    distributionManifest: DistributionManifest;
}
