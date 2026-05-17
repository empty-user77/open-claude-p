// Pluggable output-adapter registry.
//
// An output adapter takes parsed events (produced by the parsers pipeline)
// and serializes them onto a writable sink. This is what makes
// `--output-format {text|json|stream-json}` work and lets us add new formats
// later (e.g. SSE, msgpack) without touching the driver core.
//
// Adapter shape:
//   {
//     name:    string                       matches `--output-format` value
//     create(opts, sink): AdapterInstance   factory; sink is a Writable
//   }
// AdapterInstance:
//   .onEvent(event): void
//   .end(finalResult): void

/** @type {Map<string, object>} */
const REGISTRY = new Map();

export function registerOutputAdapter(adapter) {
  if (!adapter?.name) throw new Error('registerOutputAdapter: adapter.name is required');
  REGISTRY.set(adapter.name, adapter);
}

export function unregisterOutputAdapter(name) {
  REGISTRY.delete(name);
}

export function listOutputAdapters() {
  return [...REGISTRY.values()];
}

export function getOutputAdapter(name) {
  return REGISTRY.get(name);
}
