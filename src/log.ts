import { BaseCommandOptions } from './types';

/**
 * Returns, in this order, the info, warn and error settings for logging.
 *
 * @param options an object extending `BaseCommandOptions`
 */
export function getLoggerSettingsFromOptions(options: Partial<BaseCommandOptions>) {
    let useInfoConsoleLog = true;
    if (options?.useConsoleLog !== undefined) {
        if (typeof options.useConsoleLog === 'boolean') {
            useInfoConsoleLog = options.useConsoleLog;
        } else {
            useInfoConsoleLog = options.useConsoleLog.info;
        }
    }

    let useWarnConsoleLog = true;
    if (options?.useConsoleLog !== undefined) {
        if (typeof options.useConsoleLog === 'boolean') {
            useWarnConsoleLog = options.useConsoleLog;
        } else {
            useWarnConsoleLog = options.useConsoleLog.warn;
        }
    }

    let useErrorConsoleLog = true;
    if (options?.useConsoleLog !== undefined) {
        if (typeof options.useConsoleLog === 'boolean') {
            useErrorConsoleLog = options.useConsoleLog;
        } else {
            useErrorConsoleLog = options.useConsoleLog.error;
        }
    }

    return [useInfoConsoleLog, useWarnConsoleLog, useErrorConsoleLog];
}
