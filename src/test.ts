import { pack, install, needsUpdate } from './index';

const test = async (doBuild: boolean, doCheck: boolean, doInstall: boolean) => {
    try {
        if (doBuild) {
            console.log('\n\n======== Build ========\n');
            const details = await pack({
                baseDir: '../a32nx/A32NX',
                outDir: './test/out',
                modules: [{
                    name: 'effects',
                    sourceDir: './effects'
                }, {
                    name: 'html_ui',
                    sourceDir: './html_ui'
                }, {
                    name: 'CUSTOMIZE',
                    sourceDir: './CUSTOMIZE'
                }, {
                    name: 'ModelBehaviorDefs',
                    sourceDir: './ModelBehaviorDefs'
                }, {
                    name: 'Textures',
                    sourceDir: './SimObjects/AirPlanes/Asobo_A320_NEO/TEXTURE'
                }, {
                    name: 'Livery',
                    sourceDir: './SimObjects/AirPlanes/Asobo_A320_NEO-LIVERY'
                }, {
                    name: 'Sound',
                    sourceDir: './SimObjects/AirPlanes/Asobo_A320_NEO/sound'
                }, {
                    name: 'Model',
                    sourceDir: './SimObjects/AirPlanes/Asobo_A320_NEO/model'
                }]
            });
            console.log(details);
        }

        if (doCheck) {
            console.log('\n\n======== Update check ========\n');
            const details = await needsUpdate('http://localhost:5000', './test/mods/A32NX');
            console.log(details);
        }

        if (doInstall) {
            console.log('\n\n======== Install ========\n');
            const details = await install('https://flybywiresim.b-cdn.net/addons/a32nx/vmaster', './test/mods/A32NX', false, progress => {
                console.log(progress);
            });
            console.log(details);
        }
    } catch (e) {
        console.error(e);
    }
};


test(false, false, true);
