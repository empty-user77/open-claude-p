// Single source of truth for every option that `claude -p` accepts.
//
// Each entry describes one flag in a declarative shape so the argv parser,
// the validator, and the help-text generator can all be derived from this
// file alone. Adding support for a new flag therefore means appending one
// entry here — no other module should need to be edited.
//
// Entry shape (all fields are stable contract):
//   {
//     name:         Canonical long name, e.g. 'output-format'.
//     short:        Optional single-character short alias, e.g. 'p'.
//     aliases:      Optional extra long aliases, e.g. ['allowedTools'].
//     kind:         'boolean' | 'string' | 'number' | 'enum' | 'array' | 'json'.
//     choices:      For 'enum': array of accepted values.
//     default:      Default value when omitted.
//     repeatable:   For 'array': whether the flag may be specified multiple
//                   times (occurrences accumulate); array kind also collects
//                   variadic values until the next flag-looking token.
//     env:          Optional environment-variable fallback.
//     printModeOnly: Only forward this flag when running under
//                   `--print-mode`. For upstream flags that require
//                   `--print` and abort the process without it.
//     description:  One-line help text.
//     forward:      How this option reaches the upstream `claude` process.
//                     { type: 'argv', flag: '--name' }   pass to spawn argv
//                     { type: 'env',  name: 'VAR' }      set on spawn env
//                     { type: 'system-prompt' }          fold into injected prompt
//                     { type: 'shim' }                   enforced locally
//                     { type: 'unsupported', reason }    refuse with message
//     validate:     Optional (value, allOptions) => string | undefined.
//   }
//
// This file contains the option spec used by the CLI and the library.

