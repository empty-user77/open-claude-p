// Pluggable parser registry.
//
// A "parser" here is a stage that consumes raw PTY chunks and emits
// structured events (assistant text, tool-use indicators, status lines,
// session-id banners, completion sentinels, etc.). Parsers run as an ordered
// pipeline: the output of one becomes the input of the next.
//
// Why a registry? The TUI rendering of the upstream `claude` CLI changes
// across versions. Isolating each parsing concern into a small named module
// keeps version-pinning surgical — when something breaks, we replace or add
// one parser rather than rewriting a monolithic state machine.
//
// A parser is any object with shape:
//   {
//     name:    string                  unique id
//     priority: number                 lower runs earlier (default 100)
//     create(): ParserInstance         factory called once per session
//   }
// A ParserInstance exposes:
//   .feed(chunk: string): ParsedEvent[]
//   .reset(): void

/** @type {Map<string, object>} */
const REGISTRY = new Map();

export function registerParser(parser) {
  if (!parser?.name) throw new Error('registerParser: parser.name is required');
  REGISTRY.set(parser.name, parser);
}

export function unregisterParser(name) {
  REGISTRY.delete(name);
}

export function listParsers() {
  return [...REGISTRY.values()].sort(
    (a, b) => (a.priority ?? 100) - (b.priority ?? 100),
  );
}

export function getParser(name) {
  return REGISTRY.get(name);
}
