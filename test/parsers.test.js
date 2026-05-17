// Unit tests for the parser pipeline modules.
//
// Run with: `node --test test/parsers.test.js` (or `npm test`).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ansiStripParser } from '../src/parsers/ansi-strip.js';
import {
  tuiFrameParser,
  PATTERNS as TUI_PATTERNS,
  resolveCarriageReturns,
} from '../src/parsers/tui-frame.js';
import { createSentinelParser } from '../src/parsers/sentinel.js';
import { createPipeline } from '../src/parsers/pipeline.js';

// ── ANSI strip ─────────────────────────────────────────────────────────

describe('ansiStripParser', () => {
  test('passes plain text through unchanged', () => {
    const p = ansiStripParser.create();
    const r = p.feed('hello world');
    assert.equal(r.text, 'hello world');
    assert.deepEqual(r.events, []);
  });

  test('strips CSI color codes', () => {
    const p = ansiStripParser.create();
    assert.equal(p.feed('\x1b[31mred\x1b[0m').text, 'red');
    assert.equal(p.feed('\x1b[1;32mgreen').text, 'green');
  });

  test('strips OSC sequences (BEL terminated)', () => {
    const p = ansiStripParser.create();
    assert.equal(p.feed('\x1b]0;title\x07after').text, 'after');
  });

  test('strips OSC sequences (ST terminated)', () => {
    const p = ansiStripParser.create();
    assert.equal(p.feed('\x1b]0;title\x1b\\after').text, 'after');
  });

  test('strips DEC private 2-byte forms (ESC 7, ESC 8, ESC =, ESC >)', () => {
    const p = ansiStripParser.create();
    assert.equal(p.feed('\x1b7save\x1b8restore\x1b=keypad\x1b>normal').text, 'saverestorekeypadnormal');
  });

  test('strips C1 7-bit aliases (ESC @ .. ESC _)', () => {
    const p = ansiStripParser.create();
    assert.equal(p.feed('a\x1bMb').text, 'ab');     // ESC M (RI - reverse index)
    const q = ansiStripParser.create();
    assert.equal(q.feed('x\x1b_apc\x1b\\y').text, 'xy'); // APC followed by ST
  });

  test('buffers a partial CSI across chunks', () => {
    const p = ansiStripParser.create();
    const r1 = p.feed('foo\x1b[3');     // incomplete CSI
    const r2 = p.feed('1mred\x1b[0m');  // completion
    assert.equal(r1.text, 'foo');
    assert.equal(r2.text, 'red');
  });

  test('buffers a partial OSC across chunks', () => {
    const p = ansiStripParser.create();
    const r1 = p.feed('a\x1b]0;ti');   // incomplete OSC (no BEL/ST yet)
    const r2 = p.feed('tle\x07b');     // BEL closes it
    assert.equal(r1.text, 'a');
    assert.equal(r2.text, 'b');
  });

  test('reset() clears the pending buffer', () => {
    const p = ansiStripParser.create();
    p.feed('a\x1b['); // partial CSI held
    p.reset();
    // After reset, the next feed should not be polluted by the prior partial
    assert.equal(p.feed('x').text, 'x');
  });
});

// ── Sentinel parser ────────────────────────────────────────────────────

describe('createSentinelParser', () => {
  test('emits a sentinel event for every occurrence', () => {
    const p = createSentinelParser('abc123').create();
    const r = p.feed('hello ⟦OCP_END:abc123⟧ world ⟦OCP_END:abc123⟧ done');
    assert.equal(r.events.filter((e) => e.type === 'sentinel').length, 2);
    assert.equal(r.events[0].nonce, 'abc123');
    assert.equal(r.events[1].nonce, 'abc123');
  });

  test('ignores sentinels with a different nonce', () => {
    const p = createSentinelParser('abc123').create();
    const r = p.feed('echo ⟦OCP_END:OTHER⟧ here');
    assert.deepEqual(r.events, []);
  });

  test('matches a sentinel split across chunks', () => {
    const p = createSentinelParser('abc123').create();
    assert.deepEqual(p.feed('start ⟦OCP_').events, []);
    const r2 = p.feed('END:abc123⟧ end');
    assert.equal(r2.events.length, 1);
    assert.equal(r2.events[0].type, 'sentinel');
  });

  test('does not re-emit the same sentinel occurrence', () => {
    const p = createSentinelParser('abc123').create();
    p.feed('foo ⟦OCP_END:abc123⟧');
    const r2 = p.feed(' bar');
    assert.deepEqual(r2.events, []);
  });
});

// ── TUI frame parser ───────────────────────────────────────────────────

