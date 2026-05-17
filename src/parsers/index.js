// Barrel re-export for the parsers module.
export {
  registerParser, unregisterParser, listParsers, getParser,
} from './registry.js';
export { ansiStripParser } from './ansi-strip.js';
export { tuiFrameParser, PATTERNS as TUI_PATTERNS } from './tui-frame.js';
export { createSentinelParser } from './sentinel.js';
export { createPipeline } from './pipeline.js';
