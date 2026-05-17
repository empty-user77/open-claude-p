// Baseline parser: strip ANSI escape sequences.
//
// We do not attempt to reconstruct a terminal screen here. Cursor moves,
// clears, and color codes are simply removed. The remaining text is what
// downstream parsers consume.
//
// Buffering rule for partial chunks: if the chunk ends with an ESC that has
// not yet been terminated (e.g. mid-CSI), hold it until the next chunk.

const ESC = '\x1b';
const BEL = '\x07';

// Cursor Forward (CUF): `ESC [ Pn C` advances the cursor `Pn` columns
// (default 1). In headless captures the upstream `claude` CLI uses this
// in place of literal space characters for inter-word gaps (a TUI
// rendering optimization). Stripping the sequence collapses words
// together — `each<CUF1>other` becomes `eachother`. We translate CUF
// into the equivalent run of spaces BEFORE the general CSI strip so the
// visible text is preserved.
const RE_CSI_CURSOR_FORWARD = /\x1b\[(\d*)C/g;
function expandCursorForward(text) {
  return text.replace(RE_CSI_CURSOR_FORWARD, (_match, n) => {
    const count = parseInt(n || '1', 10);
    return ' '.repeat(Math.min(count, 200)); // cap defensively
  });
}

// Complete-sequence regexes — used only on input slices we have proven to be
// complete (i.e. without a dangling partial at the end).
const RE_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;       // ESC [ params intermediates final
// OSC-style sequences: ESC introducer then arbitrary content then BEL or ST.
// Covers OSC (`]`), DCS (`P`), SOS (`X`), PM (`^`), APC (`_`).
const RE_STRING_TERMINATED =
  /\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Two-byte ESC forms — covers C1 7-bit aliases (`ESC @`..`ESC _` except the
// CSI/OSC/etc. introducers, which are handled above) AND the DEC private
// single-letter sequences in the 0x30..0x3F range (`ESC 7` = DECSC save
// cursor, `ESC 8` = DECRC restore, `ESC =` / `ESC >` keypad modes, etc.).
// Order is: CSI -> string-terminated -> this, so by the time we reach
// RE_C1 the only `\x1b[`/`\x1b]`/`\x1b_`/... left in the input is either
// complete-and-already-stripped or partial-and-held-back by the pending
// buffer.
const RE_C1  = /\x1b[0-?@-_]/g;

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

export const ansiStripParser = {
  name: 'ansi-strip',
  priority: 10,
  create() {
    let pending = '';
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

        // Translate visible-gap CSI sequences (cursor forward) into
        // literal spaces BEFORE the general CSI strip eats them.
        const expanded = expandCursorForward(input);
        const out = expanded
          .replace(RE_CSI, '')
          .replace(RE_STRING_TERMINATED, '')
          .replace(RE_C1, '');
        return { text: out, events: [] };
      },
      reset() {
        pending = '';
      },
    };
  },
};
