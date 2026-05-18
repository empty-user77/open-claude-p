#!/usr/bin/env node
//
// Sample chat server demonstrating how to drop `open-claude-p/chat` into
// an Express app. Loopback-only by default; see startup banner for the
// security knobs.

import express from 'express';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// One `import { createChatClient } from 'open-claude-p/chat'` is all an
// external project needs. The in-repo dev flow uses the same public
// import: sample/package.json declares `"open-claude-p": "file:.."`
// so `cd sample && npm install` symlinks `node_modules/open-claude-p`
// to the repo root and this import resolves through that. The
// `ocp-sample init` companion CLI rewrites the file: spec to a
// real semver range when copying the sample out as a standalone
// project.
import { createChatClient, cleanSpinnerLabel, isAssistantTextNoise } from 'open-claude-p/chat';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR    = path.join(__dirname, 'data');
const PUBLIC_DIR  = path.join(__dirname, 'public');

// Chat client owns the driver + conversation store + skill loader +
// JSONL extractor + cost calculator. Everything `/api/chat` used to do
// by hand now lives here.
const chat = createChatClient({
  dbPath: path.join(DATA_DIR, 'conversations.json'),
  skillsDir: path.join(os.homedir(), '.claude', 'skills'),
  // `createChatClient` already defaults `dangerouslySkipPermissions`
  // to true in 1.1+ — PTY automation can't answer claude's
  // interactive permission prompt, so anything else would deadlock
  // on the first tool call. No env-gate here on purpose: this demo
  // is for trying the SDK out, not for guarding an untrusted prompt
  // source. Wrap the chat client yourself with a stricter config
  // for that case.
  // No `appendSystemPrompt` here — the SDK ships a sensible default
  // for interactive use. If you want to add chat-specific rules on
  // top, pass a string and it will be appended to (not replace) the
  // SDK default. To opt out of the SDK default entirely, pass `null`.
  driverOpts: { maxResponseMs: 86_400_000, warmupMs: 5_000 }, // 24h timeout
});

// Active request tracker — keyed by a monotonic ID
const activeProcs = new Map();
let procSeq = 0;

// ── PTY monitor broadcaster ─────────────────────────────────────────────────
// All connected /api/monitor SSE clients receive every chat lifecycle event.
const monitor = new EventEmitter();
monitor.setMaxListeners(50);

const TAG_COLOR = { SPAWN: '\x1b[33m', DATA: '\x1b[32m', DONE: '\x1b[36m', ERR: '\x1b[31m', INFO: '\x1b[37m' };

function emit(tag, payload = {}) {
  const ts = new Date().toISOString().slice(11, 23);
  monitor.emit('event', { ts, tag, ...payload });
  const c = TAG_COLOR[tag] ?? '\x1b[37m';
  const line = Object.entries(payload).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  ');
  process.stdout.write(`\x1b[90m${ts}\x1b[0m ${c}[${tag}]\x1b[0m ${line}\n`);
}

// ── Express ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

// Number(env) || fb would accept `-1` (truthy) and silently pass it to
// app.listen which then throws a libuv RangeError — surface a clean
// fallback instead.
const RAW_PORT = Number(process.env.PORT);
const PORT = (Number.isFinite(RAW_PORT) && RAW_PORT > 0 && RAW_PORT < 65536) ? Math.floor(RAW_PORT) : 3000;
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Host header allowlist defeats DNS-rebinding attacks against the loopback
// bind: a malicious page that rebinds evil.example → 127.0.0.1 would send
// Host: evil.example, which we reject before any handler runs.
app.use((req, res, next) => {
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return res.status(403).json({ error: 'forbidden host' });
  next();
});

// Reject cross-origin mutating requests.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({ error: 'forbidden origin' });
  }
  next();
});

// List conversations (metadata only)
app.get('/api/conversations', async (_req, res) => {
  res.json(await chat.listConversations());
});

