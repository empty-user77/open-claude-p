// Regression: ocp running inside a Claude Code session produced sessions
// that were never persisted.
//
// The child `claude` inherited the caller's session identity (id, IPC
// bridge, `CLAUDE_CODE_CHILD_SESSION`) and treated itself as a
// continuation of that session rather than a new one. It then wrote no
// session JSONL, so `sessionId` came back null, the clean transcript was
// unavailable (answers fell back to PTY-scraped text), and `--continue`
// had nothing to resume.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { scrubParentSessionEnv } from '../src/index.js';

const PARENT = {
  CLAUDE_CODE_SESSION_ID: '0795f64a-2b67-4b05-af38-f5334b578f51',
  CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_01EGmumPVxqYXXpSfQzH717q',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/10361.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'deadbeef',
  CLAUDE_CODE_EXECPATH: '/Users/x/.local/share/claude/versions/2.1.258',
};

describe('scrubParentSessionEnv', () => {
  test('every parent-session variable is removed', () => {
    const out = scrubParentSessionEnv({ ...PARENT, PATH: '/usr/bin' });
    for (const key of Object.keys(PARENT)) {
      assert.equal(key in out, false, `${key} survived the scrub`);
    }
  });

  test('unrelated environment is preserved', () => {
    const out = scrubParentSessionEnv({ ...PARENT, PATH: '/usr/bin', HOME: '/Users/x' });
    assert.equal(out.PATH, '/usr/bin');
    assert.equal(out.HOME, '/Users/x');
  });

  test('user-facing Claude configuration is NOT scrubbed', () => {
    // These configure Claude generally; only session identity goes.
    const config = {
      CLAUDE_CODE_SIMPLE: '1',
      CLAUDE_CODE_SAFE_MODE: '1',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_API_KEY: 'sk-test',
    };
    const out = scrubParentSessionEnv({ ...PARENT, ...config });
    for (const [k, v] of Object.entries(config)) assert.equal(out[k], v, `${k} was scrubbed`);
  });

  test('an explicitly-supplied value wins over the scrub', () => {
    // A caller that deliberately sets one of these means it.
    const explicit = { CLAUDE_CODE_ENTRYPOINT: 'sdk' };
    const out = scrubParentSessionEnv({ ...PARENT, ...explicit }, explicit);
    assert.equal(out.CLAUDE_CODE_ENTRYPOINT, 'sdk');
    assert.equal('CLAUDE_CODE_SESSION_ID' in out, false);
  });

  test('the input object is not mutated', () => {
    const input = { ...PARENT };
    scrubParentSessionEnv(input);
    assert.equal(input.CLAUDE_CODE_SESSION_ID, PARENT.CLAUDE_CODE_SESSION_ID);
  });

  test('an env with none of these variables is unchanged', () => {
    const plain = { PATH: '/usr/bin', TERM: 'xterm' };
    assert.deepEqual(scrubParentSessionEnv(plain), plain);
  });
});
