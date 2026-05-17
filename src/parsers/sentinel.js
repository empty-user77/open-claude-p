// Sentinel matcher — emits a `sentinel` event for every occurrence of the
// expected marker string in the (already ANSI-stripped) text stream.
//
// We emit EVERY occurrence rather than only the first because the upstream
// CLI typically echoes the user prompt into its input box, producing a
// pre-response occurrence of the literal sentinel. The completion detector
// is responsible for the policy choice of which occurrence to act on.

/**
 * @param {string} nonce  unique hex token bound to a single request
 */
export function createSentinelParser(nonce) {
  const sentinel = `⟦OCP_END:${nonce}⟧`;
  return {
    name: 'sentinel',
    priority: 90,
    create() {
      // Buffer concatenates incoming text so a sentinel split across two
      // chunks still matches. `nextScanFrom` advances past each match so we
      // don't re-emit the same one.
      let buffer = '';
      let nextScanFrom = 0;
      return {
        feed(text) {
          buffer += text;
          const events = [];
          let idx;
          while ((idx = buffer.indexOf(sentinel, nextScanFrom)) !== -1) {
            events.push({ type: 'sentinel', nonce, at: idx });
            nextScanFrom = idx + sentinel.length;
          }
          return { text, events };
        },
        reset() {
          buffer = '';
          nextScanFrom = 0;
        },
      };
    },
  };
}
