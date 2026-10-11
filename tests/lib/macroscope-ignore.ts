/**
 * Macroscope ignore-file glob rules (https://docs.macroscope.com/code-review/ignore-files):
 * `**` crosses directories, `*` stays in one segment, `?` is one character, and a pattern with
 * no `/` matches at any depth.
 */

/** Takes ignore-file text; returns its patterns verbatim (untrimmed), dropping empty lines and lines starting `#`. */
export function parseIgnoreFile(text: string): string[] {
	return text
		.split("\n")
		.map(l => l.replace(/\r$/, ""))
		.filter(l => l !== "" && !l.startsWith("#"));
}

function globToRegExp(pattern: string): RegExp {
	if (/[!\[\]{}]/.test(pattern) || pattern !== pattern.trim()) {
		throw new Error(`unsupported ignore pattern: ${JSON.stringify(pattern)}`);
	}
	let re = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]!;
		if (c === "*" && pattern[i + 1] === "*") {
			if (pattern[i + 2] === "/") {
				re += "(?:.*/)?";
				i += 2;
			} else {
				re += ".*";
				i += 1;
			}
		} else if (c === "*") {
			re += "[^/]*";
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${pattern.includes("/") ? "" : "(?:.*/)?"}${re}$`);
}

/** Takes a repo-relative path and ignore patterns; returns whether any pattern matches the path. Throws on a pattern with `!`, `[`, `]`, `{`, `}` or surrounding whitespace, which the documented rules do not define. */
export function isIgnored(file: string, patterns: readonly string[]): boolean {
	return patterns.some(p => globToRegExp(p).test(file));
}
