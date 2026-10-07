/**
 * User-editable pricing registry loader.
 *   New models are a config edit, not a rebuild: entries in
 *   ~/.config/wtft/pricing.json (XDG_CONFIG_HOME respected, #156) merge OVER
 *   the built-in MODEL_PRICING table. File shape is
 *   Record<modelKey, ModelPricing> — same shape as MODEL_PRICING.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { applyUserPricing, resetUserPricing, type ModelPricing } from "./wtft-cost.js";
import { WTFT_CONFIG_DIR } from "./wtft-config-dir.js";

// ---

export function getUserPricingPath(): string {
	const xdgHome = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
	return path.join(xdgHome, WTFT_CONFIG_DIR, "pricing.json");
}

// ---

/**
 * Entries from an earlier load are dropped first. Missing/unreadable/invalid file → built-ins
 * only (wtft never blocks on config; per-entry validation lives in applyUserPricing).
 * Each rejection goes to `report`, stderr by default. A surge schedule that cannot be
 * walked is dropped and the rates are kept. A rate that is not a finite
 * number stores nothing.
 */
export function loadUserPricing(
	filePath: string = getUserPricingPath(),
	report: (line: string) => void = (line) => console.error(`\x1b[33m⚠ ${line}\x1b[0m`),
): Record<string, ModelPricing> | null {
	resetUserPricing();
	try {
		if (!fs.existsSync(filePath)) return null;
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		for (const item of applyUserPricing(parsed as Record<string, ModelPricing>)) {
			report(`pricing ${item.key}: ${item.reason}`);
		}
		return parsed as Record<string, ModelPricing>;
	} catch {
		return null; // unreadable or malformed JSON — keep built-ins
	}
}
