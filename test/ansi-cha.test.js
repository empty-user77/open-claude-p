// Regression: inter-word spacing lost when the TUI positions words with CHA.
//
// The upstream TUI does not emit literal spaces between words on a redraw.
// It positions each word with an absolute column move and lets the terminal
// leave the gap blank. `ansi-strip` translated only CUF (`ESC[nC`), so the
// far more common CHA (`ESC[nG`) was deleted by the general CSI strip and
// every word ran together:
//
//   "Apseudoterminalisasoftwareinterfacethatemulates..."
//
// The byte sequences below are verbatim from a captured session
// (claude 2.1.270, warm PTY, second turn).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ansiStripParser } from '../src/parsers/ansi-strip.js';

/** Feed a whole string through a fresh parser instance. */
function strip(input) {
  const p = ansiStripParser.create();
  return p.feed(input).text;
}

const ESC = '\x1b';

describe('ansi-strip: absolute column moves (CHA)', () => {
  test('captured assistant line keeps its inter-word spaces', () => {
    // Exactly as captured off the wire.
    const raw =
      `\r${ESC}[2C${ESC}[14BA${ESC}[5Gpseudoterminal${ESC}[20Gis${ESC}[23Ga` +
      `${ESC}[25Gsoftware${ESC}[34Ginterface${ESC}[44Gthat${ESC}[49Gemulates`;
    const out = strip(raw);
    assert.match(out, /A pseudoterminal is a software interface that emulates/);
  });

  test('CHA advances to the requested column', () => {
    // `ESC[10G` = go to column 10 (1-based) => index 9.
    assert.equal(strip(`ab${ESC}[10Gcd`), 'ab' + ' '.repeat(7) + 'cd');
  });

  test('a CHA that does not move forward inserts nothing', () => {
    // Backwards moves cannot be represented with spaces; we must not
    // invent padding, and must not crash.
    assert.equal(strip(`abcdef${ESC}[3Gxy`), 'abcdefxy');
    assert.equal(strip(`abc${ESC}[4Gxy`), 'abcxy');
  });

  test('carriage return resets the column', () => {
    assert.equal(strip(`abcdef\r${ESC}[3Gx`), 'abcdef\r  x');
  });

  test('newline resets the column', () => {
    assert.equal(strip(`abcdef\n${ESC}[3Gx`), 'abcdef\n  x');
  });

  test('CUF still expands, and composes with CHA', () => {
    // CUF is relative, CHA is absolute; both must land on the same column.
    assert.equal(strip(`a${ESC}[2Cb`), 'a  b');
    assert.equal(strip(`a${ESC}[4Gb`), 'a  b');
  });

  test('CHA with no parameter means column 1', () => {
    assert.equal(strip(`abc${ESC}[Gx`), 'abcx');
  });

  test('cursor up/down do not change the column', () => {
    // `ESC[14B` moves down a row; the column is untouched, so the
    // following CHA must still be measured from the current column.
    assert.equal(strip(`ab${ESC}[14B${ESC}[6Gz`), 'ab' + ' '.repeat(3) + 'z');
  });

  test('colour codes do not occupy columns', () => {
    // SGR is zero-width; counting it would shift every later CHA.
    assert.equal(strip(`${ESC}[38;2;1;2;3mab${ESC}[39m${ESC}[6Gz`), 'ab   z');
  });

  test('a split CHA sequence across chunks is still expanded', () => {
    const p = ansiStripParser.create();
    const a = p.feed(`ab${ESC}[1`).text;
    const b = p.feed(`0Gcd`).text;
    assert.equal(a + b, 'ab' + ' '.repeat(7) + 'cd');
  });

  test('padding is capped for absurd column targets', () => {
    const out = strip(`a${ESC}[100000Gb`);
    assert.ok(out.length < 1000, `unbounded padding: ${out.length} chars`);
  });
});
