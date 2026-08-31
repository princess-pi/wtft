#!/usr/bin/env bash
# run-mutants.sh — the mutation-proofs behind docs/spec-46-install-wtft.md.
#
# Why this is committed rather than described (#18's lesson, reapplied): the
# spec used to state three mutation results as fact, with no code in the tree a
# reader could run to reproduce them. A cited measurement nobody can re-derive
# is a claim wearing evidence's clothes. This is the smaller, duller fix — commit
# the probe, and let the spec point at it.
#
# THE MUTANT MUST LIVE IN bin/. `REPO` inside install-wtft is derived from the
# script's own location, so a copy anywhere else computes the wrong repo, fails
# with status "build-failed", and proves nothing about the branch it deleted.
# That is what happened on the first attempt.
#
# Run: research/46-install-mutants/run-mutants.sh
# Exit: 0 if every mutant reported "ok" where the real script reported a fault.

set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd -P)"
REAL="$REPO/bin/install-wtft"
MUT="$REPO/bin/mut-install-wtft"
BUNDIR="$(dirname "$(command -v bun)")"
trap 'rm -f "$MUT"' EXIT

status_of() { sed -n 's/.*"status":"\([^"]*\)".*/\1/p' <<<"$1"; }
fails=0

report() { # name expected-real got-real expected-mut got-mut
  printf '%-46s real=%-10s mutant=%-10s %s\n' "$1" "$3" "$5" \
    "$( [ "$3" = "$2" ] && [ "$5" = "$4" ] && echo OK || { echo MISMATCH; fails=$((fails+1)); } )"
}

# M1 — never escalate a bad artifact state to drift.
D=$(mktemp -d); sed '/\[ "$state" = ok \] || {/d' "$REAL" > "$MUT"; chmod +x "$MUT"
R=$(PATH="$BUNDIR:/usr/bin:/bin" "$REAL" --check --json --dir "$D" 2>/dev/null)
M=$(PATH="$BUNDIR:/usr/bin:/bin" "$MUT"  --check --json --dir "$D" 2>/dev/null)
report "M1 drift escalation deleted" drift "$(status_of "$R")" ok "$(status_of "$M")"; rm -rf "$D"

# M2 — never escalate a foreign PATH winner to shadowed.
D=$(mktemp -d); DEC=$(mktemp -d); printf '#!/bin/sh\n' > "$DEC/wtft"; chmod +x "$DEC/wtft"
sed '/if \[ "$STATUS" = ok \]; then STATUS=shadowed; EXIT=2; fi/d' "$REAL" > "$MUT"; chmod +x "$MUT"
R=$(PATH="$DEC:$BUNDIR:/usr/bin:/bin" "$REAL" --json --dir "$D" 2>/dev/null)
M=$(PATH="$DEC:$BUNDIR:/usr/bin:/bin" "$MUT"  --json --dir "$D" 2>/dev/null)
report "M2 shadow escalation deleted" shadowed "$(status_of "$R")" ok "$(status_of "$M")"; rm -rf "$D" "$DEC"

# M3 — never compare source against destination.
D=$(mktemp -d); PATH="$BUNDIR:/usr/bin:/bin" "$REAL" --dir "$D" >/dev/null 2>&1
printf '\n// drift\n' >> "$D/wtft"
sed 's/elif ! cmp -s "$src" "$dst"; then state=stale/elif false; then state=stale/' "$REAL" > "$MUT"; chmod +x "$MUT"
R=$(PATH="$BUNDIR:/usr/bin:/bin" "$REAL" --check --json --dir "$D" 2>/dev/null)
M=$(PATH="$BUNDIR:/usr/bin:/bin" "$MUT"  --check --json --dir "$D" 2>/dev/null)
report "M3 content comparison deleted" drift "$(status_of "$R")" ok "$(status_of "$M")"; rm -rf "$D"

exit $(( fails > 0 ))
