/**
 * A lease file: one small file whose whole content names its holder, a pid or
 * the token `rebuild`. Every claim, release and replacement of one goes through
 * here. An unlink happens only when the lease still holds what the caller
 * read, on the same inode; a conditional replace compares content only.
 */

import * as fs from "node:fs";
import { classifyPid, holdsLease, pidAlive, processTable, sessionArgOf } from "./holder.js";

export interface LeaseIdentity {
	dev: number;
	ino: number;
}

/** What the lease names, or "" when there is none or it cannot be read. */
export function leaseHolder(file: string): string {
	try { return fs.readFileSync(file, "utf8").trim(); } catch { return ""; }
}

export function leaseIdentity(file: string): LeaseIdentity | null {
	try {
		const st = fs.statSync(file);
		return { dev: st.dev, ino: st.ino };
	} catch {
		return null;
	}
}

/**
 * Unlink `file` if it still holds `value` — and, when `observed` is given, if
 * it is still the inode the caller observed. True when it was removed.
 */
export function unlinkLeaseIf(file: string, value: string, observed?: LeaseIdentity): boolean {
	try {
		const before = fs.statSync(file);
		if (observed && (before.dev !== observed.dev || before.ino !== observed.ino)) return false;
		if (fs.readFileSync(file, "utf8").trim() !== value) return false;
		const now = fs.statSync(file);
		if (now.dev !== before.dev || now.ino !== before.ino) return false;
		fs.unlinkSync(file);
		return true;
	} catch {
		return false;
	}
}

const REPLACE_LOCK_WAIT_MS = 5000;

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Publish `value` at `file` through a rename, so no reader sees an empty
 * lease. It first takes `<file>.lock`, waiting up to `REPLACE_LOCK_WAIT_MS`; a
 * lock naming a dead owner, or older than that, is taken over. With
 * `expected`, only when the lock was taken, and, just before the rename, it
 * still holds the lock and the lease still holds `expected`; else false. True
 * when written. Throws when the write itself fails.
 */
export function replaceLease(file: string, value: string, owner: string, expected?: string): boolean {
	const lock = `${file}.lock`;
	const locked = takeLock(lock, owner);
	try {
		if (expected !== undefined && !locked) return false;
		return publish(file, value, owner, () => expected === undefined || (leaseHolder(lock) === owner && leaseHolder(file) === expected));
	} finally {
		if (locked) unlinkLeaseIf(lock, owner);
	}
}

/** Wait, up to `REPLACE_LOCK_WAIT_MS`, for a `replaceLease` of `file` in flight to finish. */
export function awaitLeaseReplace(file: string, owner: string): void {
	const lock = `${file}.lock`;
	if (takeLock(lock, owner)) unlinkLeaseIf(lock, owner);
}

function takeLock(lock: string, owner: string): boolean {
	const held = (holder: string) => pidAlive(leasePid(holder)) && lockAgeMs(lock) < REPLACE_LOCK_WAIT_MS;
	for (const until = Date.now() + REPLACE_LOCK_WAIT_MS; ;) {
		if (claimLease(lock, owner, held) === "claimed") return true;
		if (Date.now() >= until) return false;
		sleepSync(5);
	}
}

function lockAgeMs(lock: string): number {
	try { return Date.now() - fs.statSync(lock).mtimeMs; } catch { return 0; }
}

function publish(file: string, value: string, owner: string, ready: () => boolean): boolean {
	const replacement = `${file}.replace-${owner}`;
	try {
		fs.writeFileSync(replacement, value);
		if (!ready()) {
			fs.rmSync(replacement, { force: true });
			return false;
		}
		fs.renameSync(replacement, file);
		return true;
	} catch (err) {
		try { fs.unlinkSync(replacement); } catch { /* never written */ }
		throw err;
	}
}

/**
 * Claim `file` for `owner` with an exclusive hard link. A lease already naming
 * `owner` is claimed. One naming a holder `holderIsLive` accepts is busy. Any
 * other holder is stale: it is unlinked, re-proved, and the claim retried once.
 * A stale `rebuild` token is left owed first, and the claim is busy when it
 * cannot be: see `takeRebuildOwed`.
 */
