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
import { readdir, stat } from 'node:fs/promises';
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
const DEFAULT_MAX_RESPONSE_MS = 60_000;

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
      promptBoxWaitMs: finiteNonNeg(opts.promptBoxWaitMs, numberFromEnv('OCP_PROMPT_BOX_WAIT_MS', 6_000)),
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
   * @param {boolean} [req.dangerouslySkipPermissions]
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
    // cwd has never been confirmed. PTY automation cannot answer these
    // unless we recognise the dialog. We auto-accept folder-trust ONLY
    // when explicitly opted in (OCP_AUTO_ACCEPT_TRUST=1 or req
    // .autoAcceptFolderTrust); otherwise we abort fast with a clear
    // completion reason rather than letting the user stare at a silent
    // timeout. Unknown dialogs short-circuit with `interactive-required`
    // so the CLI can surface an actionable error.
    const autoAcceptTrust = process.env.OCP_AUTO_ACCEPT_TRUST === '1'
                         || req.autoAcceptFolderTrust === true;
    const TRUST_PATTERNS = [
      /Quick safety check/i,
      /Is this a project you (?:created|trust)/i,
      /trust this folder/i,
    ];
    const TRUST_SETTLE_MS = this.opts.trustSettleMs
                         ?? numberFromEnv('OCP_TRUST_SETTLE_MS')
                         ?? 5000;
    let dialogState = 'none'; // 'none' | 'trust-accepted' | 'trust-blocked' | 'unknown-blocked'
    let dialogScanBuf = '';

    const dialogWatchHandler = (chunk) => {
      if (dialogState !== 'none') return;
      dialogScanBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
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
      if (promptBoxTimeoutHit && !promptBoxReady) {
        this._logDebug(`prompt-box-shown not seen within ${PROMPT_BOX_WAIT_MS}ms — sending anyway`);
      } else if (promptBoxReady && PROMPT_BOX_SETTLE_MS > 0) {
        // Small settle so an animating chevron / cursor blink doesn't
        // race our first keystroke.
        await sleep(PROMPT_BOX_SETTLE_MS);
      }

      // Sentinel marker appended to every user turn so PTY automation
      // can tell when the reply is done. Phrased to be inert to model
      // behaviour — do NOT use words like "finish", "complete",
      // "wrap up", or "final" that nudge the model to cut tool use
      // short. The reply itself is the actual signal of completion;
      // this marker is just the bookkeeping byte we emit afterwards.
      // Single-line form because `\n` flips claude TUI into multi-line
      // edit mode where `\r` no longer submits.
      const instruction =
        ` (Append the literal token ${sentinel} on its own line at the very` +
        ' end of your reply. Automation glue — does not constrain how you' +
        ' answer above; use tools as freely and thoroughly as you would' +
        ' without this marker.)';
      try {
        session.write(req.prompt + instruction);
        session.write('\r');
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
    const dirty = completion.reason === 'cancelled'
               || completion.reason === 'trust-required'
               || completion.reason === 'interactive-required';
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

    // Buffer-scan is primary: finds text between the LAST ⏺ marker and the
    // LAST sentinel occurrence, which is always Claude's complete final
    // response regardless of how many partial re-renders the TUI produced.
    // Event-based extraction is the fallback (used when the buffer scan finds
    // nothing, e.g. if the PTY session was too short to accumulate a sentinel).
    const text =
      extractAssistantText(strippedBuffer, nonce) ||
      extractAssistantTextFromEvents(events);

    if (this.opts.debug) {
      const marker = TUI_PATTERNS.assistantRegionMarker;
      const rIdx = strippedBuffer.indexOf(marker);
      const sIdx = strippedBuffer.indexOf(`⟦OCP_END:${nonce}⟧`);
      this._logDebug(
        `extract: regionIdx=${rIdx} sentinelIdx=${sIdx} ` +
        `stripLen=${strippedBuffer.length} ` +
        `sentinelEvents=${events.filter(e=>e.type==='sentinel').length} ` +
        `assistantText=${events.filter(e=>e.type==='assistant-text').length} ` +
        `sid=${capturedSessionId}`,
      );
    }

    // For stall-style failures, capture the tail of the stripped PTY
    // buffer so the caller can see exactly what claude was rendering
    // when we gave up — that is usually the dialog or error that the
    // user needs to act on manually.
    const stalledReasons = new Set(['interactive-required', 'trust-required', 'timeout']);
    let stalledOutputTail;
    if (stalledReasons.has(completion.reason)) {
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
      exitCode: completion.isError ? 1 : 0,
      isError: completion.isError,
      completionReason: completion.reason,
      cost: { totalUsd: null, numTurns: null },
      durationMs: Date.now() - startTime,
      diagnostics: { rawBytes, strippedBytes: strippedBuffer.length, stalledOutputTail, eventsTruncated, strippedTruncated },
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
  const absCwd = path.resolve(cwd ?? process.cwd());
  // Upstream encodes BOTH `/` and `_` as `-`, so a cwd containing
  // underscores (`gen_keypair`) maps to `gen-keypair`. The `/`-only
  // replacement silently looks in the wrong dir for those projects.
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
  const absCwd = path.resolve(cwd ?? process.cwd());
  // Upstream encodes BOTH `/` and `_` as `-`, so a cwd containing
  // underscores (`gen_keypair`) maps to `gen-keypair`. The `/`-only
  // replacement silently looks in the wrong dir for those projects.
  const encoded = absCwd.replace(/[/_]/g, '-');
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
    // Fall back to "everything after the first ⏺" — this preserves the
    // legacy behavior when the model dropped the sentinel.
    const ri = stripped.indexOf(marker);
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
