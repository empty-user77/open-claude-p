#!/usr/bin/env node
//
// `ocp` — CLI entry point.
//
// Accepts the same argv shape as `claude -p` (with `-p` itself implicit).
// Pipeline:
//   argv -> parseArgv -> validate -> createDriver().runOneShot()
//        -> output adapter (text / json / stream-json) -> stdout
// Unknown flags are forwarded verbatim to the upstream `claude` process via
// the driver's `passThroughArgv` so this binary stays argv-transparent.

// Don't crash on `ocp "…" | head -1` style usage where the downstream
// reader closes before we finish writing. Both stdout (assistant text)
// and stderr (live spinner, meta line, debug log) are vulnerable.
process.stdout.on('error', (e) => { if (e?.code !== 'EPIPE') throw e; });
process.stderr.on('error', (e) => { if (e?.code !== 'EPIPE') throw e; });

// Surface stray rejections / uncaught exceptions with a friendly
// prefix instead of Node's default `[UnhandledPromiseRejection]` dump.
process.on('unhandledRejection', (r) => {
  process.stderr.write(`ocp: unhandled rejection: ${r?.stack || r?.message || r}\n`);
  process.exit(1);
});
process.on('uncaughtException', (e) => {
  process.stderr.write(`ocp: uncaught exception: ${e?.stack || e?.message || e}\n`);
  process.exit(1);
});

import { parseArgv } from '../src/options/parse-argv.js';
import { validate } from '../src/options/validate.js';
import { OPTION_SPEC } from '../src/options/spec.js';
import { createDriver } from '../src/index.js';
import { sendToDaemon } from '../src/daemon/client.js';
import { daemonKey, socketPath, resolveCwd } from '../src/daemon/socket.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  registerOutputAdapter, getOutputAdapter,
} from '../src/output/registry.js';
import { textOutputAdapter } from '../src/output/text.js';
import { jsonOutputAdapter } from '../src/output/json.js';
import { streamJsonOutputAdapter } from '../src/output/stream-json.js';
import { stripTerminalControl } from '../src/chat/event-filters.js';
import { DEFAULT_APPEND_SYSTEM_PROMPT } from '../src/chat/index.js';
import { isatty } from 'node:tty';
import readline from 'node:readline';

// Register the bundled adapters once at startup. Plugins can extend this
// registry via the public `open-claude-p/output` entry point.
registerOutputAdapter(textOutputAdapter);
registerOutputAdapter(jsonOutputAdapter);
registerOutputAdapter(streamJsonOutputAdapter);

const EXIT = {
  OK: 0,
  GENERIC_ERROR: 1,
  PARSE_ERROR: 2,
  VALIDATION_ERROR: 3,
  TIMEOUT: 4,
  CANCELLED: 5,
  INTERACTIVE_REQUIRED: 6,
  NOT_IMPLEMENTED: 8,
};