describe('tuiFrameParser', () => {
  test('emits assistant-region-entered on first ⏺ line', () => {
    const p = tuiFrameParser.create();
    const r = p.feed('⏺ hello\n');
    const types = r.events.map((e) => e.type);
    assert.ok(types.includes('assistant-region-entered'));
    const text = r.events.find((e) => e.type === 'assistant-text');
    assert.equal(text.text, 'hello');
    assert.equal(text.region, 1);
  });

  test('emits assistant-region-exited on horizontal rule', () => {
    const p = tuiFrameParser.create();
    p.feed('⏺ hello\n');
    const r2 = p.feed('────────────────────────\n');
    const types = r2.events.map((e) => e.type);
    assert.ok(types.includes('assistant-region-exited'));
    // Horizontal rules alone do NOT signal prompt-box-shown — the
    // welcome banner uses box borders too, so we only fire that event
    // on the `❯` input chevron (see test below).
    assert.ok(!types.includes('prompt-box-shown'));
  });

  test('emits prompt-box-shown when input chevron appears', () => {
    const p = tuiFrameParser.create();
    const r = p.feed('❯ Try "refactor <filepath>"\n');
    const types = r.events.map((e) => e.type);
    assert.ok(types.includes('prompt-box-shown'));
  });

  test('closes region when sentinel appears on the marker line', () => {
    const p = tuiFrameParser.create();
    const r = p.feed('⏺ apple⟦OCP_END:deadbeef⟧\n');
    const types = r.events.map((e) => e.type);
    assert.ok(types.includes('assistant-region-entered'));
    assert.ok(types.includes('assistant-region-exited'));
    const text = r.events.find((e) => e.type === 'assistant-text');
    assert.equal(text.text, 'apple');
  });

  test('numbers regions across multiple ⏺ markers (resume case)', () => {
    const p = tuiFrameParser.create();
    p.feed('⏺ old response\n');
    p.feed('──────────────\n');
    const r3 = p.feed('⏺ new response⟦OCP_END:cafebabe⟧\n');
    const entered = r3.events.find((e) => e.type === 'assistant-region-entered');
    assert.equal(entered.n, 2);
    const text = r3.events.find((e) => e.type === 'assistant-text');
    assert.equal(text.region, 2);
    assert.equal(text.text, 'new response');
  });

  test('detects session-id banner across chunks', () => {
    const p = tuiFrameParser.create();
    p.feed('Resume this session with:\n');
    const r = p.feed('claude --resume 11111111-2222-3333-4444-555555555555\n');
    const sid = r.events.find((e) => e.type === 'session-id');
    assert.ok(sid);
    assert.equal(sid.id, '11111111-2222-3333-4444-555555555555');
  });

  test('treats bare \\r as a line ender (in-place redraw)', () => {
    const p = tuiFrameParser.create();
    const r = p.feed('⏺ first\r⏺ second\n');
    // Each \r-separated segment is processed as its own line. Two ⏺
    // markers => two region-entered events. The extractor downstream
    // picks the max region (i.e. the later overwrite).
    const entered = r.events.filter((e) => e.type === 'assistant-region-entered');
    assert.equal(entered.length, 2);
  });

  test('emits spinner events for status-glyph lines', () => {
    const p = tuiFrameParser.create();
    const r = p.feed('✻ Working… (2s · ↓5 tokens)\n');
    const spin = r.events.find((e) => e.type === 'spinner');
    assert.ok(spin);
    assert.match(spin.label, /Working/);
  });

  test('ignores lines outside a region', () => {
    const p = tuiFrameParser.create();
    const r = p.feed('some banner text\nmore text\n');
    assert.deepEqual(r.events.filter((e) => e.type === 'assistant-text'), []);
  });

  test('exposes assistant region marker through PATTERNS', () => {
    assert.equal(TUI_PATTERNS.assistantRegionMarker, '⏺');
  });
});

// ── Carriage-return resolution ─────────────────────────────────────────

describe('resolveCarriageReturns', () => {
  test('passes through lines with no \\r', () => {
    assert.equal(resolveCarriageReturns('hello world'), 'hello world');
    assert.equal(resolveCarriageReturns(''), '');
  });

  test('a longer overwrite fully replaces the shorter prefix', () => {
    assert.equal(resolveCarriageReturns('xxx\ryyyyy'), 'yyyyy');
  });

  test('a shorter overwrite leaves the visible tail of the prefix', () => {
    assert.equal(resolveCarriageReturns('xxxxx\ryy'), 'yyxxx');
  });

  test('multiple \\r segments resolve left-to-right', () => {
    // 1st: "abc" -> cursor 3
    // \r -> cursor 0; "de" -> "dec" cursor 2
    // \r -> cursor 0; "f" -> "fec" cursor 1
    assert.equal(resolveCarriageReturns('abc\rde\rf'), 'fec');
  });

  test('progressive status update overwrites previous status', () => {
    const before = 'Working… (2s · ↓3 tokens)';
    const after  = 'Working… (5s · ↓8 tokens)';
    // Both lines share the prefix; the longer overwrite + same-length here wins exactly.
    assert.equal(resolveCarriageReturns(before + '\r' + after), after);
  });
});

// ── Pipeline ──────────────────────────────────────────────────────────

describe('createPipeline', () => {
  test('feeds chunks through parsers in priority order', () => {
    const trace = [];
    const a = { name: 'a', priority: 10, create: () => ({ feed: (t) => { trace.push('a'); return { text: t.toUpperCase(), events: [{ type: 'a' }] }; }, reset: () => {} }) };
    const b = { name: 'b', priority: 20, create: () => ({ feed: (t) => { trace.push('b'); return { text: t, events: [{ type: 'b', got: t }] }; }, reset: () => {} }) };
    const pipe = createPipeline([b, a]); // intentionally out of order
    const r = pipe.feed('hello');
    assert.deepEqual(trace, ['a', 'b']);     // sorted by priority
    assert.equal(r.text, 'HELLO');
    const types = r.events.map((e) => e.type);
    assert.deepEqual(types, ['a', 'b']);
    assert.equal(r.events[1].got, 'HELLO');  // b saw output of a
    assert.equal(r.events[0]._source, 'a');  // pipeline tags _source
  });

  test('reset() resets every parser instance', () => {
    let resets = 0;
    const def = { name: 'x', priority: 100, create: () => ({ feed: (t) => ({ text: t, events: [] }), reset: () => { resets++; } }) };
    const pipe = createPipeline([def, def]);
    pipe.reset();
    assert.equal(resets, 2);
  });
});
