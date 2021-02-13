export interface Module {
    name: string;
    sourceDir: string;
}

export interface DistributionModule extends Module {
    crc32: string;
}

export interface CrcInfo {
    crc32: string;
}
