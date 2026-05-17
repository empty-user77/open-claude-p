#!/usr/bin/env node
//
// Phase 1a probe — validate the two core assumptions of the shim:
//
//   1. We can spawn the upstream `claude` CLI in interactive mode under
//      node-pty, send a prompt, and capture its TTY output.
//   2. A sentinel-injection instruction (telling the model to emit a unique
//      marker line at the end of its answer) survives to stdout reliably so
//      we can later use it for completion detection.
//
// Usage:
//   node scripts/capture-raw.js [prompt]
//
// Outputs (per run, in ./captures/<iso-timestamp>/):
//   meta.json       Run metadata: prompt, sentinel, timings, exit info.
//   raw.bin         Raw PTY bytes exactly as the upstream CLI wrote them.
//   stripped.txt    ANSI-stripped text (for human eyeball debugging).
//   pty.log         Operational log: what we sent and when.
//
// Environment overrides:
//   OCP_CLAUDE_BIN   Path to the upstream `claude` binary (default: 'claude').
//   OCP_TIMEOUT_MS   Hard kill after this much wall time   (default: 60000).
//   OCP_WARMUP_MS    Delay before sending the prompt       (default: 2500).
//   OCP_IDLE_MS      Idle silence after sentinel before kill (default: 1500).
//   OCP_EXTRA_ARGS   Space-separated extra argv for claude  (default: empty).
//   OCP_PROBE_CWD    Working directory for the spawned claude (default: this project root).
//
// Exit codes:
//   0  Sentinel detected. Both assumptions hold.
//   1  Sentinel NOT detected (assumption #2 needs rework or longer timeout).
//   2  Spawn failed or unrecoverable error (assumption #1 broken).

import { spawn as ptySpawn } from 'node-pty';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------- Configuration ----------

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
const CAPTURE_DIR = path.join(PROJECT_ROOT, 'captures', RUN_ID);

// ---------- Minimal ANSI stripper (diagnostic only) ----------
// A production-grade implementation lives in src/parsers/ansi-strip.js (TBD).
// This one only needs to be good enough to make stripped.txt human-readable.
function stripAnsi(s) {
  return s
    // OSC ... BEL
    .replace(/\][^]*/g, '')
    // OSC ... ST (ESC \)
    .replace(/\][^]*\\/g, '')
    // CSI: ESC [ ... letter
    .replace(/\[[0-?]*[ -/]*[@-~]/g, '')
    // Single-character 7-bit C1 codes: ESC <letter>
    .replace(/[@-Z\\-_]/g, '');
}

