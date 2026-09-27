#!/usr/bin/env bash
# Counts the test suites that start the real log parser daemon.
# A suite counts when, under strace, any process it starts execs an argv naming
# bin/wtft-daemon (bare, .mjs, .ts or .js). docs/spec-279-in-memory-suites.md § 1.
# Usage: debug/count-daemon-spawners.sh [jobs]
# Prints one suite per line, then "spawners: <n> of <total>", and exits 0.
# Exits 4 after the count when a suite that started no daemon also failed: it
# may have failed before reaching one, so those suites are named on stderr.
# Exits 3 with no count when a suite was not traced or did not finish, since a
# count that skipped a suite would read low. Exits 2 on a setup failure.
set -uo pipefail
cd "$(dirname "$0")/.."
jobs="${1:-8}"
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || { echo "count-daemon-spawners: jobs must be a positive integer, got '$jobs'" >&2; exit 2; }
out="$(mktemp -d)" || exit 2
trap 'rm -rf "$out"' EXIT

# Seconds a suite may run before it is recorded as unfinished.
LIMIT=300

run_one() {
	local suite="$1" out="$2" limit="$3" runner="bun test" name
	name="$(basename "$suite")"
	[[ "$suite" == *.sh ]] && runner=bash
	# As tests/run.ts runs it. $0 is unquoted so "bun test" splits.
	# Each suite gets its own config, state and tmp roots, as tests/run.ts gives it.
	local home
	home="$(mktemp -d "$out/suite.XXXXXX")" || { echo "UNFINISHED $name"; return; }
	mkdir -p "$home/config" "$home/state" "$home/tmp"
	# strace -f also follows the daemons a suite leaves running, so it is stopped
	# when the suite returns. -I 1 lets SIGTERM through: strace then detaches,
	# flushes the trace and exits, and the daemons run on as they would untraced.
	# setsid gives the tracer and the suite their own process group, so a suite
	# that runs past the limit is killed with it.
	XDG_CONFIG_HOME="$home/config" XDG_STATE_HOME="$home/state" TMPDIR="$home/tmp" \
		setsid strace -f -ff -qq -I 1 -s 512 -e trace=execve -o "$out/$name.trace" \
		bash -c '$0 "$1" >/dev/null 2>&1; echo $? > "$2"' "$runner" "$suite" "$out/$name.done" &
	local tracer=$! ticks=0
	while [[ ! -e "$out/$name.done" ]] && kill -0 "$tracer" 2>/dev/null && (( ticks < limit * 10 )); do
		sleep 0.1
		ticks=$((ticks + 1))
	done
	if [[ ! -e "$out/$name.done" ]]; then
		kill -KILL -- "-$tracer" 2>/dev/null
		wait "$tracer" 2>/dev/null
		echo "UNFINISHED $name"
		return
	fi
	kill "$tracer" 2>/dev/null
	wait "$tracer" 2>/dev/null
	# -ff writes one file per process, so an exec is never split across an
	# <unfinished ...> line and its result.
	# No -q on either grep: it would quit early, and pipefail would read cat's
	# SIGPIPE as no match.
	if ! cat "$out/$name.trace".* 2>/dev/null | grep -F "\"$suite\"" >/dev/null; then echo "UNTRACED $name"; return; fi
	# A failed exec (= -1 ENOENT, a PATH search) started nothing.
	# The CLI harness's stand-in (tests/lib/cli-harness.ts) is excluded by path.
	if cat "$out/$name.trace".* | grep -E '"[^"]*bin/wtft-daemon(\.mjs|\.ts|\.js)?"' \
		| grep -vE '"[^"]*/wtft-cli-harness-[^"/]*/bin/wtft-daemon\.mjs"' | grep -vE '= -1 [A-Z]+' >/dev/null; then
		echo "$name"
	elif [[ "$(cat "$out/$name.done")" != 0 ]]; then
		echo "FAILED $name"
	fi
}
export -f run_one

# The runner's SOLO suites reach outside their sandbox, so they run alone here too.
solo="$(sed -n '/^const SOLO = \[/,/^\];/p' tests/run.ts | grep -oE '"[^"]+"' | tr -d '"' | paste -sd'|')"
[[ -n "$solo" ]] || { echo "count-daemon-spawners: no SOLO list found in tests/run.ts" >&2; exit 2; }
suites="$(ls tests/*.test.ts tests/*.test.sh)"
for s in ${solo//|/ }; do
	grep -qxF "tests/$s" <<<"$suites" || { echo "count-daemon-spawners: SOLO names $s, which is not a suite" >&2; exit 2; }
done
{
	grep -vxE "tests/(${solo//./\\.})" <<<"$suites" | xargs -P "$jobs" -I{} bash -c 'run_one "$1" "$2" "$3"' _ {} "$out" "$LIMIT"
	for s in $(grep -xE "tests/(${solo//./\\.})" <<<"$suites"); do run_one "$s" "$out" "$LIMIT"; done
} | sort > "$out/list"

if grep -qE '^(UNFINISHED|UNTRACED) ' "$out/list"; then
	grep -E '^(UNFINISHED|UNTRACED) ' "$out/list" >&2
	echo "count-daemon-spawners: no count; the suites above were not measured" >&2
	exit 3
fi
grep -v '^FAILED ' "$out/list"
echo "spawners: $(grep -vc '^FAILED ' "$out/list") of $(wc -l <<<"$suites")"
if grep -q '^FAILED ' "$out/list"; then
	sed -n 's/^FAILED /failed, and started no daemon: /p' "$out/list" >&2
	exit 4
fi
