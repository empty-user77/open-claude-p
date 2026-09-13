// Unit tests for `cleanResponse` — the last-line-of-defence scrubber
// the chat client applies to PTY-extracted text. The patterns here
// are drawn from real PTY captures (Cosmica integration test plus the
// open-claude-p stress harness) where the upstream's claude-hud
// plugin and MCP-auth banner interleaved with the assistant content.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { cleanResponse, TUI_CHROME_PATTERNS } from '../src/chat/index.js';

describe('cleanResponse — TUI chrome scrubbing', () => {
  test('passes clean assistant markdown through unchanged', () => {
    const input = "## SQLite\n\n**Pros**\n- Zero-config embedded engine.\n- Fast.\n";
    const out = cleanResponse(input);
    assert.match(out, /## SQLite/);
    assert.match(out, /Zero-config embedded engine/);
  });

  test('drops a standalone HUD counter line', () => {
    const input = [
      "## SQLite",
      "6 rules | 2 MCPs | 4 hooks",
      "- Embedded engine",
    ].join('\n');
    const out = cleanResponse(input);
    assert.doesNotMatch(out, /\d+\s+rules?\s*\|\s*\d+\s+MCPs?/);
    assert.match(out, /Embedded engine/);
  });

  test('removes inline HUD fragment without dropping the surrounding line', () => {
    const input =
      "SQLite Pros 6 rules | 2 MCPs | 4 hooks - Zero-config embedded engine.";
    const out = cleanResponse(input);
    assert.doesNotMatch(out, /rules?\s*\|/);
    assert.match(out, /SQLite Pros/);
    assert.match(out, /Zero-config embedded engine/);
  });

  test('drops the "MCP server needs auth · /mcp" banner', () => {
    const input = [
      "WebSockets are great.",
      "1 MCP server needs auth · /mcp",
      "Use them for chat.",
    ].join('\n');
    const out = cleanResponse(input);
    assert.doesNotMatch(out, /needs auth/);
    assert.match(out, /WebSockets/);
    assert.match(out, /Use them for chat/);
  });

  test('handles the inline MCP-auth banner mid-line', () => {
    const input = "WebSockets vs. HTTP Long-Polling 1 MCP server needs auth · /mcp Connection model";
    const out = cleanResponse(input);
    assert.doesNotMatch(out, /needs auth/);
    assert.match(out, /WebSockets vs\. HTTP Long-Polling/);
    assert.match(out, /Connection model/);
  });

  test('drops `auto mode unavailable for this model` banner', () => {
    const input = "Reply line one\nauto mode unavailable for this model\nReply line two";
    const out = cleanResponse(input);
    assert.doesNotMatch(out, /auto mode unavailable/);
    assert.match(out, /Reply line one[\s\S]*Reply line two/);
  });

  test('drops the prompt-input chevron line', () => {
    const input = "Real content above.\n❯ \nMore real content below.";
    const out = cleanResponse(input);
    assert.doesNotMatch(out, /^❯\s*$/m);
    assert.match(out, /Real content above/);
    assert.match(out, /More real content below/);
  });

  test('drops `[Pasted text #N]` placeholder line', () => {
    const input = "Question text.\n[Pasted text #1 +21 lines]\nAnswer text.";
    const out = cleanResponse(input);
    assert.doesNotMatch(out, /Pasted text/);
    assert.match(out, /Question text/);
    assert.match(out, /Answer text/);
  });

  test('drops the `Context ░░…░░ N%` meter row', () => {
    const input = "Substantive text.\nContext ░░░░░░░░░░ 0%\nMore substantive text.";
    const out = cleanResponse(input);
    assert.doesNotMatch(out, /^Context\s/m);
    assert.match(out, /Substantive text/);
    assert.match(out, /More substantive text/);
  });

  test('drops the `⏵⏵ bypass permissions …` mode-line', () => {
    const input = "Real answer.\n⏵⏵ bypass permissions on (shift+tab to cycle)\nReal answer continued.";
    const out = cleanResponse(input);
    assert.doesNotMatch(out, /bypass permissions/);
    assert.match(out, /Real answer/);
  });

  test('drops the `[Sonnet 4.6] │ ProjectName` statusline cell', () => {
    const input = "Hello.\n[Sonnet 4.6] │ ExtraDeviceWorkspace\nGoodbye.";
    const out = cleanResponse(input);
    assert.doesNotMatch(out, /Sonnet 4\.6/);
    assert.match(out, /Hello/);
    assert.match(out, /Goodbye/);
  });

  test('strips the sentinel marker if it leaks into the text', () => {
    const input = "The answer is 42.\n⟦OCP_END:abc123⟧";
    const out = cleanResponse(input);
    assert.doesNotMatch(out, /OCP_END/);
    assert.match(out, /The answer is 42/);
  });

  test('preserves code-block indentation in surviving lines', () => {
    const input = [
      "```python",
      "def hello():",
      "    return 'world'",
      "```",
    ].join('\n');
    const out = cleanResponse(input);
    assert.match(out, /^    return 'world'$/m);
  });

  test('collapses 3+ blank lines but keeps paragraph breaks', () => {
    const input = "Paragraph one.\n\n\n\nParagraph two.";
    const out = cleanResponse(input);
    assert.equal(out.split('\n\n').length, 2);
  });

  test('TUI_CHROME_PATTERNS is exported and non-empty', () => {
    assert.ok(Array.isArray(TUI_CHROME_PATTERNS));
    assert.ok(TUI_CHROME_PATTERNS.length > 5);
    for (const re of TUI_CHROME_PATTERNS) assert.ok(re instanceof RegExp);
  });
});

describe('cleanResponse: statusline meters leaked onto the answer line', () => {
  // Verbatim from a warm-daemon run (claude 2.1.270 with a statusline
  // plugin active). The TUI paints its spinner cell to the left of the
  // streamed reply and the usage meters to the right, and when the
  // upstream JSONL is unavailable all three land on one line.
  const LEAKED =
    '63✢                  88  A pseudoterminal is a pair of virtual devices ' +
    'that emulate a physical terminal to allow programs to interact with user ' +
    'input and output streams bidirectionally.          ██         22% │ ' +
    'Usage ██░░░░░░░░ 16% (resets in 3h 18m) | Weekly ░░░░░░░░░░ 3% (resets in 6d 1h)';

  test('the answer survives intact', () => {
    const out = cleanResponse(LEAKED);
    assert.match(out, /^A pseudoterminal is a pair of virtual devices/);
    assert.match(out, /bidirectionally\.$/);
  });

  test('the usage and weekly meters are gone', () => {
    const out = cleanResponse(LEAKED);
    assert.doesNotMatch(out, /Usage/);
    assert.doesNotMatch(out, /Weekly/);
    assert.doesNotMatch(out, /resets in/);
  });

  test('meter bar glyphs are gone', () => {
    assert.doesNotMatch(cleanResponse(LEAKED), /[█░]/);
  });

  test('the leading spinner cell and its counters are gone', () => {
    const out = cleanResponse(LEAKED);
    assert.doesNotMatch(out, /^\s*\d/);
    assert.doesNotMatch(out, /✢/);
  });

  test('a spinner cell with the counter on the right is also handled', () => {
    assert.equal(cleanResponse('✳ 128  Here is the answer.'), 'Here is the answer.');
  });

  test('prose containing percentages and pipes is not damaged', () => {
    // The meter patterns require bar glyphs, so ordinary text with a
    // percentage or a pipe must pass through untouched.
    const prose = 'Throughput rose 22% | latency fell, and coverage hit 91%.';
    assert.equal(cleanResponse(prose), prose);
  });

  test('a bulleted line is not mistaken for a spinner cell', () => {
    // `·` is in the spinner glyph set; without an adjacent counter it is
    // just a bullet and the line must survive.
    assert.equal(cleanResponse('· install the dependencies'), '· install the dependencies');
  });

  test('a line that is only a meter is dropped entirely', () => {
    assert.equal(cleanResponse('██████░░░░ 22% │ Usage ██░░ 16% (resets in 3h)'), '');
  });
});

describe('cleanResponse: stray token counters', () => {
  test('a bare counter line beside real content is dropped', () => {
    assert.equal(cleanResponse('63\nA pseudoterminal emulates a terminal.'),
      'A pseudoterminal emulates a terminal.');
    assert.equal(cleanResponse('A pseudoterminal emulates a terminal.\n128'),
      'A pseudoterminal emulates a terminal.');
  });

  test('a numeric answer is NOT dropped when it is the whole reply', () => {
    // `ocp "what is 6*7"` must still be able to answer "42".
    assert.equal(cleanResponse('42'), '42');
    assert.equal(cleanResponse('  42  '), '42');
  });

  test('a numeric line inside a list survives', () => {
    // Only lines that are nothing but a bare integer are candidates, and
    // only when other content exists — but a numbered/among-prose figure
    // that carries any other character must never be touched.
    assert.equal(cleanResponse('Results:\n42 requests\ndone'),
      'Results:\n42 requests\ndone');
  });
});

describe('cleanResponse: spinner cell left alone on a line', () => {
  test('a glyph-plus-counter line beside real content is dropped', () => {
    assert.equal(
      cleanResponse('✢                    63\nA pseudoterminal emulates a terminal.'),
      'A pseudoterminal emulates a terminal.',
    );
    assert.equal(cleanResponse('✳ 128\nThe answer.'), 'The answer.');
  });

  test('a numeric answer is still never swallowed', () => {
    assert.equal(cleanResponse('42'), '42');
  });

  test('a glyph line with prose is not dropped', () => {
    assert.equal(cleanResponse('· 5 minutes later\nthen it finished'),
      '· 5 minutes later\nthen it finished');
  });
});