async function main() {
  const { options, positional, unknown, errors } = parseArgv(process.argv.slice(2));

  if (errors.length > 0) {
    process.stderr.write(errors.map((e) => `error: ${e}`).join('\n') + '\n');
    return EXIT.PARSE_ERROR;
  }

  if (options.help === true) {
    process.stdout.write(buildHelp() + '\n');
    return EXIT.OK;
  }
  if (options.version === true) {
    const v = await readPackageVersion();
    process.stdout.write(`ocp ${v}\n`);
    return EXIT.OK;
  }

  // CLI-only default: when the user has not explicitly set
  // `--dangerously-skip-permissions`, honour the `OCP_DEFAULT_SKIP_PERMS=1`
  // env. Rationale — `ocp` is a non-interactive automation surface; a
  // permission prompt that wants a human answer makes most prompts
  // (WebSearch, Bash, Read, Write) silently no-op since PTY automation
  // cannot answer. Library callers via `createDriver()` retain the safer
  // default (`false`) — this opt-in only changes the CLI default.
  if (options['dangerously-skip-permissions'] !== true
   && process.env.OCP_DEFAULT_SKIP_PERMS === '1') {
    options['dangerously-skip-permissions'] = true;
  }

  // CLI-only default: pre-approve the read-only network tools so that a
  // plain `ocp "오늘 날씨"` actually uses WebSearch/WebFetch instead of
  // silently no-op'ing with "I can't access real-time info". These are
  // safe-by-construction (no filesystem mutation, no shell exec); a
  // headless tool that refuses to fetch the web for an automation
  // surface is the wrong default. Caller-supplied `--allowed-tools`
  // takes precedence (additive — we merge rather than replace).
  // Set OCP_NO_DEFAULT_TOOLS=1 to opt out entirely.
  if (process.env.OCP_NO_DEFAULT_TOOLS !== '1') {
    const DEFAULT_SAFE_TOOLS = ['WebSearch', 'WebFetch'];
    const existing = Array.isArray(options['allowed-tools']) ? options['allowed-tools'] : [];
    const merged = [...existing];
    for (const t of DEFAULT_SAFE_TOOLS) {
      if (!merged.includes(t)) merged.push(t);
    }
    options['allowed-tools'] = merged;
  }

  // CLI-only default: when no permission flag is supplied at all (no
  // `--dangerously-skip-permissions`, no `--permission-mode`), drop into
  // `acceptEdits` so edits / writes flow through without a per-call
  // prompt that the non-interactive PTY can't answer. This is the
  // "auto mode" most users want from a headless `ocp "…"` invocation.
  // Bypass mode is strictly more permissive (and noisier in audits) so
  // we don't apply it unless the user opted in explicitly.
  // Set OCP_NO_DEFAULT_PERMISSION_MODE=1 to keep `default` mode.
  if (options['dangerously-skip-permissions'] !== true
   && (options['permission-mode'] === undefined || options['permission-mode'] === '')
   && process.env.OCP_NO_DEFAULT_PERMISSION_MODE !== '1') {
    options['permission-mode'] = 'acceptEdits';
  }

  // Per-invocation reminder when both opt-in envs are active — that
  // combination means "any new cwd auto-trusted + every tool runs
  // without a prompt". A forgotten `export` in ~/.zshrc is otherwise
  // invisible. Set OCP_NO_WARN=1 to silence.
  if (process.env.OCP_DEFAULT_SKIP_PERMS === '1'
   && process.env.OCP_AUTO_ACCEPT_TRUST === '1'
   && process.stderr.isTTY
   && process.env.OCP_NO_WARN !== '1') {
    process.stderr.write(
      '\x1b[33m[ocp] OCP_DEFAULT_SKIP_PERMS + OCP_AUTO_ACCEPT_TRUST active — tools run unprompted in any cwd.\n' +
      '       Unset one of those envs in ~/.zshrc to restore prompts, or set OCP_NO_WARN=1 to silence this notice.\x1b[0m\n',
    );
  }

  // CLI-only default: encourage tool use for current/time-sensitive
  // queries via the same SDK-wide DEFAULT_APPEND_SYSTEM_PROMPT the
  // chat client already uses. Without this, a plain `ocp "오늘 날씨"`
  // refuses with "I can't access real-time data" instead of calling
  // WebSearch — because Claude's print-mode default behaviour leans
  // toward declining over tool-use when it can answer with disclaimers.
  // This is a generic, ONE-LINE rule ("use tools when you need to look
  // something up"), not tool-by-tool guidance, so it stays within the
  // "common rules" policy. Caller-supplied `--append-system-prompt`
  // takes precedence (additive — we prepend the default before it).
  // Set OCP_NO_DEFAULT_PROMPT=1 to opt out.
  if (process.env.OCP_NO_DEFAULT_PROMPT !== '1') {
    const userAppend = options['append-system-prompt'];
    options['append-system-prompt'] = (typeof userAppend === 'string' && userAppend.length > 0)
      ? `${DEFAULT_APPEND_SYSTEM_PROMPT}\n\n${userAppend}`
      : DEFAULT_APPEND_SYSTEM_PROMPT;
  }

  const validationErrors = validate(options);
  if (validationErrors.length > 0) {
    process.stderr.write(
      validationErrors.map((e) => `error: ${e}`).join('\n') + '\n',
    );
    return EXIT.VALIDATION_ERROR;
  }

  if (options.debug && unknown.length > 0) {
    process.stderr.write(
      `[ocp] forwarding unknown flags to claude: ${unknown.join(' ')}\n`,
    );
  }

  const inputFormat = options['input-format'] ?? 'text';

  // For `--input-format=text` the prompt resolution is positional argv
  // first, then stdin if non-TTY. For `--input-format=stream-json` we
  // drive a loop over NDJSON user messages on stdin instead — see
  // runStreamJsonInputLoop() below.
  let prompt = '';
  if (inputFormat === 'text') {
    prompt = positional.length > 0 ? positional.join(' ') : '';
    if (!prompt && !isatty(0)) {
      prompt = await readStdin();
    }
    if (!prompt) {
      process.stderr.write(
        'error: no prompt provided. Pass it positionally (`ocp "hello"`) or pipe it via stdin.\n\n',
      );
      process.stderr.write(buildHelp() + '\n');
      return EXIT.PARSE_ERROR;
    }
  }

  const outputFormat = options['output-format'] ?? 'text';
  const adapterDef = getOutputAdapter(outputFormat);
  if (!adapterDef) {
    process.stderr.write(
      `error: --output-format=${outputFormat} is not registered.\n`,
    );
    return EXIT.NOT_IMPLEMENTED;
  }

  // ── Daemon path ──────────────────────────────────────────────────────────
  // The daemon keeps a PTY alive between invocations so conversation context
  // is preserved and subsequent commands skip the 2.5 s warmup delay.
  //
  // Bypassed when:
  //   OCP_NO_DAEMON=1      — explicit opt-out
  //   --input-format=stream-json — daemon doesn't help multi-turn loops
  //   --resume / --continue / --fork-session — caller wants a specific session
  // Print-mode (--print-mode / OCP_PRINT_MODE) bypasses PTY+TUI entirely.
  // Daemon is irrelevant for that path — the child process is short-lived.
  const printMode =
    options['print-mode'] === true ||
    process.env.OCP_PRINT_MODE === '1' ||
    process.env.OCP_PRINT_MODE === 'true';

  const useDaemon = !process.env.OCP_NO_DAEMON
    && !printMode
    && inputFormat !== 'stream-json'
    && !options.resume
    && !options.continue
    && !options['fork-session'];

  if (useDaemon) {
    // Include claudeBin in the key — two ocp runs in the same cwd but
    // with different OCP_CLAUDE_BIN values must address different
    // daemons (otherwise the second silently rides on the first's
    // binary).
    const key = daemonKey({ cwd: options.cwd, claudeBin: process.env.OCP_CLAUDE_BIN });
    const sockPath = socketPath(key);

    const req = {
      prompt,
      // Echo the realpath-normalised cwd we keyed the daemon on. Both
      // sides must use the SAME normalisation (realpath) — otherwise
      // two shells reaching the same directory via different symlinks
      // route to the same socket (key uses realpath) but the daemon
      // would reject the second shell's raw req.cwd as "cwd mismatch".
      cwd: resolveCwd(options.cwd),
      // Echo the claudeBin we expected this daemon to be bound to. A
      // same-uid peer can otherwise connect directly to our socket and
      // drive requests through whatever binary the daemon is running,
      // regardless of what the requester intended. Daemon rejects on
      // mismatch.
      claudeBin: process.env.OCP_CLAUDE_BIN || 'claude',
      model: options.model,
      systemPrompt: options['system-prompt'],
      appendSystemPrompt: options['append-system-prompt'],
      allowedTools: options['allowed-tools'],
      disallowedTools: options['disallowed-tools'],
      dangerouslySkipPermissions: options['dangerously-skip-permissions'],
      permissionMode: options['permission-mode'],
      debug: options.debug,
      verbose: options.verbose,
      maxTurns: options['max-turns'],
      maxBudgetUsd: options['max-budget-usd'],
      taskBudget: options['task-budget'],
      noSessionPersistence: options['no-session-persistence'],
      passThroughArgv: unknown,
    };

    try {
      const result = await sendToDaemon(sockPath, req, { cwd: options.cwd, debug: options.debug }, key);

      const adapter = adapterDef.create(
        { outputFormat, jsonSchema: options['json-schema'] },
        process.stdout,
      );
      for (const ev of (result.events ?? [])) adapter.onEvent(ev);
      adapter.end({
        text: result.text,
        isError: result.isError,
        sessionId: result.sessionId,
        cost: result.cost,
        durationMs: result.durationMs,
        completionReason: result.completionReason,
      });

      if (result.sessionId && options.debug) process.stderr.write(`[ocp] sessionId=${result.sessionId}\n`);
      if (options.debug) {
        process.stderr.write(`[ocp] daemon: completion=${result.completionReason} duration=${result.durationMs}ms\n`);
      }
      return mapCompletionToExit(result);
    } catch (e) {
      // Distinguish "daemon unreachable / crashed" (safe to retry direct)
      // from "daemon explicitly refused this request" (must NOT retry —
      // the refusal is a security decision such as cwd mismatch).
      if (e.fromDaemon) {
        process.stderr.write(`ocp: daemon refused request: ${e.message}\n`);
        return EXIT.GENERIC_ERROR;
      }
      // Setup errors that won't be fixed by retrying direct (e.g. wrong-
      // owner ~/.ocp/) — surface immediately rather than silently
      // falling back. ensureOcpDir's wrong-uid error is the canonical
      // case; identify it by message prefix so a chown hint reaches
      // the user without --debug.
      if (typeof e.message === 'string' && e.message.startsWith('~/.ocp is owned by')) {
        process.stderr.write(`ocp: ${e.message}\n`);
        return EXIT.GENERIC_ERROR;
      }
      if (options.debug) {
        process.stderr.write(`[ocp] daemon unreachable (${e.message}), falling back to direct mode\n`);
      }
      // Fall through to direct mode below.
    }
  }

  // ── Direct path (no daemon) ──────────────────────────────────────────────
  const driver = createDriver({
    debug: options.debug,
    cwd: options.cwd,
    printMode,
  });

  const ac = new AbortController();
  setupSignalHandlers(ac);

  // Print-mode bypasses the adapter: claude's stdout (already in the
  // requested --output-format) is streamed verbatim to process.stdout.
  if (printMode) {
    try {
      const result = await driver.runOneShot({
        prompt,
        cwd: options.cwd,
        outputFormat,
        model: options.model,
        systemPrompt: options['system-prompt'],
        appendSystemPrompt: options['append-system-prompt'],
        allowedTools: options['allowed-tools'],
        disallowedTools: options['disallowed-tools'],
        dangerouslySkipPermissions: options['dangerously-skip-permissions'],
        permissionMode: options['permission-mode'],
        verbose: options.verbose,
        continue: options.continue,
        resume: options.resume,
        forkSession: options['fork-session'],
        noSessionPersistence: options['no-session-persistence'],
        sessionId: options['session-id'],
        passThroughArgv: unknown,
        abortSignal: ac.signal,
        maxTurns: options['max-turns'],
        maxBudgetUsd: options['max-budget-usd'],
        printSink: process.stdout,
      });
      if (result.sessionId && options.debug) process.stderr.write(`[ocp] sessionId=${result.sessionId}\n`);
      if (options.debug) {
        process.stderr.write(
          `[ocp] print-mode completion=${result.completionReason} duration=${result.durationMs}ms\n`,
        );
      }
      return mapCompletionToExit(result);
    } finally {
      await driver.close();
    }
  }

  const adapter = adapterDef.create(
    { outputFormat, jsonSchema: options['json-schema'] },
    process.stdout,
  );

  try {
    if (inputFormat === 'stream-json') {
      return await runStreamJsonInputLoop({
        driver, adapter, options, unknown, ac,
      });
    }

    const result = await runOneTurn({
      driver, adapter, options, unknown, ac, prompt,
      resumeOverride: options.resume,
    });

    if (result.sessionId && options.debug) {
      process.stderr.write(`[ocp] sessionId=${result.sessionId}\n`);
    }
    if (options.debug) {
      process.stderr.write(
        `[ocp] completion=${result.completionReason} duration=${result.durationMs}ms ` +
        `rawBytes=${result.diagnostics.rawBytes} strippedBytes=${result.diagnostics.strippedBytes}\n`,
      );
    }
    return mapCompletionToExit(result);
  } finally {
    await driver.close();
  }
}

