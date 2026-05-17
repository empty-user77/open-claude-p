// High-level chat client.
//
// Wraps the low-level `createDriver()` from open-claude-p with the
// "ready-to-use chat application" conveniences that the bundled sample
// server uses verbatim:
//
//   - conversation persistence (file-backed JSON store, or in-memory)
//   - skill loading from ~/.claude/skills/<name>/SKILL.md (path-safe)
//   - per-turn `runOneShot` with sane defaults (system prompt, --resume
//     threading, tool-permission skipping)
//   - post-turn extraction of clean markdown + usage + tool list from
//     the upstream JSONL session file
//   - per-token cost calculation
//
// Usage:
//   import { createChatClient } from 'open-claude-p/chat';
//   const chat = createChatClient({ dangerouslySkipPermissions: true });
//   const { text, conversationId, meta } = await chat.send({
//     message: 'Hello',
//     onEvent: (ev) => { /* spinner, assistant-text streaming, ... */ },
//   });

import path from 'node:path';
import os from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, stat, lstat, chmod, realpath, rename, unlink, open } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import lockfile from 'proper-lockfile';

import { createDriver } from '../index.js';
export {
  cleanSpinnerLabel,
  isAssistantTextNoise,
  extractToolName,
  stripTerminalControl,
} from './event-filters.js';
import { extractToolName, stripTerminalControl } from './event-filters.js';

const DEFAULT_DB_FILENAME = 'conversations.json';
const DEFAULT_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
function envPositiveInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const MAX_CONVERSATIONS = envPositiveInt('OCP_MAX_CONVERSATIONS', 500);
const MAX_MESSAGES_PER_CONV = envPositiveInt('OCP_MAX_MESSAGES_PER_CONV', 500);

// Module-level per-key promise chain. Used in two roles:
//   (a) `withDbLock(dbPath, …)` — in-process serialisation of file IO
//       for a given conversations.json. Combined with `withFileLock`
//       (below) to also block other processes targeting the same file.
//   (b) `withDbLock("${dbPath}::${convId}", …)` — per-conversation lock
//       wrapping a whole `chat.send()` so two same-conv calls cannot
//       interleave their user/assistant turns.
//
// Lock-key invariant: the per-conversation key uses `::` as separator
// (never present in absolute filesystem paths in either form), so it
// cannot collide with a bare `dbPath` key acquired by `withFileLock`.
// Keep this invariant if you ever change the key format — collision
// would deadlock (outer holds key X waiting on its inner fn, inner
// `withDbLock(X, …)` chains forever behind outer).
//
// NOTE on re-entrancy: calling `chat.send(...)` synchronously from
// inside an `onEvent` callback of an in-flight `chat.send(...)` to the
// SAME dbPath would deadlock — outer holds the lock until its driver
// finishes; inner waits for outer to release; outer can't finish
// because its driver is blocked on the inner await. Defer the inner
// call with `queueMicrotask` / `setImmediate` (fire-and-forget) if
// you need to chain, or use a different `dbPath` for the inner client.
const dbLocks = new Map();
function withDbLock(key, fn) {
  const prev = dbLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn).finally(() => {
    if (dbLocks.get(key) === next) dbLocks.delete(key);
  });
  dbLocks.set(key, next);
  return next;
}

// In-process `withDbLock` only serialises within ONE Node process.
// Two separate processes (PM2 cluster, daemon + manual CLI, parallel
// shells) targeting the same conversations.json would still race on
// read-modify-write — the atomic tmp+rename keeps each write whole
// but the loser silently overwrites the winner with stale state.
// `withFileLock` adds a cross-process advisory lock on top, via
// proper-lockfile.
//
// Why a synthetic lock path under os.tmpdir() rather than locking the
// dbPath directly (which would create a sibling `<dbPath>.lock/` dir):
//   - `<dbPath>.lock/` in the user's cwd is surprising; shows up in
//     `git status`, can be accidentally committed, and leaks chat
//     existence after `conversations.json` is deleted.
//   - Locking `dbPath` directly requires it to exist pre-lock — eagerly
//     creating `{conversations:[]}` surprises callers that probe with
//     `existsSync` before deciding to chat.
//
// The lock path = sha256(realpath(dbPath)) so symlinked aliases (path A
// is a symlink whose target is path B) hash to the same lock. Plain
// `path.resolve` is purely lexical and would let A and B race.
//
// LOCK_DIR is per-uid: `open-claude-p-locks-<uid>` under tmpdir. This
// closes three multi-tenant hazards at once:
//   - shared 0o700 dir owned by user A blocks user B with EACCES
//   - attacker on the host pre-creating LOCK_DIR with looser perms
//     bypasses the 0o700 we'd otherwise have set (mkdir doesn't chmod
//     existing dirs)
//   - cross-user hash enumeration of `<sha256>.lock` filenames leaks
//     which dbPaths neighbours are using
// We still verify ownership + mode after mkdir as belt-and-suspenders
// in case the dir was tampered with between runs.
//
// Trade-off: locks live on tmpdir (machine-local). Two processes on
// different hosts sharing a dbPath via NFS/SMB will NOT serialise —
// but proper-lockfile is itself unsafe on NFS<v3, so this is no
// regression from the threat model.
const LOCK_UID = (typeof process.getuid === 'function') ? process.getuid() : 'nouid';
const LOCK_DIR = path.join(os.tmpdir(), `open-claude-p-locks-${LOCK_UID}`);
const SENTINEL_MAX_AGE_MS = envPositiveInt('OCP_LOCK_SWEEP_AGE_MS', 24 * 60 * 60 * 1000);

async function canonicalDbPath(filePath) {
  // Prefer realpath so symlink A and target B canonicalise to one key.
  // If filePath doesn't exist yet (first-ever call), realpath ENOENT —
  // fall back to realpath(parent)/basename so we still canonicalise the
  // dir portion (the common alias source). On macOS this is also where
  // `/var → /private/var` collapses, so two callers passing the same
  // logical path through different OS-level symlinks end up identical.
  //
  // Non-ENOENT failures (EACCES on a parent dir, ELOOP from a symlink
  // cycle, ENOTDIR when a path component is actually a regular file)
  // mean the dbPath is unusable for locking — wrap as a domain error so
  // callers see a consistent ChatErrorCodes value instead of raw
  // libuv-style codes leaking through.
  try {
    return await realpath(filePath);
  } catch (e) {
    if (e.code === 'ENOENT') {
      const dir = path.dirname(filePath);
      let realDir;
      try { realDir = await realpath(dir); }
      catch (e2) {
        if (e2.code !== 'ENOENT') {
          const wrapped = new Error(`chat: cannot resolve dbPath ${filePath} (${e2.code} on parent dir)`, { cause: e2 });
          wrapped.code = 'ERR_CHAT_DBPATH_INVALID';
          throw wrapped;
        }
        realDir = path.resolve(dir);
      }
      return path.join(realDir, path.basename(filePath));
    }
    const wrapped = new Error(`chat: cannot resolve dbPath ${filePath} (${e.code})`, { cause: e });
    wrapped.code = 'ERR_CHAT_DBPATH_INVALID';
    throw wrapped;
  }
}

