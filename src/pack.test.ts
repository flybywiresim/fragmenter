import { pack } from './index';

jest.setTimeout(720_000);

test('Pack', async () => {
    const result = await pack({
        baseDir: './tests/in/pack-01',
        outDir: './tests/out/pack-01',
        modules: [{
            name: 'a',
            sourceDir: './a',
        }, {
            name: 'b',
            sourceDir: './b',
        }, {
            name: 'c',
            sourceDir: './c',
        }],
    });

    expect(result.fullHash).toBe('7a8192768029ad9bd0aff064df12568aeea22573fe12eda88898687232e8cefdb759bf2cbd7795fa5840be1c6886025b86d621c76869df996a18260c535c761c');
    expect(result.base.hash).toBe('c66ac1e5c010060c460d72ee94034f0fff3dffc9ef762502611876fcba444c9d7b5a761952a906175db7e96243b8d93651a0468d3e768709eb7895f36c35ad67');
    expect(result.base.files).toEqual(['a.json', 'module.json']);
    expect(result.modules).toHaveLength(3);
});
