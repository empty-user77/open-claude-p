#!/usr/bin/env node
// stress-test.js — practical-value stress tests for ocp.
//
// Categories (single-turn):
//   1. code-dev     — small, real coding tasks (Fibonacci, SQL, REST handler, Dockerfile…)
//   2. code-review  — find bugs/issues in given snippets
//   3. work-doc     — commit messages, PR descriptions, OpenAPI, README, CHANGELOG
//   4. tool-use     — exercise --allowed-tools paths (WebSearch / WebFetch)
//   5. quick-fact   — short factual answers (arithmetic, HTTP codes, conversions)
//
// Multi-turn Q&A (context retention via --resume):
//   iterative API client · review-then-fix · iterative work doc ·
//   SQL-then-index · debug dialog
//
// Evaluation axes (recorded per run):
//   - quality   : expected keywords appear in the answer
//   - format    : output shape matches expectation (code-block, list, markdown, short…)
//   - parsing   : ocp's output is a clean, parseable answer (no ANSI leakage,
//                 no welcome-banner contamination, valid JSON for json formats)
//   - error     : non-zero exit, timeout, or model refusal phrasing
//   - speed     : durationMs (per run + p50/p90/p95 aggregates per category)
//
// Usage:
//   node scripts/stress-test.js [options]
//
// Options:
//   --runs=30            total single-turn runs       (default 30)
//   --qa-sessions=5      multi-turn Q&A sessions      (default 5)
//   --concurrency=3      parallel single-turn jobs    (default 3)
//   --format=text        output-format for ocp        (default text)
//   --no-daemon=true     set OCP_NO_DAEMON=1          (default true)
//   --jitter=150         max random pre-spawn delay   (default 150ms)
//
// Results → captures/stress-{timestamp}/
//   results.jsonl          single-turn per-run records
//   qa-results.jsonl       Q&A per-session records
//   summary.json           aggregated stats
//   report.md              human-readable report

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const CLI       = path.join(ROOT, 'bin', 'cli.js');

// ── CLI arg parsing ──────────────────────────────────────────────────────────
const argv   = process.argv.slice(2);
const argMap = {};
for (const a of argv) {
  const m = a.match(/^--([^=]+)=(.+)$/);
  if (m) argMap[m[1]] = m[2];
  else if (a.startsWith('--')) argMap[a.slice(2)] = 'true';
}
const TOTAL_RUNS    = parseInt(argMap.runs            ?? '30', 10);
const QA_SESSIONS   = parseInt(argMap['qa-sessions']  ?? '5',  10);
const CONCURRENCY   = parseInt(argMap.concurrency     ?? '3',  10);
const DEFAULT_FMT   = argMap.format     ?? 'text';
const NO_DAEMON     = argMap['no-daemon'] !== 'false';   // default true
const JITTER_MS     = parseInt(argMap.jitter ?? '150', 10);

// Refusal / non-answer markers
const REFUSAL_KEYWORDS = [
  'I cannot', "I can't help", "I'm unable",
  'I do not have access', "I don't have access",
  "I'm not able to", 'I am not able to',
];

// ── Single-turn prompt catalogue ─────────────────────────────────────────────
//
// Each entry:
//   { id, label, prompt,
//     expectKeywords?       (string[], AND by default)
//     expectKeywordsAny?    (string[], any-match)
//     expectFormat?         'code-block' | 'sql' | 'json' | 'markdown' | 'list' | 'short'
//     forbiddenKeywords?    refusal/uncertainty markers
//     extraArgs?            per-entry extra CLI args (e.g., --allowed-tools …)
//     timeoutMs?            per-entry timeout (default 125000) }

// 1. code-dev — small practical coding tasks
const CODE_DEV_PROMPTS = [
  { id: 'code-01', label: 'JS Fibonacci',
    prompt: 'Write a JavaScript function fib(n) that returns the first n Fibonacci numbers as an array. Code only, inside a JS code block.',
    expectKeywords: ['function', 'return'], expectFormat: 'code-block' },
  { id: 'code-02', label: 'SQL join+aggregate',
    prompt: 'Write a SQL query joining "users" and "orders" tables and listing each user with their total order count. Use COUNT and GROUP BY. SQL inside a code block only.',
    expectKeywords: ['JOIN', 'COUNT', 'GROUP BY'], expectFormat: 'code-block' },
  { id: 'code-03', label: 'Python comprehension',
    prompt: 'Write a Python list comprehension that returns squares of even numbers from 1 to 20 inclusive. Code only, inside a code block.',
    expectKeywords: ['for', 'if'], expectFormat: 'code-block' },
  { id: 'code-04', label: 'Express endpoint',
    prompt: 'Write an Express.js POST /api/users endpoint that validates "name" and "email", then returns 201 with the created object. Code only.',
    expectKeywords: ['201'], expectKeywordsAny: ['app.post', 'router.post'], expectFormat: 'code-block' },
  { id: 'code-05', label: 'TS discriminated union',
    prompt: 'Define a TypeScript discriminated union type Result<T> with an "ok" variant (data: T) and an "err" variant (message: string). Use a literal kind tag. Code only.',
    expectKeywords: ['type'],
    expectKeywordsAny: ['ok', 'err', 'success', 'failure', 'error'],
    expectFormat: 'code-block' },
  { id: 'code-06', label: 'async retry',
    prompt: 'Write an async JavaScript function retry(fn, max) that retries fn() up to max times with exponential backoff. Code only.',
    expectKeywords: ['async', 'await'], expectFormat: 'code-block' },
  { id: 'code-07', label: 'React useDebounce',
    prompt: 'Write a React custom hook useDebounce(value, delayMs) that returns a debounced value. Code only.',
    expectKeywords: ['useState', 'useEffect'], expectFormat: 'code-block' },
  { id: 'code-08', label: 'Bash find one-liner',
    prompt: 'Write a single-line bash command that finds all .log files modified in the last 7 days under /var/log and prints their sizes. Command only inside a bash code block.',
    expectKeywords: ['find', '/var/log', '-mtime'], expectFormat: 'code-block' },
  { id: 'code-09', label: 'Dockerfile node20',
    prompt: 'Write a multi-stage Dockerfile for a Node.js 20 app that copies package.json, installs dependencies, copies sources, exposes port 3000, and runs npm start. Code only.',
    expectKeywords: ['FROM', 'WORKDIR', 'EXPOSE'], expectFormat: 'code-block' },
  { id: 'code-10', label: 'Jest unit test',
    prompt: 'Write a Jest unit test for a sum(a, b) function covering positive, negative, and zero inputs. Code only.',
    expectKeywords: ['describe', 'test', 'expect'], expectFormat: 'code-block' },
];

