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
# A UNIQUE name, because the EXIT trap deletes it: a fixed `bin/mut-install-wtft`
# destroyed any pre-existing file of that name — including a concurrent probe's
# mutant, which is not hypothetical on a box that runs several agent sessions at
# once and now runs this from the test suite.
MUT="$(mktemp "$REPO/bin/mut-install-wtft.XXXXXX")"
# A ONE-ENTRY SHIM, not bun's own directory. On this host bun lives in ~/bin,
# which is install-wtft's DEFAULT TARGET: once a real run puts ~/bin/wtft there,
# putting bun's directory on the mutant's PATH makes every run see a foreign
# wtft, report `shadowed` instead of `ok`, and fail on a correct mutation. The
# suite that drives install-wtft defends against exactly this; the script the
# spec tells you to trust over its own table has to as well.
SHIM="$(mktemp -d)"
ln -s "$(command -v bun)" "$SHIM/bun"
BUNDIR="$SHIM"
trap 'rm -f "$MUT"; rm -rf "$SHIM"' EXIT

status_of() { sed -n 's/.*"status":"\([^"]*\)".*/\1/p' <<<"$1"; }
fails=0

# The verdict is computed in the PARENT. It used to be computed inside a
# command substitution, so `fails=$((fails+1))` incremented a subshell's copy and
# `exit $(( fails > 0 ))` was unreachable — the script printed MISMATCH and
# exited 0, which is the same defect class the mutants themselves are hunting.
report() { # name expected-real got-real expected-mut got-mut
  local verdict=OK
  if [ "$3" != "$2" ] || [ "$5" != "$4" ]; then verdict=MISMATCH; fails=$((fails + 1)); fi
  printf '%-46s real=%-10s mutant=%-10s %s\n' "$1" "$3" "$5" "$verdict"
}

# A sed that matches nothing produces a mutant identical to the real script,
# which then agrees with it and reports OK — a green run that mutated nothing.
# That is not hypothetical: refactoring the drift escalation into a `case` left
# M1's pattern matching no line, and only the exit-code fix above surfaced it.
mutate() { # sed-expr
  sed "$1" "$REAL" > "$MUT"; chmod +x "$MUT"
  if cmp -s "$REAL" "$MUT"; then
    printf '%-46s MUTATION DID NOT APPLY: %s\n' "$2" "$1"
    fails=$((fails + 1)); return 1
  fi
}

# M1 — never escalate a bad artifact state to drift.
D=$(mktemp -d); mutate 's/\*) STATUS=drift ;;/*) ;;/' "M1 drift escalation deleted" || true
R=$(PATH="$BUNDIR:/usr/bin:/bin" "$REAL" --check --json --dir "$D" 2>/dev/null)
M=$(PATH="$BUNDIR:/usr/bin:/bin" "$MUT"  --check --json --dir "$D" 2>/dev/null)
report "M1 drift escalation deleted" drift "$(status_of "$R")" ok "$(status_of "$M")"; rm -rf "$D"

# M2 — never escalate a foreign PATH winner to shadowed.
D=$(mktemp -d); DEC=$(mktemp -d); printf '#!/bin/sh\n' > "$DEC/wtft"; chmod +x "$DEC/wtft"
mutate '/if \[ "$STATUS" = ok \]; then STATUS=shadowed; EXIT=2; fi/d' "M2 shadow escalation deleted" || true
R=$(PATH="$DEC:$BUNDIR:/usr/bin:/bin" "$REAL" --json --dir "$D" 2>/dev/null)
M=$(PATH="$DEC:$BUNDIR:/usr/bin:/bin" "$MUT"  --json --dir "$D" 2>/dev/null)
report "M2 shadow escalation deleted" shadowed "$(status_of "$R")" ok "$(status_of "$M")"; rm -rf "$D" "$DEC"

# M3 — never compare source against destination.
D=$(mktemp -d); PATH="$BUNDIR:/usr/bin:/bin" "$REAL" --dir "$D" >/dev/null 2>&1
printf '\n// drift\n' >> "$D/wtft"
mutate 's/elif ! cmp -s "$src" "$dst"; then state=stale/elif false; then state=stale/' "M3 content comparison deleted" || true
R=$(PATH="$BUNDIR:/usr/bin:/bin" "$REAL" --check --json --dir "$D" 2>/dev/null)
M=$(PATH="$BUNDIR:/usr/bin:/bin" "$MUT"  --check --json --dir "$D" 2>/dev/null)
report "M3 content comparison deleted" drift "$(status_of "$R")" ok "$(status_of "$M")"; rm -rf "$D"

exit $(( fails > 0 ))