/**
 * Run a single user prompt through the driver, forwarding events into the
 * shared adapter and calling `adapter.end()` once on completion. Used by
 * both the default single-turn path and the stream-json input loop.
 */
async function runOneTurn({ driver, adapter, options, unknown, ac, prompt, resumeOverride }) {
  const startTime = Date.now();
  const result = await driver.runOneShot({
    prompt,
    cwd: options.cwd,
    model: options.model,
    systemPrompt: options['system-prompt'],
    appendSystemPrompt: options['append-system-prompt'],
    allowedTools: options['allowed-tools'],
    disallowedTools: options['disallowed-tools'],
    dangerouslySkipPermissions: options['dangerously-skip-permissions'],
    permissionMode: options['permission-mode'],
    debug: options.debug,
    verbose: options.verbose,
    continue: options.continue,
    resume: resumeOverride ?? options.resume,
    forkSession: options['fork-session'],
    noSessionPersistence: options['no-session-persistence'],
    resumeSessionAt: options['resume-session-at'],
    rewindFiles: options['rewind-files'],
    sessionId: options['session-id'],
    name: options.name,
    passThroughArgv: unknown,
    abortSignal: ac.signal,
    maxTurns: options['max-turns'],
    maxBudgetUsd: options['max-budget-usd'],
    taskBudget: options['task-budget'],
    onEvent: (ev) => adapter.onEvent(ev),
  });

  // Prefer the upstream JSONL session file's clean markdown over the
  // PTY-extracted text when available. PTY-stripped buffers commonly
  // interleave statusline / HUD plugin output that region extraction
  // alone cannot scrub; the JSONL file is what claude itself stores
  // and contains only the assistant's message verbatim. We call
  // readSessionText even when sessionId is null — it falls back to the
  // most-recently-modified JSONL written during this request window.
  let finalText = result.text;
  let usage = null;
  let toolsFromSession = [];
  if (!result.isError) {
    try {
      const { readSessionText } = await import('../src/chat/index.js');
      const sessionRead = await readSessionText(result.sessionId, startTime, options.cwd);
      if (sessionRead?.text) finalText = sessionRead.text;
      if (sessionRead?.usage) usage = sessionRead.usage;
      if (sessionRead?.tools) toolsFromSession = sessionRead.tools;
    } catch { /* keep PTY-extracted fallback */ }
  }

  adapter.end({
    text: finalText,
    isError: result.isError,
    sessionId: result.sessionId,
    cost: result.cost,
    durationMs: result.durationMs,
    completionReason: result.completionReason,
  });

  // Persist a per-turn record under <cwd>/.ocp/<sessionId>/ for the
  // direct (no-daemon) CLI path. Daemon-routed turns already record
  // server-side. Best-effort — failures are captured inside
  // recordSession and never block the response.
  try {
    const { recordSession } = await import('../src/session-log.js');
    recordSession({
      cwd: options.cwd ?? process.cwd(),
      sessionId: result.sessionId,
      prompt,
      response: finalText,
      meta: {
        isError: result.isError,
        completionReason: result.completionReason,
        durationMs: result.durationMs,
        cost: result.cost,
        tools: toolsFromSession,
      },
      events: result.events,
    }).catch(() => {});
  } catch { /* ignore */ }

  await printMetaLine({ options, result, usage, toolsFromSession });
  return result;
}