// 2. code-review — find issues in a given snippet
const CODE_REVIEW_PROMPTS = [
  { id: 'review-01', label: 'SQL injection',
    prompt: 'Review this code and list the security issue:\n```js\nconst q = `SELECT * FROM users WHERE id=${userId}`;\ndb.query(q);\n```',
    expectKeywords: ['injection'] },
  { id: 'review-02', label: 'async forEach bug',
    prompt: 'What is wrong here?\n```js\nawait items.forEach(async (i) => { await save(i); });\nconsole.log("done");\n```',
    expectKeywordsAny: ['forEach', 'Promise.all', 'for...of', 'await', 'sequential', 'undefined'] },
  { id: 'review-03', label: 'null chain access',
    prompt: 'What bug exists in this function?\n```js\nfunction getName(user) { return user.profile.name.toUpperCase(); }\n```',
    expectKeywordsAny: ['null', 'undefined', 'optional chaining', 'missing', 'TypeError'] },
  { id: 'review-04', label: 'cache stores promise / unbounded',
    prompt: 'Identify the issue:\n```js\nconst cache = {};\nfunction get(key) {\n  if (!cache[key]) cache[key] = fetch(key);\n  return cache[key];\n}\n```',
    // Two valid critiques: (a) stores Promise not resolved value; (b) unbounded growth / no eviction.
    expectKeywords: ['cache'],
    expectKeywordsAny: ['Promise', 'fetch', 'resolved', 'leak', 'unbounded', 'eviction', 'TTL', 'memory'] },
  { id: 'review-05', label: 'race in counter',
    prompt: 'What is the problem here?\n```js\nlet count = 0;\nasync function inc() {\n  const c = count;\n  await sleep(10);\n  count = c + 1;\n}\n```',
    expectKeywordsAny: ['race', 'concurrent', 'lost update', 'lost', 'overwrite', 'stale'] },
];

// 3. work-doc — commit messages, PR descriptions, API specs, README, CHANGELOG
const WORK_DOC_PROMPTS = [
  { id: 'doc-01', label: 'commit message',
    prompt: 'Write a conventional commit message (subject line only, ≤72 chars) for: fixed null pointer when user email is missing during login.',
    expectKeywords: ['fix'], expectFormat: 'short' },
  { id: 'doc-02', label: 'PR description',
    prompt: 'Write a 3-bullet PR description summary for a change that adds rate limiting (100 req/min per IP) to the /login endpoint. Bullets only.',
    expectKeywords: ['rate'], expectFormat: 'list' },
  { id: 'doc-03', label: 'OpenAPI snippet',
    prompt: 'Write the OpenAPI 3 YAML spec for GET /api/users/{id} returning a user object with fields id, name, email. YAML inside a code block only.',
    expectKeywords: ['paths', 'get'], expectFormat: 'code-block' },
  { id: 'doc-04', label: 'README Installation',
    prompt: 'Write a markdown "## Installation" section for a Node.js CLI distributed via npm. Include prerequisites and the install command.',
    expectKeywords: ['Installation', 'npm install'], expectFormat: 'markdown' },
  { id: 'doc-05', label: 'CHANGELOG entry',
    prompt: 'Write a CHANGELOG.md "[Unreleased]" entry in Keep-a-Changelog format covering: added WebSocket support; fixed memory leak in cache.',
    expectKeywords: ['Added', 'Fixed'], expectFormat: 'markdown' },
];

// 4. tool-use — exercise --allowed-tools paths (WebSearch / WebFetch)
//    Longer timeouts because the upstream tool call adds latency.
const TOOL_USE_PROMPTS = [
  { id: 'tool-01', label: 'WebSearch Node LTS',
    prompt: 'Use a web search to find the current Node.js LTS major version, then report ONLY the major version number (e.g., "22").',
    expectKeywordsAny: ['18', '20', '22', '24'],  // any plausible LTS major
    forbiddenKeywords: REFUSAL_KEYWORDS,
    extraArgs: ['--allowed-tools', 'WebSearch'],
    timeoutMs: 180000, expectFormat: 'short' },
  { id: 'tool-02', label: 'WebFetch summarize',
    prompt: 'Fetch https://nodejs.org/en/about and summarize what Node.js is in two sentences.',
    expectKeywords: ['Node'],
    forbiddenKeywords: REFUSAL_KEYWORDS,
    extraArgs: ['--allowed-tools', 'WebFetch'],
    timeoutMs: 180000 },
];

// 5. quick-fact — short factual answers
const QUICK_FACT_PROMPTS = [
  { id: 'fact-01', label: 'arithmetic',
    prompt: 'What is 7 * 13 + 42? Answer with the number only.',
    expectKeywords: ['133'], expectFormat: 'short' },
  { id: 'fact-02', label: 'HTTP code',
    prompt: 'What HTTP status code indicates "Unprocessable Entity"? Number only.',
    expectKeywords: ['422'], expectFormat: 'short' },
  { id: 'fact-03', label: 'unit conversion',
    prompt: 'Convert 1 GiB (gibibyte) to bytes. Number only, no thousands separators.',
    expectKeywords: ['1073741824'], expectFormat: 'short' },
  { id: 'fact-04', label: 'protocol fact',
    prompt: 'Name one well-known internet protocol that runs over UDP. One word only.',
    expectKeywordsAny: ['DNS', 'QUIC', 'DHCP', 'NTP', 'SNMP'],
    expectFormat: 'short' },
  { id: 'fact-05', label: 'git command',
    prompt: 'Provide the git command to discard ALL local uncommitted changes to tracked files. Command only, single line, no explanation.',
    expectKeywords: ['git'], expectFormat: 'short' },
];

