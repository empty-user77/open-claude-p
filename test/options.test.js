// Unit tests for the options module.
//
// Covers:
//   - parseArgv: long/short flags, =value, repeatable arrays, variadic
//     arrays, `--` terminator, positional collection, unknown flags,
//     missing values, invalid enum choices, boolean=value forms, short
//     bundles.
//   - validate: each cross-rule pass and fail case.
//
// Run with: `node --test test/options.test.js` (or `npm test`).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv } from '../src/options/parse-argv.js';
import { validate } from '../src/options/validate.js';

describe('parseArgv — positional and prompt', () => {
  test('captures a bare prompt as positional', () => {
    const r = parseArgv(['hello']);
    assert.deepEqual(r.positional, ['hello']);
    assert.deepEqual(r.unknown, []);
    assert.deepEqual(r.errors, []);
  });

  test('keeps positional after flags', () => {
    const r = parseArgv(['--model', 'sonnet', 'hello world']);
    assert.equal(r.options.model, 'sonnet');
    assert.deepEqual(r.positional, ['hello world']);
  });

  test('`--` terminates flag parsing', () => {
    const r = parseArgv(['--', '--not-a-flag', '-x']);
    assert.deepEqual(r.positional, ['--not-a-flag', '-x']);
    assert.deepEqual(r.unknown, []);
  });
});

describe('parseArgv — boolean flags', () => {
  test('long boolean: --verbose sets true', () => {
    const r = parseArgv(['--verbose']);
    assert.equal(r.options.verbose, true);
  });

  test('short boolean: -p sets `print` true', () => {
    const r = parseArgv(['-p']);
    assert.equal(r.options.print, true);
  });

  test('bundled short booleans: -ph sets print AND help', () => {
    const r = parseArgv(['-ph']);
    assert.equal(r.options.print, true);
    assert.equal(r.options.help, true);
  });

  test('inline boolean value: --verbose=false', () => {
    const r = parseArgv(['--verbose=false']);
    assert.equal(r.options.verbose, false);
  });

  test('boolean does not consume the next token', () => {
    const r = parseArgv(['--verbose', 'hello']);
    assert.equal(r.options.verbose, true);
    assert.deepEqual(r.positional, ['hello']);
  });
});

describe('parseArgv — string / enum / number', () => {
  test('--model with value', () => {
    const r = parseArgv(['--model', 'sonnet']);
    assert.equal(r.options.model, 'sonnet');
  });

  test('--model=inline form', () => {
    const r = parseArgv(['--model=sonnet']);
    assert.equal(r.options.model, 'sonnet');
  });

  test('--output-format accepts text', () => {
    const r = parseArgv(['--output-format', 'text']);
    assert.equal(r.options['output-format'], 'text');
    assert.deepEqual(r.errors, []);
  });

  test('--output-format rejects unknown choice', () => {
    const r = parseArgv(['--output-format', 'yaml']);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /expected one of/);
  });

  test('missing value for non-boolean flag is an error', () => {
    const r = parseArgv(['--model']);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /requires a value/);
  });
});

describe('parseArgv — array (variadic and repeatable)', () => {
  test('variadic: --allowed-tools a b c collects all three', () => {
    const r = parseArgv(['--allowed-tools', 'Bash', 'Edit', 'Read']);
    assert.deepEqual(r.options['allowed-tools'], ['Bash', 'Edit', 'Read']);
  });

  test('repeatable: --allowed-tools a --allowed-tools b accumulates', () => {
    const r = parseArgv(['--allowed-tools', 'Bash', '--allowed-tools', 'Edit']);
    assert.deepEqual(r.options['allowed-tools'], ['Bash', 'Edit']);
  });

  test('mixed variadic + repeatable', () => {
    const r = parseArgv([
      '--allowed-tools', 'Bash', 'Edit',
      '--allowed-tools', 'Read',
    ]);
    assert.deepEqual(r.options['allowed-tools'], ['Bash', 'Edit', 'Read']);
  });

  test('variadic stops at the next flag', () => {
    const r = parseArgv(['--allowed-tools', 'Bash', 'Edit', '--verbose']);
    assert.deepEqual(r.options['allowed-tools'], ['Bash', 'Edit']);
    assert.equal(r.options.verbose, true);
  });

  test('array flag with no values is an error', () => {
    const r = parseArgv(['--allowed-tools', '--verbose']);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /requires at least one value/);
    assert.equal(r.options.verbose, true);
  });

  test('long-alias allowedTools resolves to canonical name', () => {
    const r = parseArgv(['--allowedTools', 'Bash']);
    assert.deepEqual(r.options['allowed-tools'], ['Bash']);
  });
});

describe('parseArgv — unknown and edge cases', () => {
  test('unknown long flag goes to unknown list', () => {
    const r = parseArgv(['--no-such-flag', 'x']);
    assert.deepEqual(r.unknown, ['--no-such-flag']);
    // 'x' is treated as positional since the unknown flag was not consumed.
    assert.deepEqual(r.positional, ['x']);
  });

  test('unknown short flag goes to unknown list', () => {
    const r = parseArgv(['-z']);
    assert.deepEqual(r.unknown, ['-z']);
  });

  test('a lone "-" is treated as positional', () => {
    const r = parseArgv(['-']);
    assert.deepEqual(r.positional, ['-']);
  });

  test('defaults are pre-seeded into the options object', () => {
    const r = parseArgv([]);
    assert.equal(r.options['output-format'], 'text');
    assert.equal(r.options.print, false);
    assert.equal(r.options.verbose, false);
    assert.equal(r.options.help, false);
  });
});

