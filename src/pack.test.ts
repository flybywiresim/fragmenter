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

    expect(result.fullHash).toBe('798c378b346ec101b3d100c43a04b3609513e9dab6150b6c8f78d86b56fcbf713c2d12eba5d597e5cfe507c0e71e0bc1efc680b5a35c842f723b88c62f1db0ee');
    expect(result.base.hash).toBe('97abb8fde5370d4b0806597f68bcec38c57a0783d6ff26eb8c25c18f327694963e59ae298af2b859cfedbd92f510dba33d2c84d9275430eafe6840a3b95b9b06');
    expect(result.base.files).toEqual(['a.json', 'module.json']);
    expect(result.modules).toHaveLength(3);
});
