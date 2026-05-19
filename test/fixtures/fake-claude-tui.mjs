#!/usr/bin/env node
// Minimal claude TUI simulator used by integration tests.
//
// Models just enough of claude's terminal rendering to exercise the
// driver's parsers and completion detector end-to-end:
//
//   - emits an initial banner, a box border, and the `❯` chevron so the
//     driver's `prompt-box-shown` fires and unblocks the write
//   - reads stdin until a carriage return (`\r`), treats everything
//     before it as the submitted prompt
//   - dispatches on the prompt's leading slash command:
//       `/compact`     → spinner activity → "Compacted" → chevron,
//                        with NO `⏺` region and NO sentinel — the
//                        exact "no assistant turn" shape that hung
//                        the driver for 24 h before the fix
//       anything else  → opens an `⏺` region, writes a short reply,
//                        emits the OCP_END sentinel echoed back from
//                        the prompt, and returns to the chevron
//
// Argv from the driver (`--dangerously-skip-permissions`, etc.) is
// silently ignored — this script does not implement any real flag.

import process from 'node:process';

const REGION = '⏺';
const CHEVRON = '❯ \n';

function write(s) {
  process.stdout.write(s);
}

// Initial render. The driver waits for `❯` before submitting the prompt,
// so emit it before reading stdin.
write('Welcome to fake-claude (test fixture)\n');
write('────────────────────────────────────────\n');
write(CHEVRON);

let buf = '';
let busy = false;

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  if (busy) return;
  // Driver writes the prompt + literal `\r` to terminate. node-pty's
  // default `icrnl` flag converts `\r` → `\n` on the slave's stdin, so
  // either may arrive depending on the host. Treat both as submit.
  const submitIdx = (() => {
    const a = buf.indexOf('\n');
    const b = buf.indexOf('\r');
    if (a === -1) return b;
    if (b === -1) return a;
    return Math.min(a, b);
  })();
  if (submitIdx === -1) return;
  const prompt = buf.slice(0, submitIdx);
  buf = buf.slice(submitIdx + 1);
  busy = true;
  dispatch(prompt);
});

process.stdin.on('end', () => process.exit(0));

function dispatch(rawPrompt) {
  const prompt = rawPrompt.trim();

  // /compact: spinner for a short window (compressed from the real
  // ~57s), then "Compacted" stdout, then chevron. No assistant region
  // is ever opened — claude TUI's local command handler runs and
  // returns without invoking the model. This is the "no-response"
  // pattern that the slash-command fix targets.
  if (/^\/compact\b/.test(prompt)) {
    let ticks = 0;
    const t = setInterval(() => {
      write(`✻ Compacting... ${++ticks}\n`);
      if (ticks >= 3) {
        clearInterval(t);
        write('Compacted\n');
        write(CHEVRON);
        busy = false;
      }
    }, 80);
    return;
  }

  // Default: assistant turn. Open a region, write a short reply, echo
  // the OCP_END sentinel back from the prompt (the driver appends it
  // to every non-builtin turn), then return to the chevron.
  const m = /⟦OCP_END:([a-f0-9]+)⟧/.exec(rawPrompt);
  const nonce = m ? m[1] : 'deadbeef00000000';
  setTimeout(() => {
    write(`${REGION} Echo\n`);
    write('hello from fake-claude\n');
    write(`⟦OCP_END:${nonce}⟧\n`);
    write(CHEVRON);
    busy = false;
  }, 40);
}
