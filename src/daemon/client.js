// Daemon client — connects to the running daemon or starts one.
//
// sendToDaemon(sockPath, req, daemonOpts, key):
//   1. Try to connect to an existing daemon (IDLE state).
//   2. If no daemon: read state file for resumeSessionId (INACTIVE state),
//      spawn daemon, wait for ready signal, retry.
//   3. Send request JSON, receive result JSON.

import net from 'node:net';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { OCP_DIR, ensureOcpDir, readState } from './socket.js';

const DEFAULT_MAX_DAEMONS = 30;

const SERVER_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'server.js');

/**
 * @param {string} sockPath
 * @param {object} req        request body forwarded to driver.runOneShot
 * @param {object} daemonOpts options passed to the daemon on first start
 * @param {string} key        daemon key (for state file lookup)
 * @returns {Promise<object>} result from the daemon
 */
export async function sendToDaemon(sockPath, req, daemonOpts, key) {
  await ensureOcpDir();

  // Happy path — daemon already IDLE.
  try {
    return await sendOnSocket(sockPath, req);
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ECONNREFUSED') throw e;
  }

  // No daemon running — check for INACTIVE state (saved sessionId).
  const state = await readState(key);
  const resumeSessionId = state?.sessionId ?? null;

  await startDaemon(sockPath, key, { ...daemonOpts, resumeSessionId });

  return await sendOnSocket(sockPath, req);
}

// ── internals ─────────────────────────────────────────────────────────────

// Cap the response we'll buffer from the daemon. The daemon is same-uid
// trust but a corrupted / malicious / squatting socket could trickle MB
// of bytes without ending and OOM the client. 64 MiB is well above any
// legitimate response (events array + stalledOutputTail + diagnostics)
// while bounding the worst case.
function envPositiveIntLocal(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const MAX_DAEMON_RESPONSE_BYTES = envPositiveIntLocal('OCP_DAEMON_MAX_RESPONSE_BYTES', 64 * 1024 * 1024);

function sendOnSocket(sockPath, req) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath);
    let buf = '';
    let recv = 0;
    let killed = false;

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(JSON.stringify(req));
      socket.end(); // signal end of request (server reads until 'end')
    });
    socket.on('data', (c) => {
      if (killed) return;
      // `setEncoding('utf8')` makes `c` a string of code units, which
      // can be up to 4× lighter than the actual byte cost of multibyte
      // characters. Use Buffer.byteLength so the cap is an honest byte
      // cap, not a code-unit approximation.
      recv += Buffer.byteLength(c, 'utf8');
      if (recv > MAX_DAEMON_RESPONSE_BYTES) {
        killed = true;
        try { socket.destroy(); } catch {}
        const e = new Error(`daemon response exceeded ${MAX_DAEMON_RESPONSE_BYTES} bytes; refusing to buffer further`);
        e.code = 'ERR_DAEMON_RESPONSE_TOO_LARGE';
        reject(e);
        return;
      }
      buf += c;
    });
    socket.on('end', () => {
      if (killed) return;
      try {
        const result = JSON.parse(buf.trim());
        if (result.error) {
          const err = new Error(result.error);
          err.fromDaemon = true;
          reject(err);
        } else {
          resolve(result);
        }
      } catch (e) {
        // A same-uid peer squatting on the socket path can write any
        // bytes including C0/C1/DEL/ANSI sequences; JSON.parse's error
        // message quotes a snippet of that buffer, which would land in
        // the user's terminal via the CLI's stderr printer and could
        // re-emit cursor moves or BEL. Scrub before embedding.
        const rawMsg = e?.message ?? String(e);
        const safeMsg = String(rawMsg).replace(/[\x00-\x1f\x7f\x80-\x9f]/g, '?').slice(0, 512);
        reject(new Error(`daemon response parse failed: ${safeMsg}`));
      }
    });
    socket.on('error', reject);
  });
}

async function countRunningDaemons() {
  try {
    const files = await readdir(OCP_DIR);
    return files.filter((f) => f.startsWith('d-') && f.endsWith('.sock')).length;
  } catch {
    return 0;
  }
}

async function startDaemon(sockPath, key, daemonOpts) {
  // Number(env) → NaN for non-numeric input ("abc", "") and the
  // `running >= NaN` check silently disables the cap. Coerce via the
  // same positive-int helper used elsewhere so garbage values fall
  // back to DEFAULT_MAX_DAEMONS instead of unbounded growth.
  const rawLimit = process.env.OCP_MAX_DAEMONS;
  const parsed = Number(rawLimit);
  const limit = (Number.isFinite(parsed) && parsed > 0) ? Math.floor(parsed) : DEFAULT_MAX_DAEMONS;
  const running = await countRunningDaemons();
  if (running >= limit) {
    throw new Error(
      `terminal limit reached: ${running}/${limit} sessions are active or idle.\n` +
      `Stop unused sessions or raise the limit with OCP_MAX_DAEMONS=<n>.`,
    );
  }

  const child = spawn(
    process.execPath,
    [SERVER_JS, sockPath, key, JSON.stringify(daemonOpts)],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('daemon start timeout (10s)')),
      10_000,
    );
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      buf += c;
      if (buf.includes('ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timer);
        reject(new Error(`daemon exited early (code ${code})`));
      }
    });
  });

  child.unref(); // let daemon outlive this process
}
