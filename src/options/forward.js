// Parsed-argv options -> driver request fields.
//
// `buildSpawnArgs()` in the driver is fully spec-driven: it walks
// OPTION_SPEC and emits `--flag value` for every entry whose
// `forward.type` is `'argv'`, reading the value from
// `req[camelCase(spec.name)]`. This module is the other half of that
// contract — it lifts those same options out of the parsed argv map and
// onto the request object under the field names the driver expects.
//
// The two halves used to be maintained by hand at each call site, and
// they drifted: roughly thirty documented flags (`--effort`,
// `--thinking`, `--add-dir`, `--mcp-config`, `--settings`, `--agents`,
// `--betas`, `--fallback-model`, `--tools`, `--bare`, …) parsed cleanly,
// passed validation, and appeared in `--help`, but nothing ever copied
// them into the request, so they were silently dropped before the
// upstream process could see them. Deriving both directions from the
// same spec keeps them in lockstep: appending an entry to OPTION_SPEC is
// once again the only edit a newly-supported upstream flag needs.

import { OPTION_SPEC } from './spec.js';

/**
 * Canonical option name -> driver request field name.
 * Must stay identical to `fieldNameOf()` in `src/index.js`.
 *
 * @param {string} name  e.g. 'no-session-persistence'
 * @returns {string}     e.g. 'noSessionPersistence'
 */
export function fieldNameFor(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Build the driver request fields implied by a parsed option map.
 *
 * Only options that forward to upstream argv are included; shim-enforced
 * options (`--max-turns`, `--max-budget-usd`, `--task-budget`,
 * `--output-format`, …) are the caller's responsibility because they map
 * onto driver behaviour rather than onto spawn argv.
 *
 * Callers should spread the result FIRST and apply their own explicit
 * fields afterwards, so per-path overrides still win.
 *
 * A few upstream flags abort the process unless `claude` is also given
 * `--print` (currently `--include-partial-messages`). Those are marked
 * `printModeOnly` in the spec and are withheld unless the caller says it
 * is running the print-mode path.
 *
 * @param {Record<string, unknown>} options  parsed argv options
 * @param {object} [ctx]
 * @param {boolean} [ctx.printMode=false]    is this the `--print-mode` path?
 * @returns {Record<string, unknown>}        driver request fields
 */
export function forwardedRequestFields(options, { printMode = false } = {}) {
  /** @type {Record<string, unknown>} */
  const fields = {};
  if (!options || typeof options !== 'object') return fields;
  for (const spec of OPTION_SPEC) {
    if (spec.forward?.type !== 'argv') continue;
    if (spec.printModeOnly && !printMode) continue;
    const value = options[spec.name];
    // `buildSpawnArgs` already skips undefined / null / false, but we drop
    // them here too so request objects stay readable in debug dumps and
    // daemon payloads stay small.
    if (value === undefined || value === null || value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    fields[fieldNameFor(spec.name)] = value;
  }
  return fields;
}
