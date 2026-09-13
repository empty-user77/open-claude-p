// Guards the spec -> request-field -> spawn-argv contract.
//
// The bug this file exists to prevent: `bin/cli.js` used to hand-list the
// request fields it forwarded, so an option could be added to OPTION_SPEC,
// parse cleanly, validate cleanly, show up in `--help`, and still never
// reach the upstream `claude` process. These tests walk the spec itself,
// so a newly-added flag is covered the moment it is declared.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { OPTION_SPEC } from '../src/options/spec.js';
import { parseArgv } from '../src/options/parse-argv.js';
import { validate } from '../src/options/validate.js';
import { forwardedRequestFields, fieldNameFor } from '../src/options/forward.js';
import {
  buildSpawnArgs, redactArgvForLog, sanitizePassThroughArgv,
} from '../src/index.js';

/** A value that satisfies `spec.kind` and survives round-tripping. */
function sampleFor(spec) {
  switch (spec.kind) {
    case 'boolean': return true;
    case 'number': return 7;
    case 'array': return ['alpha', 'beta'];
    case 'json': return '{"k":"v"}';
    case 'enum': return spec.choices[0];
    default: return `sample-${spec.name}`;
  }
}

const ARGV_FORWARDED = OPTION_SPEC.filter((s) => s.forward?.type === 'argv');
// Flags upstream rejects unless it is also given `--print`; withheld on
// the default PTY path, where forwarding them aborts the spawn.
const PRINT_ONLY = ARGV_FORWARDED.filter((s) => s.printModeOnly);
const ALWAYS_FORWARDED = ARGV_FORWARDED.filter((s) => !s.printModeOnly);

describe('forwardedRequestFields', () => {
  test('every argv-forwarded option reaches the spawn argv', () => {
    // One option at a time, so a failure names the exact flag that broke.
    for (const spec of ALWAYS_FORWARDED) {
      const options = { [spec.name]: sampleFor(spec) };
      const args = buildSpawnArgs(forwardedRequestFields(options));
      assert.ok(
        args.includes(spec.forward.flag),
        `--${spec.name} was dropped between the option map and the spawn argv`,
      );
    }
  });

  test('all argv-forwarded options survive together in one request', () => {
    const options = {};
    for (const spec of ALWAYS_FORWARDED) options[spec.name] = sampleFor(spec);
    const args = buildSpawnArgs(forwardedRequestFields(options));
    const missing = ALWAYS_FORWARDED
      .filter((s) => !args.includes(s.forward.flag))
      .map((s) => `--${s.name}`);
    assert.deepEqual(missing, []);
  });

  test('print-mode-only flags are withheld from the PTY path', () => {
    // Regression: `--include-partial-messages` on the interactive spawn
    // makes upstream print "requires --print and
    // --output-format=stream-json" and exit, failing the whole run.
    assert.ok(PRINT_ONLY.length > 0, 'expected at least one printModeOnly flag');
    for (const spec of PRINT_ONLY) {
      const options = { [spec.name]: sampleFor(spec) };
      const ptyArgs = buildSpawnArgs(forwardedRequestFields(options));
      assert.ok(
        !ptyArgs.includes(spec.forward.flag),
        `--${spec.name} must not reach the interactive spawn`,
      );
      const printArgs = buildSpawnArgs(
        forwardedRequestFields(options, { printMode: true }),
      );
      assert.ok(
        printArgs.includes(spec.forward.flag),
        `--${spec.name} must still reach the print-mode spawn`,
      );
    }
  });

  test('--include-partial-messages is the currently-gated flag', () => {
    // Guard the list so gating another flag is a deliberate act.
    assert.deepEqual(PRINT_ONLY.map((s) => s.name), ['include-partial-messages']);
  });

  test('field names match the driver\'s camelCase convention', () => {
    assert.equal(fieldNameFor('no-session-persistence'), 'noSessionPersistence');
    assert.equal(fieldNameFor('permission-mode'), 'permissionMode');
    assert.equal(fieldNameFor('model'), 'model');
  });

  test('unset, false, null and empty-array values are omitted', () => {
    const fields = forwardedRequestFields({
      model: undefined,
      verbose: false,
      'system-prompt': null,
      'add-dir': [],
      'allowed-tools': ['Read'],
    });
    assert.deepEqual(fields, { allowedTools: ['Read'] });
  });

  test('shim-enforced options are NOT forwarded as argv', () => {
    // These map onto driver behaviour, not onto upstream flags. Forwarding
    // them would make `claude` reject the spawn.
    const fields = forwardedRequestFields({
      'max-turns': 3,
      'max-budget-usd': 1.5,
      'task-budget': 20000,
      'output-format': 'json',
      'input-format': 'text',
      cwd: '/tmp',
    });
    assert.deepEqual(fields, {});
  });

  test('a non-object argument yields an empty field set', () => {
    assert.deepEqual(forwardedRequestFields(undefined), {});
    assert.deepEqual(forwardedRequestFields(null), {});
  });
});

