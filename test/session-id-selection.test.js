// Regression: picking a concurrent session's JSONL as "our" session id.
//
// `findRecentSessionId` is the filesystem fallback used when no session-id
// banner was scraped from the PTY. It must not select a neighbour session
// that merely happened to be appended to while our request was in flight —
// the id it returns is handed to `readSessionText`, whose strict path then
// returns that neighbour's transcript as this request's answer.
//
// The realistic trigger is a background daemon holding a warm PTY in the
// same cwd: its JSONL keeps growing, so ranking every candidate together
// by mtime let it out-race the file our own spawn had just created.

import { test, describe, before as beforeAll, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { findRecentSessionId } from '../src/index.js';
import { readSessionText } from '../src/chat/index.js';

const CWD = path.join(os.tmpdir(), 'ocp-session-selection-test');
const PROJECT_DIR = path.join(
  os.homedir(), '.claude', 'projects',
  // Upstream encodes both `/` and `_` as `-`, after resolving symlinks.
  '',
);

const OURS = '22222222-2222-2222-2222-222222222222';
const THEIRS = '11111111-1111-1111-1111-111111111111';

let dir;

async function realProjectDir(cwd) {
  const { realpath } = await import('node:fs/promises');
  let resolved;
  try { resolved = await realpath(path.resolve(cwd)); }
  catch { resolved = path.resolve(cwd); }
  return path.join(
    os.homedir(), '.claude', 'projects', resolved.replace(/[/_]/g, '-'),
  );
}

/** Write a session file and pin its mtime. */
async function place(name, mtimeMs) {
  const f = path.join(dir, `${name}.jsonl`);
  await writeFile(f, '{}\n');
  await utimes(f, new Date(mtimeMs), new Date(mtimeMs));
}

beforeAll(async () => {
  await mkdir(CWD, { recursive: true });
  dir = await realProjectDir(CWD);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(CWD, { recursive: true, force: true });
});

describe('findRecentSessionId', () => {
  test('a newly-created file wins over a neighbour touched later', async () => {
    const t0 = Date.now();
    // Their session existed before we started, and a live daemon appends
    // to it AFTER our own session file was last written.
    await place(THEIRS, t0 - 60_000);
    const before = new Map([[`${THEIRS}.jsonl`, t0 - 60_000]]);
    await place(OURS, t0 + 500);       // our fresh spawn
    await place(THEIRS, t0 + 5_000);   // daemon appends, now the newest file

    const picked = await findRecentSessionId(CWD, t0, before);
    assert.equal(picked, OURS,
      'selected a concurrent session instead of the one this request created');
  });

  test('an appended pre-existing file is still used when nothing is new', async () => {
    // The legitimate `--resume` case: no new file appears, the existing
    // session is appended to. That must keep working.
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const t0 = Date.now();
    await place(THEIRS, t0 - 60_000);
    const before = new Map([[`${THEIRS}.jsonl`, t0 - 60_000]]);
    await place(THEIRS, t0 + 1_000);

    assert.equal(await findRecentSessionId(CWD, t0, before), THEIRS);
  });

  test('a pre-existing file that did not move is ignored', async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const t0 = Date.now();
    await place(THEIRS, t0 + 2_000);
    // Baseline says it already had this mtime — nothing moved.
    const before = new Map([[`${THEIRS}.jsonl`, t0 + 2_000]]);

    assert.equal(await findRecentSessionId(CWD, t0, before), null);
  });

  test('files older than the request window are ignored', async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const t0 = Date.now();
    await place(THEIRS, t0 - 120_000);

    assert.equal(await findRecentSessionId(CWD, t0, new Map()), null);
  });

  test('the newest of several new files wins', async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const t0 = Date.now();
    await place(THEIRS, t0 + 1_000);
    await place(OURS, t0 + 9_000);

    assert.equal(await findRecentSessionId(CWD, t0, new Map()), OURS);
  });
});

describe('readSessionText — transcript ownership', () => {
  const OUR_PROMPT = 'Summarize the release notes for version 1.2.0';

  /** Write a transcript with one user turn and one assistant turn. */
  async function transcript(name, userText, assistantText, t0, mtimeMs) {
    const ln = (role, text, ts) => JSON.stringify({
      type: role,
      timestamp: new Date(ts).toISOString(),
      message: { role, content: [{ type: 'text', text }] },
    }) + '\n';
    const f = path.join(dir, `${name}.jsonl`);
    await writeFile(f, ln('user', userText, t0 + 100) + ln('assistant', assistantText, t0 + 200));
    await utimes(f, new Date(mtimeMs), new Date(mtimeMs));
  }

  test('a neighbour transcript is not returned as our answer', async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const t0 = Date.now();
    // Someone else's session, appended to after we started, so it is the
    // newest file in the directory and wins on mtime alone.
    await transcript(THEIRS, 'their unrelated question', 'THEIR-PRIVATE-ANSWER', t0, t0 + 9_000);

    const r = await readSessionText(null, t0, CWD, { expectPrompt: OUR_PROMPT });
    assert.equal(r, null, 'returned another session’s transcript');
  });

  test('our own transcript is found even when a neighbour is newer', async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const t0 = Date.now();
    await transcript(THEIRS, 'their unrelated question', 'THEIR-PRIVATE-ANSWER', t0, t0 + 9_000);
    // Ours is OLDER than theirs — ownership must beat recency.
    await transcript(
      OURS, `${OUR_PROMPT}\n\nWhen done, print the marker.`, 'OUR-REAL-ANSWER', t0, t0 + 1_000,
    );

    const r = await readSessionText(null, t0, CWD, { expectPrompt: OUR_PROMPT });
    assert.equal(r?.text, 'OUR-REAL-ANSWER');
  });

  test('a very short prompt is not treated as evidence either way', async () => {
    // Too little signal to identify a transcript; keep prior behaviour
    // rather than silently refusing to read anything.
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const t0 = Date.now();
    await transcript(OURS, 'hi', 'SHORT-ANSWER', t0, t0 + 1_000);

    const r = await readSessionText(null, t0, CWD, { expectPrompt: 'hi' });
    assert.equal(r?.text, 'SHORT-ANSWER');
  });

  test('omitting expectPrompt preserves the previous behaviour', async () => {
    // `readSessionText` is exported from `open-claude-p/chat`; a caller
    // that does not pass the new option must not see a behaviour change.
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const t0 = Date.now();
    await transcript(THEIRS, 'their question', 'THEIR-PRIVATE-ANSWER', t0, t0 + 9_000);

    const r = await readSessionText(null, t0, CWD);
    assert.equal(r?.text, 'THEIR-PRIVATE-ANSWER');
  });
});
