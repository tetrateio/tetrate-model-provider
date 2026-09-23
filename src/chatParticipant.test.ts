import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { createHandler, type ParticipantDeps } from './chatParticipant';

function model(
    partial: Partial<vscode.LanguageModelChatInformation> & { id: string }
): vscode.LanguageModelChatInformation {
    return {
        name: partial.id,
        family: 'other',
        version: '1.0',
        maxInputTokens: 100_000,
        maxOutputTokens: 28_000,
        capabilities: {},
        ...partial,
    } as vscode.LanguageModelChatInformation;
}

const models = [
    model({
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        family: 'anthropic',
        capabilities: { toolCalling: true, imageInput: true },
    }),
    model({
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        family: 'anthropic',
        capabilities: { toolCalling: true },
    }),
    model({
        id: 'gpt-5-mini',
        name: 'GPT-5 mini',
        family: 'openai',
        capabilities: { toolCalling: true },
    }),
    model({ id: 'mystery-model', name: 'Mystery Model' }),
];

const prices: Record<
    string,
    { inputPer1M: number; outputPer1M: number } | undefined
> = {
    'claude-opus-5': { inputPer1M: 5, outputPer1M: 25 },
    'claude-haiku-4-5': { inputPer1M: 1, outputPer1M: 5 },
    'gpt-5-mini': { inputPer1M: 0.25, outputPer1M: 2 },
};

function makeDeps(overrides: Partial<ParticipantDeps> = {}): ParticipantDeps {
    return {
        usageLines: () => ['claude-opus-5: 2 request(s)', 'Session total: …'],
        today: () => ({ cost: 0.42, requests: 7 }),
        week: () => ({ cost: 3.5, requests: 41 }),
        listModels: () => Promise.resolve(models),
        priceOf: (modelId) => prices[modelId],
        profiles: () => ({
            production: 'https://api.router.tetrate.ai/v1',
            staging: 'https://staging.example.com/v1',
        }),
        currentBaseUrl: () => 'https://api.router.tetrate.ai/v1',
        switchTo: () => Promise.resolve(),
        ...overrides,
    };
}

/** Runs the handler with structural fakes and returns the joined markdown. */
async function run(
    deps: ParticipantDeps,
    command: string | undefined,
    prompt = ''
): Promise<string> {
    const handler = createHandler(deps);
    const markdown = vi.fn();
    const result = await handler(
        { command, prompt } as unknown as vscode.ChatRequest,
        { history: [] } as unknown as vscode.ChatContext,
        { markdown } as unknown as vscode.ChatResponseStream,
        {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose() {} }),
        } as unknown as vscode.CancellationToken
    );
    expect(result).toEqual({});
    return markdown.mock.calls.map((call) => call[0]).join('');
}

describe('/usage', () => {
    it('reports today, the week, and the session lines', async () => {
        const output = await run(makeDeps(), 'usage');

        // formatCost keeps four decimals under a dollar, two above.
        expect(output).toContain('**Today:** $0.4200 across 7 request(s)');
        expect(output).toContain('**Last 7 days:** $3.50 across 41 request(s)');
        expect(output).toContain('- claude-opus-5: 2 request(s)');
        expect(output).toContain('- Session total: …');
    });
});

describe('/models', () => {
    it('filters on vision', async () => {
        const output = await run(makeDeps(), 'models', 'vision');

        expect(output).toContain('claude-opus-5');
        expect(output).not.toContain('claude-haiku-4-5');
        expect(output).not.toContain('gpt-5-mini');
    });

    it('filters on input price and skips models with no known price', async () => {
        const output = await run(makeDeps(), 'models', 'under $3');

        expect(output).toContain('claude-haiku-4-5');
        expect(output).toContain('gpt-5-mini');
        expect(output).not.toContain('claude-opus-5');
        expect(output).not.toContain('mystery-model');
    });

    it('matches bare words against id and name', async () => {
        const output = await run(makeDeps(), 'models', 'haiku');

        expect(output).toContain('claude-haiku-4-5');
        expect(output).not.toContain('claude-opus-5');
        // The table renders name, family, price, and a compact context figure.
        expect(output).toContain('| Model | Provider/family | Price per 1M | Context |');
        expect(output).toContain(
            '| Claude Haiku 4.5 (`claude-haiku-4-5`) | anthropic | $1 in / $5 out | 128K |'
        );
    });

    it('says so when nothing matches', async () => {
        const output = await run(makeDeps(), 'models', 'nonexistent-model');
        expect(output).toContain('No models matched');
    });
});

describe('/switch', () => {
    it('switches to a profile matched case-insensitively', async () => {
        const switchTo = vi.fn(() => Promise.resolve());
        const output = await run(makeDeps({ switchTo }), 'switch', '  Staging ');

        expect(switchTo).toHaveBeenCalledExactlyOnceWith(
            'https://staging.example.com/v1'
        );
        expect(output).toContain('Switched to **staging**');
        expect(output).toContain('https://staging.example.com/v1');
    });

    it('lists the profiles and the current endpoint on no match', async () => {
        const switchTo = vi.fn(() => Promise.resolve());
        const output = await run(makeDeps({ switchTo }), 'switch', 'nope');

        expect(switchTo).not.toHaveBeenCalled();
        expect(output).toContain('production');
        expect(output).toContain('staging');
        expect(output).toContain('https://api.router.tetrate.ai/v1');
    });
});

describe('without a command', () => {
    it('lists the three slash commands', async () => {
        const output = await run(makeDeps(), undefined);

        expect(output).toContain('/usage');
        expect(output).toContain('/models');
        expect(output).toContain('/switch');
    });
});

describe('error handling', () => {
    it('streams a dependency failure instead of throwing', async () => {
        const output = await run(
            makeDeps({
                listModels: () => Promise.reject(new Error('catalog offline')),
            }),
            'models',
            'haiku'
        );
        expect(output).toContain('catalog offline');
    });
});
