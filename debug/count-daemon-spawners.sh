#!/usr/bin/env bash
# Counts the test suites that start the real log parser daemon.
# A suite counts when, under strace, any process it starts execs an argv naming
# bin/wtft-daemon (bare, .mjs, .ts or .js). Stand-ins live outside a bin/ dir.
# Usage: debug/count-daemon-spawners.sh [jobs]
# Prints one suite per line, then "spawners: <n> of <total>", and exits 0.
# Exits 3 with no count when a suite was not traced or did not finish, since a
# count that skipped a suite would read low. Exits 2 on a setup failure.
set -uo pipefail
cd "$(dirname "$0")/.."
jobs="${1:-8}"
out="$(mktemp -d)" || exit 2
trap 'rm -rf "$out"' EXIT

# Seconds a suite may run before it is recorded as unfinished.
LIMIT=300

run_one() {
	local suite="$1" out="$2" limit="$3" runner=bun name
	name="$(basename "$suite")"
	[[ "$suite" == *.sh ]] && runner=bash
	# strace -f also follows the daemons a suite leaves running, so it is stopped
	# when the suite returns. It blocks SIGTERM while tracing, so it gets SIGKILL,
	# and --kill-on-exit takes those daemons with it.
	strace -f -qq -s 512 -e trace=execve --kill-on-exit -o "$out/$name.trace" \
		bash -c '"$0" "$1" >/dev/null 2>&1; : > "$2"' "$runner" "$suite" "$out/$name.done" &
	local tracer=$! ticks=0
	while [[ ! -e "$out/$name.done" ]] && kill -0 "$tracer" 2>/dev/null && (( ticks < limit * 10 )); do
		sleep 0.1
		ticks=$((ticks + 1))
	done
	kill -KILL "$tracer" 2>/dev/null
	wait "$tracer" 2>/dev/null
	if [[ ! -e "$out/$name.done" ]]; then echo "UNFINISHED $name"; return; fi
	if ! grep -qF "\"$suite\"" "$out/$name.trace" 2>/dev/null; then echo "UNTRACED $name"; return; fi
	grep -qE '"[^"]*bin/wtft-daemon(\.mjs|\.ts|\.js)?"' "$out/$name.trace" && echo "$name"
}
export -f run_one

# The runner's SOLO suites reach outside their sandbox, so they run alone here too.
solo="$(sed -n '/^const SOLO = \[/,/^\];/p' tests/run.ts | grep -oE '"[^"]+"' | tr -d '"' | paste -sd'|')"
[[ -n "$solo" ]] || { echo "count-daemon-spawners: no SOLO list found in tests/run.ts" >&2; exit 2; }
suites="$(ls tests/*.test.ts tests/*.test.sh)"
{
	grep -vxE "tests/($solo)" <<<"$suites" | xargs -P "$jobs" -I{} bash -c 'run_one "$1" "$2" "$3"' _ {} "$out" "$LIMIT"
	for s in $(grep -xE "tests/($solo)" <<<"$suites"); do run_one "$s" "$out" "$LIMIT"; done
} | sort > "$out/list"

if grep -qE '^(UNFINISHED|UNTRACED) ' "$out/list"; then
	grep -E '^(UNFINISHED|UNTRACED) ' "$out/list" >&2
	echo "count-daemon-spawners: no count; the suites above were not measured" >&2
	exit 3
fi
cat "$out/list"
echo "spawners: $(wc -l < "$out/list") of $(wc -l <<<"$suites")"
