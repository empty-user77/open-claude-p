#!/usr/bin/env node
//
// `ocp-sample` — companion CLI that downloads the demo chat-UI app
// (the `sample/` subtree of the open-claude-p repo) into a folder
// chosen by the caller and supervises its lifecycle.
//
// We DO NOT bundle the sample into the published npm tarball: it would
// triple the install size for users who never run it. Instead this
// command does a shallow `git clone` of the repo into a temp dir,
// copies the `sample/` subtree to a user-chosen location, runs
// `npm install` there, and then offers `start`/`stop`/`status`
// helpers that operate from the current working directory.
//
// Designed for npx-first usage:
//   npx -p open-claude-p ocp-sample init demo
//   cd demo && npx -p open-claude-p ocp-sample start
//
// Usage:
//   ocp-sample init [name=ocp-sample]   download into ./<name>/
//   ocp-sample start [--port=N]         start the demo server (cwd)
//   ocp-sample stop                     stop a previously-started server
//   ocp-sample status                   inspect the per-cwd PID file

import { spawn } from 'node:child_process';
import {
  mkdir, rm, readdir, copyFile, stat,
  mkdtemp, readFile, writeFile, unlink, chmod,
} from 'node:fs/promises';
import { open as fsOpen } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

const REPO_URL = 'https://github.com/empty-user77/open-claude-p.git';
const SAMPLE_SUBDIR = 'sample';
const PID_FILE = '.ocp-sample.pid';
const LOG_FILE = '.ocp-sample.log';
const ENTRY_FILE = 'server.js';

// ── presentation helpers ──────────────────────────────────────────────
//
// All ANSI / animation output goes through this layer so it can be
// disabled in three ways:
//   - stderr is not a TTY (piped / redirected)
//   - NO_COLOR=1 or OCP_SAMPLE_NO_TTY=1 in env
//   - terminal too narrow for box-drawing characters

const TTY = !!process.stderr.isTTY
         && process.env.NO_COLOR !== '1'
         && process.env.OCP_SAMPLE_NO_TTY !== '1';

const C = {
  reset:  TTY ? '\x1b[0m'     : '',
  bold:   TTY ? '\x1b[1m'     : '',
  dim:    TTY ? '\x1b[2m'     : '',
  cyan:   TTY ? '\x1b[36m'    : '',
  green:  TTY ? '\x1b[32m'    : '',
  yellow: TTY ? '\x1b[33m'    : '',
  red:    TTY ? '\x1b[31m'    : '',
  magenta:TTY ? '\x1b[35m'    : '',
  blue:   TTY ? '\x1b[34m'    : '',
  grey:   TTY ? '\x1b[90m'    : '',
};

function paint(color, s) { return `${color}${s}${C.reset}`; }

