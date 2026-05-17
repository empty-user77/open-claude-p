// `--output-format stream-json` adapter.
//
// Emits newline-delimited JSON events matching the upstream Claude Code
// stream-json schema. The full message-type catalogue is intentionally
// kept extensible via EVENT_BUILDERS so new SDK event types can be added
// without touching the adapter core.
//
// Three events are synthesized at end-of-session:
//   1) { type:'system', subtype:'init', session_id, … }
//   2) { type:'assistant', session_id, message:{content:[{type:'text',text}]} }
//   3) { type:'result',   subtype:'success'|'error', session_id, … }
// The init event is emitted as soon as a session id has been observed.
// Per-line streaming of assistant deltas is also emitted via the
// `assistant-partial` events; consumers accumulate them to reconstruct
// the response incrementally before the final consolidated event.
//
// EVENT_BUILDERS lets consumers extend the upstream-event surface by
// registering a builder for a new internal event type:
//
//   import { EVENT_BUILDERS } from 'open-claude-p/output';
//   EVENT_BUILDERS['my-internal-event'] = (e) => ({
//     type: 'my-upstream-event', session_id: e.session_id, payload: e,
//   });

/** @type {Record<string, (event: object, ctx: { sessionId: string|null }) => object|null>} */
export const EVENT_BUILDERS = {
  // Stream each assistant text line as it arrives. Consumers accumulate
  // `delta` fields per session to reconstruct the response incrementally;
  // the final `end()` still emits one consolidated `assistant` event so
  // the contract is forward-compatible.
  'assistant-text': (e, ctx) => ({
    type: 'assistant-partial',
    session_id: ctx.sessionId,
    delta: e.text,
    region: e.region,
  }),
  // Internal events with no upstream equivalent today.
  'assistant-region-entered': () => null,
  'assistant-region-exited': () => null,
  'prompt-box-shown': () => null,
  'sentinel': () => null,
  'spinner': () => null,
};

function emit(sink, obj) {
  sink.write(JSON.stringify(obj) + '\n');
}

export const streamJsonOutputAdapter = {
  name: 'stream-json',
  /**
   * @param {object} _opts
   * @param {{ write: (s: string) => void }} sink
   */
  create(_opts, sink) {
    let sessionId = null;
    let initEmitted = false;

    function maybeEmitInit() {
      if (initEmitted) return;
      initEmitted = true;
      emit(sink, {
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
      });
    }

    return {
      onEvent(event) {
        if (event.type === 'session-id' && event.id) {
          sessionId = event.id;
          maybeEmitInit();
          return;
        }
        const builder = EVENT_BUILDERS[event.type];
        if (builder) {
          const obj = builder(event, { sessionId });
          if (obj) emit(sink, obj);
        }
      },
      end(finalResult) {
        // Make sure the consumer always sees an init line, even if no
        // session id was captured (e.g. upstream exited before printing
        // its banner). The session id is reported once we have it.
        sessionId = sessionId ?? finalResult?.sessionId ?? null;
        maybeEmitInit();

        if (finalResult?.text) {
          emit(sink, {
            type: 'assistant',
            session_id: sessionId,
            message: {
              content: [{ type: 'text', text: finalResult.text }],
            },
          });
        }

        emit(sink, {
          type: 'result',
          subtype: finalResult?.isError ? 'error' : 'success',
          session_id: sessionId,
          total_cost_usd: finalResult?.cost?.totalUsd ?? null,
          num_turns: finalResult?.cost?.numTurns ?? null,
          duration_ms: finalResult?.durationMs ?? null,
          completion: finalResult?.completionReason ?? null,
        });
      },
    };
  },
};