export function claimLease(file: string, owner: string, holderIsLive: (holder: string) => boolean): "claimed" | "busy" {
	const existing = leaseHolder(file);
	if (existing === owner) return "claimed";
	if (existing && holderIsLive(existing)) return "busy";
	const candidate = `${file}.claim-${owner}`;
	try {
		fs.writeFileSync(candidate, owner);
		try {
			fs.linkSync(candidate, file);
			return "claimed";
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		// Lost the link to a lease that appeared meanwhile: read it, and take
		// it only if its holder is not live.
		const holder = leaseHolder(file);
		if (holder === owner) return "claimed";
		if (holder && holderIsLive(holder)) return "busy";
		if (holder === "rebuild") {
			try { fs.writeFileSync(owedPath(file), ""); } catch { return "busy"; }
		}
		// An empty lease is a stale one too: `unlinkLeaseIf` matches "" on an empty file.
		unlinkLeaseIf(file, holder);
		try {
			fs.linkSync(candidate, file);
			return "claimed";
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") return "busy";
			throw err;
		}
	} finally {
		try { fs.unlinkSync(candidate); } catch { /* already gone */ }
	}
}

/**
 * Claim `file` for `owner` from a per-session daemon serving it: SIGTERM it, up to 20 times
 * 50 ms apart, then claim. A daemon whose `--session` `servesLease` rejects holds `file`
 * stale and is never signalled. False at once for a harness holder, and after the 20th try.
 */
export function takeOverLease(file: string, owner: string, servesLease: (session: string) => boolean, wait: (ms: number) => void = sleepSync): boolean {
	const ownerPid = leasePid(owner);
	const holds = (holder: string): boolean => {
		const pid = leasePid(holder);
		if (pid === ownerPid) return false;
		const kind = classifyPid(pid);
		if (kind === "harness") return true;
		if (kind !== "daemon") return false;
		const session = sessionArgOf(pid);
		return session !== null && servesLease(session);
	};
	for (let attempt = 0; attempt < 20; attempt++) {
		if (claimLease(file, owner, holds) === "claimed") return true;
		const holder = leaseHolder(file);
		if (holder === owner) return true;
		const pid = leasePid(holder);
		if (classifyPid(pid) === "harness") return false;
		if (holds(holder)) processTable().signal(pid, "SIGTERM");
		wait(50);
	}
	return claimLease(file, owner, holds) === "claimed";
}

/**
 * Take the rebuild a claim on `file` left owed when it unlinked a `rebuild`
 * token, whichever process made that claim. True when one was owed and is now
 * taken; the caller rebuilds.
 */
export function takeRebuildOwed(file: string): boolean {
	try {
		fs.unlinkSync(owedPath(file));
		return true;
	} catch {
		return false;
	}
}

/** Whether a rebuild is owed on `file`, without taking it. */
export function rebuildIsOwed(file: string): boolean {
	return fs.existsSync(owedPath(file));
}

function owedPath(file: string): string {
	return `${file}.rebuild`;
}

/** The pid a lease holder names, or 0 when it is not one. */
export function leasePid(holder: string): number {
	return /^[1-9]\d*$/.test(holder) ? Number(holder) : 0;
}

/**
 * Claim `file` for a daemon the caller has just spawned, so the lease names a
 * live process from the moment of the spawn. A `rebuild` token and a live
 * holder are left for the child to meet as it would without this claim.
 */
export function claimLeaseForChild(file: string, childPid: number): "claimed" | "busy" {
	const result = claimLease(file, String(childPid), (holder) =>
		holder === "rebuild" || holdsLease(classifyPid(leasePid(holder))));
	// A child gone before the claim landed must not be left named.
	if (result === "claimed" && !pidAlive(childPid)) {
		unlinkLeaseIf(file, String(childPid));
		return "busy";
	}
	return result;
}