// ── Multi-turn Q&A session catalogue ─────────────────────────────────────────
// Each session: { id, label, category, turns: [{ q, expectKeywords?, expectKeywordsAny?, contextCheck? }] }
//
// contextCheck: keyword from a previous turn's answer that should appear in
// THIS turn's answer if --resume context is properly threaded (turn index ≥ 1).

const QA_SESSION_CATALOGUE = [
  {
    id: 'qa-iter-code', label: 'iterative API client', category: 'qa-code',
    turns: [
      { q: 'Write a JS function fetchUser(id) that GETs `/api/users/{id}` and returns the parsed JSON.',
        expectKeywords: ['fetch'] },
      { q: 'Now add a 5-second timeout using AbortController.',
        expectKeywords: ['AbortController'],
        contextCheck: ['fetchUser', 'fetch(', '/api/users'] },
      { q: 'Add retry-on-failure with up to 3 attempts and exponential backoff.',
        expectKeywordsAny: ['retry', 'attempt', 'backoff', 'tries'],
        contextCheck: ['fetchUser', 'AbortController', 'timeout', 'abort'] },
    ],
  },
  {
    id: 'qa-review-then-fix', label: 'review then fix', category: 'qa-code',
    turns: [
      { q: 'Find the bug:\n```js\nasync function load(ids) {\n  return ids.map(async id => await fetch(`/api/${id}`));\n}\n```',
        expectKeywordsAny: ['Promise', 'array of promises'] },
      { q: 'Rewrite the function correctly.',
        expectKeywords: ['Promise.all'], contextCheck: 'Promise' },
    ],
  },
  {
    id: 'qa-doc-iter', label: 'iterative work doc', category: 'qa-doc',
    turns: [
      { q: 'Write a one-paragraph markdown description of the feature "User Profile API".',
        expectKeywords: ['Profile'] },
      { q: 'Now add a "## Acceptance Criteria" section with 3 bullet points.',
        expectKeywords: ['Acceptance'], contextCheck: 'Profile' },
      { q: 'Add an "## Endpoints" section listing GET /api/profile and PUT /api/profile with their purposes.',
        expectKeywords: ['Endpoints', 'GET'], contextCheck: 'Profile' },
    ],
  },
  {
    id: 'qa-sql-then-index', label: 'SQL then index', category: 'qa-code',
    turns: [
      { q: 'Write a SQL query returning the top 5 users by total order amount. Tables: users(id, name), orders(user_id, amount).',
        expectKeywords: ['JOIN', 'ORDER BY', 'LIMIT'] },
      { q: 'Suggest one composite index on the orders table to speed this query up. Reply with one CREATE INDEX statement only.',
        expectKeywords: ['INDEX'], contextCheck: 'order' },
    ],
  },
  {
    id: 'qa-debug-dialog', label: 'debug dialog', category: 'qa-code',
    turns: [
      { q: 'Why might `Promise.all([])` resolve immediately while `Promise.race([])` never resolves?',
        expectKeywordsAny: ['empty', 'no promises'] },
      { q: 'How would you guard `Promise.race(promises)` against an empty input?',
        expectKeywordsAny: ['length', 'check', 'guard'], contextCheck: 'race' },
    ],
  },
];

// ── Low-level runner ─────────────────────────────────────────────────────────

function spawnOcp(prompt, format, extraArgs = [], timeoutMs = 125000) {
  return new Promise((resolve) => {
    const startMs = Date.now();
    const args = [CLI, prompt, `--output-format=${format}`, ...extraArgs];
    const childEnv = { ...process.env };
    if (NO_DAEMON) childEnv.OCP_NO_DAEMON = '1';
    childEnv.OCP_MAX_RESPONSE_MS = String(Math.max(15000, timeoutMs - 10000));

    const proc = spawn(process.execPath, args, {
      cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => proc.kill('SIGTERM'), timeoutMs);
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, durationMs: Date.now() - startMs, timedOut: code === null });
    });
  });
}

async function runOcp(prompt, format, timeoutMs = 125000, { jitterMs = 0, resumeSessionId = null, extraArgs = [] } = {}) {
  if (jitterMs > 0) await new Promise(r => setTimeout(r, Math.random() * jitterMs));
  const full = [...extraArgs];
  if (resumeSessionId) full.push('--resume', resumeSessionId);
  let result;
  // 3 attempts: tolerates a double-timeout against a slow upstream
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 3000 + attempt * 2000));
    result = await spawnOcp(prompt, format, full, timeoutMs);
    // exit=0: success; exit=1: generic (no retry); exit=4: inner timeout;
    // exit=5: cancelled; null: killed by outer timer
    if (result.exitCode !== 5 && result.exitCode !== 4 && !result.timedOut) break;
  }
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function checkKeywords(text, keywords, mode = 'all') {
  if (!keywords || keywords.length === 0) return { passed: true, missing: [] };
  const lower = text.toLowerCase();
  if (mode === 'any') {
    const matched = keywords.some(k => lower.includes(k.toLowerCase()));
    return { passed: matched, missing: matched ? [] : keywords };
  }
  const missing = keywords.filter(k => !lower.includes(k.toLowerCase()));
  return { passed: missing.length === 0, missing };
}

// The upstream `claude` TUI renders markdown when it prints, so by the time
// ocp's parser sees the output the ``` fences and ## heading markers are
// gone (they were turned into visual styling). Format detection therefore
// looks for *content shape* (code-like tokens, structured layout) rather
// than literal markdown syntax. ``` fences are still accepted when present.

