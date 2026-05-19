// open-claude-p — public library entry.
//
// The library and the CLI binary share the same core. `createDriver()`
// returns a Driver that can be used for one-shot prompt-response cycles
// against the upstream `claude` CLI driven through `node-pty`.
//
// Implements the single-request path (`runOneShot`) with the
// `text` output strategy, plus pooling, sessions, and additional
// output formats.

import { randomBytes } from 'node:crypto';
import { readdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { PtySession } from './pty/session.js';
import { PtyPool } from './pty/pool.js';
import { ansiStripParser } from './parsers/ansi-strip.js';
import { tuiFrameParser, PATTERNS as TUI_PATTERNS } from './parsers/tui-frame.js';
import { createSentinelParser } from './parsers/sentinel.js';
import { createPipeline } from './parsers/pipeline.js';
import { CompletionDetector } from './completion/detector.js';
import { OPTION_SPEC } from './options/spec.js';
import { runPrintMode } from './print-mode.js';

const DEFAULT_WARMUP_MS = 2500;
const DEFAULT_IDLE_MS = 1500;
const DEFAULT_PRE_IDLE_MS = 8000;
// 24 h. Set high by design: a hard cap that's too low aborts legitimate
// long-running tool sequences (multi-step WebSearch / WebFetch / Bash
// rounds), and the in-flight idle/pre-idle silence detectors already
// stop "actually stuck" runs much earlier. Operators who want a tighter
// ceiling set OCP_MAX_RESPONSE_MS explicitly.
const DEFAULT_MAX_RESPONSE_MS = 24 * 60 * 60 * 1000;

// Flags that allow reading arbitrary files, loading untrusted config, granting
// extra filesystem scope, or bypassing permission gates on the upstream claude
// CLI. We refuse to forward these from `passThroughArgv` to prevent argv
// injection through wrappers that pipe user input verbatim. Set
// OCP_ALLOW_UNSAFE_ARGV=1 to opt out (e.g. trusted controlled environments).
const UNSAFE_PASSTHROUGH_FLAGS = new Set([
  // Read arbitrary files into prompt context
  '--system-prompt-file',
  '--append-system-prompt-file',
  // Load untrusted configuration
  '--mcp-config',
  '--strict-mcp-config',
  '--settings',
  '--setting-sources',
  // Grant extra filesystem scope
  '--add-dir',
  '--debug-file',
  // Load untrusted agents / plugins
  '--agents',
  '--plugin-dir',
  // Bypass permission gates
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--permission-mode',
  '--permission-prompt-tool',
  // Materialise files at attacker-chosen paths
  '--file',
  // Broaden attach surface to a discoverable IDE
  '--ide',
]);

// Flags whose VALUE may contain secrets / file paths the user would not
// want to paste into a bug report. We redact the value when debug-logging
// the spawn argv. The flag name itself is retained for diagnostics.
const SENSITIVE_FLAG_VALUE = new Set([
  '--system-prompt',
  '--append-system-prompt',
  '--system-prompt-file',
  '--append-system-prompt-file',
  '--mcp-config',
  '--settings',
  '--resume',
  '--session-id',
  '--debug-file',
]);

export function redactArgvForLog(argv) {
  if (!Array.isArray(argv)) return [];
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (typeof tok !== 'string') { out.push(tok); continue; }
    const eq = tok.indexOf('=');
    const flag = eq >= 0 ? tok.slice(0, eq) : tok;
    if (SENSITIVE_FLAG_VALUE.has(flag)) {
      if (eq >= 0) {
        out.push(`${flag}=<redacted len=${tok.length - eq - 1}>`);
      } else {
        out.push(flag);
        if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
          out.push(`<redacted len=${argv[i + 1].length}>`);
          i++;
        }
      }
      continue;
    }
    out.push(tok);
  }
  return out;
}

export function sanitizePassThroughArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return { sanitized: [], rejected: [] };
  if (process.env.OCP_ALLOW_UNSAFE_ARGV === '1') return { sanitized: argv.slice(), rejected: [] };
  const sanitized = [];
  const rejected = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (typeof tok !== 'string') { sanitized.push(tok); continue; }
    const eq = tok.indexOf('=');
    const flag = eq >= 0 ? tok.slice(0, eq) : tok;
    if (UNSAFE_PASSTHROUGH_FLAGS.has(flag)) {
      rejected.push(tok);
      if (eq < 0 && i + 1 < argv.length && !argv[i + 1].startsWith('-')) i++;
      continue;
    }
    sanitized.push(tok);
  }
  if (rejected.length > 0) {
    process.stderr.write(
      `[ocp] dropped unsafe pass-through flag(s): ${rejected.join(' ')} ` +
      `(set OCP_ALLOW_UNSAFE_ARGV=1 to override)\n`,
    );
  }
  return { sanitized, rejected };
}

/**
 * Construct a driver. The driver is the entry point for any consumer of
 * the library API and is shared between calls. By default, every
 * `runOneShot()` spawns a fresh PTY session; pass `poolSize: N` to opt
 * into warm-session reuse.
 */
export function createDriver(driverOpts = {}) {
  return new Driver(driverOpts);
}

