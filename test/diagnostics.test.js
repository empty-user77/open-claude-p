import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { detectStallCause } from '../src/diagnostics/stall-cause.js';

describe('detectStallCause', () => {
  test('returns null for empty / non-string input', () => {
    assert.equal(detectStallCause(null), null);
    assert.equal(detectStallCause(undefined), null);
    assert.equal(detectStallCause(''), null);
    assert.equal(detectStallCause(42), null);
  });

  test('detects MCP-auth status banner', () => {
    const tail = `
      [Sonnet 4.6] · Project foo
      auto mode unavailable for this model
      1 MCP server needs auth · /mcp
    `;
    const cause = detectStallCause(tail);
    assert.equal(cause?.kind, 'mcp-auth-required');
    assert.match(cause.hint, /\/mcp/);
  });

  test('detects folder-trust dialog', () => {
    const tail = 'Quick safety check\nIs this a project you trust?';
    const cause = detectStallCause(tail);
    assert.equal(cause?.kind, 'trust-required');
  });

  test('detects theme picker', () => {
    const cause = detectStallCause('Choose your theme\n  > Dark\n    Light');
    assert.equal(cause?.kind, 'theme-picker');
  });

  test('detects login expiry', () => {
    const cause = detectStallCause('Please log in to continue.');
    assert.equal(cause?.kind, 'login-expired');
  });

  test('detects tool-permission ask', () => {
    const cause = detectStallCause('Allow this tool? (y/n)');
    assert.equal(cause?.kind, 'tool-permission');
  });

  test('detects paste-mode not submitted', () => {
    const tail = `
      ⏵⏵ bypass permissions on (shift+tab to cycle)
      [Pasted text #1 +21 lines]
      paste again to expand
    `;
    const cause = detectStallCause(tail);
    assert.equal(cause?.kind, 'paste-not-submitted');
  });

  test('MCP-auth wins over paste-not-submitted when both present', () => {
    // The list is most-actionable-first; an unauth MCP server is a
    // user-config issue and the paste pattern can be a downstream
    // symptom (large prompt + slow first response). The caller should
    // see the MCP hint so they can fix the env first.
    const tail = `
      1 MCP server needs auth · /mcp
      [Pasted text #1 +21 lines]
    `;
    const cause = detectStallCause(tail);
    assert.equal(cause?.kind, 'mcp-auth-required');
  });

  test('returns null when no known pattern matches', () => {
    const tail = 'Some unrelated TUI banner\nwith no signal we recognise';
    assert.equal(detectStallCause(tail), null);
  });
});
