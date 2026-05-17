// Barrel re-export for the output module.
export {
  registerOutputAdapter, unregisterOutputAdapter,
  listOutputAdapters, getOutputAdapter,
} from './registry.js';
export { textOutputAdapter } from './text.js';
export { jsonOutputAdapter } from './json.js';
export { streamJsonOutputAdapter, EVENT_BUILDERS } from './stream-json.js';
