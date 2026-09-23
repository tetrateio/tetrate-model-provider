/**
 * Minimal stand-in for the `vscode` module. Unit tests run outside the
 * extension host, where the real module does not exist; vitest.config.ts aliases
 * `vscode` here. Only the surface the tested code touches is implemented.
 */

export enum LanguageModelChatMessageRole {
    User = 1,
    Assistant = 2,
}

export enum LanguageModelChatToolMode {
    Auto = 1,
    Required = 2,
}

export enum ConfigurationTarget {
    Global = 1,
    Workspace = 2,
    WorkspaceFolder = 3,
}

export enum StatusBarAlignment {
    Left = 1,
    Right = 2,
}

export enum ProgressLocation {
    SourceControl = 1,
    Window = 10,
    Notification = 15,
}

export class LanguageModelTextPart {
    constructor(public value: string) {}
}

export class LanguageModelToolCallPart {
    constructor(
        public callId: string,
        public name: string,
        public input: object
    ) {}
}

export class LanguageModelToolResultPart {
    constructor(
        public callId: string,
        public content: unknown[]
    ) {}
}

export class LanguageModelPromptTsxPart {
    constructor(public value: unknown) {}
}

export class LanguageModelDataPart {
    constructor(
        public data: Uint8Array,
        public mimeType: string
    ) {}

    static text(value: string, mime = 'text/plain'): LanguageModelDataPart {
        return new LanguageModelDataPart(
            new TextEncoder().encode(value),
            mime
        );
    }

    static image(data: Uint8Array, mime: string): LanguageModelDataPart {
        return new LanguageModelDataPart(data, mime);
    }
}

export class LanguageModelError extends Error {
    constructor(
        message: string,
        public readonly code: string
    ) {
        super(message);
    }

    static NoPermissions(message = ''): LanguageModelError {
        return new LanguageModelError(message, 'NoPermissions');
    }

    static Blocked(message = ''): LanguageModelError {
        return new LanguageModelError(message, 'Blocked');
    }

    static NotFound(message = ''): LanguageModelError {
        return new LanguageModelError(message, 'NotFound');
    }
}

export class EventEmitter<T> {
    private listeners: Array<(value: T) => void> = [];

    event = (listener: (value: T) => void) => {
        this.listeners.push(listener);
        return {
            dispose: () => {
                this.listeners = this.listeners.filter((l) => l !== listener);
            },
        };
    };

    fire(value: T): void {
        for (const listener of [...this.listeners]) {
            listener(value);
        }
    }

    dispose(): void {
        this.listeners = [];
    }
}

/** Values returned by `workspace.getConfiguration`; tests overwrite this. */
export const configValues: Record<string, unknown> = {};

export const workspace = {
    getConfiguration(_section?: string) {
        return {
            get<T>(key: string, defaultValue?: T): T | undefined {
                return (configValues[key] as T) ?? defaultValue;
            },
            update(key: string, value: unknown) {
                configValues[key] = value;
                return Promise.resolve();
            },
        };
    },
    onDidChangeConfiguration() {
        return { dispose() {} };
    },
};

export const Uri = {
    parse: (value: string) => ({ toString: () => value }),
};

export const env = {
    openExternal: () => Promise.resolve(true),
};

export const window = {
    showInputBox: () => Promise.resolve(undefined),
    showQuickPick: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
    createOutputChannel: () => ({
        info() {},
        warn() {},
        error() {},
        show() {},
        dispose() {},
    }),
    createStatusBarItem: () => ({
        name: '',
        text: '',
        tooltip: '',
        command: undefined as string | undefined,
        show() {},
        hide() {},
        dispose() {},
    }),
    withProgress: <T>(_options: unknown, task: () => Thenable<T>) => task(),
};

export const commands = {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: () => Promise.resolve(undefined),
};

export const lm = {
    registerLanguageModelChatProvider: () => ({ dispose() {} }),
};
