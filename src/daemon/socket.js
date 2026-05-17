// Shared utilities: socket path, state file, daemon key.
//
// One daemon per (cwd, claudeBin) pair. Per-request options like --model
// are forwarded in the request body and handled by the pool internally.

import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile, unlink, chmod, stat } from 'node:fs/promises';

export const OCP_DIR = path.join(os.homedir(), '.ocp');

export async function ensureOcpDir() {
  await mkdir(OCP_DIR, { recursive: true, mode: 0o700 });
  // mkdir with `recursive: true` does NOT apply mode to an existing dir,
  // so chmod separately in case it was created earlier with default perms.
  try { await chmod(OCP_DIR, 0o700); } catch {}
  // If the directory exists but is owned by another uid (e.g. a prior
  // sudo invocation), every later write fails silently and ocp keeps
  // falling back to direct mode on every call with no diagnosis. Surface
  // the actual cause once, fast.
  if (process.getuid) {
    try {
      const st = await stat(OCP_DIR);
      if (st.uid !== process.getuid()) {
        throw new Error(
          `~/.ocp is owned by uid ${st.uid}, not ${process.getuid()}. ` +
          `Run \`sudo chown -R $USER ~/.ocp\` (or remove the directory) and retry.`,
        );
      }
    } catch (e) {
      if (e.message?.startsWith('~/.ocp is owned')) throw e;
      // stat ENOENT is impossible right after mkdir; other errors fall through.
    }
  }
}

export function resolveCwd(cwd) {
  const target = cwd ?? process.cwd();
  try { return realpathSync(target); }
  catch { return path.resolve(target); }
}

/** Stable key that identifies a daemon instance. */
export function daemonKey({ cwd, claudeBin } = {}) {
  return JSON.stringify({
    cwd: resolveCwd(cwd),
    claudeBin: claudeBin ?? 'claude',
  });
}

function hashOf(key) {
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
}

/** Unix socket path for a given daemon key. */
export function socketPath(key) {
  return path.join(OCP_DIR, `d-${hashOf(key)}.sock`);
}

/** State file path — written when daemon goes INACTIVE, read on next start. */
export function statePath(key) {
  return path.join(OCP_DIR, `s-${hashOf(key)}.json`);
}

export async function readState(key) {
  try { return JSON.parse(await readFile(statePath(key), 'utf8')); } catch { return null; }
}

export async function writeState(key, state) {
  await ensureOcpDir();
  await writeFile(statePath(key), JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
}

export async function clearState(key) {
  try { await unlink(statePath(key)); } catch {}
}