class Driver {
  constructor(opts = {}) {
    // All numeric options pass through `finiteNonNeg` so a caller-side
    // typo (`maxEvents: 'lots'`, `firstResponseMs: NaN`, `poolSize: -1`)
    // falls back to the env / hard-coded default instead of corrupting
    // downstream math (e.g. `events.splice(0, len - (MAX>>1))` becomes
    // unbounded growth or zero-retention with NaN).
    this.opts = {
      claudeBin: opts.claudeBin ?? process.env.OCP_CLAUDE_BIN ?? 'claude',
      warmupMs: finiteNonNeg(opts.warmupMs, numberFromEnv('OCP_WARMUP_MS', DEFAULT_WARMUP_MS)),
      reuseWarmupMs: finiteNonNeg(opts.reuseWarmupMs, numberFromEnv('OCP_REUSE_WARMUP_MS', 200)),
      idleMs: finiteNonNeg(opts.idleMs, numberFromEnv('OCP_IDLE_MS', DEFAULT_IDLE_MS)),
      preIdleMs: finiteNonNeg(opts.preIdleMs, numberFromEnv('OCP_PRE_IDLE_MS', DEFAULT_PRE_IDLE_MS)),
      maxResponseMs: finiteNonNeg(opts.maxResponseMs, numberFromEnv('OCP_MAX_RESPONSE_MS', DEFAULT_MAX_RESPONSE_MS)),
      cwd: opts.cwd,
      env: (opts.env && typeof opts.env === 'object') ? opts.env : {},
      debug: !!opts.debug,
      poolSize: finiteNonNeg(opts.poolSize, numberFromEnv('OCP_POOL_SIZE', 0)),
      poolMaxAgeMs: finiteNonNeg(opts.poolMaxAgeMs, numberFromEnv('OCP_POOL_MAX_AGE_MS', 600_000)),
      maxBufferBytes: finiteNonNeg(opts.maxBufferBytes, 16 * 1024 * 1024),
      maxEvents: finiteNonNeg(opts.maxEvents, 10_000),
      firstResponseMs: finiteNonNeg(opts.firstResponseMs, numberFromEnv('OCP_FIRST_RESPONSE_MS', 120_000)),
      trustSettleMs: finiteNonNeg(opts.trustSettleMs, numberFromEnv('OCP_TRUST_SETTLE_MS', 2_500)),
      // 30 s default: in environments with many MCP servers, plugins,
      // or hooks the first prompt-box render can take 8–25 s. The pre-
      // 1.1 default of 6 s caused the driver to give up on
      // prompt-box-shown and write the prompt anyway, *before* claude
      // had even shown the trust dialog — the prompt's trailing CR
      // then confirmed whatever option was highlighted on the dialog
      // and the user message was dropped. 30 s leaves room for slow
      // startups while still bounding total spawn latency.
      promptBoxWaitMs: finiteNonNeg(opts.promptBoxWaitMs, numberFromEnv('OCP_PROMPT_BOX_WAIT_MS', 30_000)),
      initialSessionId: opts.initialSessionId ?? null,
      printMode:
        opts.printMode === true ||
        process.env.OCP_PRINT_MODE === '1' ||
        process.env.OCP_PRINT_MODE === 'true',
    };
    /** Lazily-constructed pool — only when poolSize > 0. */
    this._pool = null;
  }

  /** @returns {PtyPool|null} */
  _getPool() {
    if (this.opts.poolSize <= 0) return null;
    if (!this._pool) {
      this._pool = new PtyPool({
        maxIdlePerKey: this.opts.poolSize,
        maxAgeMs: this.opts.poolMaxAgeMs,
        initialSessionId: this.opts.initialSessionId,
      });
    }
    return this._pool;
  }

