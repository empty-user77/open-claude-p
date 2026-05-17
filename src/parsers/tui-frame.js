// TUI frame parser.
//
// A line-oriented state machine that classifies upstream TUI output into
// structured events. The line model is approximate: we DO NOT run a real
// terminal emulator, but we do honor the most common TTY redraw idiom —
// a bare carriage return (`\r`) returns the cursor to column 0 and any
// subsequent characters on the same logical line overwrite what was
// there. We model this by splitting each `\n`-terminated segment on `\r`
// and keeping only the last subsegment (i.e. what survives all redraws).
//
// Events emitted:
//
//   { type: 'assistant-region-entered', n }      a `⏺` opened the region
//   { type: 'assistant-region-exited',  n }      a horizontal rule, the
//                                                request's sentinel, or
//                                                an unrecoverable break
//                                                closed the region
//   { type: 'assistant-text', text, region: n }  one line of response
//   { type: 'session-id', id }                   from "claude --resume <uuid>"
//   { type: 'prompt-box-shown' }                 first `─{3,}` rule
//   { type: 'spinner', label }                   `✻…` thinking/work lines
//
// `region` numbers increment per response area; a `--resume` session that
// re-renders prior history therefore produces region=1..k for old turns
// and a higher number for the new response. The driver filters on the
// MAX region when extracting clean assistant text.
//
// All version-sensitive patterns live in PATTERNS so future drift is a
// localized edit.

export const PATTERNS = {
  assistantRegionMarker: '⏺',
  boxBorder: /^─{3,}/,
  spinnerLeading: /^[✻✶✺✹✸✷✵●✢✳✽·✾✿❀❁❂❃❄❅❆❇❈❉❊❋]/,
  blankLine: /^\s*$/,
  sessionIdBanner:
    /claude\s+--resume\s+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/,
  /** Stripped-form sentinel — nonce-agnostic, used to close the region. */
  sentinel: /⟦OCP_END:[0-9a-fA-F]+⟧/,
  /** The `❯` chevron that marks the start of the input prompt line.
   * Once we see this we know we have reached the input box; everything
   * that follows on subsequent lines is the statusline / HUD plugin
   * area, not response content, and is suppressed from parsing. */
  promptInputChevron: /^[❯›❮‹]/,
};

/**
 * Resolve carriage-return (`\r`) redraws within a single logical line.
 *
 * Real terminal semantics: a bare `\r` returns the cursor to column 0 of
 * the current line, and any subsequent characters overwrite from that
 * position. If the overwrite is shorter than the previous content, the
 * trailing characters of the previous content remain visible. This
 * function simulates that minimal cursor model and returns the final
 * visible content of the line.
 *
 * Examples:
 *   resolveCarriageReturns("xxxxx\ryy")        // "yyxxx"
 *   resolveCarriageReturns("⏺ apple\rstatus")  // "status"   (status fully overwrote)
 *   resolveCarriageReturns("⏺ apple\ra")       // "appale" — kept the tail
 *
 * Strings without any `\r` are returned as-is.
 *
 * @param {string} line
 * @returns {string}
 */
export function resolveCarriageReturns(line) {
  if (line.indexOf('\r') === -1) return line;
  let buf = '';
  let cursor = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\r') {
      cursor = 0;
    } else {
      if (cursor >= buf.length) {
        buf += ch;
      } else {
        buf = buf.slice(0, cursor) + ch + buf.slice(cursor + 1);
      }
      cursor += 1;
    }
  }
  return buf;
}

