#!/usr/bin/env node
// Stress test for open-claude-p: drives a single warm chat session
// through a realistic, mixed-workload turn series — long-form text,
// web search, news fetch + analysis, code review, translation,
// context recall, large RAG-style prompts.
//
// Coverage:
//   - chunked-write path for large prompts (Cosmica regression case)
//   - WebSearch / WebFetch tool dispatch
//   - cross-turn context recall (same chat session, --resume-driven)
//   - long-form output (200-300 word answers)
//   - mixed prompt sizes (50 B → 3 KB)
//
// Each turn has a `check(text)` function that returns true when the
// response looks substantively correct. Open-ended responses use
// keyword presence or simple length checks rather than exact match.
//
// The run uses a fresh temp dir as `cwd` so it does NOT share
// `~/.claude/projects/<this-cwd>/` with any other active claude
// session — a defensive choice after observing cross-session JSONL
// pickup when the test cwd was shared with an interactive claude run.
//
// Usage:
//   node scripts/stress-test.mjs                # full turn set
//   node scripts/stress-test.mjs --turns=10     # truncate to first N

import { createChatClient } from '../src/chat/index.js';
import { mkdir, writeFile, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { turns: null };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--(\w[\w-]*)(?:=(.+))?$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'turns') out.turns = Math.max(1, Number(v) || 0);
    else if (k === 'help') {
      process.stdout.write(
        'usage: node scripts/stress-test.mjs [--turns=N]\n',
      );
      process.exit(0);
    }
  }
  return out;
}

// Build a ~3 KB RAG-style document the model has to extract a fact
// from — same shape as the Cosmica prompts that originally triggered
// the paste-mode regression.
function buildLargeRagPrompt() {
  const blocks = Array.from({ length: 20 }, (_, k) => {
    const id = String(k).padStart(2, '0');
    return (
      `::note-card\n` +
      `path: /notes/2026/research-${id}.md\n` +
      `title: Note ${id} — distributed consensus primer\n` +
      `excerpt: Raft uses a leader-based replication model; election ` +
      `timeouts randomised between 150–300 ms reduce split-vote risk. ` +
      `Multi-Paxos is the older alternative with comparable safety but ` +
      `harder operational reasoning. The CANARY_LATCH project notes ` +
      `that quorum reads degrade gracefully under network partition ` +
      `when reader quorum size is W+R>N.\n` +
      `::`
    );
  });
  // Hide one identifying fact in block 13 the prompt asks about.
  blocks[13] =
    `::note-card\n` +
    `path: /notes/2026/secret-handshake.md\n` +
    `title: Note 13 — CANARY_LATCH coordinator hostname\n` +
    `excerpt: The CANARY_LATCH coordinator is reachable at ` +
    `canary-latch-prod-13.internal:7042. Failover is announced via the ` +
    `etcd key /latch/leader. Health probe expects HTTP 200 on /healthz.\n` +
    `::`;
  return (
    blocks.join('\n\n') +
    `\n\n--- Latest user message — respond to this ---\n` +
    `USER: From the notes above, what is the hostname and port of the ` +
    `CANARY_LATCH coordinator? Reply with just "<host>:<port>" on one line.`
  );
}

