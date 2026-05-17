// Per-cwd session log under `<cwd>/.ocp/<sessionId>/`.
//
// Each turn writes four files:
//   - prompt.txt   the user prompt verbatim
//   - response.md  the assistant's clean markdown reply
//   - meta.json    timestamps, tokens, cost, tools, completion reason
//   - events.jsonl one event per line (omitted when no events present)
//
// Also appends one line to `<cwd>/.ocp/sessions.jsonl` for chronological
// listing (sessionId, ts, summary).
//
// Failure mode: best-effort. Logging errors NEVER propagate to the
// chat result — a cwd that's read-only just means no log, not a failed
// request. We DO emit a one-shot warning so silent failure isn't
// totally invisible.
//
// The directory is auto-created with mode 0o700 and refused if it
// already exists with looser perms or different owner — same trust
// stance as the lock dir.

import path from 'node:path';
import { mkdir, lstat, chmod, writeFile, appendFile } from 'node:fs/promises';

const SESSIONS_DIR_NAME = '.ocp';

let dirVerifiedFor = new Map(); // cwd → boolean
let dirWarned = false;

function emitOnce(msg) {
  if (dirWarned) return;
  dirWarned = true;
  try { process.emitWarning(msg, { type: 'OcpSessionLogUnsafe' }); } catch {}
}

async function ensureSessionsDir(cwd) {
  const dir = path.join(cwd, SESSIONS_DIR_NAME);
  if (dirVerifiedFor.get(cwd)) return dir;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const st = await lstat(dir);
    if (st.isSymbolicLink()) {
      emitOnce(`ocp: refusing to write session log — ${dir} is a symbolic link`);
      return null;
    }
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      emitOnce(`ocp: refusing to write session log — ${dir} owned by uid ${st.uid}`);
      return null;
    }
    if ((st.mode & 0o077) !== 0) {
      // Group/other-readable — try to tighten but don't fail if chmod
      // can't (we still own it, so the contents leak is bounded to the
      // owner's reads).
      await chmod(dir, 0o700).catch(() => {});
    }
    dirVerifiedFor.set(cwd, true);
    return dir;
  } catch (e) {
    if (e?.code !== 'EACCES' && e?.code !== 'EROFS') {
      emitOnce(`ocp: session log dir ${dir} unusable (${e?.code || e?.message})`);
    }
    return null;
  }
}

/**
 * Record a single turn under `<cwd>/.ocp/<sessionId>/`.
 *
 * @param {object} args
 * @param {string} args.cwd
 * @param {string|null} args.sessionId  claude sessionId (UUID); falls back to ts-suffix if null
 * @param {string} args.prompt          original user prompt
 * @param {string} args.response        assistant text (clean markdown)
 * @param {object} [args.meta]          {durationMs, inputTokens, outputTokens, costUsd, tools, completionReason, isError}
 * @param {Array<object>} [args.events] full event stream (writes events.jsonl when non-empty)
 */
export async function recordSession({ cwd, sessionId, prompt, response, meta, events }) {
  if (!cwd || typeof cwd !== 'string') return;
  const baseDir = await ensureSessionsDir(cwd);
  if (!baseDir) return;
  // Fall back to a synthetic id when claude didn't return one (e.g.
  // error before session-init). Use timestamp so the dir name is still
  // sortable, prefixed so it can't collide with a real UUID.
  const id = sessionId || `noid-${Date.now()}`;
  const turnDir = path.join(baseDir, id);
  try {
    await mkdir(turnDir, { recursive: true, mode: 0o700 });
    const ts = new Date().toISOString();
    const writes = [
      writeFile(path.join(turnDir, 'prompt.txt'), prompt ?? '', { mode: 0o600 }),
      writeFile(path.join(turnDir, 'response.md'), response ?? '', { mode: 0o600 }),
      writeFile(
        path.join(turnDir, 'meta.json'),
        JSON.stringify({ sessionId: sessionId ?? null, timestamp: ts, ...(meta ?? {}) }, null, 2),
        { mode: 0o600 },
      ),
    ];
    if (Array.isArray(events) && events.length > 0) {
      // Cap to avoid an unbounded write — events can balloon to MB on
      // long sessions. Keep the tail (most recent), the head usually
      // is just framing/prompt-box init noise.
      const MAX_EVENTS_LOG = 2000;
      const slice = events.length > MAX_EVENTS_LOG ? events.slice(-MAX_EVENTS_LOG) : events;
      writes.push(writeFile(
        path.join(turnDir, 'events.jsonl'),
        slice.map((e) => JSON.stringify(e)).join('\n') + '\n',
        { mode: 0o600 },
      ));
    }
    await Promise.all(writes);
    // Append an index line so a single `tail -f .ocp/sessions.jsonl`
    // gives a chronological feed of all turns in this project.
    const indexLine = JSON.stringify({
      ts,
      sessionId: sessionId ?? null,
      promptPreview: (prompt ?? '').slice(0, 80),
      isError: !!meta?.isError,
      durationMs: meta?.durationMs ?? null,
      tools: meta?.tools ?? [],
    }) + '\n';
    await appendFile(path.join(baseDir, 'sessions.jsonl'), indexLine, { mode: 0o600 }).catch(() => {});
  } catch (e) {
    emitOnce(`ocp: session log write failed for ${turnDir} (${e?.code || e?.message})`);
  }
}