function lockPathForCanonical(canonical) {
  const h = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  return path.join(LOCK_DIR, `${h}.lock`);
}

let lockDirVerified = false;
async function ensureLockDir() {
  if (lockDirVerified) return;
  await mkdir(LOCK_DIR, { recursive: true, mode: 0o700 });
  // mkdir is a no-op on an existing dir — re-assert mode + ownership so
  // a pre-existing tampered or umask-derived dir doesn't leak listings.
  const st = await lstat(LOCK_DIR);
  if (st.isSymbolicLink()) {
    const e = new Error(`chat: refusing to use ${LOCK_DIR} — it is a symbolic link`);
    e.code = 'ERR_CHAT_LOCK_DIR_TAMPERED';
    throw e;
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    const e = new Error(`chat: refusing to use ${LOCK_DIR} — owned by uid ${st.uid}, expected ${process.getuid()}`);
    e.code = 'ERR_CHAT_LOCK_DIR_TAMPERED';
    throw e;
  }
  if ((st.mode & 0o777) !== 0o700) {
    await chmod(LOCK_DIR, 0o700).catch(() => {});
  }
  lockDirVerified = true;
}

let sentinelSwept = false;
async function sweepLockDir() {
  if (sentinelSwept) return;
  sentinelSwept = true;
  try {
    const entries = await readdir(LOCK_DIR);
    if (entries.length > 4096) return; // hostile-peer guard
    const now = Date.now();
    await Promise.all(entries
      .filter((e) => e.endsWith('.lock'))
      .map(async (e) => {
        const p = path.join(LOCK_DIR, e);
        try {
          const st = await lstat(p);
          if (!st.isFile()) return; // never touch dirs/symlinks
          if (now - st.mtimeMs > SENTINEL_MAX_AGE_MS) await unlink(p).catch(() => {});
        } catch {}
      }));
  } catch {}
}

// Track in-flight lock keys per async context so a re-entrant
// `chat.send()` from within an `onEvent` callback throws a clear
// `ERR_REENTRANT_SEND` instead of deadlocking forever on its own
// outer lock. AsyncLocalStorage propagates through promise chains,
// timers, and `await`, which is exactly the surface where a consumer
// might naively re-enter.
//
// CAVEAT: ALS does NOT propagate across `worker_threads`. A driver
// that dispatches work to a worker and re-enters `chat.send` from
// that worker's context bypasses the re-entrancy guard. Same goes
// for forked child processes (which inherit the lock fd via flock
// semantics but not the ALS store). Out of scope for the SDK to
// detect; document so callers know.
const LOCK_CONTEXT = new AsyncLocalStorage();
function heldLockKeys() { return LOCK_CONTEXT.getStore() ?? new Set(); }

// Module-level constant — hoisted out of the catch block so we don't
// pay per-error Set allocation. Codes that already carry their own
// `code` value should propagate as-is rather than being re-wrapped as
// `ERR_CHAT_LOCK_FAILED`.
const PASS_THROUGH_CODES = new Set([
  'ERR_REENTRANT_SEND',
  'ERR_CHAT_LOCK_TAMPERED',
  'ERR_CHAT_LOCK_DIR_TAMPERED',
  'ERR_CHAT_LOCK_LOST',
  'ERR_CHAT_DBPATH_INVALID',
]);
// AbortError is matched by `e.name` separately below since it has no
// `e.code` in stock Node.

// One-shot Node warning so callers that catch `chat.send` errors
// generically (no `err.code` check) still see a signal that they're
// losing user turns. Emitted via the standard process warning channel
// so it routes through any structured logger the host already wired.
let busyWarned = false;
function emitBusyWarningOnce() {
  if (busyWarned) return;
  busyWarned = true;
  try {
    process.emitWarning(
      'chat.send rejected with ERR_CHAT_BUSY — the user turn was NOT persisted. Catch the error and retry, or you will silently lose messages under cross-process contention.',
      { type: 'ChatBusyDataLoss', code: 'ERR_CHAT_BUSY' },
    );
  } catch { /* emitWarning unavailable */ }
}