  /**
   * Single-prompt request. Spawns a fresh upstream `claude` process,
   * sends the user prompt plus a sentinel instruction, waits for
   * completion, and returns the extracted assistant text.
   *
   * @param {object} req
   * @param {string} req.prompt
   * @param {string} [req.cwd]
   * @param {string} [req.model]
   * @param {string} [req.systemPrompt]
   * @param {string[]} [req.allowedTools]
   * @param {string[]} [req.disallowedTools]
   * @param {boolean} [req.dangerouslySkipPermissions=true]
   *   Default ON in 1.1+. PTY automation cannot answer claude's
   *   interactive y/n permission prompt, so leaving it OFF makes
   *   the first tool call hang forever. Pass `false` explicitly to
   *   restore the prompts (and accept the hang).
   * @param {boolean} [req.debug]
   * @param {boolean} [req.verbose]
   * @param {string[]} [req.passThroughArgv]   extra argv to forward verbatim
   * @param {AbortSignal} [req.abortSignal]
   * @param {(event: object) => void} [req.onEvent]
   *   Optional live event callback. Receives parser events as they are
   *   emitted, before they are batched into the returned `events` array.
   *   Used by the stream-json output adapter to emit incremental output.
   * @returns {Promise<OneShotResult>}
   */
  async runOneShot(req) {
    if (!req?.prompt || typeof req.prompt !== 'string') {
      throw new Error('runOneShot: `prompt` (string) is required');
    }

    // Default ON across the driver in 1.1+: PTY automation has no
    // way to answer claude's interactive permission prompt, so a
    // request that doesn't explicitly set it would otherwise hang on
    // the first tool call. We mutate `req` in place because every
    // downstream branch (print-mode, daemon proxy, buildSpawnArgs)
    // reads the same field. `??` keeps an explicit `false` intact.
    req.dangerouslySkipPermissions = req.dangerouslySkipPermissions ?? true;

    // Print-mode short-circuit: spawn `claude --print` directly, bypass
    // the PTY+TUI pipeline. Caller opts in via req.printMode, driver-level
    // opts.printMode, or env OCP_PRINT_MODE=1.
    const printMode =
      req.printMode === true ||
      this.opts.printMode === true ||
      process.env.OCP_PRINT_MODE === '1' ||
      process.env.OCP_PRINT_MODE === 'true';
    if (printMode) {
      const cwd = req.cwd ?? this.opts.cwd;
      const env = { ...process.env, ...this.opts.env };
      const r = await runPrintMode({
        bin: this.opts.claudeBin,
        req,
        sink: req.printSink,
        cwd, env,
        abortSignal: req.abortSignal,
        timeoutMs: this.opts.maxResponseMs,
        logDebug: (m) => this._logDebug(m),
      });
      return {
        text: r.text,
        sessionId: r.sessionId,
        isError: r.isError,
        events: [],
        completionReason: r.completionReason,
        durationMs: r.durationMs,
        cost: { totalUsd: null, numTurns: null },
        diagnostics: { rawBytes: r.text.length, strippedBytes: r.text.length, mode: 'print' },
      };
    }

    const startTime = Date.now();
    const nonce = randomBytes(8).toString('hex');
    const sentinel = `⟦OCP_END:${nonce}⟧`;

    const spawnArgs = buildSpawnArgs(req);

    const sentinelParser = createSentinelParser(nonce);
    const pipeline = createPipeline([
      ansiStripParser,
      tuiFrameParser,
      sentinelParser,
    ]);
    const detector = new CompletionDetector({
      nonce,
      idleMs: this.opts.idleMs,
      preIdleMs: this.opts.preIdleMs,
      maxResponseMs: this.opts.maxResponseMs,
      maxTurns: req.maxTurns,
    });

    // Pool eligibility: explicit resume/continue bind to a specific past
    // session and are not poolable (they bypass the pool entirely).
    const cwd = req.cwd ?? this.opts.cwd;
    const env = { ...process.env, ...this.opts.env };
    const pool = this._getPool();
    const isResumeLike =
      (typeof req.resume === 'string' && req.resume !== '') ||
      req.continue === true ||
      (typeof req.sessionId === 'string' && req.sessionId !== '');
    const poolKey = pool && !isResumeLike
      ? PtyPool.canonicalKey({ cwd, spawnArgs })
      : null;

    let session;
    let warmReuse = false;

    if (poolKey) {
      const acquired = await pool.acquire({ key: poolKey });

      if (acquired.session) {
        // Warm hit — PTY already running, conversation context intact.
        session = acquired.session;
        warmReuse = true;
        this._logDebug(`pool hit (warm reuse) parked=${pool.size()}`);
      } else {
        // Miss — spawn a new PTY. Use resumeSessionId (if any) so the
        // new process continues the conversation from where we left off.
        const effectiveSpawnArgs = acquired.resumeSessionId
          ? buildSpawnArgs({ ...req, resume: acquired.resumeSessionId })
          : spawnArgs;
        if (acquired.resumeSessionId) {
          this._logDebug(`pool stale — respawn with --resume ${acquired.resumeSessionId}`);
        } else {
          this._logDebug(`pool empty — fresh spawn`);
        }
        session = new PtySession();
        await session.spawn({ bin: this.opts.claudeBin, args: effectiveSpawnArgs, cwd, env });
      }
    } else {
      session = new PtySession();
      this._logDebug(`spawn ${this.opts.claudeBin} ${redactArgvForLog(spawnArgs).join(' ')}`);
      await session.spawn({ bin: this.opts.claudeBin, args: spawnArgs, cwd, env });
    }

    let rawBytes = 0;
    let strippedBuffer = '';
    // Hard cap on per-request stripped output. A runaway upstream (tool loop,
    // verbose paste from a hostile MCP server) would otherwise grow this
    // string unbounded for the full maxResponseMs window — up to 24 h in
    // the sample. When we exceed the cap we keep only the tail so the
    // sentinel anchor and any session-id banner near the end are preserved.
    const MAX_STRIPPED_BYTES = this.opts.maxBufferBytes ?? 16 * 1024 * 1024;
    let strippedTruncated = false;
    /** @type {Array<object>} */
    const events = [];
    // Hard cap on retained events. A 24 h request emitting per-millisecond
    // spinner frames would otherwise grow `events` to gigabytes and
    // amplify daemon IPC `JSON.stringify` cost. We keep the tail so
    // completion-relevant events (sentinel, assistant-text, session-id)
    // near the end of the run survive.
    const MAX_EVENTS = this.opts.maxEvents ?? 10_000;
    let eventsTruncated = false;
    let capturedSessionId = null;
    // Snapshot the pre-existing session-id files in the project dir so the
    // filesystem fallback below only accepts NEW files (created during
    // THIS request). Without this, a timed-out request would pick the
    // most-recently-modified neighbour file — possibly from a different
    // session entirely — leading to chained `--resume` calls landing in
    // the wrong conversation.
    const sessionFilesBeforeSpawn = await listSessionFiles(cwd);

    const dataHandler = (chunk) => {
      rawBytes += Buffer.byteLength(chunk);
      // Any byte arriving from the PTY counts as activity — this prevents
      // the idle fallback from tripping while the model is streaming text
      // between region-entered and sentinel events.
      detector.markActivity();
      const r = pipeline.feed(chunk);
      strippedBuffer += r.text;
      if (strippedBuffer.length > MAX_STRIPPED_BYTES) {
        // Keep the last quarter so sentinel matching at the tail still works.
        strippedBuffer = strippedBuffer.slice(-(MAX_STRIPPED_BYTES >> 2));
        if (!strippedTruncated) {
          strippedTruncated = true;
          this._logDebug(`stripped buffer truncated at ${MAX_STRIPPED_BYTES} bytes`);
        }
      }
      for (const ev of r.events) {
        events.push(ev);
        if (events.length > MAX_EVENTS) {
          events.splice(0, events.length - (MAX_EVENTS >> 1));
          if (!eventsTruncated) {
            eventsTruncated = true;
            this._logDebug(`events array truncated at ${MAX_EVENTS}`);
          }
        }
        if (ev.type === 'session-id' && ev.id) capturedSessionId = ev.id;
        // Any sign that the model started producing output cancels the
        // first-response watchdog (set up below). Spinner and region
        // events both count — they prove the upstream is past whatever
        // dialog or initialisation may have been blocking input.
        if (ev.type === 'assistant-region-entered'
         || ev.type === 'assistant-text'
         || ev.type === 'spinner') {
          assistantActivitySeen = true;
        }
        if (ev.type === 'prompt-box-shown' && !promptBoxReady) {
          promptBoxReady = true;
          promptBoxResolve();
        }
        detector.onEvent(ev);
        if (typeof req.onEvent === 'function') {
          try { req.onEvent(ev); } catch (e) { this._logDebug(`onEvent threw: ${e.message}`); }
        }
      }
    };
    let assistantActivitySeen = false;
    let promptBoxReady = false;
    let promptBoxResolve;
    const promptBoxReadyPromise = new Promise((r) => { promptBoxResolve = r; });
    session.on('data', dataHandler);

    // If the upstream process exits before we've reached a completion
    // decision, treat it as an error and short-circuit the detector. This
    // typically happens when a forwarded flag was rejected by `claude`.
    const exitHandler = (info) => {
      this._logDebug(`session exited code=${info?.exitCode} signal=${info?.signal}`);
      detector.cancel('upstream-exited');
    };
    session.once('exit', exitHandler);

    let detachAbort = () => {};
    if (req.abortSignal) {
      const onAbort = () => detector.cancel();
      req.abortSignal.addEventListener('abort', onAbort, { once: true });
      detachAbort = () => req.abortSignal.removeEventListener('abort', onAbort);
    }

    // Interactive-dialog watcher. The upstream claude TUI can ask
    // questions that block prompt input — most commonly the "Quick safety
    // check: Is this a project you trust?" folder-trust dialog when the
    // cwd has never been confirmed.
    //
    // Auto-accept is the DEFAULT in 1.1+. Rationale: `ocp` is a non-
    // interactive PTY automation surface. A dialog that needs a human
    // y/n cannot be answered by a calling app — leaving it un-accepted
    // means every call into a fresh cwd aborts on `trust-required` and
    // the only available action is "go run `claude` manually once".
    // For a tool whose entire job is to make claude callable from
    // scripts and apps, that is the wrong default.
    //
    // Opt out with `OCP_NO_AUTO_ACCEPT_TRUST=1` (env, takes precedence)
    // or `req.autoAcceptFolderTrust === false` (per-request, explicit).
    // When opted out, we abort fast with `trust-required` so the
    // caller gets an actionable error instead of a silent timeout.
    const autoAcceptOptOut = process.env.OCP_NO_AUTO_ACCEPT_TRUST === '1'
                          || process.env.OCP_NO_AUTO_ACCEPT_TRUST === 'true'
                          || req.autoAcceptFolderTrust === false;
    const autoAcceptTrust = !autoAcceptOptOut;
    // The trust dialog text is rendered with cursor-positioning
    // escapes between words rather than real space bytes. After our
    // ANSI strip the buffer reads `Quicksafetycheck...` with the
    // spaces gone, so `/Quick safety check/i` no longer matches.
    // Allow zero-or-more whitespace between every word and accept
    // the seq with or without spaces.
    const TRUST_PATTERNS = [
      /Quick\s*safety\s*check/i,
      /Is\s*this\s*a\s*project\s*you\s*(?:created|trust)/i,
      /trust\s*this\s*folder/i,
    ];
    const TRUST_SETTLE_MS = this.opts.trustSettleMs
                         ?? numberFromEnv('OCP_TRUST_SETTLE_MS')
                         ?? 5000;
    let dialogState = 'none'; // 'none' | 'trust-accepted' | 'trust-blocked' | 'unknown-blocked'
    let dialogScanBuf = '';

    const dialogWatchHandler = (chunk) => {
      if (dialogState !== 'none') return;
      // Strip ANSI escapes BEFORE pattern-matching. claude's TUI wraps
      // the dialog text in color codes mid-word ("\x1b[1mQ\x1b[muick
      // safety check..."), which prevents a simple `/Quick safety/`
      // regex from ever matching the raw byte stream. Result observed
      // in user testing: trust dialog renders in 1-2 s but our
      // detector never fires, the driver falls back to writing the
      // user's prompt after `OCP_PROMPT_BOX_WAIT_MS`, and the
      // trailing `\r` confirms whichever dialog option is highlighted
      // (silently dropping the user message). Stripping here keeps
      // the watcher decoupled from the main parser pipeline while
      // still seeing the plain text claude actually rendered.
      const raw = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      dialogScanBuf += raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
                          .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
                          .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      if (dialogScanBuf.length > 16384) dialogScanBuf = dialogScanBuf.slice(-8192);
      if (TRUST_PATTERNS.some((p) => p.test(dialogScanBuf))) {
        if (autoAcceptTrust) {
          dialogState = 'trust-accepted';
          this._logDebug('trust dialog detected — auto-accepting (OCP_AUTO_ACCEPT_TRUST=1)');
          // Slight delay so claude finishes rendering the dialog before
          // it samples our \r.
          setTimeout(() => { try { session.write('\r'); } catch {} }, 200);
        } else {
          dialogState = 'trust-blocked';
          this._logDebug('trust dialog detected — aborting (set OCP_AUTO_ACCEPT_TRUST=1 to auto-accept)');
          detector.cancel('trust-required');
        }
      }
    };
    session.on('data', dialogWatchHandler);

    // Warm reuse: PTY is already running and showing the prompt — just a
    // short settle delay. Fresh spawn: wait for the TUI to fully initialise
    // before sending the prompt (avoids race with the welcome render).
    await sleep(warmReuse ? this.opts.reuseWarmupMs : this.opts.warmupMs);

    // If a folder-trust dialog was auto-accepted during warm-up, give the
    // TUI extra time to transition to the main prompt box before we send
    // anything — otherwise our keystrokes land in a half-rendered UI and
    // get swallowed.
    if (dialogState === 'trust-accepted') {
      this._logDebug(`settling ${TRUST_SETTLE_MS}ms after trust accept`);
      await sleep(TRUST_SETTLE_MS);
    }

    // First-response watchdog. After we have written the prompt, the
    // upstream should produce at least a spinner or a `⏺` region marker
    // within a few seconds — those are the cheapest signals that the
    // model received the input and started working. If neither arrives
    // within firstResponseMs the upstream is almost certainly waiting on
    // an interactive prompt we don't recognise (folder-trust we missed,
    // tool-permission ask, MCP auth, login expiry, an unknown new
    // dialog). Fail fast with `interactive-required` instead of stalling
    // silently until `maxResponseMs` so the caller gets an actionable
    // error and the current PTY screen to read.
    const FIRST_RESPONSE_MS = this.opts.firstResponseMs
                           ?? numberFromEnv('OCP_FIRST_RESPONSE_MS')
                           ?? 20_000;
    let firstResponseTimer = null;

    if (session.state === 'dead') {
      // Upstream already exited during warm-up; detector has been cancelled.
    } else {
      // Don't fire blindly at fixed warmup. Wait for the parser to
      // emit `prompt-box-shown` (anchored to the `❯` chevron, so it
      // never fires on the welcome banner's border). In environments
      // with heavy hook / MCP / rule loading, the input box may take
      // 5-10 s after spawn to appear; the timeout below is the fallback
      // for the unusual case where the chevron never lands. Without
      // this wait, our prompt arrives during the welcome screen and
      // most of it gets swallowed (only the tail makes it into the box).
      const PROMPT_BOX_WAIT_MS = this.opts.promptBoxWaitMs
                              ?? numberFromEnv('OCP_PROMPT_BOX_WAIT_MS')
                              ?? 15_000;
      const PROMPT_BOX_SETTLE_MS = this.opts.promptBoxSettleMs
                                ?? numberFromEnv('OCP_PROMPT_BOX_SETTLE_MS')
                                ?? 400;
      let promptBoxTimeoutHit = false;
      await Promise.race([
        promptBoxReadyPromise,
        sleep(PROMPT_BOX_WAIT_MS).then(() => { promptBoxTimeoutHit = true; }),
      ]);
      // If the dialog watcher is mid-flow (trust just auto-accepted)
      // when our prompt-box wait times out, claude is still transitioning
      // from the dialog to the main UI — the chevron has not landed
      // because it doesn't exist yet. Give it the trust-settle window
      // plus another bounded wait for the real input box to appear.
      // Writing now would land the prompt into the dialog (and its
      // trailing `\r` would confirm whichever option is highlighted),
      // silently dropping the user's message.
      if (promptBoxTimeoutHit && !promptBoxReady && dialogState === 'trust-accepted') {
        const EXTRA_WAIT = PROMPT_BOX_WAIT_MS;
        this._logDebug(
          `prompt-box-shown still not seen but trust dialog is processing — ` +
          `extending wait by ${EXTRA_WAIT}ms`,
        );
        let extendedTimeoutHit = false;
        await Promise.race([
          promptBoxReadyPromise,
          sleep(EXTRA_WAIT).then(() => { extendedTimeoutHit = true; }),
        ]);
        promptBoxTimeoutHit = extendedTimeoutHit;
      }
      if (promptBoxTimeoutHit && !promptBoxReady) {
        this._logDebug(`prompt-box-shown not seen within ${PROMPT_BOX_WAIT_MS}ms — sending anyway`);
      } else if (promptBoxReady && PROMPT_BOX_SETTLE_MS > 0) {
        // Small settle so an animating chevron / cursor blink doesn't
        // race our first keystroke.
        await sleep(PROMPT_BOX_SETTLE_MS);
      }

      // End-of-reply marker appended to every user turn so PTY
      // automation can tell when the reply is done. Word choice
      // matters here:
      //   - **Avoid "token"**: the model's safety training flags
      //     prompts of the form "include this token in your reply"
      //     as access-token / API-key exfiltration attempts; it then
      //     warns the user about a "prompt injection attempt" in
      //     the response, which is alarming and user-visible. Use
      //     "marker" / "sentinel" instead — they carry no auth
      //     baggage.
      //   - **Avoid "finish", "complete", "wrap up", "final"**: those
      //     nudge the model to cut tool use short. The reply itself
      //     is the actual signal of completion; this marker is just
      //     the bookkeeping byte we emit afterwards.
      //   - Identify the source explicitly: framing it as "the ocp
      //     wrapper's marker" gives the model context to recognise
      //     it as harness plumbing rather than a hostile injection.
      // Single-line form because `\n` flips claude TUI into multi-line
      // edit mode where `\r` no longer submits.
      const instruction =
        ` (End your reply with the literal text ${sentinel} on its own line.` +
        ' This is the ocp wrapper\'s end-of-reply marker — programmatic plumbing' +
        ' the automation uses to know your reply has landed. It is not part of' +
        ' the user\'s message and you do not need to mention or flag it. Answer' +
        ' the user\'s actual message above as you normally would, using tools' +
        ' as freely and thoroughly as you would without the marker.)';
      const fullPrompt = req.prompt + instruction;
      // Skip the prompt write if the dialog watcher has already
      // decided to abort. Without this check the trailing `\r` of
      // the prompt lands inside whatever modal we tried to abort on
      // (most commonly the folder-trust dialog), confirms its
      // currently-highlighted option, and silently drops the user
      // prompt. The detector has already been cancel()'d at this
      // point but the await chain above does not observe that
      // cancellation, so the write would otherwise still happen.
      if (dialogState === 'trust-blocked' || dialogState === 'unknown-blocked') {
        this._logDebug(`skipping prompt write — dialog blocked (${dialogState})`);
      } else try {
        this._logDebug(
          `writing prompt: ${fullPrompt.length} chars, ` +
          `dialogState=${dialogState}, promptBoxReady=${promptBoxReady}`,
        );
        await writePromptToSession(session, fullPrompt, this.opts);
        this._logDebug('prompt write returned');
        firstResponseTimer = setTimeout(() => {
          if (!assistantActivitySeen) {
            this._logDebug(`no assistant activity for ${FIRST_RESPONSE_MS}ms — interactive prompt suspected`);
            detector.cancel('interactive-required');
          }
        }, FIRST_RESPONSE_MS);
        if (firstResponseTimer.unref) firstResponseTimer.unref();
      } catch (e) {
        this._logDebug(`write failed: ${e.message}`);
        detector.cancel('write-failed');
      }
    }

    const completion = await detector.done();
    if (firstResponseTimer) clearTimeout(firstResponseTimer);

    // Detach the request-scoped listeners so the session can be safely
    // reused by the next acquirer (when pooled) or cleanly killed
    // (when not). Without this, a recycled session would keep delivering
    // events into THIS request's buffers.
    session.off('data', dataHandler);
    session.off('data', dialogWatchHandler);
    session.off('exit', exitHandler);
    detachAbort();

    // A cancelled or dialog-blocked session may be sitting at a prompt
    // we never resolved. Returning it to the pool would let the next
    // request reuse a PTY whose UI state is dirty. Force the non-pooled
    // tear-down path in those cases.
    //
    // `timeout` and `write-failed` are also dirty — the PTY is stuck
    // mid-response (probably mid-tool-call or mid-render), and parking
    // it would make the very next pool acquire reuse a hung PTY and
    // see the same timeout. That was the root cause of the user-visible
    // "sometimes the second `ocp` call hangs forever" pattern when
    // running several `ocp` calls in parallel in the same cwd: one PTY
    // timed out, got parked dirty, and every subsequent acquire of
    // that pool slot inherited the hang.
    const dirty = completion.reason === 'cancelled'
               || completion.reason === 'trust-required'
               || completion.reason === 'interactive-required'
               || completion.reason === 'timeout'
               || completion.reason === 'write-failed';
    if (poolKey && session.state !== 'dead' && !dirty) {
      // Pooled path — park for reuse. Context is preserved (no /clear).
      await pool.release(session, poolKey, capturedSessionId);
    } else {
      // Non-pooled path — best-effort graceful exit so the upstream CLI
      // gets a chance to print its end-of-session banner. We try a single
      // Ctrl-D and wait briefly; if it does not exit we move on. The
      // session-id is captured via the filesystem fallback below either
      // way, so there is no need to block long here.
      if (session.state !== 'dead') {
        try { session.write('\x04'); } catch {}
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 400);
          session.once('exit', () => { clearTimeout(t); resolve(); });
        });
      }
      await session.kill();
    }

    // After the session is fully terminated (or released), do one last
    // scan of the accumulated stripped buffer for a session-id banner.
    if (!capturedSessionId) {
      const m = strippedBuffer.match(
        /claude\s+--resume\s+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/,
      );
      if (m) capturedSessionId = m[1];
    }

    // Filesystem fallback: the upstream CLI persists each session to
    // `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. If we never saw a
    // banner — common when the request was cut short and `claude` did not
    // print its exit hint — find the file whose mtime advanced during
    // THIS request and take its filename as the session id.
    if (!capturedSessionId) {
      try {
        capturedSessionId = await findRecentSessionId(cwd, startTime, sessionFilesBeforeSpawn);
      } catch (e) {
        this._logDebug(`session-id fs fallback failed: ${e.message}`);
      }
    }

    // PTY-extracted text is what we used to return as `text`. Keep it
    // as a fallback — it's our only option when the upstream JSONL is
    // disabled (`--no-session-persistence`), unavailable, or hasn't
    // flushed in time. But prefer the JSONL when present: it is the
    // upstream's own authoritative store of the assistant message,
    // with no PTY chrome, HUD plugins, statusline interleaving, or
    // `[Pasted text #N]` echoes mixed in.
    const ptyText =
      extractAssistantText(strippedBuffer, nonce) ||
      extractAssistantTextFromEvents(events);

    // JSONL-first extraction. Claude writes the completed assistant
    // turn to `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
    // as soon as the response finishes; reading from that file gives
    // us a clean markdown string that no PTY parser can ever match.
    // Skipped when noSessionPersistence is set (the file is never
    // written) or when we never captured a sessionId.
    let jsonlExtraction = null;
    if (capturedSessionId && req.noSessionPersistence !== true) {
      try {
        const { readSessionText } = await import('./chat/index.js');
        jsonlExtraction = await readSessionText(
          capturedSessionId,
          startTime,
          cwd,
        );
      } catch (e) {
        this._logDebug(`JSONL read failed: ${e.message}`);
      }
    }

    let text = jsonlExtraction?.text || ptyText;
    let effectiveCompletion = completion.reason;
    let effectiveIsError = completion.isError;
    let recoveredFromJsonl = false;

    // False-positive abort recovery. The PTY-side first-response
    // watchdog fires when no `⏺` / spinner is seen within
    // `OCP_FIRST_RESPONSE_MS`. Some legitimate runs cross that
    // threshold — heavy MCP/plugin loading, cold-cwd warmup, a slow
    // first-token. If the upstream nevertheless completed its turn
    // and flushed the response to JSONL, the abort was a timing
    // artifact, not a real stall. Promote to success when JSONL
    // proves the response actually landed.
    const stalledReasons = new Set(['interactive-required', 'trust-required', 'timeout']);
    if (stalledReasons.has(completion.reason) && jsonlExtraction?.text) {
      this._logDebug(
        `JSONL recovered from completion=${completion.reason} ` +
        `(${jsonlExtraction.text.length} chars) — treating as success`,
      );
      effectiveCompletion = 'jsonl-recovered';
      effectiveIsError = false;
      recoveredFromJsonl = true;
    }

    if (this.opts.debug) {
      const marker = TUI_PATTERNS.assistantRegionMarker;
      const rIdx = strippedBuffer.indexOf(marker);
      const sIdx = strippedBuffer.indexOf(`⟦OCP_END:${nonce}⟧`);
      this._logDebug(
        `extract: regionIdx=${rIdx} sentinelIdx=${sIdx} ` +
        `stripLen=${strippedBuffer.length} ` +
        `sentinelEvents=${events.filter(e=>e.type==='sentinel').length} ` +
        `assistantText=${events.filter(e=>e.type==='assistant-text').length} ` +
        `sid=${capturedSessionId} ` +
        `source=${jsonlExtraction?.text ? 'jsonl' : 'pty'} ` +
        `recovered=${recoveredFromJsonl}`,
      );
    }

    // Degraded-capture notice. When the per-turn sentinel never landed
    // (`reason='idle'`) or a stalled completion was rescued via JSONL
    // (`reason='jsonl-recovered'`), the streamed PTY frames did NOT
    // produce a clean end-of-reply boundary. The text we are returning
    // is a post-hoc recovery — usually from the upstream JSONL session
    // log, or as a best-effort tail of the PTY buffer when JSONL was
    // unavailable. Prepend a one-line notice so the caller (and any
    // chat UI rendering it) can tell this apart from a normal capture.
    // The notice is intentionally a literal English prefix and only
    // appears on the degraded path — the default success path
    // (`reason='sentinel'`) is unchanged.
    const captureFailed =
      effectiveCompletion === 'idle' || effectiveCompletion === 'jsonl-recovered';
    if (captureFailed && text) {
      const source = jsonlExtraction?.text
        ? 'local session log'
        : 'terminal buffer (best effort)';
      text =
        `[ocp] Streaming capture not detected — showing last result from ${source}.\n\n` +
        text;
    }

    // For stall-style failures, capture the tail of the stripped PTY
    // buffer so the caller can see exactly what claude was rendering
    // when we gave up — that is usually the dialog or error that the
    // user needs to act on manually. Skip when JSONL already gave us
    // a real response (the "stall" was a false positive).
    let stalledOutputTail;
    if (stalledReasons.has(effectiveCompletion)) {
      stalledOutputTail = strippedBuffer
        .split('\n')
        .map((l) => l.replace(/\s+$/, ''))
        .filter((l) => l.length > 0)
        .slice(-24)
        .join('\n');
    }

    return {
      sessionId: capturedSessionId,
      text,
      events,
      exitCode: effectiveIsError ? 1 : 0,
      isError: effectiveIsError,
      completionReason: effectiveCompletion,
      cost: { totalUsd: null, numTurns: null },
      durationMs: Date.now() - startTime,
      diagnostics: {
        rawBytes,
        strippedBytes: strippedBuffer.length,
        stalledOutputTail,
        eventsTruncated,
        strippedTruncated,
        textSource: jsonlExtraction?.text ? 'jsonl' : 'pty',
        recoveredFromJsonl,
      },
    };
  }

  async close() {
    if (this._pool) {
      await this._pool.close();
      this._pool = null;
    }
  }

  _logDebug(msg) {
    if (this.opts.debug) {
      process.stderr.write(`[ocp] ${msg}\n`);
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────

function numberFromEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  // Accept only positive finite values — `OCP_TRUST_SETTLE_MS=0`,
  // `OCP_FIRST_RESPONSE_MS=-1`, etc. would silently disable the
  // watchdog / collapse the wait, masking misconfiguration as fast
  // hangs or premature timeouts. Fall back to the documented default.
  return (Number.isFinite(n) && n > 0) ? n : fallback;
}

/**
 * Coerce a caller-supplied option value to a finite non-negative number,
 * falling back when it's missing/garbage. Lets the constructor accept
 * untrusted `opts.maxEvents`, `opts.firstResponseMs`, etc. without
 * silently letting NaN / strings / `-1` propagate to the math sites
 * (which would corrupt `events.splice(0, events.length - (MAX>>1))` into
 * unbounded growth or empty-array modes).
 */
function finiteNonNeg(v, fallback) {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve a cwd the same way `claude` does when building its session
 * directory under `~/.claude/projects/`: follow symlinks so callers
 * passing paths under `/var/folders/`, `/tmp/`, etc. on macOS land in
 * the matching `/private/<…>` directory. Falls back to a string
 * resolve when the path no longer exists (e.g. between turns the cwd
 * was deleted) — the lookup will simply miss and the caller falls
 * back to its own null-handling path.
 *
 * @param {string|undefined} cwd
 * @returns {Promise<string>}
 */
async function canonicalCwd(cwd) {
  const abs = path.resolve(cwd ?? process.cwd());
  try {
    return await realpath(abs);
  } catch {
    return abs;
  }
}

/**
 * Write a prompt to the PTY in a way that the upstream TUI will accept
 * and submit reliably even for multi-kilobyte payloads.
 *
 * Why this exists: a single `session.write(big)` followed by
 * `session.write('\r')` races claude's input handler. For large prompts
 * (Cosmica's RAG-injected ~3 KB), the TUI's paste detector grouped the
 * bytes into one or more `[Pasted text #N +X lines]` blocks and our
 * trailing `\r` was consumed as paste content rather than a submit —
 * the prompt sat in the input box, no `⏺` ever appeared, and the
 * first-response watchdog fired `interactive-required` 20 s later.
 *
 * Strategy:
 *
 *   - small prompts: write atomically and submit immediately
 *     (unchanged from pre-1.1 behaviour — keeps small-turn latency)
 *   - large prompts (`OCP_PASTE_MODE=auto` and length > threshold):
 *     write in chunks with brief inter-chunk delays so claude's auto-
 *     paste detector either treats each chunk as a separate typed
 *     burst or coalesces cleanly, then a settle delay before the
 *     `\r` submit so the input box has time to redraw
 *   - `OCP_PASTE_MODE=bracket`: wrap the payload in xterm bracketed-
 *     paste markers (`\x1b[200~ … \x1b[201~`). Modern TUIs treat the
 *     enclosed bytes as a single paste with explicit boundaries; the
 *     trailing `\r` lands outside the paste so it submits cleanly.
 *   - `OCP_PASTE_MODE=raw`: pre-1.1 behaviour (atomic write + `\r`).
 *     Escape hatch for environments where the new path regresses.
 *
 * @param {{ write: (s: string) => void }} session
 * @param {string} content
 * @param {object} opts  Driver options (chunk size / delays optional)
 */
export async function writePromptToSession(session, content, opts = {}) {
  const mode = opts.pasteMode
            ?? process.env.OCP_PASTE_MODE
            ?? 'auto';
  const threshold = opts.pasteThreshold
                 ?? numberFromEnv('OCP_PASTE_THRESHOLD')
                 ?? 1024;
  const settleMs = opts.submitSettleMs
                ?? numberFromEnv('OCP_SUBMIT_SETTLE_MS')
                ?? 50;

  if (mode === 'raw') {
    session.write(content);
    session.write('\r');
    return;
  }

  if (mode === 'bracket') {
    session.write('\x1b[200~' + content + '\x1b[201~');
    if (settleMs > 0) await sleep(settleMs);
    session.write('\r');
    return;
  }

  // `auto` (default) and `chunk` share the chunked-write path; `chunk`
  // forces it regardless of size, `auto` only kicks in above threshold.
  const useChunk = mode === 'chunk' || (mode === 'auto' && content.length > threshold);
  if (!useChunk) {
    session.write(content);
    session.write('\r');
    return;
  }

  const chunkChars = opts.pasteChunkChars
                  ?? numberFromEnv('OCP_PASTE_CHUNK_CHARS')
                  ?? 256;
  const chunkDelay = opts.pasteChunkDelayMs
                  ?? numberFromEnv('OCP_PASTE_CHUNK_DELAY_MS')
                  ?? 18;

  let i = 0;
  while (i < content.length) {
    let end = Math.min(i + chunkChars, content.length);
    // Don't split a surrogate pair across writes. JS strings are UTF-16
    // and most non-BMP code points (emoji, some CJK extensions) live as
    // pairs — splitting one yields two unpaired halves and the upstream
    // would render replacement glyphs.
    if (end < content.length) {
      const code = content.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    session.write(content.slice(i, end));
    i = end;
    if (i < content.length && chunkDelay > 0) await sleep(chunkDelay);
  }
  if (settleMs > 0) await sleep(settleMs);
  session.write('\r');
}

/**
 * Build upstream `claude` argv from the request object by walking
 * OPTION_SPEC and emitting each entry whose forward strategy is `argv`.
 * Pass-through tokens from the CLI's unknown-flag list are appended last.
 */
function buildSpawnArgs(req) {
  const args = [];
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
  if (Array.isArray(req.passThroughArgv) && req.passThroughArgv.length > 0) {
    const { sanitized } = sanitizePassThroughArgv(req.passThroughArgv);
    args.push(...sanitized);
  }
  return args;
}

/**
 * Map a spec entry to the corresponding camelCase field on the request
 * object. This is the convention the library API uses (e.g. spec name
 * 'allowed-tools' -> req.allowedTools).
 */
function fieldNameOf(spec) {
  return spec.name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * List session-id files that already exist in the project's session dir
 * BEFORE this request runs. Used as a "before" snapshot so the
 * post-request fallback only considers files that didn't exist
 * previously (or whose mtime moved during this request from a known
 * baseline).
 *
 * @param {string|undefined} cwd
 * @returns {Promise<Map<string, number>>}  filename -> previous mtimeMs
 */
async function listSessionFiles(cwd) {
  // Upstream encodes BOTH `/` and `_` as `-`, so a cwd containing
  // underscores (`gen_keypair`) maps to `gen-keypair`. The `/`-only
  // replacement silently looks in the wrong dir for those projects.
  // Also realpath() to follow macOS `/var` -> `/private/var` symlinks
  // — `claude` resolves symlinks when building its own JSONL dir, so
  // a string-only `path.resolve` here looks up the wrong project
  // directory and we miss every existing session file.
  const encoded = (await canonicalCwd(cwd)).replace(/[/_]/g, '-');
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

/**
 * Locate the session id from claude's on-disk session log.
 *
 * The upstream CLI persists each session to
 *   `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`
 * where `<encoded-cwd>` is the absolute cwd with `/` replaced by `-`.
 * We accept a file as "ours" when:
 *   (a) it did not exist in `before` (NEW file created during our run), OR
 *   (b) it existed in `before` AND its mtime moved during our run
 *       (resume-style append).
 * This avoids picking up an unrelated neighbour session created by
 * another claude process that happened to finish around the same time.
 *
 * @param {string|undefined} cwd
 * @param {number} since                  epoch-ms taken at the start of the request
 * @param {Map<string,number>} before     baseline filename -> mtimeMs from listSessionFiles
 * @returns {Promise<string|null>}
 */
async function findRecentSessionId(cwd, since, before) {
  // See listSessionFiles for the rationale on realpath + the `/_` -> `-`
  // mapping. Both helpers must agree, or the "did this file exist
  // before our request?" comparison silently misses every entry.
  const encoded = (await canonicalCwd(cwd)).replace(/[/_]/g, '-');
  const dir = path.join(os.homedir(), '.claude', 'projects', encoded);
  let entries;
  try { entries = await readdir(dir); } catch { return null; }
  const threshold = since - 1500;
  let best = null;
  let bestMtime = 0;
  for (const name of entries) {
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.jsonl$/.test(name)) continue;
    let st;
    try { st = await stat(path.join(dir, name)); } catch { continue; }
    if (st.mtimeMs < threshold) continue;
    const baseline = before?.get(name);
    if (baseline !== undefined && st.mtimeMs <= baseline + 100) continue; // existed before, didn't move
    if (st.mtimeMs > bestMtime) {
      bestMtime = st.mtimeMs;
      best = name.replace(/\.jsonl$/, '');
    }
  }
  return best;
}

/**
 * Preferred extraction path — operates on parsed events.
 *
 * The line-aware tui-frame parser tags each assistant-text event with the
 * region number it came from. For a fresh session the buffer has one
 * region (the response). For `--resume` the buffer can contain history
 * regions plus the current response; the current response is always the
 * HIGHEST region number, so we filter on that.
 *
 * @param {Array<{type:string,text?:string,region?:number}>} events
 * @returns {string} empty string when no assistant-text events were seen
 */
function extractAssistantTextFromEvents(events) {
  let maxRegion = 0;
  for (const e of events) {
    if (e.type === 'assistant-text' && typeof e.region === 'number') {
      if (e.region > maxRegion) maxRegion = e.region;
    }
  }
  if (maxRegion === 0) return '';
  const lines = [];
  for (const e of events) {
    if (e.type === 'assistant-text' && e.region === maxRegion) {
      lines.push(e.text ?? '');
    }
  }
  return lines.join('\n').replace(/\n+$/, '').trim();
}

/**
 * Fallback extraction — buffer-scan when no assistant-text events arrived.
 *
 * The upstream TUI renders the assistant response on the line that begins
 * with the `⏺` marker glyph. For a fresh session the first `⏺` is the
 * current response; for a `--resume` session the upstream re-renders prior
 * conversation history so the buffer can contain multiple `⏺` markers AND
 * multiple occurrences of the literal sentinel string (prompt echo + the
 * model's real response).
 *
 * The robust selection rule for both cases:
 *   1. Find the LAST occurrence of the sentinel string — it must be the
 *      model's response (echoes are always BEFORE the actual response in
 *      arrival order, so the byte-position of the last occurrence in the
 *      accumulated buffer corresponds to the real response output).
 *   2. Find the LAST `⏺` that appears BEFORE that sentinel — that is the
 *      response's region marker for the current turn.
 *   3. Slice between them and trim.
 *
 * @param {string} stripped
 * @param {string} nonce
 */
function extractAssistantText(stripped, nonce) {
  const sentinel = `⟦OCP_END:${nonce}⟧`;
  const marker = TUI_PATTERNS.assistantRegionMarker;

  let sentinelIdx = -1;
  for (let i = stripped.indexOf(sentinel);
       i !== -1;
       i = stripped.indexOf(sentinel, i + sentinel.length)) {
    sentinelIdx = i;
  }
  if (sentinelIdx === -1) {
    // Sentinel-missing fallback. On a resumed session the buffer carries
    // history regions before the current response, so anchoring on the
    // FIRST `⏺` would slice from the oldest history turn and return the
    // entire re-rendered transcript. Anchor on the LAST `⏺` instead —
    // that's the region marker for the current turn even after `--resume`.
    const ri = stripped.lastIndexOf(marker);
    return ri === -1 ? '' : stripped.slice(ri + marker.length).trim();
  }

  let regionIdx = -1;
  for (let j = stripped.indexOf(marker);
       j !== -1 && j < sentinelIdx;
       j = stripped.indexOf(marker, j + marker.length)) {
    regionIdx = j;
  }
  if (regionIdx === -1) {
    return stripped.slice(0, sentinelIdx).trim();
  }
  return stripped.slice(regionIdx + marker.length, sentinelIdx).trim();
}

/**
 * @typedef {object} OneShotResult
 * @property {string|null} sessionId
 * @property {string}      text
 * @property {Array<object>} events
 * @property {number}      exitCode
 * @property {boolean}     isError
 * @property {string}      completionReason
 * @property {{ totalUsd: number|null, numTurns: number|null }} cost
 * @property {number}      durationMs
 * @property {{ rawBytes: number, strippedBytes: number }} diagnostics
 */