async function printMetaLine({ options, result, usage, toolsFromSession }) {
  // The meta line is supplementary UX — only show it when stderr is an
  // interactive terminal AND the user has not opted out. Suppressed in
  // pipe / script contexts so script consumers see only the response.
  if (!process.stderr.isTTY) return;
  if (options['no-meta'] === true) return;
  if (process.env.OCP_NO_META === '1') return;
  if (result.isError) return;

  let totalInputTokens, computeCost, formatTokens, stripTerminalControl;
  try {
    const m = await import('../src/chat/index.js');
    totalInputTokens = m.totalInputTokens;
    computeCost = m.computeCost;
    formatTokens = m.formatTokens;
    stripTerminalControl = m.stripTerminalControl;
  } catch { return; }

  // Defense in depth: tool names are already sanitised at JSONL
  // extraction time, but we also scrub here in case a future code path
  // routes around that sink.
  const tools = new Set();
  for (const t of toolsFromSession ?? []) {
    const safe = stripTerminalControl(t);
    if (safe) tools.add(safe);
  }
  if (usage?.server_tool_use?.web_search_requests > 0) tools.add('web_search');
  if (usage?.server_tool_use?.web_fetch_requests > 0)  tools.add('web_fetch');

  const secs = ((result.durationMs ?? 0) / 1000).toFixed(1);
  const inTok = formatTokens(totalInputTokens(usage));
  const outTok = usage?.output_tokens != null ? formatTokens(usage.output_tokens) : '?';
  const cost = computeCost(usage);
  const costStr = cost != null ? `$${cost.toFixed(4)}` : '$?';
  const toolsStr = tools.size > 0 ? [...tools].join(', ') : 'none';

  // Dim grey so the meta line doesn't compete with the response above.
  process.stderr.write(
    `\x1b[90m⏱ ${secs}s · ↑${inTok} ↓${outTok} tok · ${costStr} · 🔧 ${toolsStr}\x1b[0m\n`,
  );
}

