import { Module } from './module';

export interface BuildManifest {
    baseDir: string;
    outDir: string;
    modules: Module[];
}
