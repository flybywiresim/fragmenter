import EventEmitter from 'events';
import { IEntryEvent, Unzip } from 'zip-lib';
import path from 'path';
import fs from 'fs-extra';
import TypedEventEmitter from '../typed-emitter';
import { DistributionModule } from '../types';
import { FragmenterError, FragmenterErrorCode } from '../errors';
import { FragmenterContext, FragmenterOperation } from '../core';

export interface ModuleDecompressorProgress {
    entryIndex: number,
    entryName: string,
    entryCount: number,
}

export interface ModuleDecompressorEvents {
    'progress': (progress: ModuleDecompressorProgress) => void,
}

export class ModuleDecompressor extends (EventEmitter as new () => TypedEventEmitter<ModuleDecompressorEvents>) {
    constructor(
        private readonly ctx: FragmenterContext,
        private readonly module: DistributionModule,
        private readonly moduleIndex: number,
    ) {
        // eslint-disable-next-line constructor-super
        super();
    }

    async decompress(filePath: string, destDir: string): Promise<boolean> {
        this.ctx.currentPhase = { op: FragmenterOperation.InstallModuleDecompress, module: this.module, moduleIndex: this.moduleIndex };

        let entryIndex = 0;

        const unzip = new Unzip({
            onEntry: ({ entryName, entryCount }: IEntryEvent) => {
                entryIndex++;

                this.emit('progress', { entryIndex, entryName, entryCount });
            },
        });

        try {
            this.ctx.logInfo(`[ModuleDecompressor] Extracting module file at '${filePath}' -> '${destDir}'`);

            await unzip.extract(filePath, destDir);

            this.ctx.logTrace(`[ModuleDecompressor] Done extracting module file at '${filePath}'`);
        } catch (e) {
            this.ctx.logError('[ModuleDecompressor] Error while extracting module file. See exception below');

            throw FragmenterError.createFromError(e);
        }

        this.ctx.logTrace('[ModuleDecompressor] Done extracting module file');

        const moduleJsonPath = path.join(destDir, 'module.json');

        let moduleJson;
        try {
            const contents = (await fs.readFile(moduleJsonPath)).toString();

            moduleJson = JSON.parse(contents);
        } catch (e) {
            this.ctx.logError('[ModuleDecompressor] Error while reading module.json file. See exception below');

            throw FragmenterError.createFromError(e);
        }

        const actualCrc = moduleJson.hash;
        const expectedCrc = this.module.hash;

        if (actualCrc !== expectedCrc) {
            throw FragmenterError.create(
                FragmenterErrorCode.ModuleCrcMismatch,
                `expected: ${expectedCrc.substring(0, 8)}, read: ${actualCrc.substring(0, 8)}`,
            );
        }

        this.ctx.logInfo('[ModuleDecompressor] module.json hash matched expected hash');

        return true;
    }
}
