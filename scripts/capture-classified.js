#!/usr/bin/env node
//
// Phase 1b probe — validate echo-aware sentinel detection.
//
// Builds on the Phase 1a probe by wiring the real `PtySession` class and the
// real parser pipeline (ansi-strip + tui-frame + sentinel). The goal is to
// prove that:
//
//   1. The pipeline emits an `assistant-region-entered` event before the
//      model's actual sentinel-bearing response line.
//   2. The completion detector — to be written in 1c — can therefore gate
//      sentinel matches by requiring the region event to have fired first,
//      thereby ignoring the prompt-echo sentinel observed in Phase 1a.
//
// Outputs per run (./captures/1b-<iso>/):
//   raw.bin            Raw PTY bytes.
//   stripped.txt       Text after ANSI stripping (concatenated chunks).
//   events.ndjson      Parser-emitted events with timestamps.
//   meta.json          Validation result + summary.

import { PtySession } from '../src/pty/session.js';
import { ansiStripParser } from '../src/parsers/ansi-strip.js';
import { tuiFrameParser } from '../src/parsers/tui-frame.js';
import { createSentinelParser } from '../src/parsers/sentinel.js';
import { createPipeline } from '../src/parsers/pipeline.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PROMPT = process.argv[2] ?? 'Just answer with the single word: hello';
const NONCE = randomBytes(8).toString('hex');
const SENTINEL = `⟦OCP_END:${NONCE}⟧`;
const SENTINEL_INSTRUCTION =
  '\n\nWhen your full answer is complete, output exactly the following marker line ' +
  'on its own, with no other text on that line and nothing after it:\n' +
  SENTINEL;

const TIMEOUT_MS = Number(process.env.OCP_TIMEOUT_MS ?? 60000);
const WARMUP_MS = Number(process.env.OCP_WARMUP_MS ?? 2500);
const IDLE_MS = Number(process.env.OCP_IDLE_MS ?? 1500);
const CLAUDE_BIN = process.env.OCP_CLAUDE_BIN ?? 'claude';
// Empty by default — opt in explicitly via OCP_EXTRA_ARGS when needed.
// Previously defaulted to --dangerously-skip-permissions which is a
// permission bypass; we no longer ship that as an implicit default.
const EXTRA_ARGS = (process.env.OCP_EXTRA_ARGS ?? '')
  .split(/\s+/)
  .filter(Boolean);
const PROBE_CWD = process.env.OCP_PROBE_CWD ?? PROJECT_ROOT;

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const CAPTURE_DIR = path.join(PROJECT_ROOT, 'captures', `1b-${RUN_ID}`);

function logStderr(msg, startTime) {
  const t = (Date.now() - startTime).toString().padStart(6);
  process.stderr.write(`[${t}ms] ${msg}\n`);
}

