/**
 * Opt-in tests that hit the real Agent Router service. They are skipped by
 * default so the unit suite stays offline and deterministic.
 *
 *   TARS_INTEGRATION=1 npm test                       # public catalog only
 *   TARS_INTEGRATION=1 AGENTROUTER_API_KEY=sk-... npm test   # also /v1/models
 */
import { describe, expect, it } from 'vitest';

import {
    fetchApiModels,
    fetchPublicCatalog,
    isChatModel,
    selectChatModels,
} from '../catalog';
import { DEFAULT_BASE_URL } from '../config';

const enabled = process.env.TARS_INTEGRATION === '1';
const apiKey = process.env.AGENTROUTER_API_KEY;

describe.skipIf(!enabled)('public Agent Router catalog', () => {
    it('returns a catalog with the metadata the provider relies on', async () => {
        const catalog = await fetchPublicCatalog();
        expect(catalog.size).toBeGreaterThan(50);

        const conversational = [...catalog.values()].filter((model) =>
            isChatModel({ id: model.model }, model)
        );
        expect(conversational.length).toBeGreaterThan(50);

        // Most entries carry a context window; a handful do not, which is why
        // toChatInformation falls back rather than trusting the field.
        const withContext = conversational.filter(
            (model) =>
                typeof model.contextWindow === 'number' &&
                model.contextWindow > 0
        );
        expect(withContext.length / conversational.length).toBeGreaterThan(0.9);
    });

    it('still offers the OpenAI line-up, which is catalogued as responses mode', async () => {
        const catalog = await fetchPublicCatalog();
        const ids = [...catalog.values()].map((model) => ({
            id: model.model,
        }));
        const models = selectChatModels(ids, catalog, { modelFilter: [] });
        const offered = new Set(models.map((model) => model.id));

        expect(offered.has('gpt-5.6-terra')).toBe(true);
        expect(offered.has('claude-opus-5')).toBe(true);
        // Embedding and image models must not reach the picker.
        expect(offered.has('text-embedding-3-large')).toBe(false);
        expect([...offered].some((id) => id.startsWith('gpt-image'))).toBe(
            false
        );
    });

    it('maps every offered model to usable limits', async () => {
        const catalog = await fetchPublicCatalog();
        const ids = [...catalog.values()].map((model) => ({
            id: model.model,
        }));

        const models = selectChatModels(ids, catalog, { modelFilter: [] });
        expect(models.length).toBeGreaterThan(50);

        for (const model of models) {
            expect(model.maxInputTokens).toBeGreaterThan(0);
            expect(model.maxOutputTokens).toBeGreaterThan(0);
            expect(model.id).not.toBe('');
            expect(model.name).not.toBe('');
            expect(model.version).toMatch(/^\d/);
        }
    });
});

describe.skipIf(!enabled || !apiKey)('authenticated /v1/models', () => {
    it('lists models the key can reach and maps them to chat models', async () => {
        const apiModels = await fetchApiModels(
            DEFAULT_BASE_URL,
            apiKey as string,
            {}
        );
        expect(apiModels.length).toBeGreaterThan(0);

        const catalog = await fetchPublicCatalog();
        const models = selectChatModels(apiModels, catalog, {
            modelFilter: [],
        });
        expect(models.length).toBeGreaterThan(0);
    });

    it('reports an unauthorized key as an error rather than an empty list', async () => {
        await expect(
            fetchApiModels(DEFAULT_BASE_URL, 'sk-invalid', {})
        ).rejects.toThrow(/401/);
    });
});