/** @type {Array<object>} */
export const OPTION_SPEC = [
  // ── Print / output ────────────────────────────────────────────────────
  {
    name: 'print',
    short: 'p',
    kind: 'boolean',
    default: false,
    description:
      'Accepted for argv-compatibility with `claude -p`. This tool has no ' +
      'non-print mode, so the flag is a silent no-op.',
    forward: { type: 'shim' },
  },
  {
    name: 'print-mode',
    kind: 'boolean',
    default: false,
    env: 'OCP_PRINT_MODE',
    description:
      'Spawn `claude --print` directly (no PTY, no TUI rendering). Raw ' +
      'markdown formatting (``` fences, ## headings, **bold**) reaches the ' +
      'caller unchanged. Output for --output-format=json|stream-json passes ' +
      'through claude\'s native schema rather than the ocp-wrapped schema. ' +
      'Tool-approval prompts and other interactive features are not ' +
      'available in this mode; MCP servers are known to hang in print mode.',
    forward: { type: 'shim' },
  },
  {
    name: 'output-format',
    kind: 'enum',
    choices: ['text', 'json', 'stream-json'],
    default: 'text',
    description:
      'Format of stdout. `text` (default) emits plain assistant text. ' +
      '`json` emits a single result object. `stream-json` emits a ' +
      'newline-delimited event stream.',
    forward: { type: 'shim' },
  },

  // ── Spawn-time forwarding ─────────────────────────────────────────────
  {
    name: 'model',
    kind: 'string',
    description:
      'Model alias or full name. Aliases resolve to the latest model in ' +
      'that family (e.g. `fable`, `opus`, `sonnet`, `haiku`); full names ' +
      'are passed through verbatim (e.g. `claude-opus-5`, ' +
      '`claude-fable-5-1`, `claude-sonnet-5`).',
    forward: { type: 'argv', flag: '--model' },
  },
  {
    name: 'dangerously-skip-permissions',
    kind: 'boolean',
    default: false,
    description:
      'Bypass all permission checks in the upstream CLI. Never set by the ' +
      'shim itself; only forwarded when the caller asks for it.',
    forward: { type: 'argv', flag: '--dangerously-skip-permissions' },
  },
  {
    name: 'system-prompt',
    kind: 'string',
    description: 'Override the upstream system prompt.',
    forward: { type: 'argv', flag: '--system-prompt' },
  },
  {
    name: 'allowed-tools',
    aliases: ['allowedTools'],
    kind: 'array',
    repeatable: true,
    description:
      'Allow-list of tools the model may use. Accepts a variadic list of ' +
      'tool patterns and/or repeated occurrences of the flag.',
    forward: { type: 'argv', flag: '--allowed-tools' },
  },
  {
    name: 'disallowed-tools',
    aliases: ['disallowedTools'],
    kind: 'array',
    repeatable: true,
    description: 'Deny-list of tools the model may not use. Same shape as `--allowed-tools`.',
    forward: { type: 'argv', flag: '--disallowed-tools' },
  },
  {
    name: 'debug',
    kind: 'boolean',
    default: false,
    description: 'Enable shim debug logs to stderr AND forward `--debug` upstream.',
    forward: { type: 'argv', flag: '--debug' },
  },
  {
    name: 'verbose',
    kind: 'boolean',
    default: false,
    description: 'Verbose mode; useful with `stream-json` output for visibility.',
    forward: { type: 'argv', flag: '--verbose' },
  },

  // ── Session continuation ──────────────────────────────────────────────
  {
    name: 'continue',
    short: 'c',
    kind: 'boolean',
    default: false,
    description: 'Continue the most recent conversation in `cwd`.',
    forward: { type: 'argv', flag: '--continue' },
  },
  {
    name: 'resume',
    short: 'r',
    kind: 'string',
    description:
      'Resume a session by its UUID or a search term. Pass a session id ' +
      'returned by a prior run to continue from it.',
    forward: { type: 'argv', flag: '--resume' },
  },
  {
    name: 'fork-session',
    kind: 'boolean',
    default: false,
    description:
      'When resuming, create a new session id instead of writing back to ' +
      'the original. Requires `--resume` or `--continue`.',
    forward: { type: 'argv', flag: '--fork-session' },
  },
  {
    name: 'no-session-persistence',
    kind: 'boolean',
    default: false,
    env: 'OCP_NO_SESSION_PERSISTENCE',
    description:
      'Disable saving the session for later resume. Useful for stateless ' +
      'integrations that rebuild conversation context every turn — without ' +
      'this, `~/.claude/projects/<cwd>/` accumulates dead JSONL files. ' +
      'Set `OCP_NO_SESSION_PERSISTENCE=1` to apply per shell.',
    forward: { type: 'argv', flag: '--no-session-persistence' },
  },
  {
    name: 'resume-session-at',
    kind: 'string',
    description: 'Resume up to and including a specific message id.',
    forward: { type: 'argv', flag: '--resume-session-at' },
  },
  {
    name: 'rewind-files',
    kind: 'string',
    description:
      'Restore files to the state they were in at a given user-message id, ' +
      'then exit.',
    forward: { type: 'argv', flag: '--rewind-files' },
  },
  {
    name: 'session-id',
    kind: 'string',
    description: 'Use a specific UUID for the new session.',
    forward: { type: 'argv', flag: '--session-id' },
    validate(value) {
      if (typeof value !== 'string') return undefined;
      if (!/^[0-9a-fA-F-]{36}$/.test(value)) {
        return `--session-id must be a 36-char UUID; got ${JSON.stringify(value)}`;
      }
    },
  },
  {
    name: 'name',
    short: 'n',
    kind: 'string',
    description: 'Display name for the session.',
    forward: { type: 'argv', flag: '--name' },
  },

  // ── Print / output (extras) ───────────────────────────────────────────
  {
    name: 'input-format',
    kind: 'enum',
    choices: ['text', 'stream-json'],
    default: 'text',
    description:
      '`text` reads a single prompt from argv or stdin. `stream-json` ' +
      'reads NDJSON `SDKUserMessage` events from stdin (requires ' +
      '`--output-format=stream-json`).',
    forward: { type: 'shim' },
  },
  {
    name: 'json-schema',
    kind: 'json',
    description:
      'JSON Schema applied to the final assistant output (`--output-format=json`). ' +
      'A schema mismatch sets `is_error: true` in the result.',
    forward: { type: 'shim' },
  },
  {
    name: 'replay-user-messages',
    kind: 'boolean',
    default: false,
    description:
      'Echo user messages back on stdout for acknowledgment ' +
      '(stream-json input + output only).',
    forward: { type: 'shim' },
  },
  {
    name: 'forward-subagent-text',
    kind: 'boolean',
    default: false,
    description:
      'Forward subagent text and thinking blocks as assistant/user messages ' +
      'with `parent_tool_use_id` set. Requires `--output-format=stream-json`.',
    forward: { type: 'argv', flag: '--forward-subagent-text' },
  },
  {
    name: 'prompt-suggestions',
    kind: 'boolean',
    default: false,
    description:
      'Emit a `prompt_suggestion` message after each turn carrying a ' +
      'predicted next user prompt (stream-json output).',
    forward: { type: 'argv', flag: '--prompt-suggestions' },
  },
  {
    name: 'include-hook-events',
    kind: 'boolean',
    default: false,
    description: 'Include hook lifecycle events in stream-json output.',
    forward: { type: 'argv', flag: '--include-hook-events' },
  },
  {
    name: 'include-partial-messages',
    kind: 'boolean',
    default: false,
    // Upstream refuses this flag unless it is also given `--print`
    // ("Error: --include-partial-messages requires --print and
    // --output-format=stream-json") and exits immediately. The default
    // PTY path drives the interactive TUI, so forwarding it there kills
    // the spawn. ocp already synthesises `assistant-partial` events from
    // the TUI frames on that path, so the flag has nothing to add there
    // anyway — it is forwarded only under `--print-mode`.
    printModeOnly: true,
    description:
      'Include partial assistant message chunks in stream-json output. ' +
      'Forwarded upstream only under `--print-mode`; on the default PTY ' +
      'path ocp emits `assistant-partial` events itself.',
    forward: { type: 'argv', flag: '--include-partial-messages' },
  },

  // ── Model & behavior ──────────────────────────────────────────────────
  {
    name: 'effort',
    kind: 'enum',
    choices: ['low', 'medium', 'high', 'xhigh', 'max'],
    description:
      'Effort level the model should apply (`low` | `medium` | `high` | ' +
      '`xhigh` | `max`). `xhigh` sits between `high` and `max` and is the ' +
      'upstream default for coding and agentic work.',
    forward: { type: 'argv', flag: '--effort' },
  },
  {
    name: 'thinking',
    kind: 'enum',
    choices: ['enabled', 'adaptive', 'disabled'],
    description: 'Thinking mode.',
    forward: { type: 'argv', flag: '--thinking' },
  },
  {
    name: 'max-thinking-tokens',
    kind: 'number',
    description: 'Maximum thinking tokens (deprecated upstream, still forwarded).',
    forward: { type: 'argv', flag: '--max-thinking-tokens' },
  },
  {
    name: 'max-turns',
    kind: 'number',
    description:
      'Maximum agentic turns before early exit. Shim-enforced — the shim ' +
      'counts assistant events and aborts if the limit is reached.',
    forward: { type: 'shim' },
  },
  {
    name: 'max-budget-usd',
    kind: 'number',
    description: 'Maximum spend in USD. Shim-enforced.',
    forward: { type: 'shim' },
  },
  {
    name: 'task-budget',
    kind: 'number',
    description: 'API-side task budget in tokens. Shim-enforced.',
    forward: { type: 'shim' },
  },
  {
    name: 'autocompact',
    kind: 'string',
    description:
      'Auto-compact window size: `auto`, or an explicit token budget ' +
      'between 100k and 1M (e.g. `200000`, `500k`).',
    forward: { type: 'argv', flag: '--autocompact' },
  },
  {
    name: 'fallback-model',
    kind: 'string',
    description: 'Automatic fallback model when the primary is overloaded.',
    forward: { type: 'argv', flag: '--fallback-model' },
  },

  // ── Permissions / tools / MCP ─────────────────────────────────────────
  {
    name: 'permission-mode',
    kind: 'string',
    description:
      'Permission mode (`acceptEdits` | `auto` | `bypassPermissions` | ' +
      '`manual` | `dontAsk` | `plan`). `manual` is the current name for ' +
      "the interactive prompt-on-every-tool mode; upstream still accepts " +
      'the older `default` spelling, so ocp keeps accepting it too.',
    forward: { type: 'argv', flag: '--permission-mode' },
  },
  {
    name: 'allow-dangerously-skip-permissions',
    kind: 'boolean',
    default: false,
    description:
      'Allow `--dangerously-skip-permissions` as a choice without enabling it.',
    forward: { type: 'argv', flag: '--allow-dangerously-skip-permissions' },
  },
  {
    name: 'permission-prompts',
    kind: 'enum',
    choices: ['host', 'none'],
    description:
      'Who answers permission prompts: `host` (the SDK host, or the tool ' +
      'named by `--permission-prompt-tool`) or `none` (nobody — anything ' +
      'that would prompt is denied automatically; the permission mode ' +
      'still decides everything else). `none` suits PTY automation, which ' +
      'has no way to answer a prompt, when denying is preferable to ' +
      'bypassing checks outright.',
    forward: { type: 'argv', flag: '--permission-prompts' },
  },
  {
    name: 'restricted',
    kind: 'boolean',
    default: false,
    description:
      'Restricted mode: drop the built-in tools that run commands or code ' +
      '(Bash, PowerShell, REPL, …) and WebFetch unless `--tools` names ' +
      'them, ignore user/project/local settings files (managed settings ' +
      'and `--settings` still apply), confine the file tools to the ' +
      'working directories, and refuse `bypassPermissions`. Pair with ' +
      '`--strict-mcp-config` to skip MCP servers too. Note that ocp does ' +
      'not get its usual clean transcript in this mode — no session ' +
      'JSONL is written for the run, so the reply is reconstructed from ' +
      'the TUI frames and may carry leftover box-border chrome.',
    forward: { type: 'argv', flag: '--restricted' },
  },
  {
    name: 'tools',
    kind: 'string',
    description:
      'Tool set: empty string (none), `default` (all), or a comma/space-' +
      'separated list of tool names.',
    forward: { type: 'argv', flag: '--tools' },
  },
  {
    name: 'mcp-config',
    kind: 'array',
    repeatable: true,
    description: 'MCP config paths or inline JSON strings (repeatable).',
    forward: { type: 'argv', flag: '--mcp-config' },
  },
  {
    name: 'strict-mcp-config',
    kind: 'boolean',
    default: false,
    description: 'Only use `--mcp-config` sources; ignore project/local MCP configs.',
    forward: { type: 'argv', flag: '--strict-mcp-config' },
  },
  {
    name: 'permission-prompt-tool',
    kind: 'string',
    description: 'MCP tool name to handle permission prompts in headless mode.',
    forward: { type: 'argv', flag: '--permission-prompt-tool' },
  },

  // ── Prompts / context ─────────────────────────────────────────────────
  {
    name: 'system-prompt-file',
    kind: 'string',
    description: 'Load the system prompt from a file path.',
    forward: { type: 'argv', flag: '--system-prompt-file' },
  },
  {
    name: 'append-system-prompt',
    kind: 'string',
    description: 'Append to the default system prompt.',
    forward: { type: 'argv', flag: '--append-system-prompt' },
  },
  {
    name: 'append-system-prompt-file',
    kind: 'string',
    description: 'Append to the system prompt from a file path.',
    forward: { type: 'argv', flag: '--append-system-prompt-file' },
  },
  {
    name: 'system-prompt-snapshot',
    kind: 'enum',
    choices: ['on', 'off'],
    description:
      'Record the system prompt once per conversation and reuse it ' +
      'verbatim on every later request and resume (`on`, the upstream ' +
      'default), or render it fresh every request (`off`, for iterating ' +
      'on prompt text). With `on`, a later run passing different prompt ' +
      'text is ignored until the conversation is compacted.',
    forward: { type: 'argv', flag: '--system-prompt-snapshot' },
  },
  {
    name: 'exclude-dynamic-system-prompt-sections',
    kind: 'boolean',
    default: false,
    description:
      'Move per-machine sections (cwd, env info, memory paths, git status) ' +
      'out of the system prompt and into the first user message, so the ' +
      'cached prompt prefix is identical across machines and users. Ignored ' +
      'when `--system-prompt` replaces the default prompt.',
    forward: { type: 'argv', flag: '--exclude-dynamic-system-prompt-sections' },
  },
  {
    name: 'add-dir',
    kind: 'array',
    repeatable: true,
    description: 'Additional directories to allow tool access to (repeatable).',
    forward: { type: 'argv', flag: '--add-dir' },
  },

  // ── Settings / plugins ────────────────────────────────────────────────
  {
    name: 'settings',
    kind: 'string',
    description: 'Path to a settings JSON file or an inline JSON string.',
    forward: { type: 'argv', flag: '--settings' },
  },
  {
    name: 'setting-sources',
    kind: 'string',
    description: 'Comma-separated sources to load: `user`, `project`, `local`.',
    forward: { type: 'argv', flag: '--setting-sources' },
  },
  {
    name: 'agents',
    kind: 'json',
    description: 'Custom agent definitions as JSON.',
    forward: { type: 'argv', flag: '--agents' },
  },
  {
    name: 'plugin-dir',
    kind: 'array',
    repeatable: true,
    description: 'Load plugins from directory (repeatable).',
    forward: { type: 'argv', flag: '--plugin-dir' },
  },
  {
    name: 'plugin-url',
    kind: 'array',
    repeatable: true,
    description: 'Fetch a plugin `.zip` from a URL for this session only (repeatable).',
    forward: { type: 'argv', flag: '--plugin-url' },
  },
  {
    name: 'disable-slash-commands',
    kind: 'boolean',
    default: false,
    description: 'Disable all slash commands and skills.',
    forward: { type: 'argv', flag: '--disable-slash-commands' },
  },
  {
    name: 'agent',
    kind: 'string',
    description: 'Selected agent name for this session.',
    forward: { type: 'argv', flag: '--agent' },
  },
  {
    name: 'file',
    kind: 'array',
    repeatable: true,
    description:
      'File resources to download at startup. Each entry has the form ' +
      '`file_id:relative_path`.',
    forward: { type: 'argv', flag: '--file' },
  },
  {
    name: 'ide',
    kind: 'boolean',
    default: false,
    description: 'Auto-connect to an IDE if exactly one is available.',
    forward: { type: 'argv', flag: '--ide' },
  },
  {
    name: 'enable-auth-status',
    kind: 'boolean',
    default: false,
    description: 'Emit `auth-status` events in stream-json output.',
    forward: { type: 'argv', flag: '--enable-auth-status' },
  },

  // ── Debug / lifecycle ─────────────────────────────────────────────────
  {
    name: 'bare',
    kind: 'boolean',
    default: false,
    description:
      'Minimal mode: skip hooks, LSP, plugins, attribution, auto-memory, ' +
      'background prefetches, keychain. Sets `CLAUDE_CODE_SIMPLE=1`.',
    forward: { type: 'argv', flag: '--bare' },
  },
  {
    name: 'init',
    kind: 'boolean',
    default: false,
    description: 'Run Setup hooks with the `init` trigger, then continue.',
    forward: { type: 'argv', flag: '--init' },
  },
  {
    name: 'init-only',
    kind: 'boolean',
    default: false,
    description: 'Run Setup & SessionStart hooks, then exit.',
    forward: { type: 'argv', flag: '--init-only' },
  },
  {
    name: 'maintenance',
    kind: 'boolean',
    default: false,
    description: 'Run Setup hooks with the `maintenance` trigger, then continue.',
    forward: { type: 'argv', flag: '--maintenance' },
  },
  {
    name: 'safe-mode',
    kind: 'boolean',
    default: false,
    description:
      'Start with all customizations disabled (CLAUDE.md, skills, plugins, ' +
      'hooks, MCP servers, custom commands and agents, output styles, ' +
      'workflows, themes, keybindings). Admin policy settings still apply. ' +
      'Sets `CLAUDE_CODE_SAFE_MODE=1`. Useful for reproducing a failure ' +
      'without local configuration in the way.',
    forward: { type: 'argv', flag: '--safe-mode' },
  },
  {
    name: 'ax-screen-reader',
    kind: 'boolean',
    default: false,
    env: 'OCP_AX_SCREEN_READER',
    description:
      'Ask the upstream TUI for screen-reader friendly output: flat text, ' +
      'no decorative borders, no animations. Because ocp reconstructs its ' +
      'answer by scraping TUI frames, this markedly reduces the amount of ' +
      'chrome the parsers have to strip. Opt-in — it changes the captured ' +
      'frame shape, so it is never enabled by default.',
    forward: { type: 'argv', flag: '--ax-screen-reader' },
  },
  {
    name: 'brief',
    kind: 'boolean',
    default: false,
    description: 'Enable the SendUserMessage tool for agent-to-user communication.',
    forward: { type: 'argv', flag: '--brief' },
  },
  {
    name: 'debug-file',
    kind: 'string',
    description: 'Write upstream debug logs to a file.',
    forward: { type: 'argv', flag: '--debug-file' },
  },
  {
    name: 'workload',
    kind: 'string',
    description: 'Workload tag for billing (internal SDK daemon use).',
    forward: { type: 'argv', flag: '--workload' },
  },
  {
    name: 'betas',
    kind: 'array',
    repeatable: true,
    description: 'Beta headers for the API (API-key users only).',
    forward: { type: 'argv', flag: '--betas' },
  },

  // ── Shim-only convenience ─────────────────────────────────────────────
  {
    name: 'cwd',
    kind: 'string',
    description:
      'Working directory for the spawned `claude` process. Shim-only — the ' +
      'upstream CLI inherits cwd; this flag sets the PTY spawn cwd.',
    forward: { type: 'shim' },
  },
  {
    name: 'help',
    short: 'h',
    kind: 'boolean',
    default: false,
    description: 'Print this help text and exit.',
    forward: { type: 'shim' },
  },
  {
    name: 'version',
    short: 'V',
    kind: 'boolean',
    default: false,
    description: 'Print the ocp version and exit.',
    forward: { type: 'shim' },
  },
  {
    name: 'no-meta',
    kind: 'boolean',
    default: false,
    description:
      'Hide the trailing meta line (duration · input/output tokens · USD ' +
      'cost · tools used) printed to stderr after the response. Same effect ' +
      'as OCP_NO_META=1. The meta line is printed only when stderr is a TTY.',
    forward: { type: 'shim' },
  },
];

/**
 * Look up an option by its canonical name, short alias, or long alias.
 * @param {string} name
 * @returns {object | undefined}
 */
export function getOption(name) {
  return OPTION_SPEC.find(
    (o) => o.name === name || o.short === name || (o.aliases ?? []).includes(name),
  );
}
