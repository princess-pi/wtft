#!/usr/bin/env bash
# Usage: pricing-bump-check.sh <base-ref>
# Exit 0: prices unchanged against <base-ref>, or changed with a tagger bump. Exit 1: changed without one. Exit 2: no such ref.
set -euo pipefail
base=$1
git rev-parse --verify --quiet "$base^{commit}" >/dev/null || { echo "::error::base ref $base not found: the pricing bump check could not run"; exit 2; }
manifest=docs/manifests/wtft-pricing.json
version=extensions/lib/wtft-tagger-version.ts

prices() { jq -S 'del(.. | .note?)'; }
if diff -q <(git show "$base:$manifest" | prices) <(prices < "$manifest") >/dev/null; then
	echo "Prices unchanged against $base."
	exit 0
fi
stamp() { grep 'WTFT_TAGGER_VERSION = '; }
if [ "$(git show "$base:$version" | stamp)" != "$(stamp < "$version")" ]; then
	echo "Prices changed and $version changed too."
	exit 0
fi
echo "::error file=$version::$manifest changed its prices against $base, but $version did not change. Bump WTFT_TAGGER_VERSION: tag lines carry the cost priced at parse time, and only a bump reparses them."
exit 1