/**
 * --input-format=stream-json loop.
 *
 * Reads NDJSON user messages from stdin and runs each through a fresh
 * driver request. The session id is threaded through so the conversation
 * persists across messages. The shared adapter accumulates per-turn output
 * (stream-json adapters emit init once on first session id, then assistant
 * + result per turn).
 *
 * Supported message shapes:
 *   { "type": "user", "content": "..." }
 *   { "type": "user", "message": { "content": "..." } }
 * Unknown shapes / unparseable lines are reported as `status` warnings on
 * stderr.
 */
async function runStreamJsonInputLoop({ driver, adapter, options, unknown, ac }) {
  if ((options['output-format'] ?? 'text') !== 'stream-json') {
    // Cross-rule R1 enforces this earlier, but double-check.
    process.stderr.write('error: --input-format=stream-json requires --output-format=stream-json.\n');
    return EXIT.VALIDATION_ERROR;
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let currentSessionId = options.resume ?? null;
  let lastExit = EXIT.OK;
  let any = false;
  ac.signal.addEventListener('abort', () => rl.close(), { once: true });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) {
      process.stderr.write(`[ocp] stream-json input: invalid JSON (${e.message})\n`);
      continue;
    }
    if (msg?.type !== 'user') {
      process.stderr.write(`[ocp] stream-json input: skipping non-user message type=${JSON.stringify(msg?.type)}\n`);
      continue;
    }
    const content =
      typeof msg.content === 'string' ? msg.content
        : typeof msg.message?.content === 'string' ? msg.message.content
        : null;
    if (!content) {
      process.stderr.write('[ocp] stream-json input: user message missing string content\n');
      continue;
    }
    any = true;
    const result = await runOneTurn({
      driver, adapter, options, unknown, ac,
      prompt: content,
      resumeOverride: currentSessionId,
    });
    currentSessionId = result.sessionId ?? currentSessionId;
    if (options.debug) {
      process.stderr.write(
        `[ocp] turn done: sid=${currentSessionId} completion=${result.completionReason}\n`,
      );
    }
    const turnExit = mapCompletionToExit(result);
    if (turnExit !== EXIT.OK) lastExit = turnExit;
    if (ac.signal.aborted) break;
  }
  if (!any) {
    process.stderr.write('error: stream-json input ended with no usable user messages.\n');
    return EXIT.PARSE_ERROR;
  }
  return lastExit;
}

