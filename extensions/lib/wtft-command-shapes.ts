/**
 * @package @princess-pi/wtft
 * @module wtft-command-shapes
 * @description What a bash command STRING is made of — and nothing about what
 *   it means. The meaning lives in `wtft-parser.ts`'s classifier.
 *
 *   Split once, quote/heredoc/substitution-aware, into the commands a shell
 *   would run — rather than rewriting the string with leading-prefix regexes.
 *   Deliberately NOT a shell parser. A command it cannot read comes back whole.
 */

// ---
// SEGMENTATION
// ---

/**
 * Shell operators that end one command and begin the next, longest first.
 *
 * A bare `&` is deliberately NOT here. It backgrounds a command rather than
 * introducing a different one, and `2>&1` — which appears on a large share of
 * real commands — would otherwise split into `… 2>` and `1`, inventing a
 * command called `1`.
 */
const SEPARATORS = ["&&", "||", "|&", ";;", ";", "|", "\n"];

/**
 * Anything that could make a command string more than one command: a separator,
 * a quote, a substitution, a heredoc, a comment, or a line continuation.
 *
 * A string with none of these is one command, and the character walk below can
 * be skipped entirely. Most real commands are short and simple, so the bail is
 * taken on the large majority of them.
 */
const NEEDS_SPLIT = /[;|&'"`\n#\\]|\$\(/;

/** One command, plus the operator that joined it to the one before it. */
export interface JoinedSegment {
	text: string;
	/** "" for the first segment; otherwise `&&`, `||`, `;`, `|`, `|&`, `;;` or "\n". */
	joinedBy: string;
}

/**
 * Like `extractCommandSegments`, but keeps the operator that preceded each
 * command.
 *
 * The operator is the difference between "then" and "only if that failed".
 * `cd /real 2>/dev/null || cd /tmp` runs the second `cd` only when the first
 * fails — so for a spawn that follows, the FIRST is almost always the real
 * directory. "Last one wins" attributes cost to the wrong project directory.
 */
export function extractJoinedSegments(cmd: string): JoinedSegment[] {
	return splitSegments(cmd);
}

/**
 * Split a bash command string into the individual commands a shell would run.
 *
 * Quote-, heredoc- and substitution-aware: separators inside `'…'`, `"…"`,
 * `$(…)`, `` `…` `` or a heredoc body are literal text, not splits. A heredoc
 * body stays attached to the command that opened it, which is what lets an
 * inline `python3 - <<'PY' … PY` be classified by the paths inside its script.
 *
 * Use `extractJoinedSegments` when the operator BETWEEN commands matters — it
 * is the difference between "and then" and "only if that failed".
 */
export function extractCommandSegments(cmd: string): string[] {
	return splitSegments(cmd).map(s => s.text);
}

function splitSegments(cmd: string): JoinedSegment[] {
	const trimmed = cmd.trim();
	if (!NEEDS_SPLIT.test(trimmed)) return trimmed ? [{ text: trimmed, joinedBy: "" }] : [];

	const segments: JoinedSegment[] = [];
	let nextJoin = "";
	let buf = "";
	let i = 0;
	const n = cmd.length;

	// Heredoc delimiters opened on the current line, consumed at the next newline.
	let pendingHeredocs: { delim: string; stripTabs: boolean }[] = [];
	// Index of the already-pushed segment that opened those heredocs, or -1 when
	// the opener is still in `buf`. `python3 - <<'PY' | sort` pushes the opener
	// at the `|` BEFORE the body is reached — body must stay on the opener.
	let heredocOwner = -1;

	const push = () => {
		const t = buf.trim();
		if (t) {
			segments.push({ text: t, joinedBy: nextJoin });
			if (pendingHeredocs.length > 0 && heredocOwner === -1) heredocOwner = segments.length - 1;
		}
		buf = "";
	};

	while (i < n) {
		const c = cmd[i]!;

		// Line continuation: a backslash-newline is whitespace, not a command.
		if (c === "\\" && cmd[i + 1] === "\n") { buf += " "; i += 2; continue; }
		if (c === "\\" && i + 1 < n) { buf += c + cmd[i + 1]; i += 2; continue; }

		// Single quotes: no escapes, no expansion — copy verbatim to the close.
		if (c === "'") {
			const end = cmd.indexOf("'", i + 1);
			if (end === -1) { buf += cmd.slice(i); break; }
			buf += cmd.slice(i, end + 1); i = end + 1; continue;
		}

		// Double quotes: escapes apply; `$( )` and backticks inside are still
		// nested, but nothing in them can separate commands, so copy through.
		if (c === '"') {
			let j = i + 1;
			while (j < n) {
				if (cmd[j] === "\\") { j += 2; continue; }
				if (cmd[j] === '"') break;
				j++;
			}
			buf += cmd.slice(i, Math.min(j + 1, n)); i = j + 1; continue;
		}

		// Command substitution: `$( … )` nests, so count depth rather than
		// scanning for the first `)`. Quote-aware: a paren inside a quoted
		// string is text, not structure.
		if (c === "$" && cmd[i + 1] === "(") {
			let depth = 0, j = i + 1;
			for (; j < n; j++) {
				const d = cmd[j]!;
				if (d === "\\") { j++; continue; }
				if (d === "'") { const e = cmd.indexOf("'", j + 1); if (e === -1) { j = n; break; } j = e; continue; }
				if (d === '"') {
					let k = j + 1;
					while (k < n && cmd[k] !== '"') { if (cmd[k] === "\\") k++; k++; }
					j = k; continue;
				}
				if (d === "(") depth++;
				else if (d === ")") { depth--; if (depth === 0) break; }
			}
			buf += cmd.slice(i, Math.min(j + 1, n)); i = j + 1; continue;
		}
		if (c === "`") {
			const end = cmd.indexOf("`", i + 1);
			if (end === -1) { buf += cmd.slice(i); break; }
			buf += cmd.slice(i, end + 1); i = end + 1; continue;
		}

		// Heredoc opener: remember the delimiter; the body is consumed when the
		// line ends. `<<-` strips leading tabs from the terminator.
		if (c === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
			let j = i + 2;
			const stripTabs = cmd[j] === "-";
			if (stripTabs) j++;
			while (j < n && (cmd[j] === " " || cmd[j] === "\t")) j++;
			let delim = "";
			if (cmd[j] === "'" || cmd[j] === '"') {
				const q = cmd[j]!;
				const end = cmd.indexOf(q, j + 1);
				if (end !== -1) { delim = cmd.slice(j + 1, end); j = end + 1; }
			} else {
				const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(cmd.slice(j));
				if (m) { delim = m[0]; j += m[0].length; }
			}
			if (delim) {
				pendingHeredocs.push({ delim, stripTabs });
				buf += cmd.slice(i, j); i = j; continue;
			}
		}

		// A newline with heredocs pending: swallow every body before splitting.
		if (c === "\n" && pendingHeredocs.length > 0) {
			let j = i + 1;
			for (const { delim, stripTabs } of pendingHeredocs) {
				while (j < n) {
					const lineEnd = cmd.indexOf("\n", j);
					const line = cmd.slice(j, lineEnd === -1 ? n : lineEnd);
					const probe = stripTabs ? line.replace(/^\t+/, "") : line;
					j = lineEnd === -1 ? n : lineEnd + 1;
					if (probe.trim() === delim) break;
				}
			}
			const body = cmd.slice(i, j);
			if (heredocOwner >= 0) segments[heredocOwner]!.text += body;
			else buf += body;
			pendingHeredocs = [];
			heredocOwner = -1;
			i = j;
			// The delimiter line's terminating newline was consumed with the
			// body — close the segment explicitly or everything after the heredoc
			// is glued onto it.
			push();
			nextJoin = "\n";
			continue;
		}

		// A `#` that starts a word begins a comment to end of line.
		if (c === "#" && (buf === "" || /\s$/.test(buf))) {
			const end = cmd.indexOf("\n", i);
			if (end === -1) break;
			i = end; continue;
		}

		const sep = SEPARATORS.find(s => cmd.startsWith(s, i));
		if (sep) { push(); nextJoin = sep; i += sep.length; continue; }

		buf += c; i++;
	}
	push();
	return segments;
}

// ---
// WORDS AND REDIRECTIONS
// ---

/** One command, taken apart: its argument words and its redirection targets. */
export interface CommandWords {
	/** argv, quotes removed, redirections and heredoc openers excluded. */
	words: string[];
	/** Targets of `>` / `>>` — files the command writes. */
	writes: string[];
	/** Targets of `<` — files the command reads. */
	reads: string[];
}

/**
 * Split one command into words and redirection targets, quote-aware.
 *
 * A regex over the raw string reads `>` inside a quoted argument as a
 * redirection — `git commit -m "fix > bug"` would fabricate a WRITE to `bug`.
 * Quoting decides whether `>` is an operator, so the scan has to know it.
 * The heredoc BODY is ignored: only the opener's line carries arguments.
 */
export function splitCommandWords(cmd: string): CommandWords {
	const head = cmd.split("\n", 1)[0]!;
	const words: string[] = [];
	const writes: string[] = [];
	const reads: string[] = [];
	let cur = "";
	let pending: "write" | "read" | null = null;
	let i = 0;

	const flush = () => {
		if (!cur) return;
		if (pending === "write") writes.push(cur);
		else if (pending === "read") reads.push(cur);
		else words.push(cur);
		pending = null;
		cur = "";
	};

	while (i < head.length) {
		const c = head[i]!;
		if (c === "\\") { cur += head[i + 1] ?? ""; i += 2; continue; }
		if (c === "'") {
			const e = head.indexOf("'", i + 1);
			cur += e === -1 ? head.slice(i + 1) : head.slice(i + 1, e);
			i = e === -1 ? head.length : e + 1;
			continue;
		}
		if (c === '"') {
			let j = i + 1, out = "";
			while (j < head.length && head[j] !== '"') {
				if (head[j] === "\\") { out += head[j + 1] ?? ""; j += 2; continue; }
				out += head[j]!; j++;
			}
			cur += out;
			i = j + 1;
			continue;
		}
		if (/\s/.test(c)) { flush(); i++; continue; }
		// A HERE-STRING (`<<<`) feeds a literal, not a file — skipping it left
		// the third `<` to be read as an input redirection.
		if (c === "<" && head[i + 1] === "<" && head[i + 2] === "<") {
			flush();
			i += 3;
			while (i < head.length && /\s/.test(head[i]!)) i++;
			// Consume the literal word or quoted run; it is data, not a path.
			if (head[i] === "'" || head[i] === '"') {
				const q = head[i]!;
				const e = head.indexOf(q, i + 1);
				i = e === -1 ? head.length : e + 1;
			} else {
				while (i < head.length && !/\s/.test(head[i]!)) i++;
			}
			continue;
		}
		// A heredoc opener is not a redirection and its delimiter is not a file.
		if (c === "<" && head[i + 1] === "<") {
			flush();
			i += 2;
			if (head[i] === "-") i++;
			while (i < head.length && /\s/.test(head[i]!)) i++;
			if (head[i] === "'" || head[i] === '"') {
				const q = head[i]!;
				const e = head.indexOf(q, i + 1);
				i = e === -1 ? head.length : e + 1;
			} else {
				while (i < head.length && /[A-Za-z0-9_]/.test(head[i]!)) i++;
			}
			continue;
		}
		// A `>` inside quotes never reaches here — the quote handlers consume
		// the whole quoted run. Any `>` here IS an operator, including one that
		// abuts a closing quote: `echo "a">out`.
		if (c === ">" || c === "<") {
			// `2>`/`1>` — the leading fd digit already landed in `cur`.
			if (/^\d$/.test(cur)) cur = "";
			flush();
			pending = c === ">" ? "write" : "read";
			i++;
			if (head[i] === ">") i++;         // >>
			if (head[i] === "&") {            // 2>&1 — a descriptor, not a file
				i++;
				while (i < head.length && /[\d-]/.test(head[i]!)) i++;
				pending = null;
			}
			continue;
		}
		cur += c;
		i++;
	}
	flush();
	return { words, writes, reads };
}

// ---
// SCAFFOLDING
// ---

/**
 * Wrapper commands whose argument IS the command that matters.
 *
 * Every option that CONSUMES A FOLLOWING WORD has to be spelled out, not folded
 * into a generic `-\S+`. `timeout -k 5 200 bun test` must not read duration as
 * `5` and leave `200 bun test` as the command; `sudo -u root git status` must
 * not yield a command named `root`.
 */
const WRAPPER = new RegExp(
	"^(?:" +
	[
		// timeout: value-taking options, THEN the mandatory duration.
		"timeout(?:\\s+(?:-k|--kill-after|-s|--signal)(?:=\\S+|\\s+\\S+)|\\s+(?:--preserve-status|--foreground|-[a-zA-Z]\\S*))*\\s+\\S+",
		"time(?:\\s+(?:-o|--output|-f|--format)(?:=\\S+|\\s+\\S+)|\\s+-[a-zA-Z]\\S*)*",
		"nice(?:\\s+(?:-n|--adjustment)(?:=\\S+|\\s+-?\\d+)|\\s+-\\d+)?",
		"ionice(?:\\s+(?:-c|-n|-p)(?:=\\S+|\\s+\\S+)|\\s+-[a-zA-Z]\\S*)*",
		"nohup",
		"stdbuf(?:\\s+(?:-i|-o|-e)(?:=\\S+|\\s+\\S+))*",
		"command",
		"builtin",
		"exec",
		// sudo: -u/-g/-U/-p/-C/-D/-h all take the next word.
		"sudo(?:\\s+(?:-u|-g|-U|-p|-C|-D|-h|--user|--group|--prompt)(?:=\\S+|\\s+\\S+)|\\s+-[a-zA-Z]\\S*)*",
		"doas(?:\\s+-u\\s+\\S+|\\s+-[a-zA-Z]\\S*)*",
		// env: flags, `-u NAME` pairs (two words), and assignments, in any order.
		"env(?:\\s+(?:-u|--unset)(?:=\\S+|\\s+[A-Za-z_][A-Za-z0-9_]*)|\\s+-[A-Za-z]+|\\s+[A-Za-z_][A-Za-z0-9_]*=(?:\"[^\"]*\"|'[^']*'|\\S*))*",
		// xargs: -I/-n/-P/-d/-a/-E/-s all take the next word.
		"xargs(?:\\s+(?:-I|-i|-n|-P|-d|-a|-E|-s|--replace|--max-args|--max-procs|--delimiter)(?:=\\S+|\\s+\\S+)|\\s+-[a-zA-Z]\\S*)*",
		"script\\s+-qc",
	].join("|") +
	")\\s+",
);

/** Leading `VAR=value` assignments, including a `$( … )` value with spaces. */
const ASSIGNMENT = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`|[^\s;&|]*)[ \t]*)+/;

/** Declaration builtins that only ever introduce assignments. */
const DECLARE = /^(?:export|declare|local|readonly|typeset|set)\s+/;

/** Loop/branch openers and closers — grammar, never work. */
const KEYWORD = /^(?:for|while|until|if|elif|else|then|do|done|fi|case|esac|in|select|function|coproc|\}|\(|\)|!)(?:\s|$)/;

/**
 * A function DEFINITION — the body is not an invocation.
 * BOTH spellings: `name() { … }` and bash's `function name { … }`.
 */
const FUNCTION_DEF = /^(?:[A-Za-z_][A-Za-z0-9_-]*\s*\(\s*\)|function\s+[A-Za-z_][A-Za-z0-9_-]*)/;

/**
 * Net brace nesting introduced by a segment, ignoring braces inside quotes.
 * A `}` in a string is text, not structure.
 */
function braceDelta(segment: string): number {
	let depth = 0;
	for (let i = 0; i < segment.length; i++) {
		const c = segment[i]!;
		if (c === "\\") { i++; continue; }
		if (c === "'") { const e = segment.indexOf("'", i + 1); i = e === -1 ? segment.length : e; continue; }
		if (c === '"') {
			let j = i + 1;
			while (j < segment.length && segment[j] !== '"') { if (segment[j] === "\\") j++; j++; }
			i = j; continue;
		}
		if (c === "{") depth++;
		else if (c === "}") depth--;
	}
	return depth;
}

/** Navigation and test builtins: real commands, but not work worth a category. */
const NAVIGATION = /^(?:cd|pushd|popd|dirs|\[|\[\[|test|:|true|false)(?:\s|$)/;

/** Pure-wait commands — scaffolding only INSIDE a loop body (see below). */
const WAIT_ONLY = /^(?:sleep|wait|usleep)(?:\s|$)/;

/**
 * Strip every prefix that is not the command: `do`/`then`, assignments,
 * declaration builtins, and wrappers. Applied repeatedly, because they stack
 * (`do PATH=… timeout 200 bun test …`).
 */
export function stripCommandPrefixes(segment: string): string {
	let s = segment.trim();
	for (let pass = 0; pass < 12; pass++) {
		const before = s;
		// `else` introduces an ARM — the command after it is work. `elif` is NOT
		// here: what follows it is a condition.
		s = s.replace(/^(?:do|then|else|!)\s+/, "");
		// A brace GROUP runs its body — unlike a function definition.
		s = s.replace(/^\{\s+/, "");
		// A SUBSHELL group runs its body too. Closing `)` still dropped by KEYWORD.
		s = s.replace(/^\(\s*/, "");
		s = s.replace(DECLARE, "");
		s = s.replace(ASSIGNMENT, "");
		s = s.replace(WRAPPER, "");
		s = s.trim();
		if (s === before) break;
	}
	return s;
}

/**
 * One segment, reduced to the command it runs — or `""` when it runs none.
 *
 * `inLoopBody`: `sleep 15` is ordinary work at top level and pure scaffolding
 * between `do` and `done`. Treating a wait-loop's `sleep` as the command hides
 * the work the loop was waiting to do.
 */
export function reduceSegment(segment: string, inLoopBody = false): string {
	const s = stripCommandPrefixes(segment);
	if (!s) return "";
	if (FUNCTION_DEF.test(s)) return "";
	if (KEYWORD.test(s)) return "";
	if (NAVIGATION.test(s)) return "";
	if (inLoopBody && WAIT_ONLY.test(s)) return "";
	return s;
}

/**
 * Every real command in a bash string, scaffolding removed, in order.
 * This is what the classifier reads.
 *
 * Memo: the same command string is segmented up to three times per turn, and a
 * session replays the same commands across every render. Bounded, cleared
 * wholesale — a simple ceiling beats an LRU for a batch tool.
 */
const REAL_COMMAND_CACHE = new Map<string, string[]>();
const REAL_COMMAND_CACHE_MAX = 4096;

export function extractRealCommands(cmd: string): string[] {
	const cached = REAL_COMMAND_CACHE.get(cmd);
	if (cached) return cached;
	const computed = computeRealCommands(cmd);
	if (REAL_COMMAND_CACHE.size >= REAL_COMMAND_CACHE_MAX) REAL_COMMAND_CACHE.clear();
	REAL_COMMAND_CACHE.set(cmd, computed);
	return computed;
}

function computeRealCommands(cmd: string): string[] {
	const out: string[] = [];
	let loopDepth = 0;
	// Brace depth inside a function DEFINITION. A definition runs nothing —
	// dropping only the `name() {` segment would leave the body as top-level.
	let fnDepth = 0;
	for (const segment of extractCommandSegments(cmd)) {
		const raw = segment.trim();
		if (fnDepth > 0) {
			fnDepth += braceDelta(raw);
			continue;
		}
		if (FUNCTION_DEF.test(stripCommandPrefixes(raw))) {
			// The `{` already in this segment IS the opening brace — counting an
			// extra level for the definition itself left the depth stuck at 1
			// after the closing `}`, so every later command was swallowed too.
			fnDepth = Math.max(0, braceDelta(raw));
			continue;
		}
		// Depth is read off the RAW segment, before any prefix stripping: `do`
		// and `done` are exactly what stripCommandPrefixes and reduceSegment
		// remove, so by the time they are gone there is nothing left to count.
		// The body opens on the `do` segment itself, so the increment has to
		// happen BEFORE that segment is reduced — the first `sleep` of a wait
		// loop lives on the same segment as its `do`.
		if (/^do(?:\s|$)/.test(raw)) loopDepth++;
		const reduced = reduceSegment(segment, loopDepth > 0);
		if (reduced) out.push(reduced);
		if (/^done\b/.test(raw) && loopDepth > 0) loopDepth--;
	}
	return out;
}
