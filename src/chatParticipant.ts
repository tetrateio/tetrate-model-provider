import * as vscode from 'vscode';

import { formatContext } from './modelPicker';
import { formatCost } from './usage';

/**
 * The `@tetrate` chat participant: usage figures, a model search, and an
 * endpoint switch, reachable from the chat view without leaving the
 * conversation. The extension supplies its state through {@link ParticipantDeps}
 * so the handler stays a pure function of its inputs and tests need no wiring.
 */

export type ParticipantDeps = {
    /** Session summary lines, one per model plus a total. */
    usageLines(): string[];
    today(): { cost: number; requests: number };
    week(): { cost: number; requests: number };
    listModels(): Promise<readonly vscode.LanguageModelChatInformation[]>;
    priceOf(
        modelId: string
    ): { inputPer1M: number; outputPer1M: number } | undefined;
    profiles(): Record<string, string>;
    currentBaseUrl(): string;
    switchTo(url: string): Promise<void>;
};

/** Keeps a broad query readable; the Choose Models pick handles the long tail. */
const MAX_TABLE_ROWS = 15;

export function createHandler(deps: ParticipantDeps): vscode.ChatRequestHandler {
    return async (request, _context, stream, _token) => {
        // A dependency failure becomes a line in the response: the chat view
        // renders a thrown error as an opaque failure, which helps nobody.
        try {
            switch (request.command) {
                case 'usage':
                    respondUsage(deps, stream);
                    break;
                case 'models':
                    await respondModels(deps, request.prompt, stream);
                    break;
                case 'switch':
                    await respondSwitch(deps, request.prompt, stream);
                    break;
                default:
                    respondHelp(stream);
            }
        } catch (error) {
            stream.markdown(
                `Something went wrong: ${error instanceof Error ? error.message : String(error)}\n`
            );
        }
        return {};
    };
}

export function registerTetrateParticipant(
    deps: ParticipantDeps
): vscode.Disposable {
    return vscode.chat.createChatParticipant(
        'tetrate-model-provider.tetrate',
        createHandler(deps)
    );
}

function respondUsage(
    deps: ParticipantDeps,
    stream: vscode.ChatResponseStream
): void {
    const today = deps.today();
    const week = deps.week();
    stream.markdown(
        `**Today:** ${formatCost(today.cost)} across ${today.requests} request(s)\n\n` +
            `**Last 7 days:** ${formatCost(week.cost)} across ${week.requests} request(s)\n\n` +
            '**This session:**\n\n'
    );
    for (const line of deps.usageLines()) {
        stream.markdown(`- ${line}\n`);
    }
}

/** What `/models <query>` understands, extracted word by word. */
type ModelQuery = {
    vision: boolean;
    tools: boolean;
    /** Input dollars per 1M the model must stay strictly under. */
    maxInputPrice?: number;
    /** Whatever words remain match against the id and display name. */
    terms: string[];
};

function parseModelQuery(prompt: string): ModelQuery {
    let rest = prompt;
    let maxInputPrice: number | undefined;
    // The price phrase is cut out before word-splitting, so neither "under"
    // nor the number leaks into the substring terms.
    const priceMatch = rest.match(/under \$?(\d+(?:\.\d+)?)/i);
    if (priceMatch) {
        maxInputPrice = Number(priceMatch[1]);
        rest = rest.replace(priceMatch[0], ' ');
    }
    const words = rest.toLowerCase().split(/\s+/).filter(Boolean);
    return {
        vision: words.includes('vision'),
        tools: words.includes('tools') || words.includes('tool'),
        ...(maxInputPrice !== undefined ? { maxInputPrice } : {}),
        terms: words.filter(
            (word) => !['vision', 'tools', 'tool'].includes(word)
        ),
    };
}

async function respondModels(
    deps: ParticipantDeps,
    prompt: string,
    stream: vscode.ChatResponseStream
): Promise<void> {
    const query = parseModelQuery(prompt);
    const models = await deps.listModels();

    const matches = models.filter((model) => {
        if (query.vision && !model.capabilities?.imageInput) {
            return false;
        }
        if (query.tools && !model.capabilities?.toolCalling) {
            return false;
        }
        if (query.maxInputPrice !== undefined) {
            const price = deps.priceOf(model.id);
            // A model without a known price cannot honestly claim to be under
            // any budget, so a price filter excludes it.
            if (!price || price.inputPer1M >= query.maxInputPrice) {
                return false;
            }
        }
        const haystack = `${model.id} ${model.name}`.toLowerCase();
        return query.terms.every((term) => haystack.includes(term));
    });

    if (matches.length === 0) {
        stream.markdown('No models matched that query.\n');
        return;
    }

    const rows = matches.slice(0, MAX_TABLE_ROWS).map((model) => {
        const price = deps.priceOf(model.id);
        const priceLabel = price
            ? `$${price.inputPer1M} in / $${price.outputPer1M} out`
            : 'unknown';
        return `| ${model.name} (\`${model.id}\`) | ${model.family} | ${priceLabel} | ${formatContext(model)} |`;
    });
    const truncated =
        matches.length > MAX_TABLE_ROWS
            ? `\n…and ${matches.length - MAX_TABLE_ROWS} more; narrow the query to see them.\n`
            : '';

    stream.markdown(
        '| Model | Provider/family | Price per 1M | Context |\n' +
            '| --- | --- | --- | --- |\n' +
            `${rows.join('\n')}\n${truncated}`
    );
}

async function respondSwitch(
    deps: ParticipantDeps,
    prompt: string,
    stream: vscode.ChatResponseStream
): Promise<void> {
    const wanted = prompt.trim();
    const profiles = deps.profiles();
    const match = Object.entries(profiles).find(
        ([name]) => name.toLowerCase() === wanted.toLowerCase()
    );

    if (match) {
        const [name, url] = match;
        await deps.switchTo(url);
        stream.markdown(`Switched to **${name}** (${url}).\n`);
        return;
    }

    const names = Object.keys(profiles);
    stream.markdown(
        (names.length > 0
            ? `No profile named "${wanted}". Available profiles: ${names.join(', ')}.\n\n`
            : 'No profiles are configured; add some under the `profiles` setting.\n\n') +
            `Current endpoint: ${deps.currentBaseUrl()}\n`
    );
}

function respondHelp(stream: vscode.ChatResponseStream): void {
    stream.markdown(
        'I answer questions about the Tetrate Agent Router connection.\n\n' +
            '- `/usage` — spend for today, the last 7 days, and this session\n' +
            '- `/models <query>` — search the model list; try `vision`, `tools`, `under $3`, or any word from a model name\n' +
            '- `/switch <profile>` — switch to a named endpoint profile\n'
    );
}