async function withFileLock(filePath, fn) {
  // Canonicalise BEFORE picking the in-process key so two callers in
  // one process passing symlink aliases (`./link.json` vs the realpath
  // target) still queue on the same key. Without this, the in-process
  // mutex would be bypassed even though the cross-process lockfile
  // would catch it — silent same-process corruption.
  const canonical = await canonicalDbPath(filePath);
  return withDbLock(canonical, async () => {
    const held = heldLockKeys();
    if (held.has(`file::${canonical}`)) {
      const e = new Error(`chat: re-entrant chat.send detected on ${filePath}; do not call chat.send from inside another chat.send's onEvent`);
      e.code = 'ERR_REENTRANT_SEND';
      throw e;
    }
    await ensureLockDir();
    await sweepLockDir();
    const lockPath = lockPathForCanonical(canonical);
    // O_CREAT|O_EXCL|O_NOFOLLOW|O_WRONLY: atomic create that refuses to
    // follow a pre-planted symlink at the final path component. EEXIST
    // = a sibling created it first (benign). ELOOP = symlink hijack
    // attempt — refuse rather than racing.
    try {
      const fh = await open(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW | fsConstants.O_WRONLY,
        0o600,
      );
      await fh.close();
    } catch (err) {
      if (err.code === 'ELOOP') {
        const e = new Error(`chat: refusing to lock ${filePath} — sentinel ${lockPath} is a symlink (tampering)`);
        e.code = 'ERR_CHAT_LOCK_TAMPERED';
        throw e;
      }
      if (err.code !== 'EEXIST') throw err;
      // Re-verify the existing sentinel isn't a symlink (race: planted
      // between sweep and our open).
      const lst = await lstat(lockPath).catch(() => null);
      if (lst && !lst.isFile()) {
        const e = new Error(`chat: refusing to lock ${filePath} — sentinel ${lockPath} is not a regular file (tampering)`);
        e.code = 'ERR_CHAT_LOCK_TAMPERED';
        throw e;
      }
    }
    let release;
    let compromised = null;
    const newHeld = new Set(held);
    newHeld.add(`file::${canonical}`);
    try {
      release = await lockfile.lock(lockPath, {
        retries: { retries: 30, minTimeout: 50, maxTimeout: 500, factor: 1.5 },
        stale: 10_000,
        realpath: false,
        // Fires when proper-lockfile's internal mtime-refresh interval
        // fails (e.g. tmpdir cleared mid-lock). Without a handler, the
        // library emits a `compromised` event with no listeners and the
        // in-flight `fn()` proceeds blind — split-brain. We capture the
        // error so the outer try can rethrow after fn() completes; we
        // can't interrupt fn() directly (no AbortController surface),
        // but signalling via a rejected promise still aborts the writer.
        onCompromised: (err) => { compromised = err; },
      });
      const result = await LOCK_CONTEXT.run(newHeld, fn);
      if (compromised) {
        const e = new Error(`chat: lock on ${filePath} was compromised mid-operation (${compromised.message || compromised.code})`);
        e.code = 'ERR_CHAT_LOCK_LOST';
        e.cause = compromised;
        throw e;
      }
      return result;
    } catch (e) {
      // If fn threw AND the lock was also compromised mid-flight, the
      // original throw is the proximate cause — but attach the
      // compromised error so post-mortem still surfaces it. Without
      // this, a fn() that EACCES'd because the tmpdir was cleared
      // would look like a random filesystem error with no hint that
      // the lock was lost.
      if (compromised && e && typeof e === 'object' && !e.lockCompromised) {
        try { e.lockCompromised = compromised; } catch {}
      }
      // Surface cross-process contention as a stable domain error.
      // Caller MUST retry — Phase 1 rejected before the user turn was
      // persisted, so silently swallowing this means data loss. We
      // also emit a one-shot Node warning so callers that swallow all
      // errors generically still see a signal in their logs.
      if (e?.code === 'ELOCKED') {
        const wrapped = new Error(
          `chat: lock acquisition timed out for ${filePath}; message was NOT persisted — retry to record this turn`,
          { cause: e },
        );
        wrapped.code = 'ERR_CHAT_BUSY';
        wrapped.persisted = false;
        // Mirror lockCompromised onto the wrap so consumers don't have
        // to dig through err.cause.lockCompromised in their handler.
        if (compromised) wrapped.lockCompromised = compromised;
        emitBusyWarningOnce();
        throw wrapped;
      }
      // Anything else thrown out of fn() or the lock acquire — wrap as
      // a single domain error so consumers don't need to hand-classify
      // libuv codes (EACCES, ENOSPC, EROFS, ENOTDIR) or chase
      // programmer bugs (TypeError, ReferenceError, SyntaxError) that
      // happened to escape from `fn`. Re-entrancy/tampering errors
      // already have their own codes and pass through unchanged.
      if (e?.code && PASS_THROUGH_CODES.has(e.code)) throw e;
      if (e?.name === 'AbortError') throw e;
      if (e?.__chatWrapped) throw e;
      const wrapped = new Error(
        `chat: lock subsystem failure for ${filePath} (${e?.code || e?.name || 'unknown'})`,
        { cause: e },
      );
      wrapped.code = 'ERR_CHAT_LOCK_FAILED';
      wrapped.__chatWrapped = true;
      if (compromised) wrapped.lockCompromised = compromised;
      throw wrapped;
    } finally {
      if (release) await release().catch(() => {});
      // Best-effort sentinel cleanup once we've released. A racer that
      // re-creates it via O_CREAT|O_EXCL will succeed atomically; if
      // they already created the marker dir we'll skip the unlink.
      try {
        const markerExists = await stat(`${lockPath}.lock`).then(() => true, () => false);
        if (!markerExists) await unlink(lockPath).catch(() => {});
      } catch {}
    }
  });
}

/**
 * Stable error codes thrown by `chat.send()` / `deleteConversation()`.
 * Caller-checkable via `err.code === ChatErrorCodes.BUSY`, etc.
 */
export const ChatErrorCodes = Object.freeze({
  BUSY: 'ERR_CHAT_BUSY',
  LOCK_LOST: 'ERR_CHAT_LOCK_LOST',
  LOCK_TAMPERED: 'ERR_CHAT_LOCK_TAMPERED',
  LOCK_DIR_TAMPERED: 'ERR_CHAT_LOCK_DIR_TAMPERED',
  LOCK_FAILED: 'ERR_CHAT_LOCK_FAILED',
  DBPATH_INVALID: 'ERR_CHAT_DBPATH_INVALID',
  DRIVER_FAILED: 'ERR_CHAT_DRIVER_FAILED',
  REENTRANT: 'ERR_REENTRANT_SEND',
  INVALID_ID: 'ERR_INVALID_ID',
  INVALID_MESSAGE: 'ERR_INVALID_MESSAGE',
  MESSAGE_TOO_LARGE: 'ERR_MESSAGE_TOO_LARGE',
});

// Sonnet 4.x default pricing (USD per token). Override via `pricing` opt
// (createChatClient) or by passing your own rates into `computeCost`.
export const DEFAULT_PRICING = {
  input:      3.00e-6,
  cacheWrite: 3.75e-6,
  cacheRead:  0.30e-6,
  output:    15.00e-6,
};

/**
 * Total input tokens for a turn = base input + cache write + cache read.
 *
 * @param {object|null} usage  upstream `message.usage` block from the JSONL session file.
 * @returns {number|null}
 */
// Defensive coercion — a malicious or buggy JSONL field that holds a
// string ("3") or an absurdly large number (1e308) would otherwise
// propagate NaN / Infinity through cost / token math.
function safeTokens(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 100_000_000); // 100M token ceiling
}

export function totalInputTokens(usage) {
  if (!usage) return null;
  return safeTokens(usage.input_tokens)
       + safeTokens(usage.cache_creation_input_tokens)
       + safeTokens(usage.cache_read_input_tokens);
}

/**
 * USD cost of a turn from the upstream `message.usage` block and a
 * `{ input, cacheWrite, cacheRead, output }` pricing table. Returns
 * `null` if usage is missing.
 *
 * @param {object|null} usage
 * @param {object} [pricing]  defaults to `DEFAULT_PRICING`
 * @returns {number|null}
 */
export function computeCost(usage, pricing = DEFAULT_PRICING) {
  if (!usage) return null;
  return safeTokens(usage.input_tokens)              * pricing.input
       + safeTokens(usage.cache_creation_input_tokens) * pricing.cacheWrite
       + safeTokens(usage.cache_read_input_tokens)   * pricing.cacheRead
       + safeTokens(usage.output_tokens)             * pricing.output;
}

/**
 * Compact token count formatter: 41200 → `"41.2K"`, 864 → `"864"`.
 * @param {number|null} n
 * @returns {string}
 */
export function formatTokens(n) {
  if (n == null) return '?';
  if (n < 1000) return String(n);
  if (n < 100_000) return (n / 1000).toFixed(1) + 'K';
  return Math.round(n / 1000) + 'K';
}

