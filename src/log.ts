import { BaseCommandOptions } from './types';

/**
 * Returns, in this order, the info, warn and error settings for logging.
 *
 * @param options an object extending `BaseCommandOptions`
 */
export function getLoggerSettingsFromOptions(options: Partial<BaseCommandOptions>) {
    return [options?.useConsoleLog ?? true, options?.useConsoleLog ?? true, options?.useConsoleLog ?? true];
}
