import type { Category, Interaction } from "../../extensions/lib/wtft-parser.ts";
import { calculateClaudeCost, calculateServerToolCost, getPeakMultiplier, surgeScheduleFor } from "../../extensions/lib/wtft-cost.ts";

export const WTFT_MODELS = ["claude-sonnet-5-5", "deepseek-v4-pro"] as const;

type Mix = Partial<Record<Category, number>>;

interface Scene { start: string; turns: number; mix: Mix }

const SCENES: Scene[] = [
	{ start: "2026-09-24T14:10:00Z", turns: 24, mix: { plan: 5, spec: 4, research: 4, grep: 2, code: 4, web: 1 } },
	{ start: "2026-09-25T09:05:00Z", turns: 46, mix: { code: 8, tests: 4, git: 2, grep: 2, agents: 2, prompt: 1, web: 1 } },
	{ start: "2026-09-26T13:02:00Z", turns: 60, mix: { code: 7, tests: 4, git: 2, agents: 2, prompt: 2, other: 2, interrupted: 1, compaction: 1 } },
];

interface Shape { input: [number, number]; output: [number, number]; read: [number, number]; write: [number, number] }

const SHAPES: Record<Category, Shape> = {
	plan: { input: [400, 1800], output: [900, 3200], read: [30_000, 90_000], write: [0, 4000] },
	spec: { input: [300, 1500], output: [700, 2600], read: [30_000, 110_000], write: [0, 3000] },
	research: { input: [600, 2600], output: [300, 1400], read: [40_000, 140_000], write: [0, 9000] },
	web: { input: [500, 2200], output: [200, 900], read: [30_000, 100_000], write: [0, 6000] },
	grep: { input: [200, 900], output: [100, 500], read: [40_000, 120_000], write: [0, 1500] },
	code: { input: [300, 2500], output: [500, 3800], read: [60_000, 190_000], write: [0, 7000] },
	tests: { input: [200, 1400], output: [200, 1200], read: [60_000, 190_000], write: [0, 2500] },
	git: { input: [100, 600], output: [100, 500], read: [50_000, 150_000], write: [0, 1200] },
	agents: { input: [800, 3000], output: [300, 1200], read: [30_000, 90_000], write: [0, 5000] },
	prompt: { input: [200, 900], output: [200, 1100], read: [60_000, 170_000], write: [0, 1500] },
	compaction: { input: [1000, 3000], output: [1500, 4500], read: [0, 0], write: [90_000, 140_000] },
	interrupted: { input: [200, 900], output: [50, 300], read: [50_000, 150_000], write: [0, 900] },
	overhead: { input: [100, 400], output: [50, 200], read: [0, 0], write: [80_000, 120_000] },
	other: { input: [200, 1200], output: [200, 1500], read: [40_000, 140_000], write: [0, 3000] },
};

function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * The fake session, shaped as `readTagFileWithVerdict` returns one: every interaction carries `_cat`,
 * the tag file's own field, so the classifier's file, command and text inputs are not needed.
 */
export function wtftSession(model: string): Interaction[] {
	const rand = prng(386);
	const between = ([lo, hi]: [number, number]) => Math.round(lo + rand() * (hi - lo));
	const out: Interaction[] = [];
	let codeTurns = 0;
	for (const scene of SCENES) {
		let at = Date.parse(scene.start);
		const bag = Object.entries(scene.mix).flatMap(([cat, n]) => Array<Category>(n).fill(cat as Category));
		for (let n = 0; n < scene.turns; n++) {
			const gapMinutes = rand() < 0.03 ? 12 + Math.round(rand() * 8) : 1 + Math.round(rand() * 6);
			const afterGap = n === 0 || gapMinutes >= 12;
			at += n === 0 ? 0 : gapMinutes * 60_000;
			const cat = afterGap ? "overhead" as const : bag[Math.floor(rand() * bag.length)];
			const shape = SHAPES[cat];
			const missed = afterGap;
			const input = between(shape.input);
			const output = between(shape.output);
			const read = missed ? 0 : Math.round(between(shape.read) / 5);
			const write = missed ? between([40_000, 80_000]) : between(shape.write);
			const searches = cat === "web" || (cat === "code" && codeTurns++ % 9 === 4) ? 1 : 0;
			const cost = calculateClaudeCost(model, {
				input_tokens: input,
				output_tokens: output,
				cache_creation_input_tokens: write,
				cache_read_input_tokens: read,
			}, at);
			out.push({
				timestamp: at,
				cost,
				model,
				inputTokens: input,
				outputTokens: output,
				cacheReadTokens: read,
				cacheWriteTokens: write,
				reasoningTokens: 0,
				webSearchRequests: searches,
				webFetchRequests: 0,
				serverToolCost: calculateServerToolCost(model, searches, 0),
				surgePriced: surgeScheduleFor(model) ? getPeakMultiplier(model, at) > 1 : undefined,
				cacheMiss: missed && write > 0 ? true : undefined,
				files: [],
				commands: [],
				texts: [],
				_cat: cat,
			});
		}
	}
	return out;
}
