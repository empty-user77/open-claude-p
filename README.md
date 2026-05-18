**English** · [한국어](README.ko.md) · [中文](README.zh.md) · [日本語](README.ja.md)

[![npm](https://img.shields.io/npm/v/open-claude-p.svg)](https://www.npmjs.com/package/open-claude-p)
[![downloads](https://img.shields.io/npm/dm/open-claude-p.svg)](https://www.npmjs.com/package/open-claude-p)
[![stars](https://img.shields.io/github/stars/empty-user77/open-claude-p.svg)](https://github.com/empty-user77/open-claude-p/stargazers)
[![License](https://img.shields.io/npm/l/open-claude-p.svg)](https://github.com/empty-user77/open-claude-p/blob/main/LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ec1c8a?logo=github)](https://github.com/sponsors/empty-user77)

---

# open-claude-p (ocp)

A PTY-based compatibility layer that drives the interactive `claude` CLI via **node-pty**, providing the same functionality as `claude -p` (headless print mode) in environments where it is unavailable.

> **Key difference**: `claude -p` is Claude Code's non-interactive mode that operates through an internal API, but it is not available on certain plans/environments. `open-claude-p` runs the actual TUI client through a PTY and parses the output stream to achieve the same result.

---

**Version history**: see [CHANGELOG.md](./CHANGELOG.md).

---

## Table of Contents

- [Installation](#installation)
- [Recommended one-time setup](#recommended-one-time-setup)
- [Known Divergences from `claude -p`](#known-divergences-from-claude--p)
- [CLI Usage](#cli-usage) — full reference in [docs/cli-reference.md](./docs/cli-reference.md)
- [Daemon (Session Persistence)](#daemon-session-persistence)
- [SDK Usage](#sdk-usage) — full reference in [docs/sdk-reference.md](./docs/sdk-reference.md)
  - [High-level: createChatClient](#high-level-createchatclient)
  - [Low-level: createDriver](#low-level-createdriver)
- [Session Management](#session-management)
- [Working with JSONL Session Files](#working-with-jsonl-session-files)
- [About Output Parsing](#about-output-parsing)
- [Environment Variables](#environment-variables)
- [Full Option Reference](#full-option-reference)
- [Sample App](#sample-app)

---

## Installation

### npm

```bash
# Install as a project dependency
npm install open-claude-p

# Or install globally to use the `ocp` CLI anywhere
npm install -g open-claude-p
```

### From source (development)

```bash
# Clone and symlink from the project root
git clone https://github.com/empty-user77/open-claude-p.git
cd open-claude-p
npm link

# Or install via a local path from another project
npm install /path/to/open-claude-p
```

**Prerequisite**: The `claude` CLI must be installed and available on `PATH`.

```bash
# Verify Claude Code CLI installation
claude --version
```

---

## Recommended one-time setup

**None required in 1.1+.** The CLI defaults are now permissive: folder
trust is auto-accepted and `--dangerously-skip-permissions` is on.
A plain `npm install -g open-claude-p` then `ocp "…"` works.

If you specifically want claude's normal prompts back (knowing that
every tool call PTY automation can't answer will hang), opt out:

```bash
export OCP_NO_AUTO_ACCEPT_TRUST=1   # abort on "Do you trust this folder?" dialog
export OCP_NO_SKIP_PERMS=1          # restore claude's normal permission prompts
```

> ⚠️ With the default CLI settings, every `ocp "…"` invocation can
> execute Bash, Write, Edit, and other tools on whatever prompt you
> feed it, with no per-tool confirmation. This is correct for a
> personal workstation or a controlled service account whose prompts
> you author. **Never** wire it up where untrusted input becomes part
> of the prompt (public chatbots, prompt-injection-prone RAG, …)
> without first locking the surface down via `--allowed-tools`,
> `OCP_NO_SKIP_PERMS=1`, or per-call validation.
>
> The library defaults (`createDriver` / `createChatClient`) remain
> conservative — those callers are explicit about opting in to skip
> permissions.

See [docs/cli-reference.md](./docs/cli-reference.md) for the full env var list.

---

## Known Divergences from `claude -p`

`ocp` is an argv-compatible shim, not a byte-for-byte replacement. The
following cases produce different behaviour than running `claude -p`
directly with the same flags. Plan for these when integrating into a
consumer pipeline:

- **Sensitivity to `~/.claude.json` state.** The PTY layer renders the
  full upstream TUI banner on each spawn, including any "1 MCP server
  needs auth · /mcp", "auto mode unavailable for this model", and
  plugin-update notices the upstream chose to display. None of these
  block `claude -p` (which renders nothing). They don't block `ocp`
  either — `ocp` waits for a `⏺` or spinner event before declaring the
  upstream "alive" — but heavy notice traffic can push first-response
  latency past `OCP_FIRST_RESPONSE_MS` (default 20 s). Raise that env or
  remove unused MCP/plugin entries from `~/.claude.json` to avoid
  spurious `interactive-required` aborts.

- **Large prompts (>1 KB) take the chunked-write path.** Single
  multi-kilobyte `session.write` calls confuse the upstream TUI's paste
  detector — the trailing carriage return is consumed as paste content
  and the prompt is never submitted. `ocp` 1.1+ writes large prompts in
  ~256-char chunks with brief delays so paste detection does not fire.
  This adds ~50–500 ms to first-byte latency for large prompts. Switch
  to `OCP_PASTE_MODE=raw` for the pre-1.1 behaviour, or to
  `--input-format=stream-json` to bypass the TUI input box entirely.

- **Session persistence is on by default.** Every `ocp` turn writes a
  JSONL file under `~/.claude/projects/<encoded-cwd>/` exactly the same
  way `claude` does. Set `OCP_NO_SESSION_PERSISTENCE=1` (or
  `--no-session-persistence`) for stateless integrations that rebuild
  conversation history server-side every turn — otherwise the
  `~/.claude/projects/` directory accumulates one dead session file per
  turn and the `--continue` lookup picks unpredictable neighbours.

- **A warm daemon outlives the calling process by default.** `ocp`
  detaches a daemon under `~/.ocp/d-<hash>.sock` so subsequent calls in
  the same cwd skip the 2.5 s spawn warmup. The daemon exits after
  `OCP_DAEMON_IDLE_MS` (default 10 min) of inactivity. This is by
  design — but consumer apps that expect "child exits when I exit"
  semantics should either set `OCP_NO_DAEMON=1` or override the idle
  timeout to a smaller value.

- **Print-mode (`--print-mode` / `OCP_PRINT_MODE=1`) is the only path
  that bypasses the PTY entirely** and is functionally `claude --print`
  with argv pass-through. MCP servers, tool-permission prompts, and
  every other interactive surface are unavailable there — use it only
  as a fallback for environments where the PTY path regresses or for
  parity testing against upstream.

- **Aborts emit a structured error frame, not assistant text.** When a
  turn ends in `timeout`, `interactive-required`, `trust-required`,
  `cancelled`, `write-failed`, or `upstream-exited`, the `text` /
  `stream-json` adapter does NOT emit accumulated PTY content as the
  assistant reply. `claude -p` would have failed silently or echoed
  whatever it had at the time; `ocp` instead emits `result.subtype=
  error` with `completion=<reason>` and surfaces a `detected: <kind>`
  hint on stderr when a known dialog pattern matched.

## CLI Usage

The package installs a single binary: **`ocp`**.

When stderr is an interactive terminal, ocp shows a live spinner while
working and prints a one-line meta footer after the response:

```
⏱ 42.8s · ↑41.2K ↓864 tok · $0.0287 · 🔧 Web Search, ToolSearch, WebSearch
```

Hide it with `--no-meta` / `OCP_NO_META=1`. In pipe / redirect mode
both spinner and meta are suppressed automatically.

```bash
# Basic usage
ocp "Hello"

# Supports the same argv format as claude -p (-p flag is ignored for compatibility)
ocp -p "Hello"

# Read prompt from stdin
echo "What is the weather in Seoul?" | ocp

# Specify output format
ocp --output-format json "Answer in one word: apple"
ocp --output-format stream-json "Hi"

# Specify model
ocp --model sonnet "Complex question..."
ocp --model claude-opus-4-7 "Architecture review..."

# Append system prompt
ocp --append-system-prompt "Always reply in English" "what's the weather?"

# Resume a session — sessionId is printed to stderr
SID=$(ocp "Say only kiwi" 2>&1 >/dev/null | grep sessionId | grep -oE '[0-9a-f-]{36}')
ocp --resume "$SID" "What did you just say?"

# Or automatically continue the most recent session
ocp --continue "What did you just say?"

# Skip permission checks (for automation)
ocp --dangerously-skip-permissions "Read and analyze the file"
```

### Output Formats

#### `text` (default)

```
Hello! How can I help you today?
```

#### `json`

```json
{
  "result": "Hello! How can I help you today?",
  "session_id": "a1b2c3d4-...",
  "is_error": false,
  "cost_usd": null,
  "duration_ms": 4200,
  "num_turns": 1
}
```

#### `stream-json` (NDJSON)

Response is streamed line by line:

```jsonl
{"type":"system","subtype":"init","session_id":"a1b2c3d4-...","tools":[],"mcp_servers":[]}
{"type":"assistant","session_id":"a1b2c3d4-...","message":{"role":"assistant","content":[{"type":"text","text":"Hello!"}]}}
{"type":"result","subtype":"success","session_id":"a1b2c3d4-...","is_error":false,"duration_ms":4200}
```

---

## Daemon (Session Persistence)

The `ocp` CLI keeps PTY sessions alive through a **background daemon** by default.  
This means repeated calls in the same directory skip the 2.5-second warmup wait, and conversation context is automatically preserved.

```
ocp "First question"    → starts a new daemon if none exists, reuses if one does
ocp "Second question"   → connects to the same daemon, context is preserved
```

Daemon sockets are stored under `~/.ocp/`, **one per working directory**.

### Disabling the Daemon

```bash
OCP_NO_DAEMON=1 ocp "Run just once"   # spawns a PTY directly, no daemon
```

When you should skip the daemon:
- When using `--resume`, `--continue`, or `--fork-session` flags (automatically switches to direct mode)
- When using `--input-format=stream-json`
- For single isolated runs in CI/CD environments

### Daemon Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OCP_NO_DAEMON` | Set to `1` to disable the daemon | — |
| `OCP_DAEMON_IDLE_MS` | Auto-terminate daemon after this much idle time | `600000` (10 min) |
| `OCP_MAX_DAEMONS` | Maximum number of daemons to keep alive simultaneously | `30` |
| `OCP_DAEMON_MAX_PENDING` | Max queued requests per daemon socket; over → `busy` reply | `16` |
| `OCP_DAEMON_MAX_REQ_BYTES` | Per-request body cap | `4194304` (4 MiB) |
| `OCP_DAEMON_SOCKET_TIMEOUT_MS` | Idle timeout for a single daemon socket | `30000` |
| `OCP_DAEMON_SOCKET_MAX_LIFETIME_MS` | Hard cap on a single socket's total lifetime (slow-loris guard) | `300000` (5 min) |
| `OCP_DAEMON_MAX_RESPONSE_BYTES` | Client-side cap on bytes buffered from a single daemon reply | `67108864` (64 MiB) |
| `OCP_DAEMON_MAX_PARALLEL` | Max warm PTYs the daemon keeps for concurrent fresh requests | `8` |
| `OCP_NO_DEFAULT_PROMPT` | Set to `1` to suppress the CLI's default tool-use system prompt | — |
| `OCP_NO_DEFAULT_TOOLS` | Set to `1` to NOT pre-approve `WebSearch`/`WebFetch` | — |
| `OCP_DIR` | Override the daemon state directory | `~/.ocp` |

### Driver / Pool Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OCP_CLAUDE_BIN` | Path to the upstream `claude` binary | `claude` (PATH lookup) |
| `OCP_POOL_SIZE` | Default `poolSize` for `createDriver` | `0` (off) |
| `OCP_POOL_MAX_AGE_MS` | Max age of a pooled PTY before forced refresh | `600000` |
| `OCP_WARMUP_MS` / `OCP_REUSE_WARMUP_MS` | Per-spawn / reuse warmup wait | tuned defaults |
| `OCP_IDLE_MS` / `OCP_PRE_IDLE_MS` | Completion idle thresholds (post-sentinel / silence-only) | `1500` / `8000` |
| `OCP_FIRST_RESPONSE_MS` | Max wait for first byte after prompt submit | `120000` |
| `OCP_MAX_RESPONSE_MS` | Per-turn hard ceiling in ms. Default is intentionally long because in-flight idle / pre-idle silence detectors already abort genuinely-stuck runs much earlier. | `86400000` (24 h) |
| `OCP_TRUST_SETTLE_MS` | Pause after dismissing the trust prompt | tuned |
| `OCP_PROMPT_BOX_WAIT_MS` / `OCP_PROMPT_BOX_SETTLE_MS` | Wait for prompt box / settle after type | tuned |
| `OCP_AUTO_ACCEPT_TRUST` | Auto-accept the "trust this folder" dialog | `0` |
| `OCP_DEFAULT_SKIP_PERMS` | Auto-pass `--dangerously-skip-permissions` | `0` |
| `OCP_NO_LIVE` | Suppress live spinner / progress in CLI | `0` |
| `OCP_NO_META` | Suppress the post-turn meta line in CLI | `0` |
| `OCP_NO_WARN` | Mute non-fatal driver warnings to stderr | `0` |
| `OCP_DEBUG` | Verbose debug logging (path takes precedence over flag) | `0` |
| `OCP_PRINT_MODE` | Force print-mode codepath | `0` |
| `OCP_END` | Sentinel string the driver appends to detect completion | internal |
| `OCP_ALLOW_UNSAFE_ARGV` | **Security-sensitive.** Disable argv sanitizer (control-char / `--` stripping). Daemon refuses this var; CLI prints a warning. Only set for trusted, ephemeral invocations. | `0` |

### Chat SDK Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OCP_MAX_CONVERSATIONS` | Hard cap on conversations kept in the JSON store | `500` |
| `OCP_MAX_MESSAGES_PER_CONV` | Hard cap on messages per conversation | `500` |
| `OCP_MAX_MESSAGE_CHARS` | Reject `chat.send` messages larger than this | `262144` (256 KiB) |
| `OCP_MAX_JSONL_BYTES` | Tail-read cap for `~/.claude/projects/.../*.jsonl` | `8388608` (8 MiB) |
| `OCP_MAX_STDIN_BYTES` | CLI stdin payload cap | `262144` |
| `OCP_LOCK_SWEEP_AGE_MS` | Drop sentinel files older than this from the lock dir | `86400000` (24 h) |

---

## SDK Usage

Two layers ship in the same `open-claude-p` package — pick whichever
matches your altitude:

| Layer | Import | For |
|-------|--------|-----|
| **High-level chat client** | `open-claude-p/chat` | Build a chat UI / app. Brings conversation persistence, skill loading, JSONL clean-text, cost calc. |
| **Low-level driver** | `open-claude-p` | One-shot PTY runs with full control. |

Full API: [docs/sdk-reference.md](./docs/sdk-reference.md).

### High-level: `createChatClient`

The same SDK the bundled sample chat server uses. One import gives you
conversation state, multi-turn `--resume`, skill loading, JSONL clean
markdown, and per-turn cost / token / tool tracking.

```js
import { createChatClient } from 'open-claude-p/chat';

const chat = createChatClient({
  // dbPath: './conversations.json',   // default: <cwd>/conversations.json
  // skillsDir: '~/.claude/skills',     // default: ~/.claude/skills
  dangerouslySkipPermissions: true,    // let claude actually use its tools
  // appendSystemPrompt: 'extra rules', // appended on top of SDK base default
  //                                    // (null to opt the base out entirely)
});

// New conversation
const r1 = await chat.send({
  message: 'What is the weather in Seoul right now?',
  onEvent(ev) {
    if (ev.type === 'spinner')        process.stderr.write(`[…] ${ev.label}\n`);
    if (ev.type === 'assistant-text') process.stdout.write(ev.text);
  },
});
console.log(r1.text);                  // clean markdown
console.log(r1.meta);                  // { elapsedMs, inputTokens, outputTokens, costUsd, tools }

// Continue the same conversation
const r2 = await chat.send({
  conversationId: r1.conversationId,
  message: 'And tomorrow?',
});

// CRUD
await chat.listConversations();        // [{ id, title, ... }]
await chat.getConversation(r1.conversationId);
await chat.deleteConversation(r1.conversationId);
await chat.listSkills();               // [{ name, description }]

await chat.close();
```

Also exported from the same module: `readSessionText` (read JSONL clean
markdown), `cleanResponse` (TUI chrome strip), `cleanSpinnerLabel`,
`isAssistantTextNoise`, `extractToolName`. See the
[SDK reference](./docs/sdk-reference.md#standalone-helpers-also-exported-from-open-claude-pchat).

### Low-level: `createDriver`

For one-shot PTY runs with no conversation state or higher-level helpers.

### `createDriver(opts?)`

Creates a driver. Share a single driver instance across your entire application.

```js
import { createDriver } from 'open-claude-p';

const driver = createDriver({
  claudeBin:      'claude',     // path to claude binary (default: claude on PATH)
  warmupMs:       2500,         // PTY initialization wait time (ms)
  reuseWarmupMs:  200,          // wait time when reusing from pool (ms)
  idleMs:         1500,         // silence wait after response completes (ms)
  preIdleMs:      8000,         // minimum wait before sentinel matching (ms)
  maxResponseMs:  86_400_000,   // hard timeout (ms), default 24 h (idleMs/preIdleMs abort earlier)
  poolSize:       0,            // PTY pool size (0=disabled, N>0=keep N warmed up)
  poolMaxAgeMs:   600_000,      // maximum pool session lifetime (ms)
  cwd:            process.cwd(), // working directory
  env:            {},           // additional environment variables
  debug:          false,        // print debug logs to stderr
});
```

### `runOneShot(req)`

Sends a single prompt to Claude and waits for the response.

```js
const result = await driver.runOneShot({
  prompt: 'What is the current weather in Seoul?',

  // ── Model / Behavior ──────────────────────────
  model: 'sonnet',                        // model name
  effort: 'high',                         // 'low' | 'medium' | 'high' | 'max'
  thinking: 'adaptive',                   // 'enabled' | 'adaptive' | 'disabled'
  maxTurns: 5,                            // max agent turns (shim-enforced)

  // ── System Prompt ─────────────────────────────
  systemPrompt: 'You are a weather expert',  // replace entire system prompt
  appendSystemPrompt: 'Always reply in English',  // append to default prompt

  // ── Permissions / Tools ───────────────────────
  dangerouslySkipPermissions: true,        // skip permission checks
  allowedTools: ['WebSearch', 'Read'],     // tool whitelist
  disallowedTools: ['Bash'],               // tool blacklist

  // ── Session ───────────────────────────────────
  resume: 'a1b2c3d4-...',                  // resume from previous session UUID
  continue: false,                         // continue most recent session
  forkSession: false,                      // create a new session ID on resume

  // ── Working Directory ─────────────────────────
  cwd: '/path/to/project',

  // ── Cancellation ──────────────────────────────
  abortSignal: controller.signal,

  // ── Real-time Event Callback ──────────────────
  onEvent(ev) {
    // called in real time as the response is generated
    // see "Event Types" section below
    if (ev.type === 'assistant-text') {
      process.stdout.write(ev.text);
    }
  },
});
```

### Return Value: OneShotResult

When `runOneShot()` resolves, it returns an object with the following structure:

```ts
{
  // ── Core Result ────────────────────────────────────────────────────
  text: string,
  // Claude's final response text (TUI artifacts removed).
  // Raw text as Claude produced it — markdown, HTML, code blocks, etc.
  // Rendering/parsing is the caller's responsibility.

  sessionId: string | null,
  // Claude session UUID for this request.
  // Use with --resume <sessionId> to continue the conversation.
  // Falls back to filesystem scan of ~/.claude/projects/ if banner capture fails.

  isError: boolean,
  // true = completed with error or timeout

  completionReason: string,
  // How the request completed:
  //   'sentinel'         normal completion (sentinel string detected)
  //   'idle'             silence timeout after response
  //   'prompt-box'       TUI input box reappeared
  //   'timeout'          maxResponseMs exceeded
  //   'max-turns'        maxTurns limit reached
  //   'upstream-exited'  claude process exited first
  //   'write-failed'     PTY write failed
  //   'cancelled'        cancelled via AbortSignal

  exitCode: number,
  // 0 = success, 1 = error

  // ── Event Array ───────────────────────────────────────────────────
  events: Array<object>,
  // All events produced by the pipeline (same objects as onEvent callback).
  // See "Event Types" section below.

  // ── Performance Metrics ───────────────────────────────────────────
  durationMs: number,
  // Total elapsed time (ms)

  cost: { totalUsd: number | null, numTurns: number | null },
  // Currently null (cost info is not directly available from PTY).
  // For accurate token/cost data, read the JSONL session file (see below).

  diagnostics: { rawBytes: number, strippedBytes: number },
  // Raw bytes received from PTY / bytes after ANSI stripping
}
```

### Event Types (onEvent callback)

The `onEvent` callback and `result.events` array contain events of the following types:

```ts
// When Claude starts responding (⏺ marker detected)
{ type: 'assistant-region-entered', n: number }

// When the response region closes (hr or sentinel detected)
{ type: 'assistant-region-exited', n: number }

// One line of response text (real-time streaming)
{
  type: 'assistant-text',
  text: string,   // one line of text (raw markdown)
  region: number  // which response region (higher = later; useful when resuming)
}

// Claude session UUID detected (from banner or exit message)
{ type: 'session-id', id: string }

// TUI spinner (indicates Claude is working)
// label: "Searching the web...", "Reading file...", "Cogitated for 25s", etc.
{ type: 'spinner', label: string }

// TUI input box appeared on screen (one of the completion signals)
{ type: 'prompt-box-shown' }

// Sentinel string detected (normal completion)
{ type: 'sentinel' }
```

#### Event Usage Example

```js
const result = await driver.runOneShot({
  prompt: 'Analyze this long document',
  onEvent(ev) {
    switch (ev.type) {
      case 'assistant-text':
        // real-time streaming — print line by line
        process.stdout.write(ev.text + '\n');
        break;

      case 'spinner':
        // spinner label — shown while a tool is in use (e.g. "Searching the web...")
        process.stderr.write(`\r⏳ ${ev.label}   `);
        break;

      case 'session-id':
        // save session ID early so you can resume even if a timeout occurs
        saveSessionId(ev.id);
        break;
    }
  },
});

// Full text can also be reconstructed from events
const lines = result.events
  .filter(e => e.type === 'assistant-text' && e.region === Math.max(...result.events.filter(e => e.type === 'assistant-text').map(e => e.region)))
  .map(e => e.text);
```

---

## Session Management

Claude identifies each session with a UUID, which you can use to resume previous conversations.

```js
// 1. First request — start a new session
const result1 = await driver.runOneShot({
  prompt: 'Implement Fibonacci in Python',
});
console.log('Session ID:', result1.sessionId);
// → "a1b2c3d4-5678-..."

// 2. Resume session — previous conversation context is preserved
const result2 = await driver.runOneShot({
  prompt: 'Now rewrite that without recursion using iteration',
  resume: result1.sessionId,
});

// 3. Fork session — explore a different direction while preserving the original
const result3 = await driver.runOneShot({
  prompt: 'Instead, make a generator version',
  resume: result1.sessionId,
  forkSession: true,   // assigns a new UUID, original session is preserved
});
```

---

## Working with JSONL Session Files

The Claude CLI saves each session as a JSONL file at:

```
~/.claude/projects/<cwd-encoded-as-path>/<session-uuid>.jsonl
```

For example, if `cwd` is `/Users/alice/myproject`:  
→ `~/.claude/projects/-Users-alice-myproject/<uuid>.jsonl`

These files contain **token usage, cost, and tool usage metadata** that is not available in the PTY output.

```js
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function readSessionMeta(sessionId, cwd = process.cwd()) {
  const key = path.resolve(cwd).replace(/\//g, '-');
  const filePath = path.join(os.homedir(), '.claude', 'projects', key, `${sessionId}.jsonl`);
  const lines = (await readFile(filePath, 'utf8')).split('\n').filter(Boolean);

  // Extract usage from the last assistant message
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      if (ev.message?.role === 'assistant') {
        const textBlock = ev.message.content?.find(c => c.type === 'text');
        return {
          text: textBlock?.text,     // clean markdown text (no TUI artifacts)
          usage: ev.message.usage,   // { input_tokens, output_tokens, cache_read_input_tokens, ... }
          timestamp: ev.timestamp,
        };
      }
    } catch {}
  }
  return null;
}

const meta = await readSessionMeta(result.sessionId);
// meta.usage.input_tokens  → input tokens
// meta.usage.output_tokens → output tokens
// meta.usage.cache_read_input_tokens → cache read tokens
// meta.usage.server_tool_use.web_search_requests → web search count
```

### What You Can Get from JSONL

| Item | PTY result.text | JSONL |
|------|----------------|-------|
| Response text | ✅ (may have TUI artifacts) | ✅ (clean markdown) |
| Input token count | ❌ | ✅ |
| Output token count | ❌ | ✅ |
| Cache token count | ❌ | ✅ |
| Cost calculation | ❌ | ✅ (tokens × unit price) |
| Web search count | ❌ | ✅ |
| Timestamps | ❌ | ✅ |
| Tool usage details | Partial (events) | ✅ |

---

## About Output Parsing

**`result.text` is the raw markdown/text produced by Claude.**  
It is an open format — rendering, parsing, and display are your responsibility.

```
result.text example:
─────────────────────────────────────
# Fibonacci Sequence

Here is how to implement Fibonacci in Python:

```python
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
```

- Time complexity: O(n)
- Space complexity: O(1)
─────────────────────────────────────
```

### Parsing Implementation Reference

The `renderMarkdown()` function in `sample/public/app.js` is a parsing example for web UIs.  
Implement your own based on your target environment:

```js
// Web UI → HTML rendering (example)
import { marked } from 'marked';
const html = marked.parse(result.text);

// Terminal → ANSI color rendering (example)
import { renderMarkdown } from 'cli-markdown';
console.log(renderMarkdown(result.text));

// Pass to another LLM → use as-is
const nextPrompt = `Previous response: ${result.text}\n\nNow proceed to the next step`;
```

### On TUI Artifacts

`result.text` has TUI rendering residue removed as much as possible by ocp, but it may not be perfect.  
If you need cleaner text, reading from the **JSONL session file** is recommended (see above).

---

## Environment Variables

Most-used:

| Variable | What |
|----------|------|
| `OCP_NO_AUTO_ACCEPT_TRUST=1` | Disable the 1.1 default of auto-accepting the "Do you trust this folder?" dialog. Set if you want the upstream dialog to abort the call (the pre-1.1 behaviour). |
| `OCP_NO_SKIP_PERMS=1` | Disable the 1.1 CLI default of `--dangerously-skip-permissions`. Set if you want claude's normal permission prompts (they will hang every tool call PTY automation can't answer). |
| `OCP_NO_SESSION_PERSISTENCE=1` | Skip writing the per-turn JSONL session file. For stateless integrations that rebuild context every turn. |
| `OCP_NO_LIVE=1` | Disable the live spinner on stderr |
| `OCP_NO_META=1` | Hide the trailing meta footer (`⏱ … · 🔧 …`) |
| `OCP_NO_DAEMON=1` | Fresh PTY for every call (no warm daemon) |
| `OCP_DAEMON_IDLE_MS` | How long the warm daemon survives between calls before exiting. Default `600000` (10 min). |
| `OCP_MAX_RESPONSE_MS` | Hard timeout in ms, default `86400000` (24 h) |
| `OCP_FIRST_RESPONSE_MS` | Fail-fast if no progress within N ms after prompt, default `20000` |
| `OCP_PROMPT_BOX_WAIT_MS` | Max wait for the input chevron, default `15000` (raise for heavy hook/MCP loading) |
| `OCP_PASTE_MODE` | How large prompts are written to the TUI: `auto` (default) chunks prompts above the threshold; `chunk` always chunks; `bracket` wraps with xterm bracketed-paste markers; `raw` is pre-1.1 atomic write |
| `OCP_PASTE_THRESHOLD` | Byte threshold above which `auto` paste mode kicks in. Default `1024` |
| `OCP_DUMP_STALL=1` | Include the captured PTY screen tail in the abort stderr message. Default off (the tail can echo the caller's prompt). |
| `OCP_CLAUDE_BIN` | Path to upstream `claude` binary, default `'claude'` |

Full table (timeouts, pool, daemon, sanitizer escape hatch, etc.):
[docs/cli-reference.md#environment-variables](./docs/cli-reference.md#environment-variables).

```bash
# Tighten per-turn timeout to 10 minutes (default is 24 h)
OCP_MAX_RESPONSE_MS=600000 ocp "Complex task..."

# Single run without daemon
OCP_NO_DAEMON=1 ocp "Run just once"
```

---

## Full Option Reference

Quick mapping between `runOneShot(req)` request fields and CLI flags
appears below; the canonical, fully-described table is in
[docs/cli-reference.md#options](./docs/cli-reference.md#options).

| req field | CLI flag | Type | Description |
|-----------|----------|------|-------------|
| `model` | `--model` | string | Model name (e.g. `sonnet`, `claude-sonnet-4-6`) |
| `systemPrompt` | `--system-prompt` | string | Replace entire system prompt |
| `appendSystemPrompt` | `--append-system-prompt` | string | Append to default system prompt |
| `dangerouslySkipPermissions` | `--dangerously-skip-permissions` | boolean | Skip permission checks |
| `allowedTools` | `--allowed-tools` | string[] | Tool whitelist |
| `disallowedTools` | `--disallowed-tools` | string[] | Tool blacklist |
| `resume` | `--resume` / `-r` | string | Resume from session UUID |
| `continue` | `--continue` / `-c` | boolean | Continue most recent session |
| `forkSession` | `--fork-session` | boolean | Create new session ID on resume |
| `sessionId` | `--session-id` | string | Assign a specific UUID to the new session |
| `noSessionPersistence` | `--no-session-persistence` | boolean | Disable session saving |
| `effort` | `--effort` | enum | `low` \| `medium` \| `high` \| `max` |
| `thinking` | `--thinking` | enum | `enabled` \| `adaptive` \| `disabled` |
| `maxTurns` | `--max-turns` | number | Maximum agent turns |
| `fallbackModel` | `--fallback-model` | string | Fallback when primary model is overloaded |
| `permissionMode` | `--permission-mode` | string | `default` \| `plan` \| `acceptEdits` \| `bypassPermissions` |
| `mcpConfig` | `--mcp-config` | string[] | MCP config paths |
| `addDir` | `--add-dir` | string[] | Additional directories tools can access |
| `bare` | `--bare` | boolean | Minimal mode (disables hooks, LSP, plugins, etc.) |
| `debug` | `--debug` | boolean | Print debug logs to stderr |
| `verbose` | `--verbose` | boolean | Verbose output |
| `cwd` | `--cwd` | string | PTY process working directory |
| `abortSignal` | — | AbortSignal | Cancellation signal |
| `onEvent` | — | function | Real-time event callback |
| `passThroughArgv` | — | string[] | Additional argv passed directly to claude |

---

## Sample App

A small web chat UI built on top of `open-claude-p/chat`. The source
lives under `sample/` in the upstream git repo and is **not bundled
into the npm tarball** — the package ships a companion `ocp-sample`
CLI that downloads the demo on demand. This keeps the published
install small while making the demo a one-line try.

### Quick start

```bash
npm install -g open-claude-p          # one time
ocp-sample init demo                   # download + npm install
cd demo
ocp-sample start                       # → http://localhost:3000

# When you're done:
ocp-sample stop
```

### What `init` does

1. Shallow-clones the upstream repo into a temp directory.
2. Copies the `sample/` subtree to `./<name>/` (default `./ocp-sample/`).
3. Rewrites the dev-only `"open-claude-p": "file:.."` dep in the
   copied `package.json` to a real semver range pinned against the
   version of `ocp-sample` doing the work (so the demo always
   matches the CLI that scaffolded it).
4. Runs `npm install --no-audit --no-fund`.
5. Attempts `npm link open-claude-p` — silent no-op when no global
   link exists; when one does, the demo runs against your local
   `open-claude-p` source instead of the registry copy.

### Subcommands

| Command | What |
|---------|------|
| `ocp-sample init [name]` | Download + install the demo into `./<name>/` (default `ocp-sample`). Refuses if the directory exists and is non-empty. |
| `ocp-sample start [--port=N]` | Spawn `node server.js` detached from CWD. Writes PID to `.ocp-sample.pid`, appends stdout/stderr to `.ocp-sample.log`. `PORT` env also honoured. |
| `ocp-sample stop` | SIGTERM the running PID (5 s grace, then SIGKILL). |
| `ocp-sample status` | Print `running` / `stopped` plus PID + URL. |

### Files written in the cwd

```
demo/
├── .ocp-sample.pid    PID of the running server (start writes, stop deletes)
├── .ocp-sample.log    Detached server's stdout/stderr (appended)
├── server.js          Express + ocp/chat
├── package.json
├── public/            Static chat UI (index.html, app.js, style.css)
└── node_modules/      Created by `npm install`
```

### Environment

| Variable | Effect |
|----------|--------|
| `PORT` | Override the default port (3000) for `start`. Same as `--port=N`. |
| `NO_COLOR=1` | Disable ANSI colours and the spinner — useful in CI and log captures. |
| `OCP_SAMPLE_NO_TTY=1` | Same as `NO_COLOR=1`. |
| `OCP_SAMPLE_REPO` | Override the upstream git URL `init` clones from. Testing only. |

### Demo features

The demo is intentionally small but exercises the bits of the SDK
most consumer apps need:

- **Conversation persistence** via `chat.send` and `~/.claude/projects/<cwd>/<sid>.jsonl`
- **SSE streaming** of `assistant-text` / `spinner` / `done` events to the browser
- **Skill invocation** — typing `/<skill-name>` injects a `SKILL.md` from `~/.claude/skills/`
- **Process management** — list and abort in-flight requests via `/api/processes`
- **Markdown rendering** — a minimal client-side renderer so the chat bubbles show fenced code, headings, lists

See `demo/server.js` after `init` for the full surface; treat that
file as the canonical "how to wrap `open-claude-p/chat` in an
Express app" reference.

---

## Module Structure

```
src/
  index.js                Library public API (createDriver, runOneShot)
  options/
    spec.js               All option definitions (single source of truth)
    parse-argv.js         CLI argv parser
    validate.js           Cross-option validation
  parsers/
    ansi-strip.js         ANSI escape removal
    tui-frame.js          TUI frame parser (event generation)
    sentinel.js           Completion sentinel detection
    pipeline.js           Parser pipeline composition
  output/
    text.js               --output-format text adapter
    json.js               --output-format json adapter
    stream-json.js        --output-format stream-json adapter
  pty/
    session.js            Single PTY session lifecycle
    pool.js               Warmed-up PTY pool
  completion/
    detector.js           Completion detection (sentinel + idle + prompt-box)
bin/
  cli.js                  ocp CLI entry point
sample/
  server.js               Example web server
  public/                 Chat UI
```

---

## License

MIT
