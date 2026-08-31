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
// THE NOTICE IS DERIVED FROM WHAT IS ACTUALLY BUNDLED, not written by hand.
//
// The hand-written version was wrong in three ways at once, and a reconcile
// audit found all three:
//
//   - It named only wcwidth. `clone` and `defaults` (both MIT, both pulled in
//     by wcwidth) are in the bundle too, and MIT's "shall be included in all
//     copies" clause does not care that they arrived transitively.
//   - Its body was the STANDARD MIT disclaimer. wcwidth's own LICENSE uses a
//     BSD-2-style one ("ANY EXPRESS OR IMPLIED WARRANTIES … EXEMPLARY, OR
//     CONSEQUENTIAL DAMAGES"). Reproducing the wrong disclaimer is not
//     reproducing the notice.
//   - It was emitted unconditionally, "harmless for absent code" — which also
//     meant the licence test could not fail for its stated reason. Strip
//     wcwidth entirely and the assertion still passed.
//
// Deriving it fixes all three and cannot drift: bun writes a `// node_modules/
// <pkg>/…` marker above each vendored module, so the bundle names its own
// contents, and each LICENSE is copied verbatim rather than paraphrased.
// The whole `@princess-pi/` SCOPE is skipped, on the grounds that libs is MIT-0
// and waives attribution. That is a scope-wide bet on a per-package fact: a
// future `@princess-pi/*` under another licence would drop out silently. It is
// the only hand-maintained fact left, and one this repo owns.
// ---
function noticeFor(code: string): string {
  // Capture the whole path FROM the first `node_modules/`, so a nested
  // `node_modules/wcwidth/node_modules/defaults/…` marker resolves to the
  // directory that actually holds that copy's LICENSE. An earlier version took
  // the last segment name and then joined it onto the TOP-LEVEL node_modules,
  // where a genuinely nested package does not exist — so the comment claimed a
  // fix the code turned into a throw. Today's tree has no nested markers, which
  // is why nothing caught it.
  const pkgs = new Map<string, string>();   // package name -> directory
  for (const m of code.matchAll(/^\/\/ (.*node_modules\/((?:@[^/\n]+\/)?[^/\n]+))\//gm)) {
    const name = m[2];
    if (name.startsWith("@princess-pi/")) continue;
    pkgs.set(name, path.join(import.meta.dir, m[1]));
  }
  // An empty result is SILENT — a bundle with no notice at all is the violation
  // this function exists to prevent, and it is the one failure mode with no
  // error. The guarantee therefore lives in the test, not here:
  // tests/wtft-36-relocatable-build.test.ts V4a fails the build's output when a
  // bundle names no vendored package. Saying "cannot drift" of this code alone
  // would be the claim, not the check.
  if (pkgs.size === 0) return "";

  const parts: string[] = [];
  for (const name of [...pkgs.keys()].sort()) {
    const dir = pkgs.get(name)!;
    // Any file whose name starts LICENSE/LICENCE/COPYING, in any case and with
    // any suffix — `.txt`, `.md`, `-MIT`, none. A fixed four-name list turned a
    // dependency's filename choice into a hard build failure (and `install-wtft`
    // exit 3), which is a large penalty for a naming convention nobody agrees on.
    const file = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
      .filter(f => /^(licen[cs]e|copying)/i.test(f))
      .sort()
      .map(f => path.join(dir, f))
      .find(f => fs.statSync(f).isFile());
    if (!file) throw new Error(`bundled package ${name} has no LICENSE file — cannot emit a notice for it`);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    // `*/` inside a licence would close this comment block early and turn the
    // rest of the notice into code. Verbatim, then, up to a `" * "` prefix, a
    // trailing-whitespace trim, and this one escape.
    const text = fs.readFileSync(file, "utf8").trimEnd().replaceAll("*/", "*\\/");
    parts.push(` * ${name}@${pkg.version} — ${pkg.license ?? "see below"}\n *\n` +
      text.split("\n").map(l => ` * ${l}`.trimEnd()).join("\n"));
  }
  return `/*\n * This file is a BUNDLE. Besides @princess-pi/wtft (MIT-0) it contains the\n` +
    ` * following third-party code, with each project's licence reproduced verbatim:\n *\n` +
    parts.join("\n *\n * ---\n *\n") + "\n */\n";
}

const entries = [
  { src: "bin/wtft.ts", out: "wtft.mjs" },
  { src: "bin/wtft-daemon.ts", out: "wtft-daemon.mjs" },
] as const;

// ---
// THE VERSION NUMBER MOVED INTO THE BUNDLE (#46).
//
// Not "the last thing the bundle reached for outside itself" — an earlier draft
// of this comment said that and it was false. `readBuildStamp` still reads
// `build-stamp.json` beside the module, and the harness registry still
// `import()`s whatever `wtft-harnesses.json` names. This fixes the version
// NUMBER only; the rest is a separate question.
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
    // A global, not `process.env.X`: with an env key, an unbundled source run
    // reads it LIVE, so `WTFT_BUILD_VERSION=13.3.7-pwned bun bin/wtft.ts
    // --version` printed 13.3.7-pwned. Inside the BUNDLE the identifier is
    // replaced by a literal and nothing can reach it; in unbundled source it
    // still resolves through globalThis, so a `NODE_OPTIONS=--import <preload>`
    // could set it. Narrower than "no such reader" — one less reader, and only
    // the bundle is airtight.
    define: { __WTFT_BUILD_VERSION__: JSON.stringify(pkgVersion) },
  });
  if (!result.success) {
    console.error(`❌ ${out}:`, result.logs);
    errors++;
    continue;
  }

  // The shebang has to stay on line 1 for the `bin` entries to be executable,
  // so the notice goes after it rather than at the top of the file.
  //
  // AND IT IS REWRITTEN. bun copies the entrypoint's shebang through verbatim,
  // and bin/wtft.ts opens with `#!/usr/bin/env -S node --experimental-strip-types`
  // — correct for a .ts file, fatal on the plain-JS bundle: Node 20 answers
  // `node: bad option: --experimental-strip-types` and exits, so the installed
  // `~/bin/wtft` was unrunnable AS A COMMAND on two of the three majors
  // package.json's `engines: >=18` promises. Nothing caught it because every
  // test ran the artifact as `node <file>`, never by its own shebang.
  const file = path.join(BIN, out);
  const code = fs.readFileSync(file, "utf8");
  const nl = code.startsWith("#!") ? code.indexOf("\n") + 1 : 0;
  fs.writeFileSync(file, "#!/usr/bin/env node\n" + noticeFor(code) + code.slice(nl));
  fs.chmodSync(file, 0o755);

  console.log(`✅ bin/${out} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
}

if (errors > 0) process.exit(1);
console.log("\n✅ build complete");
