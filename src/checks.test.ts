import { getCurrentInstall } from './checks';

test('Current Install', () => {
    const install = getCurrentInstall('./tests/in/update-01');

    expect(install.modules).toHaveLength(10);
    expect(install.base.hash).toEqual('d5daa0c1a723496883e0f47a2516bf977a96dbb4b03e5506bea1fe821057ff97a0f3730775758b88141169fc18e5e3bc31f6e64fee44237a3890ee27de14f122');
});
