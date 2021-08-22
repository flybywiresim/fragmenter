import path from 'path';
import fs from 'fs-extra';
import urljoin from 'url-join';
import { DistributionManifest, InstallManifest, NeedsUpdateOptions, UpdateInfo } from './types';
import { INSTALL_MANIFEST, MODULES_MANIFEST } from './constants';

/**
 * Get the current install manifest.
 * @param destDir Directory to search.
 */
export const getCurrentInstall = (destDir: string): InstallManifest => {
    const installManifestPath = path.join(destDir, INSTALL_MANIFEST);
    return fs.readJSONSync(installManifestPath);
};

/**
 * Check, whether a destination directory is up to date or needs to be updated.
 * @param source Base URL of the artifact server.
 * @param destDir Directory to validate.
 * @param options Advanced options for the check.
 */
export const needsUpdate = async (source: string, destDir: string, options?: NeedsUpdateOptions): Promise<UpdateInfo> => {
    if (!fs.existsSync(destDir)) {
        throw new Error('Destination directory does not exist!');
    }

    const installManifestPath = path.join(destDir, INSTALL_MANIFEST);
    let existingInstall: InstallManifest;

    let url = urljoin(source, MODULES_MANIFEST);
    if (options?.forceCacheBust) {
        url += `?cache=${Math.random() * 999999999}`;
    }

    console.log('[FRAGMENT] Downloading module info from', url);
    const distribution: DistributionManifest = (await fetch(url).then((response) => response.json()));
    const updateInfo: UpdateInfo = {
        needsUpdate: false,
        isFreshInstall: false,
        baseChanged: false,
        distributionManifest: distribution,
        existingManifest: undefined,

        addedModules: [],
        removedModules: [],
        updatedModules: [],
    };

    if (fs.existsSync(installManifestPath)) {
        existingInstall = await fs.readJSON(installManifestPath);
        updateInfo.existingManifest = existingInstall;
        console.log('[FRAGMENT] Existing install', existingInstall);
    } else {
        console.log('[FRAGMENT] No existing install found. Update needed.');
        updateInfo.needsUpdate = true;
        updateInfo.isFreshInstall = true;
        updateInfo.addedModules = distribution.modules;
        updateInfo.baseChanged = true;
        return updateInfo;
    }

    if (existingInstall.base.hash !== distribution.base.hash) {
        console.log('[FRAGMENT] Base CRC does not match. Update needed.');
        updateInfo.needsUpdate = true;
        updateInfo.baseChanged = true;
    }

    updateInfo.addedModules = distribution.modules.filter((e) => !existingInstall.modules.find((f) => e.name === f.name));
    updateInfo.removedModules = existingInstall.modules.filter((e) => !distribution.modules.find((f) => e.name === f.name));
    updateInfo.updatedModules = existingInstall.modules.filter((e) => !distribution.modules.find((f) => e.hash === f.hash)
        && !updateInfo.addedModules.includes(e)
        && !updateInfo.removedModules.includes(e));

    if (updateInfo.addedModules.length > 0 || updateInfo.removedModules.length > 0 || updateInfo.updatedModules.length > 0) {
        updateInfo.needsUpdate = true;
    }

    return updateInfo;
};
