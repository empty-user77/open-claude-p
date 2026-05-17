// A single PTY-backed `claude` session.
//
// Wraps `node-pty`'s spawn surface in a small EventEmitter so the driver can
// subscribe to data and exit events without depending on node-pty's typings
// directly. The class is intentionally dumb — it knows nothing about parsers,
// sentinels, or output formats. Higher layers compose those on top.
//
// Lifecycle:
//   new PtySession()  ->  state = 'starting'
//   .spawn({...})     ->  state = 'idle' once node-pty returns the child
//   .write(s)         ->  send raw bytes
//   .kill()           ->  state = 'dead'; resolves when the child exits
//
// State values used so far ('busy', 'resetting') are reserved for the pool
// integration that lands in a later phase.

import { spawn as ptySpawn } from 'node-pty';
import { EventEmitter } from 'node:events';

export class PtySession extends EventEmitter {
  constructor() {
    super();
    this.state = 'starting';
    this.proc = null;
    this.exitInfo = null;
  }

  /**
   * Spawn the upstream binary under node-pty.
   *
   * @param {object} opts
   * @param {string} opts.bin            Path or PATH-resolvable name.
   * @param {string[]} [opts.args]
   * @param {string} [opts.cwd]
   * @param {NodeJS.ProcessEnv} [opts.env]
   * @param {number} [opts.cols]
   * @param {number} [opts.rows]
   */
  async spawn({ bin, args = [], cwd, env, cols = 220, rows = 500 }) {
    if (this.proc) throw new Error('PtySession.spawn: already spawned');
    this.proc = ptySpawn(bin, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd ?? process.cwd(),
      env: env ?? process.env,
    });
    this.proc.onData((chunk) => this.emit('data', chunk));
    this.proc.onExit((info) => {
      this.exitInfo = info;
      this.state = 'dead';
      this.emit('exit', info);
    });
    this.state = 'idle';
  }

  /** Send raw bytes to the PTY. Throws if not spawned or already dead. */
  write(data) {
    if (!this.proc) throw new Error('PtySession.write: not spawned');
    if (this.state === 'dead') throw new Error('PtySession.write: session is dead');
    this.proc.write(data);
  }

  /** Resize the PTY. Safe to call repeatedly. */
  resize(cols, rows) {
    if (!this.proc || this.state === 'dead') return;
    try { this.proc.resize(cols, rows); } catch {}
  }

  /**
   * Kill the underlying process. Resolves when it has exited (or after 1 s
   * if the OS does not deliver the exit event quickly enough).
   */
  async kill() {
    if (!this.proc || this.state === 'dead') return;
    try { this.proc.kill(); } catch {}
    if (this.state !== 'dead') {
      await new Promise((resolve) => {
        const onExit = () => resolve();
        this.once('exit', onExit);
        setTimeout(() => {
          this.off('exit', onExit);
          resolve();
        }, 1000);
      });
    }
  }
}