// Get single conversation with full message history
app.get('/api/conversations/:id', async (req, res) => {
  const conv = await chat.getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'not found' });
  res.json(conv);
});

// Delete conversation
app.delete('/api/conversations/:id', async (req, res) => {
  try {
    await chat.deleteConversation(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    process.stderr.write(`[chat] delete failed: ${err.stack || err.message}\n`);
    res.status(500).json({ error: 'delete failed' });
  }
});

// List available skills from ~/.claude/skills/
app.get('/api/skills', async (_req, res) => {
  res.json(await chat.listSkills());
});

// Active processes — list
app.get('/api/processes', (_req, res) => {
  const now = Date.now();
  res.json([...activeProcs.values()].map(({ abort: _, ...p }) => ({ ...p, elapsedMs: now - p.startMs })));
});

// Active processes — kill by id, or 'all'
app.delete('/api/processes/:id', (req, res) => {
  if (req.params.id === 'all') {
    const ids = [...activeProcs.keys()];
    for (const id of ids) activeProcs.get(id)?.abort.abort();
    emit('INFO', { msg: `killed all (${ids.length}) processes` });
    return res.json({ ok: true, killed: ids });
  }
  const id = Number(req.params.id);
  const proc = activeProcs.get(id);
  if (!proc) return res.status(404).json({ error: 'process not found' });
  proc.abort.abort();
  emit('INFO', { msg: `killed process ${id}` });
  res.json({ ok: true, id });
});

// ── PTY Monitor SSE ─────────────────────────────────────────────────────────
app.get('/api/monitor', (req, res) => {
  // Hard cap on concurrent monitor subscribers. setMaxListeners(50)
  // only warns; without this cap, a local script connecting in a loop
  // would attach unbounded listeners and every emit() would iterate
  // all of them synchronously, blocking the event loop.
  const MAX_MONITOR_SUBS = Number(process.env.SAMPLE_MAX_MONITOR_SUBS) || 20;
  if (monitor.listenerCount('event') >= MAX_MONITOR_SUBS) {
    return res.status(503).json({ error: 'too many monitor subscribers', max: MAX_MONITOR_SUBS });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  const ts = new Date().toISOString().slice(11, 23);
  res.write(`data: ${JSON.stringify({ ts, tag: 'CONNECTED', msg: 'monitor stream ready' })}\n\n`);
  const handler = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  monitor.on('event', handler);
  req.on('close', () => monitor.off('event', handler));
});

// ── Chat SSE ────────────────────────────────────────────────────────────────
const MAX_ACTIVE_CHATS = Number(process.env.SAMPLE_MAX_ACTIVE ?? 4);

app.post('/api/chat', async (req, res) => {
  const { conversationId, message, skillName } = req.body;
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message must be a non-empty string' });
  }
  if (message.length > 262_144) {
    return res.status(413).json({ error: 'message too large', limit: 262_144 });
  }
  // Hard cap on in-flight chats — each spawns a real claude PTY (~100 MB
  // RSS + FDs). Without this, a buggy frontend retry loop or local
  // script hammering /api/chat will OOM / FD-exhaust the host.
  if (activeProcs.size >= MAX_ACTIVE_CHATS) {
    res.setHeader('Retry-After', '5');
    return res.status(503).json({ error: 'too many active chats', max: MAX_ACTIVE_CHATS });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  const sse = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const procId = ++procSeq;
  const abortCtrl = new AbortController();
  activeProcs.set(procId, { id: procId, prompt: message.slice(0, 60), startMs: Date.now(), status: 'running', abort: abortCtrl });
  emit('PROC', { action: 'start', id: procId, prompt: message.slice(0, 60) });
  emit('SPAWN', { transport: 'open-claude-p/chat', prompt: message.slice(0, 80) });

  try {
    let charCount = 0;
    const result = await chat.send({
      conversationId,
      message,
      skillName,
      signal: abortCtrl.signal,
      onEvent(ev) {
        if (ev.type === 'session-id') {
          emit('DATA', { event: 'session-id', id: ev.id });
        } else if (ev.type === 'spinner') {
          const label = cleanSpinnerLabel(ev.label);
          if (label) sse({ type: 'spinner', label });
        } else if (ev.type === 'assistant-text' && ev.text) {
          if (isAssistantTextNoise(ev.text)) return;
          const t = ev.text;
          charCount += t.length;
          sse({ type: 'text', text: t });
          if (charCount <= t.length || charCount % 200 < t.length) {
            emit('DATA', { event: 'assistant-text', chars: charCount, preview: t.slice(0, 50).replace(/\n/g, '↵') });
          }
        } else if (ev.type === 'sentinel') {
          emit('DATA', { event: 'sentinel', found: true });
        }
      },
    });

    emit('DONE', {
      reason: result.completionReason,
      ms: result.meta.elapsedMs,
      chars: result.text.length,
      sessionId: result.sessionId?.slice(0, 8) ?? null,
      tools: result.meta.tools,
      inputTokens: result.meta.inputTokens,
      outputTokens: result.meta.outputTokens,
      costUsd: result.meta.costUsd,
      isError: result.isError,
    });

    if (result.isError) {
      const reason = result.completionReason;
      sse({ type: 'error', error: reason === 'timeout' ? 'Response timed out.' : `An error occurred: ${reason}` });
    } else {
      sse({
        type: 'done',
        conversationId: result.conversationId,
        text: result.text || '(no response)',
        isNew: result.isNew,
        meta: result.meta,
      });
    }
  } catch (err) {
    process.stderr.write(`[chat] error: ${err.stack || err.message}\n`);
    const safeMsg = err.code === 'ENOENT' ? 'resource not found'
                  : err.name === 'AbortError' ? 'cancelled'
                  : 'internal error';
    emit('ERR', { message: safeMsg });
    sse({ type: 'error', error: safeMsg });
  } finally {
    activeProcs.delete(procId);
    emit('PROC', { action: 'end', id: procId });
  }

  res.end();
});

// Bind to loopback only. This sample is local-dev/demo grade; it has no
// auth and spawns the claude CLI on every /api/chat.
const HOST = process.env.HOST ?? '127.0.0.1';

// Refuse to bind anything other than loopback unless the operator has
// explicitly opted in. This sample ships with no auth and spawns a
// real `claude` CLI on every request — binding it to 0.0.0.0 turns
// the host into a remote-code-execution surface for anyone on the LAN.
const isLoopbackHost = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
if (!isLoopbackHost && process.env.SAMPLE_ALLOW_PUBLIC !== '1') {
  process.stderr.write(
    `\n\x1b[31m  ✖ Refusing to bind to ${HOST}.\x1b[0m\n` +
    `\x1b[31m    This sample has no auth and spawns the claude CLI on each request.\x1b[0m\n` +
    `\x1b[31m    To accept that risk and bind anyway, also set SAMPLE_ALLOW_PUBLIC=1.\x1b[0m\n\n`,
  );
  process.exit(1);
}

app.listen(PORT, HOST, () => {
  process.stdout.write(`\n\x1b[36m  Open Claude -p Chat  →  http://${HOST}:${PORT}\x1b[0m\n\n`);
  process.stdout.write(`\x1b[90m  uses open-claude-p/chat — same SDK any project can install\x1b[0m\n`);
  process.stdout.write(`\x1b[33m  ⚠ Local demo only. Do NOT expose this port. No auth, no rate limit.\x1b[0m\n`);
  if (process.env.SAMPLE_ALLOW_TOOLS === '1') {
    process.stdout.write(`\x1b[31m  ⚠ SAMPLE_ALLOW_TOOLS=1 — claude tool calls run without prompts.\x1b[0m\n`);
  }
  process.stdout.write('\n');
});
