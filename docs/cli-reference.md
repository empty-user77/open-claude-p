# CLI Reference

Complete reference for the `ocp` command.

> **Quick start**: see the [main README](../README.md). This page enumerates
> every flag and environment variable.

---

## Usage

```
ocp [options] [prompt]
echo "<prompt>" | ocp [options]
```

`ocp` is `claude -p`–compatible: any argv that works with `claude -p`
works with `ocp`. Unknown flags are forwarded to the upstream `claude`
process (subject to the [argv sanitizer](#argv-sanitizer-and-pass-through)
below).

If `<prompt>` is omitted, stdin is consumed instead.

---

## Recommended defaults for everyday CLI use

Drop these in your shell rc once. With both set, `ocp "…"` just works for
weather / search / file tool use — the same behavior the sample chat shows
in the browser.

```bash
# ~/.zshrc (or ~/.bashrc)
export OCP_AUTO_ACCEPT_TRUST=1   # auto-accept "do you trust this folder?" dialog
export OCP_DEFAULT_SKIP_PERMS=1  # default --dangerously-skip-permissions for the CLI
```

Without `OCP_DEFAULT_SKIP_PERMS`, each tool call (WebSearch, Bash, Read,
Write, …) blocks on a permission prompt that PTY automation cannot
answer — claude then replies with "I don't have access to that tool"
instead of actually using it.

---

## Options

### Output

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--output-format <text\|json\|stream-json>` | enum | `text` | Format of stdout. `text` emits clean assistant markdown (default). `json` emits a single result object. `stream-json` emits NDJSON events as they happen. |
| `--input-format <text\|stream-json>` | enum | `text` | Format of stdin. `stream-json` reads NDJSON user messages and feeds them as a multi-turn conversation. |
| `-p, --print` | boolean | — | Compatibility no-op. `ocp` is always non-interactive; the flag is accepted to keep `claude -p` argv portable. |
| `--print-mode` | boolean | off | Spawn `claude --print` directly via `child_process` instead of driving a PTY. Raw markdown reaches the caller unchanged. **Trade-offs**: tool prompts unavailable; MCP servers are known to hang in print mode. |
| `--verbose` | boolean | off | Verbose mode of the upstream CLI. Forwarded. |

### Model & prompt

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--model <alias\|id>` | string | upstream default | Model alias (`sonnet`, `haiku`, `opus`) or full id (`claude-sonnet-4-6`). |
| `--system-prompt <text>` | string | — | Override the upstream system prompt entirely. |
| `--append-system-prompt <text>` | string | (see below) | Appended to the upstream system prompt. When `--dangerously-skip-permissions` is on and no value supplied, ocp auto-injects `"For real-time information (weather, news, prices, scores, …) use WebSearch immediately without asking."` so tools actually get used. |
| `--max-turns <n>` | int | — | Stop after this many assistant turns. |
| `--max-budget-usd <usd>` | float | — | Stop when accumulated cost exceeds this budget. (Accepted; enforcement depends on the upstream cost stream.) |
| `--task-budget <tokens>` | int | — | Same idea, in tokens. |

### Permissions / tools

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--dangerously-skip-permissions` | boolean | off (see `OCP_DEFAULT_SKIP_PERMS`) | Skip every tool-permission prompt in the upstream CLI. Required for most non-interactive tool use because PTY automation cannot click "Yes". |
| `--allowed-tools <name…>` | array | — | Restrict claude to the listed tool names. |
| `--disallowed-tools <name…>` | array | — | Block specific tools. |

### Session continuation

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--resume <session-id>` | string | — | Resume a specific upstream session by its UUID. |
| `--continue` | boolean | off | Resume the most recent session in this cwd. |
| `--fork-session` | boolean | off | Branch off a new session from the resumed point, preserving the original. |
| `--no-session-persistence` | boolean | off | Do not write a JSONL session file. The conversation cannot be resumed later. |
| `--resume-session-at <iso8601>` | string | — | Resume at a specific point in the session timeline. |
| `--rewind-files` | boolean | off | When resuming, also rewind file edits made after the resume point. |
| `--session-id <uuid>` | string | — | Force the session id of a new session. |
| `--name <label>` | string | — | Label this session in the upstream's session list. |

### Lifecycle / debug

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--debug` | boolean | off | Forwarded to upstream and turns on extra ocp logging on stderr. Argv values (e.g. `--system-prompt`, `--resume <uuid>`, `--mcp-config <path>`) are redacted in the log so debug output is safe to paste into bug reports. |
| `--cwd <path>` | string | `process.cwd()` | Spawn `claude` in this working directory. Affects which `~/.claude/projects/<encoded-cwd>/` the session JSONL lands in. |
| `--no-meta` | boolean | off | Hide the trailing meta line (duration · input/output tokens · USD cost · tools) printed to stderr after the response. Same effect as `OCP_NO_META=1`. The meta line is only ever printed when stderr is a TTY. |
| `-h, --help` | boolean | — | Print help to stdout. |
| `-V, --version` | boolean | — | Print `ocp <version>` to stdout. |

---

## Environment variables

### Trust & defaults

| Variable | Default | Effect |
|----------|---------|--------|
| `OCP_AUTO_ACCEPT_TRUST` | unset | When `=1`, auto-accept the upstream "Do you trust this folder?" dialog on first use in a new cwd. Without this, ocp aborts fast (exit code 6) and shows the dialog so you can handle it manually with `claude` directly. |
| `OCP_DEFAULT_SKIP_PERMS` | unset | When `=1`, default `--dangerously-skip-permissions` to on for the CLI. **Security cost is real**: every `ocp "…"` then executes Bash / Write / Edit / WebFetch on the prompt without per-tool confirmation. Set this in a personal workstation's shell rc only — **never** in CI, never in a shared shell, never in a project `.envrc` you would clone from an untrusted repo. CLI-only; library callers via `createDriver()` retain the safer default (`false`). Explicit `--dangerously-skip-permissions` always wins. |
| `OCP_NO_LIVE` | unset | When `=1`, disable the live spinner / phase indicator on stderr even when the terminal is a TTY. Useful when `--debug` output competes with the spinner for the same stderr stream. |
| `OCP_NO_META` | unset | When `=1`, suppress the trailing meta line (`⏱ … · ↑/↓ tok · $… · 🔧 …`). Equivalent to `--no-meta`. |
| `OCP_DEBUG` | unset | When `=1`, surface full stack traces from the top-level CLI catch (otherwise only `e.message`). Per-invocation `--debug` is the same thing. |

### Watchdogs / timing

| Variable | Default | Effect |
|----------|---------|--------|
| `OCP_WARMUP_MS` | `2500` | Settle delay between PTY spawn and the moment ocp starts looking for the input box. |
| `OCP_PROMPT_BOX_WAIT_MS` | `15000` | Max time to wait for the `❯` input chevron after warmup before sending the prompt anyway. Heavy hook / MCP loading may push this past the default; raise if your cwd has many `~/.claude/` integrations. |
| `OCP_PROMPT_BOX_SETTLE_MS` | `400` | Tiny settle after the chevron lands to avoid racing the cursor blink. |
| `OCP_FIRST_RESPONSE_MS` | `20000` | Once the prompt is written, max time to wait for a spinner / region-entered event before declaring `interactive-required`. |
| `OCP_MAX_RESPONSE_MS` | `86400000` (24 h) | Hard timeout for the whole request. In-flight idle / pre-idle silence detectors abort genuinely-stuck runs earlier; this is the worst-case ceiling. |
| `OCP_IDLE_MS` | `1500` | Idle silence threshold for completion after the sentinel has been seen. |
| `OCP_TRUST_SETTLE_MS` | `5000` | Extra wait after auto-accepting the folder-trust dialog so the TUI can transition to the main prompt box. |

### Upstream binary

| Variable | Default | Effect |
|----------|---------|--------|
| `OCP_CLAUDE_BIN` | `claude` | Path to the upstream `claude` binary. Useful when not on PATH or when targeting a specific install. **Trust boundary** — running ocp is equivalent to running this binary. |

### Daemon (background PTY)

| Variable | Default | Effect |
|----------|---------|--------|
| `OCP_NO_DAEMON` | unset | When `=1`, disable the daemon and spawn a fresh PTY for every call. |
| `OCP_DAEMON_IDLE_MS` | `600000` (10 min) | Daemon shuts down after this much idle time. |
| `OCP_MAX_DAEMONS` | `30` | Max concurrent active + idle terminals across all cwds. |
| `OCP_DAEMON_MAX_REQ_BYTES` | `4194304` (4 MB) | Cap on a single IPC request body (DoS protection against a same-user peer flooding the socket). |
| `OCP_DAEMON_SOCKET_TIMEOUT_MS` | `30000` | Per-connection idle timeout on the unix socket. |

### Pool

| Variable | Default | Effect |
|----------|---------|--------|
| `OCP_POOL_SIZE` | `0` | Number of warm PTY sessions to keep parked between calls. `0` means no pooling. |
| `OCP_POOL_MAX_AGE_MS` | — | Max age of a pooled session before it gets recycled. |

### Argv sanitizer escape hatch

| Variable | Default | Effect |
|----------|---------|--------|
| `OCP_ALLOW_UNSAFE_ARGV` | unset | When `=1`, disable the deny-list that blocks `--system-prompt-file`, `--mcp-config`, `--add-dir`, `--permission-mode`, `--dangerously-skip-permissions`, etc. from `passThroughArgv`. **Direct mode only** — the daemon explicitly strips this env to prevent surprise bypass via inherited shells. Run with `OCP_NO_DAEMON=1` to make it effective. |

---

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | OK |
| `1` | Generic error |
| `2` | Argv parse error |
| `3` | Validation error |
| `4` | Hard timeout (`OCP_MAX_RESPONSE_MS`) |
| `5` | Cancelled (SIGINT, AbortSignal) |
| `6` | Interactive prompt blocking input (`trust-required` / `interactive-required`). ocp's stderr will include the last 24 lines of the PTY screen so you can see exactly what claude is waiting on. |
| `8` | Not implemented (reserved) |

---

## Argv sanitizer and pass-through

Any argv flag ocp does not recognise is forwarded verbatim to the
upstream `claude` process. A small deny-list refuses a handful of flags
known to escalate trust regardless of intent — passing them via
`passThroughArgv` is rejected with a warning on stderr.

**Refused flags** (drop value too, where applicable):

```
--system-prompt-file        --append-system-prompt-file
--mcp-config                --strict-mcp-config
--settings                  --setting-sources
--add-dir                   --debug-file
--agents                    --plugin-dir
--dangerously-skip-permissions   --allow-dangerously-skip-permissions
--permission-mode           --permission-prompt-tool
--file                      --ide
```

Set `OCP_ALLOW_UNSAFE_ARGV=1` to disable the deny-list when you
genuinely need one of these (e.g. trusted controlled environments).

Note: the deny-list applies only to **unknown** argv. The same flag
exposed by ocp's own option spec (e.g. `--dangerously-skip-permissions`)
still works through its normal handling.

---

## Output formats

### `text` (default)

Clean markdown of the assistant's final reply, terminated by a single
newline. ocp prefers the upstream's own JSONL session file for this so
the output has no TUI artifacts. In an interactive TTY, a stderr
spinner (`⋯ Starting…` → `Sending prompt…` → `Receiving…` → claude's
own spinner) shows progress; stdout still receives only the final
clean blob. In pipe mode (`ocp … > out.txt`, `ocp … | jq`) no spinner
is emitted.

After the response, a one-line meta footer is printed to stderr (TTY
only) summarising the turn:

```
⏱ 42.8s · ↑41.2K ↓864 tok · $0.0287 · 🔧 Web Search, ToolSearch, WebSearch
```

Hide it with `--no-meta` or `OCP_NO_META=1`. In pipe mode the footer
is suppressed automatically so script consumers see only the response.

### `json`

A single JSON object with the result shape:

```json
{
  "type": "result",
  "subtype": "success",
  "session_id": "…",
  "result": "the assistant reply text",
  "duration_ms": 13205,
  "is_error": false
}
```

### `stream-json`

NDJSON events emitted as they happen. Three primary event types:

```jsonl
{"type":"system","subtype":"init","session_id":"…"}
{"type":"assistant","session_id":"…","message":{"content":[{"type":"text","text":"…"}]}}
{"type":"result","subtype":"success","session_id":"…","is_error":false}
```

Also `{"type":"assistant-partial","session_id":"…","delta":"…line…"}` for
per-line streaming as claude renders the response.

---

## Daemon

`ocp` runs a per-cwd background daemon that keeps a warm PTY alive
between invocations. Subsequent calls in the same cwd skip the 2.5 s
warmup and reuse the upstream session.

Daemon files live under `~/.ocp/` (mode `0700`, sockets `0600`).
Per-cwd state file `s-<hash>.json` persists the `sessionId` so that
even after the daemon idles out, a subsequent call resumes the same
conversation.

To bypass the daemon entirely for one call: `OCP_NO_DAEMON=1 ocp "…"`.
To kill all daemons: `pkill -f "daemon/server.js"`.

---

## Help text

`ocp --help` prints a condensed version of this reference. This document
is the canonical source.
