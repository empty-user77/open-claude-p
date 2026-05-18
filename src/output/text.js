// `--output-format text` adapter.
//
// Two behaviors depending on the sink:
//
//   - **TTY (terminal)**: live progress UI. Spinner labels render on a
//     single stderr line that overwrites itself; assistant text streams
//     to stdout as it arrives. Gives interactive use the same "looks
//     busy" feedback the sample chat UI shows in the browser.
//
//   - **Pipe / file** (`ocp "…" > out.txt`, `ocp "…" | jq`): no live
//     output. We accumulate the response and emit it once at end() so
//     scripts get a clean blob with no carriage-return artefacts.
//
// The live path can be force-disabled via OCP_NO_LIVE=1 (useful for
// debugging when --debug output competes with the spinner line).

import { cleanSpinnerLabel } from '../chat/event-filters.js';

const SENTINEL_REGEX = /⟦OCP_END:[a-f0-9]+⟧/g;

/**
 * Completion reasons that mean we never got a real assistant response.
 * The accumulated `text` for these is PTY-extracted noise (welcome
 * banner, status line, prompt back-echo) and writing it to stdout makes
 * the consumer pipeline display garbage — or the user's own prompt —
 * as the model's reply.
 */
const ABORT_REASONS = new Set([
  'timeout',
  'interactive-required',
  'trust-required',
  'cancelled',
  'write-failed',
  'upstream-exited',
]);

export const textOutputAdapter = {
  name: 'text',
  /**
   * @param {object} _opts
   * @param {{ write: (s: string) => void, isTTY?: boolean }} sink
   */
  create(_opts, sink) {
    const liveStdout = !!sink.isTTY;
    const liveStderr = !!process.stderr.isTTY;
    const live = liveStdout && liveStderr && process.env.OCP_NO_LIVE !== '1';

    let spinnerActive = false;
    let lastSpinnerLabel = '';

    // Default progress label shown from spawn until claude's own
    // spinner / response arrives. Without this, the user sees a silent
    // terminal during the 2-15 s window of warmup + hook/MCP loading +
    // first-byte latency.
    let phaseLabel = 'Starting…';

    function clearSpinner() {
      if (!spinnerActive) return;
      // CR + clear-to-end-of-line. Cheap and works in every modern terminal.
      process.stderr.write('\r\x1b[2K');
      spinnerActive = false;
    }

    function writeSpinner(label) {
      if (!live) return;
      if (label === lastSpinnerLabel && spinnerActive) return;
      process.stderr.write(`\r\x1b[2K\x1b[90m⋯ ${label}\x1b[0m`);
      spinnerActive = true;
      lastSpinnerLabel = label;
    }

    // Kick the spinner immediately so the user gets feedback that
    // ocp is alive, even during warmup before claude itself draws
    // anything we can recognise as activity.
    if (live) writeSpinner(phaseLabel);

    return {
      onEvent(event) {
        if (!live) return; // pipe mode: silent until end()
        // We intentionally do NOT stream per-event `assistant-text` to
        // stdout. The PTY-stripped chunks are interleaved with TUI
        // chrome (statusline, HUD plugins, box borders, mode
        // indicators) that this adapter cannot reliably scrub at
        // single-line granularity. Instead we drive a phase spinner
        // here and emit a single clean blob in `end()` once the driver
        // has done region-based extraction.
        if (event?.type === 'prompt-box-shown') {
          phaseLabel = 'Sending prompt…';
          writeSpinner(phaseLabel);
        } else if (event?.type === 'spinner') {
          const label = cleanSpinnerLabel(event.label);
          if (label) writeSpinner(label);
        } else if (event?.type === 'assistant-region-entered') {
          phaseLabel = 'Receiving…';
          writeSpinner(phaseLabel);
        }
      },

      /**
       * @param {{ text: string, isError: boolean, completionReason?: string }} finalResult
       */
      end(finalResult) {
        clearSpinner();
        // On aborts, stdout stays empty — the CLI's stderr error message
        // is the user-facing signal. Emitting accumulated text here is
        // worse than useless: it puts PTY chrome into a pipe that the
        // caller is parsing as the assistant's reply.
        if (ABORT_REASONS.has(finalResult?.completionReason)) return;
        const text = (finalResult?.text ?? '').replace(SENTINEL_REGEX, '');
        sink.write(text);
        if (!text.endsWith('\n')) sink.write('\n');
      },
    };
  },
};
