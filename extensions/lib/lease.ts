/**
 * A lease file: one small file whose whole content names its holder, a pid or
 * the token `rebuild`. Every claim, release and replacement of one goes through
 * here, so the re-prove-then-act rule lives once: a lease is only unlinked or
 * replaced when it still holds what the caller read, on the same inode.
 */

import * as fs from "node:fs";

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

/**
 * Publish `value` at `file` through a rename, so no reader sees an empty
 * lease. With `expected`, only when the lease still holds it; true when
 * written. Throws when the write itself fails.
 */
export function replaceLease(file: string, value: string, owner: string, expected?: string): boolean {
	const replacement = `${file}.replace-${owner}`;
	try {
		fs.writeFileSync(replacement, value);
		if (expected !== undefined && leaseHolder(file) !== expected) {
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
		if (holder) unlinkLeaseIf(file, holder);
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
