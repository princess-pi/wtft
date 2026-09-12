/**
 * @package wtft
 * @module wtft-command-shapes
 * @description What a bash command STRING is made of (#106) — and nothing about
 *   what it means. The meaning lives in `wtft-parser.ts`'s classifier.
 *
 *   Why this is its own module: #63 handled the compound-command problem with
 *   three leading-prefix regexes on one string, and the corpus measured in
 *   `research/other-corpus/` shows what that misses. `cd` was the single largest
 *   "other" command at ~20% of the whole bucket, because its strip demanded a
 *   literal `&&` or `;` and the commonest real shape separates with a NEWLINE.
 *   A prefix-strip also cannot see past the first command, so `until …; do sleep
 *   15; done; gh pr checks 277` is a wait loop whose actual work is invisible.
 *
 *   The deep-module move is to stop rewriting the string and instead SPLIT it —
 *   once, quote/heredoc/substitution-aware — into the commands a shell would run.
 *   Everything above then reads a list instead of guessing at a prefix.
 *
 *   Deliberately NOT a shell parser. It knows quoting, `$( )`, backticks,
 *   heredocs, line continuations and the separators, because getting those wrong
 *   silently mis-splits real commands. It does not know expansion, arrays,
 *   arithmetic, or `case` patterns — a command it cannot read comes back whole,
 *   which degrades to today's behaviour rather than to a wrong answer.
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
 * Split a bash command string into the individual commands a shell would run.
 *
 * Quote-, heredoc- and substitution-aware: separators inside `'…'`, `"…"`,
 * `$(…)`, `` `…` `` or a heredoc body are literal text, not splits. A heredoc
 * body stays attached to the command that opened it, which is what lets an
 * inline `python3 - <<'PY' … PY` be classified by the paths inside its script.
 */
/**
 * Anything that could make a command string more than one command: a separator,
 * a quote, a substitution, a heredoc, a comment, or a line continuation.
 *
 * A string with none of these is one command, and the character walk below can
 * be skipped entirely. Measured motivation: the walk is ~16% slower than the
 * three regexes it replaced, and `tests/wtft-issue-149-…` already sits within
 * 5% of bun's 5s per-test ceiling on this host (#27). Most real commands are
 * short and simple, so the bail is taken on the large majority of them.
 */
const NEEDS_SPLIT = /[;|&'"`\n#\\]|\$\(/;

export function extractCommandSegments(cmd: string): string[] {
	const trimmed = cmd.trim();
	if (!NEEDS_SPLIT.test(trimmed)) return trimmed ? [trimmed] : [];

	const segments: string[] = [];
	let buf = "";
	let i = 0;
	const n = cmd.length;

	// Heredoc delimiters opened on the current line, consumed at the next newline.
	let pendingHeredocs: { delim: string; stripTabs: boolean }[] = [];
	// Index of the already-pushed segment that opened those heredocs, or -1 when
	// the opener is still in `buf`. `python3 - <<'PY' | sort` pushes the opener
	// at the `|` BEFORE the body is reached, and the body was then appended to
	// whatever came next — so the script's paths were read as `sort`'s and the
	// inline-script rule was tested against the wrong command (#106 review).
	let heredocOwner = -1;

	const push = () => {
		const t = buf.trim();
		if (t) {
			segments.push(t);
			if (pendingHeredocs.length > 0 && heredocOwner === -1) heredocOwner = segments.length - 1;
		}
		buf = "";
	};

	while (i < n) {
		const c = cmd[i]!;

		// Line continuation: a backslash-newline is whitespace, not a command.
		// Corpus: 208 calls rendered a bare `\` as though it were a program.
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
		// scanning for the first `)`. This is the arm that `cd $(mktemp -d)`
		// defeated in #63 — its value contains a space AND a paren.
		//
		// Quote-aware, because a paren inside a quoted string is text, not
		// structure: `$(grep ')' bin/x.ts)` closed at the quoted `)` and sliced
		// the substitution short, feeding a wrong primary token into everything
		// downstream (#106 review, Low/correctness).
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
			if (heredocOwner >= 0) segments[heredocOwner] += body;
			else buf += body;
			pendingHeredocs = [];
			heredocOwner = -1;
			i = j; continue;
		}

		// A `#` that starts a word begins a comment to end of line.
		if (c === "#" && (buf === "" || /\s$/.test(buf))) {
			const end = cmd.indexOf("\n", i);
			if (end === -1) break;
			i = end; continue;
		}

		const sep = SEPARATORS.find(s => cmd.startsWith(s, i));
		if (sep) { push(); i += sep.length; continue; }

		buf += c; i++;
	}
	push();
	return segments;
}

