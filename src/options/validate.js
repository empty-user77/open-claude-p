// Cross-flag validation rules.
//
// Per-option validation (range, format) lives on each entry of OPTION_SPEC
// via its optional `validate` function. This module enforces relationships
// BETWEEN options — e.g. `--input-format=stream-json` requires
// `--output-format=stream-json`.
//
// Rules are appended to `CROSS_RULES`; the runner returns the concatenated
// list of human-readable errors.

// Upstream (`claude --permission-mode`) advertises: acceptEdits, auto,
// bypassPermissions, manual, dontAsk, plan. `manual` is the current name
// for the prompt-on-every-tool mode that used to be spelled `default`;
// upstream still accepts `default`, so we keep it here rather than
// breaking callers that pass it.
const PERMISSION_MODES = new Set([
  'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan',
  'default',
]);

/** @type {Array<(options: Record<string, unknown>) => string | undefined>} */
export const CROSS_RULES = [
  // R1. input-format=stream-json => output-format=stream-json
  (o) => {
    if (o['input-format'] === 'stream-json' && o['output-format'] !== 'stream-json') {
      return '`--input-format=stream-json` requires `--output-format=stream-json`.';
    }
  },
  // R2. replay-user-messages => stream-json on both sides
  (o) => {
    if (
      o['replay-user-messages'] === true &&
      (o['input-format'] !== 'stream-json' || o['output-format'] !== 'stream-json')
    ) {
      return '`--replay-user-messages` requires both `--input-format=stream-json` and `--output-format=stream-json`.';
    }
  },
  // R3. include-hook-events => stream-json output
  (o) => {
    if (o['include-hook-events'] === true && o['output-format'] !== 'stream-json') {
      return '`--include-hook-events` requires `--output-format=stream-json`.';
    }
  },
  // R4. include-partial-messages => stream-json output
  (o) => {
    if (o['include-partial-messages'] === true && o['output-format'] !== 'stream-json') {
      return '`--include-partial-messages` requires `--output-format=stream-json`.';
    }
  },
  // R5. max-budget-usd must be a positive number when set
  (o) => {
    const v = o['max-budget-usd'];
    if (v !== undefined && (typeof v !== 'number' || !(v > 0))) {
      return '`--max-budget-usd` must be a positive number.';
    }
  },
  // R6. task-budget must be a positive integer when set
  (o) => {
    const v = o['task-budget'];
    if (v !== undefined && (!Number.isInteger(v) || v <= 0)) {
      return '`--task-budget` must be a positive integer.';
    }
  },
  // R7. session-id format is enforced by the per-option validate callback;
  //     we re-check here so the failure surfaces alongside other cross
  //     errors in a single batch.
  (o) => {
    const v = o['session-id'];
    if (typeof v === 'string' && v !== '' && !/^[0-9a-fA-F-]{36}$/.test(v)) {
      return '`--session-id` must be a 36-char UUID.';
    }
  },
  // R8. permission-mode must be one of the known values when set
  (o) => {
    const v = o['permission-mode'];
    if (typeof v === 'string' && v !== '' && !PERMISSION_MODES.has(v)) {
      return `\`--permission-mode\` must be one of: ${[...PERMISSION_MODES].join(', ')}.`;
    }
  },
  // R9. resume and continue are mutually exclusive
  (o) => {
    if (typeof o.resume === 'string' && o.resume !== '' && o.continue === true) {
      return '`--resume` and `--continue` are mutually exclusive.';
    }
  },
  // R10. fork-session requires a base session: resume or continue
  (o) => {
    const hasBase =
      (typeof o.resume === 'string' && o.resume !== '') || o.continue === true;
    if (o['fork-session'] === true && !hasBase) {
      return '`--fork-session` requires `--resume <id>` or `--continue`.';
    }
  },
  // R11. forward-subagent-text => stream-json output. Upstream only emits
  //      the extra assistant/user messages on the stream-json channel.
  (o) => {
    if (o['forward-subagent-text'] === true && o['output-format'] !== 'stream-json') {
      return '`--forward-subagent-text` requires `--output-format=stream-json`.';
    }
  },
  // R12. prompt-suggestions => stream-json output. The suggestion arrives
  //      as its own `prompt_suggestion` event; the text and json adapters
  //      have nowhere to put it.
  (o) => {
    if (o['prompt-suggestions'] === true && o['output-format'] !== 'stream-json') {
      return '`--prompt-suggestions` requires `--output-format=stream-json`.';
    }
  },
  // R13. autocompact takes `auto` or a token budget in the 100k–1M range.
  //      Accepts a bare integer or a `k`/`m` suffix.
  (o) => {
    const v = o.autocompact;
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v === '') {
      return '`--autocompact` must be `auto` or a token budget between 100k and 1M.';
    }
    if (v === 'auto') return undefined;
    const m = /^(\d+(?:\.\d+)?)([km])?$/i.exec(v.trim());
    if (!m) {
      return `\`--autocompact\` must be \`auto\` or a token budget between 100k and 1M; got ${JSON.stringify(v)}.`;
    }
    const mult = m[2] ? { k: 1e3, m: 1e6 }[m[2].toLowerCase()] : 1;
    const tokens = Number(m[1]) * mult;
    if (!(tokens >= 100_000 && tokens <= 1_000_000)) {
      return `\`--autocompact\` token budget must be between 100k and 1M; got ${JSON.stringify(v)}.`;
    }
  },
];

/**
 * Run all cross-flag rules. Returns an array of error messages; empty when
 * the option set is internally consistent.
 *
 * @param {Record<string, unknown>} options
 * @returns {string[]}
 */
export function validate(options) {
  const errors = [];
  for (const rule of CROSS_RULES) {
    const msg = rule(options);
    if (msg) errors.push(msg);
  }
  return errors;
}
