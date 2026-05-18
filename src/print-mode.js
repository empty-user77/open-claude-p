// Direct `claude --print` mode — opt-in alternative to the default PTY+TUI
// pipeline. The default driver spawns `claude` interactively and captures
// the rendered TUI output, which means markdown formatting characters
// (``` fences, ## headings, **bold**, etc.) are consumed during rendering
// and never reach the caller.
//
// Print mode bypasses the TUI entirely:
//   - spawns `claude --print "<prompt>" [forwarded args]` via child_process
//   - claude detects non-TTY stdout and emits raw output
//   - markdown formatting is preserved verbatim
//
// Trade-offs (vs. the default PTY path):
//   + raw markdown reaches the caller (the original motivation)
//   + simpler — no PTY, no ANSI strip, no TUI frame parser
//   - claude's native schemas pass through unchanged (json / stream-json
//     no longer match ocp's wrapped schema; document this for callers)
//   - tool-approval prompts and other interactive flows are not available
//   - print-mode MCP calls have a known upstream hang; callers using
//     MCP servers should stay on the default path

import { spawn } from 'node:child_process';
import { readdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { OPTION_SPEC } from './options/spec.js';
import { sanitizePassThroughArgv, redactArgvForLog } from './index.js';

/**
 * Translate a runOneShot-style request into a `claude --print` argv list.
 * Flags come first, then a `--` end-of-options separator, then the prompt as
 * a positional argument so the upstream parser cannot mistake a prompt
 * starting with `-` for a flag.
 *
 * @param {object} req
 * @returns {string[]}
 */
export function buildPrintModeArgs(req) {
  const args = ['--print'];
  for (const spec of OPTION_SPEC) {
    if (spec.forward?.type !== 'argv') continue;
    const value = req[fieldNameOf(spec)];
    if (value === undefined || value === null || value === false) continue;
    if (spec.kind === 'boolean') {
      if (value === true) args.push(spec.forward.flag);
    } else if (spec.kind === 'array') {
      if (Array.isArray(value) && value.length > 0) {
        args.push(spec.forward.flag, ...value.map(String));
      }
    } else {
      args.push(spec.forward.flag, String(value));
    }
  }
  if (req.outputFormat) args.push('--output-format', String(req.outputFormat));
  if (Array.isArray(req.passThroughArgv) && req.passThroughArgv.length > 0) {
    const { sanitized } = sanitizePassThroughArgv(req.passThroughArgv);
    args.push(...sanitized);
  }
  args.push('--', req.prompt);
  return args;
}

function fieldNameOf(spec) {
  return spec.name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Run a single prompt against `claude --print` and stream stdout to the
 * provided sink (typically process.stdout).
 *
 * @param {object} opts
 * @param {string} opts.bin                Binary to spawn (default 'claude').
 * @param {string} opts.prompt
 * @param {object} opts.req                Full request object (forwarded fields used).
 * @param {{ write: (s: string) => void }} [opts.sink]   stdout sink (default: capture-only).
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {AbortSignal} [opts.abortSignal]
 * @param {number} [opts.timeoutMs]
 * @param {(msg: string) => void} [opts.logDebug]
 * @returns {Promise<{ text: string, sessionId: string|null, isError: boolean, exitCode: number|null, durationMs: number, completionReason: string }>}
 */
export async function runPrintMode(opts) {
  const startMs = Date.now();
  const args = buildPrintModeArgs(opts.req);
  if (opts.logDebug) opts.logDebug(`print-mode spawn ${opts.bin} ${redactArgvForLog(args).join(' ')}`);

  const sessionFilesBefore = await listSessionFiles(opts.cwd);

  return new Promise((resolve) => {
    const child = spawn(opts.bin, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let textBuf = '';
    let stderrBuf = '';
    let timedOut = false;
    let aborted = false;

    const timer = opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, opts.timeoutMs)
      : null;

    let onAbort;
    if (opts.abortSignal) {
      onAbort = () => { aborted = true; child.kill('SIGTERM'); };
      opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      textBuf += s;
      if (opts.sink) opts.sink.write(s);
    });
    child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf8'); });

    child.on('close', async (code) => {
      if (timer) clearTimeout(timer);
      if (onAbort && opts.abortSignal) opts.abortSignal.removeEventListener('abort', onAbort);

      let sessionId = extractSessionIdFromOutput(textBuf, opts.req.outputFormat);
      if (!sessionId) {
        sessionId = await scanForNewSessionFile(opts.cwd, sessionFilesBefore);
      }

      const completionReason =
        aborted ? 'cancelled' :
        timedOut ? 'timeout' :
        code === 0 ? 'sentinel' :
        'upstream-exited';

      if (opts.logDebug && stderrBuf) opts.logDebug(`print-mode stderr: ${stderrBuf.slice(-400)}`);

      resolve({
        text: textBuf,
        sessionId,
        isError: code !== 0,
        exitCode: code,
        durationMs: Date.now() - startMs,
        completionReason,
      });
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (opts.logDebug) opts.logDebug(`print-mode spawn error: ${err.message}`);
      resolve({
        text: textBuf,
        sessionId: null,
        isError: true,
        exitCode: null,
        durationMs: Date.now() - startMs,
        completionReason: 'spawn-error',
      });
    });
  });
}

// Pull session_id from claude --output-format=json or stream-json output.
function extractSessionIdFromOutput(text, outputFormat) {
  if (!text) return null;
  if (outputFormat === 'json') {
    try {
      const obj = JSON.parse(text.trim());
      return obj.session_id ?? null;
    } catch { return null; }
  }
  if (outputFormat === 'stream-json') {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.session_id) return obj.session_id;
      } catch { /* ignore non-JSON lines */ }
    }
  }
  return null;
}

async function listSessionFiles(cwd) {
  // Upstream encodes BOTH path separators and underscores as `-`, so
  // `/Users/alice/gen_keypair` lands in `-Users-alice-gen-keypair/`.
  // A `/`-only replacement misses any cwd containing `_` and silently
  // looks in the wrong directory. Additionally, realpath() to follow
  // macOS `/var` -> `/private/var` so a cwd under `/tmp` resolves to
  // the same path `claude` writes to (`-private-tmp-<…>`), not the
  // mismatched `-tmp-<…>`.
  const abs = path.resolve(cwd ?? process.cwd());
  let absCwd;
  try { absCwd = await realpath(abs); } catch { absCwd = abs; }
  const encoded = absCwd.replace(/[/_]/g, '-');
  const dir = path.join(os.homedir(), '.claude', 'projects', encoded);
  const out = new Map();
  let entries;
  try { entries = await readdir(dir); } catch { return out; }
  for (const name of entries) {
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.jsonl$/.test(name)) continue;
    try {
      const st = await stat(path.join(dir, name));
      out.set(name, st.mtimeMs);
    } catch { /* ignore */ }
  }
  return out;
}

async function scanForNewSessionFile(cwd, before) {
  const after = await listSessionFiles(cwd);
  let best = null;
  let bestMtime = 0;
  for (const [name, mtime] of after) {
    const prev = before.get(name);
    if (prev === undefined || mtime > prev) {
      if (mtime > bestMtime) { bestMtime = mtime; best = name; }
    }
  }
  return best ? best.replace(/\.jsonl$/, '') : null;
}
