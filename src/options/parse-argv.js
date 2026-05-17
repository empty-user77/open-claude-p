// argv -> normalized options object.
//
// A small hand-rolled parser that consumes the OPTION_SPEC contract. No
// third-party dependency, to keep this package's runtime footprint to just
// `node-pty`.
//
// Supported forms:
//   --flag                       boolean true (or array-marker for kind=array)
//   --flag value                 string / number / enum / json / first array elem
//   --flag=value                 inline value
//   --flag a b c                 array kind: collect variadic until next flag
//   --flag a --flag b            array kind with repeatable: accumulates
//   -x                           short flag
//   -xyz                         bundled boolean shorts: -x -y -z
//   --                           end of options; remaining tokens are positional
//   anything else                positional
//
// Returns `{ options, positional, unknown, errors }`. Callers decide whether
// to fail on errors or treat unknown flags as forwarded pass-through.

import { OPTION_SPEC, getOption } from './spec.js';

/**
 * @typedef {object} ParseResult
 * @property {Record<string, unknown>} options
 * @property {string[]} positional
 * @property {string[]} unknown      Tokens that look like flags but were not in the spec.
 * @property {string[]} errors       Human-readable error strings.
 */

/**
 * @param {string[]} argv
 * @returns {ParseResult}
 */
export function parseArgv(argv) {
  /** @type {ParseResult} */
  const out = { options: {}, positional: [], unknown: [], errors: [] };

  // Pre-seed defaults so the validator sees them.
  for (const spec of OPTION_SPEC) {
    if (Object.prototype.hasOwnProperty.call(spec, 'default')) {
      out.options[spec.name] = spec.default;
    }
  }

  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];

    if (tok === '--') {
      for (const rest of argv.slice(i + 1)) out.positional.push(rest);
      break;
    }

    if (tok.startsWith('--')) {
      // Long flag (possibly with inline =value).
      const eq = tok.indexOf('=');
      const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      const inline = eq === -1 ? undefined : tok.slice(eq + 1);
      const spec = getOption(name);
      if (!spec) {
        out.unknown.push(tok);
        i++;
        continue;
      }
      i = consumeOption(spec, argv, i, inline, out);
      continue;
    }

    if (tok.length > 1 && tok.startsWith('-') && tok !== '-') {
      // Short flag or bundle (e.g. -p or -pv).
      const chars = tok.slice(1).split('');
      // `consumedByValue` is true only if a non-boolean short flag was
      // matched and consumeOption() already advanced `i` for us. In every
      // other case (all booleans, all unknown, mixed unknown+boolean) we
      // must advance i by one ourselves at the end.
      let consumedByValue = false;
      for (let k = 0; k < chars.length; k++) {
        const ch = chars[k];
        const spec = OPTION_SPEC.find((o) => o.short === ch);
        if (!spec) {
          out.unknown.push(`-${ch}`);
          continue;
        }
        if (spec.kind !== 'boolean') {
          // Non-boolean short. The value comes from the next argv token;
          // bundling a non-boolean with trailing chars is rejected.
          if (k !== chars.length - 1) {
            out.errors.push(
              `Short flag -${ch} requires a value and cannot be bundled with -${chars
                .slice(k + 1)
                .join('')}.`,
            );
            break;
          }
          i = consumeOption(spec, argv, i, undefined, out);
          consumedByValue = true;
          break;
        }
        // Boolean short: just set.
        out.options[spec.name] = true;
      }
      if (!consumedByValue) i++;
      continue;
    }

    // Positional argument.
    out.positional.push(tok);
    i++;
  }

  return out;
}

/**
 * Consume the value(s) for `spec` starting at argv index `i` (where argv[i]
 * is the flag token itself). `inline` is the post-`=` value when present.
 * Returns the new index to resume parsing at.
 *
 * @returns {number}
 */
function consumeOption(spec, argv, i, inline, out) {
  const name = spec.name;
  const flagToken = argv[i];

  if (spec.kind === 'boolean') {
    if (inline !== undefined) {
      // --flag=true / --flag=false / --flag=1 / --flag=0
      const v = inline.toLowerCase();
      out.options[name] = v === 'true' || v === '1' || v === 'yes';
    } else {
      out.options[name] = true;
    }
    return i + 1;
  }

  if (spec.kind === 'array') {
    /** @type {string[]} */
    const arr = Array.isArray(out.options[name]) ? out.options[name] : [];
    let j = i + 1;
    if (inline !== undefined) {
      arr.push(inline);
    } else {
      // Collect variadic values until the next flag-looking token.
      while (j < argv.length && !looksLikeFlag(argv[j])) {
        arr.push(argv[j]);
        j++;
      }
      if (arr.length === 0) {
        out.errors.push(`${flagToken} requires at least one value.`);
      }
    }
    out.options[name] = arr;
    return j;
  }

  // string / number / enum / json — consume exactly one value.
  let raw;
  if (inline !== undefined) {
    raw = inline;
  } else if (i + 1 < argv.length && !looksLikeFlag(argv[i + 1])) {
    raw = argv[i + 1];
    i += 1;
  } else {
    out.errors.push(`${flagToken} requires a value.`);
    return i + 1;
  }

  const { value, error } = coerce(spec, raw);
  if (error) out.errors.push(`${flagToken}: ${error}`);
  else out.options[name] = value;
  return i + 1;
}

/**
 * @param {string} tok
 */
function looksLikeFlag(tok) {
  if (tok === undefined) return false;
  if (tok === '-' || tok === '--') return true;
  return tok.startsWith('--') || /^-[A-Za-z]/.test(tok);
}

/**
 * @param {object} spec
 * @param {string} raw
 * @returns {{ value?: unknown, error?: string }}
 */
function coerce(spec, raw) {
  switch (spec.kind) {
    case 'string':
      return { value: raw };
    case 'number': {
      const n = Number(raw);
      if (Number.isNaN(n)) return { error: `expected a number, got ${JSON.stringify(raw)}` };
      return { value: n };
    }
    case 'enum':
      if (!spec.choices.includes(raw)) {
        return {
          error: `expected one of ${spec.choices.join(', ')}, got ${JSON.stringify(raw)}`,
        };
      }
      return { value: raw };
    case 'json':
      try {
        return { value: JSON.parse(raw) };
      } catch (e) {
        return { error: `invalid JSON: ${e.message}` };
      }
    default:
      return { error: `unsupported kind ${JSON.stringify(spec.kind)}` };
  }
}
