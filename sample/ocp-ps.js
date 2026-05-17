#!/usr/bin/env node
/**
 * ocp-ps — CLI process manager for Open Claude -p Chat server
 *
 * Commands:
 *   ocp-ps               list active processes (default)
 *   ocp-ps list          list active processes
 *   ocp-ps kill <id>     kill process by id
 *   ocp-ps kill all      kill all active processes
 *   ocp-ps watch         live-refresh list every second (like `watch`)
 *
 * Options:
 *   --port <n>           server port (default: 3000, or $OCP_PORT)
 *   --host <h>           server host (default: localhost, or $OCP_HOST)
 *
 * Examples:
 *   node ocp-ps.js
 *   node ocp-ps.js watch
 *   node ocp-ps.js kill 3
 *   node ocp-ps.js kill all
 *   OCP_PORT=4000 node ocp-ps.js list
 */

const PORT = process.env.OCP_PORT ?? 3000;
const HOST = process.env.OCP_HOST ?? 'localhost';
const BASE = `http://${HOST}:${PORT}`;

// ── ANSI helpers ────────────────────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  yellow: '\x1b[33m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  gray:   '\x1b[90m',
};
const clr = (code, s) => `${code}${s}${c.reset}`;

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, opts);
  } catch (e) {
    console.error(clr(c.red, `✗ Cannot reach server at ${BASE}`));
    console.error(clr(c.gray, `  Start the server first: npm start`));
    process.exit(1);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error(clr(c.red, `✗ Server error ${res.status}: ${body.error ?? res.statusText}`));
    process.exit(1);
  }
  return res.json();
}

function getProcs()    { return apiFetch('/api/processes'); }
function killProc(id)  { return apiFetch(`/api/processes/${id}`, { method: 'DELETE' }); }

// ── Formatting ────────────────────────────────────────────────────────────────
function fmtElapsed(ms) {
  if (ms < 60_000)  return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m${s}s`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h${m}m`;
}

const PROMPT_MAX = 52;

function printTable(procs, prefix = '') {
  if (!procs.length) {
    console.log(`${prefix}${clr(c.gray, 'No active processes.')}`);
    return;
  }
  const now = Date.now();
  const HEAD = `${'ID'.padEnd(5)}  ${'STATUS'.padEnd(9)}  ${'ELAPSED'.padEnd(9)}  PROMPT`;
  console.log(`${prefix}${clr(c.cyan + c.bold, HEAD)}`);
  console.log(`${prefix}${clr(c.gray, '─'.repeat(HEAD.length))}`);
  for (const p of procs) {
    const elapsed = fmtElapsed(now - p.startMs);
    const prompt  = p.prompt.length > PROMPT_MAX
      ? p.prompt.slice(0, PROMPT_MAX - 1) + '…'
      : p.prompt;
    const status  = p.status ?? 'running';
    const statusColor = status === 'running' ? c.green : c.yellow;
    console.log(
      `${prefix}` +
      clr(c.yellow, String(p.id).padEnd(5)) + '  ' +
      clr(statusColor, status.padEnd(9)) + '  ' +
      clr(c.gray, elapsed.padEnd(9)) + '  ' +
      prompt,
    );
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);

// Parse --port / --host flags
let portOverride = null;
let hostOverride = null;
const filteredArgs = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--port' && rawArgs[i + 1]) { portOverride = rawArgs[++i]; }
  else if (rawArgs[i] === '--host' && rawArgs[i + 1]) { hostOverride = rawArgs[++i]; }
  else filteredArgs.push(rawArgs[i]);
}
if (portOverride) globalThis.__ocpPort = portOverride;
if (hostOverride) globalThis.__ocpHost = hostOverride;

const cmd    = filteredArgs[0] ?? 'list';
const subArg = filteredArgs[1] ?? null;

