// Unit tests for the three bundled output adapters.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { textOutputAdapter } from '../src/output/text.js';
import { jsonOutputAdapter } from '../src/output/json.js';
import { streamJsonOutputAdapter } from '../src/output/stream-json.js';

/** Minimal Writable-like sink that captures every `write()` call. */
function captureSink() {
  const chunks = [];
  return {
    chunks,
    write(s) { chunks.push(s); },
    get text() { return chunks.join(''); },
    get lines() {
      return this.text.split('\n').filter((l) => l.length > 0);
    },
    get jsonLines() {
      return this.lines.map((l) => JSON.parse(l));
    },
  };
}

// ── text ───────────────────────────────────────────────────────────────

describe('textOutputAdapter', () => {
  test('writes the assistant text and one trailing newline', () => {
    const sink = captureSink();
    const a = textOutputAdapter.create({}, sink);
    a.end({ text: 'hello world', isError: false });
    assert.equal(sink.text, 'hello world\n');
  });

  test('does not double up an existing trailing newline', () => {
    const sink = captureSink();
    const a = textOutputAdapter.create({}, sink);
    a.end({ text: 'hello\n', isError: false });
    assert.equal(sink.text, 'hello\n');
  });

  test('handles an empty result gracefully', () => {
    const sink = captureSink();
    const a = textOutputAdapter.create({}, sink);
    a.end({ text: '', isError: false });
    assert.equal(sink.text, '\n');
  });

  test('onEvent is a no-op', () => {
    const sink = captureSink();
    const a = textOutputAdapter.create({}, sink);
    a.onEvent({ type: 'assistant-text', text: 'should not write' });
    assert.equal(sink.text, '');
  });
});

// ── json ───────────────────────────────────────────────────────────────

describe('jsonOutputAdapter', () => {
  test('emits a single JSON object with the expected shape', () => {
    const sink = captureSink();
    const a = jsonOutputAdapter.create({}, sink);
    a.end({
      text: 'answer',
      isError: false,
      sessionId: '11111111-2222-3333-4444-555555555555',
      cost: { totalUsd: null, numTurns: null },
      durationMs: 123,
      completionReason: 'sentinel',
    });
    const objs = sink.jsonLines;
    assert.equal(objs.length, 1);
    assert.equal(objs[0].result, 'answer');
    assert.equal(objs[0].session_id, '11111111-2222-3333-4444-555555555555');
    assert.equal(objs[0].is_error, false);
    assert.deepEqual(objs[0].cost, { total_usd: null, num_turns: null });
    assert.equal(objs[0].duration_ms, 123);
    assert.equal(objs[0].completion, 'sentinel');
  });

  test('reports null fields when the upstream cost is unavailable', () => {
    const sink = captureSink();
    const a = jsonOutputAdapter.create({}, sink);
    a.end({ text: 'x', isError: false });
    const obj = sink.jsonLines[0];
    assert.equal(obj.session_id, null);
    assert.deepEqual(obj.cost, { total_usd: null, num_turns: null });
  });

  test('flips is_error and adds schema_error on json-schema mismatch', () => {
    const sink = captureSink();
    const a = jsonOutputAdapter.create(
      { jsonSchema: { type: 'object', required: ['name'] } },
      sink,
    );
    a.end({ text: '{"other":"thing"}', isError: false });
    const obj = sink.jsonLines[0];
    assert.equal(obj.is_error, true);
    assert.match(obj.schema_error, /missing required key: name/);
  });

  test('passes when the assistant text matches the schema', () => {
    const sink = captureSink();
    const a = jsonOutputAdapter.create(
      { jsonSchema: { type: 'object', required: ['name'] } },
      sink,
    );
    a.end({ text: '{"name":"alice"}', isError: false });
    const obj = sink.jsonLines[0];
    assert.equal(obj.is_error, false);
    assert.equal(obj.schema_error, undefined);
  });
});

// ── stream-json ────────────────────────────────────────────────────────

describe('streamJsonOutputAdapter', () => {
  test('emits assistant-partial for assistant-text events', () => {
    const sink = captureSink();
    const a = streamJsonOutputAdapter.create({}, sink);
    a.onEvent({ type: 'assistant-text', text: 'hello', region: 1 });
    a.onEvent({ type: 'assistant-text', text: 'world', region: 1 });
    const objs = sink.jsonLines;
    assert.equal(objs.length, 2);
    assert.equal(objs[0].type, 'assistant-partial');
    assert.equal(objs[0].delta, 'hello');
    assert.equal(objs[1].delta, 'world');
  });

  test('emits system/init exactly once when session-id is observed', () => {
    const sink = captureSink();
    const a = streamJsonOutputAdapter.create({}, sink);
    a.onEvent({ type: 'session-id', id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    a.onEvent({ type: 'session-id', id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    const inits = sink.jsonLines.filter((o) => o.type === 'system');
    assert.equal(inits.length, 1);
    assert.equal(inits[0].subtype, 'init');
    assert.equal(inits[0].session_id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  test('end() emits system+assistant+result in order', () => {
    const sink = captureSink();
    const a = streamJsonOutputAdapter.create({}, sink);
    a.end({
      text: 'final',
      isError: false,
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      cost: { totalUsd: null, numTurns: null },
      durationMs: 99,
      completionReason: 'sentinel',
    });
    const objs = sink.jsonLines;
    assert.equal(objs[0].type, 'system');
    assert.equal(objs[1].type, 'assistant');
    assert.equal(objs[1].message.content[0].text, 'final');
    assert.equal(objs[2].type, 'result');
    assert.equal(objs[2].subtype, 'success');
  });

  test('error completion yields result.subtype=error', () => {
    const sink = captureSink();
    const a = streamJsonOutputAdapter.create({}, sink);
    a.end({ text: '', isError: true, completionReason: 'timeout' });
    const result = sink.jsonLines.find((o) => o.type === 'result');
    assert.equal(result.subtype, 'error');
    assert.equal(result.completion, 'timeout');
  });

  test('multi-turn: init fires once but result fires per end() call', () => {
    const sink = captureSink();
    const a = streamJsonOutputAdapter.create({}, sink);
    a.onEvent({ type: 'session-id', id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    a.end({ text: 'turn1', sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', completionReason: 'sentinel' });
    a.end({ text: 'turn2', sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', completionReason: 'sentinel' });
    const objs = sink.jsonLines;
    const inits = objs.filter((o) => o.type === 'system');
    const results = objs.filter((o) => o.type === 'result');
    const assistants = objs.filter((o) => o.type === 'assistant');
    assert.equal(inits.length, 1);
    assert.equal(results.length, 2);
    assert.equal(assistants.length, 2);
  });

  test('null-builder events are silently dropped', () => {
    const sink = captureSink();
    const a = streamJsonOutputAdapter.create({}, sink);
    a.onEvent({ type: 'assistant-region-entered', n: 1 });
    a.onEvent({ type: 'prompt-box-shown' });
    a.onEvent({ type: 'sentinel', nonce: 'x' });
    a.onEvent({ type: 'spinner', label: 'thinking' });
    assert.equal(sink.text, ''); // nothing emitted
  });
});
