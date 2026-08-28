/**
 * @package princess-pi-tools
 * @module harness/registry
 * @description Enumerates harnesses from runtime config (#156).
 *
 * Two channels, one contract:
 *
 *   In-repo — build.ts scans harness/<id>/ and writes builtins.generated.ts, a
 *   static import table. Adding a harness is two new files plus a config entry;
 *   the table regenerates. No shared file is edited. Static imports keep the
 *   bundle self-contained and behave identically under Bun's bundler and the Pi
 *   extension's tsx loader.
 *
 *   Out-of-tree — a config entry carrying `discovery`/`parse` module paths is
 *   await import()ed by loadExternalHarnesses() at startup. No rebuild at all.
 *   .mjs/.js only: stock node cannot import .ts, and requiring node ≥ 22.6
 *   type-stripping from a global install was already ruled out (#31).
 *
 * Config is read at runtime, not baked at build — the precedent set by
 * wtft-pricing.json (#140). loadExternalHarnesses() is async and called once at
 * startup; getHarnesses() stays sync so discoverSessions() and
 * parseEntryToInteraction() keep their signatures and the hot parse path takes
 * no async penalty.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

import type {
	HarnessConfigEntry,
	HarnessDiscovery,
	HarnessParseAdapter,
	RegisteredHarness,
} from "./types.ts";
import { BUILTIN_HARNESSES } from "./builtins.generated.ts";
import { emitLegacyDeprecation } from "../config.js";

// ---
// CONFIG
// ---

/**
 * ~/.config/princess-pi-tools/wtft-harnesses.json (repo config convention).
 * Falls back to the pre-rename princess-pi-packages/ path when only that one
 * exists, so an existing harness config keeps working without being moved.
 */
export function getHarnessConfigPath(): string {
	const xdgHome = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
	const current = path.join(xdgHome, "princess-pi-tools", "wtft-harnesses.json");
	if (fs.existsSync(current)) return current;
	const legacy = path.join(xdgHome, "princess-pi-packages", "wtft-harnesses.json");
	if (fs.existsSync(legacy)) {
		emitLegacyDeprecation(legacy, current);
		return legacy;
	}
	return current;
}

/** Read the harness config. Missing/unreadable/invalid → {} (never blocks wtft). */
export function loadHarnessConfig(
	filePath: string = getHarnessConfigPath()
): Record<string, HarnessConfigEntry> {
	try {
		if (!fs.existsSync(filePath)) return {};
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: Record<string, HarnessConfigEntry> = {};
		for (const [id, entry] of Object.entries(parsed)) {
			// An unknown or malformed key is ignored, not fatal.
			if (entry && typeof entry === "object" && !Array.isArray(entry)) {
				out[id] = entry as HarnessConfigEntry;
			}
		}
		return out;
	} catch {
		return {};
	}
}

/** Expand a leading ~ so config files can be written the way humans write paths. */
function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homedir(), p.slice(2));
	return p;
}

// ---
// REGISTRY STATE
// ---

/** Harnesses contributed by config-declared external modules. */
const externals = new Map<string, RegisteredHarness>();

/** Ids explicitly disabled in config. */
let disabled = new Set<string>();

let configCache: Record<string, HarnessConfigEntry> | null = null;

/** Memo for getHarnesses() — the parse path consults it once per entry. */
let harnessesCache: RegisteredHarness[] | null = null;
/** Memo for the parse halves — parseEntryToInteraction runs per transcript line. */
let adaptersCache: HarnessParseAdapter[] | null = null;

function config(): Record<string, HarnessConfigEntry> {
	if (configCache === null) {
		configCache = loadHarnessConfig();
		disabled = new Set(
			Object.entries(configCache)
				.filter(([, e]) => e.enabled === false)
				.map(([id]) => id)
		);
	}
	return configCache;
}

/** Drop cached config + external modules (tests, and config hot-reload). */
export function resetHarnessRegistry(): void {
	configCache = null;
	disabled = new Set();
	externals.clear();
	harnessesCache = null;
	adaptersCache = null;
}

/**
 * Load config-declared out-of-tree harness modules. Async, called once at
 * startup by bin/wtft.ts and bin/wtft-daemon.ts — exactly like loadUserPricing().
 * A module that fails to load is skipped with a stderr note; wtft never blocks
 * on config.
 */
export async function loadExternalHarnesses(
	filePath: string = getHarnessConfigPath()
): Promise<string[]> {
	resetHarnessRegistry();
	configCache = loadHarnessConfig(filePath);
	harnessesCache = null;
	adaptersCache = null;
	disabled = new Set(
		Object.entries(configCache)
			.filter(([, e]) => e.enabled === false)
			.map(([id]) => id)
	);

	const loaded: string[] = [];
	for (const [id, entry] of Object.entries(configCache)) {
		if (BUILTIN_HARNESSES[id]) continue;   // built-ins need no import
		if (entry.enabled === false) continue;
		if (!entry.discovery || !entry.parse) continue;
		try {
			const discoveryMod: any = await import(
				pathToFileURL(path.resolve(expandHome(entry.discovery))).href
			);
			const parseMod: any = await import(
				pathToFileURL(path.resolve(expandHome(entry.parse))).href
			);
			const discovery: HarnessDiscovery = discoveryMod.discovery || discoveryMod.default;
			const parse: HarnessParseAdapter = parseMod.parse || parseMod.default;
			if (!discovery || !parse) throw new Error("module exports no discovery/parse");
			if (entry.label) (discovery as any).label = entry.label;
			externals.set(id, { id, discovery, parse });
			harnessesCache = null;
			adaptersCache = null;
			loaded.push(id);
		} catch (err) {
			process.stderr.write(
				`wtft: harness '${id}' failed to load: ${err instanceof Error ? err.message : String(err)}\n`
			);
		}
	}
	return loaded;
}

/**
 * Register a harness directly. The in-process path an out-of-tree harness's
 * tests use, and how the Codex sketch is exercised without touching config.
 */
export function registerHarness(harness: RegisteredHarness): void {
	externals.set(harness.id, harness);
	disabled.delete(harness.id);
	harnessesCache = null;
	adaptersCache = null;
}

// ---
// LOOKUP (sync — the hot path)
// ---

/** Every enabled harness, built-ins first, in stable id order. */
export function getHarnesses(): RegisteredHarness[] {
	if (harnessesCache) return harnessesCache;
	config();
	const out: RegisteredHarness[] = [];
	for (const [id, mods] of Object.entries(BUILTIN_HARNESSES)) {
		if (disabled.has(id)) continue;
		const cfg = configCache?.[id];
		if (cfg?.label) (mods.discovery as any).label = cfg.label;
		out.push({ id, discovery: mods.discovery, parse: mods.parse });
	}
	for (const [id, harness] of externals) {
		if (disabled.has(id)) continue;
		out.push(harness);
	}
	harnessesCache = out;
	return out;
}

/** One harness by id, or null when unknown/disabled. */
export function getHarness(id: string): RegisteredHarness | null {
	return getHarnesses().find(h => h.id === id) || null;
}

/** Discovery halves only. */
export function getDiscoveries(): HarnessDiscovery[] {
	return getHarnesses().map(h => h.discovery);
}

/** Parse halves only — memoised, because this runs once per transcript line. */
export function getParseAdapters(): HarnessParseAdapter[] {
	if (adaptersCache) return adaptersCache;
	adaptersCache = getHarnesses().map(h => h.parse);
	return adaptersCache;
}