export const tuiFrameParser = {
  name: 'tui-frame',
  priority: 20,
  create() {
    /** Pending text awaiting a newline. */
    let pending = '';
    let regionActive = false;
    let regionsEntered = 0;
    let promptBoxShownEmitted = false;
    let lastSessionId = null;
    /**
     * Becomes true the moment we see the input chevron (`❯`) line. Every
     * subsequent line is statusline / HUD content (e.g. claude-hud
     * plugin output, context meter, mode indicator) — none of it is
     * response content, so we drop it. Reset only when a new response
     * region begins (`⏺` marker), which is the upstream's signal that
     * the screen scrolled and we're back above the prompt box.
     */
    let belowPromptBox = false;
    /**
     * Tracks the most recent assistant-text emission to dedupe consecutive
     * blank-line emissions. Real paragraph breaks survive (one blank
     * between text); runs of blanks from redraw artifacts collapse to one.
     */
    let lastEmittedBlank = false;

    function closeRegion(events) {
      if (!regionActive) return;
      regionActive = false;
      events.push({ type: 'assistant-region-exited', n: regionsEntered });
    }

    function emitText(events, raw) {
      if (!regionActive) return;
      const isBlank = raw === '' || /^\s*$/.test(raw);
      if (isBlank && lastEmittedBlank) return; // collapse runs of blanks
      lastEmittedBlank = isBlank;
      events.push({
        type: 'assistant-text',
        text: raw,
        region: regionsEntered,
      });
    }

    function processLine(line, events) {
      const trimmedStart = line.trimStart();

      // A new assistant region marker (`⏺`) means the upstream is
      // re-drawing above the prompt box. Whatever statusline/HUD content
      // we were ignoring is now stale — fall back into normal parsing.
      if (trimmedStart.startsWith(PATTERNS.assistantRegionMarker)) {
        belowPromptBox = false;
      }

      // Once we have seen the input chevron, every line below it is
      // statusline / HUD plugin content (claude-hud, mode indicator,
      // context meter, queued-message hints, …). Suppress all parsing
      // until a new assistant region is opened above.
      if (belowPromptBox) return;

      // Session-id banner — accept anywhere in the buffer.
      const sm = line.match(PATTERNS.sessionIdBanner);
      if (sm && sm[1] !== lastSessionId) {
        lastSessionId = sm[1];
        events.push({ type: 'session-id', id: sm[1] });
      }

      // Input chevron (`❯`) marks the prompt input line itself. This is
      // the only reliable "the input box is ready" signal — box borders
      // alone fire too early on the welcome banner's bottom border, so
      // we anchor `prompt-box-shown` to the chevron. The line may
      // legitimately contain queued draft text after the chevron, but
      // it is not response content — drop it and from here on suppress
      // everything until a new response region opens.
      if (PATTERNS.promptInputChevron.test(trimmedStart)) {
        closeRegion(events);
        if (!promptBoxShownEmitted) {
          promptBoxShownEmitted = true;
          events.push({ type: 'prompt-box-shown' });
        }
        belowPromptBox = true;
        return;
      }

      // Box border closes any open assistant region. We do NOT fire
      // `prompt-box-shown` here — the welcome banner and tool-output
      // panels both use box borders, so chevron-based emission above is
      // the authoritative signal.
      if (PATTERNS.boxBorder.test(line.trim())) {
        closeRegion(events);
        return;
      }

      const trimmed = trimmedStart;

      // New assistant region: first character is the response marker.
      if (trimmed.startsWith(PATTERNS.assistantRegionMarker)) {
        regionActive = true;
        regionsEntered += 1;
        events.push({ type: 'assistant-region-entered', n: regionsEntered });
        let after = trimmed.slice(PATTERNS.assistantRegionMarker.length).trimStart();
        // The sentinel may sit on the same line as the marker (e.g.
        // `⏺hello⟦OCP_END:…⟧`); split it out and close the region.
        const sIdx = after.search(PATTERNS.sentinel);
        if (sIdx !== -1) {
          const before = after.slice(0, sIdx).replace(/\s+$/, '');
          if (before) emitText(events, before);
          closeRegion(events);
        } else if (after) {
          emitText(events, after);
        }
        return;
      }

      // Spinner / working status — emit a typed event and otherwise skip.
      if (PATTERNS.spinnerLeading.test(trimmed)) {
        events.push({ type: 'spinner', label: trimmed });
        return;
      }

      if (!regionActive) return; // outside any region — ignore noise

      // Inside an active region: the sentinel closes it.
      const sIdx = line.search(PATTERNS.sentinel);
      if (sIdx !== -1) {
        const before = line.slice(0, sIdx).replace(/\s+$/, '');
        if (before) emitText(events, before);
        closeRegion(events);
        return;
      }

      if (PATTERNS.blankLine.test(line)) {
        emitText(events, ''); // paragraph break
        return;
      }
      emitText(events, line.replace(/\s+$/, ''));
    }

    return {
      feed(text) {
        const events = [];
        pending += text;
        // Split on any of CR / LF / CRLF as a line boundary. Treating
        // bare `\r` as a line ender is essential: many response lines
        // arrive as `…content\r` without a following `\n` (the upstream
        // does in-place updates of the current row), and a parser that
        // waited for `\n` alone would block forever on those rows.
        // Each segment is processed as its own line; consumers
        // (extractAssistantTextFromEvents) pick the highest region.
        const parts = pending.split(/\r\n|\r|\n/);
        pending = parts.pop() ?? '';
        for (const line of parts) {
          processLine(line, events);
        }
        // text is passed through unchanged for downstream parsers (the
        // sentinel parser still scans the raw stream).
        return { text, events };
      },
      reset() {
        pending = '';
        regionActive = false;
        regionsEntered = 0;
        promptBoxShownEmitted = false;
        lastSessionId = null;
        lastEmittedBlank = false;
        belowPromptBox = false;
      },
    };
  },
};
