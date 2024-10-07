import path from 'path';
import fs from 'fs-extra';
import urljoin from 'url-join';
import Axios from 'axios';
import EventEmitter from 'events';
import { DistributionManifest, DistributionModule, DistributionModuleFile, FragmenterUpdateCheckerEvents, InstallManifest, NeedsUpdateOptions, UpdateInfo } from './types';
import { INSTALL_MANIFEST, MODULES_MANIFEST } from './constants';
import { getLoggerSettingsFromOptions } from './log';
import TypedEventEmitter from './typed-emitter';
import { FragmenterError, FragmenterErrorCode } from './errors';

export class FragmenterUpdateChecker extends (EventEmitter as new () => TypedEventEmitter<FragmenterUpdateCheckerEvents>) {
    /**
     * Check whether a destination directory is up to date or needs to be updated.
     *
     * @param source Base URL of the artifact server.
     * @param destDir Directory to validate.
     * @param options Advanced options for the check.
     */
    public async needsUpdate(source: string, destDir: string, options?: NeedsUpdateOptions): Promise<UpdateInfo> {
        const [useInfoConsoleLog] = getLoggerSettingsFromOptions(options);

        const logInfo = (...bits: any[]) => {
            if (useInfoConsoleLog) {
                console.log('[FRAGMENT]', ...bits);
            }
            this.emit('logInfo', null, ...bits);
        };

        const installManifestPath = path.join(destDir, INSTALL_MANIFEST);
        let existingInstall: InstallManifest;

        let url = urljoin(source, MODULES_MANIFEST);
        if (options?.forceCacheBust) {
            url += `?cache=${Math.random() * 999999999}`;
        }

        logInfo('Downloading module info from', url);

        const response = await Axios.get<DistributionManifest>(url, { responseType: 'json' });
        const distribution = response.data;

        const updateInfo: UpdateInfo = {
            needsUpdate: false,
            isFreshInstall: false,
            baseChanged: false,
            willFullyReDownload: false,

            distributionManifest: distribution,
            existingManifest: undefined,

            addedModules: [],
            removedModules: [],
            updatedModules: [],
            unchangedModules: [],

            downloadSize: undefined,
            requiredDiskSpace: undefined,
        };

        if (fs.existsSync(installManifestPath)) {
            existingInstall = await fs.readJSON(installManifestPath);
            updateInfo.existingManifest = existingInstall;

            logInfo('Existing install', existingInstall);
        } else {
            logInfo('No existing install found. Fresh install needed.');

            updateInfo.needsUpdate = true;
            updateInfo.isFreshInstall = true;
            updateInfo.addedModules = distribution.modules.map((module) => {
                let chosenAlternativeKey: string | null = null;
                if (module.kind === 'alternatives') {
                    const choice = options?.moduleAlternativesMap?.get(module.name);

                    if (!choice) {
                        throw FragmenterError.create(FragmenterErrorCode.InvalidOptions, `Alternative not specified for module '${module.name}'`);
                    }

                    chosenAlternativeKey = choice;
                }

                const fileToDownload = this.moduleFileToUse(module, chosenAlternativeKey);

                return {
                    kind: module.kind,
                    name: module.name,
                    destDir: module.destDir,
                    fileToDownload,
                };
            });
            updateInfo.baseChanged = true;
            updateInfo.downloadSize = distribution.fullCompleteFileSize;
            updateInfo.requiredDiskSpace = distribution.fullCompleteFileSizeUncompressed;
            return updateInfo;
        }

        if (existingInstall.base.hash !== distribution.base.hash) {
            logInfo('Base CRC does not match. Update needed.');

            updateInfo.needsUpdate = true;
            updateInfo.baseChanged = true;
        }

        updateInfo.addedModules = distribution.modules.filter((e) => !existingInstall.modules.find((f) => e.name === f.name)).map((module) => {
            let chosenAlternativeKey: string | null = null;
            if (module.kind === 'alternatives') {
                const choice = options?.moduleAlternativesMap?.get(module.name);

                if (!choice) {
                    throw FragmenterError.create(FragmenterErrorCode.InvalidOptions, `Alternative not specified for module '${module.name}'`);
                }

                chosenAlternativeKey = choice;
            }

            const fileToDownload = this.moduleFileToUse(module, chosenAlternativeKey);

            return {
                kind: module.kind,
                name: module.name,
                destDir: module.destDir,
                fileToDownload,
            };
        });
        updateInfo.removedModules = existingInstall.modules.filter((e) => !distribution.modules.find((f) => e.name === f.name));

        for (const module of existingInstall.modules) {
            const moduleInDistribution = distribution.modules.find((it) => it.name === module.name);

            if (!moduleInDistribution) {
                continue;
            }

            let chosenAlternativeKey: string | null = null;
            if (module.kind === 'alternatives') {
                const choice = options?.moduleAlternativesMap?.get(module.name);

                if (!choice) {
                    throw FragmenterError.create(FragmenterErrorCode.InvalidOptions, `Alternative not specified for module '${module.name}'`);
                }

                chosenAlternativeKey = choice;
            }

            const fileToCompare = this.moduleFileToUse(moduleInDistribution, chosenAlternativeKey);

            if (module.kind === 'alternatives' && chosenAlternativeKey === module.installedAlternativeKey) {
                updateInfo.updatedModules.push({ kind: module.kind, name: module.name, destDir: module.destDir, fileToDownload: fileToCompare });
                continue;
            }

            const update = fileToCompare.hash !== module.hash
                && !updateInfo.addedModules.some((it) => it.name === module.name)
                && !updateInfo.removedModules.some((it) => it.name === module.name);

            if (update) {
                updateInfo.updatedModules.push({ kind: module.kind, name: module.name, destDir: module.destDir, fileToDownload: fileToCompare });
            }
        }

        updateInfo.unchangedModules = existingInstall.modules.filter((module) => !(updateInfo.addedModules.some((it) => it.name === module.name))
            && !(updateInfo.removedModules.some((it) => it.name === module.name))
            && !(updateInfo.updatedModules.some((it) => it.name === module.name)));

        if (updateInfo.addedModules.length > 0 || updateInfo.removedModules.length > 0 || updateInfo.updatedModules.length > 0) {
            updateInfo.needsUpdate = true;

            updateInfo.downloadSize = [...updateInfo.addedModules, ...updateInfo.updatedModules].reduce((accu, module) => accu + module.fileToDownload.completeFileSize, 0);
            updateInfo.requiredDiskSpace = [...updateInfo.addedModules, ...updateInfo.updatedModules].reduce((accu, module) => accu + module.fileToDownload.completeFileSizeUncompressed, 0);
        }

        const moduleRatio = (updateInfo.updatedModules.length + updateInfo.addedModules.length) / Math.max(1, updateInfo.existingManifest.modules.length);

        // Force a full install if the ratio is above the configured threshold, if applicable
        if (options.forceFullInstallRatio !== undefined && moduleRatio > options.forceFullInstallRatio) {
            updateInfo.willFullyReDownload = true;
            updateInfo.downloadSize = distribution.fullCompleteFileSize;
            updateInfo.requiredDiskSpace = distribution.fullCompleteFileSizeUncompressed;
        }

        return updateInfo;
    }

    private moduleFileToUse(module: DistributionModule, chosenAlternativeKey: string | null): DistributionModuleFile {
        let fileToCompare: DistributionModuleFile;
        if (module.kind === 'alternatives') {
            const matchingFile = module.downloadFiles.find((it) => it.key === chosenAlternativeKey);

            if (!matchingFile) {
                throw FragmenterError.create(
                    FragmenterErrorCode.InvalidParameters,
                    `Alternatives module '${module.name}' does not have a download file matching the chosen alternative ('${chosenAlternativeKey}')`,
                );
            }

            fileToCompare = matchingFile;
        } else {
            if (module.downloadFiles.length !== 1) {
                throw FragmenterError.create(FragmenterErrorCode.InvalidDistributionManifest, `Non-alternative module '${module.name}' does not have exactly one download file`);
            }

            [fileToCompare] = module.downloadFiles;
        }

        return fileToCompare;
    }
}

/**
 * Get the current install manifest.
 * @param destDir Directory to search.
 */
export function getCurrentInstall(destDir: string): InstallManifest {
    const installManifestPath = path.join(destDir, INSTALL_MANIFEST);
    return fs.readJSONSync(installManifestPath);
}
