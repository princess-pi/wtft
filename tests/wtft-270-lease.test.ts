#!/usr/bin/env -S bun
/**
 * #270 S2 — the lease module: claim, release and replace on temp files, no
 * daemon spawned. The matrix is {absent, mine, live holder, dead holder,
 * rebuild token} × {claim, unlinkLeaseIf, replaceLease}.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claimLease, unlinkLeaseIf, replaceLease, leaseHolder, leaseIdentity } from "../extensions/lib/lease.ts";
import { trackSandbox } from "./lib/sandbox";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-270-lease-")));
let n = 0;
const fresh = (content?: string) => {
	const file = path.join(dir, `lease-${++n}.pid`);
	if (content !== undefined) fs.writeFileSync(file, content);
	return file;
};
const live = (holder: string) => holder === "4242";
const ME = "777";

console.log("\nPART C — claim");
{
	const f = fresh();
	check(claimLease(f, ME, live) === "claimed" && leaseHolder(f) === ME, "C1 an absent lease is claimed and names the owner");
	check(claimLease(f, ME, live) === "claimed", "C2 a lease already naming the owner is claimed again");
	check(fs.readdirSync(dir).every(name => !name.includes(".claim-")), "C3 no claim candidate is left behind");
}
{
	const f = fresh("4242");
	check(claimLease(f, ME, live) === "busy" && leaseHolder(f) === "4242", "C4 a live holder is busy, and keeps the lease");
}
{
	const f = fresh("999");
	check(claimLease(f, ME, live) === "claimed" && leaseHolder(f) === ME, "C5 a dead holder is replaced");
}
{
	const f = fresh("rebuild");
	check(claimLease(f, ME, live) === "claimed" && leaseHolder(f) === ME, "C6 the rebuild token is a stale holder to a claim; the caller reads it first");
}
{
	const f = fresh("");
	check(claimLease(f, ME, live) === "claimed" && leaseHolder(f) === ME, "C7 an empty lease is claimed");
}

console.log("\nPART U — unlinkLeaseIf");
{
	const f = fresh(ME);
	check(unlinkLeaseIf(f, "other") === false && fs.existsSync(f), "U1 a value mismatch unlinks nothing");
	check(unlinkLeaseIf(f, ME) === true && !fs.existsSync(f), "U2 a match unlinks");
	check(unlinkLeaseIf(f, ME) === false, "U3 an absent lease is false");
}
{
	const f = fresh(ME);
	const observed = leaseIdentity(f)!;
	fs.unlinkSync(f);
	fs.writeFileSync(f, ME);
	check(unlinkLeaseIf(f, ME, observed) === false && fs.existsSync(f), "U4 the same value on a new inode is not the lease that was observed");
	check(unlinkLeaseIf(f, ME, leaseIdentity(f)!) === true, "U5 the observed inode unlinks");
}

console.log("\nPART R — replaceLease");
{
	const f = fresh(ME);
	check(replaceLease(f, "rebuild", ME) === true && leaseHolder(f) === "rebuild", "R1 an unconditional replace lands");
	check(replaceLease(f, "1", ME, "nope") === false && leaseHolder(f) === "rebuild", "R2 an expected value that no longer holds writes nothing");
	check(replaceLease(f, "1", ME, "rebuild") === true && leaseHolder(f) === "1", "R3 an expected value that holds is replaced");
	check(fs.readdirSync(dir).every(name => !name.includes(".replace-")), "R4 no replacement file is left behind");
}
{
	const f = fresh();
	check(replaceLease(f, ME, ME) === true && leaseHolder(f) === ME, "R5 a replace creates an absent lease");
	let threw = false;
	try { replaceLease(path.join(dir, "missing-dir", "x.pid"), ME, ME); } catch { threw = true; }
	check(threw, "R6 a write that cannot land throws");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
