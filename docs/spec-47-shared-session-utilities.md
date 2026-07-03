# Spec — Shared Session Path Shortener & Selector

> **Issue:** #47 — Extract session path shortener + selector into reusable lib
> **Status:** Spec Draft

---

## Motivation

Two independent UI patterns exist across this repo:

| Pattern | Location | Lines |
|---|---|---|
| `buildDisplayPath` | `bin/wtft.ts` | ~45 |
| `shortenPath` | `extensions/lib/serve/tui.ts` | ~8 |
| `formatRelativeTime` | `bin/wtft.ts` | ~12 |
| `selectSessionPrompt` | `bin/wtft.ts` | ~80 |
| `discoverSessions` | `bin/wtft.ts` | ~60 |
| `getSessionSummary` | `bin/wtft.ts` | ~20 |

None of these are importable across tools. `shortenPath` in serve's tui.ts is a different (simpler) implementation than `buildDisplayPath` in wtft.

The `watu` project (Rust TUI, outside scope for JS sharing) will need the same session path conventions documented when Phase 2 adds `.jsonl` tailing.

## Make vs Buy

Research results — see issue #47 for full search output:

**Path shorteners:** No npm library performs domain-specific Pi/Claude session path compaction (`home-user-git-projects-foo` → `~/g-p/foo`). General truncation libs (`cli-truncate`) handle visual-width ellipsis but not slug reconstruction.

**Interactive selectors:** `@inquirer/select` (v14) is well-maintained but pulls a dep tree for ~80 lines of raw stdin handling. Desired: zero-dep CLI bins.

**Verdict: Make > Buy.** Both patterns are domain-specific enough that a custom shared module is correct.

## Extracted Modules

### Module A: `extensions/lib/session-path-shortener.ts`

Pure functions, zero deps beyond Node builtins (`path`, `os`).

```typescript
export function buildDisplayPath(
  filename: string,
  dirSlug: string,
  harness: 'pi' | 'claude-code'
): string;

export function shortenPath(
  rawPath: string,
  cwd?: string
): string;

export function formatRelativeTime(
  ts: number
): string;
```

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

export function discoverSessions(
  harness?: 'pi' | 'claude-code' | 'auto'
): SessionCandidate[];

export function getSessionSummary(
  filePath: string
): { turns: number; cost: number };

export function selectSessionPrompt(
  candidates: SessionCandidate[]
): Promise<string>;
```

## Consumers To Update

| File | Change |
|---|---|
| `bin/wtft.ts` | Remove inline `buildDisplayPath`, `discoverSessions`, `formatRelativeTime`, `getSessionSummary`, `selectSessionPrompt`. Import from new modules. |
| `extensions/lib/serve/tui.ts` | Remove inline `shortenPath`. Import from `session-path-shortener.ts`. |
| `extensions/serve.ts` | Import `shortenPath` from `session-path-shortener.ts` instead of `./lib/serve/tui.js`. |

## What Stays Behind

Each module retains exactly what's specific to its domain:
- `serve/tui.ts`: serve-widget rendering (`updateWidget`, `buildKilledSummary`, `buildDiscoveredSummary`), ANSI helpers (`stripAnsi`, `getVisualLength`, `padVisual`), `isEmojiDisabled`
- `bin/wtft.ts`: CLI argument parsing, help/why printers, main flow, watch mode dispatch, subagent recursion, settings persistence
- `wtft-shared.ts`: All cost calculation, binning, bar chart rendering, interaction parsing — **unchanged**

## Verification

1. `node bin/wtft.ts --help` — runs without error
2. `node bin/wtft.ts` — discovers sessions, renders selector (if >1) or auto-selects
3. `node bin/wtft.ts -s 1` — numeric index still works
4. `node bin/wtft.ts -W` — watch mode still works
5. Pi extension `/wtft` — TUI widget still renders
6. `/serve` — widget still shows server paths with shortened display
7. Existing wtft tests pass