describe('validate — cross-flag rules', () => {
  test('R1: input-format=stream-json without stream-json output errors', () => {
    const errs = validate({ 'input-format': 'stream-json', 'output-format': 'text' });
    assert.equal(errs.length, 1);
    assert.match(errs[0], /input-format=stream-json/);
  });

  test('R1: input-format=stream-json + output-format=stream-json passes', () => {
    const errs = validate({ 'input-format': 'stream-json', 'output-format': 'stream-json' });
    assert.deepEqual(errs, []);
  });

  test('R2: --replay-user-messages requires both stream-json sides', () => {
    const errs = validate({ 'replay-user-messages': true, 'output-format': 'stream-json' });
    assert.equal(errs.length, 1);
    assert.match(errs[0], /replay-user-messages/);
  });

  test('R2: --replay-user-messages with both stream-json passes', () => {
    const errs = validate({
      'replay-user-messages': true,
      'input-format': 'stream-json',
      'output-format': 'stream-json',
    });
    assert.deepEqual(errs, []);
  });

  test('R3: --include-hook-events requires stream-json output', () => {
    const errs = validate({ 'include-hook-events': true, 'output-format': 'text' });
    assert.equal(errs.length, 1);
    assert.match(errs[0], /include-hook-events/);
  });

  test('R4: --include-partial-messages requires stream-json output', () => {
    const errs = validate({ 'include-partial-messages': true, 'output-format': 'json' });
    assert.equal(errs.length, 1);
    assert.match(errs[0], /include-partial-messages/);
  });

  test('valid baseline (no flags set) passes', () => {
    const errs = validate({ 'output-format': 'text' });
    assert.deepEqual(errs, []);
  });

  test('R5: max-budget-usd must be positive number', () => {
    assert.ok(validate({ 'output-format': 'text', 'max-budget-usd': 0 }).some((e) => /max-budget-usd/.test(e)));
    assert.ok(validate({ 'output-format': 'text', 'max-budget-usd': -1 }).some((e) => /max-budget-usd/.test(e)));
    assert.deepEqual(validate({ 'output-format': 'text', 'max-budget-usd': 0.5 }), []);
  });

  test('R6: task-budget must be positive integer', () => {
    assert.ok(validate({ 'output-format': 'text', 'task-budget': 0 }).some((e) => /task-budget/.test(e)));
    assert.ok(validate({ 'output-format': 'text', 'task-budget': 1.5 }).some((e) => /task-budget/.test(e)));
    assert.deepEqual(validate({ 'output-format': 'text', 'task-budget': 100 }), []);
  });

  test('R7: session-id must be UUID-shaped', () => {
    assert.ok(validate({ 'output-format': 'text', 'session-id': 'not-a-uuid' }).some((e) => /session-id/.test(e)));
    assert.deepEqual(
      validate({ 'output-format': 'text', 'session-id': '05af21cb-90d7-4ad5-adec-3831f1584d26' }),
      [],
    );
  });

  test('R8: permission-mode must be a known value', () => {
    assert.ok(validate({ 'output-format': 'text', 'permission-mode': 'cowboy' }).some((e) => /permission-mode/.test(e)));
    assert.deepEqual(validate({ 'output-format': 'text', 'permission-mode': 'plan' }), []);
  });

  test('R9: resume and continue are mutually exclusive', () => {
    const errs = validate({
      'output-format': 'text',
      resume: '05af21cb-90d7-4ad5-adec-3831f1584d26',
      continue: true,
    });
    assert.ok(errs.some((e) => /mutually exclusive/.test(e)));
  });

  test('R10: fork-session requires resume or continue', () => {
    const errs = validate({ 'output-format': 'text', 'fork-session': true });
    assert.ok(errs.some((e) => /fork-session/.test(e)));
    // With resume → OK
    assert.deepEqual(
      validate({
        'output-format': 'text',
        'fork-session': true,
        resume: '05af21cb-90d7-4ad5-adec-3831f1584d26',
      }),
      [],
    );
    // With continue → OK
    assert.deepEqual(
      validate({ 'output-format': 'text', 'fork-session': true, continue: true }),
      [],
    );
  });
});

describe('parseArgv + validate — end-to-end', () => {
  test('a typical chat invocation is valid', () => {
    const r = parseArgv([
      '--model', 'sonnet',
      '--output-format', 'stream-json',
      '--allowed-tools', 'Read',
      '--verbose',
      'tell me a joke',
    ]);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.unknown, []);
    assert.deepEqual(validate(r.options), []);
    assert.equal(r.options.model, 'sonnet');
    assert.equal(r.options['output-format'], 'stream-json');
    assert.deepEqual(r.options['allowed-tools'], ['Read']);
    assert.equal(r.options.verbose, true);
    assert.deepEqual(r.positional, ['tell me a joke']);
  });

  test('a `claude -p`-style drop-in is parsed identically without -p', () => {
    const a = parseArgv(['-p', 'hello']);
    const b = parseArgv(['hello']);
    // Both should have the same positional and the same effective options
    // (only difference: `print` is true vs false; semantically a no-op).
    assert.deepEqual(a.positional, b.positional);
    assert.equal(a.options.print, true);
    assert.equal(b.options.print, false);
    assert.deepEqual(a.errors, []);
    assert.deepEqual(b.errors, []);
  });
});
