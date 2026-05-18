# Changelog

All notable changes to **open-claude-p** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] — 2026-05-18

`ocp` 1.1 reshapes the CLI defaults around the assumption that
**callers are programs, not humans**, and adds a JSONL-first
extraction path so PTY chrome can no longer leak into responses.

### Added

- **JSONL-first response extraction.** `claude` writes the completed
  assistant turn to `~/.claude/projects/<cwd>/<sid>.jsonl`. The driver
  now reads that authoritative source first and falls back to
  PTY-extracted text only when the JSONL is unavailable
  (`--no-session-persistence`, missing file, etc.). Cleans up
  statusline / HUD plugin / `[Pasted text #N]` leakage at the source.
  Result: `diagnostics.textSource` is `"jsonl"` or `"pty"`,
  `diagnostics.recoveredFromJsonl` is `true` when a PTY-side abort
  was overridden by a successful JSONL read.
- **Paste-mode handling for large prompts.** New driver option
  `pasteMode` (`auto` | `chunk` | `bracket` | `raw`) with env
  `OCP_PASTE_MODE`. Prompts above `OCP_PASTE_THRESHOLD` bytes
  (default 1024) are written in ~256-char chunks with brief delays
  so the upstream TUI's paste detector does not coalesce them into
  a `[Pasted text]` placeholder that swallows the trailing
  carriage-return. New exported helper `writePromptToSession`.
- **Stall-cause detector.** New `src/diagnostics/stall-cause.js`
  scans the captured PTY tail at abort time and returns a stable
  machine-readable identifier (`mcp-auth-required`,
  `trust-required`, `theme-picker`, `login-expired`,
  `tool-permission`, `paste-not-submitted`) plus an actionable
  English hint, surfaced as `detected: <kind>` on stderr.
- **`TUI_CHROME_PATTERNS` / `TUI_CHROME_INLINE_PATTERNS`** exported
  from `open-claude-p/chat`. Line-anchored vs inline-fragment
  pattern lists used by `cleanResponse`. External callers building
  alternative scrubbers can reuse the list.
- **`OCP_NO_SESSION_PERSISTENCE` env binding** on the CLI. Previously
  only the flag `--no-session-persistence` was honoured.
- **`OCP_DUMP_STALL=1` opt-in** for the PTY screen tail in abort
  errors. The default suppresses the tail because it can echo the
  caller's prompt (a real concern for RAG-injected prompts containing
  user data).
- **`OCP_NO_AUTO_ACCEPT_TRUST=1` opt-out** for folder-trust
  auto-accept.
- **`OCP_NO_SKIP_PERMS=1` opt-out** for the new default
  `--dangerously-skip-permissions`.
- **CHANGELOG.md** (this file).
- **`ocp-sample` companion CLI.** Downloads the demo chat-UI app
  (the `sample/` subtree) from the upstream git repo on demand so
  the published tarball stays small. Subcommands `init` (clone +
  npm install into a user-chosen directory), `start` (detached server
  with PID/log file), `stop`, `status`. Pretty TTY output (braille
  spinner, success/failure marks, end-of-init banner with the running
  URL); auto-falls-back to plain text when `NO_COLOR=1` or stderr
  isn't a TTY. Designed for npx-first use:
  `npx -p open-claude-p ocp-sample init demo`.

### Changed

- **`--dangerously-skip-permissions` is now the CLI default.**
  Rationale: `ocp` is a non-interactive PTY automation surface. A
  permission prompt that wants a human y/n hangs forever — every
  Bash / Edit / Write / MCP call breaks without this flag. Library
  callers (`createDriver` / `createChatClient`) keep the
  conservative `false` default; only the `ocp` binary flips.
  Pre-1.1 users with `OCP_DEFAULT_SKIP_PERMS=1` exported see no
  change; the env is now a no-op.
- **Folder-trust dialog is auto-accepted by default.** Same
  rationale: a `claude` dialog asking "Do you trust this folder?"
  is unanswerable from PTY automation. Opt out via
  `OCP_NO_AUTO_ACCEPT_TRUST=1`.
