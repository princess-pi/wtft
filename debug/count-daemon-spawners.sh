#!/usr/bin/env bash
# Counts the test suites that start the real log parser daemon (#279's closer).
# A suite counts when, under strace, any process it starts execs an argv naming
# bin/wtft-daemon (bare, .mjs, .ts or .js). Stand-ins live outside a bin/ dir.
# Usage: debug/count-daemon-spawners.sh [jobs]   Prints one suite per line, then the count.
set -uo pipefail
cd "$(dirname "$0")/.."
jobs="${1:-8}"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

run_one() {
	local suite="$1" out="$2" runner=bun
	[[ "$suite" == *.sh ]] && runner=bash
	timeout -k 10 300 strace -f -qq -s 512 -e trace=execve -o "$out/$(basename "$suite").trace" \
		"$runner" "$suite" >/dev/null 2>&1
	grep -qE '"[^"]*bin/wtft-daemon(\.mjs|\.ts|\.js)?"' "$out/$(basename "$suite").trace" \
		&& basename "$suite"
}
export -f run_one

# The runner's SOLO suites reach outside their sandbox; they run alone here too (tests/run.ts).
solo='wtft-96-fixture-daemons|wtft-205-one-daemon-per-harness|wtft-46-install-wtft'
{
	ls tests/*.test.ts tests/*.test.sh | grep -vE "$solo" | xargs -P "$jobs" -I{} bash -c 'run_one "$1" "$2"' _ {} "$out"
	for s in $(ls tests/*.test.ts | grep -E "$solo"); do run_one "$s" "$out"; done
} | sort > "$out/list"
cat "$out/list"
echo "spawners: $(wc -l < "$out/list") of $(ls tests/*.test.ts tests/*.test.sh | wc -l)"
