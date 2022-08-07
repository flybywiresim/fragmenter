export enum FragmenterErrorCode {
    Null,
    PermissionsError,
    NoSpaceOnDevice,
    MaxModuleRetries,
    FileNotFound,
    DirectoryNotEmpty,
    NotADirectory,
    ModuleJsonInvalid,
    ModuleCrcMismatch,
    UserAborted,
    DownloadStreamClosed,
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
        return error.message.includes('FragmenterError(');
    }

    static createFromError(e: Error) {
        const code = this.interpretNodeException(e);

        return new FragmenterError(code, `FragmenterError(${FragmenterErrorCode[code]}): ${e.message}`, e);
    }

    static create(code: FragmenterErrorCode, message: string) {
        return new FragmenterError(code, `FragmenterError(${FragmenterErrorCode[code]}): ${message}`);
    }

    private static interpretNodeException(e: Error): FragmenterErrorCode | null {
        const errorCode = (e as unknown as { code: string }).code ?? e.message;

        switch (errorCode) {
        case 'EACCES':
        case 'EPERM':
            return FragmenterErrorCode.PermissionsError;
        case 'ENOSPC':
            return FragmenterErrorCode.NoSpaceOnDevice;
        case 'ENOENT':
            return FragmenterErrorCode.FileNotFound;
        case 'ENOTEMPTY':
            return FragmenterErrorCode.DirectoryNotEmpty;
        case 'ENOTDIR':
            return FragmenterErrorCode.NotADirectory;
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
