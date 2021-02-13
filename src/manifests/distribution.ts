import { DistributionModule } from './module';
import { Base } from './base';

export interface DistributionManifest {
    modules: DistributionModule[];
    base: Base;
    fullCrc32: string;
}