- **Abort completions no longer leak PTY noise.**
  When `completionReason` is in
  `{timeout, interactive-required, trust-required, cancelled, write-failed, upstream-exited}`:
  - The `text` adapter writes nothing to stdout (was: accumulated
    PTY junk).
  - The `stream-json` adapter emits only `system/init` +
    `result.subtype=error` (was: also an `assistant` frame with the
    PTY-extracted blob).
  - The `printStalledOutput` PTY tail is omitted by default
    (was: emitted to stderr including the caller's prompt back-echo).
- **`cleanResponse` scrubs HUD chrome.** Additional patterns added
  for claude-hud counters, MCP-auth banners, paste placeholders,
  and `Context ░░░░ N%` meters. Inline fragments are removed
  without dropping the surrounding line.
- **Permissive CLI defaults note in README** — `Recommended one-time
  setup` reduced to "None required". The post-1.0 opt-in envs
  (`OCP_AUTO_ACCEPT_TRUST=1`, `OCP_DEFAULT_SKIP_PERMS=1`) are now
  effectively no-ops; users keep them in `~/.zshrc` without effect,
  or remove them.

### Fixed

- **macOS realpath in `~/.claude/projects/<encoded-cwd>/` lookup.**
  Earlier versions used `path.resolve(cwd)` which is a string
  operation that does not follow symlinks. On macOS `/var`, `/tmp`,
  and other launchd-owned paths redirect to `/private/<…>`; `claude`
  itself resolves symlinks when picking its JSONL directory, so the
  driver was looking up a directory the upstream never wrote to.
  Net effect: any session under a `/var/` or `/tmp/` cwd had its
  session id capture fail silently, so `claudeSessionId` stayed
  `null`, `--resume` was never threaded between turns, and every
  call spawned a fresh conversation with no memory of the previous
  one. Fixed via `realpath` in `src/index.js` (driver), 
  `src/chat/index.js` (`readSessionText`), and `src/print-mode.js`.
- **Stale daemon socket on launch.** A SIGKILL'd daemon left
  `~/.ocp/d-*.sock` behind; the next launch's `server.listen` failed
  with `EADDRINUSE` and the client gave up and fell back to direct
  mode. The daemon now pre-unlinks the path before binding.
- **`readSessionText` strict-mode fallback.** When the caller passes
  a `sessionId`, the function no longer scans neighbouring JSONLs in
  the project dir on miss. Under concurrent load (another claude
  session active in the same cwd, an editor's built-in agent, …)
  the scan picked the most-recently-modified file and returned
  someone else's transcript as the "model's response". Strict mode
  returns `null` on miss instead.
- **GUI-app install of `ocp`.** The postinstall script rewrites the
  shebang in `bin/cli.js` from `#!/usr/bin/env node` to the absolute
  path of the node binary that ran the install (`process.execPath`).
  Without this, launching `ocp` from a launchd-managed GUI process
  (Electron, Tauri, native Cocoa) — which gets `/usr/bin:/bin` as
  PATH and never sees nvm / homebrew node — fails with
  `env: node: No such file or directory` before our code runs.
- **`stream-json` adapter** now opens with `system/init` even when
  no session id was captured (regression-proofs consumer parsers
  expecting the init line as the first event regardless of
  completion outcome).

### Security

- **Default CLI permission posture is permissive.** Documented
  prominently in README under "Recommended one-time setup". The
  flip is correct for personal workstations and controlled service
  accounts whose prompts are authored by the operator, but the
  CLI is unsafe to wire up to untrusted prompt input (public
  chatbots, prompt-injection-prone RAG, …) without
  `--allowed-tools`, `OCP_NO_SKIP_PERMS=1`, or per-call validation
  on top.
- **`printStalledOutput` redacts prompt back-echo** when emitted.
  When the captured PTY tail is included (now opt-in via
  `OCP_DUMP_STALL=1` or `--debug`), lines that overlap the caller's
  prompt by ≥24 characters are replaced with
  `[prompt echo redacted]` so RAG context glued into the prompt
  does not leak into error logs.

---

## [1.0.0] — 2026-XX-XX

Initial release.

### Added

- `ocp` CLI binary — argv-compatible shim for `claude -p`. `-p` /
  `--print` are implicit; `ocp "…"` is equivalent to
  `claude -p "…"`.
- Output adapters: `text` (default), `json`, `stream-json` (NDJSON).
- Driver (`createDriver`, `runOneShot`) — node-pty-backed PTY layer
  that drives the interactive `claude` CLI and parses the output
  stream to produce headless-mode-equivalent results.
- Chat SDK (`createChatClient`) — high-level wrapper with
  per-conversation state, file-backed transcript store, skill
  invocation, and JSONL session-file extraction.
- Warm daemon under `~/.ocp/d-<hash>.sock` so subsequent calls in
  the same cwd skip the 2.5 s PTY warmup. Idle timeout via
  `OCP_DAEMON_IDLE_MS` (default 10 min).
- Hard timeout via `OCP_MAX_RESPONSE_MS` (default 24 h).
- First-response watchdog `OCP_FIRST_RESPONSE_MS` (default 20 s)
  for fast `interactive-required` failure when an unrecognised
  dialog blocks the prompt box.
- Folder-trust auto-accept opt-in via `OCP_AUTO_ACCEPT_TRUST=1`.
- Permission-bypass opt-in via `OCP_DEFAULT_SKIP_PERMS=1`.
- Default `--allowed-tools` pre-approval for `WebSearch` and
  `WebFetch` (opt out: `OCP_NO_DEFAULT_TOOLS=1`).
- Default `--append-system-prompt` encouraging tool use (opt out:
  `OCP_NO_DEFAULT_PROMPT=1`).
- Localised READMEs: Korean, Japanese, Chinese.

[1.1.0]: https://github.com/empty-user77/open-claude-p/releases/tag/v1.1.0
[1.0.0]: https://github.com/empty-user77/open-claude-p/releases/tag/v1.0.0
