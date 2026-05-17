// Response-completion detector.
//
// Combines three signals to decide when a request's response is finished:
//
//   1. Sentinel match (gated). A sentinel event with the request's nonce
//      counts only if `assistant-region-entered` has already fired,
//      ignoring the pre-response echo of the prompt input (see §7.1).
//      After a sentinel match we still wait `idleMs` for any trailing
//      output before declaring completion.
//
//   2. Idle silence. If at least one assistant-text event has fired and
//      `idleMs` elapses without further events, complete with reason
//      'idle' (defensive fallback when the sentinel is dropped).
//
//   3. Hard timeout. Always completes after `maxResponseMs` to bound
//      worst-case wait.
//
// `cancel()` short-circuits to completion with `reason='cancelled'`,
// `isError=true`.
//
// Completion is reported by the promise returned from `done()`.

export class CompletionDetector {
  /**
   * @param {object} opts
   * @param {string} opts.nonce             per-request sentinel nonce
   * @param {number} [opts.idleMs=1500]     idle silence after a sentinel
   *                                        match, before declaring done
   * @param {number} [opts.preIdleMs=8000]  idle silence BEFORE sentinel,
   *                                        used as a defensive fallback
   *                                        when the model drops the marker.
   * @param {number} [opts.maxResponseMs=60000]
   * @param {number} [opts.maxTurns]        max number of assistant turns
   *                                        before the request is aborted
   *                                        (shim-enforced `--max-turns`).
   *                                        Each `⏺` region counts as one
   *                                        turn; when the (N+1)th turn
   *                                        opens, the request is aborted
   *                                        with reason 'max-turns'.
   */
  constructor({
    nonce,
    idleMs = 1500,
    preIdleMs = 8000,
    maxResponseMs = 60000,
    maxTurns,
  } = {}) {
    if (!nonce) throw new Error('CompletionDetector: nonce is required');
    this.nonce = nonce;
    this.idleMs = idleMs;
    this.preIdleMs = preIdleMs;
    this.maxResponseMs = maxResponseMs;
    this.maxTurns = Number.isFinite(maxTurns) && maxTurns >= 0 ? maxTurns : null;

    this.startTime = Date.now();
    this.regionEntered = false;
    this.hadAssistantText = false;
    this.sentinelMatched = false;
    this.turnsEntered = 0;
    this.lastEventTime = this.startTime;

    this.completion = null;
    this._resolve = null;
    this._promise = new Promise((r) => { this._resolve = r; });

    this._tick = setInterval(() => this._onTick(), 100);
    this._hardTimeout = setTimeout(
      () => this._complete('timeout', true),
      this.maxResponseMs,
    );
  }

  /**
   * Mark generic activity (e.g. a raw PTY data chunk that produced no
   * events). Without this, a slow-streaming response that emits no
   * intermediate events between `assistant-region-entered` and `sentinel`
   * can trip the idle fallback prematurely — for example when the upstream
   * CLI is rendering long conversation history during a `--resume`.
   */
  markActivity() {
    if (this.completion) return;
    this.lastEventTime = Date.now();
  }

  /** Feed a parsed event into the detector. */
  onEvent(e) {
    if (this.completion) return;
    this.lastEventTime = Date.now();

    if (e.type === 'assistant-region-entered') {
      this.regionEntered = true;
      this.hadAssistantText = true;
      this.turnsEntered += 1;
      if (this.maxTurns !== null && this.turnsEntered > this.maxTurns) {
        this._complete('max-turns', true);
      }
      return;
    }

    if (
      e.type === 'sentinel' &&
      e.nonce === this.nonce &&
      this.regionEntered
    ) {
      // Any post-region sentinel match counts. We do NOT complete here
      // because, in `--resume` workflows, both the prompt-echo and the
      // model's real response can carry the same nonce. Instead we just
      // flip sentinelMatched and let the tick-based idle window decide:
      // completion fires only after `idleMs` of true silence — which means
      // all subsequent sentinels (including any later "real" one) have
      // already arrived. The text extractor then uses the LAST sentinel
      // occurrence in the buffer to find the response.
      this.sentinelMatched = true;
    }
  }

  /**
   * Cancel from the outside (AbortSignal, SIGINT, upstream exit, …).
   * @param {string} [reason='cancelled']
   */
  cancel(reason = 'cancelled') {
    this._complete(reason, true);
  }

  /** Resolves once a completion decision has been reached. */
  done() {
    return this._promise;
  }

  // ── internal ─────────────────────────────────────────────────────────
  _onTick() {
    if (this.completion) return;
    const idleFor = Date.now() - this.lastEventTime;
    if (this.sentinelMatched) {
      // Once we've seen at least one post-region sentinel, complete after
      // `idleMs` of true silence (any chunk resets via markActivity()).
      if (idleFor >= this.idleMs) {
        this._complete('sentinel', false);
      }
      return;
    }
    // Pre-sentinel fallback: only valid once we've seen any assistant
    // signal, with the longer `preIdleMs` threshold so that brief render
    // pauses (common during `--resume`) do not trip premature completion.
    if (this.hadAssistantText) {
      if (idleFor >= this.preIdleMs) {
        this._complete('idle', false);
      }
    }
  }

  _complete(reason, isError) {
    if (this.completion) return;
    this.completion = { reason, isError };
    clearInterval(this._tick);
    clearTimeout(this._hardTimeout);
    this._resolve({
      reason,
      isError,
      durationMs: Date.now() - this.startTime,
    });
  }
}
