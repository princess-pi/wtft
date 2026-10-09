/**
 * A lease file: one small file whose whole content names its holder, a pid or
 * the token `rebuild`. Every claim, release and replacement of one goes through
 * here. An unlink happens only when the lease still holds what the caller
 * read, on the same inode; a conditional replace compares content only.
 */

import * as fs from "node:fs";
import { classifyPid, holdsLease, pidAlive } from "./holder.js";

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
 * `expected`, only when the lock was taken and the lease still holds it, else
 * false. True when written. Throws when the write itself fails.
 */
export function replaceLease(file: string, value: string, owner: string, expected?: string): boolean {
	const lock = `${file}.lock`;
	const locked = takeLock(lock, owner);
	try {
		if (expected !== undefined && (!locked || leaseHolder(file) !== expected)) return false;
		return publish(file, value, owner);
	} finally {
		if (locked) unlinkLeaseIf(lock, owner);
	}
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

function publish(file: string, value: string, owner: string): true {
	const replacement = `${file}.replace-${owner}`;
	try {
		fs.writeFileSync(replacement, value);
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

