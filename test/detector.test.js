// Unit tests for CompletionDetector.
//
// The detector is the policy layer that turns raw parser events into a
// completion decision. These tests use a fake clock-free model: we feed
// events synchronously and inspect state. For the time-based paths
// (idle, timeout) we use very short thresholds so real timers fire fast.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CompletionDetector } from '../src/completion/detector.js';

const NONCE = 'deadbeef00000000';

/** Tiny sleep helper. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('CompletionDetector — sentinel path', () => {
  test('region-gated: completes after idleMs of silence following the first post-region sentinel', async () => {
    const d = new CompletionDetector({ nonce: NONCE, idleMs: 80, preIdleMs: 10_000, maxResponseMs: 10_000 });
    d.onEvent({ type: 'assistant-region-entered', n: 1 });
    d.onEvent({ type: 'sentinel', nonce: NONCE });
    const start = Date.now();
    const r = await d.done();
    const elapsed = Date.now() - start;
    assert.equal(r.reason, 'sentinel');
    assert.equal(r.isError, false);
    assert.ok(elapsed >= 80, `expected >=80ms, got ${elapsed}`);
  });

  test('ignores pre-region sentinels (echo defense)', async () => {
    const d = new CompletionDetector({ nonce: NONCE, idleMs: 80, preIdleMs: 250, maxResponseMs: 10_000 });
    // Echo sentinel arrives BEFORE region — must not satisfy the sentinel gate.
    d.onEvent({ type: 'sentinel', nonce: NONCE });
    d.onEvent({ type: 'sentinel', nonce: NONCE });
    // Time passes with no region entry — pre-idle fallback applies, but
    // since hadAssistantText is false, no fallback fires. Region-entered
    // is then declared.
    d.onEvent({ type: 'assistant-region-entered', n: 1 });
    // ...and a real sentinel arrives:
    d.onEvent({ type: 'sentinel', nonce: NONCE });
    const r = await d.done();
    assert.equal(r.reason, 'sentinel');
  });

  test('rejects sentinels with the wrong nonce', async () => {
    const d = new CompletionDetector({ nonce: NONCE, idleMs: 80, preIdleMs: 10_000, maxResponseMs: 250 });
    d.onEvent({ type: 'assistant-region-entered', n: 1 });
    d.onEvent({ type: 'sentinel', nonce: 'other' });
    const r = await d.done();
    // Times out at 250 ms since no matching sentinel ever arrives.
    assert.equal(r.reason, 'timeout');
    assert.equal(r.isError, true);
  });
});

describe('CompletionDetector — fallback paths', () => {
  test('idle fallback fires after preIdleMs once assistant text has been seen', async () => {
    const d = new CompletionDetector({ nonce: NONCE, idleMs: 50, preIdleMs: 80, maxResponseMs: 10_000 });
    d.onEvent({ type: 'assistant-region-entered', n: 1 });
    const start = Date.now();
    const r = await d.done();
    const elapsed = Date.now() - start;
    assert.equal(r.reason, 'idle');
    assert.equal(r.isError, false);
    assert.ok(elapsed >= 80);
  });

  test('hard timeout always fires', async () => {
    const d = new CompletionDetector({ nonce: NONCE, idleMs: 60_000, preIdleMs: 60_000, maxResponseMs: 100 });
    // No assistant text — neither sentinel nor idle paths can fire.
    const r = await d.done();
    assert.equal(r.reason, 'timeout');
    assert.equal(r.isError, true);
  });

  test('markActivity() resets the idle clock', async () => {
    const d = new CompletionDetector({ nonce: NONCE, idleMs: 50, preIdleMs: 200, maxResponseMs: 10_000 });
    d.onEvent({ type: 'assistant-region-entered', n: 1 });
    // Repeatedly poke activity so pre-idle never fires until we stop poking.
    let polls = 0;
    const ticker = setInterval(() => { d.markActivity(); if (++polls > 6) clearInterval(ticker); }, 50);
    const start = Date.now();
    const r = await d.done();
    clearInterval(ticker);
    const elapsed = Date.now() - start;
    // Without markActivity this would complete at ~200ms; with the pokes,
    // it should complete after roughly 6*50 + preIdleMs = ~500ms.
    assert.equal(r.reason, 'idle');
    assert.ok(elapsed >= 350, `expected >=350ms, got ${elapsed}`);
  });
});

describe('CompletionDetector — max-turns', () => {
  test('aborts when assistant-region count exceeds maxTurns', async () => {
    const d = new CompletionDetector({ nonce: NONCE, idleMs: 10_000, preIdleMs: 10_000, maxResponseMs: 10_000, maxTurns: 1 });
    d.onEvent({ type: 'assistant-region-entered', n: 1 }); // turnsEntered = 1, not over
    d.onEvent({ type: 'assistant-region-entered', n: 2 }); // turnsEntered = 2, exceeds 1
    const r = await d.done();
    assert.equal(r.reason, 'max-turns');
    assert.equal(r.isError, true);
  });

  test('maxTurns=0 aborts on the first region', async () => {
    const d = new CompletionDetector({ nonce: NONCE, idleMs: 10_000, preIdleMs: 10_000, maxResponseMs: 10_000, maxTurns: 0 });
    d.onEvent({ type: 'assistant-region-entered', n: 1 });
    const r = await d.done();
    assert.equal(r.reason, 'max-turns');
  });

  test('maxTurns=null disables the check', async () => {
    const d = new CompletionDetector({ nonce: NONCE, idleMs: 80, preIdleMs: 200, maxResponseMs: 10_000, maxTurns: null });
    d.onEvent({ type: 'assistant-region-entered', n: 1 });
    d.onEvent({ type: 'assistant-region-entered', n: 2 });
    d.onEvent({ type: 'assistant-region-entered', n: 3 });
    d.onEvent({ type: 'sentinel', nonce: NONCE });
    const r = await d.done();
    assert.equal(r.reason, 'sentinel');
  });
});

describe('CompletionDetector — cancel', () => {
  test('cancel() with default reason produces cancelled error', async () => {
    const d = new CompletionDetector({ nonce: NONCE, idleMs: 60_000, preIdleMs: 60_000, maxResponseMs: 60_000 });
    setTimeout(() => d.cancel(), 20);
    const r = await d.done();
    assert.equal(r.reason, 'cancelled');
    assert.equal(r.isError, true);
  });

  test('cancel() accepts a custom reason (e.g. upstream-exited)', async () => {
    const d = new CompletionDetector({ nonce: NONCE, idleMs: 60_000, preIdleMs: 60_000, maxResponseMs: 60_000 });
    setTimeout(() => d.cancel('upstream-exited'), 20);
    const r = await d.done();
    assert.equal(r.reason, 'upstream-exited');
    assert.equal(r.isError, true);
  });

  test('cancel is idempotent — subsequent events are ignored', async () => {
    const d = new CompletionDetector({ nonce: NONCE, idleMs: 60_000, preIdleMs: 60_000, maxResponseMs: 60_000 });
    d.cancel();
    d.onEvent({ type: 'assistant-region-entered', n: 1 });
    d.onEvent({ type: 'sentinel', nonce: NONCE });
    const r = await d.done();
    assert.equal(r.reason, 'cancelled');
  });
});

describe('CompletionDetector — guard rails', () => {
  test('throws when constructed without a nonce', () => {
    assert.throws(() => new CompletionDetector(), /nonce is required/);
    assert.throws(() => new CompletionDetector({}), /nonce is required/);
  });

  test('done() resolves only once across multiple completion triggers', async () => {
    const d = new CompletionDetector({ nonce: NONCE, idleMs: 20, preIdleMs: 30, maxResponseMs: 10_000, maxTurns: 0 });
    d.onEvent({ type: 'assistant-region-entered', n: 1 });
    // Three competing completion conditions; the FIRST wins.
    d.cancel();
    await sleep(80); // would normally fire idle by now
    const r = await d.done();
    // Either max-turns (n=1 > 0) or cancelled may win, depending on order.
    assert.ok(r.reason === 'max-turns' || r.reason === 'cancelled');
    assert.equal(r.isError, true);
  });
});
