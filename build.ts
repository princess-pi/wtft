#!/usr/bin/env bun
// build.ts — bundles wtft and wtft-daemon CLIs to bin/*.mjs for npm publish
import * as fs from "node:fs";
import * as path from "node:path";

const BIN = path.join(import.meta.dir, "bin");

const entries = [
  { src: "bin/wtft.ts", out: "wtft.mjs" },
  { src: "bin/wtft-daemon.ts", out: "wtft-daemon.mjs" },
] as const;

let errors = 0;
for (const { src, out } of entries) {
  const result = await Bun.build({
    entrypoints: [path.join(import.meta.dir, src)],
    outdir: BIN,
    format: "esm",
    target: "node",
    naming: out,
    external: ["@princess-pi/libs", "wcwidth"],
  });
  if (!result.success) {
    console.error(`❌ ${out}:`, result.logs);
    errors++;
  } else {
    console.log(`✅ bin/${out}`);
  }
}

if (errors > 0) process.exit(1);
console.log("\n✅ build complete");
