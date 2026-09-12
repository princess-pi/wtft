#!/usr/bin/env bun
/**
 * @package wtft
 * @test wtft-106-other-reclaim
 * @description Validates #106 (with #10 and #11): the classifier reclaims work
 *   that was landing in "other".
 *
 *   Every command SHAPE in this suite was taken from the corpus measured by
 *   `research/other-corpus/` — not invented. That is the point: #10 and #11 each
 *   generalised from one session, and the shapes that actually dominate (a `cd`
 *   followed by a NEWLINE, a `$( )` value, a line-continuation backslash) appear
 *   in neither issue's proposal.
 *
 *   SHAPE, not byte-for-byte string. Paths and arguments are shortened, and
 *   `#106`'s closer asked for the exact strings — a fair catch in review, and
 *   the wrong thing to do here: the real ones are absolute paths inside private
 *   client repositories (`~/git-projects/iarts-pantograph/…`), so pinning them
 *   verbatim would publish directory structure into a repo intended to go
 *   public, and would rot the moment a worktree is renamed. What must be
 *   verbatim is the SYNTAX under test — the separator, the quoting, the
 *   substitution, the operator — and that is preserved exactly. The corpus
 *   itself is reachable through `research/other-corpus/sample-other.ts`, which
 *   prints the untouched strings on demand.
 *
 *   Four surfaces, in the order the data ranks them:
 *     1. normalizeCommand  — cd/wrapper/keyword stripping (the gate on all of it)
 *     2. classifyInteraction — gh and the pr- / git- wrappers, runners, readers, inline scripts
 *     3. TOOL_CATEGORY_MAP — per-harness tool names (Pi's search_web, CC's MCP prefix)
 *     4. renderOtherHistogram — parse misses never render as commands
 */

import {
	parseEntryToInteraction,
	classifyInteraction,
	normalizeCommand,
	extractCommandSegments,
	extractCwdFromBashCommand,
	extractRealCommands,
	cwdForClaudeSpawn,
	splitCommandWords,
	renderOtherHistogram,
} from "../bin/wtft.mjs";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function assert(label: string, ok: boolean, detail?: string) {
	if (ok) {
		console.log(`  ${GREEN}PASS${RESET} ${label}`);
		passed++;
	} else {
		console.log(`  ${RED}FAIL${RESET} ${label}${detail ? `\n        ${detail}` : ""}`);
		failed++;
	}
}

