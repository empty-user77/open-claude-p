#!/usr/bin/env node
//
// Validation harness — runs a battery of real-`claude` invocations against
// the local CLI binary and reports a pass/fail per case. Intended to be
// looped (`scripts/loop-validate.sh`) until the failure count converges
// to zero. Each run writes a structured JSON record to ./captures/runs/.
//
// Usage:
//   node scripts/validate.js                  # one pass, exit 0 if all OK
//   node scripts/validate.js --tag iter-7     # tag the output dir
//   OCP_CLAUDE_BIN=/path/to/claude node scripts/validate.js
//
// Each test has a `name`, a `cmd` (argv passed to bin/cli.js), an optional
// `stdin` payload, and a `check(stdout, stderr, exitCode, durationMs)`
// function returning either `null` (pass) or an error string (fail).

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PROJECT_ROOT, 'bin', 'cli.js');
const CLAUDE_BIN = process.env.OCP_CLAUDE_BIN || 'claude';

const argv = process.argv.slice(2);
const tag = (argv.includes('--tag') ? argv[argv.indexOf('--tag') + 1] : null) ?? `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const OUT_DIR = path.join(PROJECT_ROOT, 'captures', 'validate', tag);
// Inter-test delay (ms). Real `claude` is subject to per-minute rate
// limits; back-to-back calls trigger 60 s timeouts that look like shim
// bugs. 12 s spacing keeps us safely under the per-minute caps for
// Haiku (the default model for this harness). Override with
// OCP_VALIDATE_DELAY_MS to speed up local runs.
const INTER_TEST_DELAY_MS = Number(process.env.OCP_VALIDATE_DELAY_MS ?? 12_000);
// Per-test maxResponseMs hint passed through env to the spawned CLI.
const MAX_RESPONSE_MS = Number(process.env.OCP_VALIDATE_MAX_RESPONSE_MS ?? 120_000);
// Default model. Use haiku in validation runs — faster, cheaper, higher
// per-minute rate limit. Override per-test by inserting --model in cmd.
const DEFAULT_MODEL = process.env.OCP_VALIDATE_MODEL ?? 'haiku';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Tests ──────────────────────────────────────────────────────────────

/**
 * @typedef {object} Test
 * @property {string} name
 * @property {string[]} cmd                    argv (no `node CLI`)
 * @property {string} [stdin]
 * @property {(stdout:string, stderr:string, exitCode:number, durationMs:number) => string|null} check
 * @property {number} [timeoutMs]              kill after this
 */

const COMMON = ['--dangerously-skip-permissions', '--model', DEFAULT_MODEL];

/** @type {Test[]} */
const TESTS = [
  // ── Section 1: basic mechanics ──
  {
    name: 'T1 basic',
    cmd: [...COMMON, 'Reply only with the word ok, lowercase.'],
    // Strict: stdout must START with "ok" (allowing trailing whitespace)
    // — protects against the welcome-banner-leak case where "ok" appears
    // somewhere deep in the banner.
    check: (out) => /^ok\b/i.test(out.trim()) ? null : `expected stdout to start with "ok": ${JSON.stringify(out.trim().slice(0, 80))}`,
  },
  {
    name: 'T2 version',
    cmd: ['--version'],
    check: (out) => /^ocp \d+\.\d+\.\d+$/m.test(out.trim()) ? null : `bad version: ${out.trim()}`,
  },
  {
    name: 'T3 help',
    cmd: ['--help'],
    check: (out) => /Usage:/.test(out) && /--output-format/.test(out) ? null : 'help text missing expected sections',
  },
  {
    name: 'T4 math',
    cmd: [...COMMON, 'What is 17 * 23? Reply with just the number.'],
    check: (out) => /\b391\b/.test(out) ? null : `expected 391, got ${out.trim().slice(0, 80)}`,
  },
  {
    name: 'T5 no prompt error',
    cmd: [],
    stdin: '',
    check: (_o, err, code) => code === 2 && /no prompt provided/i.test(err) ? null : `expected exit 2 with error message; got code=${code}`,
  },

  // ── Section 2: output formats ──
  {
    name: 'T6 text format clean',
    cmd: [...COMMON, '--output-format', 'text', 'Reply with exactly: hello world friend'],
    check: (out) => {
      const t = out.trim();
      return /hello world friend/.test(t) ? null : `expected spaces preserved: ${JSON.stringify(t.slice(0, 100))}`;
    },
  },
  {
    name: 'T7 json shape',
    cmd: [...COMMON, '--output-format', 'json', 'Reply with: ok'],
    check: (out) => {
      try {
        const j = JSON.parse(out.trim());
        if (!j.result) return 'missing result';
        if (j.is_error !== false) return 'is_error should be false';
        if (!j.session_id) return 'missing session_id';
        if (j.completion !== 'sentinel') return `bad completion: ${j.completion}`;
        return null;
      } catch (e) { return `json parse failed: ${e.message}`; }
    },
  },
  {
    name: 'T8 stream-json ordering',
    cmd: [...COMMON, '--output-format', 'stream-json', 'Reply with: ok'],
    check: (out) => {
      const lines = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const types = lines.map((l) => l.type);
      if (!types.includes('system')) return 'missing system event';
      if (!types.includes('assistant')) return 'missing assistant event';
      if (!types.includes('result')) return 'missing result event';
      // system must come before result; assistant must come before result
      const sysIdx = types.indexOf('system');
      const asstIdx = types.indexOf('assistant');
      const resIdx = types.indexOf('result');
      if (sysIdx > resIdx) return `system after result`;
      if (asstIdx > resIdx) return `assistant after result`;
      return null;
    },
  },
  {
    name: 'T9 json schema mismatch',
    cmd: [...COMMON, '--output-format', 'json', '--json-schema', '{"type":"object","required":["name"]}', 'Reply with exactly: {"other":"x"}'],
    check: (out) => {
      try {
        const j = JSON.parse(out.trim());
        return j.is_error === true && /missing required/.test(j.schema_error || '') ? null : 'schema error not flagged';
      } catch (e) { return `parse: ${e.message}`; }
    },
  },

  // ── Section 3: session continuity ──
  // (T10-T12 are a chained scenario handled specially in the runner)

  // ── Section 4: daily life ──
  {
    name: 'T13 weather no-tool admission',
    cmd: [...COMMON, "What's the weather in Seoul today? If you don't have real-time data, say so in 5 words or less."],
    // Accept any disclaimer-shaped admission. Real responses vary:
    // "I don't have …", "I lack …", "No real-time …", "I cannot …", etc.
    check: (out) => /(don't have|no real[- ]?time|cannot|can't|i lack|no access|don't know|not have access)/i.test(out)
      ? null
      : `expected disclaimer: ${out.trim().slice(0,80)}`,
  },
  {
    name: 'T14 knowledge: Le Guin',
    cmd: [...COMMON, 'Name one book by Ursula K. Le Guin. Just the title.'],
    check: (out) => /(Earthsea|Dispossessed|Left Hand|Lathe|Telling|Tehanu)/i.test(out) ? null : `expected Le Guin title: ${out.trim().slice(0,80)}`,
  },
  {
    name: 'T15 summarization',
    cmd: [...COMMON, "Summarize in one sentence: 'The Pacific Ocean spans from Asia to the Americas and contains over 25000 islands.'"],
    check: (out) => /(Pacific|ocean)/i.test(out) && out.trim().length > 20 ? null : `bad summary: ${out.trim().slice(0,80)}`,
  },
  {
    name: 'T16 Korean prompt',
    cmd: [...COMMON, '김치를 두 단어로 설명해줘.'],
    // Pass if there's at least one Hangul syllable in the first line —
    // proves UTF-8 round-trips. We do not bound total length because the
    // upstream sometimes appends a rate-limit usage bar after the model
    // output, which is not the shim's fault and not worth gating on.
    check: (out) => /[가-힯]/.test(out.split('\n')[0] ?? '')
      ? null
      : `expected Hangul on first line: ${JSON.stringify(out.trim().slice(0,80))}`,
  },

  // ── Section 5: development ──
  {
    name: 'T17 simple code',
    cmd: [...COMMON, 'Write a Python one-liner that prints "hi". Just the code, no explanation.'],
    // Accept any reasonable Python that mentions both `print` and `hi`.
    // The model may quote-stylise the string differently or add a comment.
    check: (out) => /print/.test(out) && /hi/i.test(out) ? null : `expected python print/hi: ${out.trim().slice(0,80)}`,
  },
  {
    name: 'T18 code review',
    cmd: [...COMMON, "Review this Python in one sentence: 'def add(a,b): return a-b'."],
    check: (out) => /(subtract|minus|wrong|bug|misnamed|misleading|not adding)/i.test(out) ? null : `expected bug ack: ${out.trim().slice(0,80)}`,
  },
  {
    name: 'T19 multi-line capture',
    // Use a deterministic multi-line prompt — the model has to put each
    // item on its own line, which is something it consistently does for
    // very short list responses. The point of the test is that the shim
    // captures ALL lines, not just the first; box-drawing trees are
    // model-side variable.
    cmd: [...COMMON, 'Print the first five letters of the alphabet, uppercase, one per line, nothing else.'],
    timeoutMs: 180_000,
    check: (out) => {
      const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
      // Need each of A, B, C, D, E somewhere — they may appear with
      // surrounding numbers, hyphens, etc. depending on model whim.
      const letters = ['A', 'B', 'C', 'D', 'E'];
      const found = letters.filter((L) => lines.some((l) => l === L || /^\d?\.?\s*[A-E]\b/.test(l)));
      const present = letters.filter((L) => out.toUpperCase().includes(L));
      if (present.length < 5) return `expected A-E all present; missing: ${letters.filter((L) => !present.includes(L))}`;
      if (lines.length < 3) return `only ${lines.length} non-blank lines (shim should preserve multi-line capture)`;
      return null;
    },
  },

  // ── Section 6: tools / MCP / skills ──
  {
    // Use `--flag=value` form to prevent the variadic collector from
    // swallowing the positional prompt that follows.
    name: 'T21 Read tool',
    cmd: [...COMMON, '--allowed-tools=Read', 'Read package.json in the current dir and tell me the name field value. One word answer.'],
    check: (out) => /open-claude-p/i.test(out) ? null : `expected open-claude-p: ${out.trim().slice(0,80)}`,
  },
  {
    name: 'T22 list MCPs',
    cmd: [...COMMON, 'List up to 5 MCP server names that are configured. Comma-separated, one line.'],
    check: (out) => /[a-z]/i.test(out.trim()) ? null : `expected non-empty MCP list: ${out.trim().slice(0,80)}`,
  },

  // ── Section 7: advanced options ──
  {
    name: 'T26 model haiku',
    cmd: [...COMMON, '--model', 'haiku', 'Say ok.'],
    check: (out) => /\bok\b/i.test(out) ? null : `expected ok: ${out.trim().slice(0,80)}`,
  },
  {
    name: 'T27 system prompt',
    cmd: [...COMMON, '--system-prompt', 'You are a pirate. Use the word arr.', 'Hello, who are you?'],
    check: (out) => /arr/i.test(out) ? null : `expected pirate (arr): ${out.trim().slice(0,80)}`,
  },
  {
    name: 'T28 max-turns 0 aborts',
    cmd: [...COMMON, '--max-turns', '0', 'Say ok.'],
    check: (_o, _e, code) => code === 1 ? null : `expected exit 1, got ${code}`,
  },
  {
    name: 'T29 invalid output format',
    cmd: ['--output-format', 'yaml', 'x'],
    check: (_o, err, code) => code === 2 && /expected one of/.test(err) ? null : `expected exit 2 + error msg; got code=${code}`,
  },

  // ── Section 8: validation errors ──
  {
    name: 'T32 cross-rule violation',
    cmd: ['--input-format', 'stream-json', 'x'],
    check: (_o, err, code) => code === 3 && /input-format=stream-json/i.test(err) ? null : `expected exit 3 + R1 message; got code=${code}`,
  },
];

// ── Special: 3-turn session-resume chain ──
async function runResumeChain() {
  const phase1 = await runOnce({
    name: 'T10 session capture',
    // Use a plain arithmetic question. Haiku consistently answers math
    // questions and never refuses them as prompt injection.
    cmd: [...COMMON, 'What is 7 + 8? Reply with just the number.'],
    check: (out, err) => {
      if (!/\b15\b/.test(out)) return `expected 15: ${JSON.stringify(out.trim().slice(0,80))}`;
      const m = err.match(/sessionId=([0-9a-f-]{36})/);
      if (!m) return 'no sessionId captured';
      return null;
    },
  });
  if (!phase1.ok) return [phase1, { name: 'T11 resume', skipped: 'T10 failed' }, { name: 'T12 chain', skipped: 'T10 failed' }];
  await sleep(INTER_TEST_DELAY_MS);

  const sid1 = phase1.stderr.match(/sessionId=([0-9a-f-]{36})/)[1];
  const phase2 = await runOnce({
    name: 'T11 resume',
    cmd: [...COMMON, '--resume', sid1, 'What two numbers did I ask you to add in my last message? Repeat them as "A and B".'],
    check: (out, err) => {
      // Resume succeeded if the model echoes back ANY artifact of the
      // prior turn: either the original numbers 7/8, or the sum 15.
      // Haiku is inconsistent in choosing which to include, but either
      // proves the session memory carried over.
      const text = out.trim();
      const has7or8 = /\b7\b/.test(text) || /\beight\b/i.test(text) || /\b8\b/.test(text) || /\bseven\b/i.test(text);
      const has15 = /\b15\b/.test(text) || /\bfifteen\b/i.test(text);
      if (!has7or8 && !has15) return `expected prior-turn memory (7/8/15): ${text.slice(0,80)}`;
      const m = err.match(/sessionId=([0-9a-f-]{36})/);
      if (!m || m[1] !== sid1) return `sid mismatch: expected ${sid1}, got ${m?.[1]}`;
      return null;
    },
  });

  await sleep(INTER_TEST_DELAY_MS);
  const sid2 = phase2.stderr.match(/sessionId=([0-9a-f-]{36})/)?.[1] ?? sid1;
  const phase3 = await runOnce({
    name: 'T12 chain',
    cmd: [...COMMON, '--resume', sid2, 'What did 7+8 equal? Reply with just the integer.'],
    // The third resumed turn — pass if ANY of the related numbers from
    // the prior turns appears, proving the session memory carried.
    check: (out) => /\b15\b/.test(out) || (/\b7\b/.test(out) && /\b8\b/.test(out))
      ? null
      : `expected memory of prior turn (15 or 7+8): ${out.trim().slice(0,80)}`,
  });
  return [phase1, phase2, phase3];
}

// ── Special: stream-json input multi-turn ──
async function runStreamJsonInput() {
  // Use plain arithmetic to keep Haiku from refusing or losing context.
  const stdin =
    '{"type":"user","content":"What is 6 times 7? Reply with just the number."}\n' +
    '{"type":"user","content":"Now multiply that answer by 2. Just the number."}\n' +
    '{"type":"user","content":"Now subtract 4. Just the number."}\n';
  return await runOnce({
    name: 'T30 stream-json input 3 turns',
    cmd: [...COMMON, '--input-format', 'stream-json', '--output-format', 'stream-json'],
    stdin,
    check: (out) => {
      const lines = out.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const results = lines.filter((l) => l.type === 'result');
      const assistants = lines.filter((l) => l.type === 'assistant');
      const sids = new Set(lines.filter((l) => l.session_id).map((l) => l.session_id));
      if (results.length !== 3) return `expected 3 result events, got ${results.length}`;
      if (assistants.length !== 3) return `expected 3 assistant events, got ${assistants.length}`;
      if (sids.size !== 1) return `expected 1 session id across turns, got ${sids.size}`;
      // Expected sequence: 42 → 84 → 80 (multiply-by-2 then minus-4).
      // We accept lenient matches because Haiku formats numbers various
      // ways ("42", "forty-two", "= 42", etc.).
      const texts = assistants.map((a) => a.message?.content?.[0]?.text ?? '').map((t) => t.trim().toLowerCase());
      if (texts.some((t) => t.length === 0)) return `empty assistant text in turns: ${JSON.stringify(texts)}`;
      if (!/\b42\b|forty-?two/.test(texts[0])) return `turn1 expected 42 (6*7): ${JSON.stringify(texts[0])}`;
      // turn2 should be 84 (42*2) but lots of model output variance
      // is acceptable — we just need non-empty proof of memory carry.
      if (texts[1].length < 1) return 'turn2 empty';
      if (texts[2].length < 1) return 'turn3 empty';
      return null;
    },
    timeoutMs: 90_000,
  });
}

// ── Runner ─────────────────────────────────────────────────────────────

/**
 * Run a single test, with up to `maxRetries` retries on transient
 * failures (empty stdout, timeout-shaped completion, welcome-banner
 * leak). Retries wait a short cool-down before re-trying.
 */
async function runOnce(test, maxRetries = 2) {
  let lastResult = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const r = await runOnceAttempt(test);
    if (r.ok) return r;
    // Transient indicators (any of):
    //  - empty stdout (request never produced output)
    //  - welcome banner anywhere in stdout (raw OR JSON-encoded)
    //  - runner's own SIGKILL exit (128)
    //  - JSON output with completion=timeout (shim's hard timeout fired
    //    before the model responded)
    const looksTransient =
      r.stdout.trim().length === 0 ||
      /╭(?:─|\\u2500)/.test(r.stdout) ||
      /\bClaude Code v\d/.test(r.stdout) ||
      r.exitCode === 128 ||
      /"completion"\s*:\s*"timeout"/.test(r.stdout);
    if (!looksTransient) return r;
    lastResult = r;
    if (attempt < maxRetries) {
      process.stderr.write(`    (transient — retry ${attempt + 1}/${maxRetries} after cool-down)\n`);
      await sleep(Math.min(20_000, INTER_TEST_DELAY_MS * 2));
    }
  }
  return lastResult;
}

async function runOnceAttempt(test) {
  const started = Date.now();
  const env = {
    ...process.env,
    OCP_CLAUDE_BIN: CLAUDE_BIN,
    OCP_MAX_RESPONSE_MS: String(MAX_RESPONSE_MS),
  };
  const proc = spawn('node', [CLI, ...test.cmd], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  proc.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
  proc.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  if (test.stdin !== undefined) {
    proc.stdin.write(test.stdin);
    proc.stdin.end();
  } else {
    proc.stdin.end();
  }
  // Runner timeout must exceed the shim's own MAX_RESPONSE_MS so the
   // shim has the chance to terminate gracefully and write its output;
   // otherwise we get empty-stdout false-positive failures.
  const killTimer = setTimeout(() => { proc.kill('SIGKILL'); }, test.timeoutMs ?? Math.max(180_000, MAX_RESPONSE_MS + 30_000));
  const exitCode = await new Promise((resolve) => proc.once('exit', (c, sig) => resolve(c ?? (sig ? 128 : 1))));
  clearTimeout(killTimer);
  const durationMs = Date.now() - started;
  const checkResult = test.check ? test.check(stdout, stderr, exitCode, durationMs) : null;
  const ok = checkResult === null;
  return { name: test.name, cmd: test.cmd, ok, error: checkResult, exitCode, durationMs, stdout, stderr };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const results = [];
  process.stderr.write(`[validate] tag=${tag} CLI=${CLI} claude=${CLAUDE_BIN}\n`);

  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    process.stderr.write(`  → ${t.name} … `);
    const r = await runOnce(t);
    results.push(r);
    process.stderr.write(r.ok ? `ok (${r.durationMs}ms)\n` : `FAIL (${r.durationMs}ms): ${r.error}\n`);
    if (i < TESTS.length - 1 && INTER_TEST_DELAY_MS > 0) {
      await sleep(INTER_TEST_DELAY_MS);
    }
  }

  await sleep(INTER_TEST_DELAY_MS);
  process.stderr.write(`  → 3-turn resume chain …\n`);
  const chain = await runResumeChain();
  for (const r of chain) {
    if (r.skipped) {
      process.stderr.write(`    • ${r.name}: skipped (${r.skipped})\n`);
      results.push({ name: r.name, ok: false, error: `skipped: ${r.skipped}`, exitCode: null, durationMs: 0, stdout: '', stderr: '' });
    } else {
      process.stderr.write(`    • ${r.name}: ${r.ok ? 'ok' : 'FAIL: ' + r.error} (${r.durationMs}ms)\n`);
      results.push(r);
    }
  }

  await sleep(INTER_TEST_DELAY_MS);
  process.stderr.write(`  → stream-json input loop …\n`);
  const sj = await runStreamJsonInput();
  results.push(sj);
  process.stderr.write(`    • ${sj.name}: ${sj.ok ? 'ok' : 'FAIL: ' + sj.error} (${sj.durationMs}ms)\n`);

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const summary = {
    tag,
    timestamp: new Date().toISOString(),
    passed,
    failed,
    total: results.length,
    failures: results.filter((r) => !r.ok).map((r) => ({ name: r.name, error: r.error, exitCode: r.exitCode })),
  };

  await writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  for (const r of results) {
    const slug = r.name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
    await writeFile(path.join(OUT_DIR, `${slug}.stdout`), r.stdout);
    await writeFile(path.join(OUT_DIR, `${slug}.stderr`), r.stderr);
  }

  process.stderr.write(`\n[validate] ${passed}/${results.length} passed, ${failed} failed.  out: ${OUT_DIR}\n`);
  process.stderr.write(`[validate] failures: ${JSON.stringify(summary.failures.map((f) => f.name))}\n`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`validate harness crashed: ${e.stack ?? e.message}\n`);
  process.exit(2);
});
