// Baseline parser: strip ANSI escape sequences.
//
// We do not attempt to reconstruct a terminal screen here. Colors, clears
// and vertical moves are simply removed. The one thing we DO model is the
// cursor's horizontal position, because the upstream TUI uses horizontal
// moves in place of literal spaces:
//
//   A\x1b[5Gpseudoterminal\x1b[20Gis\x1b[23Ga\x1b[25Gsoftware
//
// Every inter-word gap there is an absolute column move, not a space. Strip
// the sequences blindly and the words run together — "Apseudoterminalisa…".
// So we track the column and translate a forward move into the run of
// spaces it would have left blank on screen.
//
// Two sequences produce those gaps:
//   CUF — `ESC [ Pn C`  move right Pn columns (relative, default 1)
//   CHA — `ESC [ Pn G`  move to column Pn    (absolute, 1-based, default 1)
//
// CUF alone used to be enough; the current CLI emits CHA for nearly every
// word, which is what made this worth modelling properly rather than
// special-casing one sequence.
//
// Buffering rule for partial chunks: if the chunk ends with an ESC that has
// not yet been terminated (e.g. mid-CSI), hold it until the next chunk.

const ESC = '\x1b';
const BEL = '\x07';

// Defensive ceiling on generated padding. A corrupt or hostile column
// target must not let one escape sequence expand into megabytes.
const MAX_PAD = 200;

/** Introducer characters for OSC-style sequences (BEL/ST terminated). */
const STRING_INTRODUCERS = new Set([']', 'P', 'X', '^', '_']);

function isCompleteEscapeTail(tail) {
  if (tail.length < 2) return false;
  const c1 = tail[1];
  if (c1 === '[') return /\x1b\[[0-?]*[ -/]*[@-~]/.test(tail);
  if (STRING_INTRODUCERS.has(c1)) {
    return tail.includes(BEL) || tail.includes(ESC + '\\');
  }
  // Two-byte form: ESC <letter>. Complete with two characters.
  return tail.length >= 2;
}

/** First numeric parameter of a CSI parameter string, or `fallback`. */
function firstParam(params, fallback) {
  const n = parseInt(params, 10);
  return Number.isNaN(n) ? fallback : n;
}

/** Nth (0-based) numeric parameter of a CSI parameter string. */
function nthParam(params, index, fallback) {
  const raw = params.split(';')[index];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * Strip escapes from `input` while tracking the cursor column, expanding
 * forward horizontal moves into spaces.
 *
 * `state.col` is the 0-based column and persists across chunks, since a
 * rendered line routinely spans several PTY reads.
 *
 * @param {string} input
 * @param {{col: number}} state
 * @returns {string}
 */
function stripTrackingColumn(input, state) {
  let out = '';
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];

    if (ch === '\r' || ch === '\n') {
      out += ch;
      state.col = 0;
      i += 1;
      continue;
    }

    if (ch !== ESC) {
      out += ch;
      state.col += 1;
      i += 1;
      continue;
    }

    const c1 = input[i + 1];

    // ── CSI: ESC [ params intermediates final ────────────────────────────
    if (c1 === '[') {
      let j = i + 2;
      while (j < len) {
        const c = input.charCodeAt(j);
        if (c >= 0x30 && c <= 0x3f) j += 1; // parameter bytes
        else break;
      }
      const paramsEnd = j;
      while (j < len) {
        const c = input.charCodeAt(j);
        if (c >= 0x20 && c <= 0x2f) j += 1; // intermediate bytes
        else break;
      }
      if (j >= len) {
        // Incomplete despite the pending-buffer guard; drop the remainder.
        break;
      }
      const final = input[j];
      const params = input.slice(i + 2, paramsEnd);
      i = j + 1;

      // Private-parameter sequences (`ESC [ ? 25 h`) never move the cursor
      // horizontally in a way we can model; strip them.
      if (params.charCodeAt(0) >= 0x3c && params.charCodeAt(0) <= 0x3f) continue;

      if (final === 'C') {
        // CUF — relative forward move.
        const n = Math.max(0, firstParam(params, 1));
        const pad = Math.min(n, MAX_PAD);
        out += ' '.repeat(pad);
        state.col += pad;
      } else if (final === 'G' || final === '`') {
        // CHA / HPA — absolute column, 1-based.
        const target = Math.max(1, firstParam(params, 1)) - 1;
        if (target > state.col) {
          const pad = Math.min(target - state.col, MAX_PAD);
          out += ' '.repeat(pad);
          state.col += pad;
        }
        // A backwards move would overwrite already-emitted text. We cannot
        // represent that without a screen model, so we neither pad nor
        // rewind — the text simply continues.
      } else if (final === 'H' || final === 'f') {
        // CUP — absolute row;col. This is a jump to another part of the
        // screen (status line, input box), so it never means "gap here";
        // adopt the column but emit no padding.
        state.col = Math.max(1, nthParam(params, 1, 1)) - 1;
      }
      // Everything else (SGR, erase, vertical moves, scroll regions) is
      // zero-width for our purposes: stripped, column untouched.
      continue;
    }

    // ── OSC and friends: ESC ] … BEL | ST ────────────────────────────────
    if (STRING_INTRODUCERS.has(c1)) {
      let j = i + 2;
      while (j < len) {
        if (input[j] === BEL) { j += 1; break; }
        if (input[j] === ESC && input[j + 1] === '\\') { j += 2; break; }
        j += 1;
      }
      i = j;
      continue;
    }

    // ── Two-byte ESC forms (ESC 7, ESC 8, ESC =, C1 aliases) ─────────────
    if (c1 === undefined) break; // dangling ESC; pending guard should catch it
    i += 2;
  }

  return out;
}

export const ansiStripParser = {
  name: 'ansi-strip',
  priority: 10,
  create() {
    let pending = '';
    // Cursor column persists across feeds — a line spans many PTY reads.
    const state = { col: 0 };
    return {
      feed(chunk) {
        let input = pending + chunk;
        pending = '';

        // If input ends with a possibly-incomplete escape sequence, hold its
        // tail back for the next feed() so we don't drop or mangle bytes.
        const lastEsc = input.lastIndexOf(ESC);
        if (lastEsc >= 0) {
          const tail = input.slice(lastEsc);
          if (!isCompleteEscapeTail(tail)) {
            pending = tail;
            input = input.slice(0, lastEsc);
          }
        }

        return { text: stripTrackingColumn(input, state), events: [] };
      },
      reset() {
        pending = '';
        state.col = 0;
      },
    };
  },
};