describe('parsed argv reaches the upstream process', () => {
  // Regression: these all parsed and validated but were silently dropped.
  const CASES = [
    { argv: ['--effort', 'xhigh'], flag: '--effort', value: 'xhigh' },
    { argv: ['--thinking', 'adaptive'], flag: '--thinking', value: 'adaptive' },
    { argv: ['--add-dir', '/tmp'], flag: '--add-dir', value: '/tmp' },
    { argv: ['--fallback-model', 'sonnet'], flag: '--fallback-model', value: 'sonnet' },
    { argv: ['--mcp-config', '/tmp/m.json'], flag: '--mcp-config', value: '/tmp/m.json' },
    { argv: ['--settings', '/tmp/s.json'], flag: '--settings', value: '/tmp/s.json' },
    { argv: ['--betas', 'my-beta'], flag: '--betas', value: 'my-beta' },
    { argv: ['--agent', 'reviewer'], flag: '--agent', value: 'reviewer' },
    { argv: ['--tools', 'Bash,Edit'], flag: '--tools', value: 'Bash,Edit' },
    { argv: ['--bare'], flag: '--bare', value: undefined },
    { argv: ['--autocompact', '200k'], flag: '--autocompact', value: '200k' },
    { argv: ['--safe-mode'], flag: '--safe-mode', value: undefined },
    { argv: ['--plugin-url', 'https://x/p.zip'], flag: '--plugin-url', value: 'https://x/p.zip' },
    { argv: ['--ax-screen-reader'], flag: '--ax-screen-reader', value: undefined },
    { argv: ['--brief'], flag: '--brief', value: undefined },
    {
      argv: ['--exclude-dynamic-system-prompt-sections'],
      flag: '--exclude-dynamic-system-prompt-sections',
      value: undefined,
    },
  ];

  for (const { argv, flag, value } of CASES) {
    test(`${argv.join(' ')} -> spawn argv`, () => {
      const parsed = parseArgv([...argv, 'a prompt']);
      assert.deepEqual(parsed.errors, []);
      assert.deepEqual(parsed.unknown, []);
      const args = buildSpawnArgs(forwardedRequestFields(parsed.options));
      const i = args.indexOf(flag);
      assert.notEqual(i, -1, `${flag} missing from spawn argv`);
      if (value !== undefined) assert.equal(args[i + 1], value);
    });
  }
});

describe('option surface matches Claude Code 2.x', () => {
  test('--effort accepts xhigh', () => {
    const r = parseArgv(['--effort', 'xhigh', 'hi']);
    assert.deepEqual(r.errors, []);
    assert.equal(r.options.effort, 'xhigh');
    assert.deepEqual(validate(r.options), []);
  });

  test('--effort still accepts every documented level', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const r = parseArgv(['--effort', level, 'hi']);
      assert.deepEqual(r.errors, [], `--effort ${level} rejected`);
    }
  });

  test('--permission-mode accepts the current `manual` spelling', () => {
    assert.deepEqual(validate({ 'permission-mode': 'manual' }), []);
  });

  test('--permission-mode still accepts the legacy `default` spelling', () => {
    // Upstream continues to accept it, so refusing it here would be a
    // gratuitous break for existing callers.
    assert.deepEqual(validate({ 'permission-mode': 'default' }), []);
  });

  test('--permission-mode rejects an unknown mode', () => {
    assert.equal(validate({ 'permission-mode': 'nope' }).length, 1);
  });

  test('--autocompact accepts auto and a 100k-1M budget', () => {
    for (const v of ['auto', '100k', '200000', '1m', '1000000']) {
      assert.deepEqual(validate({ autocompact: v }), [], `--autocompact ${v} rejected`);
    }
  });

  test('--autocompact rejects an out-of-range or malformed budget', () => {
    for (const v of ['50k', '2m', 'huge', '']) {
      assert.equal(validate({ autocompact: v }).length, 1, `--autocompact ${v} accepted`);
    }
  });

  test('--forward-subagent-text requires stream-json output', () => {
    assert.equal(
      validate({ 'forward-subagent-text': true, 'output-format': 'text' }).length, 1,
    );
    assert.deepEqual(
      validate({ 'forward-subagent-text': true, 'output-format': 'stream-json' }), [],
    );
  });

  test('--prompt-suggestions requires stream-json output', () => {
    assert.equal(
      validate({ 'prompt-suggestions': true, 'output-format': 'text' }).length, 1,
    );
    assert.deepEqual(
      validate({ 'prompt-suggestions': true, 'output-format': 'stream-json' }), [],
    );
  });
});

