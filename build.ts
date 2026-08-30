#!/usr/bin/env bun
// build.ts — bundles wtft and wtft-daemon CLIs to bin/*.mjs for npm publish

// ---
// WHY NOTHING IS `external` (#36)
//
// These two files are the WHOLE published artifact: `files` in package.json
// ships `bin/*.mjs` and nothing else. Anything left external is therefore a
// bare import that survives into the emitted ESM, and node resolves those by
// walking up from the FILE — so the artifact only runs from a directory that
// happens to have the dependency in an ancestor `node_modules`.
//
// The `@princess-pi/libs` extraction added it to `external` and made the
// artifact non-relocatable: `cp bin/wtft.mjs /tmp/x && node /tmp/x/wtft.mjs`
// died with ERR_MODULE_NOT_FOUND. That also broke a test which relies on the
// relocatability rather than testing it — wtft-308 §6 copies wtft.mjs to a
// directory with no wtft-daemon.mjs beside it to inject a daemon that dies
// during startup STRUCTURALLY instead of by timing, and the copy started dying
// of the module error instead, so the assertion could not run at all.
//
// The domain standard is the same rule from the consumer's side: "a published
// npm package MUST run on stock node with `npx`: ship prebuilt output via a
// `files` allowlist". Bundling is what makes that true.
//
// Relocatability is asserted by tests/wtft-36-relocatable-build.test.ts, not
// left to this comment.
// ---

import * as fs from "node:fs";
import * as path from "node:path";

const BIN = path.join(import.meta.dir, "bin");

// ---
// Bundling third-party code carries its notice with it. `@princess-pi/libs` is
// MIT-0, which waives attribution; `wcwidth` is MIT, which does not — its
// notice must appear "in all copies or substantial portions", and a bundle is
// a copy. Emitted unconditionally rather than only into the artifact that
// happens to pull wcwidth in today: a notice present for absent code is
// harmless, a notice absent for present code is the violation, and an
// unconditional banner has no dependency graph to fall out of sync with.
// ---
const NOTICE = `/*
 * This file is a BUNDLE. It contains, in addition to @princess-pi/wtft
 * (MIT-0), the following third-party code:
 *
 * wcwidth <https://github.com/timoxley/wcwidth> — MIT
 * A JavaScript porting of wcwidth() by Markus Kuhn.
 * Copyright (C) 2012 by Jun Woong.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
`;

const entries = [
  { src: "bin/wtft.ts", out: "wtft.mjs" },
  { src: "bin/wtft-daemon.ts", out: "wtft-daemon.mjs" },
] as const;

// ---
// THE VERSION IS THE LAST THING THE BUNDLE REACHED FOR OUTSIDE ITSELF (#46).
//
// `renderWtftVersion` reads `<artifactDir>/../package.json`. That resolves in a
// package install (node_modules/@princess-pi/wtft/bin/wtft.mjs) and in this
// repo, and in NO other layout — including the one #46 installs, where the
// artifact sits in ~/bin and the lookup lands on `$HOME/package.json`. Two
// failures, and the second is the bad one:
//
//   - absent  → `wtft --version` prints "unknown", on the one command you run
//     when you already suspect you are running the wrong build.
//   - PRESENT → it prints an unrelated project's version, confidently. A stray
//     package.json in a home directory is not exotic.
//
// Injecting it at build time keeps package.json the single source of truth
// (this reads it) while making the artifact answer from itself. In unbundled
// source — the Pi extension loads it directly — the define is absent and the
// package.json read still happens, which is correct there.
// ---
const pkgVersion = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "package.json"), "utf8"),
).version as string;

let errors = 0;
for (const { src, out } of entries) {
  const result = await Bun.build({
    entrypoints: [path.join(import.meta.dir, src)],
    outdir: BIN,
    format: "esm",
    target: "node",
    naming: out,
    define: { "process.env.WTFT_BUILD_VERSION": JSON.stringify(pkgVersion) },
  });
  if (!result.success) {
    console.error(`❌ ${out}:`, result.logs);
    errors++;
    continue;
  }

  // The shebang has to stay on line 1 for the `bin` entries to be executable,
  // so the notice goes after it rather than at the top of the file.
  const file = path.join(BIN, out);
  const code = fs.readFileSync(file, "utf8");
  const nl = code.startsWith("#!") ? code.indexOf("\n") + 1 : 0;
  fs.writeFileSync(file, code.slice(0, nl) + NOTICE + code.slice(nl));
  fs.chmodSync(file, 0o755);

  console.log(`✅ bin/${out} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
}

if (errors > 0) process.exit(1);
console.log("\n✅ build complete");
