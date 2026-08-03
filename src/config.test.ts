import { describe, expect, it } from 'vitest';

import {
    DEFAULT_BASE_URL,
    isIncludedByFilter,
    matchesPattern,
    normalizeBaseUrl,
    sanitizeHeaders,
} from './config';

describe('normalizeBaseUrl', () => {
    it('falls back to the Agent Router endpoint when unset or blank', () => {
        expect(normalizeBaseUrl(undefined)).toBe(DEFAULT_BASE_URL);
        expect(normalizeBaseUrl('')).toBe(DEFAULT_BASE_URL);
        expect(normalizeBaseUrl('   ')).toBe(DEFAULT_BASE_URL);
        expect(normalizeBaseUrl('/')).toBe(DEFAULT_BASE_URL);
    });

    it('keeps a configured URL, trimming whitespace and trailing slashes', () => {
        expect(normalizeBaseUrl('  https://gateway.internal/v1/  ')).toBe(
            'https://gateway.internal/v1'
        );
    });

    it('appends /v1 when no version segment is present', () => {
        expect(normalizeBaseUrl('https://gateway.internal')).toBe(
            'https://gateway.internal/v1'
        );
        expect(normalizeBaseUrl('http://localhost:8080/proxy')).toBe(
            'http://localhost:8080/proxy/v1'
        );
    });

    it('leaves an explicit version segment alone', () => {
        expect(normalizeBaseUrl('https://gateway.internal/v2')).toBe(
            'https://gateway.internal/v2'
        );
    });
});

describe('matchesPattern', () => {
    it('matches literally, ignoring case', () => {
        expect(matchesPattern('gpt-5.6-terra', 'gpt-5.6-terra')).toBe(true);
        expect(matchesPattern('gpt-5.6-terra', 'GPT-5.6-TERRA')).toBe(true);
        // `.` must not behave as a wildcard
        expect(matchesPattern('gpt-5x6-terra', 'gpt-5.6-terra')).toBe(false);
    });

    it('treats * as a wildcard', () => {
        expect(matchesPattern('claude-opus-5', 'claude-*')).toBe(true);
        expect(matchesPattern('claude-opus-5', '*opus*')).toBe(true);
        expect(matchesPattern('gemini-3.1-pro-preview', 'claude-*')).toBe(
            false
        );
    });

    it('supports a wildcard mid-pattern and several wildcards', () => {
        expect(matchesPattern('claude-opus-5', 'claude-*-5')).toBe(true);
        expect(matchesPattern('xai/grok-4.5', '*grok*4*')).toBe(true);
        expect(matchesPattern('claude-opus-5', 'claude-*-4')).toBe(false);
    });

    it('escapes regex metacharacters around a wildcard', () => {
        // Each chunk between wildcards is escaped, so these compare literally
        // rather than acting as regex syntax.
        expect(matchesPattern('gpt(5)-mini', 'gpt(5)-*')).toBe(true);
        expect(matchesPattern('gpt5-mini', 'gpt(5)-*')).toBe(false);
        expect(matchesPattern('a+b-model', 'a+b-*')).toBe(true);
        expect(matchesPattern('aab-model', 'a+b-*')).toBe(false);
    });

    it('handles a pattern that is only a wildcard', () => {
        expect(matchesPattern('anything-at-all', '*')).toBe(true);
    });
});

describe('isIncludedByFilter', () => {
    it('includes everything when no filter is configured', () => {
        expect(isIncludedByFilter('anything', [])).toBe(true);
    });

    it('includes a model matching any pattern', () => {
        const filter = ['claude-*', 'gpt-5-mini'];
        expect(isIncludedByFilter('claude-sonnet-5', filter)).toBe(true);
        expect(isIncludedByFilter('gpt-5-mini', filter)).toBe(true);
        expect(isIncludedByFilter('gemini-2.5-flash', filter)).toBe(false);
    });
});

describe('sanitizeHeaders', () => {
    it('keeps ordinary headers', () => {
        expect(sanitizeHeaders({ 'X-Tenant-Id': 'team-platform' })).toEqual({
            'X-Tenant-Id': 'team-platform',
        });
    });

    it('drops Authorization whatever its casing or padding', () => {
        expect(
            sanitizeHeaders({
                Authorization: 'Bearer attacker',
                authorization: 'Bearer attacker',
                ' AUTHORIZATION ': 'Bearer attacker',
                'X-Tenant-Id': 'team-platform',
            })
        ).toEqual({ 'X-Tenant-Id': 'team-platform' });
    });
});
