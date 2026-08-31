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
// @princess-pi/libs is MIT-0, which waives attribution, so it is skipped by
// name — the only hand-maintained fact left, and one this repo owns.
// ---
function noticeFor(code: string): string {
  const pkgs = new Set<string>();
  for (const m of code.matchAll(/^\/\/ node_modules\/((?:@[^/\n]+\/)?[^/\n]+)\//gm)) {
    if (!m[1].startsWith("@princess-pi/")) pkgs.add(m[1]);
  }
  if (pkgs.size === 0) return "";

  const parts: string[] = [];
  for (const name of [...pkgs].sort()) {
    const dir = path.join(import.meta.dir, "node_modules", name);
    const file = ["LICENSE", "LICENSE.md", "LICENCE", "license"]
      .map(f => path.join(dir, f))
      .find(f => fs.existsSync(f));
    if (!file) throw new Error(`bundled package ${name} has no LICENSE file — cannot emit a notice for it`);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    parts.push(` * ${name}@${pkg.version} — ${pkg.license ?? "see below"}\n *\n` +
      fs.readFileSync(file, "utf8").trimEnd().split("\n").map(l => ` * ${l}`.trimEnd()).join("\n"));
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
    // --version` printed 13.3.7-pwned. A define'd global has no such reader.
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
