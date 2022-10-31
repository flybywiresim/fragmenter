export enum FragmenterErrorCode {
    Null,
    PermissionsError,
    ResourcesBusy,
    NoSpaceOnDevice,
    MaxModuleRetries,
    FileNotFound,
    DirectoryNotEmpty,
    NotADirectory,
    ModuleJsonInvalid,
    ModuleCrcMismatch,
    UserAborted,
    NetworkError,
    CorruptedZipFile,
    Unknown,
}

export class FragmenterError extends Error {
    private constructor(
        public readonly code: FragmenterErrorCode,
        public readonly message: string,
        public readonly fromError?: Error,
    ) {
        super(fromError?.message);
    }

    static isFragmenterError(error: Error): error is FragmenterError {
        return error?.message?.includes('FragmenterError(');
    }

    static createFromError(e: Error) {
        const code = this.interpretNodeException(e);

        return new FragmenterError(code, `FragmenterError(${FragmenterErrorCode[code]}): ${e.message}`, e);
    }

    static create(code: FragmenterErrorCode, message: string) {
        return new FragmenterError(code, `FragmenterError(${FragmenterErrorCode[code]}): ${message}`);
    }

    static parseFromMessage(message: string): FragmenterError {
        const regex = /FragmenterError\((\w+)\):\s*(.+)/;

        const match = message.match(regex);

        if (!match) {
            throw new Error('Could not parse FragmenterError: does not match regex');
        }

        const [, codeString, messageString] = match;

        const code = FragmenterErrorCode[codeString as any];

        if (typeof code !== 'number') {
            throw new Error('Could not parse FragmenterError: unknown code string');
        }

        return FragmenterError.create(code, messageString);
    }

    private static interpretNodeException(e: Error): FragmenterErrorCode | null {
        if (CorruptedZipMessages.includes(e.message.trim())) {
            return FragmenterErrorCode.CorruptedZipFile;
        }

        const errorCode = (e as unknown as { code: string }).code ?? e.message;

        switch (errorCode) {
        case 'EACCES':
        case 'EPERM':
            return FragmenterErrorCode.PermissionsError;
        case 'EBUSY':
            return FragmenterErrorCode.ResourcesBusy;
        case 'ENOSPC':
            return FragmenterErrorCode.NoSpaceOnDevice;
        case 'ENOENT':
            return FragmenterErrorCode.FileNotFound;
        case 'ENOTEMPTY':
            return FragmenterErrorCode.DirectoryNotEmpty;
        case 'ENOTDIR':
            return FragmenterErrorCode.NotADirectory;
        case 'ECONNRESET':
        case 'ENOTFOUND':
            return FragmenterErrorCode.NetworkError;
        default:
            return FragmenterErrorCode.Unknown;
        }
    }
}

export const UnrecoverableErrors = [
    FragmenterErrorCode.PermissionsError,
    FragmenterErrorCode.NoSpaceOnDevice,
    FragmenterErrorCode.MaxModuleRetries,
    FragmenterErrorCode.FileNotFound,
    FragmenterErrorCode.DirectoryNotEmpty,
    FragmenterErrorCode.NotADirectory,
];

const CorruptedZipMessages = [
    'unexpected EOF',
    'end of central directory record signature not found',
];