function eq(label: string, actual: unknown, expected: unknown) {
	assert(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- Synthetic turns -------------------------------------------------------

let idCounter = 0;

/** A Claude Code assistant turn running one or more bash commands. */
function bashTurn(...commands: string[]) {
	return parseEntryToInteraction({
		type: "assistant",
		timestamp: "2026-09-11T12:00:00Z",
		message: {
			role: "assistant",
			id: `msg_${++idCounter}`,
			model: "claude-sonnet-5",
			usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: commands.map(command => ({ type: "tool_use", name: "Bash", input: { command } })),
		},
	});
}

/** A Claude Code assistant turn that narrates AND runs one bash command. */
function narratedBashTurn(text: string, command: string) {
	return parseEntryToInteraction({
		type: "assistant",
		timestamp: "2026-09-11T12:00:00Z",
		message: {
			role: "assistant",
			id: `msg_${++idCounter}`,
			model: "claude-sonnet-5",
			usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [{ type: "text", text }, { type: "tool_use", name: "Bash", input: { command } }],
		},
	});
}

/** A Claude Code assistant turn firing one non-file tool by name. */
function toolTurn(name: string, input: any = {}) {
	return parseEntryToInteraction({
		type: "assistant",
		timestamp: "2026-09-11T12:00:00Z",
		message: {
			role: "assistant",
			id: `msg_${++idCounter}`,
			model: "claude-sonnet-5",
			usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			content: [{ type: "text", text: "working" }, { type: "tool_use", name, input }],
		},
	});
}

/** A Pi assistant turn firing one toolCall by name. */
function piToolTurn(name: string, args: any = {}) {
	return parseEntryToInteraction({
		type: "message",
		timestamp: "2026-09-11T12:00:00Z",
		message: {
			role: "assistant",
			id: `pi_${++idCounter}`,
			model: "claude-sonnet-5",
			timestamp: "2026-09-11T12:00:00Z",
			usage: { input: 10, output: 10, cacheWrite: 0, cacheRead: 0 },
			content: [{ type: "text", text: "working" }, { type: "toolCall", name, arguments: args }],
		},
	});
}

const cat = (i: any) => classifyInteraction(i);

/** Does any real command in this string spawn an agent? Mirrors the predicate
 *  the daemon uses, so a test can ask the question without a daemon. */
function extractRealCommandsHasClaude(cmd: string): boolean {
	return extractRealCommands(cmd).some((c: string) =>
		/(?:^|\s)claude(?:\s+-|\s*\||\s*$)/.test(c.split("\n", 1)[0]!.toLowerCase()));
}

// ---------------------------------------------------------------------------
console.log("\n#106 / 1 — normalizeCommand strips the shapes the corpus actually contains");
// ---------------------------------------------------------------------------

// Shape A: cd then a NEWLINE, with no && or ;. The most common shape in the
// corpus, and the reason `cd` was the #1 'other' command at 20% of the bucket.
eq(
	"A: cd <path> NEWLINE <command>",
	normalizeCommand("cd /home/p/git-projects/wtft/.claude/worktrees/625-x\ngrep -n '.bot_login' bin/repo-gate"),
	"grep -n '.bot_login' bin/repo-gate",
);

// Shape B: a $( ) value, whose inner space defeated the old [^\s;&|]+ arm.
// Note the contract change (#106): normalizeCommand returns the PRIMARY command
// alone, where #63 returned the whole remaining string. A caller that needs the
// later commands reads extractRealCommands, which sees more than the remainder
// ever did — it also looks inside loop bodies.
eq(
	"B: cd $(mktemp -d) && <command>",
	normalizeCommand("cd $(mktemp -d) && cp /a/b/pr-review . && python3 build.py"),
	"cp /a/b/pr-review .",
);
eq(
	"B: VAR=$(cmd with spaces) <command>",
	normalizeCommand("BODY=$(cat $S/pr309.md); gh pr create --body \"$BODY\""),
	'gh pr create --body "$BODY"',
);

// Shape C: redirection and || around the cd.
eq(
	"C: cd a 2>/dev/null || cd b; <command>",
	normalizeCommand("cd ~/git-projects/iarts 2>/dev/null || cd /home/p/git-projects/iarts; gh issue view 84"),
	"gh issue view 84",
);

// Line-continuation backslash: 208 corpus calls rendered `\` as a command.
eq(
	"backslash continuation after cd &&",
	normalizeCommand('cd /home/p/wt/575-x && \\\nPATH="/tmp/pishim:$PATH" \\\nPR_REVIEW_TIMEOUT=1800 \\\npr-review 2>&1'),
	"pr-review 2>&1",
);

// Wrappers: the command that matters is the one being wrapped.
eq("wrapper: timeout N", normalizeCommand("timeout 200 bun test tests/x.test.ts"), "bun test tests/x.test.ts");
eq("wrapper: env VAR=v", normalizeCommand("env -u GH_TOKEN gh issue view 387"), "gh issue view 387");
eq("wrapper: nohup + time", normalizeCommand("nohup time bun run build"), "bun run build");

// Shell keywords and function definitions are not commands.
eq(
	"keyword: for ... do <command>",
	normalizeCommand("for s in a b c; do bash bin/$s --help; done"),
	"bash bin/$s --help",
);
eq(
	"keyword: until ... do <command>; <real work>",
	normalizeCommand('until [ "$(gh pr checks 277 --json bucket)" = "true" ]; do sleep 15; done; gh pr checks 277'),
	"gh pr checks 277",
);
eq(
	"function definition is skipped",
	normalizeCommand('reply() { gh api -X POST "$1"; }\nreply 42'),
	"reply 42",
);

// A command that is ONLY navigation normalizes to nothing, and must not be
// counted as work at all.
eq("pure cd normalizes to empty", normalizeCommand("cd /home/p/git-projects/wtft"), "");
eq("pure var assignment normalizes to empty", normalizeCommand("export SP=/tmp/scratch"), "");

// Regression: a command that was already correct must not be mangled.
eq("untouched: plain git", normalizeCommand("git status --short"), "git status --short");
eq("untouched: cd is the whole point", normalizeCommand("cdrecord -v dev=/dev/sr0 x.iso"), "cdrecord -v dev=/dev/sr0 x.iso");

// ---------------------------------------------------------------------------
console.log("\n#106 / 2 — classifyInteraction reclaims named work from 'other'");
// ---------------------------------------------------------------------------

// #10 Finding 1/2 — gh and the shipped workflow wrappers are git operations.
eq("gh issue view -> git", cat(bashTurn("gh issue view 84 --json comments")), "git");
eq("gh pr checks -> git", cat(bashTurn("gh pr checks 277")), "git");
eq("gh api -> git", cat(bashTurn("gh api repos/duppypro/wtft/pulls/277")), "git");
eq("pr-open -> git", cat(bashTurn("pr-open --json")), "git");
eq("pr-threads -> git", cat(bashTurn("pr-threads 106 --json")), "git");
eq("git-checkpoint -> git", cat(bashTurn('git-checkpoint "msg"')), "git");
eq("wt-new -> git", cat(bashTurn("wt-new 106-slug")), "git");
eq("pr-cleanup -> git", cat(bashTurn("pr-cleanup 106-slug")), "git");

// #11 item 4 — runners.
eq("bun test -> tests", cat(bashTurn("bun test tests/config-dir.test.ts 2>&1 | sed -n '1,40p'")), "tests");
eq("bun run test -> tests", cat(bashTurn("bun run test 2>&1 | grep FAIL")), "tests");
eq("pytest -> tests", cat(bashTurn("pytest -q")), "tests");
eq("bash tests/run.sh -> tests", cat(bashTurn("bash tests/run.sh")), "tests");
eq("bun run typecheck -> code", cat(bashTurn("bun run typecheck 2>&1 | tail -15")), "code");
eq("bun run build -> code", cat(bashTurn("bun run build")), "code");
eq("tsc --noEmit -> code", cat(bashTurn("tsc --noEmit")), "code");

// #11 item 2 — file readers/writers classify by the PATH they touch, exactly as
// the Read/Edit tools do. This is the single largest reclaim in the corpus.
eq("sed -n on a source file -> code", cat(bashTurn("sed -n '300,350p' bin/wtft.ts")), "code");
eq("sed -n on a test file -> tests", cat(bashTurn("sed -n '1,60p' tests/repo-gate.test.ts")), "tests");
eq("sed -i on a doc -> spec", cat(bashTurn("sed -i 's/a/b/' docs/spec-26-json.md")), "spec");
eq("head on a source file -> code", cat(bashTurn("head -40 extensions/lib/wtft-parser.ts")), "code");
eq("tail on a source file -> code", cat(bashTurn("tail -20 bin/wtft-daemon.ts")), "code");
eq("cat a research file -> research", cat(bashTurn("cat research/other-corpus/measure-other.ts")), "research");
eq("tee into a source file -> code", cat(bashTurn("tee bin/new-script.ts < /tmp/x")), "code");

// #11 item 3 — inline scripts classify by the paths INSIDE the script body, and
// never as "Session & Agent": that bucket was named for pi/claude invocations.
eq(
	"python3 heredoc editing a source file -> code",
	cat(bashTurn("python3 - <<'PY'\nsrc = open('bin/wtft.ts').read()\nopen('bin/wtft.ts','w').write(src)\nPY")),
	"code",
);
eq(
	"python3 heredoc editing a test -> tests",
	cat(bashTurn("python3 - <<'PY'\nopen('tests/wtft-106.test.ts','w').write(x)\nPY")),
	"tests",
);
eq(
	"node -e reading a source file -> code",
	cat(bashTurn("node -e \"console.log(require('fs').readFileSync('extensions/lib/wtft-cost.ts','utf8'))\"")),
	"code",
);

// Composition: the wrapper strip must feed the classifier, not bypass it.
eq("timeout + bun test -> tests", cat(bashTurn("timeout 200 bun test tests/x.test.ts")), "tests");
eq("cd NEWLINE sed on a source file -> code", cat(bashTurn("cd /home/p/wtft\nsed -n '1,20p' bin/wtft.ts")), "code");
eq("cd $(mktemp -d) && gh -> git", cat(bashTurn("cd $(mktemp -d) && gh pr view 106")), "git");

// Genuinely unclassifiable shell noise STAYS other — reclaiming it would be a
// lie, and the bucket has to keep meaning something.
eq("echo stays other", cat(bashTurn('echo "hello"')), "other");
eq("ls stays other", cat(bashTurn("ls -la /tmp")), "other");
eq("sleep stays other", cat(bashTurn("sleep 5")), "other");

// Existing behaviour must not regress (#3, #52).
eq("claude -p still agents", cat(bashTurn('claude -p "do a thing" --output-format text')), "agents");
eq("plain git still git", cat(bashTurn("git status --short")), "git");
eq("rg still grep", cat(bashTurn("rg -n 'pattern' src/")), "grep");

// ---------------------------------------------------------------------------
console.log("\n#106 / 3 — the harness seam's own 'other': tool names in neither map");
// ---------------------------------------------------------------------------

// Pi spells these differently from Claude Code, and the shared map only knew
// Claude Code's spelling — 268 corpus calls of search_web fell to 'other'.
eq("pi search_web -> web", cat(piToolTurn("search_web", { query: "x" })), "web");
eq("pi todo_write -> plan", cat(piToolTurn("todo_write", { todos: [] })), "plan");
eq("pi grep -> grep", cat(piToolTurn("grep", { pattern: "x" })), "grep");
// Navigation is not work: it must not make the turn 'other', and must not
// poison 'prompt' either.
eq("pi change_working_directory -> prompt (not work)", cat(piToolTurn("change_working_directory", { path: "/tmp" })), "prompt");

// Claude Code's newer tools.
eq("taskoutput -> agents", cat(toolTurn("TaskOutput", { id: "x" })), "agents");
eq("taskstop -> agents", cat(toolTurn("TaskStop", { id: "x" })), "agents");
eq("sendmessage -> agents", cat(toolTurn("SendMessage", { to: "x", message: "y" })), "agents");
eq("listagents -> agents", cat(toolTurn("ListAgents")), "agents");
eq("enterworktree -> git", cat(toolTurn("EnterWorktree", { path: "/x" })), "git");
eq("exitworktree -> git", cat(toolTurn("ExitWorktree", { action: "keep" })), "git");

// MCP tools arrive under a vendor prefix; the suffix is what says what they do.
eq("mcp exa web_search -> web", cat(toolTurn("mcp__exa__web_search_exa", { query: "x" })), "web");
eq("mcp exa web_fetch -> web", cat(toolTurn("mcp__exa__web_fetch_exa", { url: "x" })), "web");
// An MCP tool the suffix heuristic cannot read is still not conversation: it
// must not be counted as 'prompt' just because the turn narrated first.
eq("unknown mcp tool is not prompt", cat(toolTurn("mcp__hostinger_dns__DNS_getDNSRecordsV1", {})) !== "prompt", true);

// ---------------------------------------------------------------------------
console.log("\n#106 / 4 — parse misses never render as commands (#11 item 5)");
// ---------------------------------------------------------------------------

const histogram = renderOtherHistogram([
	bashTurn('echo "a"'),
	bashTurn("ls -la"),
	// A shape normalizeCommand cannot reduce: its residue must be quarantined,
	// not printed as though `-d);` were a program somebody ran.
	bashTurn("d=$(mktemp -d); -d); weird"),
]);

/** A command row is two spaces then the token; a Parse miss row carries the marker. */
function commandRows(rendered: string): string[] {
	return rendered
		.split("\n")
		.filter(l => /^ {2}\S/.test(l) && !l.includes("##PARSE-MISS##") && !l.startsWith("  these tokens"))
		.map(l => l.trim().split(/\s+/)[0]!);
}

for (const bad of ["-d)", "$S/", "\\", ";", "-", "$"]) {
	assert(
		`histogram renders no command row starting with '${bad}'`,
		!commandRows(histogram).some(tok => tok.startsWith(bad)),
		JSON.stringify(commandRows(histogram)),
	);
}
assert("histogram still renders real commands", /\becho\b/.test(histogram) && /\bls\b/.test(histogram), histogram.slice(0, 400));
assert(
	"a parse miss is quarantined under a [Parse miss] group",
	!/Unclassified/.test(histogram) || /Parse miss/.test(histogram),
	histogram.slice(0, 600),
);

// Agent-First Output: an attacker-influenced token must not be able to write
// escape sequences or an unbounded line into the operator's terminal (#106 F5).
const nasty = renderOtherHistogram([bashTurn(`\x1b[2J\x1b[H${"A".repeat(400)} --flag`)]);
assert("histogram strips control characters from rendered tokens", !/\x1b\[2J/.test(nasty), JSON.stringify(nasty.slice(0, 200)));
assert(
	"histogram caps token length",
	!nasty.split("\n").some(l => l.replace(/\x1b\[[0-9;]*m/g, "").length > 200),
	JSON.stringify(nasty.slice(0, 200)),
);

// ---------------------------------------------------------------------------
console.log("\n#106 / 5 — review-round-1 regressions (each one reproduced first)");
// ---------------------------------------------------------------------------

// [Medium/correctness] A wrapper option that CONSUMES the next word must not
// leave that word standing as the command. The first cut modelled every option
// as `-\S+`, so `-k 5` ate the flag and the duration became the command.
eq("timeout -k 5 <dur> <cmd> -> tests", cat(bashTurn("timeout -k 5 200 bun test tests/x.test.ts")), "tests");
eq("sudo -u root git status -> git", cat(bashTurn("sudo -u root git status")), "git");
eq("timeout --signal=KILL <dur> -> tests", cat(bashTurn("timeout --signal=KILL 60 pytest -q")), "tests");
eq("xargs -n 1 <cmd> -> git", cat(bashTurn("xargs -n 1 git show")), "git");
eq("nice -n 10 still unwraps", normalizeCommand("nice -n 10 bun run build"), "bun run build");

// [Medium/reasoning] A turn whose every command is navigation did no work. It
// must not be forced to `other` before the prompt rule gets a look — otherwise a
// narrated `cd` is billed as unclassified work rather than as the reply it is.
eq("cd + narration -> prompt", cat(narratedBashTurn("Moving there.", "cd /home/p/x")), "prompt");
// …and with no reply in it, a bare `cd` turn is still `other`: it ran something,
// did no work, and said nothing. `other` is the honest residual, not a bug.
eq("bare cd, no text -> other", cat(bashTurn("cd /home/p/x")), "other");

// [Low/correctness] An INPUT redirection is not a file the command wrote, and a
// device node is not repository work. `tee out < /dev/null` recorded /dev/null
// as a write, which graded the turn `code`.
const tee = bashTurn("tee out < /dev/null");
assert("input redirection does not record /dev/null",
	!tee!.files.some(f => f.path === "/dev/null"), JSON.stringify(tee!.files));
eq("tee still records its own output file", tee!.files.some(f => f.path === "out" && f.action === "write"), true);

// [Low/correctness] A heredoc body belongs to the command that OPENED it, even
// when a separator pushed that command first.
const segs = extractCommandSegments("python3 - <<'PY' | sort\nopen('bin/x.ts')\nPY");
assert("heredoc body stays with its opener",
	segs[0]!.includes("open('bin/x.ts')") && !segs[1]!.includes("open("), JSON.stringify(segs));
eq("inline script after a pipe still classifies by its path",
	cat(bashTurn("python3 - <<'PY' | sort\nopen('bin/wtft.ts','w').write(x)\nPY")), "code");

// [Low/correctness] A paren inside a quoted string is text, not structure.
eq("$( ) with a quoted paren stays one segment",
	extractCommandSegments("echo $(grep ')' bin/x.ts) && ls").length, 2);

// [Medium/correctness] The cwd extractor must reach as far as the claude-spawn
// detector, or the daemon drops the interaction and loses the subagent's cost.
eq("cwd found after a loop header",
	extractCwdFromBashCommand("until [ -f /tmp/go ]; do cd /home/p/proj; claude -p 'go'; done"), "/home/p/proj");
eq("cwd found when cd is not the first command",
	extractCwdFromBashCommand("echo start && cd /home/p/proj && claude -p 'go'"), "/home/p/proj");
eq("cwd still null when there is no cd", extractCwdFromBashCommand("claude -p 'go'"), null);

// ---------------------------------------------------------------------------
console.log("\n#106 / 6 — review-round-2 regressions (bugs introduced by round-1 fixes)");
// ---------------------------------------------------------------------------

// [High/correctness] A `>` inside a QUOTED argument is data, not a redirection.
// The round-1 regex fabricated a file write from it, and because path-derived
// categories outrank command names, the turn was reported as `code`.
for (const [cmd, want] of [
	['echo "a > b"', "other"],
	['git commit -m "fix > bug"', "git"],
	["grep 'x > 1' notes.txt", "grep"],
] as const) {
	eq(`quoted '>' is not a redirect: ${cmd}`, cat(bashTurn(cmd)), want);
}
assert("quoted '>' records no file at all",
	bashTurn('git commit -m "fix > bug"')!.files.length === 0,
	JSON.stringify(bashTurn('git commit -m "fix > bug"')!.files));
// …while a REAL redirection is still a write.
assert("a real redirect is still recorded",
	bashTurn("cat > bin/new.ts <<'EOF'\nx\nEOF")!.files.some(f => f.path === "bin/new.ts" && f.action === "write"),
	JSON.stringify(bashTurn("cat > bin/new.ts <<'EOF'\nx\nEOF")!.files));

// [High/crossfile] An unknowable `cd` target must read as UNKNOWN. Returning the
// partial `$(mktemp` was worse than null: non-null, so the daemon accepted it,
// stat'd a path that cannot exist, and re-queued forever while the subagent's
// whole cost went missing.
eq("cd $( … ) yields null, not a partial match",
	extractCwdFromBashCommand("cd $(mktemp -d) && claude -p 'go'"), null);

// [Medium/crossfile] A `cd` AFTER the spawn is where the shell went next, not
// where the spawn ran.
eq("cd after the spawn is ignored",
	extractCwdFromBashCommand("cd /home/p/proj && claude -p 'x'; cd /elsewhere"), "/home/p/proj");
eq("no cd before the spawn is still null",
	extractCwdFromBashCommand("claude -p 'x'; cd /elsewhere"), null);
// The last cd BEFORE the spawn wins — it is the one in effect when it ran.
eq("last cd before the spawn wins",
	extractCwdFromBashCommand("cd /repo && cd /repo/sub && claude -p 'go'"), "/repo/sub");

// …EXCEPT across `||`, which runs its right side only if the left FAILED. This
// exact shape is in the corpus, and reading it as "last wins" sent discovery to
// /tmp and lost a real subagent's $0.38 from the session total. It was caught by
// the totals invariant in research/other-corpus/before-after.ts, not by a unit
// test — which is why the invariant is in the repo and not just in a comment.
eq("a `||` fallback cd does not beat the cd it falls back FROM",
	extractCwdFromBashCommand(
		"cd /tmp/scratch/b3df8f20/scratchpad 2>/dev/null || cd /tmp\ntimeout 180 claude -p \"find the bun version\""),
	"/tmp/scratch/b3df8f20/scratchpad");
// A `&&` chain is not a fallback: there, later really does mean later.
eq("&& after a || chain still advances",
	extractCwdFromBashCommand("cd /a 2>/dev/null || cd /fallback && cd /a/sub && claude -p 'go'"), "/a/sub");

// [Low/correctness] Command families are matched case-insensitively, as they
// were before this branch.
eq("Git status -> git", cat(bashTurn("Git status")), "git");
eq("Bun test -> tests", cat(bashTurn("Bun test tests/x.test.ts")), "tests");

// ---------------------------------------------------------------------------
console.log("\n#106 / 7 — review-round-3 regressions");
// ---------------------------------------------------------------------------

// [High/crossfile] Each `commands` entry is a SEPARATE Bash call with its own
// shell, so a `cd` in one says nothing about the cwd of a spawn in another.
eq("cwd is not borrowed from a different bash call",
	cwdForClaudeSpawn(["cd /a", "claude -p 'go'"]), null);
eq("cwd comes from the call that spawned",
	cwdForClaudeSpawn(["cd /decoy", "cd /real && claude -p 'go'"]), "/real");

// [High/crossfile] `||` only marks a fallback when the thing it falls back FROM
// was the cd we kept. `cd /a && false || cd /b` really does run `cd /b`.
eq("|| after a non-cd command is not a fallback chain",
	extractCwdFromBashCommand("cd /a && false || cd /b; timeout 180 claude -p 'go'"), "/b");

// [Medium/correctness] A substitution target is unknowable QUOTED too — the
// double-quote arm matched first and handed back the unexpanded text.
eq("cd \"$( … )\" yields null", extractCwdFromBashCommand("cd \"$(mktemp -d)\" && claude -p 'x'"), null);
eq("cd `…` yields null", extractCwdFromBashCommand("cd `mktemp -d` && claude -p 'x'"), null);

// [Medium/crossfile] A `claude -p` inside a heredoc BODY is data, not a spawn.
eq("claude -p inside a heredoc body is not agents",
	cat(bashTurn("cat <<'EOF' > notes.md\nrun claude -p \"go\" to start\nEOF")), "spec");
eq("cwd ignores a spawn that is only heredoc text",
	cwdForClaudeSpawn(["cat <<'EOF'\nclaude -p 'go'\nEOF"]), null);

// [Medium/correctness] A function DEFINITION runs nothing — not its first
// statement and not the rest of a multi-statement body.
eq("a multi-statement function body does not leak",
	normalizeCommand("reply() { gh api -X POST \"$1\"; gh pr checks 1; }\nreply 42"), "reply 42");
assert("a claude -p inside a function body is not a spawn",
	!extractRealCommandsHasClaude("spawn() { claude -p 'go'; }\necho defined"),
	"function body registered as a spawn");

// [Medium/contract] Shell noise stays other even when it redirects: the target
// is outside any checkout, so it is not this repository's code.
eq("echo > /tmp file stays other", cat(bashTurn("echo hi > /tmp/notes.txt")), "other");
eq("ls > /tmp file stays other", cat(bashTurn("ls > /tmp/list.txt")), "other");
eq("cat /etc/hosts stays other", cat(bashTurn("cat /etc/hosts")), "other");
// …but a redirect into the REPO is still a code write.
eq("redirect into the repo is still code", cat(bashTurn("echo x > bin/generated.ts")), "code");
// The non-repo rule applies on EVERY route to a path, including the one inside
// an inline script — that branch returns early and was skipping the check, so
// the same path graded differently depending on how it was written.
eq("inline script writing outside a checkout is not code",
	cat(bashTurn("python3 - <<'PY'\nopen('/tmp/scratch/x.mjs','w').write(x)\nPY")), "other");
eq("inline script writing INTO the repo is still code",
	cat(bashTurn("python3 - <<'PY'\nopen('bin/wtft.ts','w').write(x)\nPY")), "code");
// An absolute path into a checkout is repo work, and must not be caught by the
// non-repo roots.
eq("absolute path into a checkout still classifies",
	cat(bashTurn("sed -n '1,5p' /home/princess-pi/git-projects/wtft/bin/wtft.ts")), "code");

// [Low/correctness] A redirection abutting a closing quote is an operator.
assert("echo \"a\">out records the redirect",
	splitCommandWords('echo "a">out').writes.includes("out"),
	JSON.stringify(splitCommandWords('echo "a">out')));
// …while a `>` INSIDE the quotes is still data.
assert("echo \"a > b\" records nothing",
	splitCommandWords('echo "a > b"').writes.length === 0,
	JSON.stringify(splitCommandWords('echo "a > b"')));

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? GREEN : RED}#106: ${passed} passed, ${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);