// 25-turn realistic workload. Each entry:
//   prompt: string sent to the model
//   shape:  human-readable category (logged + summarised)
//   check(text): function returning { ok: boolean, reason: string }
//
// The check function is intentionally lenient — open-ended answers
// are validated by keyword presence, not exact match.
const TURNS = [
  {
    shape: 'long-write',
    prompt:
      "Write a 200-word explanation of the differences between WebSockets " +
      "and HTTP long-polling, aimed at a mid-level backend engineer. " +
      "Cover: connection model, message framing, server cost per client, " +
      "and one realistic case where long-polling is actually the right " +
      "choice. Be specific.",
    check: (t) => ({
      ok: t.length > 600 && /websocket/i.test(t) && /poll/i.test(t),
      reason: '≥600 chars, mentions WebSocket and polling',
    }),
  },
  {
    shape: 'follow-up',
    prompt:
      "Now contrast WebSockets specifically with Server-Sent Events. " +
      "Two paragraphs max.",
    check: (t) => ({
      ok: t.length > 300 && /sse|server-sent/i.test(t),
      reason: '≥300 chars, mentions SSE',
    }),
  },
  {
    shape: 'analysis',
    prompt:
      "Compare PostgreSQL and SQLite for an embedded desktop app that " +
      "holds <100 MB of structured data and needs offline-first reads. " +
      "Give 3 pros and 3 cons for each. Format as two bulleted lists.",
    check: (t) => ({
      ok: /postgres|postgresql/i.test(t) && /sqlite/i.test(t) && (t.match(/\n[-*•]/g)?.length ?? 0) >= 4,
      reason: 'covers both DBs and uses bulleted format',
    }),
  },
  {
    shape: 'code-gen',
    prompt:
      "Show a minimal Node.js example (ESM, no comments) of opening a " +
      "SQLite connection using better-sqlite3, creating a single `users` " +
      "table with id/name columns, and inserting one row. Just code, no prose.",
    check: (t) => ({
      ok: /better-sqlite3/.test(t) && /CREATE TABLE/i.test(t) && /INSERT INTO/i.test(t),
      reason: 'imports better-sqlite3 and shows CREATE+INSERT',
    }),
  },
  {
    shape: 'web-search',
    prompt:
      "Search the web for the current Node.js LTS major version and the " +
      "date it entered Active LTS. Reply in this exact shape on one line: " +
      "`Node.js <major>: Active LTS since <YYYY-MM-DD>`",
    check: (t) => ({
      ok: /Node\.js\s+\d{2}/i.test(t) && /\d{4}-\d{2}-\d{2}/.test(t),
      reason: 'contains Node.js NN and a YYYY-MM-DD date',
    }),
  },
  {
    shape: 'web-fetch-analysis',
    prompt:
      "Search for Anthropic's most recent public blog post (2026). " +
      "Reply with: (1) the post title, (2) one-sentence summary of what " +
      "it's about, (3) one specific claim or number from the post. " +
      "Three short lines.",
    check: (t) => ({
      ok: t.length > 120 && (t.match(/\n/g)?.length ?? 0) >= 2,
      reason: 'three-line structured answer',
    }),
  },
  {
    shape: 'recall',
    prompt:
      "Earlier in this conversation you compared two databases for an " +
      "embedded desktop app. Which one did you recommend, and why " +
      "(one sentence)?",
    check: (t) => ({
      ok: /sqlite/i.test(t) && t.length < 500,
      reason: 'recalls SQLite recommendation in <500 chars',
    }),
  },
  {
    shape: 'long-tech',
    prompt:
      "Write a 300-word explanation of the role of write-ahead logging " +
      "(WAL) in modern databases. Include: durability guarantee, why WAL " +
      "is faster than in-place update, and one concrete production " +
      "incident pattern that WAL recovery handles cleanly.",
    check: (t) => ({
      ok: t.length > 900 && /wal|write-ahead/i.test(t) && /durab/i.test(t),
      reason: '≥900 chars, mentions WAL and durability',
    }),
  },
  {
    shape: 'code-review',
    prompt:
      "Review this function for correctness issues. Reply with a numbered " +
      "list of bugs (max 5), each in one sentence.\n\n```js\n" +
      "async function transfer(fromId, toId, amount) {\n" +
      "  const from = await db.getAccount(fromId);\n" +
      "  const to = await db.getAccount(toId);\n" +
      "  if (from.balance < amount) throw new Error('insufficient');\n" +
      "  await db.update(fromId, { balance: from.balance - amount });\n" +
      "  await db.update(toId,   { balance: to.balance + amount });\n" +
      "  return true;\n" +
      "}\n```",
    check: (t) => ({
      ok: t.length > 200 && (/race|concurren|atomic|transaction/i.test(t)),
      reason: 'mentions race / atomicity / transaction',
    }),
  },
  {
    shape: 'math-reason',
    prompt:
      "A server sustains 1000 requests per second with a p99 response " +
      "time of 50 ms. Using Little's Law, how many concurrent in-flight " +
      "requests does the server hold at the 99th percentile? Show the " +
      "calculation, then state the answer on the last line as " +
      "`Answer: <number>`.",
    check: (t) => ({
      ok: /50/.test(t) && /Answer:\s*5\d?(\s|$|\.)/.test(t),
      reason: "applies L = λW with W=50ms (answer near 50)",
    }),
  },
  {
    shape: 'news-search',
    prompt:
      "Search the web for AI-safety news from the past 30 days (relative " +
      "to today). Pick the single most policy-relevant story, and reply " +
      "with: title on line 1, publisher on line 2, two-sentence summary " +
      "on lines 3-4.",
    check: (t) => ({
      ok: t.length > 200 && (t.match(/\n/g)?.length ?? 0) >= 3,
      reason: 'four-line structured answer with substance',
    }),
  },
  {
    shape: 'news-analysis',
    prompt:
      "For the story you just summarized, identify the one specific " +
      "regulatory or commercial implication that would most affect a " +
      "small AI-startup founder. One paragraph (3-5 sentences).",
    check: (t) => ({
      ok: t.length > 180 && t.length < 1500,
      reason: '180-1500 char focused analysis',
    }),
  },
  {
    shape: 'translation',
    prompt:
      "Translate this Korean sentence to natural English (one line, no " +
      "explanation): '이 코드를 좀 더 효율적으로 리팩터링해주세요. 특히 " +
      "I/O 병목 부분을 개선하면 좋겠습니다.'",
    check: (t) => ({
      ok: /refactor/i.test(t) && /(i\/o|io|input.?output)/i.test(t),
      reason: 'contains refactor and I/O',
    }),
  },
  {
    shape: 'refactor',
    prompt:
      "Refactor this Python function for clarity and correctness. Reply " +
      "with the refactored code only (no prose).\n\n```python\n" +
      "def fmt(items):\n" +
      "    s = ''\n" +
      "    for i in range(0, len(items)):\n" +
      "        if i != 0: s = s + ', '\n" +
      "        s = s + str(items[i])\n" +
      "    return s\n```",
    check: (t) => ({
      ok: /def\s+fmt/.test(t) && /(join|', '\.join)/.test(t),
      reason: 'uses str.join in the refactor',
    }),
  },
  {
    shape: 'long-qa',
    prompt:
      "Explain the CAP theorem in roughly 250 words. Include a concrete " +
      "example of a real datastore that chooses CP over AP, and one that " +
      "chooses AP over CP. Be specific with product names.",
    check: (t) => ({
      ok: t.length > 700 && /CAP/.test(t) && /(consisten)/i.test(t) && /partition/i.test(t),
      reason: '≥700 chars, mentions CAP/consistency/partition',
    }),
  },
  {
    shape: 'web-search-time',
    prompt:
      "Use a web search if needed: what is the current local time in " +
      "Tokyo right now (within ±5 minutes)? Reply in the exact format " +
      "`Tokyo: HH:MM <TZ>` on one line.",
    check: (t) => ({
      ok: /tokyo/i.test(t) && /\d{1,2}:\d{2}/.test(t),
      reason: 'contains Tokyo and HH:MM',
    }),
  },
  {
    shape: 'large-rag',
    prompt: buildLargeRagPrompt(),
    check: (t) => ({
      ok: /canary-latch-prod-13\.internal:7042/.test(t),
      reason: 'extracted hidden fact from block 13',
    }),
  },
  {
    shape: 'recall-list',
    prompt:
      "Going back over THIS conversation, list every distinct topic we " +
      "have discussed so far, in the order they appeared. One bullet per " +
      "topic, ≤6 words each.",
    check: (t) => ({
      ok: (t.match(/\n[-*•]/g)?.length ?? 0) >= 8 || (t.match(/^[-*•]/gm)?.length ?? 0) >= 8,
      reason: '≥8 bulleted topics',
    }),
  },
  {
    shape: 'creative',
    prompt: "Write a haiku about distributed systems. Three lines, no title.",
    check: (t) => {
      const lines = t.split(/\n/).map((l) => l.trim()).filter(Boolean);
      return {
        ok: lines.length >= 3 && lines.length <= 5 && t.length < 200,
        reason: '3-5 short lines, <200 chars',
      };
    },
  },
  {
    shape: 'compare',
    prompt:
      "Compare Rust's borrow checker to Swift's automatic reference " +
      "counting (ARC) as memory-management strategies. 200 words max. " +
      "Focus on what each catches at compile-time vs runtime.",
    check: (t) => ({
      ok: t.length > 500 && /borrow/i.test(t) && /arc/i.test(t),
      reason: '≥500 chars, mentions borrow and ARC',
    }),
  },
  {
    shape: 'type-gen',
    prompt:
      "Write a TypeScript type for a paginated API response carrying a " +
      "list of `User` objects with id (string), name (string), email " +
      "(string optional). Include cursor-based pagination metadata " +
      "(next_cursor optional, has_more boolean). Just the type, no prose.",
    check: (t) => ({
      ok: /type\s+\w+\s*=|interface\s+\w+/.test(t) &&
          /next_cursor/.test(t) && /has_more/.test(t),
      reason: 'declares type/interface with next_cursor and has_more',
    }),
  },
  {
    shape: 'whitespace-edge',
    prompt:
      "   \n\t  In one sentence, what's a 'thundering herd' in the " +
      "context of cache stampedes?",
    check: (t) => ({
      ok: /thunder/i.test(t) && /(cache|stampede|expir)/i.test(t),
      reason: 'mentions thundering herd and cache-related term',
    }),
  },
  {
    shape: 'final-recall',
    prompt:
      "What was the CANARY_LATCH coordinator hostname I asked about " +
      "earlier? One line.",
    check: (t) => ({
      ok: /canary-latch-prod-13\.internal/.test(t),
      reason: 'recalls the hostname from the large-rag turn',
    }),
  },
  {
    shape: 'summary',
    prompt:
      "Summarize EVERY exchange in this conversation in 5 bullet points, " +
      "in the order they happened. Each bullet ≤12 words. Number them.",
    check: (t) => ({
      ok: (t.match(/^\s*[1-5][.)]/gm)?.length ?? 0) >= 4,
      reason: '≥4 numbered bullets',
    }),
  },
];