describe('env-var fallbacks (OPTION_SPEC `env:` field)', () => {
  test('an env var fills in an option that argv did not supply', () => {
    const r = parseArgv(['hi'], { OCP_AX_SCREEN_READER: '1' });
    assert.equal(r.options['ax-screen-reader'], true);
    assert.deepEqual(r.errors, []);
  });

  test('argv wins over the env var — including an explicit opt-out', () => {
    // `--print-mode=false` sets the same value as the default, so a
    // value-comparison would mistake it for "not supplied" and let the
    // env var switch it back on.
    const r = parseArgv(['--print-mode=false', 'hi'], { OCP_PRINT_MODE: '1' });
    assert.equal(r.options['print-mode'], false);
  });

  test('argv wins when it turns the option ON and the env says off', () => {
    const r = parseArgv(['--print-mode', 'hi'], { OCP_PRINT_MODE: '0' });
    assert.equal(r.options['print-mode'], true);
  });

  test('falsey and empty env values leave the default alone', () => {
    for (const raw of ['0', '', 'false', 'no', 'off', 'nonsense']) {
      const r = parseArgv(['hi'], { OCP_PRINT_MODE: raw });
      assert.equal(r.options['print-mode'], false, `OCP_PRINT_MODE=${raw} enabled it`);
    }
  });

  test('truthy spellings are all accepted', () => {
    for (const raw of ['1', 'true', 'TRUE', 'yes', 'on']) {
      const r = parseArgv(['hi'], { OCP_PRINT_MODE: raw });
      assert.equal(r.options['print-mode'], true, `OCP_PRINT_MODE=${raw} ignored`);
    }
  });

  test('an absent env map changes nothing', () => {
    const r = parseArgv(['hi'], {});
    assert.equal(r.options['print-mode'], false);
    assert.equal(r.options['no-session-persistence'], false);
    assert.deepEqual(r.errors, []);
  });

  test('non-string and inherited env values are ignored, not thrown on', () => {
    // `env` is caller-supplied on the library path, so it may be any object.
    for (const env of [{ OCP_PRINT_MODE: 1 }, { OCP_PRINT_MODE: {} }, null]) {
      const r = parseArgv(['hi'], env);
      assert.equal(r.options['print-mode'], false);
      assert.deepEqual(r.errors, []);
    }
    // Inherited properties must not count as "set".
    const inherited = Object.create({ OCP_PRINT_MODE: '1' });
    assert.equal(parseArgv(['hi'], inherited).options['print-mode'], false);
  });

  test('only options that declare `env:` are affected', () => {
    const declared = OPTION_SPEC.filter((s) => s.env).map((s) => s.name);
    // Guard the list so adding an `env:` entry is a deliberate act.
    assert.deepEqual(
      declared.sort(),
      ['ax-screen-reader', 'no-session-persistence', 'print-mode'],
    );
  });
});

