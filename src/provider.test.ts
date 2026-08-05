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

    it('keeps synthesized ids distinct across turns', () => {
        // Index alone repeats every response, so replaying a history of turns
        // from a gateway that omits ids would reuse one id for two calls.
        const first = new ToolCallAccumulator('call_0');
        const second = new ToolCallAccumulator('call_1');
        const delta = [{ index: 0, function: { name: 'now', arguments: '{}' } }];
        first.add(delta);
        second.add(delta);

        expect(first.finish()[0]?.id).toBe('call_0_0');
        expect(second.finish()[0]?.id).toBe('call_1_0');
    });

    it('reports arguments it could not parse so they can be logged', () => {
        const accumulator = new ToolCallAccumulator();
        accumulator.add([
            { index: 0, id: 'a', function: { name: 'read', arguments: '{"pa' } },
        ]);

        const [call] = accumulator.finish();
        expect(call?.input).toEqual({});
        expect(call?.malformedArguments).toBe('{"pa');
    });

    it('leaves malformedArguments unset for a clean parse', () => {
        const accumulator = new ToolCallAccumulator();
        accumulator.add([
            { index: 0, id: 'a', function: { name: 'read', arguments: '{}' } },
        ]);

        expect(accumulator.finish()[0]?.malformedArguments).toBeUndefined();
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
