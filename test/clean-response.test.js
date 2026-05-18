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
