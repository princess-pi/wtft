import type { Category, Interaction } from "../../extensions/lib/wtft-parser.ts";

/** The fair's local clock is UTC-6 (Denver, September). */
export const FAIR_UTC_OFFSET_HOURS = 6;
export const FAIR_TZ = "America/Denver";
export const FAIR_OPEN_HOUR = 10;

export interface FairItem {
	id: string;
	label: string;
	price: number;
	/** The chart category that carries this item. */
	slot: Category;
	/** Expected sales per open hour, 10:00 to 21:00. */
	perHour: number[];
}

export const FAIR_ITEMS: FairItem[] = [
	{ id: "latte", label: "Lattes", price: 5.5, slot: "overhead", perHour: [9, 8, 5, 3, 3, 4, 4, 3, 2, 1, 1, 0] },
	{ id: "apple", label: "Apples", price: 3, slot: "interrupted", perHour: [3, 4, 5, 6, 6, 7, 7, 8, 8, 6, 4, 2] },
	{ id: "funnel", label: "Funnel cake", price: 8, slot: "plan", perHour: [0, 1, 2, 3, 4, 5, 6, 8, 11, 12, 9, 5] },
	{ id: "pie", label: "Pie", price: 7, slot: "research", perHour: [1, 2, 3, 5, 7, 7, 5, 4, 3, 2, 1, 0] },
	{ id: "corndog", label: "Corn dogs", price: 6, slot: "web", perHour: [1, 4, 9, 10, 7, 4, 4, 7, 9, 6, 3, 1] },
	{ id: "lemonade", label: "Lemonade", price: 4, slot: "tests", perHour: [2, 4, 7, 9, 11, 12, 10, 7, 5, 3, 2, 1] },
];

export const SOUVENIRS: FairItem = {
	id: "souvenir", label: "Souvenirs", price: 12, slot: "other", perHour: [3, 3, 4, 6, 7, 7, 7, 6, 6, 4, 3, 1],
};

const DAYS: [number, number, number][] = [[2026, 9, 11], [2026, 9, 12], [2026, 9, 13]];
const DAY_DEMAND = [0.8, 1.3, 1.0];

/** Local hours (10 is 10:00 to 10:59) that bill 1.5 times. */
export const RUSH_HOURS = [12, 13, 18, 19];
export const RUSH_MULTIPLIER = 1.5;

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
 * The booth's sales, oldest first, one per interaction: revenue is `cost`, units are `inputTokens`.
 * `souvenirs` adds a seventh item, in the chart's "other" category.
 */
export function fairBooth(options: { souvenirs: boolean }): Interaction[] {
	const rand = prng(1211);
	const items = options.souvenirs ? [...FAIR_ITEMS, SOUVENIRS] : FAIR_ITEMS;
	const out: Interaction[] = [];
	let cutFlagged = false;
	DAYS.forEach(([year, month, day], dayIndex) => {
		for (let slot = 0; slot < 12; slot++) {
			const localHour = FAIR_OPEN_HOUR + slot;
			const rush = RUSH_HOURS.includes(localHour);
			for (const item of items) {
				const sales = Math.round(item.perHour[slot] * DAY_DEMAND[dayIndex] * (0.7 + rand() * 0.6));
				for (let n = 0; n < sales; n++) {
					const units = 1 + Math.floor(rand() * 3);
					const minute = Math.floor(rand() * 60);
					const timestamp = Date.UTC(year, month - 1, day, localHour + FAIR_UTC_OFFSET_HOURS, minute, Math.floor(rand() * 60));
					const powerCut = dayIndex === 1 && localHour === 14 && !cutFlagged;
					if (powerCut) cutFlagged = true;
					out.push({
						timestamp,
						cost: Math.round(item.price * units * (rush ? RUSH_MULTIPLIER : 1) * 100) / 100,
						inputTokens: units,
						outputTokens: 0,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						reasoningTokens: 0,
						webSearchRequests: 0,
						webFetchRequests: 0,
						serverToolCost: 0,
						surgePriced: rush || undefined,
						cacheMiss: powerCut || undefined,
						files: [],
						commands: [],
						texts: [],
						_cat: item.slot,
					});
				}
			}
		}
	});
	out.sort((a, b) => a.timestamp - b.timestamp);
	return out;
}
