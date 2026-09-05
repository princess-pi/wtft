/**
 * Tests for #169 — docs/EXT_WTFT.html's Model Pricing table is generated from
 * MODEL_PRICING, not hand-maintained.
 *
 * The hand-maintained table listed Claude 4 and no Claude 5 family, no GPT-5.x,
 * no notion of a dated or size tier, and DeepSeek rates from before the
 * 2026-08-16 card. Nothing failed while it was wrong.
 *
 * These tests gate the generated path end to end: the committed manifest must
 * equal a fresh render (so a registry edit that skips `bun run build` is red),
 * every registry model must appear (so a new model cannot be invisible), and
 * the page must actually read the manifest rather than carry a fourth copy of
 * the numbers in markup.
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildPricingManifest,
	renderPricingManifest,
	PRICING_MANIFEST_SCHEMA,
} from "../extensions/lib/wtft-pricing-manifest.ts";
import { MODEL_PRICING } from "../extensions/lib/wtft-cost.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(REPO, "docs", "manifests", "wtft-pricing.json");
const DOC_PATH = path.join(REPO, "docs", "EXT_WTFT.html");

describe("#169 the pricing manifest is committed and current", () => {
	it("exists", () => {
		assert.ok(fs.existsSync(MANIFEST_PATH), `${MANIFEST_PATH} is missing — run: bun run build`);
	});

	it("matches a fresh render of the registry byte for byte", () => {
		// The whole point: a rate edit that skips the build is caught HERE, not
		// by a reader noticing the docs page disagrees with the CLI.
		const committed = fs.readFileSync(MANIFEST_PATH, "utf8");
		assert.strictEqual(committed, renderPricingManifest(), "stale manifest — run: bun run build");
	});

	it("declares its schema", () => {
		const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
		assert.strictEqual(m.schema, PRICING_MANIFEST_SCHEMA);
	});
});

describe("#169 every priced model reaches the manifest", () => {
	it("the COMMITTED manifest lists exactly the registry's models", () => {
		// Reads the file on disk, NOT buildPricingManifest() (#22 C1). The
		// builder constructs `models` as Object.keys(MODEL_PRICING).sort().map(…),
		// so comparing its output against Object.keys(MODEL_PRICING).sort() was
		// an identity — it could not fail under any registry or builder state,
		// while its failure message named a cause the builder makes impossible.
		// Against the committed file it fails for the reason that message gives:
		// a registry edit that skipped `bun run build`.
		const committed = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
		const listed = committed.models.map((m: { model: string }) => m.model).sort();
		const priced = Object.keys(MODEL_PRICING).sort();
		for (const model of priced) {
			assert.ok(listed.includes(model), `${model} is priced but missing from the committed manifest — run: bun run build`);
		}
		for (const model of listed) {
			assert.ok(priced.includes(model), `${model} is in the committed manifest but no longer priced — run: bun run build`);
		}
	});

	it("carries the Claude 5 family and the GPT-5.x lineup the old table omitted", () => {
		const listed = new Set(buildPricingManifest().models.map(m => m.model));
		for (const model of [
			"claude-fable-5", "claude-mythos-5", "claude-opus-5", "claude-sonnet-5",
			"gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
		]) {
			assert.ok(listed.has(model), `${model} is priced but missing from the manifest`);
		}
	});

	it("renders a dated window as its own conditioned row", () => {
		// claude-sonnet-5's intro rate and DeepSeek's pre-2026-08-16 card are both
		// dateTiers. The old table had no way to express either.
		const sonnet = buildPricingManifest().models.find(m => m.model === "claude-sonnet-5");
		assert.ok(sonnet);
		const dated = sonnet!.rates.filter(r => r.condition.startsWith("before "));
		assert.strictEqual(dated.length, 1);
		assert.strictEqual(dated[0].input, 2.00);
	});

	it("renders a size tier as its own conditioned row", () => {
		const gpt = buildPricingManifest().models.find(m => m.model === "gpt-5.6-sol");
		assert.ok(gpt);
		// "combined input", not "input": the resolver sums input + cacheRead +
		// cacheWrite tokens, and the old label said otherwise (PR #507 review).
		const tiered = gpt!.rates.filter(r => r.condition.startsWith("combined input over "));
		assert.strictEqual(tiered.length, 1);
		assert.strictEqual(tiered[0].input, 10.00);
	});

	// Pins the rendered VALUES and their format. It does not prove they came from
	// the shared constants — it would pass if formatWindow returned literals. The
	// delegation itself is covered behaviourally in wtft-495-deepseek-rates.test.ts.
	it("renders the DeepSeek surge schedule in the expected values and format", () => {
		const surge = buildPricingManifest().deepseekSurge;
		assert.deepStrictEqual(surge.windowsUtc, ["01:00–04:00", "06:00–10:00"]);
		assert.strictEqual(surge.weekendOffPeakFrom, "2026-08-23T00:00:00Z");
		assert.strictEqual(surge.multiplier, 2.0);
	});
});

describe("#169 the docs page reads the manifest instead of hardcoding rates", () => {
	const html = () => fs.readFileSync(DOC_PATH, "utf8");

	it("fetches manifests/wtft-pricing.json", () => {
		assert.ok(html().includes("manifests/wtft-pricing.json"));
	});

	it("no longer carries the hand-written rate rows", () => {
		// These exact strings were table cells in the stale hand-maintained
		// version. Any of them surviving means a second source of truth is back.
		// These were table cells in the hand-maintained version. Two are dead values;
		// "$0.0145" is NOT — it is deepseek-v4-pro's live dateTiers cacheRead and it
		// appears in the committed manifest. It is banned from the MARKUP precisely
		// because a live number hand-typed into the page is the drift this replaced.
		for (const stale of ["Claude Opus 4<", "Claude Sonnet 4<", "$0.0145", "as of July 2026"]) {
			assert.ok(!html().includes(stale), `docs/EXT_WTFT.html still hardcodes: ${stale}`);
		}
	});
});
