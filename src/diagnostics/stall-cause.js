// Pattern-match the tail of the PTY screen captured at abort time to
// guess WHICH interactive dialog or environmental condition is most
// likely blocking the upstream. Returns a stable string identifier the
// CLI prints in the error message so the operator does not have to
// guess between five possibilities.
//
// The list is intentionally ordered most-actionable-first: when several
// patterns match (e.g. an MCP-auth banner AND a welcome screen) the
// caller sees the one they can do something about. `null` is returned
// when nothing matches — the caller should fall back to the generic
// "interactive prompt we cannot answer" wording.

/**
 * @typedef {object} StallCause
 * @property {string} kind  Stable machine-readable identifier.
 * @property {string} hint  One-line, English, end-user actionable hint.
 */

/** @type {Array<{kind: string, hint: string, test: (s: string) => boolean}>} */
const DETECTORS = [
  {
    kind: 'mcp-auth-required',
    hint:
      'an MCP server in your `~/.claude.json` is unauthenticated. Run ' +
      '`claude` directly, then `/mcp` to complete its OAuth flow, or remove ' +
      'the server from `~/.claude.json` if it is not needed.',
    test: (s) => /needs auth\s*·\s*\/mcp/i.test(s) || /MCP server needs auth/i.test(s),
  },
  {
    kind: 'trust-required',
    hint:
      'the upstream is waiting on the "Do you trust this folder?" dialog. ' +
      'Run `OCP_AUTO_ACCEPT_TRUST=1 ocp …`, or run `claude` once in this ' +
      'directory and choose "Yes".',
    test: (s) =>
      /Quick safety check/i.test(s) ||
      /trust this folder/i.test(s) ||
      /Is this a project you (?:created|trust)/i.test(s),
  },
  {
    kind: 'theme-picker',
    hint:
      'the upstream is showing the first-run theme picker. Run `claude` ' +
      'directly once and choose a theme so the picker does not block future ' +
      '`ocp` calls.',
    test: (s) => /Choose your theme/i.test(s) || /Select a theme/i.test(s),
  },
  {
    kind: 'login-expired',
    hint:
      'your `claude` login appears to have expired. Run `claude` directly, ' +
      'sign in, then retry.',
    test: (s) =>
      /Please log in/i.test(s) ||
      /authentication.*expired/i.test(s) ||
      /not logged in/i.test(s),
  },
  {
    kind: 'tool-permission',
    hint:
      'the upstream is waiting on a tool-permission prompt that headless ' +
      'PTY automation cannot answer. Pass `--dangerously-skip-permissions` ' +
      '(or set `OCP_DEFAULT_SKIP_PERMS=1`), or add the offending tool to ' +
      '`--allowed-tools`.',
    test: (s) =>
      /Allow this tool/i.test(s) ||
      /Run this command\?/i.test(s) ||
      /tool.*permission/i.test(s),
  },
  {
    kind: 'paste-not-submitted',
    hint:
      'the prompt was large enough that the upstream TUI handled it as a ' +
      'paste (`[Pasted text #N +X lines]`) and the trailing carriage return ' +
      'was consumed as paste content rather than a submit. Try ' +
      '`OCP_PASTE_MODE=chunk` to chunk-write the prompt (default in 1.1+), ' +
      'or switch the integration to `--input-format=stream-json`.',
    test: (s) => /\[Pasted text\s*#\d+/i.test(s),
  },
];

/**
 * Pick the single best-guess cause for an abort, based on the PTY tail
 * we captured. The tail is the trailing portion of the stripped buffer
 * (typically the last 24 non-blank lines) and is the same content the
 * operator would see if they re-ran `claude` directly in this directory.
 *
 * @param {string|null|undefined} tail
 * @returns {StallCause|null}
 */
export function detectStallCause(tail) {
  if (!tail || typeof tail !== 'string') return null;
  for (const d of DETECTORS) {
    if (d.test(tail)) return { kind: d.kind, hint: d.hint };
  }
  return null;
}
