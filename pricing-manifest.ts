#!/usr/bin/env bun
/**
 * pricing-manifest.ts — writes and verifies docs/manifests/wtft-pricing.json.
 *
 * `bun run manifest` WRITES it. `bun run build` only CHECKS it, through
 * `checkPricingManifest` below, and fails naming the write command.
 *
 * WHY THE BUILD IS NOT THE WRITER (#100). `prepare` runs `bun run build`, and CI
 * runs `npm install` before `npm test`. A build that regenerated this file would
 * silently repair a STALE COMMITTED manifest in the working tree moments before
 * tests/wtft-pricing-manifest.test.ts compared the two — and that suite exists
 * precisely to catch a regeneration someone skipped, so it would have gone green
 * for every possible registry. Measured while writing this: staling the
 * committed file fails that suite before a build and passes after one. Splitting
 * write from check is what keeps the assertion falsifiable.
 *
 * Before #100 there was no writer at all. `renderPricingManifest()` existed and
 * nothing called it, while five assertions failed with "run: bun run build" — a
 * command that wrote nothing.
 *
 * WHY IT SITS AT THE REPO ROOT beside build.ts, and not in bin/: bin/ is SHIPPED
 * output, and tsconfig.json deliberately types it with `["node"]` only so a Bun
 * global reaching a published CLI is a compile error rather than a consumer's
 * runtime crash. This is a build tool that uses `import.meta.dir`, so bin/ is
 * exactly where it must not live — the first draft put it there and turned
 * `bun run typecheck` red with TS2339. build.ts is outside `include` for the
 * same reason, and this file joins it.
 *
 * @usage bun run manifest
 *   Exit 0 — written, or already current. The two are distinguished on stdout.
 *   Exit 1 — the render or the write threw; the error is printed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { renderPricingManifest, buildPricingManifest } from "./extensions/lib/wtft-pricing-manifest.ts";

/** The one definition of where the manifest lives. Both jobs below use it. */
export const PRICING_MANIFEST = path.join(import.meta.dir, "docs", "manifests", "wtft-pricing.json");

/** Repo-relative, for messages — an absolute path in build output is noise. */
const REL = "docs/manifests/wtft-pricing.json";

/** What is on disk, or null when the file is absent. Absent and stale differ. */
function committed(): string | null {
	return fs.existsSync(PRICING_MANIFEST) ? fs.readFileSync(PRICING_MANIFEST, "utf8") : null;
}

/**
 * Compare only. Returns `"current"`, `"stale"`, or `"missing"` — three states,
 * because a build that reports an absent file as "stale" sends its reader to
 * diff something that is not there. The test messages draw the same distinction.
 */
export function checkPricingManifest(): "current" | "stale" | "missing" {
	const actual = committed();
	if (actual === null) return "missing";
	return actual === renderPricingManifest() ? "current" : "stale";
}

/** Model count, from the built object rather than by re-parsing rendered JSON. */
export function manifestModelCount(): number {
	return buildPricingManifest().models.length;
}

/** Write it. Reports whether bytes actually changed, so a no-op is visible. */
export function writePricingManifest(): "written" | "current" {
	const next = renderPricingManifest();
	if (committed() === next) return "current";
	fs.mkdirSync(path.dirname(PRICING_MANIFEST), { recursive: true });
	fs.writeFileSync(PRICING_MANIFEST, next);
	return "written";
}

// Only when run directly — build.ts imports checkPricingManifest and must not
// trigger a write by importing this module.
if (import.meta.main) {
	const result = writePricingManifest();
	const n = manifestModelCount();
	console.log(result === "written"
		? `✅ wrote ${REL} (${n} models) — commit it`
		: `✅ ${REL} already current (${n} models)`);
}
