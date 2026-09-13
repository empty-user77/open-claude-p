# Changelog

All notable changes to **open-claude-p** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.2.2] — 2026-09-13

Fixes the two defects listed as known issues in 1.2.1. Both were
pre-existing — they predate the 1.2.x work — and both were tracked to
root cause before anything was changed.

### Fixed

- **Replies lost every space between words.** The upstream TUI does not
  emit literal spaces between words on a redraw; it positions each word
  with an absolute column move and lets the terminal leave the gap blank:

  ```
  A\x1b[5Gpseudoterminal\x1b[20Gis\x1b[23Ga\x1b[25Gsoftware
  ```

  `ansi-strip` translated only CUF (`ESC [ Pn C`) into spaces. CHA
  (`ESC [ Pn G`) — which the current CLI uses for nearly every word — was
  deleted by the general CSI strip, so the reply came back as
  `Apseudoterminalisasoftware…`. The parser now tracks the cursor column
  and expands any forward horizontal move, CUF and CHA alike, into the
  run of spaces it would have left on screen. CUP (`H`/`f`) adopts the
  column without padding, since it is a jump to another region rather
  than a gap.

- **The CLI printed the TUI's spinner cell and usage meters around the
  answer.** `cleanResponse` exists as the last line of defence for
  PTY-extracted text — its own docstring says so — but only the chat
  client ever called it. The CLI printed raw PTY text whenever the
  upstream session file was unavailable, which is exactly when the scrub
  is needed. Both CLI paths now scrub, and the pattern set gained the
  rate-limit meters (`Usage ██░░ 16% (resets in 3h)`), the bare context
  meter, and the spinner status cell with its token counters (`63✢  88`).
  Guards keep real prose intact: meters must carry bar glyphs, counter
  cells must carry a digit beside the glyph and the multi-space padding
  the TUI uses, and a reply that is legitimately just a number ("what is
  6*7" → "42") is never swallowed.

- **Sessions started from inside a Claude Code session were never
  persisted.** When `ocp` itself runs under Claude Code — an agent
  driving it, or a developer testing from one — the spawned `claude`
  inherited the caller's session identity, most decisively
  `CLAUDE_CODE_CHILD_SESSION`, and concluded it was a continuation of the
  parent rather than a new session. It then wrote no session JSONL at
  all: `sessionId` came back `null`, the clean transcript ocp prefers was
  unavailable so every answer fell back to PTY-scraped text, and
  `--continue` / `--resume` had nothing to resume. The driver now removes
  the caller's session-identity variables when spawning. User-facing
  configuration (`CLAUDE_CODE_SIMPLE`, `CLAUDE_CODE_SAFE_MODE`, provider
  toggles, …) is untouched, an explicit value in `opts.env` still wins,
  and `OCP_KEEP_PARENT_SESSION_ENV=1` restores the old behaviour.

### Tests

- 237 → 243. New coverage: `test/ansi-cha.test.js` (absolute column moves,
  including the verbatim byte sequence captured off the wire) and
  `test/parent-session-env.test.js`. `test/clean-response.test.js` gains
  the meter, spinner-cell and numeric-answer cases.

### Verification

Each fix was reproduced first, then confirmed against the real CLI:
replaying the captured session through the parser now yields the sentence
with its spacing intact; a warm-daemon second turn prints the answer with
no chrome; and `--continue` recalls a word from the previous turn, which
it could not do before.

---

## [1.2.1] — 2026-09-13

Re-sync with Claude Code 2.1.270 and the current model lineup, and fix a
permission regression introduced in 1.2.0.

### Fixed

- **`--dangerously-skip-permissions=false` and `OCP_NO_SKIP_PERMS=1` were
  being ignored.** Two faults stacked up. `forwardedRequestFields` omits
  `false` values (there is no argv to emit for them), and `runOneShot`
  resolves a missing field with `?? true` — so an opt-out reached the
  driver as "unset" and came back out as "enabled". Underneath that sat
  an older, latent bug: the CLI's opt-out test read
  `options['dangerously-skip-permissions'] === false`, which is *also*
  true for the pre-seeded default, so it fired on every invocation and
  quietly turned the whole default-assignment block into dead code — the
  default-on behaviour had been coming from the driver's `?? true` all
  along. `parseArgv` now reports which options argv actually supplied
  (`result.supplied`), the opt-out keys off that, and the CLI always
  sends a concrete boolean. Net effect on defaults: none — a plain
  `ocp "…"` still runs with permissions bypassed — but asking for the
  bypass back now works.

### Added

- **Claude Code 2.1.270 flags.**

  | Flag | Purpose |
  |------|---------|
  | `--permission-prompts <host\|none>` | Who answers permission prompts; `none` denies rather than waiting |
  | `--restricted` | Drop command/code-running tools and WebFetch, ignore user/project/local settings, confine file tools, refuse `bypassPermissions` |
  | `--system-prompt-snapshot <on\|off>` | Record the system prompt once per conversation and reuse it verbatim, or re-render each request |

- **`--restricted` is wired to actually work headlessly.** Upstream
  rejects it outright when `bypassPermissions` is in play ("Error:
  bypassPermissions not supported in restricted mode") and exits, and
  ocp's CLI turns `--dangerously-skip-permissions` on by default — so a
  bare `ocp --restricted "…"` would have failed every time, silently,
  with no output. Asking for restricted mode is an explicit choice to
  keep the permission gates, so it now stands the permissive default
  down and defaults `--permission-prompts` to `none`, which is the only
  setting that keeps the run from waiting on a prompt no PTY can answer.
  Passing `--restricted` together with an explicit
  `--dangerously-skip-permissions` is reported as a validation error
  instead of being handed to upstream to reject.

  One caveat worth knowing: a restricted run writes no session JSONL, so
  ocp cannot use its usual clean-transcript path and reconstructs the
  reply from the TUI frames instead. The answer is correct, but it can
  carry leftover box-border chrome — observed on roughly two runs in
  three, against none for the same prompts without `--restricted`.

- **`parseArgv` returns `supplied`**, the set of canonical option names
  present in argv. Defaults are pre-seeded into `options`, so this is the
  only way to tell `--flag=false` apart from an unset flag.

### Changed

- **Model references refreshed to the current lineup.** Claude Fable 5.1
  (`claude-fable-5-1`) supersedes Claude Fable 5 in the documented
  examples; `claude-opus-5` remains the general-purpose recommendation.
  Aliases (`fable`, `opus`, `sonnet`, `haiku`) resolve to the latest
  model in each family and are unaffected. Verified against the upstream
  model list and the 2.1.270 binary, which ships both `claude-fable-5-1`
  and `claude-mythos-5-1`.

### Verified

- The 2.1.270 option surface was re-diffed against `OPTION_SPEC`: no
  previously-forwarded flag was removed, and the remaining unmapped
  flags (`--bg`, `--cloud`, `--environment`, `--from-pr`,
  `--remote-control`, `--teleport`, `--tmux`, `--worktree`, `--chrome`)
  are interactive or cloud-session features outside a headless shim's
  scope.

---

## [1.2.0] — 2026-08-21

Realign the option surface with Claude Code 2.1.x. The headline is a
forwarding bug: roughly thirty documented flags parsed cleanly, passed
validation, appeared in `ocp --help`, and were then silently discarded
before the upstream `claude` process ever saw them.

### Fixed

- **Flags declared in `OPTION_SPEC` are no longer dropped on the way to
  the upstream process.** `buildSpawnArgs()` has always been
  spec-driven — it walks `OPTION_SPEC` and emits `--flag value` for
  every entry whose `forward.type` is `'argv'`, reading
  `req[camelCase(spec.name)]`. The other half of that contract was
  hand-maintained: each call site in `bin/cli.js` listed the request
  fields it cared about. The two halves drifted, and everything the
  hand-written list had never picked up went nowhere:

  `--effort`, `--thinking`, `--max-thinking-tokens`, `--fallback-model`,
  `--tools`, `--add-dir`, `--mcp-config`, `--strict-mcp-config`,
  `--permission-prompt-tool`, `--system-prompt-file`,
  `--append-system-prompt-file`, `--settings`, `--setting-sources`,
  `--agents`, `--agent`, `--plugin-dir`, `--disable-slash-commands`,
  `--file`, `--ide`, `--betas`, `--bare`, `--init`, `--init-only`,
  `--maintenance`, `--debug-file`, `--workload`, `--enable-auth-status`,
  `--allow-dangerously-skip-permissions`, `--include-hook-events`, and
  `--include-partial-messages`.

  There was no error and no warning — `ocp --effort high "…"` ran at
  the upstream default effort and reported success. The mapping now
  comes from the same spec that produces the argv
  (`src/options/forward.js`), across all three request paths (daemon,
  print-mode, and the PTY path), so appending an entry to `OPTION_SPEC`
  is once again the only edit a newly-supported flag needs.

- **A concurrent session in the same directory could answer for this
  one.** Two independent defects lined up to produce it, and both are
  fixed:

  `findRecentSessionId` is the filesystem fallback that recovers a
  session id when none was scraped from the PTY. It accepted two classes
  of candidate — files created during the request, and pre-existing files
  whose mtime moved during it (the `--resume` append) — then ranked them
  together by mtime and took the newest. A background daemon holding a
  warm PTY in the same cwd appends to its own JSONL continuously, so it
  reliably out-raced the file the current spawn had just created. The
  wrong id then flowed into `readSessionText`, whose strict-by-id path
  faithfully returned that other session's transcript as this request's
  answer. Newly-created files now win outright; the append class is
  consulted only when nothing new appeared, which is exactly the
  `--resume` case it exists for.

  `readSessionText` has a second path, used when no session id is known
  at all, that scans the project directory and takes the most recently
  modified transcript. Its own source comments describe why that is
  unsafe — it is why the by-id path refuses to fall back to a scan — but
  the CLI reached it on every run where the id was missing. It now
  accepts an `expectPrompt` option and requires a candidate transcript to
  actually contain the prompt that was sent before returning its text;
  the CLI always supplies it. Ownership beats recency, so our own
  transcript is still found even when a neighbour is newer, and when
  nothing matches the caller falls back to the PTY-extracted text as
  before. Callers that omit the option keep the previous behaviour.

- **`--include-partial-messages` is no longer forwarded on the PTY
  path.** Upstream refuses it without `--print` ("Error:
  --include-partial-messages requires --print and
  --output-format=stream-json") and exits immediately, so forwarding it
  to the interactive spawn failed the whole run. OPTION_SPEC gains a
  `printModeOnly` field for this class of flag; ocp already synthesises
  `assistant-partial` events from the TUI frames, so nothing is lost.

- **`--agents` reaches upstream as JSON again.** It is a `json`-kind
  option, so `parseArgv` stores it already parsed and `buildSpawnArgs`'s
  `String(value)` turned it into the literal `[object Object]`. Upstream
  accepts that token without complaint and simply defines no agents, so
  the flag failed silently. `json`-kind values are now re-serialised, and
  a value supplied as raw JSON text is passed through unchanged rather
  than double-encoded.

- **`--effort xhigh` is accepted.** Upstream's levels are `low`,
  `medium`, `high`, `xhigh`, `max`; ocp's enum was missing `xhigh`, so
  the value most appropriate for coding and agentic work was rejected
  at parse time.

- **`--permission-mode manual` is accepted.** Upstream renamed the
  prompt-on-every-tool mode from `default` to `manual`; ocp's validator
  still had the old name only, so the current spelling was refused. Both
  are accepted now — upstream continues to take `default`, so removing
  it would have broken existing callers for no gain.

- **The `env:` field in `OPTION_SPEC` does something.** It has been part
  of the documented entry shape since 1.0 but nothing ever read it; the
  two options that used it were wired up by hand at their call sites, so
  any new entry declaring `env` silently had no effect. `parseArgv` now
  applies it, with the precedence the hand-rolled versions already used:
  **explicit argv > environment variable > spec default**. An explicit
  `--print-mode=false` beats a set `OCP_PRINT_MODE=1`. Booleans read
  `1` / `true` / `yes` / `on` as on; everything else, including the
  empty string, leaves the default in place.

### Added

- **Upstream flags introduced since the spec was last synced.** All
  forwarded verbatim:

  | Flag | Purpose |
  |------|---------|
  | `--autocompact <auto\|tokens>` | Auto-compact window size (`auto`, or 100k–1M) |
  | `--exclude-dynamic-system-prompt-sections` | Move per-machine sections out of the system prompt so the cached prefix is stable across machines |
  | `--forward-subagent-text` | Forward subagent text/thinking as messages with `parent_tool_use_id` |
  | `--prompt-suggestions` | Emit a `prompt_suggestion` event carrying a predicted next prompt |
  | `--plugin-url <url…>` | Fetch a plugin `.zip` from a URL for this session |
  | `--safe-mode` | Start with all customizations disabled |
  | `--ax-screen-reader` | Screen-reader friendly TUI output |
  | `--brief` | Enable the SendUserMessage tool |

- **`--ax-screen-reader` is worth knowing about even if you do not need
  accessibility.** It asks the upstream TUI for flat text with no
  decorative borders and no animations. ocp reconstructs its answer by
  scraping TUI frames, so there is simply less chrome for the parsers to
  strip. It stays **opt-in** (flag, or `OCP_AX_SCREEN_READER=1`) because
  it changes the captured frame shape, and this release does not alter
  any default.

- **New cross-flag validation.** `--forward-subagent-text` and
  `--prompt-suggestions` both require `--output-format=stream-json`
  (upstream only emits them on that channel, and the text/json adapters
  have nowhere to put them). `--autocompact` is checked for `auto` or a
  token budget in the 100k–1M range, accepting a `k`/`m` suffix.

- **`buildSpawnArgs` is exported from `open-claude-p`.** It was already
  a pure function; exporting it lets the spec → request-field → argv
  round-trip be asserted directly in tests.

### Security

- **`--plugin-url` added to the `passThroughArgv` deny-list.** It loads
  untrusted plugin code exactly like `--plugin-dir`, which was already
  listed, so it belongs in the same group.

- **`redactArgvForLog` now redacts every value of a variadic sensitive
  flag, not just the first.** `--mcp-config` takes multiple tokens and
  inline MCP JSON routinely carries server credentials; only the first
  token was masked, so a `--debug` run could print a secret to stderr
  and from there into a CI log or a pasted bug report. Previously
  unreachable from the CLI, because `--mcp-config` was one of the flags
  being dropped.

- **Wiring the dropped flags up widens what an argv-splicing wrapper
  exposes, and that is now documented.** ocp treats its own command line
  as trusted; the deny-list guards only *unrecognised* argv forwarded
  through `passThroughArgv` and has never covered ocp's own spec flags.
  A wrapper that splices untrusted text into ocp's argv was already
  unsafe — `--system-prompt`, `--append-system-prompt` and
  `--allowed-tools` have always been forwarded and the CLI defaults
  `--dangerously-skip-permissions` to on — but the newly-wired flags
  turn that from model-mediated influence into direct process
  execution. `docs/cli-reference.md` gains a **Never splice untrusted
  input into ocp's argv** section with the safe pattern. The flags are
  deliberately *not* gated behind an env var: they are documented,
  first-class options, and hiding them would re-break exactly what this
  release fixes.

### Tests

- `test/forward.test.js` (39 new tests). The central one walks
  `OPTION_SPEC` itself and asserts that every argv-forwarding entry
  survives the trip to the spawn argv, so a flag added to the spec is
  covered the moment it is declared rather than whenever someone
  remembers to extend a hand-written list. The rest pin the specific
  flags that regressed, the refreshed `--effort` / `--permission-mode`
  surfaces, the new validation rules, and env-var precedence.

### Documentation

- `docs/cli-reference.md` gains the model & behaviour flags
  (`--effort`, `--thinking`, `--fallback-model`, `--autocompact`,
  `--exclude-dynamic-system-prompt-sections`), a **Config, plugins &
  MCP** section covering the flags that were being dropped, the
  permission-mode values, the new lifecycle flags, and the env-var
  precedence rule.
- Model examples across `README.md`, `README.ko.md`, `README.ja.md`,
  `README.zh.md`, `docs/cli-reference.md`, and the spec's own help text
  moved off retired ids onto current ones (`claude-opus-5`,
  `claude-fable-5`) and the current aliases (`fable`, `opus`, `sonnet`,
  `haiku`).

### Internal

- Two comments in `bin/cli.js` used a non-English example prompt, which
  the project's contribution rules forbid in committed files. Replaced
  with English equivalents.

---

## [1.1.3] — 2026-05-19

Fix the `/compact` 24-hour hang and tighten the slash-command path so
skill invocations are not collateral damage. Driven by a captured
session (`4af68584-…`) where a manually-triggered `/compact` ran for
57 s of compaction activity, returned to the input box with no
assistant turn, and left `runOneShot` waiting for a sentinel that — by
the upstream's design — could never arrive.

### Fixed

- **`/compact` and other local-builtin slash commands no longer block
  for `maxResponseMs`.** Claude TUI splits `/`-prefixed prompts into
  two classes: *local builtins* (`/compact`, `/clear`, `/help`,
  `/exit`, `/quit`, `/login`, `/logout`, `/cost`, `/status`, `/model`,
  `/permissions`, `/config`) which run a local handler and never open
  an `⏺` region, and *LLM-bearing slash invocations* (skills like
  `/init`, `/review`, `/security-review`, plus every user-installed
  skill) which DO go through the model. The driver previously
  appended the OCP_END marker instruction to both and required
  `hadAssistantText` before the completion detector's idle fallback
  could fire — fine for the LLM-bearing class, fatal for builtins,
  which would wait for an assistant region that never opened until
  the 24 h hard timeout.

  Now `runOneShot` matches the prompt against a narrow whitelist of
  local builtins. On a match it (a) skips the OCP_END instruction
  append (the TUI's command parser drops it as junk args anyway, and
  appending it can pollute free-form-arg commands like `/bug`) and
  (b) sets the detector's new `allowIdleWithoutResponse` flag so the
  pre-sentinel idle path is reachable without a prior region entry.
  Skills and unknown `/<name>` prompts are NOT in the whitelist and
  keep the existing instruction + strict-idle-gate behaviour, so
  their LLM responses still complete cleanly via the sentinel.

### Added

- **`CompletionDetector.allowIdleWithoutResponse` (default false).**
  When true, `_onTick`'s pre-sentinel idle fallback fires after
  `preIdleMs` of silence even without a prior `assistant-region-
  entered`. This is the policy switch the driver uses for local
  builtins; library callers that drive prompts known to produce no
  assistant turn can opt in directly.

### Tests

- **End-to-end integration coverage for the slash-command path.**
  `test/driver-slash-command.test.js` spawns the real driver against
  `test/fixtures/fake-claude-tui.mjs` — a minimal node-pty fixture
  that reproduces the captured `/compact` shape (spinner activity,
  `Compacted` stdout, chevron return, no region, no sentinel) — and
  asserts: `/compact` completes via `reason='idle'` in well under
  `maxResponseMs`; a plain prompt still completes via `sentinel` with
  no degraded-capture notice prefix; `/init` (a skill, not a builtin)
  also completes via `sentinel`, proving the whitelist isn't too
  greedy. Three new unit tests in `test/detector.test.js` cover the
  bare `allowIdleWithoutResponse` flag.

---

## [1.1.2] — 2026-05-19

Recovery-path fixes for the sentinel-missing case. When the end-of-reply
marker fails to land — usually because claude omitted it or the PTY
frames were truncated — the driver's text extraction was returning
either an empty string or, worse, the entire re-rendered transcript of
a `--resume` session. Two changes correct that.

### Fixed

- **`extractAssistantText` no longer slices from the FIRST `⏺`** when
  the sentinel is missing. On a `--resume` run the buffer carries old
  history regions before the current response; anchoring on the first
  `⏺` returned the oldest history turn plus everything after it,
  silently leaking prior turns into `result.text`. The fallback now
  uses `lastIndexOf('⏺')` so the slice always covers the current
  turn's response. Fresh (non-resumed) sessions are unaffected because
  the buffer only has one region marker, so first == last.

### Added

- **Degraded-capture notice prefix.** When `completionReason` is
  `'idle'` (sentinel never seen, idle-fallback completed) or
  `'jsonl-recovered'` (a stall was rescued by reading the upstream
  JSONL session log), `result.text` is now prefixed with:

  ```
  [ocp] Streaming capture not detected — showing last result from {source}.
  ```

  where `{source}` is either `local session log` (JSONL had the
  response) or `terminal buffer (best effort)` (JSONL was unavailable
  and we fell back to the PTY slice above). Callers and chat UIs can
  now distinguish a normal capture from a post-hoc recovery without
  inspecting `completionReason`. The default success path
  (`reason='sentinel'`) is unchanged — no prefix is added.

---

## [1.1.1] — 2026-05-19

Post-1.1.0 fixes driven by Cosmica integration testing. Several of
these are essentially the 1.1.0 release "actually working" — the
1.1.0 surface was correct on paper but a handful of subtle parser
and default-value bugs kept the new behaviour from landing in
practice.

### Fixed

- **Trust dialog auto-accept regressed silently for two distinct
  reasons.**
  - The driver's `❯` chevron pattern matched both the real input
    box and the trust dialog's "currently-selected" row
    (`❯ 1. Yes, I trust this folder`). `prompt-box-shown` fired
    on the dialog row, the await chain proceeded to the prompt
    write, and the trailing `\r` confirmed whichever option was
    highlighted — silently dropping the user message. Pattern is
    now `/^[❯›❮‹](?:$|\s(?!\d+\.\s))/` and a write-time guard
    refuses to send when `dialogState` is in a blocked state.
  - The trust dialog text is rendered with cursor-positioning
    escapes between words rather than real space bytes; after the
    ANSI strip the buffer reads `Quicksafetycheck` (no spaces) and
    the `/Quick safety check/i` pattern never matched. Result: the
    dialog rendered in ~250 ms but the watcher never fired, the
    driver fell back to writing the prompt after
    `OCP_PROMPT_BOX_WAIT_MS`, and the trailing CR confirmed "Yes"
    in the still-open dialog. The watcher now strips ANSI before
    pattern-matching and the patterns accept `\s*` between every
    word.
- **`OCP_PROMPT_BOX_WAIT_MS` default 6 s → 30 s.** Environments
  with many MCP servers or plugins need 8–25 s before the input
  box renders. 6 s was tripping the timeout before claude had
  even shown the trust dialog. Short-circuited the moment
  `prompt-box-shown` fires, so the common-case latency is
  unchanged.
- **`dangerouslySkipPermissions` is now ON by default across
  EVERY surface** — not just the CLI. The 1.1.0 commit only
  flipped the CLI's default and left `createDriver().runOneShot()`
  and `createChatClient()` on the pre-1.1 `false`, so anything
  using the SDK directly (the bundled sample chat, third-party
  wrappers) still hung on the first tool call. Sample server's
  redundant env-gate is dropped accordingly.
- **End-of-reply marker no longer flagged as
  "prompt-injection".** The 1.0/1.1 instruction text used the
  word "token": `Append the literal token ⟦OCP_END:xxx⟧ ...`.
  The model's safety classifier treated "include this token in
  your reply" as an access-token / API-key exfiltration attempt
  and sometimes appended a `prompt injection attempt detected`
  warning to the user-facing reply. Reworded to "end-of-reply
  marker" and framed as `ocp wrapper's plumbing` so claude
  recognises it as harness infrastructure rather than hostile
  injection.

### Changed

- **postinstall skips the shebang rewrite when running inside a
  git checkout** (detected by the presence of `.git/` next to
  `package.json`). The rewrite is meant for end-user installs from
  the npm tarball; in a dev `git clone + npm link` setup it
  otherwise overwrote `#!/usr/bin/env node` with the developer's
  absolute node path on every `npm install` / `npm test`, showing
  up as a noisy working-tree diff. Consumer installs unaffected.

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

- **`--dangerously-skip-permissions` / `dangerouslySkipPermissions`
  is now the default ON across EVERY surface** — `ocp` CLI,
  `createDriver().runOneShot()`, `createChatClient()`, and the
  `sample/` server. Rationale: `ocp` is a PTY automation library; an
  interactive permission prompt that wants a human y/n hangs forever
  — every Bash / Edit / Write / MCP / WebSearch call breaks without
  this flag. The pre-1.1 library default of `false` was the cause
  of nearly every "the SDK silently hangs on tool use" report.
  Opt out per surface:
  - CLI: `OCP_NO_SKIP_PERMS=1` (env)
  - `createChatClient({ dangerouslySkipPermissions: false })`
  - `runOneShot({ dangerouslySkipPermissions: false })`
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

[1.1.1]: https://github.com/empty-user77/open-claude-p/releases/tag/v1.1.1
[1.1.0]: https://github.com/empty-user77/open-claude-p/releases/tag/v1.1.0
[1.0.0]: https://github.com/empty-user77/open-claude-p/releases/tag/v1.0.0