function mapCompletionToExit(result) {
  if (result.completionReason === 'timeout') {
    printStalledOutput(result);
    process.stderr.write(
      'ocp: hard timeout waiting for response. Increase OCP_MAX_RESPONSE_MS\n' +
      '  if the upstream genuinely needs more time, or inspect the screen\n' +
      '  above for an interactive prompt we did not recognise.\n',
    );
    return EXIT.TIMEOUT;
  }
  if (result.completionReason === 'cancelled') return EXIT.CANCELLED;
  if (result.completionReason === 'trust-required') {
    process.stderr.write(
      'ocp: upstream is waiting on the "Do you trust this folder?" dialog.\n' +
      '  Run `OCP_AUTO_ACCEPT_TRUST=1 ocp …` to auto-accept it, or run\n' +
      '  `claude` directly in this directory once and choose "Yes".\n',
    );
    printStalledOutput(result);
    return EXIT.INTERACTIVE_REQUIRED;
  }
  if (result.completionReason === 'interactive-required') {
    process.stderr.write(
      'ocp: no response after waiting — claude TUI appears to be blocked\n' +
      '  on an interactive prompt we cannot answer (tool-permission, MCP\n' +
      '  auth, login expiry, theme picker, or a dialog new to this claude\n' +
      '  version). The current PTY screen is shown below so you can handle\n' +
      '  it manually by running `claude` directly in this directory.\n',
    );
    printStalledOutput(result);
    return EXIT.INTERACTIVE_REQUIRED;
  }
  if (result.completionReason === 'max-turns') return EXIT.GENERIC_ERROR;
  return result.isError ? EXIT.GENERIC_ERROR : EXIT.OK;
}