class Spinner {
  constructor(label) {
    this.label = label;
    // Braille dots — universal in modern fonts, no exotic glyphs.
    this.frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    this.i = 0;
    this.timer = null;
    this.lastLen = 0;
  }
  start() {
    if (!TTY) {
      process.stderr.write(`  ${this.label} …\n`);
      return this;
    }
    process.stderr.write('\x1b[?25l'); // hide cursor
    this.render();
    this.timer = setInterval(() => this.render(), 80);
    return this;
  }
  update(label) {
    this.label = label;
    if (!TTY) process.stderr.write(`  ${label} …\n`);
    return this;
  }
  render() {
    if (!TTY) return;
    const frame = this.frames[this.i++ % this.frames.length];
    const line = `  ${paint(C.cyan, frame)} ${this.label}`;
    process.stderr.write(`\r${line}\x1b[K`);
    this.lastLen = line.length;
  }
  finish(symbol, color, msg) {
    this._stopTicker();
    const line = `  ${paint(color, symbol)} ${msg || this.label}`;
    if (TTY) {
      process.stderr.write(`\r${line}\x1b[K\n\x1b[?25h`);
    } else {
      process.stderr.write(`${line}\n`);
    }
  }
  succeed(msg) { this.finish('✓', C.green,  msg); }
  warn(msg)    { this.finish('!', C.yellow, msg); }
  fail(msg)    { this.finish('✗', C.red,    msg); }
  _stopTicker() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

/** Animated dot stream while a long-running child command runs.
 *  Wraps `run` so the child's stdio is piped (not inherited) and we
 *  show a spinner-with-tail-line instead of the child's noisy output.
 *  On failure, dumps the captured output so the user can debug. */
async function spinAround(label, cmd, args, opts = {}) {
  const spinner = new Spinner(label).start();
  let buf = '';
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      const last = lines[lines.length - 2] || '';
      const trimmed = last.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
      if (trimmed) spinner.update(`${label} ${paint(C.grey, '— ' + trimmed.slice(0, 60))}`);
    };
    p.stdout?.on('data', onData);
    p.stderr?.on('data', onData);
    p.on('error', (e) => { spinner.fail(`${label} — ${e.message}`); reject(e); });
    p.on('exit', (code) => {
      if (code === 0) { spinner.succeed(label); resolve(); }
      else {
        spinner.fail(`${label} — exit code ${code}`);
        if (buf) process.stderr.write(paint(C.grey, '  ──── child output ────\n') + buf + '\n');
        reject(new Error(`${cmd} exited with code ${code}`));
      }
    });
  });
}

function intro() {
  if (!TTY) {
    process.stderr.write('open-claude-p sample\n');
    return;
  }
  const lines = [
    '',
    `  ${paint(C.magenta, '◆')} ${paint(C.bold, 'open-claude-p')} ${paint(C.grey, '· sample')}`,
    `  ${paint(C.grey, 'a chat-UI demo over the ocp chat SDK')}`,
    '',
  ];
  process.stderr.write(lines.join('\n'));
}

function banner({ port, pid, logPath, cwd }) {
  const url = `http://localhost:${port}`;
  if (!TTY) {
    process.stderr.write(`\nSample running at ${url} (pid ${pid}). Logs: ${logPath}\n`);
    return;
  }
  const width = 56;
  const top    = '╭' + '─'.repeat(width - 2) + '╮';
  const bottom = '╰' + '─'.repeat(width - 2) + '╯';
  const mid = (left, right = '') => {
    const inner = ` ${left}${right ? '  ' + right : ''}`;
    const visLen = inner.replace(/\x1b\[[0-9;]*m/g, '').length;
    const pad = Math.max(1, width - 2 - visLen);
    return '│' + inner + ' '.repeat(pad) + '│';
  };
  const out = [
    '',
    paint(C.cyan, top),
    paint(C.cyan, '│') + ' ' + paint(C.bold, 'ocp-sample is ready') + ' '.repeat(width - 2 - 1 - 'ocp-sample is ready'.length) + paint(C.cyan, '│'),
    paint(C.cyan, mid('')),
    paint(C.cyan, '│') + ' ' + paint(C.green, '➜') + '  ' + paint(C.bold, url) + ' '.repeat(width - 2 - 1 - 4 - url.length) + paint(C.cyan, '│'),
    paint(C.cyan, '│') + ' ' + paint(C.grey, `pid ${pid}`) + ' '.repeat(width - 2 - 1 - `pid ${pid}`.length) + paint(C.cyan, '│'),
    paint(C.cyan, '│') + ' ' + paint(C.grey, `cwd ${cwd}`).slice(0, width - 4 + 9) + ' '.repeat(Math.max(1, width - 2 - 1 - cwd.length - 4)) + paint(C.cyan, '│'),
    paint(C.cyan, mid('')),
    paint(C.cyan, '│') + ' ' + paint(C.dim, 'stop:   ') + paint(C.bold, 'ocp-sample stop') + ' '.repeat(Math.max(1, width - 2 - 1 - 8 - 'ocp-sample stop'.length)) + paint(C.cyan, '│'),
    paint(C.cyan, '│') + ' ' + paint(C.dim, 'logs:   ') + paint(C.grey, logPath).slice(0, width - 12) + ' '.repeat(Math.max(1, width - 2 - 1 - 8 - Math.min(logPath.length, width - 12))) + paint(C.cyan, '│'),
    paint(C.cyan, bottom),
    '',
  ];
  process.stderr.write(out.join('\n'));
}

// ── core commands ─────────────────────────────────────────────────────

function usage() {
  process.stdout.write(
    'Usage:\n' +
    '  ocp-sample init [name]            Download the demo into ./<name>/\n' +
    '                                    (default name: ocp-sample)\n' +
    '  ocp-sample start [--port=N]       Start the demo server from CWD\n' +
    '  ocp-sample stop                   Stop the demo server in CWD\n' +
    '  ocp-sample status                 Show whether the demo is running\n' +
    '\n' +
    'Environment:\n' +
    '  PORT                  Override the default port (3000) for `start`\n' +
    '  NO_COLOR=1            Disable colours and animations\n' +
    '  OCP_SAMPLE_NO_TTY=1   Same as NO_COLOR=1\n' +
    '  OCP_SAMPLE_REPO       Override the upstream git URL (testing only)\n' +
    '\n' +
    'The demo source lives in the open-claude-p git repo under sample/;\n' +
    'this command shallow-clones the repo into a temp dir and copies the\n' +
    'subtree out so the published npm package stays small.\n',
  );
}

function parseFlag(name, fallback) {
  for (const a of process.argv.slice(3)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m && m[1] === name) return m[2];
    if (a === `--${name}`) return true;
  }
  return fallback;
}

