#!/usr/bin/env node
// Daemon server — manages a single claude PTY and keeps it alive between
// ocp invocations.
//
// Lifecycle states (as seen from outside):
//   ACTIVE   — currently processing a request
//   IDLE     — PTY running in background, waiting for next command (timer active)
//   INACTIVE — daemon exited, sessionId saved to state file for --resume
//
// Started by src/daemon/client.js. Do not run directly.
// argv: <socketPath> <key> <daemonOptsJSON>

import net from 'node:net';
import { unlink, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createDriver } from '../index.js';
import { writeState, clearState, resolveCwd } from './socket.js';
import { recordSession } from '../session-log.js';

const [,, socketPath, key, optsJson] = process.argv;
if (!socketPath || !key) { process.stderr.write('daemon: missing args\n'); process.exit(1); }

// A long-lived daemon must not die to an unhandled rejection — log and
// exit cleanly so the next client invocation spawns a fresh one rather
// than connecting to a half-dead socket.
process.on('unhandledRejection', (r) => {
  process.stderr.write(`[ocp-daemon] unhandled rejection: ${r?.stack || r?.message || r}\n`);
  process.exit(1);
});
process.on('uncaughtException', (e) => {
  process.stderr.write(`[ocp-daemon] uncaught exception: ${e?.stack || e?.message || e}\n`);
  process.exit(1);
});

// Refuse to honour the global argv-sanitizer opt-out inside the daemon.
// The daemon is long-lived and shared across invocations — letting it
// inherit OCP_ALLOW_UNSAFE_ARGV from whichever shell first started it
// creates a surprise-bypass for subsequent unrelated clients. Callers
// that genuinely need the opt-out must run with OCP_NO_DAEMON=1 to take
// the direct path.
delete process.env.OCP_ALLOW_UNSAFE_ARGV;

const opts = JSON.parse(optsJson ?? '{}');

function envPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Default 10-minute idle timeout. Each incoming request resets the timer.
// Guard against malformed env (NaN / negative / empty) collapsing the timer
// to zero and defeating the daemon's purpose.
const IDLE_MS = envPositiveInt('OCP_DAEMON_IDLE_MS', 600_000);

// Cap a single IPC request body. A same-user process flooding the socket
// could otherwise OOM the daemon by streaming bytes without ever ending
// the message.
const MAX_REQ_BYTES = envPositiveInt('OCP_DAEMON_MAX_REQ_BYTES', 4 * 1024 * 1024);
const SOCKET_IDLE_MS = envPositiveInt('OCP_DAEMON_SOCKET_TIMEOUT_MS', 30_000);
// Total lifetime cap on a single connection — guards against slow-loris
// where a peer trickles bytes just often enough to keep idle timeout
// from firing. Five minutes is far longer than any legitimate request.
const SOCKET_MAX_LIFETIME_MS = envPositiveInt('OCP_DAEMON_SOCKET_MAX_LIFETIME_MS', 300_000);

// Pool size = max number of warm PTYs the daemon can park concurrently.
// Set to MAX_PARALLEL so concurrent fresh requests (no resume/session-id)
// can all park their PTYs on release rather than being killed because the
// pool was full — the next round of fresh calls then gets warm reuse.
// The pool TTL is set longer than the daemon's idle timer so the pool
// never kills the PTY independently — the daemon's own timer controls
// shutdown.
const MAX_PARALLEL = envPositiveInt('OCP_DAEMON_MAX_PARALLEL', 8);
const driver = createDriver({
  claudeBin: opts.claudeBin,
  cwd: opts.cwd,
  debug: opts.debug,
  poolSize: MAX_PARALLEL,
  poolMaxAgeMs: IDLE_MS + 60_000,
  initialSessionId: opts.resumeSessionId ?? null,
});

let lastSessionId = opts.resumeSessionId ?? null;
let idleTimer;

function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    // IDLE → INACTIVE: save session for future --resume, then exit.
    await saveStateAndExit();
  }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

async function saveStateAndExit() {
  if (lastSessionId) {
    await writeState(key, { sessionId: lastSessionId, exitedAt: Date.now() }).catch(() => {});
  }
  await driver.close().catch(() => {});
  try { await unlink(socketPath); } catch {}
  process.exit(0);
}

process.on('SIGTERM', saveStateAndExit);
process.on('SIGINT',  saveStateAndExit);

resetIdle();

// Per-session-key serialisation. The original design used a single
// global `pending` chain, which forced concurrent fresh `ocp` calls in
// the same directory to wait for each other even though they had no
// session relationship. The user-visible symptom was "I opened two
// terminals and ran `ocp` in each, the second hangs until the first
// finishes". Replace with a per-key Map:
//
//   - `resume:<sessionId>` — `--resume <id>` requests serialise per id
//   - `session:<sessionId>` — `--session-id <id>` requests serialise per id
//   - `continue` — `--continue` requests serialise (single shared context)
//   - `fresh:<uuid>` — plain `ocp "..."` calls each get a unique key →
//     never collide → run in parallel up to MAX_PARALLEL
//
// MAX_PENDING is the cross-cutting ceiling so a runaway same-uid peer
// can't spawn unbounded in-flight runs.
const pendingByKey = new Map();
let pendingCount = 0;
const MAX_PENDING = envPositiveInt('OCP_DAEMON_MAX_PENDING', 16);

