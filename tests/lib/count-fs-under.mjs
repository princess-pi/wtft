// bun --preload: counts node:fs calls whose path argument is under a directory in $WTFT_COUNT_FS_UNDER
// (path-delimiter separated),
// and writes the count to $WTFT_COUNT_FS_OUT when the process exits.
import * as realFs from "node:fs";
import * as nodePath from "node:path";
import { mock } from "bun:test";

const roots = process.env.WTFT_COUNT_FS_UNDER.split(nodePath.delimiter).map(r => nodePath.resolve(r));
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
	return roots.some(root => abs === root || abs.startsWith(root + nodePath.sep));
}

function counting(fn) {
	const wrapper = function (...args) { if (under(args[0])) count++; return fn.apply(this, args); };
	for (const key of Reflect.ownKeys(fn)) {
		if (key === "length" || key === "name" || key === "prototype") continue;
		const desc = Object.getOwnPropertyDescriptor(fn, key);
		if (typeof desc.value === "function") desc.value = counting(desc.value);
		Object.defineProperty(wrapper, key, desc);
	}
	return wrapper;
}

function wrapAll(source) {
	const wrapped = {};
	for (const [name, value] of Object.entries(source)) {
		if (typeof value !== "function" || !/^[a-z]/.test(name)) { wrapped[name] = value; continue; }
		wrapped[name] = counting(value);
	}
	return wrapped;
}

const fs = wrapAll(realFs);
fs.promises = wrapAll(realFs.promises);
mock.module("node:fs", () => ({ ...fs, default: fs }));
mock.module("node:fs/promises", () => ({ ...fs.promises, default: fs.promises }));
process.on("exit", () => writeOut(out, String(count)));
