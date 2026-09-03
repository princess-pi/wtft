# spec-51-token-budget

**Status:** Active · **Issue:** princess-pi/wtft#51 (decision 1 — rename) · **Tool:** `extensions/token-budget.ts`

## What it is

Token Budget is the Pi extension that stops an agent from breaching model
subscription quota. It budgets **velocity** — tokens per minute (TPM) — per
model, and it is the surface the absolute-spend budget and the
distance-to-budget visualizations will land on (princess-pi/wtft#53).

It runs transparently: it intercepts provider requests, checks a sliding 120s
window of TPM across all active local sessions, and when a model crosses its
safety threshold (80% of that model's subscription quota, from the
`MODEL_QUOTA_REGISTRY` ceilings), it enforces a 40s synchronous cooldown rather
than letting the provider hard-fail.

## One tool, one name

Canonical term is **Token Budget**. The four pre-rename names are retired:

| surface | then | now |
|---|---|---|
| file | `extensions/rate-limiter.ts` | `extensions/token-budget.ts` |
| slash command | `/tpm` | `/budget` |
| widget / status key | `rate-limiter` | `token-budget` |
| config file | `tpm.json` | `token-budget.json` |

"TPM" survives only as the *metric* the budget tracks (tokens per minute), never
as the tool's name. In a harness the short command is `/budget`; "Token Budget"
is the name you find the tool under.

## Contract

- **Config** — `~/.config/princess-pi-tools/token-budget.json`, resolved by
  `@princess-pi/libs/config`. Keys: `widget` (bool), `footer` (bool),
  `emojiDisabled` (bool). Read by the extension; written only by the extension,
  never by the CLI — config persistence is a *convention*, not a lib
  (princess-pi/wtft#51 decision 3).
- **Command** — `/budget` toggles the widget and footer; flags `--widget
  on|off`, `--footer on|off`, `--emoji`, `--no-emoji`, `--reset`, `--why`,
  with `-w` / `-f` aliases.
- **Widget / status** — a below-editor panel plus a footer line, each showing
  per-model TPM as a colored bar against that model's ceiling (green below 50%,
  yellow above 50%, red above 80%, gray at 0).
- **Dependency on the tag format** — it scans `wtft-tags/` and parses
  `.wtft-tag.vX.Y.Z.jsonl` filenames. That grammar is a wire-format contract,
  not an implementation detail: it is pinned by `tests/wtft-tag-format.test.ts`
  against `docs/wtft-tag-format.md`, so a tagger rename is a caught break, not a
  silent one.

## Not this tool

- The absolute-spend budget and the distance-to-budget visualization are
  princess-pi/wtft#53 — named here, not yet built.
- Provider quota changes are out of scope: Token Budget displays and monitors;
  it cannot raise an API limit.
