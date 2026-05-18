import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { writePromptToSession } from '../src/index.js';

/** Fake PTY session that records every byte sent to `.write()`. */
function fakeSession() {
  const writes = [];
  return {
    writes,
    write(s) { writes.push(s); },
    get joined() { return writes.join(''); },
  };
}

// Some tests rely on env defaults; isolate to avoid bleed across runs.
const ENV_KEYS = [
  'OCP_PASTE_MODE',
  'OCP_PASTE_THRESHOLD',
  'OCP_PASTE_CHUNK_CHARS',
  'OCP_PASTE_CHUNK_DELAY_MS',
  'OCP_SUBMIT_SETTLE_MS',
];
let saved = {};
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('writePromptToSession', () => {
  test('raw mode: atomic write then CR', async () => {
    const s = fakeSession();
    await writePromptToSession(s, 'hello', { pasteMode: 'raw', submitSettleMs: 0 });
    assert.deepEqual(s.writes, ['hello', '\r']);
  });

  test('auto mode + small prompt: atomic + CR (no chunking, no settle)', async () => {
    const s = fakeSession();
    // 200 chars < 1024 default threshold
    const prompt = 'x'.repeat(200);
    await writePromptToSession(s, prompt, { pasteMode: 'auto', submitSettleMs: 0 });
    assert.deepEqual(s.writes, [prompt, '\r']);
  });

  test('auto mode + large prompt: chunked with delays, final CR', async () => {
    const s = fakeSession();
    const prompt = 'x'.repeat(2048);
    await writePromptToSession(s, prompt, {
      pasteMode: 'auto',
      pasteThreshold: 1024,
      pasteChunkChars: 256,
      pasteChunkDelayMs: 0,
      submitSettleMs: 0,
    });
    // 2048 / 256 = 8 chunks, plus the trailing \r
    assert.equal(s.writes.length, 9);
    assert.equal(s.writes[8], '\r');
    assert.equal(s.joined.slice(0, -1), prompt); // concat minus the \r
  });

  test('chunk mode forces chunking regardless of size', async () => {
    const s = fakeSession();
    const prompt = 'short prompt';
    await writePromptToSession(s, prompt, {
      pasteMode: 'chunk',
      pasteChunkChars: 4,
      pasteChunkDelayMs: 0,
      submitSettleMs: 0,
    });
    // 12 chars / 4 = 3 chunks + CR
    assert.equal(s.writes.length, 4);
    assert.equal(s.writes[3], '\r');
    assert.equal(s.joined.slice(0, -1), prompt);
  });

  test('bracket mode wraps with xterm bracketed-paste markers', async () => {
    const s = fakeSession();
    await writePromptToSession(s, 'payload', {
      pasteMode: 'bracket',
      submitSettleMs: 0,
    });
    assert.equal(s.writes.length, 2);
    assert.equal(s.writes[0], '\x1b[200~payload\x1b[201~');
    assert.equal(s.writes[1], '\r');
  });

  test('does not split a UTF-16 surrogate pair across chunks', async () => {
    const s = fakeSession();
    // U+1F600 GRINNING FACE = 0xD83D 0xDE00 (high + low surrogate)
    const emoji = '😀';
    // Build a prompt where the surrogate pair lands exactly on the chunk
    // boundary if naively split. Three regular chars + emoji + three more.
    const prompt = 'aaa' + emoji + 'bbb'; // length 8 (3 + 2 + 3)
    await writePromptToSession(s, prompt, {
      pasteMode: 'chunk',
      pasteChunkChars: 4, // would naively cut after 'aaa\uD83D'
      pasteChunkDelayMs: 0,
      submitSettleMs: 0,
    });
    // Round-trip must be byte-identical.
    assert.equal(s.joined.slice(0, -1), prompt);
    // And no individual chunk should END on a high surrogate.
    for (const chunk of s.writes.slice(0, -1)) {
      const last = chunk.charCodeAt(chunk.length - 1);
      assert.ok(
        !(last >= 0xd800 && last <= 0xdbff),
        `chunk ends on high surrogate: ${chunk}`,
      );
    }
  });

  test('OCP_PASTE_MODE env wins when opts.pasteMode is undefined', async () => {
    process.env.OCP_PASTE_MODE = 'bracket';
    const s = fakeSession();
    await writePromptToSession(s, 'x', { submitSettleMs: 0 });
    assert.equal(s.writes[0], '\x1b[200~x\x1b[201~');
  });

  test('opts.pasteMode wins over env', async () => {
    process.env.OCP_PASTE_MODE = 'bracket';
    const s = fakeSession();
    await writePromptToSession(s, 'x', { pasteMode: 'raw', submitSettleMs: 0 });
    assert.deepEqual(s.writes, ['x', '\r']);
  });
});
