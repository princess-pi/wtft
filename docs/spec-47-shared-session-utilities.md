# Spec — Shared Session Path Shortener & Selector

> **Issue:** #47 — Extract session path shortener + selector into reusable lib
> **Status:** Code and Spec Approved (Step 5)

---

## Motivation

Two independent UI patterns existed across this repo:

| Pattern | Location (before) | Lines | Now |
|---|---|---|---|
| `buildDisplayPath` | `bin/wtft.ts` (inline) | ~45 | `extensions/lib/session-path-shortener.ts` |
| `shortenPath` | `extensions/lib/serve/tui.ts` (inline) | ~8 | `extensions/lib/session-path-shortener.ts` |
| `formatRelativeTime` | `bin/wtft.ts` (inline) | ~12 | `extensions/lib/session-path-shortener.ts` |
| `selectSessionPrompt` | `bin/wtft.ts` (inline) | ~80 | `extensions/lib/session-selector.ts` |
| `discoverSessions` | `bin/wtft.ts` (inline) | ~60 | `extensions/lib/session-selector.ts` |
| `getSessionSummary` | `bin/wtft.ts` (inline) | ~20 | `extensions/lib/session-selector.ts` |

The `watu` project (Rust TUI, outside scope for JS sharing) will need the same session path conventions documented when Phase 2 adds `.jsonl` tailing.

## Make vs Buy

**Path shorteners:** No npm library performs domain-specific Pi/Claude session path compaction (`home-user-git-projects-foo` → `~/g-p/foo`). General truncation libs (`cli-truncate`) handle visual-width ellipsis but not slug reconstruction.

**Interactive selectors:** `@inquirer/select` (v14) is well-maintained but pulls a dep tree for ~80 lines of raw stdin handling. Zero-dep CLI bins are a hard requirement per cross-harness convention.

**Verdict: Make > Buy.** Both patterns are domain-specific enough that custom shared modules are correct.

---

## Extracted Modules

### Module A: `extensions/lib/session-path-shortener.ts`

Pure functions, zero deps beyond Node builtins (`path`, `os`).

```typescript
/** Pi/CC session path compaction (e.g. home-user-git-projects-foo → ~/g-p/foo) */
export function buildDisplayPath(
  filename: string,
  dirSlug: string,
  harness: 'pi' | 'claude-code'
): string;

/** Generic path ellipsis: path.relative(cwd) + "..." + last 22 chars if > 25 */
export function shortenPath(
  rawPath: string,
  cwd?: string
): string;

/** Human-readable relative time ("2m ago", "3h ago", "just now") */
export function formatRelativeTime(
  ts: number
): string;
```

#### `buildDisplayPath` transformation rules

| Input slug (after strip) | Harness | Output path |
|---|---|---|
| `home-princess-pi-git-projects-princess-pi-packages` | claude-code | `~/g-p/princess-pi-packages` |
| `home-princess-pi-git-projects-some-project` + UUID tail | claude-code | `~/g-p/some-project/...abc1` |
| `home--princess-pi--git-projects--foo` | pi | `home//princess/pi//git/projects//foo` (fallthrough, pre-existing gap) |
| `some-dir-name` | any | `some/dir/name` |

Note: Pi slugs use `--` internal separators and never match the `home-*-git-projects-` known prefix (which uses single dashes). They fall through to the generic `s/-/g` → `/` cleaner. Fixing this requires checking the `--` variant of the known prefix — tracked as a follow-up.

### Module B: `extensions/lib/session-selector.ts`

Depends on module A + `extensions/lib/wtft-shared.ts` (for `formatCost`, `parseEntryToInteraction`).

```typescript
export interface SessionCandidate {
  path: string;
  harness: 'pi' | 'claude-code';
  timestamp: number;
  name: string;
  displayPath: string;
}

/** Walk Pi and/or Claude Code session directories, sorted newest-first */
export function discoverSessions(
  harness?: 'pi' | 'claude-code' | 'auto'
): SessionCandidate[];

/** Read .jsonl → assistant turn count + total cost */
export function getSessionSummary(
  filePath: string
): { turns: number; cost: number };

/** Interactive TTY picker (↑/↓/Enter/Ctrl+C), non-TTY fallback to auto-select 1st */
export function selectSessionPrompt(
  candidates: SessionCandidate[]
): Promise<string>;
```

---

## Consumers Updated (final list)

| File | Change |
|---|---|
| `bin/wtft.ts` | Removed ~273 lines (6 inline functions + interface + unused imports), imports from new modules |
| `bin/serve.ts` | Import `shortenPath` from `session-path-shortener.ts` instead of `tui.js` |
| `extensions/lib/serve/tui.ts` | Removed inline `shortenPath`, removed unused `node:path` import, imports from shared |
| `extensions/serve.ts` | Import `shortenPath` from shared module instead of `./lib/serve/tui.js` |
| `build.mjs` | Rebuilds `bin/wtft.mjs` and `bin/serve.mjs` — both bundle the new shared modules via esbuild |

## What Stays Behind

Each module retains exactly what's specific to its domain:
- `serve/tui.ts`: serve-widget rendering (`updateWidget`, `buildKilledSummary`, `buildDiscoveredSummary`), ANSI helpers (`stripAnsi`, `getVisualLength`, `padVisual`), `isEmojiDisabled`
- `bin/wtft.ts`: CLI argument parsing, help/why printers, main flow, watch mode dispatch, subagent recursion, settings persistence
- `wtft-shared.ts`: All cost calculation, binning, bar chart rendering, interaction parsing — **unchanged**

---

## Bugs Discovered & Fixed During Refactor

### 1. Noon separator lost (`buildTimelineString`)
Condition was `if (h === 12 && !isCurrent)` — when current hour was noon, the `|` separator was skipped entirely and `◆` rendered at its position. Both serve different purposes (AM/PM divider vs current-time marker) and should both render. Fixed: always emit `|` at h=12, then additionally emit `◆` if `isCurrent`.

### 2. `bin/serve.ts` stale import path
`bin/serve.ts` imported `shortenPath` from `serve/tui.js` (the old location). Caught only when esbuild rebuild failed. After the refactor, `serve/tui.ts` no longer exports `shortenPath`.

### 3. Bugfix: non-date filenames in `buildDisplayPath`
The original code used `filename.split("_")[0]` as the date prefix — for filenames without underscores, this returned the entire filename (e.g. `session.jsonl` as a "date prefix"). The extracted `extractDatePrefix()` uses a regex that correctly returns `""` for non-date patterns.

### 4. Unused imports cleaned up
After extraction, `bin/wtft.ts` still imported `getSessionSummary`, `SessionCandidate` (type), and `formatRelativeTime` — all only used inside the extracted modules now. Removed.

---

## Verification (passed)

1. `node bin/wtft.ts --help` — runs without error ✓
2. `node bin/wtft.ts -s 1` — discovers sessions, renders bar chart ✓
3. `node bin/wtft.mjs --help` — compiled bundle works ✓
4. `node bin/wtft.mjs -s 1` — compiled bundle discovers & renders ✓
5. `node tests/wtft-issue-21.test.ts` — all tests pass ✓
6. `node tests/wtft-auto-fit.test.ts` — all tests pass ✓
7. `node tests/wtft-spec-alignment.test.ts` — all tests pass ✓
8. `node build.mjs` — esbuild completes for all three CLI bins ✓
9. `node --experimental-strip-types --check bin/wtft.ts` — no type errors ✓
10. `npx tsx` verifies serve extension import chain ✓
