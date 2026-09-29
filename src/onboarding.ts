/**
 * The Test Connection probe: one minimal chat completion against the
 * configured endpoint. It exists to answer "is the URL right and does the key
 * work" in one round trip, so the result is a plain value rather than an
 * exception — the caller always has something to show the user.
 *
 * Deliberately free of any `vscode` import, like usage.ts, so it stays
 * trivially testable.
 */

/**
 * Generous on purpose: the probe may hit a cold model, and a slow first
 * answer is still a working connection.
 */
export const PROBE_TIMEOUT_MS = 30_000;

export type ProbeResult =
    | { ok: true; modelId: string; ms: number }
    | { ok: false; message: string };

/**
 * Sends the cheapest possible completion — one token in, one token out — and
 * reports how the endpoint answered. Never throws: any 2xx proves the
 * connection, anything else comes back as a message worth showing verbatim,
 * since the endpoint's own error text ("invalid API key", "model not found")
 * is more actionable than anything synthesized here.
 */
/**
 * The passthrough counterpart of probeCompletion: one minimal Anthropic
 * Messages call with the user's Anthropic key in `x-api-key` and the Agent
 * Router key in `x-tars-api-key`, exactly as a passthrough request carries
 * them. `messagesBaseUrl` is the gateway without its `/v1` segment.
 */
export async function probePassthrough(options: {
    messagesBaseUrl: string;
    apiKey: string;
    anthropicKey: string;
    headers: Record<string, string>;
    modelId: string;
}): Promise<ProbeResult> {
    return probe(`${options.messagesBaseUrl}/v1/messages`, options.modelId, {
        headers: {
            ...options.headers,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': options.anthropicKey,
            'x-tars-api-key': options.apiKey,
        },
        body: {
            model: options.modelId,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
        },
    });
}

export async function probeCompletion(options: {
    baseUrl: string;
    apiKey: string;
    headers: Record<string, string>;
    modelId: string;
}): Promise<ProbeResult> {
    return probe(`${options.baseUrl}/chat/completions`, options.modelId, {
        headers: {
            ...options.headers,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
        },
        body: {
            model: options.modelId,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            stream: false,
        },
    });
}

async function probe(
    url: string,
    modelId: string,
    request: { headers: Record<string, string>; body: object }
): Promise<ProbeResult> {
    const controller = new AbortController();
    // Neither `fetch` nor VS Code imposes a deadline of its own, so a stalled
    // proxy would otherwise leave the probe spinning forever. The abort reason
    // becomes the reported message, so it names the allowance that ran out.
    const timer = setTimeout(
        () =>
            controller.abort(
                new Error(`the probe timed out after ${PROBE_TIMEOUT_MS} ms`)
            ),
        PROBE_TIMEOUT_MS
    );
    const startedAt = Date.now();

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: controller.signal,
        });

        if (response.ok) {
            return { ok: true, modelId, ms: Date.now() - startedAt };
        }

        // The body usually carries the endpoint's own explanation; losing it
        // to a read failure must not turn the status itself into a throw.
        const body = (await response.text().catch(() => '')).trim().slice(0, 200);
        return {
            ok: false,
            message: `HTTP ${response.status} ${response.statusText}${body ? `: ${body}` : ''}`,
        };
    } catch (error) {
        return {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
        };
    } finally {
        clearTimeout(timer);
    }
}
