import { pack } from './index';

jest.setTimeout(720_000);

describe('packer', () => {
    test('pack', async () => {
        const result = await pack({
            version: '0.1.0',
            baseDir: './tests/in/pack-01',
            outDir: './tests/out/pack-01',
            modules: [{
                kind: 'simple',
                name: 'a',
                sourceDir: './a',
                destDir: './a',
            }, {
                kind: 'simple',
                name: 'b',
                sourceDir: './b',
                destDir: './b',
            }, {
                kind: 'simple',
                name: 'c',
                sourceDir: './c',
                destDir: './c',
            }, {
                kind: 'alternatives',
                name: 'd',
                destDir: './d',
                alternatives: [
                    {
                        key: 'alt-a',
                        name: 'Alternative A',
                        sourceDir: './d/a',
                    },
                    {
                        key: 'alt-b',
                        name: 'Alternative B',
                        sourceDir: './d/b',
                    },
                ],
            }],
        });

        expect(result.version).toBe('0.1.0');
        expect(result.fullHash).toBe('65f22a91c04097ba2d407fd6c5bfe1505b065380d65df10127049f4c54ab90f7354adbd658f3848262d62cf80714be8d4653372aa62177d1ec3aebbd319da212');
        expect(result.base.hash).toBe('cc82444cff4acb62d6285274bd640ee61db81d98d78c4c5ff80710aa410a5577cc1e42684737b2fb576af1f34810c4c7e28e869efac1cdccb28bc1306304f566');
        expect(result.base.files).toEqual(['a.json', 'module.json']);
        expect(result.modules).toHaveLength(4);
    });
});
