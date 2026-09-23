import { describe, expect, it } from 'vitest';

import { filterFromSelection, validateBaseUrl } from './extension';

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

describe('filterFromSelection', () => {
    it('writes the exact ids for a partial selection', () => {
        expect(filterFromSelection(3, ['a', 'b'])).toEqual(['a', 'b']);
    });

    it('clears the filter when everything is selected', () => {
        // An empty filter keeps offering models added upstream later, which a
        // frozen list of every current id would not.
        expect(filterFromSelection(3, ['a', 'b', 'c'])).toEqual([]);
    });

    it('treats an empty selection as no change', () => {
        // Writing [] for "none" would mean the opposite: offer everything.
        expect(filterFromSelection(3, [])).toBeUndefined();
    });
});
