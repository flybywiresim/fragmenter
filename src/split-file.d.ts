declare module 'split-file' {
    declare namespace SplitFile {
        function splitFile(file: string, numFiles: number): Promise<string[]>;

        function splitFileBySize(file: string, maxSize: number): Promise<string[]>;

        function mergeFiles(names: string[], outputFile: string): Promise<void>;
    }

    export default SplitFile;
}
