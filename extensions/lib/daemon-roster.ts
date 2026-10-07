import * as fs from "node:fs";
import * as path from "node:path";

import { wtftStateDir } from "./daemon-log.ts";
import { classifyPid, holdsLease, type HolderKind } from "./holder.ts";

export const ACTIVE_WINDOW_MS = 120_000;

export interface FileInfo {
	path: string;
	mtime: number;
}

export interface RosterEntry {
	file: string;
	holder: HolderKind;
	tags: { path: string; mtimeMs: number | null }[];
}

export function rosterDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(wtftStateDir(env), "roster");
}

let published: string | null = null;

/** Writes this process's roster listing `tagPaths`; an empty list removes it. */
export function publishRoster(tagPaths: string[]): void {
	const tags = [...new Set(tagPaths.map(p => path.resolve(p)))].sort();
	const file = path.join(rosterDir(), `${process.pid}.json`);
	const text = tags.length === 0 ? "" : JSON.stringify({ v: 1, pid: process.pid, tags });
	if (text === published && (text === "" || fs.existsSync(file))) return;
	if (text === "") {
		fs.rmSync(file, { force: true });
	} else {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, text + "\n");
		fs.renameSync(tmp, file);
	}
	published = text;
}

export function decideActive(entries: RosterEntry[], now: number): { active: FileInfo[]; prune: string[] } {
	const active: FileInfo[] = [];
	const prune: string[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const inWindow = entry.tags.filter((t): t is { path: string; mtimeMs: number } => t.mtimeMs !== null && now - t.mtimeMs < ACTIVE_WINDOW_MS);
		if (!holdsLease(entry.holder) && inWindow.length === 0) {
			prune.push(entry.file);
			continue;
		}
		for (const tag of inWindow) {
			if (seen.has(tag.path)) continue;
			seen.add(tag.path);
			active.push({ path: tag.path, mtime: tag.mtimeMs });
		}
	}
	return { active, prune };
}

function mtimeOrNull(file: string): number | null {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return null;
	}
}

function rosterError(what: string): Error {
	return new Error(`daemon roster: ${what}, so TPM reads 0 and no cooldown fires. Check that path and $XDG_STATE_HOME (wtft docs/spec-442-daemon-roster.md §2e)`);
}

function readRosters(dir: string): RosterEntry[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return [];
		throw rosterError(`cannot list ${dir} (${code ?? (err as Error).message})`);
	}
	const entries: RosterEntry[] = [];
	for (const name of names) {
		const m = /^(\d+)\.json(\.tmp)?$/.exec(name);
		if (!m) continue;
		const file = path.join(dir, name);
		const pid = Number(m[1]);
		let tags: string[] = [];
		let unreadable: string | null = null;
		if (!m[2]) {
			try {
				const doc = JSON.parse(fs.readFileSync(file, "utf8"));
				if (doc?.v !== 1 || doc.pid !== pid || !Array.isArray(doc.tags)) throw new Error("not a v1 roster for this pid");
				tags = doc.tags.filter((t: unknown): t is string => typeof t === "string");
			} catch (err) {
				unreadable = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
			}
		}
		const holder = classifyPid(pid);
		if (unreadable !== null && holdsLease(holder)) throw rosterError(`cannot read ${file} of live pid ${pid} (${unreadable})`);
		entries.push({ file, holder, tags: tags.map(t => ({ path: t, mtimeMs: mtimeOrNull(t) })) });
	}
	return entries;
}

function unlinkAll(files: string[]): void {
	for (const f of files) {
		try { fs.rmSync(f, { force: true }); } catch { /* left for a reader allowed to delete it */ }
	}
}

/** The tag files written in the last `ACTIVE_WINDOW_MS`, by any daemon's roster. Prunes as it reads. */
export function activeTagFiles(now: number): FileInfo[] {
	const { active, prune } = decideActive(readRosters(rosterDir()), now);
	unlinkAll(prune);
	return active;
}

export function pruneRoster(now: number): void {
	activeTagFiles(now);
}