function getRepoUrl() {
  return process.env.OCP_SAMPLE_REPO || REPO_URL;
}

async function copyDir(src, dst) {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else if (entry.isFile()) {
      await copyFile(s, d);
      const st = await stat(s);
      if (st.mode & 0o111) await chmod(d, st.mode & 0o777);
    }
  }
}

async function dirEmptyOrMissing(dir) {
  try {
    const st = await stat(dir);
    if (!st.isDirectory()) return false;
    const entries = await readdir(dir);
    return entries.length === 0;
  } catch (e) {
    return e.code === 'ENOENT';
  }
}

/** Rewrite the sample's repo-relative imports + package.json so it
 *  becomes a standalone project that resolves `open-claude-p` from
 *  npm rather than from `../src/`. The patched files are equivalent
 *  to a hand-edited "extract sample to a standalone repo" — the
 *  sample as shipped in this monorepo uses relative imports because
 *  it runs in-tree during dev. */
/** Read this CLI's own version from the bundled package.json so the
 *  patched sample pins compatible-range against the open-claude-p
 *  version that shipped together with this `ocp-sample` binary. We
 *  never hardcode a version number anywhere else — if this read fails
 *  the install is broken (the package.json is part of every npm
 *  install of open-claude-p, including `npm link`), and we'd rather
 *  surface that explicitly than silently pin a stale fallback. */
async function readOwnPackageVersion() {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const pkgPath = path.resolve(here, '..', 'package.json');
  const raw = await readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);
  if (!pkg.version) {
    throw new Error(`${pkgPath} has no "version" field`);
  }
  return pkg.version;
}