function keyForRequest(req) {
  if (req?.resume) return `resume:${req.resume}`;
  if (req?.sessionId) return `session:${req.sessionId}`;
  if (req?.continue) return 'continue';
  return `fresh:${randomUUID()}`;
}

const server = net.createServer((socket) => {
  resetIdle(); // IDLE → ACTIVE: reset timer on new connection
  let buf = '';
  let recv = 0;
  let killed = false;
  socket.setEncoding('utf8');
  socket.setTimeout(SOCKET_IDLE_MS, () => { killed = true; socket.destroy(); });
  const lifetimeKill = setTimeout(() => {
    killed = true;
    try { socket.destroy(); } catch {}
  }, SOCKET_MAX_LIFETIME_MS);
  if (lifetimeKill.unref) lifetimeKill.unref();
  socket.once('close', () => clearTimeout(lifetimeKill));
  socket.on('data', (c) => {
    if (killed) return;
    recv += c.length;
    if (recv > MAX_REQ_BYTES) { killed = true; socket.destroy(); return; }
    buf += c;
  });
  socket.on('end', async () => {
    if (killed) return;
    let req;
    try { req = JSON.parse(buf); } catch {
      // Do not echo the parse-error message back — it may contain a
      // byte-offset into attacker-controlled input. A generic code is
      // enough for legitimate clients to retry.
      socket.write(JSON.stringify({ error: 'bad json' }) + '\n');
      socket.end(); return;
    }
    // Per-request cwd must match the cwd this daemon was spawned for.
    // Otherwise a same-uid peer could reuse our socket to spawn claude
    // in a different directory and influence which `~/.claude/projects/`
    // files get written.
    //
    // Both sides are normalised via realpath so a symlink path and its
    // target compare equal. A missing req.cwd is rejected outright
    // (legitimate clients always set it) so an attacker cannot bypass
    // by simply omitting the field.
    const boundCwd = resolveCwd(opts.cwd);
    if (req.cwd === undefined) {
      socket.write(JSON.stringify({ error: 'cwd required' }) + '\n');
      socket.end(); return;
    }
    if (resolveCwd(req.cwd) !== boundCwd) {
      socket.write(JSON.stringify({ error: 'cwd mismatch' }) + '\n');
      socket.end(); return;
    }
    // Mirror the cwd check for claudeBin — a same-uid peer connecting
    // directly to our socket could otherwise issue requests intended
    // for a DIFFERENT claude binary and silently get this daemon's
    // bound one instead. The daemonKey already includes claudeBin so
    // legitimate clients land on different sockets; this catches the
    // direct-socket bypass.
    const boundBin = opts.claudeBin || 'claude';
    if (req.claudeBin !== undefined && req.claudeBin !== boundBin) {
      socket.write(JSON.stringify({ error: 'claudeBin mismatch' }) + '\n');
      socket.end(); return;
    }
    if (pendingCount >= MAX_PENDING) {
      socket.write(JSON.stringify({ error: 'busy' }) + '\n');
      socket.end(); return;
    }
    pendingCount += 1;

    const processRequest = async () => {
      try {
        resetIdle();

        const result = await driver.runOneShot(req);
        if (result.sessionId) lastSessionId = result.sessionId;

        // Active conversation running — no need for the INACTIVE state file.
        await clearState(key).catch(() => {});

        // Per-turn log under <cwd>/.ocp/<sessionId>/. Best-effort; any
        // failure is captured inside recordSession and never propagates.
        recordSession({
          cwd: req.cwd,
          sessionId: result.sessionId,
          prompt: req.prompt,
          response: result.text,
          meta: {
            isError: result.isError,
            completionReason: result.completionReason,
            durationMs: result.durationMs,
            cost: result.cost,
          },
          events: result.events,
        }).catch(() => {});

        socket.write(JSON.stringify({
          text: result.text,
          sessionId: result.sessionId,
          isError: result.isError,
          completionReason: result.completionReason,
          durationMs: result.durationMs,
          cost: result.cost,
          events: result.events,
          diagnostics: result.diagnostics,
        }) + '\n');
      } catch (e) {
        // Log full error locally; return only a generic code to the peer
        // so absolute paths / homedir / internal symbols don't leak via IPC.
        process.stderr.write(`[ocp-daemon] request failed: ${e.stack || e.message}\n`);
        socket.write(JSON.stringify({ error: 'request failed' }) + '\n');
      }
      socket.end();
      // ACTIVE → IDLE: idle timer was reset at start of this handler
    };

    const sessionKey = keyForRequest(req);
    const prev = pendingByKey.get(sessionKey) ?? Promise.resolve();
    const next = prev
      .then(processRequest)
      .catch((e) => process.stderr.write(`[ocp-daemon] queue handler crashed: ${e?.stack || e?.message}\n`))
      .finally(() => {
        // Only delete the slot if we're still the tail — a queued
        // sibling may have already chained off `next`.
        if (pendingByKey.get(sessionKey) === next) pendingByKey.delete(sessionKey);
        pendingCount -= 1;
      });
    pendingByKey.set(sessionKey, next);
  });
});

server.listen(socketPath, async () => {
  // Restrict the unix socket to the owning user — defense in depth on
  // multi-user hosts so other local accounts cannot inject argv via IPC.
  try { await chmod(socketPath, 0o600); } catch {}
  // Signal parent (client.js) that the socket is ready.
  process.stdout.write('ready\n');
});