async function main() {
  await mkdir(CAPTURE_DIR, { recursive: true });
  const startTime = Date.now();
  const log = (m) => logStderr(m, startTime);

  log(`Run id     : ${RUN_ID}`);
  log(`Capture dir: ${CAPTURE_DIR}`);
  log(`Claude bin : ${CLAUDE_BIN}`);
  log(`Extra args : ${EXTRA_ARGS.join(' ') || '(none)'}`);
  log(`Probe cwd  : ${PROBE_CWD}`);
  log(`Sentinel   : ${SENTINEL}`);
  log(`Prompt     : ${JSON.stringify(PROMPT)}`);

  let rawBuffer = '';
  let strippedBuffer = '';
  /** @type {Array<{ type: string, t: number, [k: string]: unknown }>} */
  const events = [];

  let promptSentAt = null;
  let regionEnteredAt = null;
  /** All sentinel timestamps in order of emission. */
  const sentinelTimestamps = [];
  let exitInfo = null;

  const sentinelParser = createSentinelParser(NONCE);
  const pipeline = createPipeline([ansiStripParser, tuiFrameParser, sentinelParser]);

  const session = new PtySession();
  try {
    await session.spawn({
      bin: CLAUDE_BIN,
      args: EXTRA_ARGS,
      cwd: PROBE_CWD,
      env: process.env,
    });
  } catch (e) {
    log(`SPAWN FAILED: ${e.message}`);
    await writeFile(
      path.join(CAPTURE_DIR, 'meta.json'),
      JSON.stringify({ runId: RUN_ID, error: e.message }, null, 2),
    );
    process.exit(2);
  }

  session.on('data', (chunk) => {
    rawBuffer += chunk;
    const { text, events: emitted } = pipeline.feed(chunk);
    strippedBuffer += text;
    for (const ev of emitted) {
      const tagged = { ...ev, t: Date.now() - startTime };
      events.push(tagged);
      if (ev.type === 'assistant-region-entered' && regionEnteredAt === null) {
        regionEnteredAt = tagged.t;
        log(`assistant-region-entered at ${tagged.t}ms`);
      }
      if (ev.type === 'sentinel') {
        sentinelTimestamps.push(tagged.t);
        log(`sentinel match #${sentinelTimestamps.length} at ${tagged.t}ms (region ${regionEnteredAt === null ? 'NOT yet' : 'already'} entered)`);
      }
    }
  });

  // Schedule the prompt.
  setTimeout(() => {
    promptSentAt = Date.now() - startTime;
    log(`Sending prompt at ${promptSentAt}ms`);
    try {
      session.write(PROMPT + SENTINEL_INSTRUCTION);
      session.write('\r');
    } catch (e) {
      log(`WRITE FAILED: ${e.message}`);
      session.kill();
    }
  }, WARMUP_MS);

  // Idle-after-real-sentinel kill: arm only after the first sentinel that
  // arrived AFTER region-entered. That's the candidate "real" match.
  let idleTimer = null;
  const tickId = setInterval(() => {
    const realIdx = sentinelTimestamps.findIndex(
      (t) => regionEnteredAt !== null && t >= regionEnteredAt,
    );
    if (realIdx === -1) return;
    if (idleTimer) return;
    idleTimer = setTimeout(() => {
      log(`Idle ${IDLE_MS}ms after real sentinel — terminating`);
      session.kill();
    }, IDLE_MS);
  }, 100);
  tickId.unref?.();

  const globalTimeout = setTimeout(() => {
    log(`Global timeout ${TIMEOUT_MS}ms — terminating`);
    session.kill();
  }, TIMEOUT_MS);
  globalTimeout.unref?.();

  await new Promise((resolve) => session.once('exit', (info) => {
    exitInfo = info;
    log(`Exit (code=${info?.exitCode ?? null}, signal=${info?.signal ?? null})`);
    resolve();
  }));

  clearInterval(tickId);
  if (idleTimer) clearTimeout(idleTimer);

  // Classify sentinel matches: any match before regionEnteredAt is an echo;
  // anything at or after regionEnteredAt is a candidate real response.
  const echoSentinels = regionEnteredAt === null
    ? [...sentinelTimestamps]
    : sentinelTimestamps.filter((t) => t < regionEnteredAt);
  const realSentinels = regionEnteredAt === null
    ? []
    : sentinelTimestamps.filter((t) => t >= regionEnteredAt);

  const success =
    regionEnteredAt !== null &&
    realSentinels.length > 0;

  const validation = {
    success,
    promptSentAt,
    regionEnteredAt,
    sentinelCount: sentinelTimestamps.length,
    echoCount: echoSentinels.length,
    realCount: realSentinels.length,
    firstSentinelAt: sentinelTimestamps[0] ?? null,
    firstRealSentinelAt: realSentinels[0] ?? null,
    lastSentinelAt: sentinelTimestamps[sentinelTimestamps.length - 1] ?? null,
    durationMs: Date.now() - startTime,
  };

  await writeFile(path.join(CAPTURE_DIR, 'raw.bin'), rawBuffer);
  await writeFile(path.join(CAPTURE_DIR, 'stripped.txt'), strippedBuffer);
  await writeFile(
    path.join(CAPTURE_DIR, 'events.ndjson'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );

  const meta = {
    runId: RUN_ID,
    prompt: PROMPT,
    sentinel: SENTINEL,
    nonce: NONCE,
    warmupMs: WARMUP_MS,
    idleMs: IDLE_MS,
    timeoutMs: TIMEOUT_MS,
    claudeBin: CLAUDE_BIN,
    extraArgs: EXTRA_ARGS,
    probeCwd: PROBE_CWD,
    rawBytes: Buffer.byteLength(rawBuffer),
    strippedBytes: Buffer.byteLength(strippedBuffer),
    exit: exitInfo ?? null,
    validation,
    captureDir: CAPTURE_DIR,
  };
  await writeFile(path.join(CAPTURE_DIR, 'meta.json'), JSON.stringify(meta, null, 2));

  process.stdout.write(JSON.stringify(validation, null, 2) + '\n');
  if (success) {
    log('OK — region-gated detection works; real sentinel is identifiable.');
    process.exit(0);
  } else {
    log('FAIL — see events.ndjson and stripped.txt');
    process.exit(1);
  }
}

main().catch(async (e) => {
  process.stderr.write(`capture-classified failed: ${e.stack || e.message}\n`);
  try {
    await mkdir(CAPTURE_DIR, { recursive: true });
    await writeFile(
      path.join(CAPTURE_DIR, 'fatal.json'),
      JSON.stringify({ error: e.message, stack: e.stack }, null, 2),
    );
  } catch {}
  process.exit(2);
});
