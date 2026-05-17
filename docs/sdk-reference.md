# SDK Reference

Two layers ship in the same `open-claude-p` package:

| Layer | Import | Best for |
|-------|--------|----------|
| **High-level chat client** | `import { createChatClient } from 'open-claude-p/chat'` | Building a chat UI / app on top of the upstream CLI. Brings conversation persistence, skill loading, JSONL extraction, cost calc. |
| **Low-level driver** | `import { createDriver } from 'open-claude-p'` | Direct one-shot PTY runs, custom event handling, full control over forwarded options. |

The CLI binary (`ocp`) and the bundled sample server are both consumers
of the high-level chat client / low-level driver — they have no special
access. Anything they do, your code can do.

---

## High-level: `createChatClient`

```js
import { createChatClient } from 'open-claude-p/chat';

const chat = createChatClient({
  dangerouslySkipPermissions: true,   // let claude actually use its tools
});

const result = await chat.send({
  message: 'What is the weather in Seoul right now?',
  onEvent(ev) {
    if (ev.type === 'spinner') process.stderr.write(`[…] ${ev.label}\n`);
  },
});

console.log(result.text);
console.log(`cost: $${result.meta.costUsd.toFixed(4)}, tools: ${result.meta.tools.join(', ')}`);

await chat.close();
```