const CODE_TOKEN_RX = /\b(function|const|let|var|class|interface|type|enum|import|from|export|return|async|await|def|print|lambda|public|private|static|void|yield)\b|=>|::|\b(SELECT|FROM|WHERE|JOIN|GROUP BY|ORDER BY|CREATE|INSERT|UPDATE|DELETE|INDEX)\b|\bFROM\b|\bWORKDIR\b|\bRUN\b|\bEXPOSE\b|#!\/|^\s*[$#]\s|find\s+\/|app\.|router\.|describe\s*\(|test\s*\(|expect\s*\(|range\s*\(|\*\*\d|\bfor\s+\w+\s+in\s+|\[.*\bfor\s+\w+\s+in\s+|\b__\w+__\b|\bself\b/i;

function looksLikeCode(text) {
  if (/```/.test(text)) return true;
  if (CODE_TOKEN_RX.test(text)) return true;
  // bash one-liner heuristic — common command at start
  if (/^\s*(find|grep|awk|sed|curl|git|npm|node|docker|kubectl|cat|ls|cp|mv|chmod|chown)\s/m.test(text)) return true;
  // bracket-heavy single-line expression (list/dict comprehensions, JSON, array literals)
  if (/^\s*[\[\{].{10,}[\]\}]\s*$/m.test(text)) return true;
  return false;
}

function looksStructured(text) {
  // any of: heading, bullet, ordered item, fence, key:value blocks
  if (/(^|\n)#{1,6}\s/.test(text)) return true;
  if (/(^|\n)[-*]\s/.test(text)) return true;
  if (/(^|\n)\d+\.\s/.test(text)) return true;
  if (/```/.test(text)) return true;
  // multi-section pattern: multiple capitalized section words followed by content
  const sectionHits = text.match(/\b(Installation|Prerequisites|Usage|Examples?|Configuration|Endpoints|Acceptance|Overview|Summary|Setup|Options|Added|Fixed|Changed|Removed)\b/g);
  if (sectionHits && sectionHits.length >= 2) return true;
  return false;
}

function checkFormat(text, expectFormat) {
  if (!expectFormat) return { passed: true, kind: null };
  switch (expectFormat) {
    case 'code-block':
      return { passed: looksLikeCode(text), kind: 'code-block' };
    case 'sql':
      return { passed: /\b(SELECT|INSERT|UPDATE|DELETE|CREATE)\b/i.test(text), kind: 'sql' };
    case 'json':
      return { passed: /\{[\s\S]*\}/.test(text), kind: 'json' };
    case 'markdown':
      return { passed: looksStructured(text), kind: 'markdown' };
    case 'list':
      // bullets, dashes, numbered; also accept newline-separated 3+ short lines
      if (/(^|\n)[-*]\s|(^|\n)\d+\.\s/.test(text)) return { passed: true, kind: 'list' };
      // fallback: at least 3 short lines (TUI may flatten bullets in some renders)
      const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      return { passed: lines.length >= 3 && lines.every(l => l.length < 200), kind: 'list' };
    case 'short':
      // "short" = the *meaningful answer* is short. WebSearch/WebFetch will
      // append sources/citations and the TUI sometimes flattens newlines, so
      // check the prefix up to the first "Sources:" or hard break.
      const stripped = text.split(/Sources?:|References?:|\n\s*\n|─{3,}/i)[0].trim();
      return { passed: stripped.length <= 200, kind: 'short' };
    default:
      return { passed: true, kind: expectFormat };
  }
}

function checkRefusal(text, forbiddenKeywords) {
  if (!forbiddenKeywords || forbiddenKeywords.length === 0) return { refused: false, reason: null };
  const lower = text.toLowerCase();
  const hit = forbiddenKeywords.find(k => lower.includes(k.toLowerCase()));
  return { refused: Boolean(hit), reason: hit || null };
}

