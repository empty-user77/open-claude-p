// End-to-end verification of the slash-command no-response fix.
//
// Spawns a fake claude TUI (`test/fixtures/fake-claude-tui.mjs`) under
// the real driver via `createDriver`. This is a node-pty integration —
// the driver writes prompts into a real PTY and the fake script emits
// TUI-shaped output back.
//
// The fix under test changes how `runOneShot` handles prompts whose
// first non-whitespace word is a claude TUI local builtin (`/compact`,
// `/clear`, …). Before the fix:
//
//   - the OCP_END marker instruction was appended to every prompt
//     (and silently dropped by the TUI's command parser for builtins)
//   - the completion detector required `hadAssistantText` before
//     allowing idle completion, but local builtins never open an
//     assistant region — so a `/compact` invocation blocked until the
//     24 h `maxResponseMs` hard timeout
//
// After the fix `/compact` should complete via the idle path within
// preIdleMs of the PTY going quiet. A normal prompt must STILL go
// through the sentinel path (proves the fix is scoped to builtins).
//
// Skipped on Windows / non-Unix where node-pty integration tests are
// unreliable without a TTY-capable host.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

import { createDriver } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(__dirname, 'fixtures', 'fake-claude-tui.mjs');

// Tight timings so the test finishes in seconds, not minutes. The
// driver normally waits 1500ms idle / 8s pre-idle / 24h hard timeout;
// shrinking those is the standard way other tests in this repo bound
// real-time waits.
const TIGHT_OPTS = {
  claudeBin: FAKE_CLAUDE,
  idleMs: 60,
  preIdleMs: 250,
  maxResponseMs: 8_000,
  firstResponseMs: 4_000,
  promptBoxWaitMs: 4_000,
  warmupMs: 0,
};

function freshCwd() {
  // Avoid clobbering the repo's `~/.claude/projects/<encoded-cwd>/`
  // entry — the driver derives the JSONL lookup path from cwd, and
  // running the test from the repo root would otherwise interleave
  // with the developer's own session files.
  return mkdtempSync(join(tmpdir(), 'ocp-slash-test-'));
}

describe('runOneShot — slash-command fast-completion (regression for /compact 24h hang)', () => {
  test('/compact completes via idle within preIdleMs after PTY quiet', async () => {
    const cwd = freshCwd();
    const driver = createDriver(TIGHT_OPTS);
    const t0 = Date.now();
    let result;
    try {
      result = await driver.runOneShot({
        prompt: '/compact',
        cwd,
        noSessionPersistence: true,
      });
    } finally {
      await driver.close();
    }
    const elapsed = Date.now() - t0;

    // The fake emits ~3 spinner ticks at 80ms = ~240ms of activity,
    // then quiet. preIdleMs is 250ms, so completion should land
    // around ~490–700ms (plus PTY spawn overhead). The crucial bound
    // is that it must NOT hit `maxResponseMs` (timeout) — that was
    // the original 24-hour-hang symptom.
    assert.equal(
      result.completionReason,
      'idle',
      `expected completion via idle, got ${result.completionReason}`,
    );
    assert.equal(result.isError, false);
    assert.ok(
      elapsed < TIGHT_OPTS.maxResponseMs,
      `expected completion before maxResponseMs=${TIGHT_OPTS.maxResponseMs}, got ${elapsed}ms`,
    );
  });

  test('non-builtin prompt still completes via sentinel (skill / regular path unaffected)', async () => {
    const cwd = freshCwd();
    const driver = createDriver(TIGHT_OPTS);
    let result;
    try {
      result = await driver.runOneShot({
        prompt: 'hello',
        cwd,
        noSessionPersistence: true,
      });
    } finally {
      await driver.close();
    }

    assert.equal(
      result.completionReason,
      'sentinel',
      `expected sentinel completion, got ${result.completionReason}`,
    );
    assert.equal(result.isError, false);
    assert.match(
      result.text,
      /hello from fake-claude/,
      'sentinel-extracted text should carry the fake assistant reply',
    );
    // The 1.1.2 degraded-capture notice must NOT be present on the
    // clean sentinel path — otherwise every skill response would
    // come back with a false-positive warning header.
    assert.doesNotMatch(
      result.text,
      /Streaming capture not detected/,
      'sentinel path must not prepend the degraded-capture notice',
    );
  });

  test('skill-shaped slash (`/init`) is treated as LLM-bearing, not a local builtin', async () => {
    // `/init` is a skill in claude TUI (loads a SKILL.md, runs the
    // LLM). It must NOT match the local-builtin whitelist — if it
    // did, the driver would skip OCP_END (no sentinel possible) and
    // relax the idle gate (premature completion). The fake claude
    // treats anything that isn't `/compact` as a normal LLM turn, so
    // an `/init` prompt should still drive a sentinel completion.
    const cwd = freshCwd();
    const driver = createDriver(TIGHT_OPTS);
    let result;
    try {
      result = await driver.runOneShot({
        prompt: '/init',
        cwd,
        noSessionPersistence: true,
      });
    } finally {
      await driver.close();
    }

    assert.equal(
      result.completionReason,
      'sentinel',
      `slash-skill should complete via sentinel, got ${result.completionReason}`,
    );
    assert.equal(result.isError, false);
  });
});
