// Preload for stock node (`node --import tests/lib/fs-read-spy.mjs …`): counts
// directory reads and bytes read per path, and writes them as JSON to
// $FS_SPY_OUT on exit. Bun does not route a bundle's `node:fs` imports through
// a patched module, so a read-count assertion has to run the bundle under node,
// where syncBuiltinESMExports() makes the patch visible to ESM importers.

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const origWrite = fs.writeFileSync;
const readdirCalls = {};
const bytesRead = {};
const fdPaths = new Map();

const add = (table, key, n) => { table[key] = (table[key] ?? 0) + n; };

const origReaddir = fs.readdirSync;
fs.readdirSync = function (p, ...rest) {
	add(readdirCalls, String(p), 1);
	return origReaddir.call(this, p, ...rest);
};

const origReadFile = fs.readFileSync;
fs.readFileSync = function (p, ...rest) {
	const out = origReadFile.call(this, p, ...rest);
	if (typeof p === "string") add(bytesRead, p, typeof out === "string" ? Buffer.byteLength(out) : out.byteLength);
	return out;
};

const origOpen = fs.openSync;
fs.openSync = function (p, ...rest) {
	const fd = origOpen.call(this, p, ...rest);
	if (typeof p === "string") fdPaths.set(fd, p);
	return fd;
};

const origRead = fs.readSync;
fs.readSync = function (fd, ...rest) {
	const n = origRead.call(this, fd, ...rest);
	const p = fdPaths.get(fd);
	if (p) add(bytesRead, p, n);
	return n;
};

syncBuiltinESMExports();

process.on("exit", () => {
	if (process.env.FS_SPY_OUT) {
		origWrite(process.env.FS_SPY_OUT, JSON.stringify({ readdirCalls, bytesRead }));
	}
});