function pct(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function rssMb() {
  return Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
}

async function main() {
  const args = parseArgs(process.argv);
  const turns = args.turns ? TURNS.slice(0, args.turns) : TURNS;
  process.stdout.write(`[stress] running ${turns.length} realistic turns\n`);

  // Isolate the test in a fresh temp cwd so its
  // `~/.claude/projects/<encoded-cwd>/` JSONL files do not collide
  // with any other live claude session in the developer's editor.
  const isoCwd = await mkdtemp(path.join(os.tmpdir(), 'ocp-stress-'));
  process.stdout.write(`[stress] isolated cwd: ${isoCwd}\n`);

  // A fresh temp cwd has never been trusted by `claude`, so the very
  // first turn would otherwise abort with `trust-required` on the
  // "Do you trust this folder?" dialog. Auto-accept for the test.
  process.env.OCP_AUTO_ACCEPT_TRUST = '1';

  // Cold-cwd warmup: first claude spawn in a never-seen directory
  // adds MCP/plugin/cache loading on top of the trust-accept settle,
  // so the FIRST_RESPONSE_MS watchdog (default 20 s) can fire before
  // claude even reaches the prompt box. Bump only for the test so we
  // measure steady-state behaviour, not first-spawn warmup.
  if (!process.env.OCP_FIRST_RESPONSE_MS) {
    process.env.OCP_FIRST_RESPONSE_MS = '90000';
  }
  if (!process.env.OCP_PROMPT_BOX_WAIT_MS) {
    process.env.OCP_PROMPT_BOX_WAIT_MS = '60000';
  }

  const tmpDb = path.join(
    __dirname,
    '..',
    'captures',
    `stress-db-${Date.now()}.json`,
  );
  await mkdir(path.dirname(tmpDb), { recursive: true });

  const chat = createChatClient({
    dbPath: tmpDb,
    dangerouslySkipPermissions: true,
    driverOpts: {
      cwd: isoCwd,
      pasteMode: 'auto', // exercise the new chunked-write path
    },
  });

  // Pre-warm: spawn claude once in the isolated cwd so MCP/hook/plugin
  // loading is in cache before the measured turns start. A cold-spawn
  // in a fresh /tmp dir routinely needs 60–120 s before the first
  // prompt can be read; without this, turn 1 of the measured run
  // would consistently abort with `interactive-required`. The warmup
  // result is discarded — we only care that the directory's cache is
  // primed and claude has issued its session id.
  process.stdout.write('[stress] pre-warming claude in isolated cwd…\n');
  const warmupStart = Date.now();
  let warmupCid = null;
  try {
    const warmup = await chat.send({
      message: 'ping (warmup — reply with one word)',
      conversationId: null,
    });
    warmupCid = warmup.conversationId ?? null;
    process.stdout.write(
      `[stress] warmup done in ${Date.now() - warmupStart}ms, ` +
      `completion=${warmup.completionReason}, chars=${(warmup.text ?? '').length}\n`,
    );
  } catch (e) {
    process.stdout.write(`[stress] warmup failed: ${e.code || e.message}\n`);
  }

  let conversationId = warmupCid;
  const results = [];
  const t0 = Date.now();

  for (let i = 0; i < turns.length; i++) {
    const spec = turns[i];
    const turnNo = i + 1;
    const turnStart = Date.now();
    let res, err = null;
    try {
      res = await chat.send({
        message: spec.prompt,
        conversationId,
      });
      conversationId = res.conversationId ?? conversationId;
    } catch (e) {
      err = e;
    }
    const durationMs = Date.now() - turnStart;

    const text = (res?.text ?? '').trim();
    const checkResult = err
      ? { ok: false, reason: `threw: ${err.code || err.message}` }
      : (spec.check?.(text) ?? { ok: text.length > 0, reason: 'non-empty' });

    const row = {
      turn: turnNo,
      shape: spec.shape,
      promptBytes: Buffer.byteLength(spec.prompt, 'utf8'),
      durationMs,
      ok: checkResult.ok,
      checkReason: checkResult.reason,
      // Full text for inspection. Cap at 8 KB to keep the report
      // human-skimmable; the conversations DB has the unbounded copy.
      response: text.slice(0, 8 * 1024),
      responseChars: text.length,
      completion: res?.completionReason ?? null,
      error: err ? (err.code || err.message || String(err)) : null,
      rssMb: rssMb(),
    };
    results.push(row);

    const status = row.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const preview = text.replace(/\s+/g, ' ').slice(0, 96);
    process.stdout.write(
      `[stress] ${status} ${String(turnNo).padStart(2)}/${turns.length} ` +
      `${spec.shape.padEnd(20)} ` +
      `bytes=${String(row.promptBytes).padStart(5)} ` +
      `dur=${String(durationMs).padStart(6)}ms ` +
      `chars=${String(row.responseChars).padStart(5)} ` +
      `rss=${row.rssMb}MB · ${JSON.stringify(preview)}\n`,
    );
    if (!row.ok && !err) {
      process.stdout.write(`           reason: ${row.checkReason}\n`);
    }
  }

  await chat.close();

  // ── summary ──────────────────────────────────────────────────────────
  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const byShape = {};
  for (const r of results) {
    const s = byShape[r.shape] ??= { total: 0, pass: 0, durations: [] };
    s.total++;
    if (r.ok) s.pass++;
    s.durations.push(r.durationMs);
  }
  const allDurations = results.map((r) => r.durationMs);
  const firstTurn = results[0]?.durationMs ?? null;
  const steadyDurations = results.slice(1).map((r) => r.durationMs);

  const summary = {
    total,
    passed,
    failed: total - passed,
    successRate: total ? Math.round((passed / total) * 1000) / 10 : null,
    firstTurnMs: firstTurn,
    steadyState: {
      p50Ms: pct(steadyDurations, 50),
      p95Ms: pct(steadyDurations, 95),
      maxMs: steadyDurations.length ? Math.max(...steadyDurations) : null,
    },
    byShape: Object.fromEntries(
      Object.entries(byShape).map(([k, v]) => [k, {
        total: v.total, pass: v.pass,
        p50Ms: pct(v.durations, 50),
        p95Ms: pct(v.durations, 95),
      }]),
    ),
    elapsedMs: Date.now() - t0,
    finalRssMb: rssMb(),
    isolatedCwd: isoCwd,
  };

  const reportPath = path.join(
    __dirname,
    '..',
    'captures',
    `stress-${Date.now()}.json`,
  );
  await writeFile(reportPath, JSON.stringify({ summary, results }, null, 2));

  process.stdout.write('\n[stress] === Summary ===\n');
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(`[stress] report saved to ${path.relative(process.cwd(), reportPath)}\n`);

  process.exitCode = summary.failed === 0 ? 0 : 1;
}

main().catch((e) => {
  process.stderr.write(`[stress] fatal: ${e?.stack || e?.message || e}\n`);
  process.exit(2);
});