// Base rule the chat SDK applies to every turn — phrased as a
// behavioural principle, not a tool-by-tool recipe. The intent is the
// thing this SDK is for: an *interactive* assistant that actually uses
// its capabilities instead of declining. Caller-supplied
// `appendSystemPrompt` is APPENDED on top of this, not a replacement.
// To opt the base rule out entirely, pass `appendSystemPrompt: null`.
export const DEFAULT_APPEND_SYSTEM_PROMPT =
  'You are powering an interactive assistant. When the user asks for ' +
  'information you cannot fully answer from training data alone ' +
  '(current events, real-time data, specific facts that may have ' +
  'changed, content of a URL, anything time-sensitive), use the ' +
  'appropriate available tools to look it up and answer with the ' +
  'actual values, rather than declining or returning only a list of ' +
  'links for the user to check themselves. Be thorough.\n\n' +
  'If you cannot derive an answer from your own knowledge, you MUST ' +
  'use tools like WebSearch / WebFetch to look it up and return the ' +
  'actual result.';

/**
 * Compose the effective `appendSystemPrompt` from the SDK base default,
 * the chat-client option, and the per-turn override.
 *
 * Semantics:
 *   - `clientOpt === undefined` → base default only
 *   - `clientOpt === null`      → base default is suppressed for this client
 *   - `clientOpt === string`    → base default + clientOpt
 *   - per-turn `null`           → suppress everything for this turn
 *   - per-turn string           → previous compose + turnOpt
 */
