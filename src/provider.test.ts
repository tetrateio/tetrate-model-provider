import { describe, expect, it } from 'vitest';

import { parseArguments, ToolCallAccumulator } from './provider';

describe('ToolCallAccumulator', () => {
    it('reassembles a call split across chunks', () => {
        const accumulator = new ToolCallAccumulator();
        accumulator.add([
            {
                index: 0,
                id: 'call-1',
                function: { name: 'read_', arguments: '{"pa' },
            },
        ]);
        accumulator.add([
            { index: 0, function: { name: 'file', arguments: 'th":"a.ts"}' } },
        ]);

        expect(accumulator.finish()).toEqual([
            { id: 'call-1', name: 'read_file', input: { path: 'a.ts' } },
        ]);
    });

    it('keeps parallel calls apart and orders them by index', () => {
        const accumulator = new ToolCallAccumulator();
        accumulator.add([
            { index: 1, id: 'b', function: { name: 'second', arguments: '{}' } },
            { index: 0, id: 'a', function: { name: 'first', arguments: '{}' } },
        ]);

        expect(accumulator.finish().map((call) => call.name)).toEqual([
            'first',
            'second',
        ]);
    });

    it('synthesizes an id when the gateway omits one', () => {
        const accumulator = new ToolCallAccumulator();
        accumulator.add([
            { index: 2, function: { name: 'now', arguments: '{}' } },
        ]);

        expect(accumulator.finish()[0]?.id).toBe('call_2');
    });

    it('ignores a delta that never produced a name', () => {
        const accumulator = new ToolCallAccumulator();
        accumulator.add([{ index: 0, id: 'call-1' }]);
        accumulator.add(undefined);

        expect(accumulator.finish()).toEqual([]);
    });
});

describe('parseArguments', () => {
    it('parses a JSON object', () => {
        expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
    });

    it('returns an empty object for empty, invalid or non-object input', () => {
        expect(parseArguments('')).toEqual({});
        expect(parseArguments('   ')).toEqual({});
        expect(parseArguments('{"a":')).toEqual({});
        expect(parseArguments('null')).toEqual({});
        expect(parseArguments('42')).toEqual({});
    });
});