### `createChatClient(opts?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dbPath` | `string` | `<cwd>/conversations.json` | File-backed JSON store. Each project gets its own history by default. The SDK assumes it owns this file — pass a dedicated path you do not mind being overwritten with a JSON conversations array. Saved atomically (tmp + rename) at mode `0o600`. |
| `skillsDir` | `string` | `~/.claude/skills` | Where `<name>/SKILL.md` files live. Path is validated against traversal. |
| `dangerouslySkipPermissions` | `boolean` | `false` | Skip the upstream's tool-permission prompts (WebSearch, Bash, Read, Write, …). PTY automation cannot answer them, so leaving this off means the model usually refuses tool use. |
| `appendSystemPrompt` | `string \| null \| undefined` | `undefined` → SDK base default | The SDK ships a base default rule for this option — a one-sentence "be an interactive assistant that actually uses its tools" instruction. Your value is **appended** on top of the base default, not a replacement. Pass `null` to opt the base default out entirely. See [compose semantics](#appendsystemprompt-compose-semantics) below. |
| `pricing` | `object` | `DEFAULT_PRICING` (Sonnet 4.x rates) | `{ input, cacheWrite, cacheRead, output }` per-token USD rates. Also exported as `DEFAULT_PRICING` for direct reuse. |
| `driver` | `Driver` | — | Reuse an existing `createDriver()` instance. By default the client creates its own. |
| `driverOpts` | `object` | `{}` | Passed to `createDriver()` when no `driver` is supplied. |

> ⚠️ **Trust boundary on `appendSystemPrompt`** — text passed here lands
> in claude's system context verbatim, so anything wired into this
> field has system-prompt-level authority over the model's behaviour
> for that turn. **Never** pass untrusted end-user input through
> `appendSystemPrompt`; that would let end users inject system-level
> instructions. Keep this for your app's house rules; route user text
> through `message` instead.

### `appendSystemPrompt` compose semantics

| client-level (`createChatClient({...})`) | per-turn (`chat.send({...})`) | Effective system prompt |
|------|------|------|
| `undefined` | `undefined` | SDK base default only |
| `'X'` | `undefined` | SDK base default + `'X'` |
| `null` | `undefined` | empty (base default suppressed) |
| `undefined` | `'Y'` | SDK base default + `'Y'` |
| `'X'` | `'Y'` | SDK base default + `'X'` + `'Y'` |
| (anything) | `null` | empty (turn-level opt-out wins) |

The SDK base default text lives in `src/chat/index.js` —
`DEFAULT_APPEND_SYSTEM_PROMPT`. It is intentionally tool-agnostic
("use the appropriate available tools to look it up and answer with
the actual values") rather than a tool-by-tool recipe.

### Methods

#### `chat.send(req) → Promise<SendResult>`

```js
const result = await chat.send({
  conversationId: 'uuid-or-null',     // null → create new
  message: 'hello',
  skillName: 'my-skill',              // optional, must be alphanumeric+_-
  onEvent(ev) { /* spinner, assistant-text, … */ },
  signal: abortController.signal,     // cancel mid-flight
  maxResponseMs: 60_000,              // per-turn timeout override
  appendSystemPrompt: '…',            // per-turn override
});
```

Returns:

```ts
{
  conversationId: string,
  text: string,                       // clean markdown (JSONL-sourced when possible)
  isNew: boolean,                     // true if this call created the conversation
  isError: boolean,
  completionReason: 'sentinel' | 'timeout' | 'cancelled' | 'interactive-required' | 'trust-required' | 'upstream-exited',
  sessionId: string | null,
  meta: {
    elapsedMs: number,
    inputTokens: number | null,       // includes cache_creation + cache_read
    outputTokens: number | null,
    costUsd: number | null,
    tools: string[],                  // e.g. ['WebSearch', 'WebFetch']
  },
}
```

**Errors thrown** (check via `err.code === ChatErrorCodes.X`):

| `err.code`                  | Meaning                                                                              | Persistence            | Retry?              |
| --------------------------- | ------------------------------------------------------------------------------------ | ---------------------- | ------------------- |
| `ERR_INVALID_ID`            | `chat.deleteConversation()` called with non-string or empty `id`                     | not applicable          | caller bug — fix    |
| `ERR_INVALID_MESSAGE`       | `message` missing, empty, or non-string                                              | not persisted          | caller bug — fix    |
| `ERR_MESSAGE_TOO_LARGE`     | exceeds `OCP_MAX_MESSAGE_CHARS` (default 256 KiB)                                    | not persisted          | split & retry       |
| `ERR_CHAT_DRIVER_FAILED`    | wrapped upstream / driver failure (timeout, `interactive-required`, `trust-required`, PTY exit); `err.cause` set and `err.completionReason` carried through when available | persisted (Phase 1) but no assistant reply | inspect `cause`, decide per case |
| `ERR_CHAT_BUSY`             | cross-process lock contention after retries; `err.persisted === false`. Also emits a one-shot `ChatBusyDataLoss` Node warning. | **NOT persisted**      | safe to retry       |
| `ERR_CHAT_LOCK_LOST`        | proper-lockfile's mtime refresh failed mid-op (e.g. tmpdir cleared); `err.cause` set | partial — unknown      | retry; verify state |
| `ERR_CHAT_LOCK_TAMPERED`    | lock sentinel is a symlink / non-regular file                                        | not persisted          | investigate first   |
| `ERR_CHAT_LOCK_DIR_TAMPERED`| lock dir owned by another uid or is a symlink                                        | not persisted          | investigate first   |
| `ERR_CHAT_LOCK_FAILED`      | any other lock-acquire failure (EACCES on LOCK_DIR, ENOSPC on tmpdir, ENOTDIR, …) with `err.cause` preserved | not persisted | environment fix     |
| `ERR_CHAT_DBPATH_INVALID`   | `dbPath` cannot be canonicalised (EACCES on a parent dir, ELOOP symlink cycle, ENOTDIR component) | not persisted | fix the path        |
| `ERR_REENTRANT_SEND`        | `chat.send()` called from within another `chat.send()`'s `onEvent` (same `dbPath`)  | not persisted          | defer with `setImmediate` or use separate dbPath |
| `AbortError`                | `signal` was already aborted at entry                                                | not persisted          | caller intent       |
| `ERR_DAEMON_RESPONSE_TOO_LARGE` | (daemon mode only) IPC client buffered more than `OCP_DAEMON_MAX_RESPONSE_BYTES` (default 64 MiB) from one daemon reply; socket destroyed | n/a                  | raise the cap or shrink the reply (events/text/diagnostics) |

> **Notes**
> - `err.message` may embed the resolved `dbPath`. The bundled sample
>   server and daemon IPC both map non-allowlisted errors to generic
>   strings before transmitting, but third-party SDK consumers that
>   re-expose `err.message` over the network should redact it.
> - Re-entrancy detection uses `AsyncLocalStorage`. It does NOT
>   propagate across `worker_threads` or `child_process.fork()` — re-entry
>   from a worker bypasses the guard.
> - Cross-uid: each uid uses its own lock dir
>   (`os.tmpdir()/open-claude-p-locks-<uid>/`). Two users on the same
>   host sharing a group-writable `dbPath` will NOT serialise across
>   uids. Operate the store as single-user.
> - `ERR_CHAT_BUSY` also fires `process.emitWarning(..., { type: 'ChatBusyDataLoss' })`
>   on the first occurrence per process so structured loggers surface it
>   even if the caller swallows the throw.

```js
import { createChatClient, ChatErrorCodes } from 'open-claude-p/chat';

for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    return await chat.send({ message, conversationId });
  } catch (e) {
    if (e.code !== ChatErrorCodes.BUSY) throw e;
    await new Promise(r => setTimeout(r, 100 * attempt + Math.random() * 100));
  }
}
throw new Error('chat: still busy after 3 attempts');
```

Lock files live under `os.tmpdir()/open-claude-p-locks-<uid>/<sha256(realpath(dbPath))>.lock`.
Per-uid namespacing prevents cross-user lock enumeration and EACCES on
shared hosts; `realpath` canonicalisation ensures symlinked aliases of
the same DB serialise correctly. Same-conversation `send()` calls
serialise on a per-conversation lock; different conversations on the
same DB run their LLM calls in parallel and only serialise on the brief
load → mutate → save windows.

#### `chat.listConversations() → Promise<ConversationMeta[]>`

```ts
[{ id, title, createdAt, updatedAt, messageCount, claudeSessionId }, …]
```

#### `chat.getConversation(id) → Promise<Conversation|null>`

Full message history.

#### `chat.deleteConversation(id) → Promise<boolean>`

Returns `true` if removed, `false` if not found.

Throws the same lock-related `ChatErrorCodes` as `chat.send()`
(`ERR_CHAT_BUSY`, `ERR_CHAT_LOCK_LOST`, `ERR_CHAT_LOCK_TAMPERED`,
`ERR_CHAT_LOCK_DIR_TAMPERED`, `ERR_CHAT_LOCK_FAILED`,
`ERR_CHAT_DBPATH_INVALID`) because it acquires the same file lock for
the read-modify-write. `ERR_REENTRANT_SEND` does NOT apply (no
`onEvent` callback).

#### `chat.listSkills() → Promise<SkillInfo[]>`

```ts
[{ name, description }, …]
```

Reads `<skillsDir>/<name>/SKILL.md` and pulls the first `description:` frontmatter line.

#### `chat.close() → Promise<void>`

Tears down the underlying driver (and pooled PTYs) **if owned by this client**.
If you passed your own `driver`, close it yourself.

---

## Standalone helpers (also exported from `open-claude-p/chat`)

### Session-file extraction

| Export | Purpose |
|--------|---------|
| `readSessionText(sessionId, t0?, cwd?)` | Read the last assistant text + usage + tool list from `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. Falls back to the most-recently-modified JSONL written after `t0` when `sessionId` is null. Returns `{ text, usage, tools } \| null`. |
| `cleanResponse(text)` | Strip TUI chrome (prompt chars, box borders, statusline bars, mode indicators) from a PTY-stripped buffer. Use when the JSONL file is unavailable. |

### Event filters (shared with CLI text adapter and sample server)

| Export | Purpose |
|--------|---------|
| `cleanSpinnerLabel(label)` | Convert a raw `spinner` event label (`"✻ Brewing… (2s · 47 tokens)"`) into user-facing text (`"Brewing…"`). Returns `null` for noise. |
| `isAssistantTextNoise(text)` | `true` if an `assistant-text` event payload is TUI chrome rather than model output. |
| `extractToolName(text)` | Parse `"WebSearch(query)"` → `"WebSearch"`. `null` if not a tool announcement. |

### Cost / token helpers

| Export | Purpose |
|--------|---------|
| `DEFAULT_PRICING` | Sonnet 4.x per-token USD rates (`{ input, cacheWrite, cacheRead, output }`). Pass a `pricing` opt to `createChatClient` to override; pass your own rates to `computeCost` for ad-hoc math. |
| `computeCost(usage, pricing?)` | Compute USD cost from an upstream `message.usage` block. Returns `null` if `usage` is falsy. |
| `totalInputTokens(usage)` | Sum of `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. |
| `formatTokens(n)` | Compact display: `41200 → "41.2K"`, `864 → "864"`. |

```js
import { readSessionText, computeCost, totalInputTokens, formatTokens } from 'open-claude-p/chat';

const r = await readSessionText(sessionId);
console.log(
  `↑${formatTokens(totalInputTokens(r?.usage))} ↓${r?.usage?.output_tokens} tok ` +
  `· $${computeCost(r?.usage)?.toFixed(4) ?? '?'} · ${r?.tools.join(', ')}`,
);
```

---

## Low-level: `createDriver`

```js
import { createDriver } from 'open-claude-p';

const driver = createDriver({
  // claudeBin: '/path/to/claude',
  // poolSize: 1,
  // warmupMs: 2500,
  // maxResponseMs: 60_000,
});

const result = await driver.runOneShot({
  prompt: 'hello',
  dangerouslySkipPermissions: true,
  appendSystemPrompt: 'Use tools when relevant.',
  abortSignal: controller.signal,
  onEvent(ev) {
    switch (ev.type) {
      case 'session-id':            /* upstream session uuid */ break;
      case 'prompt-box-shown':      /* input chevron appeared */ break;
      case 'spinner':               /* { label } */ break;
      case 'assistant-region-entered':
      case 'assistant-text':        /* { text, region } */ break;
      case 'assistant-region-exited':
      case 'sentinel':              /* { nonce } */ break;
    }
  },
});

await driver.close();
```

### `createDriver(opts?)` — selected options

| Option | Default | Description |
|--------|---------|-------------|
| `claudeBin` | `'claude'` | Binary to spawn. Resolved via PATH if not absolute. |
| `cwd` | `process.cwd()` | Spawn cwd. |
| `debug` | `false` | Log spawn/extract/completion to stderr (argv values redacted). |
| `warmupMs` | `2500` | Settle delay between spawn and looking for the input chevron. |
| `maxResponseMs` | `60_000` | Hard timeout for a single `runOneShot()`. |
| `firstResponseMs` | `20_000` | Max wait for a spinner / region event after the prompt is sent. Fast-fail with `interactive-required` if nothing arrives. |
| `promptBoxWaitMs` | `15_000` | Max wait for the `❯` input chevron after warmup. Raise for cwds with heavy hook / MCP loading. |
| `promptBoxSettleMs` | `400` | Small settle after the chevron lands. |
| `trustSettleMs` | `5000` | Extra wait after auto-accepting the folder-trust dialog. |
| `poolSize` | `0` | Number of warm PTY sessions to park between calls (`0` disables pooling). |
| `poolMaxAgeMs` | — | Max age of a pooled session before recycling. |
| `idleMs` | `1500` | Idle silence threshold for completion after the sentinel. |
| `preIdleMs` | `8000` | Silence-only fallback before the sentinel has been seen. |
| `maxBufferBytes` | `16_777_216` (16 MB) | Cap on per-request stripped buffer. Excess tail is truncated. |
| `initialSessionId` | `null` | Pre-set session id for `--resume`-style continuation. |

### `driver.runOneShot(req) → Promise<OneShotResult>`

`req` accepts every option from `OPTION_SPEC` (`src/options/spec.js`),
camelCased — `dangerouslySkipPermissions`, `systemPrompt`,
`appendSystemPrompt`, `allowedTools`, `resume`, etc. Plus:

| Field | Description |
|-------|-------------|
| `prompt` | Required. User prompt text. |
| `onEvent(ev)` | Per-event callback. |
| `abortSignal` | Cancel mid-flight. |
| `maxResponseMs` | Per-request timeout override. |
| `passThroughArgv` | Extra argv tokens forwarded verbatim to upstream (subject to the [argv sanitizer](./cli-reference.md#argv-sanitizer-and-pass-through)). |

Returns:

```ts
{
  sessionId: string | null,
  text: string,
  events: Event[],
  exitCode: 0 | 1,
  isError: boolean,
  completionReason: string,
  cost: { totalUsd: null, numTurns: null },  // null unless caller computes
  durationMs: number,
  diagnostics: {
    rawBytes: number,
    strippedBytes: number,
    stalledOutputTail?: string,  // present on timeout / interactive-required
  },
}
```

### Event types delivered to `onEvent`

| Type | Payload | Meaning |
|------|---------|---------|
| `session-id` | `{ id }` | Upstream session UUID. |
| `prompt-box-shown` | — | `❯` chevron appeared — input box is ready. |
| `spinner` | `{ label }` | Upstream "working" indicator. Use `cleanSpinnerLabel` for display. |
| `assistant-region-entered` | `{ n }` | Model started writing the n-th response region. |
| `assistant-text` | `{ text, region }` | One line of response. Use `isAssistantTextNoise` to filter chrome. |
| `assistant-region-exited` | `{ n }` | Response region closed (rule / sentinel / break). |
| `sentinel` | — | Per-request sentinel echoed back — completion is imminent. |

---

## Subpath exports

| Subpath | Use |
|---------|-----|
| `open-claude-p` | `createDriver`, `sanitizePassThroughArgv`, `redactArgvForLog` |
| `open-claude-p/chat` | `createChatClient`, `readSessionText`, `cleanResponse`, `cleanSpinnerLabel`, `isAssistantTextNoise`, `extractToolName` |
| `open-claude-p/options` | `OPTION_SPEC`, `parseArgv`, `validate` |
| `open-claude-p/parsers` | `ansiStripParser`, `tuiFrameParser`, `createSentinelParser`, `createPipeline` |
| `open-claude-p/chat` (errors) | `ChatErrorCodes` — frozen map of stable `err.code` values thrown by `chat.send` / `chat.deleteConversation`. See the "Errors thrown" table under `chat.send`. |
| `open-claude-p/output` | output adapters (`textOutputAdapter`, `jsonOutputAdapter`, `streamJsonOutputAdapter`) and the registry |
| `open-claude-p/pty` | `PtySession`, `PtyPool` |