function composeAppendSystemPrompt(clientOpt, turnOpt) {
  if (turnOpt === null) return null; // explicit per-turn opt-out
  const parts = [];
  if (clientOpt !== null) parts.push(DEFAULT_APPEND_SYSTEM_PROMPT);
  if (typeof clientOpt === 'string' && clientOpt.length > 0) parts.push(clientOpt);
  if (typeof turnOpt === 'string' && turnOpt.length > 0) parts.push(turnOpt);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

const SENTINEL_REGEX = /⟦OCP_END:[a-f0-9]+⟧/g;

/**
 * @param {object} [opts]
 * @param {string} [opts.dbPath]                  Path to the conversations JSON file. Default `./conversations.json`
 *                                                in the process cwd, so each project keeps its own history.
 * @param {string} [opts.skillsDir]               Directory holding `<name>/SKILL.md` files. Default `~/.claude/skills`.
 * @param {boolean} [opts.dangerouslySkipPermissions=false]
 *                                                Forward `--dangerously-skip-permissions` to upstream so tool
 *                                                calls (WebSearch, Bash, …) do not block on a permission prompt.
 * @param {string|null} [opts.appendSystemPrompt] Appended to every turn's system prompt. Pass `null` to disable
 *                                                the default ("use WebSearch immediately …") text.
 * @param {object} [opts.pricing]                 Per-token rates: `{ input, cacheWrite, cacheRead, output }`.
 * @param {object} [opts.driver]                  An existing driver instance to reuse. If omitted, the client
 *                                                creates and owns its own driver (closed by `close()`).
 * @param {object} [opts.driverOpts]              Passed to `createDriver()` when no driver is supplied.
 */
export function createChatClient(opts = {}) {
  // Default to `<cwd>/conversations.json` so each project gets its own
  // store. Pass an explicit absolute path to share one DB across
  // multiple processes / cwds.
  const dbPath = opts.dbPath
    ? path.resolve(opts.dbPath)
    : path.resolve(process.cwd(), DEFAULT_DB_FILENAME);
  const skillsDir = path.resolve(opts.skillsDir ?? DEFAULT_SKILLS_DIR);
  const dangerouslySkipPermissions = opts.dangerouslySkipPermissions ?? false;
  // Store the raw client-level option (string | null | undefined); the
  // per-turn compose merges it with the SDK base default and any
  // per-turn override.
  const clientAppendOpt = opts.appendSystemPrompt;
  const pricing = { ...DEFAULT_PRICING, ...(opts.pricing ?? {}) };
  // Sanity guard — anyone copy-pasting Anthropic's published "$3 / 1M
  // tokens" rate as `input: 3` would overcharge by 1,000,000×. No
  // sane per-token rate ever reaches one cent.
  for (const [k, v] of Object.entries(pricing)) {
    if (typeof v === 'number' && v > 1e-2) {
      process.stderr.write(
        `[ocp/chat] pricing.${k}=${v} looks like a per-1M-token rate. Anthropic publishes USD per 1M tokens — divide by 1e6 (e.g. 3 → 3e-6).\n`,
      );
      break; // one warning per createChatClient is enough
    }
  }
  const driver = opts.driver ?? createDriver(opts.driverOpts ?? {});
  const ownsDriver = !opts.driver;

  // Best-effort cleanup of stale `<dbPath>.<pid>.<ts>.tmp` leftovers
  // from crashed saveDB calls. Runs at most once per process per dbPath.
  let tmpSwept = false;
  async function sweepStaleTmp() {
    if (tmpSwept) return;
    tmpSwept = true;
    try {
      const dir = path.dirname(dbPath);
      const base = path.basename(dbPath);
      const entries = await readdir(dir);
      const matches = entries.filter((e) => e.startsWith(`${base}.`) && e.endsWith('.tmp'));
      // Hard cap to defend against a hostile/noisy peer dropping
      // thousands of `<base>.999999.999999.tmp` files in dirname —
      // unbounded Promise.all over readdir would EMFILE / stall the
      // event loop on first chat.send.
      if (matches.length > 64) matches.length = 64;
      const now = Date.now();
      const TMP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
      await Promise.all(matches.map(async (e) => {
        const p = path.join(dir, e);
        try {
          const st = await stat(p);
          if (now - st.mtimeMs > TMP_MAX_AGE_MS) await unlink(p).catch(() => {});
        } catch { /* ignore */ }
      }));
    } catch { /* ignore */ }
  }

  async function loadDB() {
    await sweepStaleTmp();
    let raw;
    try { raw = await readFile(dbPath, 'utf8'); }
    catch (e) {
      // Only treat "file does not exist" as empty. EISDIR / EACCES /
      // EIO must rethrow — otherwise saveDB later atomically renames an
      // empty conversations array over the user's real history.
      if (e.code === 'ENOENT') return { conversations: [] };
      // Scrub error message — a same-uid attacker who can write the
      // store can plant control bytes that JSON.parse / fs would
      // surface raw into the user's terminal otherwise.
      const scrub = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f\x80-\x9f]/g, '?').slice(0, 512);
      throw new Error(`loadDB: refusing to overwrite ${dbPath} — ${e.code || e.name}: ${scrub(e.message)}`);
    }
    try { return JSON.parse(raw); }
    catch (e) {
      const scrub = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f\x80-\x9f]/g, '?').slice(0, 512);
      throw new Error(`loadDB: ${dbPath} is not valid JSON (${scrub(e.message)}) — refusing to overwrite. Move or delete the file to start fresh.`);
    }
  }
  async function saveDB(db) {
    // Atomic write: stage to a sibling tmp file then rename, so a crash
    // between truncation and final flush never produces a partial JSON.
    // Mode 0o600 — the store contains user prompts + assistant replies
    // (potentially sensitive) and other users on the host should not be
    // able to read it.
    await mkdir(path.dirname(dbPath), { recursive: true });
    const tmp = `${dbPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
    await rename(tmp, dbPath);
  }

  function resolveSkillPath(skillName) {
    if (typeof skillName !== 'string') return null;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(skillName)) return null;
    const resolved = path.resolve(skillsDir, skillName, 'SKILL.md');
    if (!resolved.startsWith(skillsDir + path.sep)) return null;
    return resolved;
  }

  // Read a SKILL.md without following symlinks at ANY path component.
  // O_NOFOLLOW only blocks the final segment, so `~/.claude/skills/foo
  // → /etc` with a real SKILL.md inside would still escape. We lstat
  // every segment from skillsDir down and refuse if any is a symlink.
  //
  // We also refuse to read from skillsDir if it (or any intermediate
  // segment) is group/world-writable: a per-segment lstat + final
  // O_NOFOLLOW can't close the TOCTOU window where an attacker with
  // write access swaps a checked component into a symlink between our
  // lstat and the final open. Refusing loose-mode skillsDir is the
  // practical mitigation since Node lacks `openat`. Owner-only mode is
  // also what `mkdir ~/.claude/skills` will produce under any sane
  // umask, so this should never fire on a legitimate setup.
  let skillsDirVerified = false;
  let skillsDirWarned = false;
  async function ensureSkillsDirSafe() {
    if (skillsDirVerified) return true;
    let reason = null;
    try {
      const st = await lstat(skillsDir);
      if (st.isSymbolicLink()) reason = 'is a symbolic link';
      else if (st.mode & 0o022) reason = `mode ${(st.mode & 0o777).toString(8)} is group/other-writable (expected 0o700 or 0o755 without write)`;
      else if (typeof process.getuid === 'function' && st.uid !== process.getuid()) reason = `owned by uid ${st.uid}, expected ${process.getuid()}`;
      else {
        skillsDirVerified = true;
        return true;
      }
    } catch (e) {
      // ENOENT is expected on a fresh install; suppress to avoid noise.
      if (e?.code !== 'ENOENT' && !skillsDirWarned) {
        skillsDirWarned = true;
        try { process.emitWarning(`chat: skillsDir ${skillsDir} is unreadable (${e?.code || e?.message}); skills will be silently ignored.`, { type: 'ChatSkillsDirUnsafe' }); } catch {}
      }
      return false;
    }
    if (!skillsDirWarned) {
      skillsDirWarned = true;
      try { process.emitWarning(`chat: skillsDir ${skillsDir} refused — ${reason}. Skills will be silently ignored until this is fixed.`, { type: 'ChatSkillsDirUnsafe' }); } catch {}
    }
    return false;
  }
  async function readSkillFile(skillPath) {
    if (!await ensureSkillsDirSafe()) return null;
    const rel = path.relative(skillsDir, skillPath);
    const parts = rel.split(path.sep);
    let probe = skillsDir;
    for (let i = 0; i < parts.length - 1; i++) {
      probe = path.join(probe, parts[i]);
      const lst = await lstat(probe).catch(() => null);
      if (!lst) return null;
      if (lst.isSymbolicLink()) return null;
      // Same loose-mode refusal at each level — a group-writable
      // sub-dir under skillsDir is still swap-able mid-walk.
      if (lst.mode & 0o022) return null;
    }
    let fh;
    try {
      fh = await open(skillPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      return await fh.readFile('utf8');
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  return {
    /** List all conversations (metadata only). */
    async listConversations() {
      const db = await loadDB();
      return db.conversations.map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: c.messages.length,
        claudeSessionId: c.claudeSessionId,
      }));
    },

    /** Get a conversation with full message history. Returns null if not found. */
    async getConversation(id) {
      const db = await loadDB();
      return db.conversations.find((c) => c.id === id) ?? null;
    },

    /**
     * Delete a conversation. Returns `true` if removed, `false` if not
     * found. Also throws the same lock-related `ChatErrorCodes` as
     * `chat.send()` (`BUSY`, `LOCK_LOST`, `LOCK_TAMPERED`, etc.) since
     * the read-modify-write acquires the same file lock.
     * @throws {Error} `ERR_INVALID_ID` — `id` is missing/empty/non-string
     */
    async deleteConversation(id) {
      // Without this guard, `undefined` would silently match no row and
      // return `false`, which the caller can't distinguish from "valid
      // id, not found" — and writing `if (!await deleteConversation(x))`
      // would mask programmer bugs that ought to surface.
      if (typeof id !== 'string' || !id) {
        const err = new Error('chat.deleteConversation: `id` must be a non-empty string');
        err.code = 'ERR_INVALID_ID';
        throw err;
      }
      let removed = false;
      await withFileLock(dbPath, async () => {
        const db = await loadDB();
        const before = db.conversations.length;
        db.conversations = db.conversations.filter((c) => c.id !== id);
        removed = db.conversations.length < before;
        if (removed) await saveDB(db);
      });
      return removed;
    },

    /** List installed skills with description from `SKILL.md` frontmatter. */
    async listSkills() {
      let entries;
      try { entries = await readdir(skillsDir); } catch { return []; }
      const out = [];
      for (const name of entries) {
        if (name.startsWith('_')) continue;
        const skillPath = resolveSkillPath(name);
        if (!skillPath) continue;
        try {
          const md = await readSkillFile(skillPath);
          // readSkillFile returns null when the skill (or skillsDir)
          // fails any of the safety checks. List the skill with no
          // description rather than throwing in null.match — the
          // outer catch would swallow but the entry would silently
          // disappear, surprising callers that compare list lengths.
          const m = md ? md.match(/^description:\s*(.+)$/m) : null;
          out.push({ name, description: m?.[1]?.trim() || name });
        } catch { /* skip */ }
      }
      return out;
    },

    /**
     * Send a chat message. Creates a new conversation when `conversationId`
     * is null. Resumes the upstream session for subsequent turns so the
     * model preserves context.
     *
     * @param {object} req
     * @param {string|null} [req.conversationId] Null to create a new conversation.
     * @param {string}      req.message          User prompt text.
     * @param {string|null} [req.skillName]      Name under `skillsDir` whose SKILL.md is injected as system prompt.
     * @param {Function}    [req.onEvent]        Receives `{type, …}` driver events (spinner, assistant-text, …)
     *                                            for live progress rendering.
     * @param {AbortSignal} [req.signal]         Abort the in-flight request.
     * @param {number}      [req.maxResponseMs]  Override the driver's response timeout for this turn.
     * @param {string}      [req.appendSystemPrompt]
     *                                            Per-turn override of the client default.
     * @returns {Promise<{
     *   conversationId: string,
     *   text: string,
     *   isNew: boolean,
     *   isError: boolean,
     *   completionReason: string,
     *   sessionId: string|null,
     *   meta: {
     *     elapsedMs: number,
     *     inputTokens: number|null,
     *     outputTokens: number|null,
     *     costUsd: number|null,
     *     tools: string[],
     *   },
     * }>}
     *
     * @throws {Error} with `err.code` set to one of `ChatErrorCodes`:
     *   - `ERR_INVALID_MESSAGE`        — `message` missing/empty/non-string
     *   - `ERR_MESSAGE_TOO_LARGE`      — exceeds `OCP_MAX_MESSAGE_CHARS` (default 256 KiB)
     *   - `ERR_CHAT_BUSY`              — cross-process lock contention after retries;
     *                                     `err.persisted === false` indicates the user
     *                                     turn was NOT saved. Caller MUST retry to
     *                                     record this turn. (Also emits a one-shot
     *                                     `ChatBusyDataLoss` Node warning so callers
     *                                     that catch generically still see the signal.)
     *   - `ERR_CHAT_LOCK_LOST`         — proper-lockfile's mtime refresh failed mid-op
     *                                     (e.g. tmpdir cleared). Treat as transient;
     *                                     `err.cause` carries the original event.
     *   - `ERR_CHAT_LOCK_TAMPERED`     — sentinel file is a symlink or non-regular file;
     *                                     someone is racing the lock dir.
     *   - `ERR_CHAT_LOCK_DIR_TAMPERED` — lock dir owned by another uid or is a
     *                                     symlink; refuse to proceed.
     *   - `ERR_CHAT_LOCK_FAILED`       — any other lock-acquire failure (EACCES on
     *                                     LOCK_DIR, ENOSPC on tmpdir, ENOTDIR, …)
     *                                     wrapped with `err.cause` preserved.
     *   - `ERR_CHAT_DBPATH_INVALID`    — `dbPath` cannot be canonicalised (EACCES on
     *                                     a parent dir, ELOOP from a symlink cycle,
     *                                     ENOTDIR when a component is a regular file).
     *   - `ERR_REENTRANT_SEND`         — `chat.send()` called from within another
     *                                     `chat.send()`'s onEvent callback for the
     *                                     same dbPath. Defer with `setImmediate` or
     *                                     use a separate dbPath. NOTE: detection
     *                                     uses AsyncLocalStorage, which does not
     *                                     propagate across `worker_threads` or
     *                                     `child_process.fork()`. Re-entry from a
     *                                     worker bypasses this guard.
     *   - `AbortError`                 — `signal` was already aborted at entry.
     *
     * Cross-uid: each uid has its own lock dir under
     * `os.tmpdir()/open-claude-p-locks-<uid>/`. Two users sharing a
     * group-writable `dbPath` will NOT serialise across uids — operate
     * the store as single-user.
     */
    async send({
      conversationId = null,
      message,
      skillName = null,
      onEvent,
      signal,
      maxResponseMs,
      appendSystemPrompt,
    }) {
      if (typeof message !== 'string' || !message.trim()) {
        const err = new Error('chat.send: `message` must be a non-empty string');
        err.code = 'ERR_INVALID_MESSAGE';
        throw err;
      }
      const MAX_MESSAGE_CHARS = envPositiveInt('OCP_MAX_MESSAGE_CHARS', 262_144);
      if (message.length > MAX_MESSAGE_CHARS) {
        const err = new Error(`chat.send: message exceeds ${MAX_MESSAGE_CHARS} chars; split it or raise OCP_MAX_MESSAGE_CHARS`);
        err.code = 'ERR_MESSAGE_TOO_LARGE';
        throw err;
      }
      // Pre-flight abort check — fail fast before persisting anything.
      if (signal?.aborted) {
        const err = new Error('chat.send: aborted before send');
        err.name = 'AbortError';
        throw err;
      }

      // Per-conversation serialisation. Two concurrent sends to the
      // SAME conversationId would otherwise interleave Phase 1 / Phase
      // 2 and corrupt transcript order (`[userA, userB, asstA, asstB]`).
      // The lock key differs from `dbPath` so different conversations
      // on the same store still proceed in parallel — only the inner
      // Phase-1/Phase-2 file IO serialises across convs.
      //
      // Re-entrancy detection: track BOTH the conv key (catches same-
      // conv recursion) and a coarser `dbpath::` key (catches different-
      // conv recursion on the same store — without it, an `onEvent` that
      // synchronously calls `chat.send` with a NEW conversationId would
      // recurse forever, since each call gets a fresh UUID and the conv
      // check never matches). The `file::` key inside withFileLock is
      // released between Phase 1 and Phase 2, so we can't rely on it
      // during the driver call window where onEvent fires.
      // Canonicalise dbPath so symlink-aliased clients (one passes
      // `~/conv.json`, another passes the realpath target) share the
      // same `dbpath::` key. Without this, the re-entrancy guard would
      // miss aliases — the file-level guard inside `withFileLock` still
      // catches them, but later (Phase 1) and with less context.
      const canonicalDb = await canonicalDbPath(dbPath);
      const convLockKey = `${canonicalDb}::${conversationId ?? `new-${randomUUID()}`}`;
      const heldNow = heldLockKeys();
      if (heldNow.has(`conv::${convLockKey}`) || heldNow.has(`dbpath::${canonicalDb}`)) {
        const err = new Error(`chat.send: re-entrant call detected on ${dbPath}; do not call chat.send from inside another chat.send's onEvent (defer with setImmediate or use a separate dbPath)`);
        err.code = 'ERR_REENTRANT_SEND';
        throw err;
      }
      const nextHeld = new Set(heldNow);
      nextHeld.add(`conv::${convLockKey}`);
      nextHeld.add(`dbpath::${canonicalDb}`);
      return withDbLock(convLockKey, async () => LOCK_CONTEXT.run(nextHeld, async () => {

      // Phase 1 (locked): create / fetch the conversation, append the
      // user message, persist. Held only for the duration of one
      // load→mutate→save round so concurrent send()s queue here for
      // milliseconds, not for the duration of the LLM call below.
      let conv, isNew, initialClaudeSessionId;
      await withFileLock(dbPath, async () => {
        const db = await loadDB();
        conv = conversationId ? db.conversations.find((c) => c.id === conversationId) : null;
        isNew = !conv;
        if (!conv) {
          conv = {
            id: randomUUID(),
            title: message.slice(0, 60),
            claudeSessionId: null,
            messages: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          db.conversations.unshift(conv);
        }
        conv.messages.push({ role: 'user', content: message, timestamp: new Date().toISOString() });
        // Cap unbounded growth — every send() does a full read-modify-
        // write of this file, so an old project's transcript grows
        // O(turns) on disk and O(turns) per-call CPU. Tunable via the
        // OCP_MAX_CONVERSATIONS / OCP_MAX_MESSAGES_PER_CONV envs.
        if (conv.messages.length > MAX_MESSAGES_PER_CONV) {
          conv.messages = conv.messages.slice(-MAX_MESSAGES_PER_CONV);
        }
        if (db.conversations.length > MAX_CONVERSATIONS) {
          db.conversations = db.conversations.slice(0, MAX_CONVERSATIONS);
        }
        initialClaudeSessionId = conv.claudeSessionId;
        await saveDB(db);
      });

      let skillContext = '';
      if (skillName) {
        const skillPath = resolveSkillPath(skillName);
        if (skillPath) {
          try { skillContext = await readSkillFile(skillPath); }
          catch { /* skill not found / symlink rejected, ignore */ }
        }
      }

      const composed = composeAppendSystemPrompt(clientAppendOpt, appendSystemPrompt);
      const systemPromptParts = [
        skillContext ? `# Active Skill: ${skillName}\n\n${skillContext}` : '',
        composed ?? '',
      ].filter(Boolean);

      const tools = new Set();
      let streamed = '';
      const t0 = Date.now();

      // Compensating rollback: if the driver throws (abort, upstream
      // exit, IO error), remove the trailing user message we just
      // persisted in Phase 1 so the conversation transcript doesn't
      // accumulate orphan user turns with no assistant reply.
      async function rollbackUserMessage() {
        await withFileLock(dbPath, async () => {
          const db = await loadDB();
          const c = db.conversations.find((x) => x.id === conv.id);
          if (!c) return;
          if (c.messages.at(-1)?.role === 'user' && c.messages.at(-1)?.content === message) {
            c.messages.pop();
            // Drop empty conversation entirely if this was the first turn.
            if (c.messages.length === 0) {
              db.conversations = db.conversations.filter((x) => x.id !== c.id);
            }
            c.updatedAt = new Date().toISOString();
            await saveDB(db);
          }
        }).catch((e) => {
          // Don't shadow the original driver error (rethrown below) but
          // surface rollback failure so a misaligned transcript isn't
          // invisible — otherwise the user sees an orphan user turn
          // with no assistant reply and no log explaining why.
          process.stderr.write(`[ocp/chat] rollback failed for ${dbPath}: ${e?.message || e}\n`);
        });
      }

      let result;
      try {
        result = await driver.runOneShot({
        prompt: message,
        dangerouslySkipPermissions,
        abortSignal: signal,
        maxResponseMs,
        appendSystemPrompt: systemPromptParts.join('\n\n') || undefined,
        ...(initialClaudeSessionId ? { resume: initialClaudeSessionId } : {}),
        onEvent(ev) {
          if (ev.type === 'assistant-text' && ev.text) {
            const tn = extractToolName(ev.text);
            if (tn) tools.add(tn);
            // Cap the fallback buffer — only used when the JSONL session
            // file isn't readable. A runaway upstream that emits MB of
            // assistant text shouldn't pin GB of heap on the off-chance
            // we need the buffer. Keep the tail so the last sentinel /
            // useful content survives.
            streamed += ev.text;
            if (streamed.length > 524_288) streamed = streamed.slice(-262_144);
          }
          if (typeof onEvent === 'function') {
            try { onEvent(ev); }
            catch (e) { /* swallow consumer errors so the request continues */ }
          }
        },
        });
      } catch (e) {
        await rollbackUserMessage();
        // Don't re-wrap chat-domain errors / AbortError (already coded);
        // wrap raw driver/upstream failures so callers can switch on a
        // single error code surface without missing the upstream's
        // libuv / domain-less codes.
        // `startsWith('ERR_CHAT_')` matches all chat-domain codes
        // including BUSY. REENTRANT lives outside that namespace so it
        // gets an explicit check.
        if (
          (e?.code && (e.code.startsWith('ERR_CHAT_') || e.code === 'ERR_REENTRANT_SEND'))
          || e?.name === 'AbortError'
        ) {
          throw e;
        }
        // Sanitize the upstream message — it may carry C0/C1/DEL bytes
        // (ANSI escape sequences, BEL, raw cursor moves) that would
        // corrupt terminals or log parsers when the wrapped error is
        // printed downstream. The original `e` rides on `cause` so
        // debuggers still see the raw bytes.
        const rawMsg = e?.message ?? String(e);
        const safeMsg = String(rawMsg).replace(/[\x00-\x1f\x7f\x80-\x9f]/g, '?').slice(0, 512);
        const wrapped = new Error(`chat.send: driver failure (${e?.code || e?.name || 'unknown'}): ${safeMsg}`, { cause: e });
        wrapped.code = 'ERR_CHAT_DRIVER_FAILED';
        if (e?.completionReason) wrapped.completionReason = e.completionReason;
        throw wrapped;
      }

      const elapsed = Date.now() - t0;

      // Prefer the JSONL session file's clean markdown over the
      // PTY-extracted text — the JSONL has real hyperlinks and no TUI
      // artifacts. Fall back to the buffer-scanned text if the JSONL is
      // unavailable (e.g. session id never landed).
      const sessionRead = await readSessionText(result.sessionId, t0);
      const finalText = sessionRead?.text
        || cleanResponse(result.text || streamed)
        || '';
      const usage = sessionRead?.usage ?? null;
      for (const t of sessionRead?.tools ?? []) tools.add(t);
      if ((usage?.server_tool_use?.web_search_requests ?? 0) > 0) tools.add('web_search');
      if ((usage?.server_tool_use?.web_fetch_requests ?? 0) > 0) tools.add('web_fetch');

      const inputTokens = totalInputTokens(usage);
      const outputTokens = usage?.output_tokens ?? null;
      const costUsd = computeCost(usage, pricing);

      // Phase 2 (locked): re-load the DB so any concurrent send() that
      // appended in the meantime is preserved, find our conversation
      // by id, append the assistant message, persist.
      if (!result.isError && finalText) {
        await withFileLock(dbPath, async () => {
          const db = await loadDB();
          const c = db.conversations.find((x) => x.id === conv.id);
          if (!c) return; // conversation was deleted while we were waiting
          c.claudeSessionId = result.sessionId ?? c.claudeSessionId;
          c.messages.push({
            role: 'assistant',
            content: finalText,
            timestamp: new Date().toISOString(),
          });
          c.updatedAt = new Date().toISOString();
          await saveDB(db);
        });
      }

      return {
        conversationId: conv.id,
        text: finalText,
        isNew,
        isError: result.isError,
        completionReason: result.completionReason,
        sessionId: result.sessionId,
        meta: { elapsedMs: elapsed, inputTokens, outputTokens, costUsd, tools: [...tools] },
      };
      })); // end per-conversation lock + AsyncLocalStorage scope
    },

    /** Close the underlying driver (and pooled PTYs) if owned by this client. */
    async close() {
      if (ownsDriver) await driver.close();
    },
  };
}

/**
 * Read the last assistant message + usage + tool list from the upstream
 * `~/.claude/projects/<cwd>/<uuid>.jsonl` session file. The JSONL has
 * clean markdown (no TUI artifacts) and accurate token counts.
 *
 * Resumed sessions may create a new JSONL with a different UUID, so we
 * first try the named session file and then fall back to the most
 * recently modified file written during or after `t0`.
 *
 * @param {string|null} sessionId
 * @param {number} [t0=0]  Lower bound on message timestamp (ms).
 * @param {string} [cwd]   Directory used to derive the project dir key.
 * @returns {Promise<{ text: string, usage: object|null, tools: string[] } | null>}
 */
export async function readSessionText(sessionId, t0 = 0, cwd = process.cwd()) {
  // Claude encodes the project cwd into a single token used as the
  // directory name under ~/.claude/projects/. The mapping replaces BOTH
  // path separators (`/`) and underscores (`_`) with a literal `-`, so
  // `/Users/alice/gen_keypair` lands in `-Users-alice-gen-keypair/`. The
  // earlier "slash-only" version missed any cwd containing `_` and
  // silently fell back to the raw PTY text.
  const cwdKey = path.resolve(cwd).replace(/[/_]/g, '-');
  const projectDir = path.join(os.homedir(), '.claude', 'projects', cwdKey);

  async function extractFromFile(filePath, minTimestampMs) {
    // Long-lived conversations grow JSONLs to tens / hundreds of MB.
    // A full readFile per send() balloons heap; tail-read past the
    // size cap and parse only what we can fit.
    const MAX_JSONL_BYTES = envPositiveInt('OCP_MAX_JSONL_BYTES', 8 * 1024 * 1024);
    let raw;
    try {
      const st = await stat(filePath);
      if (st.size <= MAX_JSONL_BYTES) {
        raw = await readFile(filePath, 'utf8');
      } else {
        // Open + read the last MAX_JSONL_BYTES; drop the first
        // (almost certainly partial) line so JSON.parse doesn't choke.
        const { open } = await import('node:fs/promises');
        const fh = await open(filePath, 'r');
        try {
          const buf = Buffer.alloc(MAX_JSONL_BYTES);
          const start = Math.max(0, st.size - MAX_JSONL_BYTES);
          await fh.read(buf, 0, MAX_JSONL_BYTES, start);
          raw = buf.toString('utf8');
          const nl = raw.indexOf('\n');
          if (nl >= 0) raw = raw.slice(nl + 1);
        } finally { await fh.close(); }
      }
    } catch { return null; }
    const lines = raw.split('\n').filter((l) => l.trim());

    const tools = new Set();
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev.message?.role === 'assistant' && Array.isArray(ev.message.content)) {
          for (const block of ev.message.content) {
            // Sanitise early — `block.name` is upstream-controlled JSON
            // and could contain terminal-control sequences that would
            // execute when echoed to stderr / SSE downstream.
            if (block.type === 'tool_use' && block.name) {
              const safe = stripTerminalControl(block.name);
              if (safe) tools.add(safe);
            }
          }
        }
      } catch { /* skip non-JSON line */ }
    }

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev.message?.role !== 'assistant') continue;
        if (minTimestampMs > 0 && ev.timestamp
          && new Date(ev.timestamp).getTime() < minTimestampMs) continue;
        const textBlock = ev.message.content?.find?.((c) => c.type === 'text');
        if (textBlock?.text) {
          return {
            text: textBlock.text.replace(SENTINEL_REGEX, '').trim(),
            usage: ev.message.usage ?? null,
            tools: [...tools],
          };
        }
      } catch { /* skip */ }
    }
    return null;
  }

  if (sessionId) {
    const r = await extractFromFile(path.join(projectDir, `${sessionId}.jsonl`), t0);
    if (r) return r;
  }

  let files;
  try { files = (await readdir(projectDir)).filter((f) => f.endsWith('.jsonl')); }
  catch { return null; }
  // A long-lived project accumulates one JSONL per session. We need to
  // pick the most-recently-modified, but dirent return order is not
  // reliably creation-ordered on XFS, hashed APFS variants, NFS, or
  // SMB — so we can't just slice the tail and assume freshness. Stat-
  // and-sort by mtime instead.
  //
  // EMFILE guard: macOS default `ulimit -n` is 256, so a single
  // unbounded `Promise.all(stat)` over 2k files can saturate FDs and
  // start failing concurrent fs ops elsewhere in the process. We cap
  // the dirent set AND batch the stats so peak concurrency stays well
  // below typical limits.
  // 512 dirents covers any realistic per-project session count
  // (one JSONL per session resume) while keeping the worst-case stat
  // latency bounded (~512/32 batches × libuv-pool=4 stat budget).
  const MAX_PROJECT_FILES = 512;
  const STAT_BATCH = 32;
  if (files.length > MAX_PROJECT_FILES) files = files.slice(0, MAX_PROJECT_FILES);
  const stats = [];
  for (let i = 0; i < files.length; i += STAT_BATCH) {
    const chunk = files.slice(i, i + STAT_BATCH);
    const batch = await Promise.all(chunk.map(async (f) => {
      try { return { f, mtime: (await stat(path.join(projectDir, f))).mtimeMs }; }
      catch { return null; }
    }));
    for (const c of batch) if (c) stats.push(c);
  }
  const recent = stats
    .filter((c) => c.mtime >= t0)
    .sort((a, b) => b.mtime - a.mtime);
  for (const { f } of recent.slice(0, 5)) {
    const r = await extractFromFile(path.join(projectDir, f), t0);
    if (r) return r;
  }
  return null;
}

/**
 * Strip TUI chrome (prompt chars, box borders, status bars, mode lines)
 * from the PTY-stripped buffer text. Use as a fallback when the JSONL
 * session file is unavailable.
 *
 * @param {string} text
 * @returns {string}
 */
export function cleanResponse(text) {
  return String(text ?? '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((line) => {
      const t = line.trim();
      if (/^[❯›❮‹]\s*$/.test(t)) return false;
      if (/^─{5,}/.test(t)) return false;
      if (/^\[.*\]\s*[│|]/.test(t)) return false;
      if (/^Context\s/.test(t)) return false;
      if (/^⏵/.test(t)) return false;
      if (/^◉\s/.test(t)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(SENTINEL_REGEX, '')
    .trim();
}