function printStalledOutput(result) {
  const tail = result.diagnostics?.stalledOutputTail;
  if (!tail) return;
  // ansiStripParser removes only ESC-introduced sequences. Bare C1 /
  // BEL / BS / CR injected by upstream into the TUI buffer would still
  // reach stderr and corrupt the user's terminal. Strip them here.
  // stripTerminalControl's default max=64 truncates to uselessness for
  // a full-screen TUI capture — explicitly pass the buffer cap from
  // upstream so the operator sees the actual stalled screen.
  const safe = stripTerminalControl(tail, Number.MAX_SAFE_INTEGER);
  process.stderr.write('\n─── current claude TUI screen (tail) ───\n');
  process.stderr.write(safe + '\n');
  process.stderr.write('─── end ───\n\n');
}

// ── helpers ────────────────────────────────────────────────────────────

function setupSignalHandlers(ac) {
  const onSig = () => {
    ac.abort();
  };
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);
}

async function readPackageVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, '..', 'package.json');
    const json = JSON.parse(await readFile(pkgPath, 'utf8'));
    return json.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readStdin() {
  // Number(env) || fb accepts -1 (truthy) and absurd values silently —
  // route through a positive-int validator so garbage falls back.
  const rawMax = Number(process.env.OCP_MAX_STDIN_BYTES);
  const MAX = (Number.isFinite(rawMax) && rawMax > 0) ? Math.floor(rawMax) : 262_144;
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      bytes += Buffer.byteLength(c);
      if (bytes > MAX) {
        process.stdin.pause();
        reject(new Error(`stdin prompt exceeds ${MAX} bytes; pipe a file path or raise OCP_MAX_STDIN_BYTES`));
        return;
      }
      data += c;
    });
    process.stdin.on('end', () => resolve(data.replace(/\s+$/, '')));
    process.stdin.on('error', (e) => {
      if (e?.code === 'EISDIR') {
        reject(new Error('stdin is a directory — pass a file via `ocp < file.txt` or a positional prompt'));
      } else if (e?.code === 'ENOENT') {
        reject(new Error('stdin source not found'));
      } else {
        reject(e);
      }
    });
  });
}

