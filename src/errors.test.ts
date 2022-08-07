import { FragmenterError, FragmenterErrorCode } from './errors';

describe('FragmenterError', () => {
    describe('isFragmenterError', () => {
        it('identifies a FragmenterError', () => {
            const error = FragmenterError.create(FragmenterErrorCode.PermissionsError, 'aw hell nah');

            expect(FragmenterError.isFragmenterError(error)).toBeTruthy();
        });

        it('does not identify a not FragmenterError', () => {
            const error = new Error('when the amogus imposter is sus');

            expect(FragmenterError.isFragmenterError(error)).toBeFalsy();
        });
    });

    describe('parseFromMessage', () => {
        it('parses valid FragmenterError', () => {
            const msg = 'FragmenterError(PermissionsError): EPERM';

            const parsed = FragmenterError.parseFromMessage(msg);

            expect(parsed.code).toBe(FragmenterErrorCode.PermissionsError);
            expect(parsed.message).toBe('FragmenterError(PermissionsError): EPERM');
        });

        it('does not parse invalid FragmenterError', () => {
            const msg = 'NotAFragmenterError(EPERM)';

            expect(() => {
                FragmenterError.parseFromMessage(msg);
            }).toThrow(expect.objectContaining({ message: 'Could not parse FragmenterError: does not match regex' }));
        });
    });
});
