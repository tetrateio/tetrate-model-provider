import { describe, expect, it } from 'vitest';

import { validateBaseUrl } from './extension';

describe('validateBaseUrl', () => {
    it('accepts blank input so the default can take over', () => {
        expect(validateBaseUrl('')).toBeNull();
        expect(validateBaseUrl('   ')).toBeNull();
    });

    it('asks for a full URL when the input does not parse as one', () => {
        expect(validateBaseUrl('not a url')).toMatch(/full URL/);
        expect(validateBaseUrl('not a url')).toMatch(/https:\/\//);
    });

    it('rejects schemes other than http and https', () => {
        expect(validateBaseUrl('ftp://x')).toMatch(/http or https/);
    });

    it('accepts http and https URLs', () => {
        expect(validateBaseUrl('https://gateway.internal/v1')).toBeNull();
        expect(validateBaseUrl('http://localhost:8080')).toBeNull();
    });

    it('ignores surrounding whitespace', () => {
        expect(validateBaseUrl(' https://x/v1 ')).toBeNull();
    });
});