/** Generate help text by walking OPTION_SPEC. */
function buildHelp() {
  const lines = [];
  lines.push('Usage:');
  lines.push('  ocp [options] [prompt]');
  lines.push('  echo "<prompt>" | ocp [options]');
  lines.push('');
  lines.push('A PTY-backed compatibility shim for `claude -p` (headless / print mode).');
  lines.push('`-p` / `--print` is implicit; `ocp "hi"` is equivalent to `claude -p "hi"`.');
  lines.push('');
  lines.push('Options:');
  for (const spec of OPTION_SPEC) {
    const shortPart = spec.short ? `-${spec.short}, ` : '    ';
    const longPart = `--${spec.name}`;
    const aliasPart = (spec.aliases ?? []).length > 0
      ? ` (alias: ${spec.aliases.map((a) => `--${a}`).join(', ')})`
      : '';
    const valuePart =
      spec.kind === 'boolean' ? ''
        : spec.kind === 'enum' ? ` <${spec.choices.join('|')}>`
        : spec.kind === 'array' ? ' <value>…'
        : ' <value>';
    const head = `  ${shortPart}${longPart}${valuePart}${aliasPart}`;
    lines.push(head);
    if (spec.description) {
      // Indent description under the head line.
      for (const w of wrap(spec.description, 76)) {
        lines.push('      ' + w);
      }
    }
    if (Object.prototype.hasOwnProperty.call(spec, 'default') && spec.default !== false) {
      lines.push(`      (default: ${JSON.stringify(spec.default)})`);
    }
  }
  lines.push('');
  lines.push('Environment:');
  lines.push('  OCP_CLAUDE_BIN       Path to upstream `claude` binary (default: `claude`).');
  lines.push('  OCP_WARMUP_MS        Delay before sending the prompt (default: 2500).');
  lines.push('  OCP_IDLE_MS          Idle silence threshold for completion (default: 1500).');
  lines.push('  OCP_MAX_RESPONSE_MS  Hard timeout (default: 60000).');
  lines.push('  OCP_AUTO_ACCEPT_TRUST=1');
  lines.push('                       Auto-accept the upstream "Do you trust this folder?"');
  lines.push('                       dialog. Off by default — without this, ocp aborts fast');
  lines.push('                       on first use in an unknown cwd with exit code 6.');
  lines.push('  OCP_DEFAULT_SKIP_PERMS=1');
  lines.push('                       Default `--dangerously-skip-permissions` to on for the');
  lines.push('                       CLI so tool calls (WebSearch, Bash, Read, Write, …) run');
  lines.push('                       without permission prompts. Off by default; explicit');
  lines.push('                       `--dangerously-skip-permissions` always wins.');
  lines.push('  OCP_NO_LIVE=1        Disable the live spinner / phase indicator on stderr');
  lines.push('                       even when the terminal is a TTY (useful with --debug).');
  lines.push('');
  lines.push('Daemon (background PTY, keeps conversation alive):');
  lines.push('  OCP_NO_DAEMON=1      Disable daemon; use a fresh PTY for every call.');
  lines.push('  OCP_DAEMON_IDLE_MS   Idle timeout before daemon exits (default: 600000 = 10 min).');
  lines.push('  OCP_MAX_DAEMONS      Max concurrent active+idle terminals (default: 30).');
  lines.push('  ~/.ocp/              State files and sockets (one daemon per working directory).');
  return lines.join('\n');
}

function wrap(s, width) {
  const out = [];
  let line = '';
  for (const w of s.split(/\s+/)) {
    if ((line + ' ' + w).trim().length > width) {
      out.push(line.trim());
      line = w;
    } else {
      line += ' ' + w;
    }
  }
  if (line.trim()) out.push(line.trim());
  return out;
}

// ── entry ──────────────────────────────────────────────────────────────

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    // Default: surface only the message — stack traces include absolute
    // homedir paths, line numbers, and internal class names that leak
    // architecture when users paste failures into bug reports.
    // Opt in to the full stack via --debug or OCP_DEBUG=1.
    const wantStack = process.argv.includes('--debug') || process.env.OCP_DEBUG === '1';
    const text = wantStack ? (e?.stack || e?.message || String(e)) : (e?.message || String(e));
    process.stderr.write(`ocp: ${text}\n`);
    process.exit(EXIT.GENERIC_ERROR);
  });