// ---------- Main ----------
async function main() {
  await mkdir(CAPTURE_DIR, { recursive: true });
  const rawPath = path.join(CAPTURE_DIR, 'raw.bin');
  const strippedPath = path.join(CAPTURE_DIR, 'stripped.txt');
  const logPath = path.join(CAPTURE_DIR, 'pty.log');
  const metaPath = path.join(CAPTURE_DIR, 'meta.json');

  const startTime = Date.now();
  const logLines = [];
  function log(msg) {
    const line = `[${(Date.now() - startTime).toString().padStart(6)}ms] ${msg}`;
    logLines.push(line);
    process.stderr.write(line + '\n');
  }

  let rawBuffer = '';
  let strippedBuffer = '';
  let sentinelMatchedAt = null;
  let promptSentAt = null;
  let exitInfo = { code: null, signal: null };
  let timedOut = false;

  log(`Probe run id: ${RUN_ID}`);
  log(`Capture dir : ${CAPTURE_DIR}`);
  log(`Claude bin  : ${CLAUDE_BIN}`);
  log(`Extra args  : ${EXTRA_ARGS.join(' ') || '(none)'}`);
  log(`Probe cwd   : ${PROBE_CWD}`);
  log(`Sentinel    : ${SENTINEL}`);
  log(`Prompt      : ${JSON.stringify(PROMPT)}`);

  let ptyProc;
  try {
    ptyProc = ptySpawn(CLAUDE_BIN, EXTRA_ARGS, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: PROBE_CWD,
      env: process.env,
    });
  } catch (e) {
    log(`SPAWN FAILED: ${e.message}`);
    await writeMeta({ spawnError: e.message });
    process.exit(2);
  }

  let idleTimer = null;
  function armIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    if (sentinelMatchedAt === null) return;
    idleTimer = setTimeout(() => {
      log(`Idle ${IDLE_MS}ms after sentinel — terminating`);
      try { ptyProc.kill(); } catch {}
    }, IDLE_MS);
  }

  const globalTimeout = setTimeout(() => {
    timedOut = true;
    log(`Global timeout ${TIMEOUT_MS}ms — terminating`);
    try { ptyProc.kill(); } catch {}
  }, TIMEOUT_MS);

  ptyProc.onData((chunk) => {
    rawBuffer += chunk;
    strippedBuffer += stripAnsi(chunk);
    if (sentinelMatchedAt === null && strippedBuffer.includes(SENTINEL)) {
      sentinelMatchedAt = Date.now() - startTime;
      log(`SENTINEL MATCHED at ${sentinelMatchedAt}ms`);
      armIdle();
    } else if (sentinelMatchedAt !== null) {
      armIdle();
    }
  });

  // We don't have a prompt-box detector yet, so we just give the upstream CLI
  // a few seconds to draw its TUI before typing. If the warm-up turns out to
  // be unreliable, we will revisit during Phase 1b.
  setTimeout(() => {
    const full = PROMPT + SENTINEL_INSTRUCTION;
    promptSentAt = Date.now() - startTime;
    log(`Sending prompt at ${promptSentAt}ms (${full.length} chars)`);
    try {
      ptyProc.write(full);
      // The interactive CLI typically requires Enter to submit. We send a
      // carriage return; if that proves wrong for multi-line input the raw
      // capture will make it obvious.
      ptyProc.write('\r');
    } catch (e) {
      log(`WRITE FAILED: ${e.message}`);
      try { ptyProc.kill(); } catch {}
    }
  }, WARMUP_MS);

  await new Promise((resolve) => {
    ptyProc.onExit(({ exitCode, signal }) => {
      clearTimeout(globalTimeout);
      if (idleTimer) clearTimeout(idleTimer);
      exitInfo = { code: exitCode ?? null, signal: signal ?? null };
      log(`Exit (code=${exitInfo.code}, signal=${exitInfo.signal})`);
      resolve();
    });
  });

  await writeFile(rawPath, rawBuffer);
  await writeFile(strippedPath, strippedBuffer);
  await appendFile(logPath, logLines.join('\n') + '\n');

  const meta = await writeMeta({
    prompt: PROMPT,
    sentinel: SENTINEL,
    nonce: NONCE,
    warmupMs: WARMUP_MS,
    idleMs: IDLE_MS,
    timeoutMs: TIMEOUT_MS,
    claudeBin: CLAUDE_BIN,
    extraArgs: EXTRA_ARGS,
    probeCwd: PROBE_CWD,
    promptSentAt,
    sentinelMatchedAt,
    sentinelFound: sentinelMatchedAt !== null,
    timedOut,
    durationMs: Date.now() - startTime,
    rawBytes: Buffer.byteLength(rawBuffer),
    strippedBytes: Buffer.byteLength(strippedBuffer),
    exit: exitInfo,
    captureDir: CAPTURE_DIR,
  });

  process.stdout.write(JSON.stringify(meta, null, 2) + '\n');
  if (meta.sentinelFound) {
    log('OK — sentinel detected, both assumptions hold for this run.');
    process.exit(0);
  } else {
    log('FAIL — sentinel not detected. Inspect stripped.txt / raw.bin.');
    process.exit(1);
  }

  // ---------- helpers ----------
  async function writeMeta(extra) {
    const meta = { runId: RUN_ID, ...extra };
    await writeFile(metaPath, JSON.stringify(meta, null, 2));
    return meta;
  }
}

main().catch(async (e) => {
  process.stderr.write(`capture-raw failed: ${e.stack || e.message}\n`);
  try {
    await mkdir(CAPTURE_DIR, { recursive: true });
    await writeFile(
      path.join(CAPTURE_DIR, 'fatal.json'),
      JSON.stringify({ error: e.message, stack: e.stack }, null, 2),
    );
  } catch {}
  process.exit(2);
});