// Whether ocp's output is a clean, parseable answer.
// Reasons it can fail:
//   - empty stdout (parser produced nothing)
//   - raw ANSI escape codes leaked through (ansi-strip miss)
//   - welcome banner / TUI startup chrome appears at the start of the answer
//   - JSON-format response that isn't valid JSON
//   - whitespace-only content
function checkParsing(text, format) {
  if (!text || text.length === 0) return { passed: false, reason: 'empty' };
  if (/\x1b\[/.test(text))         return { passed: false, reason: 'ansi-leaked' };

  const head = text.slice(0, 400);
  if (/Welcome to Claude/i.test(head) || /^\s*Tip:/m.test(head) ||
      /Claude Code v\d/.test(head) || /^[╭┌╔]─{3,}/m.test(head)) {
    return { passed: false, reason: 'welcome-banner' };
  }

  if (format === 'json' || format === 'stream-json') {
    try {
      const lines = text.trim().split('\n').filter(Boolean);
      for (const line of lines) JSON.parse(line);
    } catch {
      return { passed: false, reason: 'invalid-json' };
    }
  }

  // A single-character answer (e.g., "5") is still a valid response.
  // Only flag if there is no non-whitespace content at all.
  if (text.replace(/\s/g, '').length < 1) return { passed: false, reason: 'too-short' };
  return { passed: true, reason: null };
}

function extractSessionId(stderr) {
  const m = stderr.match(/sessionId=([a-f0-9-]{36})/);
  return m ? m[1] : null;
}

function isCollapsed(stdout) {
  // A real collapsed card ends with a title line followed immediately by ❯
  // (the TUI expand toggle). The TUI input prompt also uses ❯ but appears
  // after a full response body — detect that by requiring very short content.
  const trimmed = stdout.trimEnd();
  if (!/❯\s*$/.test(trimmed)) return false;
  const lastLineBreak = trimmed.lastIndexOf('\n');
  const preCaret = lastLineBreak >= 0 ? trimmed.slice(0, lastLineBreak).trim() : '';
  return preCaret.length < 300;
}

function evaluateAnswer(text, entry, format) {
  // Both checks may be present: expectKeywords (AND) AND expectKeywordsAny (OR) — both must pass.
  const kwAll = checkKeywords(text, entry.expectKeywords ?? [],    'all');
  const kwAny = checkKeywords(text, entry.expectKeywordsAny ?? [], 'any');
  const kw = {
    passed:  kwAll.passed && kwAny.passed,
    missing: [...kwAll.missing, ...kwAny.missing],
  };
  const fmt   = checkFormat(text, entry.expectFormat);
  const ref   = checkRefusal(text, entry.forbiddenKeywords);
  const parse = checkParsing(text, format);
  return { kw, fmt, ref, parse };
}

// ── Single-turn run ──────────────────────────────────────────────────────────

async function runSingleTurn(entry) {
  const format    = entry.format    ?? DEFAULT_FMT;
  const timeoutMs = entry.timeoutMs ?? 125000;
  const raw       = await runOcp(entry.prompt, format, timeoutMs, {
    jitterMs: JITTER_MS, extraArgs: entry.extraArgs || [],
  });
  const collapsed = isCollapsed(raw.stdout);
  const { kw, fmt, ref, parse } = evaluateAnswer(raw.stdout, entry, format);
  // collapsed TUI cards hide the body — give them the benefit of the doubt for keywords
  const keywordsPassed = collapsed ? true : kw.passed;
  const missingKeywords = collapsed ? [] : kw.missing;
  const formatPassed   = collapsed ? true : fmt.passed;

  return {
    type: 'single',
    runIndex: entry.runIndex,
    id: entry.id,
    category: entry.category,
    label: entry.label,
    format,
    durationMs: raw.durationMs,
    exitCode: raw.exitCode,
    timedOut: raw.timedOut,
    collapsed,
    sessionId: extractSessionId(raw.stderr),
    textLength: raw.stdout.length,
    keywordsPassed,
    missingKeywords,
    expectFormat: entry.expectFormat ?? null,
    formatPassed,
    parsingPassed: parse.passed,
    parsingFailReason: parse.reason,
    refused: ref.refused,
    refusalReason: ref.reason,
    isError: raw.exitCode !== 0 || raw.timedOut,
    promptLength: entry.prompt.length,
    responsePreview: raw.stdout.slice(0, 100).replace(/\n/g, '↵'),
  };
}

// ── Multi-turn Q&A session run ───────────────────────────────────────────────
// Turns within a session are ALWAYS sequential (each depends on the prior
// session id). Different sessions can run concurrently.
// On session error, retry the entire session from turn 0 (fresh conversation).

function processTurnResult(raw, turn, format) {
  const collapsed = isCollapsed(raw.stdout);
  const { kw, fmt, ref, parse } = evaluateAnswer(raw.stdout, turn, format);
  const keywordsPassed  = collapsed ? true : kw.passed;
  const missingKeywords = collapsed ? [] : kw.missing;

  // contextCheck may be a string OR a string[] (any-match). The latter is
  // useful when the prior turn established multiple memorable handles (a
  // function name, a variable name, a concept) and the model may keep any
  // subset of them while still threading the conversation.
  const contextCheck = turn.contextCheck;
  const checkList = Array.isArray(contextCheck) ? contextCheck : (contextCheck ? [contextCheck] : []);
  const contextRetained = checkList.length === 0
    ? null
    : checkList.some(k => raw.stdout.toLowerCase().includes(k.toLowerCase()));

  return {
    durationMs: raw.durationMs,
    exitCode: raw.exitCode,
    timedOut: raw.timedOut,
    collapsed,
    textLength: raw.stdout.length,
    keywordsPassed,
    missingKeywords,
    formatPassed: collapsed ? true : fmt.passed,
    parsingPassed: parse.passed,
    parsingFailReason: parse.reason,
    refused: ref.refused,
    contextRetained,
    isError: raw.exitCode !== 0 || raw.timedOut,
    sessionId: extractSessionId(raw.stderr),
    responsePreview: raw.stdout.slice(0, 100).replace(/\n/g, '↵'),
  };
}

async function runQaSessionOnce(session) {
  const format = DEFAULT_FMT;
  const turnResults = [];
  let currentSessionId = null;
  let sessionError = false;

  for (let i = 0; i < session.turns.length; i++) {
    const turn = session.turns[i];
    const isFirst = i === 0;

    const raw = await runOcp(turn.q, format, 125000, {
      jitterMs: isFirst ? JITTER_MS : 0,
      resumeSessionId: isFirst ? null : currentSessionId,
    });

    const turnResult = processTurnResult(raw, turn, format);

    if (turnResult.sessionId) currentSessionId = turnResult.sessionId;
    if (turnResult.isError) sessionError = true;

    turnResults.push({
      turnIndex: i,
      question: turn.q.slice(0, 80),
      ...turnResult,
    });

    if (turnResult.isError && !currentSessionId) break;
  }

  return { turnResults, sessionError };
}

async function runQaSession(session, sessionIndex) {
  const sessionStartMs = Date.now();
  let turnResults = [];
  let sessionError = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 5000));
    const result = await runQaSessionOnce(session);
    turnResults  = result.turnResults;
    sessionError = result.sessionError;
    if (!sessionError) break;
  }

  const allKeywordsPassed = turnResults.every(t => t.keywordsPassed);
  const contextCheckedTurns = turnResults.filter(t => t.contextRetained !== null);
  const contextRetentionRate = contextCheckedTurns.length === 0
    ? null
    : contextCheckedTurns.filter(t => t.contextRetained).length / contextCheckedTurns.length;

  return {
    type: 'qa',
    sessionIndex,
    id: session.id,
    label: session.label,
    category: session.category,
    totalTurns: session.turns.length,
    completedTurns: turnResults.length,
    totalDurationMs: Date.now() - sessionStartMs,
    avgTurnDurationMs: Math.round(turnResults.reduce((s, t) => s + t.durationMs, 0) / (turnResults.length || 1)),
    isError: sessionError,
    allKeywordsPassed,
    contextRetentionRate,
    turns: turnResults,
  };
}