// ── list ──────────────────────────────────────────────────────────────────────
if (cmd === 'list') {
  const procs = await getProcs();
  printTable(procs);

// ── kill ──────────────────────────────────────────────────────────────────────
} else if (cmd === 'kill') {
  if (!subArg) {
    console.error(clr(c.red, 'Usage: ocp-ps kill <id|all>'));
    process.exit(1);
  }

  if (subArg === 'all') {
    const procs = await getProcs();
    if (!procs.length) {
      console.log(clr(c.gray, 'No active processes to kill.'));
      process.exit(0);
    }
    const result = await killProc('all');
    for (const id of result.killed) {
      const p = procs.find(x => x.id === id);
      console.log(clr(c.green, `✓`) + ` Killed process ${clr(c.yellow, id)} — ${p?.prompt ?? ''}`);
    }
  } else {
    const id = Number(subArg);
    if (!Number.isInteger(id) || id <= 0) {
      console.error(clr(c.red, `Invalid process id: ${subArg}`));
      process.exit(1);
    }
    await killProc(id);
    console.log(clr(c.green, `✓`) + ` Killed process ${clr(c.yellow, id)}`);
  }

// ── watch ─────────────────────────────────────────────────────────────────────
} else if (cmd === 'watch') {
  process.stdout.write('\x1b[?25l'); // hide cursor
  const restore = () => { process.stdout.write('\x1b[?25h\n'); process.exit(0); };
  process.on('SIGINT',  restore);
  process.on('SIGTERM', restore);

  // ANSI: move to top-left and clear from cursor to end
  const HOME  = '\x1b[H';
  const ERASE = '\x1b[J';

  // Pre-allocate lines so we can overwrite in place
  let firstRun = true;
  let lastLines = 0;

  while (true) {
    let procs;
    try { procs = await getProcs(); } catch { procs = null; }

    const lines = [];
    lines.push(
      clr(c.bold, 'Open Claude -p Chat') + clr(c.gray, ' — Active Processes') +
      clr(c.gray, `  [${new Date().toLocaleTimeString()}]  Ctrl+C to quit`)
    );
    lines.push('');

    if (!procs) {
      lines.push(clr(c.red, '  Cannot reach server.'));
    } else if (!procs.length) {
      lines.push(clr(c.gray, '  No active processes.'));
    } else {
      const now = Date.now();
      const HEAD = `  ${'ID'.padEnd(5)}  ${'STATUS'.padEnd(9)}  ${'ELAPSED'.padEnd(9)}  PROMPT`;
      lines.push(clr(c.cyan, HEAD));
      lines.push(clr(c.gray, '  ' + '─'.repeat(HEAD.length - 2)));
      for (const p of procs) {
        const elapsed = fmtElapsed(now - p.startMs);
        const prompt  = p.prompt.length > PROMPT_MAX
          ? p.prompt.slice(0, PROMPT_MAX - 1) + '…'
          : p.prompt;
        lines.push(
          '  ' +
          clr(c.yellow, String(p.id).padEnd(5)) + '  ' +
          clr(c.green, 'running'.padEnd(9)) + '  ' +
          clr(c.gray, elapsed.padEnd(9)) + '  ' +
          prompt,
        );
      }
    }

    if (firstRun) {
      process.stdout.write('\x1b[2J\x1b[H'); // clear on first run
      firstRun = false;
    } else {
      // Move up by the number of lines we wrote last time, then erase downward
      process.stdout.write(`\x1b[${lastLines}A${HOME}${ERASE}`);
    }

    process.stdout.write(lines.join('\n') + '\n');
    lastLines = lines.length + 1;

    await new Promise(r => setTimeout(r, 1000));
  }

// ── help / unknown ────────────────────────────────────────────────────────────
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(`
${clr(c.bold, 'ocp-ps')} — process manager for Open Claude -p Chat

${clr(c.cyan, 'USAGE')}
  node ocp-ps.js [command] [options]

${clr(c.cyan, 'COMMANDS')}
  list             Show active processes (default)
  kill <id|all>    Kill process by id, or kill all at once
  watch            Live-refresh list every second

${clr(c.cyan, 'OPTIONS')}
  --port <n>       Server port  (default: 3000 / $OCP_PORT)
  --host <h>       Server host  (default: localhost / $OCP_HOST)

${clr(c.cyan, 'EXAMPLES')}
  node ocp-ps.js
  node ocp-ps.js watch
  node ocp-ps.js kill 3
  node ocp-ps.js kill all
  OCP_PORT=4000 node ocp-ps.js list
`);
} else {
  console.error(clr(c.red, `Unknown command: ${cmd}`));
  console.error(`Run ${clr(c.cyan, 'node ocp-ps.js help')} for usage.`);
  process.exit(1);
}
