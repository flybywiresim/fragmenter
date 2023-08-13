import EventEmitter from 'events';
import { BaseCommandOptions } from '../types';
import TypedEventEmitter from '../typed-emitter';
import { FragmenterOperation, FragmenterPhase } from './fragmenter-operation';

export interface FragmenterContextEvents {
    'phaseChange': (phase: FragmenterPhase) => void,
    'logInfo': (...bits: any[]) => void,
    'logWarn': (...bits: any[]) => void,
    'logTrace': (...bits: any[]) => void,
    'logError': (...bits: any[]) => void,
}

export class FragmenterContext extends (EventEmitter as new () => TypedEventEmitter<FragmenterContextEvents>) {
    readonly options: BaseCommandOptions;

    private readonly doUseConsole: boolean;

    private phase: FragmenterPhase = { op: FragmenterOperation.NotStarted };

    public get currentPhase() {
        return this.phase;
    }

    public set currentPhase(phase: FragmenterPhase) {
        this.phase = phase;
        this.emit('phaseChange', this.phase);
    }

    public unrecoverableErrorEncountered = false;

    constructor(
        options: Partial<BaseCommandOptions>,
        readonly signal: AbortSignal,
    ) {
        // eslint-disable-next-line constructor-super
        super();

        this.options = {
            useConsoleLog: true,
            forceCacheBust: false,
            logTrace: false,
            userAgent: undefined,
            ...options,
        };

        this.doUseConsole = this.options.useConsoleLog === true;
    }

    logInfo(...bits: any[]) {
        if (this.doUseConsole) {
            console.log(...bits);
        } else {
            this.emit('logInfo', ...bits);
        }
    }

    logWarn(...bits: any[]) {
        if (this.doUseConsole) {
            console.warn(...bits);
        } else {
            this.emit('logWarn', ...bits);
        }
    }

    logTrace(...bits: any[]) {
        if (this.doUseConsole && this.options.logTrace) {
            console.debug(...bits);
        } else {
            this.emit('logTrace', ...bits);
        }
    }

    logError(...bits: any[]) {
        if (this.doUseConsole) {
            console.error(...bits);
        } else {
            this.emit('logError', ...bits);
        }
    }
}