// ── Concurrency pool ─────────────────────────────────────────────────────────

async function runWithPool(tasks, concurrency) {
  const results = [];
  let idx = 0;
  let active = 0;
  return new Promise(resolveAll => {
    function next() {
      while (active < concurrency && idx < tasks.length) {
        const task = tasks[idx++];
        active++;
        task().then(r => {
          results.push(r);
          active--;
          if (active === 0 && idx >= tasks.length) resolveAll(results);
          else next();
        });
      }
    }
    next();
    if (tasks.length === 0) resolveAll(results);
  });
}

// ── Stats helpers ────────────────────────────────────────────────────────────

function stats(arr) {
  if (arr.length === 0) return { min: 0, max: 0, avg: 0, p50: 0, p90: 0, p95: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const p = pct => s[Math.min(s.length - 1, Math.floor(pct * s.length / 100))];
  return {
    min: s[0],
    max: s[s.length - 1],
    avg: Math.round(sum / s.length),
    p50: p(50),
    p90: p(90),
    p95: p(95),
  };
}

function pct(num, den) {
  if (den === 0) return '0.00%';
  return (num / den * 100).toFixed(2) + '%';
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir    = path.join(ROOT, 'captures', `stress-${timestamp}`);
  await mkdir(outDir, { recursive: true });

  const singlePath  = path.join(outDir, 'results.jsonl');
  const qaPath      = path.join(outDir, 'qa-results.jsonl');
  const summaryPath = path.join(outDir, 'summary.json');
  const reportPath  = path.join(outDir, 'report.md');

  const totalJobs = TOTAL_RUNS + QA_SESSIONS;
  let completed = 0;

  console.log(`\n🚀  stress-test`);
  console.log(`    single-turn: ${TOTAL_RUNS}  qa-sessions: ${QA_SESSIONS}  concurrency: ${CONCURRENCY}`);
  console.log(`    no-daemon: ${NO_DAEMON}  jitter: ${JITTER_MS}ms`);
  console.log(`📁  ${outDir}\n`);

  const barWidth = 40;
  function printProgress(label = '') {
    const p = completed / totalJobs;
    const filled = Math.round(p * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
    process.stdout.write(`\r[${bar}] ${(p * 100).toFixed(1).padStart(5)}% (${completed}/${totalJobs}) ${label}`);
  }
  printProgress();

  // ── Phase 1: single-turn ─────────────────────────────────────────────────
  const allSinglePrompts = [
    ...CODE_DEV_PROMPTS    .map(p => ({ ...p, category: 'code-dev'    })),
    ...CODE_REVIEW_PROMPTS .map(p => ({ ...p, category: 'code-review' })),
    ...WORK_DOC_PROMPTS    .map(p => ({ ...p, category: 'work-doc'    })),
    ...TOOL_USE_PROMPTS    .map(p => ({ ...p, category: 'tool-use'    })),
    ...QUICK_FACT_PROMPTS  .map(p => ({ ...p, category: 'quick-fact'  })),
  ];
  const singleSchedule = Array.from({ length: TOTAL_RUNS }, (_, i) => ({
    ...allSinglePrompts[i % allSinglePrompts.length],
    runIndex: i + 1,
  }));

  const singleResults = [];
  const singleTasks = singleSchedule.map(entry => async () => {
    const r = await runSingleTurn(entry);
    singleResults.push(r);
    await writeFile(singlePath, singleResults.map(x => JSON.stringify(x)).join('\n') + '\n');
    completed++;
    printProgress();
    if (r.isError) {
      process.stdout.write(`\n  ⚠️  Single #${r.runIndex} [${r.id}] ${r.timedOut ? 'TIMEOUT' : `exit=${r.exitCode}`}\n`);
      printProgress();
    }
    return r;
  });

  // ── Phase 2: Q&A sessions ───────────────────────────────────────────────
  const qaSchedule = Array.from({ length: QA_SESSIONS }, (_, i) =>
    QA_SESSION_CATALOGUE[i % QA_SESSION_CATALOGUE.length],
  );

  const qaResults = [];
  const qaTasks = qaSchedule.map((session, idx) => async () => {
    const r = await runQaSession(session, idx + 1);
    qaResults.push(r);
    await writeFile(qaPath, qaResults.map(x => JSON.stringify(x)).join('\n') + '\n');
    completed++;
    printProgress();
    if (r.isError) {
      process.stdout.write(`\n  ⚠️  QA #${r.sessionIndex} [${r.id}] error in ${r.completedTurns} turns\n`);
      printProgress();
    }
    return r;
  });

  await runWithPool(singleTasks, CONCURRENCY);
  // QA sessions run sequentially: parallel sessions can share UUIDs and cross-contaminate.
  await runWithPool(qaTasks, 1);
  process.stdout.write('\n\n');

  // ── Aggregated stats ─────────────────────────────────────────────────────
  const categories = ['code-dev', 'code-review', 'work-doc', 'tool-use', 'quick-fact'];
  const catBreakdown = categories.map(c => {
    const items = singleResults.filter(r => r.category === c);
    if (items.length === 0) return { category: c, total: 0 };
    // quality/format are conditional on a successful exit — an errored run
    // can't be expected to have correct content, so we don't double-penalize.
    // parsing is overall (parser should never produce banner contamination
    // even when the upstream errored).
    const ok = items.filter(r => !r.isError);
    const timing = stats(items.map(r => r.durationMs));
    return {
      category: c,
      total: items.length,
      success: ok.length,
      keywordsPassed: ok.filter(r => r.keywordsPassed).length,
      formatPassed:   ok.filter(r => r.formatPassed).length,
      parsingPassed:  items.filter(r => r.parsingPassed).length,
      refused:        items.filter(r => r.refused).length,
      successRate:        pct(ok.length,                                items.length),
      keywordPassRate:    pct(ok.filter(r => r.keywordsPassed).length,  ok.length),
      formatPassRate:     pct(ok.filter(r => r.formatPassed).length,    ok.length),
      parsingPassRate:    pct(items.filter(r => r.parsingPassed).length, items.length),
      avgMs: timing.avg, p50Ms: timing.p50, p90Ms: timing.p90, p95Ms: timing.p95,
    };
  });

  const singleErrors      = singleResults.filter(r => r.isError);
  const singleOk          = singleResults.filter(r => !r.isError);
  const singleKwFails     = singleOk.filter(r => !r.keywordsPassed);   // among non-errored
  const singleFmtFails    = singleOk.filter(r => !r.formatPassed);     // among non-errored
  const singleParseFails  = singleResults.filter(r => !r.parsingPassed); // overall
  const singleRefused     = singleResults.filter(r => r.refused);
  const singleCollapsed   = singleResults.filter(r => r.collapsed);

  // group parse failures by reason
  const parseFailReasons = {};
  for (const r of singleParseFails) {
    const k = r.parsingFailReason || 'unknown';
    parseFailReasons[k] = (parseFailReasons[k] || 0) + 1;
  }

  const qaErrors        = qaResults.filter(r => r.isError);
  const allQaTurns      = qaResults.flatMap(r => r.turns);
  const qaKwFails       = allQaTurns.filter(t => !t.keywordsPassed);
  const qaParseFails    = allQaTurns.filter(t => !t.parsingPassed);
  const contextChecked  = allQaTurns.filter(t => t.contextRetained !== null);
  const contextPassed   = contextChecked.filter(t => t.contextRetained);

  const summary = {
    generatedAt: new Date().toISOString(),
    config: { totalRuns: TOTAL_RUNS, qaSessions: QA_SESSIONS, concurrency: CONCURRENCY, noDaemon: NO_DAEMON },
    single: {
      total: singleResults.length,
      success: singleResults.length - singleErrors.length,
      errors: singleErrors.length,
      refused: singleRefused.length,
      collapsed: singleCollapsed.length,
      keywordFails: singleKwFails.length,
      formatFails:  singleFmtFails.length,
      parsingFails: singleParseFails.length,
      successRate:     pct(singleOk.length, singleResults.length),
      // quality/format rates are over non-errored runs; parsing is overall
      keywordPassRate: pct(singleOk.length - singleKwFails.length,  singleOk.length),
      formatPassRate:  pct(singleOk.length - singleFmtFails.length, singleOk.length),
      parsingPassRate: pct(singleResults.length - singleParseFails.length, singleResults.length),
      parsingFailReasons: parseFailReasons,
      timing: stats(singleResults.map(r => r.durationMs)),
      byCategory: catBreakdown,
    },
    qa: {
      sessions: {
        total: qaResults.length,
        errors: qaErrors.length,
        successRate: pct(qaResults.length - qaErrors.length, qaResults.length),
      },
      turns: {
        total: allQaTurns.length,
        keywordFails: qaKwFails.length,
        keywordPassRate: pct(allQaTurns.length - qaKwFails.length, allQaTurns.length),
        parsingFails: qaParseFails.length,
        parsingPassRate: pct(allQaTurns.length - qaParseFails.length, allQaTurns.length),
      },
      contextRetention: {
        checked: contextChecked.length,
        passed:  contextPassed.length,
        rate:    pct(contextPassed.length, contextChecked.length),
      },
      avgSessionDurationMs: Math.round(qaResults.reduce((s, r) => s + r.totalDurationMs, 0) / (qaResults.length || 1)),
      avgTurnDurationMs:    Math.round(allQaTurns.reduce((s, t) => s + t.durationMs, 0) / (allQaTurns.length || 1)),
    },
    failedSingleRuns: singleErrors.map(r => ({ runIndex: r.runIndex, id: r.id, label: r.label, exitCode: r.exitCode, timedOut: r.timedOut })),
    parseFailedSingleRuns: singleParseFails.map(r => ({ runIndex: r.runIndex, id: r.id, label: r.label, reason: r.parsingFailReason, preview: r.responsePreview })),
    refusedSingleRuns: singleRefused.map(r => ({ runIndex: r.runIndex, id: r.id, label: r.label, reason: r.refusalReason })),
    failedQaSessions:  qaErrors.map(r => ({ sessionIndex: r.sessionIndex, id: r.id, label: r.label, completedTurns: r.completedTurns })),
    contextFailedTurns: allQaTurns.filter(t => t.contextRetained === false)
      .map(t => ({ turnIndex: t.turnIndex, question: t.question, preview: t.responsePreview })),
  };

  await writeFile(summaryPath, JSON.stringify(summary, null, 2));

  // ── Markdown report ──────────────────────────────────────────────────────
  const ms = v => `${(v / 1000).toFixed(2)}s`;
  const catRows = catBreakdown.map(c => c.total === 0
    ? `| ${c.category} | 0 | – | – | – | – | – | – | – |`
    : `| ${c.category} | ${c.total} | ${c.successRate} | ${c.keywordPassRate} | ${c.formatPassRate} | ${c.parsingPassRate} | ${c.refused} | ${ms(c.avgMs)} | ${ms(c.p90Ms)} |`
  ).join('\n');

  const parseReasonRows = Object.entries(parseFailReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `| ${reason} | ${n} |`)
    .join('\n');

  const report = `# ocp Stress Test Report

**Generated**: ${summary.generatedAt}
**Config**: ${TOTAL_RUNS} single-turn | ${QA_SESSIONS} Q&A sessions | concurrency=${CONCURRENCY} | OCP_NO_DAEMON=${NO_DAEMON}

Evaluation axes: **quality** (expected keywords), **format** (output shape),
**parsing** (clean ocp output: no ANSI leakage, no banner, valid JSON),
**error/refusal** (exit code, timeout, refusal phrasing), **speed** (durationMs).

---

## Single-Turn Overall

| Metric | Value |
|--------|-------|
| Total runs            | ${summary.single.total} |
| Success (exit 0)      | ${summary.single.success} |
| Errors / timeouts     | ${summary.single.errors} |
| Model refusals        | ${summary.single.refused} |
| Collapsed cards       | ${summary.single.collapsed} |
| **Success rate**      | **${summary.single.successRate}** |
| **Quality (keywords)**| **${summary.single.keywordPassRate}** |
| **Format match**      | **${summary.single.formatPassRate}** |
| **Parsing success**   | **${summary.single.parsingPassRate}** |

### Timing (all single-turn)

| Avg | P50 | P90 | P95 | Min | Max |
|-----|-----|-----|-----|-----|-----|
| ${ms(summary.single.timing.avg)} | ${ms(summary.single.timing.p50)} | ${ms(summary.single.timing.p90)} | ${ms(summary.single.timing.p95)} | ${ms(summary.single.timing.min)} | ${ms(summary.single.timing.max)} |

### By Category

| Category | N | Success | Quality | Format | Parsing | Refused | Avg | P90 |
|----------|---|---------|---------|--------|---------|---------|-----|-----|
${catRows}

${parseReasonRows
  ? '### Parsing failure reasons\n\n| Reason | Count |\n|--------|-------|\n' + parseReasonRows + '\n'
  : '_No parsing failures._\n'}

---

## Q&A Multi-Turn

| Metric | Value |
|--------|-------|
| Total sessions             | ${summary.qa.sessions.total} |
| Session errors             | ${summary.qa.sessions.errors} |
| **Session success rate**   | **${summary.qa.sessions.successRate}** |
| Total turns                | ${summary.qa.turns.total} |
| **Turn quality (keywords)**| **${summary.qa.turns.keywordPassRate}** |
| **Turn parsing success**   | **${summary.qa.turns.parsingPassRate}** |
| Avg session duration       | ${ms(summary.qa.avgSessionDurationMs)} |
| Avg turn duration          | ${ms(summary.qa.avgTurnDurationMs)} |

### Context retention

Whether turn N+1's answer references a concept from turn N — verifies that
\`--resume\` correctly threads the conversation history.

| Metric | Value |
|--------|-------|
| Turns checked          | ${summary.qa.contextRetention.checked} |
| Passed                 | ${summary.qa.contextRetention.passed} |
| **Retention rate**     | **${summary.qa.contextRetention.rate}** |

${summary.contextFailedTurns.length > 0
  ? '#### Context retention failures\n\n' +
    summary.contextFailedTurns.map(t =>
      `- Turn ${t.turnIndex} \`${t.question.slice(0, 50)}\` — preview: \`${t.preview.slice(0, 60)}\``
    ).join('\n')
  : '_All context-retention checks passed._'
}

---

## Failed Single Runs

${summary.failedSingleRuns.length === 0
  ? '_None._'
  : summary.failedSingleRuns.map(r => `- #${r.runIndex} \`${r.id}\` **${r.label}** ${r.timedOut ? 'TIMEOUT' : `exit=${r.exitCode}`}`).join('\n')
}

## Parsing-Failed Runs

${summary.parseFailedSingleRuns.length === 0
  ? '_None._'
  : summary.parseFailedSingleRuns.map(r => `- #${r.runIndex} \`${r.id}\` **${r.label}** — reason: \`${r.reason}\` — preview: \`${r.preview}\``).join('\n')
}

## Refused / Non-Answer Runs

${summary.refusedSingleRuns.length === 0
  ? '_None._'
  : summary.refusedSingleRuns.map(r => `- #${r.runIndex} \`${r.id}\` **${r.label}** — reason: \`${r.reason}\``).join('\n')
}

## Failed Q&A Sessions

${summary.failedQaSessions.length === 0
  ? '_None._'
  : summary.failedQaSessions.map(r => `- #${r.sessionIndex} \`${r.id}\` **${r.label}** (${r.completedTurns} turns completed)`).join('\n')
}

---

_Files: \`results.jsonl\` · \`qa-results.jsonl\` · \`summary.json\`_
`;

  await writeFile(reportPath, report);

  // ── Console summary ──────────────────────────────────────────────────────
  const w = 62;
  console.log('═'.repeat(w));
  console.log('  SINGLE-TURN');
  console.log(`  ✅  Success      : ${summary.single.successRate}`);
  console.log(`  🔑  Quality (kw) : ${summary.single.keywordPassRate}`);
  console.log(`  🎨  Format match : ${summary.single.formatPassRate}`);
  console.log(`  📥  Parsing OK   : ${summary.single.parsingPassRate}`);
  console.log(`  🙅  Refused      : ${summary.single.refused}`);
  console.log(`  ⏱️   Avg / P90    : ${ms(summary.single.timing.avg)} / ${ms(summary.single.timing.p90)}`);
  console.log(`  ❌  Errors       : ${summary.single.errors}`);
  console.log('─'.repeat(w));
  console.log('  Q&A MULTI-TURN');
  console.log(`  ✅  Sessions     : ${summary.qa.sessions.successRate}`);
  console.log(`  🔑  Turn quality : ${summary.qa.turns.keywordPassRate}`);
  console.log(`  📥  Turn parse OK: ${summary.qa.turns.parsingPassRate}`);
  console.log(`  🧠  Ctx retention: ${summary.qa.contextRetention.rate} (${summary.qa.contextRetention.passed}/${summary.qa.contextRetention.checked})`);
  console.log(`  ⏱️   Avg session  : ${ms(summary.qa.avgSessionDurationMs)}`);
  console.log(`  ❌  Session errors: ${summary.qa.sessions.errors}`);
  console.log('═'.repeat(w));
  console.log(`\n📝  ${reportPath}`);
  console.log(`📊  ${summaryPath}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