describe('spawn-argv encoding and log redaction', () => {
  test('json-kind options are serialised, not stringified as [object Object]', () => {
    // `--agents` parses to an object; a plain String() hands upstream the
    // literal "[object Object]". It only became reachable once the flag
    // was actually forwarded.
    const parsed = parseArgv(['--agents', '{"reviewer":{"description":"d"}}', 'hi']);
    const args = buildSpawnArgs(forwardedRequestFields(parsed.options));
    const value = args[args.indexOf('--agents') + 1];
    assert.notEqual(value, '[object Object]');
    assert.deepEqual(JSON.parse(value), { reviewer: { description: 'd' } });
  });

  test('a json-kind option supplied as raw text is not double-encoded', () => {
    // Library callers may pass JSON text directly.
    const args = buildSpawnArgs({ agents: '{"a":1}' });
    assert.equal(args[args.indexOf('--agents') + 1], '{"a":1}');
  });

  test('redaction covers every value of a variadic sensitive flag', () => {
    // `--mcp-config` is variadic and inline configs carry credentials;
    // redacting only the first token leaked the rest into debug logs.
    const logged = redactArgvForLog([
      '--mcp-config', '/tmp/a.json', '{"env":{"TOKEN":"s3cr3t"}}', '--verbose',
    ]).join(' ');
    assert.ok(!logged.includes('s3cr3t'), `secret leaked: ${logged}`);
    assert.ok(logged.includes('--verbose'), 'redaction ate the following flag');
  });

  test('--plugin-url is deny-listed alongside --plugin-dir', () => {
    // Both load untrusted plugin code; only --plugin-dir was listed.
    for (const flag of ['--plugin-dir', '--plugin-url']) {
      const { sanitized, rejected } = sanitizePassThroughArgv([flag, 'x']);
      assert.deepEqual(sanitized, [], `${flag} survived the sanitizer`);
      assert.deepEqual(rejected, [flag]);
    }
  });
});

describe('parseArgv exposes what argv actually supplied', () => {
  // Every option with a `default` is pre-seeded into `options`, so a value
  // alone cannot distinguish "user passed --flag=false" from "user passed
  // nothing". The CLI's permission opt-out depends on telling them apart.
  test('an explicit false is distinguishable from an unset default', () => {
    const unset = parseArgv(['hi'], {});
    const explicit = parseArgv(['--dangerously-skip-permissions=false', 'hi'], {});
    assert.equal(unset.options['dangerously-skip-permissions'], false);
    assert.equal(explicit.options['dangerously-skip-permissions'], false);
    assert.equal(unset.supplied.has('dangerously-skip-permissions'), false);
    assert.equal(explicit.supplied.has('dangerously-skip-permissions'), true);
  });

  test('supplied tracks long, short and bundled-short flags', () => {
    assert.ok(parseArgv(['--verbose', 'hi'], {}).supplied.has('verbose'));
    assert.ok(parseArgv(['--model', 'opus', 'hi'], {}).supplied.has('model'));
    // `-p` (print) and `-c` (continue) are both boolean shorts.
    const bundled = parseArgv(['-pc', 'hi'], {}).supplied;
    assert.ok(bundled.has('print'), '-p not recorded');
    assert.ok(bundled.has('continue'), '-c not recorded');
  });

  test('unknown flags are not recorded as supplied', () => {
    const r = parseArgv(['--not-a-real-flag', 'hi'], {});
    assert.equal(r.supplied.size, 0);
    assert.deepEqual(r.unknown, ['--not-a-real-flag']);
  });
});

describe('Claude Code 2.1.270 flags', () => {
  test('--permission-prompts accepts host and none', () => {
    for (const v of ['host', 'none']) {
      const r = parseArgv(['--permission-prompts', v, 'hi'], {});
      assert.deepEqual(r.errors, []);
      assert.equal(r.options['permission-prompts'], v);
    }
  });

  test('--permission-prompts rejects anything else', () => {
    assert.equal(parseArgv(['--permission-prompts', 'nobody', 'hi'], {}).errors.length, 1);
  });

  test('--system-prompt-snapshot accepts on and off', () => {
    for (const v of ['on', 'off']) {
      assert.deepEqual(parseArgv(['--system-prompt-snapshot', v, 'hi'], {}).errors, []);
    }
  });

  test('the new flags reach the spawn argv', () => {
    const r = parseArgv(
      ['--restricted', '--permission-prompts', 'none', '--system-prompt-snapshot', 'off', 'hi'],
      {},
    );
    const args = buildSpawnArgs(forwardedRequestFields(r.options));
    assert.ok(args.includes('--restricted'));
    assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
    assert.equal(args[args.indexOf('--system-prompt-snapshot') + 1], 'off');
  });
});
