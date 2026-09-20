// Delete-only comment diet check: the ordered non-comment lines of each .ts file
// must be identical between a git ref and the working tree.
// Usage: bun debug/code-lines-unchanged.ts <base-ref> <file.ts>...
// Exit 0 identical, 1 some file differs.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// ---

// Regex-vs-division after these tokens is a heuristic; a misread shows up as a
// spurious diff, never a silent pass, because both sides lex the same way.
const REGEX_PRECEDERS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "return", "typeof", "case", "in", "of", "=>", ""]);

function stripComments(src: string): string[] {
	let out = "";
	let i = 0;
	let lastSig = "";
	const templateDepth: number[] = [];
	let braceDepth = 0;
	while (i < src.length) {
		const c = src[i], n = src[i + 1];
		if (c === "/" && n === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && n === "*") {
			const end = src.indexOf("*/", i + 2);
			const stop = end < 0 ? src.length : end + 2;
			for (let k = i; k < stop; k++) if (src[k] === "\n") out += "\n";
			i = stop;
			continue;
		}
		if (c === "'" || c === '"') {
			let j = i + 1;
			while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
			out += src.slice(i, j + 1);
			i = j + 1;
			lastSig = "str";
			continue;
		}
		if (c === "`" || (c === "}" && templateDepth.length && templateDepth[templateDepth.length - 1] === braceDepth)) {
			if (c === "}") templateDepth.pop();
			let j = i + 1;
			while (j < src.length && src[j] !== "`" && !(src[j] === "$" && src[j + 1] === "{")) j += src[j] === "\\" ? 2 : 1;
			if (src[j] === "$") {
				templateDepth.push(braceDepth);
				out += src.slice(i, j + 2);
				i = j + 2;
				lastSig = "(";
			} else {
				out += src.slice(i, j + 1);
				i = j + 1;
				lastSig = "str";
			}
			continue;
		}
		if (c === "/" && REGEX_PRECEDERS.has(lastSig)) {
			let j = i + 1, inClass = false;
			while (j < src.length && src[j] !== "\n" && (inClass || src[j] !== "/")) {
				if (src[j] === "\\") j++;
				else if (src[j] === "[") inClass = true;
				else if (src[j] === "]") inClass = false;
				j++;
			}
			j++;
			while (/[a-z]/i.test(src[j] ?? "")) j++;
			out += src.slice(i, j);
			i = j;
			lastSig = "str";
			continue;
		}
		if (c === "{") braceDepth++;
		if (c === "}") braceDepth--;
		if (/[A-Za-z0-9_$]/.test(c)) {
			let j = i;
			while (/[A-Za-z0-9_$]/.test(src[j] ?? "")) j++;
			lastSig = src.slice(i, j);
			out += lastSig;
			i = j;
			continue;
		}
		if (!/\s/.test(c)) lastSig = c;
		out += c;
		i++;
	}
	return out.split("\n").map(l => l.trim()).filter(Boolean);
}

// ---

const [base, ...files] = process.argv.slice(2);
let failed = 0;
for (const file of files) {
	const before = stripComments(execFileSync("git", ["show", `${base}:${file}`], { encoding: "utf8" }));
	const after = stripComments(readFileSync(file, "utf8"));
	const at = before.findIndex((l, k) => l !== after[k]);
	if (at >= 0 || before.length !== after.length) {
		failed++;
		const k = at >= 0 ? at : Math.min(before.length, after.length);
		console.log(`DIFF ${file} at code line ${k}:\n  - ${before[k]}\n  + ${after[k]}`);
	} else {
		console.log(`same ${file} (${after.length} code lines)`);
	}
}
process.exit(failed ? 1 : 0);
