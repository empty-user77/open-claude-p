#!/usr/bin/env node
//
// Postinstall fixup for node-pty prebuilds.
//
// npm sometimes drops the execute bit on prebuilt helper binaries during tar
// extraction. node-pty ships a `spawn-helper` per (platform, arch) that MUST
// be executable; without the +x bit every `posix_spawnp` call fails on macOS
// with the unhelpful message "posix_spawnp failed.".
//
// This script restores the execute bit for whichever prebuild matches the
// current platform/arch. It is a no-op everywhere else.
//
// Safe to run repeatedly; safe to fail (e.g. when node-pty is not installed
// yet in some lifecycle ordering).

import { chmod, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

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
  process.exit(0);
}
