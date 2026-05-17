// Parser pipeline runner.
//
// Composes a list of parser definitions into a single pipeline instance.
// Each chunk that enters `feed()` is passed through every parser in order;
// each parser receives the (cleaned) text from the previous stage and may
// emit any number of structured events. The pipeline collects all events
// and returns them along with the final text.
//
// Parser definition contract (each must satisfy):
//   {
//     name: string
//     priority: number
//     create(): { feed(text): { text, events }, reset(): void }
//   }
//
// `priority` is taken into account when sorting; lower priorities run first.

/**
 * @param {Array<object>} parserDefs  parser definitions (NOT instances)
 */
export function createPipeline(parserDefs) {
  const ordered = [...parserDefs].sort(
    (a, b) => (a.priority ?? 100) - (b.priority ?? 100),
  );
  const instances = ordered.map((p) => ({ name: p.name, inst: p.create() }));

  return {
    /**
     * @param {string} chunk
     * @returns {{ text: string, events: Array<object> }}
     */
    feed(chunk) {
      let text = chunk;
      const events = [];
      for (const { name, inst } of instances) {
        const r = inst.feed(text);
        text = r.text ?? text;
        if (r.events?.length) {
          for (const e of r.events) {
            events.push({ ...e, _source: name });
          }
        }
      }
      return { text, events };
    },
    reset() {
      for (const { inst } of instances) inst.reset();
    },
  };
}