async function patchSampleForStandalone(target) {
  // 1. package.json — add open-claude-p as a runtime dep
  const pkgPath = path.join(target, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  } catch (e) {
    throw new Error(`failed to read ${pkgPath}: ${e.message}`);
  }
  pkg.dependencies = pkg.dependencies || {};
  // Ensure `open-claude-p` resolves from npm. Two cases require us
  // to write the dep:
  //   1) `file:..` — the in-repo dev spec, which only resolves while
  //      the sample lives next to its source. Standalone copies need
  //      a real semver range so npm can pull from the registry.
  //   2) missing — older clones of the sample (pre-1.1) declared no
  //      open-claude-p dep at all and worked via relative imports.
  // We pin `^x.y.0` of this CLI's own version: patch/minor updates
  // are accepted automatically, the next major requires a deliberate
  // bump of the sample. Other hand-edited specs are left alone.
  const currentDep = pkg.dependencies['open-claude-p'];
  if (!currentDep || /^file:/i.test(currentDep)) {
    const v = await readOwnPackageVersion();
    pkg.dependencies['open-claude-p'] = `^${v}`;
  }
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  // 2. server.js (and any other sample source) — rewrite relative
  //    `../src/...` and `../src/chat/index.js` style imports to the
  //    public `open-claude-p/<entry>` subpath exports.
  const candidates = [
    path.join(target, 'server.js'),
    path.join(target, 'ocp-ps.js'),
  ];
  for (const filePath of candidates) {
    let src;
    try { src = await readFile(filePath, 'utf8'); }
    catch { continue; }
    const original = src;
    // Map `../src/chat/index.js` → `open-claude-p/chat`
    //     `../src/index.js`      → `open-claude-p`
    //     `../src/options/index.js` → `open-claude-p/options`
    //     `../src/output/index.js`  → `open-claude-p/output`
    //     `../src/parsers/index.js` → `open-claude-p/parsers`
    //     `../src/pty/index.js`     → `open-claude-p/pty`
    src = src.replace(
      /(['"])\.\.\/src\/(chat|options|output|parsers|pty)\/index\.js\1/g,
      "$1open-claude-p/$2$1",
    );
    src = src.replace(
      /(['"])\.\.\/src\/index\.js\1/g,
      "$1open-claude-p$1",
    );
    if (src !== original) await writeFile(filePath, src);
  }
}

async function init(name) {
  intro();
  const target = path.resolve(process.cwd(), name);
  const rel = path.relative(process.cwd(), target) || '.';

  if (!(await dirEmptyOrMissing(target))) {
    process.stderr.write(
      `  ${paint(C.red, '✗')} ${paint(C.bold, target)} already exists and is not empty.\n` +
      `  ${paint(C.grey, 'Pick a different name (`ocp-sample init my-demo`) or remove the directory first.')}\n`,
    );
    process.exit(1);
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ocp-sample-clone-'));
  try {
    await spinAround(
      `cloning sample from ${paint(C.grey, getRepoUrl())}`,
      'git', ['clone', '--depth=1', '--quiet', getRepoUrl(), tmp],
    );
    const src = path.join(tmp, SAMPLE_SUBDIR);
    try { await stat(src); } catch {
      throw new Error(`expected ${SAMPLE_SUBDIR}/ in the cloned repo but did not find it`);
    }
    const copySpin = new Spinner(`copying sample → ./${rel}`).start();
    await mkdir(target, { recursive: true });
    await copyDir(src, target);
    copySpin.succeed(`copied to ${paint(C.bold, './' + rel)}`);

    // Make the copy standalone: rewrite repo-relative imports and
    // declare `open-claude-p` as a real npm dependency. Without this,
    // `node server.js` fails with `ERR_MODULE_NOT_FOUND` looking for
    // `<target>/../src/chat/index.js`.
    const patchSpin = new Spinner('patching sample for standalone use').start();
    await patchSampleForStandalone(target);
    const ownVer = await readOwnPackageVersion();
    patchSpin.succeed(`standalone — depends on open-claude-p@^${ownVer}`);
  } catch (e) {
    if (e?.code === 'ENOENT' && /git/i.test(e.path || '')) {
      process.stderr.write(
        `\n  ${paint(C.red, '✗')} ${paint(C.bold, '`git` not found in PATH.')}\n` +
        `  ${paint(C.grey, 'Install git, or download manually from:')}\n` +
        `  ${paint(C.cyan, getRepoUrl().replace(/\.git$/, ''))}\n`,
      );
      process.exit(1);
    }
    throw e;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  await spinAround(
    'installing dependencies',
    'npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: target },
  );

  // Always attempt `npm link open-claude-p` after install. If a
  // global link exists (developer testing a pre-publish version, or
  // anyone who ran `npm link` from a local clone), the link wins —
  // it overwrites the registry copy with a symlink to the dev tree.
  // If no global link exists, npm exits non-zero and we silently
  // keep whatever the registry install produced. Either way the
  // demo ends up with a working `open-claude-p`.
  try {
    await runQuiet('npm', ['link', 'open-claude-p', '--loglevel=error'], { cwd: target });
  } catch { /* no global link to override the registry install — fine */ }

  if (!(await canResolveFromTarget(target, 'open-claude-p'))) {
    process.stderr.write(
      `\n  ${paint(C.red, '✗')} open-claude-p is not resolvable from ${paint(C.bold, target)}.\n` +
      `    The registry could not satisfy the version pinned in package.json,\n` +
      `    and no global ${paint(C.bold, 'npm link')} target was found either.\n` +
      `    Run ${paint(C.bold, 'npm link open-claude-p')} from the open-claude-p source\n` +
      `    directory, then re-run ${paint(C.bold, 'ocp-sample init')}.\n\n`,
    );
    process.exit(1);
  }

  process.stderr.write(
    '\n' +
    `  ${paint(C.green, '✓ ready')}\n` +
    `\n  next:\n` +
    `    ${paint(C.bold, `cd ${rel}`)}\n` +
    `    ${paint(C.bold, 'ocp-sample start')}\n\n`,
  );
}

/** True iff `require.resolve(pkg)` works from inside `cwd`. We spawn
 *  a child node so we honour the target's actual node_modules layout
 *  (resolution from THIS file would look at THIS package's
 *  node_modules and miss the install we just performed). */
async function canResolveFromTarget(cwd, pkg) {
  return new Promise((resolve) => {
    const code = `try {
      require.resolve(${JSON.stringify(pkg)});
      process.exit(0);
    } catch { process.exit(1); }`;
    const p = spawn(process.execPath, ['-e', code], {
      cwd,
      stdio: 'ignore',
    });
    p.on('exit', (c) => resolve(c === 0));
    p.on('error', () => resolve(false));
  });
}

/** Like `spinAround` but no spinner and no progress lines — used when
 *  the caller wants `npm <cmd>` to run quietly and only cares about
 *  the exit code. */
function runQuiet(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore', ...opts });
    p.on('error', reject);
    p.on('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`${cmd} exited with code ${code}`)));
  });
}

async function readPid(cwd) {
  try {
    const raw = await readFile(path.join(cwd, PID_FILE), 'utf8');
    const pid = Number(raw.trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function start() {
  intro();
  const cwd = process.cwd();
  const entry = path.join(cwd, ENTRY_FILE);
  try { await stat(entry); } catch {
    process.stderr.write(
      `  ${paint(C.red, '✗')} no ${paint(C.bold, ENTRY_FILE)} in ${paint(C.bold, cwd)}.\n` +
      `  ${paint(C.grey, 'Run `ocp-sample init` first, then `cd` into the created directory.')}\n`,
    );
    process.exit(1);
  }

  const existingPid = await readPid(cwd);
  if (existingPid && isAlive(existingPid)) {
    process.stderr.write(
      `  ${paint(C.yellow, '!')} already running (pid ${paint(C.bold, existingPid)}). ` +
      `Stop it first with ${paint(C.bold, '`ocp-sample stop`')}.\n`,
    );
    process.exit(1);
  }
  if (existingPid && !isAlive(existingPid)) {
    await unlink(path.join(cwd, PID_FILE)).catch(() => {});
  }

  const port = parseFlag('port', process.env.PORT || '3000');
  const logPath = path.join(cwd, LOG_FILE);

  const bootSpin = new Spinner(`starting demo on port ${port}`).start();
  const logFh = await fsOpen(logPath, 'a');
  const env = { ...process.env, PORT: String(port) };
  const proc = spawn(process.execPath, [ENTRY_FILE], {
    cwd,
    detached: true,
    stdio: ['ignore', logFh.fd, logFh.fd],
    env,
  });
  await writeFile(path.join(cwd, PID_FILE), String(proc.pid));
  await logFh.close();
  proc.unref();

  // Short health window: a typo / port conflict will surface fast.
  await new Promise((r) => setTimeout(r, 700));
  if (!isAlive(proc.pid)) {
    bootSpin.fail('server exited immediately');
    await unlink(path.join(cwd, PID_FILE)).catch(() => {});
    let tail = '';
    try { tail = (await readFile(logPath, 'utf8')).split('\n').slice(-12).join('\n'); } catch {}
    if (tail) {
      process.stderr.write(`\n${paint(C.grey, '──── last log lines ────')}\n${tail}\n`);
    }
    process.exit(1);
  }
  bootSpin.succeed(`pid ${proc.pid}`);

  banner({ port, pid: proc.pid, logPath, cwd });
}

async function stop() {
  intro();
  const cwd = process.cwd();
  const pid = await readPid(cwd);
  if (!pid) {
    process.stderr.write(`  ${paint(C.grey, 'no PID file in')} ${paint(C.bold, cwd)} ${paint(C.grey, '— nothing to stop.')}\n`);
    process.exit(1);
  }
  if (!isAlive(pid)) {
    await unlink(path.join(cwd, PID_FILE)).catch(() => {});
    process.stderr.write(`  ${paint(C.green, '✓')} cleaned up stale PID ${paint(C.bold, pid)}\n`);
    return;
  }
  const spin = new Spinner(`stopping pid ${pid}`).start();
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 50; i++) {
    if (!isAlive(pid)) {
      await unlink(path.join(cwd, PID_FILE)).catch(() => {});
      spin.succeed(`stopped (pid ${pid})`);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
  await unlink(path.join(cwd, PID_FILE)).catch(() => {});
  spin.warn(`force-killed (pid ${pid}) — server did not respond to SIGTERM within 5 s`);
}

async function status() {
  const cwd = process.cwd();
  const pid = await readPid(cwd);
  if (!pid) {
    process.stdout.write(`${paint(C.grey, '○')} stopped\n`);
    return;
  }
  if (isAlive(pid)) {
    const port = process.env.PORT || 3000;
    process.stdout.write(
      `${paint(C.green, '●')} running   ` +
      `${paint(C.grey, 'pid=')}${pid}  ` +
      `${paint(C.cyan, `http://localhost:${port}`)}\n` +
      `  ${paint(C.grey, 'logs:')} ${path.join(cwd, LOG_FILE)}\n`,
    );
  } else {
    process.stdout.write(
      `${paint(C.yellow, '○')} stopped   ` +
      `${paint(C.grey, '(stale PID')} ${pid}${paint(C.grey, ' — run `ocp-sample stop` to clean up)')}\n`,
    );
  }
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'init':   await init(process.argv[3] || 'ocp-sample'); break;
    case 'start':  await start(); break;
    case 'stop':   await stop(); break;
    case 'status': await status(); break;
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    default:
      if (cmd) process.stderr.write(`ocp-sample: unknown subcommand: ${cmd}\n\n`);
      usage();
      process.exit(cmd ? 2 : 0);
  }
}

// Restore the terminal cursor if the user interrupts mid-spinner.
process.on('SIGINT', () => {
  if (TTY) process.stderr.write('\x1b[?25h\n');
  process.exit(130);
});

main().catch((e) => {
  if (TTY) process.stderr.write('\x1b[?25h');
  process.stderr.write(`\n  ${paint(C.red, '✗')} ${e?.message || e}\n`);
  process.exit(1);
});
