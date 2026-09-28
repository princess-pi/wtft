// bun --preload: counts node:fs calls whose path argument is under $WTFT_COUNT_FS_UNDER,
// and writes the count to $WTFT_COUNT_FS_OUT when the process exits.
import * as realFs from "node:fs";
import * as nodePath from "node:path";
import { mock } from "bun:test";

const root = nodePath.resolve(process.env.WTFT_COUNT_FS_UNDER);
const out = process.env.WTFT_COUNT_FS_OUT;
const writeOut = realFs.writeFileSync;
let count = 0;

function under(arg) {
	let p;
	if (typeof arg === "string") p = arg;
	else if (arg instanceof URL && arg.protocol === "file:") p = arg.pathname;
	else if (Buffer.isBuffer(arg)) p = arg.toString();
	else return false;
	const abs = nodePath.resolve(p);
	return abs === root || abs.startsWith(root + nodePath.sep);
}

function wrapAll(source) {
	const wrapped = {};
	for (const [name, value] of Object.entries(source)) {
		wrapped[name] = typeof value === "function" && /^[a-z]/.test(name)
			? function (...args) { if (under(args[0])) count++; return value.apply(this, args); }
			: value;
	}
	return wrapped;
}

const fs = wrapAll(realFs);
fs.promises = wrapAll(realFs.promises);
mock.module("node:fs", () => ({ ...fs, default: fs }));
mock.module("node:fs/promises", () => ({ ...fs.promises, default: fs.promises }));
process.on("exit", () => writeOut(out, String(count)));