// ---
// SCAFFOLDING
// ---

/**
 * Wrapper commands whose argument IS the command that matters.
 *
 * Every option that CONSUMES A FOLLOWING WORD has to be spelled out, not folded
 * into a generic `-\S+`. The first cut used `timeout\s+(?:-\S+\s+)*\S+`, which
 * reads `timeout -k 5 200 bun test` as flag `-k`, duration `5` — leaving `200
 * bun test` as the command and classifying the turn `other`, the very thing this
 * module exists to prevent (#106 review, Medium/correctness). `sudo -u root git
 * status` failed the same way, yielding a command named `root`.
 */
const WRAPPER = new RegExp(
	"^(?:" +
	[
		// timeout: value-taking options, THEN the mandatory duration.
		"timeout(?:\\s+(?:-k|--kill-after|-s|--signal)(?:=\\S+|\\s+\\S+)|\\s+(?:--preserve-status|--foreground|-[a-zA-Z]+))*\\s+\\S+",
		"time(?:\\s+(?:-o|--output|-f|--format)(?:=\\S+|\\s+\\S+)|\\s+-[a-zA-Z]+)*",
		"nice(?:\\s+(?:-n|--adjustment)(?:=\\S+|\\s+-?\\d+))?",
		"ionice(?:\\s+(?:-c|-n|-p)(?:=\\S+|\\s+\\S+)|\\s+-[a-zA-Z]+)*",
		"nohup",
		"stdbuf(?:\\s+(?:-i|-o|-e)(?:=\\S+|\\s+\\S+))*",
		"command",
		"builtin",
		"exec",
		// sudo: -u/-g/-U/-p/-C/-D/-h all take the next word.
		"sudo(?:\\s+(?:-u|-g|-U|-p|-C|-D|-h|--user|--group|--prompt)(?:=\\S+|\\s+\\S+)|\\s+-[a-zA-Z]+)*",
		"doas(?:\\s+-u\\s+\\S+|\\s+-[a-zA-Z]+)*",
		// env: flags, `-u NAME` pairs (two words), and assignments, in any order.
		"env(?:\\s+(?:-u|--unset)(?:=\\S+|\\s+[A-Za-z_][A-Za-z0-9_]*)|\\s+-[A-Za-z]+|\\s+[A-Za-z_][A-Za-z0-9_]*=(?:\"[^\"]*\"|'[^']*'|\\S*))*",
		// xargs: -I/-n/-P/-d/-a/-E/-s all take the next word.
		"xargs(?:\\s+(?:-I|-i|-n|-P|-d|-a|-E|-s|--replace|--max-args|--max-procs|--delimiter)(?:=\\S+|\\s+\\S+)|\\s+-[a-zA-Z]+)*",
		"script\\s+-qc",
	].join("|") +
	")\\s+",
);

/** Leading `VAR=value` assignments, including a `$( … )` value with spaces. */
const ASSIGNMENT = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`|[^\s;&|]*)[ \t]*)+/;

/** Declaration builtins that only ever introduce assignments. */
const DECLARE = /^(?:export|declare|local|readonly|typeset|set)\s+/;

/** Loop/branch openers and closers — grammar, never work. */
const KEYWORD = /^(?:for|while|until|if|elif|else|then|do|done|fi|case|esac|in|select|function|coproc|\{|\}|\(|\)|!)(?:\s|$)/;

/** A function DEFINITION: `name() {` — the body is not an invocation. */
const FUNCTION_DEF = /^[A-Za-z_][A-Za-z0-9_-]*\s*\(\s*\)/;

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
		s = s.replace(/^(?:do|then|!)\s+/, "");
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
 * `inLoopBody` is why this takes a second argument rather than being pure over
 * the string: `sleep 15` is ordinary work at top level and is pure scaffolding
 * between `do` and `done`. The wait-loop idiom
 * `until <condition>; do sleep 15; done; <the real command>` is the single most
 * common `until` shape in the corpus, and treating its `sleep` as the command
 * hides the work the loop was waiting to do.
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
 *
 * This is what the classifier reads: a compound command is classified on
 * everything it runs, not on whichever command happened to come first.
 */
/**
 * Memo for `extractRealCommands`.
 *
 * The same command string is segmented up to three times per turn — once at
 * parse time for its file touches, once by the classifier, once by the `--other`
 * histogram — and a session replays the same commands across every render. The
 * cache is bounded and cleared wholesale rather than evicted per entry: this is
 * a batch tool, and a simple ceiling is easier to reason about than an LRU.
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
	for (const segment of extractCommandSegments(cmd)) {
		const raw = segment.trim();
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
