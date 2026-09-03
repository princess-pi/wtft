/**
 * @package princess-pi-tools
 * @module wtft-pricing-config
 * @description User-editable pricing registry loader (#140).
 *   New models are a config edit, not a rebuild: entries in
 *   ~/.config/princess-pi-tools/wtft-pricing.json (XDG_CONFIG_HOME
 *   respected) merge OVER the built-in MODEL_PRICING table. File shape is
 *   Record<modelKey, ModelPricing> — same shape as MODEL_PRICING, optional
 *   tiers included. Called at startup by both the CLI and the daemon (the
 *   daemon is where per-turn costs are actually computed).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { applyUserPricing, type ModelPricing } from "./wtft-cost.js";

// ---
// PATH RESOLUTION
// ---

/**
 * ~/.config/princess-pi-tools/wtft-pricing.json (repo config convention).
 */
export function getUserPricingPath(): string {
	const xdgHome = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
	return path.join(xdgHome, "princess-pi-tools", "wtft-pricing.json");
}

// ---
// LOADER
// ---

/**
 * Read the user pricing file and merge it over built-ins.
 * Missing/unreadable/invalid file → no-op (wtft never blocks on config;
 * per-entry validation lives in applyUserPricing).
 * Returns the parsed record, or null when nothing was applied.
 */
export function loadUserPricing(filePath: string = getUserPricingPath()): Record<string, ModelPricing> | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		applyUserPricing(parsed as Record<string, ModelPricing>);
		return parsed as Record<string, ModelPricing>;
	} catch {
		return null; // unreadable or malformed JSON — keep built-ins
	}
}
