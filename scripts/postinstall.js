#!/usr/bin/env node
//
// Postinstall fixup for two macOS-and-friends gotchas:
//
//   1. node-pty prebuild execute bit. npm sometimes drops +x on the
//      `spawn-helper` binary during tar extraction; without it every
//      `posix_spawnp` call fails with "posix_spawnp failed.".
//
//   2. Shebang line in `bin/cli.js`. The shipped file uses
//      `#!/usr/bin/env node`, which fails the moment ocp is spawned
//      from a process that does not inherit the user's shell PATH —
//      the canonical case is a macOS GUI app (Electron / Tauri / native
//      Cocoa) that gets launchd's default `/usr/bin:/bin:/usr/sbin:/sbin`
//      with no nvm/homebrew/asdf bin dir, so `env: node: No such file
//      or directory` aborts before our code runs. We rewrite the
//      shebang to `process.execPath` — the absolute path of the node
//      binary that did the install — so GUI launches keep working.
//
// Safe to run repeatedly; safe to fail (e.g. when node-pty is not installed
// yet in some lifecycle ordering).

import { chmod, lstat, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Resolve via `require.resolve` against THIS script's location, not
// process.cwd(). The npm-install case happens to use cwd = package
// root and the relative path worked accidentally, but manual
// invocation from another cwd would have chmod'd the wrong tree (or
// nothing). With require.resolve the path is always the node-pty
// actually loaded by our package.
let nodePtyRoot;
try {
  const req = createRequire(import.meta.url);
  nodePtyRoot = path.dirname(req.resolve('node-pty/package.json'));
} catch {
  // node-pty not installed yet (lifecycle ordering) — exit silently.
  process.exit(0);
}

const targets = [
  path.join(nodePtyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
];

let fixedAny = false;
for (const full of targets) {
  try {
    const st = await lstat(full);
    // Refuse to follow symlinks: a malicious package preinstall hook could
    // replace the prebuild path with a symlink to a sensitive binary and
    // gain mode 0755 on it. lstat + bail keeps us on a regular file.
    if (st.isSymbolicLink() || !st.isFile()) continue;
    await chmod(full, 0o755);
    process.stdout.write(`postinstall: chmod 0755 ${path.relative(process.cwd(), full) || full}\n`);
    fixedAny = true;
  } catch {
    // file not present for this (platform, arch) — fine, skip silently
  }
}

if (!fixedAny) {
  // Quiet success: in some environments (Windows, or pruned installs) none of
  // the targets exist; that is not an error.
}

// ── Shebang fixup for GUI-app launches ──────────────────────────────────
// Resolve `bin/cli.js` relative to this script's location, then rewrite
// the first line from `#!/usr/bin/env node` to `#!<absolute path to
// node>`. The absolute path comes from `process.execPath`, i.e. the
// node binary that is running this very postinstall — so whichever
// node was used for `npm install -g open-claude-p` is the one that
// will run the CLI later. This is the standard fix for CLIs that need
// to be invokable from launchd-managed GUI apps on macOS without the
// user's shell PATH.
//
// Skipped on Windows: the npm-cmd shim handles node resolution there
// and the file extension makes shebang lines a no-op.
if (process.platform !== 'win32') {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..');
  // Skip the shebang rewrite when this install is a git checkout
  // (dev environment via `git clone + npm link`, or a contributor
  // running `npm install` inside the repo). The rewrite would
  // otherwise overwrite the portable `#!/usr/bin/env node` with the
  // developer's absolute node path, which then shows up as a noisy
  // working-tree diff on every commit and risks getting committed
  // by mistake. Consumers installing from the npm tarball never
  // have a `.git/` so they still get the GUI-launch fix.
  try {
    const st = await lstat(path.join(repoRoot, '.git'));
    if (st.isDirectory() || st.isFile()) {
      process.stdout.write('postinstall: detected git checkout — skipping shebang rewrite\n');
      process.exit(0);
    }
  } catch { /* no .git/ — npm-tarball install, proceed */ }

  // Every shipped bin entry needs the same shebang treatment. List them
  // here rather than re-reading package.json (the file may be pruned
  // from production installs and the bin field is small enough to
  // mirror inline).
  const binFiles = [
    path.resolve(here, '..', 'bin', 'cli.js'),
    path.resolve(here, '..', 'bin', 'ocp-sample.js'),
  ];
  const wantedLine = `#!${process.execPath}`;
  for (const binPath of binFiles) {
    try {
      const original = await readFile(binPath, 'utf8');
      const firstNl = original.indexOf('\n');
      if (firstNl <= 0) continue;
      const currentShebang = original.slice(0, firstNl);
      if (!currentShebang.startsWith('#!') || currentShebang === wantedLine) continue;
      const patched = wantedLine + original.slice(firstNl);
      // chmod restores +x in case the rewrite normalised mode bits.
      await writeFile(binPath, patched);
      await chmod(binPath, 0o755);
      process.stdout.write(`postinstall: rewrote shebang in ${binPath} -> ${wantedLine}\n`);
    } catch (e) {
      // Non-fatal: a CLI launched from a shell with node in PATH still
      // works with the original `#!/usr/bin/env node`. Only the GUI-app
      // case regresses, which is the pre-1.1 behaviour.
      process.stdout.write(`postinstall: shebang fixup skipped for ${binPath} (${e?.code || e?.message || e})\n`);
    }
  }
}
