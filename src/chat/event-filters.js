// Shared event-level cleanup helpers used by the CLI text adapter, the
// chat SDK, and the bundled sample server. Centralising them here keeps
// the "what counts as TUI noise vs. real content" decision in one
// place — when claude's TUI changes shape, a single edit propagates
// everywhere.
//
// Imported by:
//   - src/output/text.js  (CLI live spinner)
//   - sample/server.js    (SSE chat stream)
//   - chat.send()         (when `filterNoise: true`)

// Forward-declared so cleanSpinnerLabel can use it before the function
// definition below — keeps the export ordering readable.
const SPINNER_ICON_PREFIX = /^[✻✶✺✹✸✷✵●✢✳✽·✾✿❀❁❂❃❄❅❆❇❈❉❊❋]\s*/;

/**
 * Convert an upstream `spinner` event label into a user-facing line of
 * progress text. Returns `null` if the label is pure noise (token
 * counters, lone digits, empty after trim, etc.).
 *
 * Examples:
 *   "✻ Brewing… (2s · 47 tokens)"   → "Brewing…"
 *   "✻ Deliberating…   10s 23 still"  → "Deliberating…"
 *   "✻ thinking"                    → null
 *   "✻"                             → null
 *
 * @param {string} label
 * @returns {string|null}
 */
export function cleanSpinnerLabel(label) {
  let s = String(label).replace(SPINNER_ICON_PREFIX, '').trim();
  s = s
    .replace(/\s{2,}\d.*$/, '')      // "  10s ..." time/token stats
    .replace(/\s{3,}.*$/, '')        // TUI suffix after 3+ spaces
    .replace(/\s+[·↓↑].*$/, '')      // " · N tokens …" separator
    .replace(/\s*\(.*$/, '')         // "(stats)" suffix
    .replace(/[\s\d·↓↑]+$/, '')      // trailing junk
    .trim();
  if (!s) return null;
  if (/^(thinking|still|tokens?)$/i.test(s)) return null;
  if (/tokens[\)·]/.test(s) || /^\d/.test(s)) return null;
  if (!/\S{3,}/.test(s)) return null;
  // Final defensive strip — claude's spinner text reaches the user's
  // terminal as live progress; an exotic upstream that smuggled an
  // ANSI sequence into the label would otherwise execute it.
  return stripTerminalControl(s, 128);
}

/**
 * `true` if an `assistant-text` event payload is TUI chrome rather than
 * model output — TUI prompt characters, box borders, redraw artifacts,
 * tree-view glyphs, "Found N" search status lines, status indicators,
 * and tool-call announcements that other systems should not surface as
 * assistant content.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isAssistantTextNoise(text) {
  const t = String(text ?? '');
  if (!t) return true;
  if (/^\s*[❯›❮‹✳✽·✾✿❀❁❂❃❄]\s*$/.test(t)) return true;       // lone TUI glyph
  if (/^[\s\d\r\n]+$/.test(t)) return true;                  // whitespace / digits only
  if (/⎿/.test(t)) return true;                              // tree-view marker
  if (/MCP servers? failed/i.test(t)) return true;           // MCP status line
  if (/^\s*(↑|↓|·|still running)\s*$/i.test(t)) return true; // arrow / indicator
  if (/^(Found \d+|Did \d+)\b/.test(t.trim())) return true;  // search status
  if (/^\s*(?:Web ?Search|WebFetch|Bash|Read|Write|Glob|Grep|LS|Edit|MultiEdit|TodoWrite|TodoRead|mcp__\w+)\(/.test(t)) return true; // tool-call announcement
  // "Inferring…          8          word" — spinner + digit + word, pure animation frame
  if (/\w(?:…|\.{2,3})\s{3,}\S.*$/.test(t)) return true;
  // Heavy leading indent + ≤2 words — usually a single-line spinner element
  { const tr = t.trim(); if ((t.length - tr.length) > 8 && tr.split(/\s+/).length <= 2) return true; }
  // "Nucleating... 4 3 Nucleating... 5" — strip CapWord… tokens; if only digits/spaces remain it's pure spinner noise
  if (/[A-Z][a-zA-Z]+[\.…]{2,3}/.test(t)) {
    const rest = t.replace(/[A-Z][a-zA-Z\-]+[\.…]{2,3}/g, '').replace(/\s/g, '');
    if (/^\d*$/.test(rest)) return true;
  }
  return false;
}

/**
 * Strip control / escape characters that would execute as terminal
 * sequences when echoed to a TTY. Use on any string sourced from
 * untrusted-by-the-terminal channels (upstream JSONL `tool_use.name`,
 * spinner labels, user prompt previews) before writing to stderr.
 * Caps the length to keep meta-line / status-line wraps sane.
 *
 * @param {string} s
 * @param {number} [max=64]
 * @returns {string}
 */
export function stripTerminalControl(s, max = 64) {
  // Strip C0 controls + DEL + the full C1 8-bit control range. The
  // narrower `\x9b` (CSI) class missed `\x90` (DCS), `\x9d` (OSC),
  // `\x9e` (PM), `\x9f` (APC) — all of which execute on VT100-compatible
  // terminals when 8-bit forms are accepted. Also strips ESC (`\x1b`)
  // which is the 7-bit prefix for the same sequences.
  return String(s ?? '')
    .replace(/[\x00-\x1f\x7f\x80-\x9f]/g, '')
    .slice(0, max);
}

/** Tool-call announcement pattern → first capture is the tool name. */
const TOOL_CALL_RE = /^\s*(Web Search|WebSearch|WebFetch|Bash|Read|Write|Glob|Grep|LS|Edit|MultiEdit|TodoWrite|TodoRead|mcp__[\w]+)\(/;

/**
 * Extract the tool name from an `assistant-text` line that announces a
 * tool call. Returns `null` if the line is not a tool announcement.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function extractToolName(text) {
  const m = String(text ?? '').match(TOOL_CALL_RE);
  return m ? m[1] : null;
}
