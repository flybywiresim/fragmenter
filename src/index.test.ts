import { pack } from './index';

test('Pack', async () => {
    const result = await pack({
        baseDir: './test-data/pack-01',
        outDir: './test-data/out/pack-01',
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

    expect(result.fullHash).toBe('454318a74acf49697c8e0deb4dd35fab94ae2273332073bb48039afb92f21f8c11b46e246dcd0762fcd7573c65baf6a5ea9368e7aaa9a54fb71ab17c05ee4446');
    expect(result.base.hash).toBe('c0a7e61ba946b06c58287f913ec159dd22a96ace006d917df4c9dfeb000f9664545ed8211952103051ab5dea82ff87fa4797ec717f117a592c9e3008525c5b59');
    expect(result.base.files).toEqual(['a.json', 'module.json']);
    expect(result.modules).toHaveLength(3);
});
