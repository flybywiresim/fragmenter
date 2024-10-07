import { FragmenterInstaller } from './fragmenter-installer';
import { FragmenterContext } from '../core';

const jestConsole = console;

beforeEach(() => {
    // eslint-disable-next-line global-require
    global.console = require('console');
});

afterEach(() => {
    global.console = jestConsole;
});

jest.setTimeout(360_000);

describe('FragmenterInstaller', () => {
    const TEST_FILES_BASE_URL = 'https://flybywirecdn.com/addons/fragmenter-test-2/';

    const FRESH_INSTALL_PATH = 'tests/out/fresh-install-01/';

    it('can perform a fresh install', async () => {
        const abortController = new AbortController();

        const ctx = new FragmenterContext({ forceCacheBust: true, useConsoleLog: true }, abortController.signal);
        const installer = new FragmenterInstaller(ctx, TEST_FILES_BASE_URL, FRESH_INSTALL_PATH, { moduleAlternativesMap: new Map([['d', 'alt-a']]) });

        let lastPct = -1;
        installer.on('error', (e) => console.error(e));
        installer.on('downloadProgress', (m, p) => {
            const pct = Math.round((p.loaded / p.total) * 100);

            if (pct !== lastPct) {
                console.log(`Progress: module=${m.name} @ ${pct}%${Number.isFinite(p.partIndex) ? ` (${p.partIndex + 1}/${p.numParts})` : ''}`);

                lastPct = pct;
            }
        });
        installer.on('unzipProgress', (m, p) => {
            console.log(`Unzip progress: module=${m.name} ${p.entryIndex + 1}/${p.entryCount}`);
        });

        await installer.install();
    });

    it('can cancel an install', async () => {
        const abortController = new AbortController();

        const ctx = new FragmenterContext({ forceCacheBust: true, useConsoleLog: true }, abortController.signal);
        const installer = new FragmenterInstaller(ctx, TEST_FILES_BASE_URL, FRESH_INSTALL_PATH, {});

        installer.on('error', (e) => console.error(e));

        const timeout = setTimeout(() => {
            abortController.abort();
        }, 3_000);

        await installer.install();

        clearTimeout(timeout);
    });
});
