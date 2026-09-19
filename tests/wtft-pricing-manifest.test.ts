/**
 * Tests for #169 — docs/EXT_WTFT.html's Model Pricing table is generated from
 * MODEL_PRICING, not hand-maintained.
 *
 * The hand-maintained table listed Claude 4 and no Claude 5 family, no GPT-5.x,
 * no notion of a dated or size tier, and DeepSeek rates from before the
 * 2026-08-16 card. Nothing failed while it was wrong.
 *
 * These tests gate the generated path end to end: the committed manifest must
 * equal a fresh render (so a registry edit that skips regeneration is red),
 * every registry model must appear (so a new model cannot be invisible), and
 * the page must actually read the manifest rather than carry a fourth copy of
 * the numbers in markup.
 *
 * THE COMMAND IN THESE MESSAGES IS `bun run manifest`, and until #100 it was
 * `bun run build` in all five messages below — a command that wrote nothing.
 * `renderPricingManifest()` existed and had no caller, so the only instruction
 * a failure ever gave you left it failing. Two things had to change together, and the second is the subtle one:
 * the build must NOT be the writer. `prepare` runs the build and CI runs
 * `npm install` before `npm test`, so a build that regenerated this file would
 * repair a stale COMMITTED manifest in the working tree moments before the
 * comparison below — turning this suite green for every possible registry.
 * Measured while making the change: staling the committed file fails this suite
 * before a build and passes after one. So `bun run manifest` writes,
 * `bun run build` only compares (and fails, naming that command), and nothing
 * between checkout and assertion touches the file.
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
// SOURCE, not `../bin/wtft.mjs`. Comparing the committed manifest against the
// BUILT registry could not detect a skipped build, because a skipped build
// leaves bundle and manifest equally stale. Importing the source is what makes
// "edit the registry, skip `bun run manifest`" observable. Verified by
// mutation both times — adding a model here and not REGENERATING turns the
// "lists exactly the registry's models" case red with its intended message.
// Regenerating, not rebuilding: since #100 `bun run build` only checks this
// file and cannot repair the comparison, so "rebuild" would name a fix that
// does not work.
import { MODEL_PRICING } from "../extensions/lib/wtft-cost.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(REPO, "docs", "manifests", "wtft-pricing.json");
const DOC_PATH = path.join(REPO, "docs", "EXT_WTFT.html");

describe("#169 the pricing manifest is committed and current", () => {
	it("exists", () => {
		assert.ok(fs.existsSync(MANIFEST_PATH), `${MANIFEST_PATH} is missing — run: bun run manifest`);
	});

	it("matches a fresh render of the registry byte for byte", () => {
		// The whole point: a rate edit that skips `bun run manifest` is caught
		// HERE, not by a reader noticing the docs page disagrees with the CLI.
		// `bun run build` also refuses on a stale file, but it only checks — it
		// deliberately does not repair, or this assertion could never fail.
		const committed = fs.readFileSync(MANIFEST_PATH, "utf8");
		assert.strictEqual(committed, renderPricingManifest(), "stale manifest — run: bun run manifest");
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
		// a registry edit that skipped `bun run manifest`.
		const committed = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
		const listed = committed.models.map((m: { model: string }) => m.model).sort();
		const priced = Object.keys(MODEL_PRICING).sort();
		for (const model of priced) {
			assert.ok(listed.includes(model), `${model} is priced but missing from the committed manifest — run: bun run manifest`);
		}
		for (const model of listed) {
			assert.ok(priced.includes(model), `${model} is in the committed manifest but no longer priced — run: bun run manifest`);
		}
		// "exactly" means the counts match too. Inclusion in
		// both directions is satisfied by a manifest that lists a model twice.
		assert.strictEqual(listed.length, priced.length,
			`the committed manifest has ${listed.length} rows for ${priced.length} priced models — a duplicate or dropped entry; run: bun run manifest`);
		assert.strictEqual(new Set(listed).size, listed.length, "the committed manifest lists a model more than once");
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

	it("attributes each cutover in the note to the model whose row carries it", () => {
		// The note is PROSE inside a generated artifact, which is the one place a
		// hardcoded date survives a regeneration: `bun run manifest` would rewrite
		// every dated row's condition from the constants and leave a stale
		// sentence beside them, and the committed file would still match a fresh
		// render byte-for-byte. So the byte-comparison above cannot catch it and
		// this case must.
		//
		// It checks ASSOCIATION, not membership. A first version collected every
		// DeepSeek instant into a set and asked whether each date in the note was
		// in it — which passes when the two dates are SWAPPED, or when one is
		// replaced by another real cutover, because every candidate is in the set
		//. What the note actually claims is that a specific
		// event happened to a specific model, so that is what is asserted.
		const m = buildPricingManifest();
		const note = m.deepseekSurge.note;

		/** The instant a model's NEWEST dated row ends — that model's last cutover. */
		const newestCutoverFor = (model: string): string => {
			const row = m.models.find(x => x.model === model);
			assert.ok(row, `${model} is not in the manifest`);
			const dated = row!.rates
				.map(r => r.condition.match(/^before (.+)$/)?.[1])
				.filter((x): x is string => !!x)
				.sort();
			assert.ok(dated.length > 0, `${model} carries no dated row`);
			return dated[dated.length - 1];
		};

		// Each claim in the note, paired with the row that has to back it up.
		const claims: Array<[RegExp, string, string]> = [
			[/retired the V4 Flash line at (\S+?) /, newestCutoverFor("deepseek-v4-flash"),
			 "the V4 Flash retirement should be deepseek-v4-flash's last cutover"],
			[/takes over deepseek-v4-pro at (\S+?),/, newestCutoverFor("deepseek-v4-pro"),
			 "the v4-pro reroute should be deepseek-v4-pro's last cutover"],
		];

		for (const [pattern, expected, why] of claims) {
			const found = note.match(pattern);
			assert.ok(found, `the note no longer states this claim in a readable form: ${pattern}`);
			assert.strictEqual(found![1], expected, `${why} — note says ${found![1]}, rows say ${expected}`);
		}

		// And the two are genuinely different events, so a swap cannot pass by
		// both sides happening to agree.
		assert.notStrictEqual(
			newestCutoverFor("deepseek-v4-flash"),
			newestCutoverFor("deepseek-v4-pro"),
			"the two cutovers must differ for the assertions above to discriminate",
		);
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
