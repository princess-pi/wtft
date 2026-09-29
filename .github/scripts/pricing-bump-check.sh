#!/usr/bin/env bash
# Usage: pricing-bump-check.sh <base-ref>
# Exit 0: prices unchanged against <base-ref>, or changed with a tagger bump. Exit 1: changed without one. Exit 2: the check could not run.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: pricing-bump-check.sh <base-ref>" >&2; exit 2; }
base=$1
manifest=docs/manifests/wtft-pricing.json
version=extensions/lib/wtft-tagger-version.ts
cannot() { echo "::error::the pricing bump check could not run: $1"; exit 2; }

git rev-parse --verify --quiet "$base^{commit}" >/dev/null || cannot "base ref $base not found"
base_prices=$(git show "$base:$manifest" | jq -S 'del(.. | .note?)') || cannot "$manifest unreadable at $base"
head_prices=$(jq -S 'del(.. | .note?)' "$manifest") || cannot "$manifest unreadable"
if [ "$base_prices" = "$head_prices" ]; then
	echo "Prices unchanged against $base."
	exit 0
fi
stamp() { sed -n 's/^export const WTFT_TAGGER_VERSION = "\([^"]*\)".*/\1/p'; }
base_stamp=$(git show "$base:$version" | stamp) && [ -n "$base_stamp" ] || cannot "no WTFT_TAGGER_VERSION in $version at $base"
head_stamp=$(stamp < "$version") && [ -n "$head_stamp" ] || cannot "no WTFT_TAGGER_VERSION in $version"
if [ "$base_stamp" != "$head_stamp" ]; then
	echo "Prices changed and WTFT_TAGGER_VERSION changed too."
	exit 0
fi
echo "::error file=$version::$manifest changed its prices against $base, but WTFT_TAGGER_VERSION in $version did not change. Bump it: tag lines carry the cost priced at parse time, and only a bump reparses them."
exit 1
