// Warm pool of idle PTY sessions.
//
// Key design decisions:
//   - No /clear on release — conversation context is preserved across calls.
//   - Sliding TTL: lastUsedAt is updated on each acquire, not at park time.
//   - acquire() does NOT spawn — it tells the caller what to do:
//       { session, isReuse: true }                → reuse warm session
//       { session: null, resumeSessionId }        → caller must spawn (use resumeSessionId for --resume if set)
//   - release(session, key, sessionId) parks the session with its sessionId so
//     a future respawn can --resume into the same conversation.
//   - initialSessionId: on the very first acquire (empty pool), return this as
//     resumeSessionId so the caller can --resume an earlier conversation.

export class PtyPool {
  /**
   * @param {object} opts
   * @param {number} [opts.maxIdlePerKey=1]
   * @param {number} [opts.maxAgeMs=600000]     sliding idle TTL (10 min default)
   * @param {string|null} [opts.initialSessionId]  resume target for first spawn
   */
  constructor({ maxIdlePerKey = 1, maxAgeMs = 600_000, initialSessionId = null } = {}) {
    this.maxIdlePerKey = maxIdlePerKey;
    this.maxAgeMs = maxAgeMs;
    /** Used once on the first empty-pool acquire, then cleared. */
    this.initialSessionId = initialSessionId;
    /** @type {Map<string, Array<{session, lastUsedAt: number, sessionId: string|null}>>} */
    this.idle = new Map();
    this.closed = false;
  }

  /**
   * Compute a canonical pool key for a request.
   * @param {object} opts
   * @param {string} [opts.cwd]
   * @param {string[]} [opts.spawnArgs]
   * @returns {string}
   */
  static canonicalKey({ cwd, spawnArgs } = {}) {
    return JSON.stringify({
      cwd: cwd ?? '',
      args: Array.isArray(spawnArgs) ? [...spawnArgs] : [],
    });
  }

  /**
   * Try to get a warm session for key.
   *
   * Returns one of:
   *   { session: PtySession, isReuse: true,  resumeSessionId: null }
   *     → warm hit; caller uses this session directly (no spawn needed).
   *   { session: null,       isReuse: false, resumeSessionId: string|null }
   *     → miss; caller must spawn a new PTY.
   *       If resumeSessionId is non-null, caller should pass --resume to the spawn.
   *
   * @param {{ key: string }} opts
   */
  async acquire({ key }) {
    if (this.closed) throw new Error('PtyPool.acquire: pool is closed');
    const list = this.idle.get(key);

    while (list && list.length > 0) {
      const entry = list.pop();
      const age = Date.now() - entry.lastUsedAt;

      if (entry.session.state === 'idle' && age <= this.maxAgeMs) {
        // Warm hit — session is now checked out; do NOT push back into idle.
        // release() will re-add it when the caller is done.
        return { session: entry.session, isReuse: true, resumeSessionId: null };
      }

      // Stale — kill the dead/expired session and bubble up its sessionId
      // so the caller can --resume into the same conversation.
      const staleId = entry.sessionId;
      try { await entry.session.kill(); } catch {}
      return { session: null, isReuse: false, resumeSessionId: staleId };
    }

    // Empty pool — use initialSessionId (if any) so the first spawn can
    // --resume an earlier conversation from a previous daemon run.
    const resumeId = this.initialSessionId;
    this.initialSessionId = null; // consume once
    return { session: null, isReuse: false, resumeSessionId: resumeId };
  }

  /**
   * Park a session for reuse. No /clear is sent — conversation context is
   * intentionally preserved so the next acquire continues the same thread.
   *
   * @param {import('./session.js').PtySession} session
   * @param {string} key
   * @param {string|null} sessionId  the claude session UUID from the last response
   */
  async release(session, key, sessionId = null) {
    if (this.closed || session.state !== 'idle') {
      try { await session.kill(); } catch {}
      return;
    }

    const list = this.idle.get(key) ?? [];

    if (list.length >= this.maxIdlePerKey) {
      try { await session.kill(); } catch {}
      return;
    }

    if (!this.idle.has(key)) this.idle.set(key, list);
    list.push({ session, lastUsedAt: Date.now(), sessionId });
  }

  /** Kill all parked sessions and mark the pool unusable. */
  async close() {
    this.closed = true;
    for (const list of this.idle.values()) {
      for (const { session } of list) {
        try { await session.kill(); } catch {}
      }
    }
    this.idle.clear();
  }

  /** Number of currently parked sessions across all keys. */
  size() {
    let n = 0;
    for (const list of this.idle.values()) n += list.length;
    return n;
  }
}
