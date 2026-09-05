# Spec 160/161/162 — The readable surfaces of wtft: `--help`, `EXT_WTFT.html`, glossary

**Issues:** [#160](https://github.com/duppypro/princess-pi-tools/issues/160),
[#161](https://github.com/duppypro/princess-pi-tools/issues/161),
[#162](https://github.com/duppypro/princess-pi-tools/issues/162)
**Branch:** `160-161-162-wtft-spec-surfaces`
**State:** Code and Spec Approved (tested; reconciled to shipped code)

---

## 1. Why one branch for three issues

All three are the doc/manifest layer of the same tool, and #162's `_Avoid_` ruling and #161's
spec index both depend on the same evidence-gathering pass (grep counts, `getBinInfo` reading,
current spec inventory). Bundling avoided doing that pass three times. This branch owns
`docs/manifests/wtft-cmd.json`, `docs/EXT_WTFT.html`, `CONTEXT.md`, and `build.ts` for the
duration — no other branch touches them.

---

## 2. #160 — `--help` omits the turn interval unit

### 2.1 Evidence, verified myself

`extensions/lib/wtft-renderer.ts:150-163`:

```ts
export function parseInterval(val: string): IntervalConfig {
	const timeMatch = /^(\d+)([mhdw])$/.exec(val);
	if (timeMatch) { ... return { size, unit, type: "time" }; }
	const turnMatch = /^(\d+)(?:t|turns?)$/.exec(val);
	if (turnMatch) { ... return { size, unit: "t", type: "turns" }; }
	return { size: 1, unit: "h", type: "time" };
}
```

`docs/manifests/wtft-cmd.json:114` (before this branch):

```json
{ "flags": "-i, --interval <size><m|h|d|w>",
  "desc": "Group cost data into arbitrary binned intervals of minutes, hours, days, or weeks (e.g., 1m, 7m, 4h, 1d, 2w; default: 1h)." }
```

`rg -ci turns docs/manifests/wtft-cmd.json` → `0`, confirmed. Issue #160's own "Verification"
section claims `bun run test` already guards this because `wtft-spec-alignment.test.ts` "reads
the manifest" — **false, checked, state before this branch's §2.2 extension**: `rg -l
"manifests" tests/` returned nothing, and `tests/wtft-spec-alignment.test.ts` imported only
`buildWtftLines`, `parseEntryToInteraction`, `classifyInteraction` from `bin/wtft.mjs` — no
`fs.readFileSync` of the manifest anywhere in `tests/`. Zero suites read
`docs/manifests/wtft-cmd.json` at that point. The issue text was stale on this specific point;
the manifest gap it describes was real. (§2.2's new V3 gate below is what changed this — the
file now also imports `parseInterval` and does `fs.readFileSync` the manifest; this paragraph
describes the pre-fix state that justified building that gate, not the file's content today.)

### 2.2 Direction

Manifest copy only — `parseInterval` is unchanged, already correct, already tested by
`tests/wtft-issue-121.test.ts`.

- `flags`: `-i, --interval <size><m|h|d|w|t>`
- `desc`: add the turn unit and its spellings, one `examples` entry with `-i 5t`
- **New:** extend `tests/wtft-spec-alignment.test.ts` so any unit letter/spelling
  `parseInterval` accepts and the manifest's `-i` entry does not mention fails the suite. This
  is the actual fix — #160 itself is one instance of "an accepted unit is undocumented"; the
  missing *gate* is what let it happen silently for the length of #121 through #158.

**Gate mechanism, so it isn't gameable by hand-editing text to satisfy a hardcoded list:** the
test brute-forces every ASCII lowercase letter `a`..`z` as a candidate time-unit suffix
(`3${ch}`) against the real `parseInterval`, and separately probes the three turn spellings
(`5t`, `5turn`, `5turns`). Whatever comes back accepted is checked against the manifest's `-i`
flag string and description — not against a second hardcoded copy of `mhdwt`. If `parseInterval`
grows a new unit tomorrow and nobody touches the manifest, this test fails without anyone
having to remember to update the test too.

### Roads not taken

- **Hardcode the expected unit set (`"mhdwt"`) in the test.** Faster to write, but it is the
  same failure mode as the bug: a second place that must be kept in sync with `parseInterval`
  by hand. The brute-force probe reads the parser's actual behavior instead of a second opinion
  of it.
- **Change `parseInterval`'s regex to also read from the manifest at runtime** (single source
  of truth the other direction). Rejected for scope — #160 is explicitly "manifest copy only,
  no code change," and coupling the parser to a JSON file it does not otherwise depend on adds
  a runtime file read to a hot path for no behavioral gain.

---

## 3. #161 — `EXT_WTFT.html` should be the system spec root

### 3.1 Evidence, verified myself

`rg -o 'href="[^"]*"' docs/EXT_WTFT.html` → 0 matches, confirmed. `rg -n '<h[1-6]' docs/EXT_WTFT.html`
→ one `<h2>` (line 46, the page title) and the rest `<h3>`/`<h4>`; no section nesting a reader
could navigate.

The issue's framing — "the manifest half already works... `fetch('manifests/wtft-cmd.json')`...
does not copy the flag reference" — is **half right, checked**. `docs/EXT_WTFT.html:317`'s
`fetch` only renders the `why` array (the `--why` scenarios), confirmed by reading the script
block (`:316-345`): it builds `s.scenario`/`s.commands`/`s.result` HTML and nothing else. The
flag reference is a **separate, hand-written, hardcoded `<ul>`** at `:56-67` ("Command Reference
→ Options") — 9 `<li>` entries duplicating a subset of the manifest's `usage` entries, already
stale in three ways I found by diffing it against `docs/manifests/wtft-cmd.json`:

1. It has the same `<m|h|d|w>` gap as #160 (independently — this is a second copy of the same
   stale string, not a downstream consequence of the manifest one).
2. It lists `-c, --cumulative` and `-b, --bucket` as two separate flags; the manifest has always
   documented them as one row (`"-c, --cumulative, -b, --bucket"`).
3. It is missing 16 documented flags outright — `--tokens`/`--by-model`,
   `--watch`, `--emoji`, `--harness`, `--thinking-budget`, `--pad`, the daemon management group
   (`--list`/`--cleanup`/`--restart`/`--stop`/`-F`), `--help`/`--version`/`--why`.

So the "keep and extend the fetch pattern" instruction in the issue is achievable exactly as
framed, but the target is bigger than the issue states: the `--why` fetch is not the only thing
to extend — the **hardcoded flag list needs replacing**, not just supplementing, or #161 ships
a page with two flag references, one correct-forever (fetched) and one stale-forever (prose).

### 3.2 Direction

1. **Replace** the hardcoded `<ul>` Options block (`:56-67`) with a second `fetch`-driven render
   off the same `data.usage` array already in the manifest and already loaded for `--why`. One
   `fetch`, two render targets (`#wtft-flag-reference`, `#wtft-why-reference`).
2. **Section structure**: add `id` attributes to every existing `<h3>` so anchors are real
   (`#overview`, `#command-reference`, `#classification`, `#surge-timeline`, `#tui-style`,
   `#architecture`, `#pricing`, `#config`, `#verification-plan`, `#daemon-health`,
   `#detailed-specs`, `#why` — 12 headings, all of them, not just the ones with obvious nav
   value), and a short in-page nav list right under the intro paragraph linking each — all 12,
   including `#verification-plan` (a small three-`<li>` placeholder section that still earns a
   direct jump target since the nav links every heading uniformly rather than curating) — this
   is where the `href` count goes from 0 to 32.
3. **New "Detailed specs" section** (`#detailed-specs`) — a static index (not fetched; these are
   files, not manifest data) of every `docs/spec-*.md` belonging to wtft, one-line summary, issue
   number(s), each an `<a href="spec-NNN-*.md">`. Includes an explicit note for the six branches
   landing in parallel (see §3.4) so the index is honest about what exists on this branch versus
   what merge will add, rather than silently wrong until then.
4. **Superseded-spec policy** — see §3.3.

### 3.3 Superseded-spec ruling

Audited all 10 spec files currently on disk against the shipped code they describe, spot-checked
the two most likely to have drifted:

- **spec-109** (half-block bars): `rg -c '▌' extensions/lib/wtft-renderer.ts` → non-zero, and the
  code comments cite `#109` directly at the render call sites (`:1281`, `:1316`). Still current.
- **spec-52** (category phases 1-2): the `Category` union in `extensions/lib/wtft-parser.ts:30`
  and the overhead-trio comment in `wtft-renderer.ts:41,54-55` (`Ovrhd`/`Waste`/`Cmpct`,
  "Phase 3 (#52) wired the overhead trio") match what spec-52 describes for the phases it covers.
  Not superseded — Phase 3/4 material lives in code comments referencing #52 but was never
  written up as its own spec file; that's a documentation gap, not a contradiction, and out of
  scope here.

No spec file on disk today contradicts shipped code. **Ruling: mark, never delete.** A spec
whose behavior a later branch supersedes gets a `**Status:** Superseded by #NNN — see
spec-NNN-*.md` line added at its top (the convention several specs already use informally, e.g.
`docs/spec-139-140-141-pricing-and-workflow-rollup.md`'s `**Status:** Code and Spec Approved
(tested; reconciled to shipped code)`); it stays linked from the Detailed Specs index, just
visually marked. Reasons, not vibes:

- `docs/spec-158-one-test-runner.md` §9's reconciliation table already cites `spec-*.md` paths as
  permanent evidence trail entries — deleting a spec breaks a citation another spec makes.
- Git history is not a substitute for "the file loads at the URL a reader clicked" — deletion
  makes the link this issue is adding immediately break, which is the opposite of #161's point.
- `CONTEXT.md`'s `_Avoid_` mechanism (the enforceable one) lives in a different file with a
  different lifecycle; specs describe *episodes* (what changed, why, what was verified) rather
  than living *state*, so "superseded but present" is the accurate description of an episode
  whose conclusion a later episode revised — not an error to erase.

### 3.4 The six specs landing in parallel

Five sibling branches are adding spec docs that do not exist on this branch yet. I looked up
each issue to write an honest one-line summary rather than inventing one from the filename
alone:

| File | Issues | Summary (from the issue body) |
|---|---|---|
| `spec-144-145-164-session-discovery.md` | #144, #145, #164 | Session selector misses Claude sessions in dotted-path worktrees (#144), doesn't search sibling worktrees (#145), and loses sessions stranded in a removed worktree (#164). |
| `spec-148-sonnet-5-intro-pricing.md` | #148 | wtft billed Sonnet 5 at the post-intro $3/$15 rate; the intro rate is $2/$10 through 2026-08-31 — a 50% over-bill on every Sonnet line. |
| `spec-149-compaction-cost-scope.md` | #149 | wtft vs. the Claude Code status line: ~11% cost gap on an identical session; wtft's own math checks out, 1h cache-write tier rate is the prime suspect. |
| `spec-159-pack-and-smoke.md` | #159 | *Not wtft-specific* — the repo's only tested install channel (`bun link`) skips `npm pack`'s `files` allowlist and staleness checks entirely; every packaging bug is currently invisible. |
| `spec-163-spec-reconcile-backtest.md` | #163 | *Not wtft-specific* — validates the `spec-reconcile` skill (written during #158, never run) against three known drifts with pre-computed right answers, one of which *is* this branch's #160. |

`#159` and `#163` are repo-wide process specs, not wtft features — their fixtures happen to be
wtft bugs, which is not the same thing as the spec being about wtft. Included per explicit
instruction (five sibling branches, index all of them) rather than by my own scoping judgment;
flagged as cross-repo in the HTML rather than silently filed under wtft.

### Roads not taken

- **Full rewrite of `EXT_WTFT.html` into a new document.** The existing prose (SURGE timeline,
  classification taxonomy, architecture, daemon health) is accurate and not manifest-derivable —
  it describes *why*, which the manifest's `usage`/`why` arrays don't carry. Restructuring
  in place (ids + nav + two new sections) fixes the actual complaint (no links, one heading,
  duplicated flag prose) without discarding correct content.
- **Delete superseded specs instead of marking them.** See §3.3 — breaks citations, breaks the
  links this issue adds, and specs aren't state that needs a single current value.
- **A build-time generated index** (script that globs `docs/spec-*.md` and writes the HTML
  section). Real DRY win, but it turns a doc file into a build artifact, which conflicts with
  this repo's `⚠️ GENERATED` banner convention (`build.ts` generates `.mjs` and one `.ts`
  registry file — extending "generated" to hand-authored prose docs is a bigger convention
  change than #161 asks for). A hand-maintained index with a test asserting completeness (§5,
  V3) gets the safety property without the convention change.

---

## 4. #162 — `## Language — WTFT` in `CONTEXT.md`

### 4.1 The daemon / log-parser ruling, with evidence

Counts, measured on this branch (not trusting the issue's numbers, which turned out close but
not identical):

| Term | Where | Count (my `rg -ci`, this branch) |
|---|---|---|
| `daemon` | `extensions/lib/wtft-daemon-lib.ts` | **131** (issue said 108 — issue undercounts, not stale-wrong, just an earlier snapshot) |
| `daemon` | `docs/manifests/wtft-cmd.json` | 1 (`"Is wtft-daemon installed?"`-style context only, not a standalone label) |
| `log parser` | `docs/manifests/wtft-cmd.json` | 5 (`--list`, `--cleanup`, `--restart`, `--stop`, `-F`) |
| `log parser` | repo-wide (`rg -ci "log parser" -g '!node_modules' .`, summed per-file) | 68, across `bin/wtft-daemon.{ts,mjs}` (27), `bin/wtft.{ts,mjs}` (4), `docs/wtft-incremental-render-spec.md` (9), `docs/EXT_WTFT.html` (8), the manifest (5), `extensions/wtft.ts` (4), `extensions/lib/wtft-cli-shared.ts` (3), `extensions/lib/wtft-daemon-lib.ts` (4), `session-selector.ts` (1), one test (3) |
| Filenames containing `daemon` | repo-wide | `bin/wtft-daemon.ts`, `bin/wtft-daemon.mjs`, `extensions/lib/wtft-daemon-lib.ts`, `wtft-daemon` (wrapper), `debug/verify-daemon-parse.mjs`, `docs/spec-95-daemon-lifecycle.md`, `docs/spec-156-155-harness-seam-and-daemon-follow.md`, `research/wtft-daemon-spec.md`, `tests/wtft-daemon-cost-cross-validation.test.ts`, `tests/wtft-daemon-lifecycle.test.ts`, `tests/wtft-daemon.test.sh`, `tests/wtft-issue-155-daemon-follow.test.ts` — **12 files** (re-verified at Step 2 with `fd -HI daemon --type f`; the Step 1 draft undercounted by one, missing the `debug/` script), not the issue's "three" (issue undercounted filenames too) |

Daemon wins on every axis that isn't the manifest's user-facing strings: overwhelming code
volume, every filename, both spec files about the thing. `log parser` is not a typo or a stray
usage — it is the manifest's and `EXT_WTFT.html`'s consistent choice, which is exactly the
"two names, one per layer, both deliberate" shape #162 describes. **Ruling: Daemon wins.**
`log parser` goes on its `_Avoid_` list. Renaming the manifest strings and `EXT_WTFT.html` prose
to match is production/doc-content work with its own blast radius — tracked as a follow-up
issue (§4.3), not done on this branch, per #162's own explicit instruction.

> **REVERSED 2026-08-10 — see #162 and #165.** The above stands as the record of what was ruled
> and why; it is no longer the standing ruling. Duppy reversed it in favour of a two-register
> rule that this analysis never considered: **"log parser daemon"** in high-level user-facing
> prose, **"daemon"** as sanctioned shorthand in code, variable names, comments, and terse
> operational messages. Bare **"log parser"** remains avoided — that part of the ruling survived.
>
> Two things this section got wrong, worth keeping visible:
>
> 1. **The framing was binary.** "Roads not taken" below considers exactly two options — daemon
>    wins, or log parser wins — and picks the cheaper rename. Both options assume one word must
>    serve every register. The reversal's premise is that it cannot: a reader meeting the process
>    for the first time and a variable name have different needs, and the cost being weighed
>    (renaming 11 filenames vs. 13 doc strings) was never the real cost.
> 2. **The 68-count row is right; the ruling was made against 13 of them.** §4.3 and #165's
>    original body both describe the work as manifest + `EXT_WTFT.html` only, and #165 went
>    further and asserted "code already says `daemon` throughout" — contradicted by this very
>    table, which lists 28 `log parser` occurrences in `.ts` sources three rows up. The evidence
>    to catch that was on the page and went unread. `wtft --cleanup` printing
>    `Cleaned up 0 log parser(s).` (`bin/wtft-daemon.ts:822`) is what surfaced it, in one command,
>    a day later.
>
> **As shipped (#165, 2026-08-10).** All 69 occurrences resolved; 52/52 suites green. Per surface:
> `wtft-daemon --help` header teaches the long form, its flag lines and the `Daemon mode:` heading
> use the shorthand; the five manifest `desc` strings each carry the long form, because `--why`
> renders them with no header above; runtime output (`Cleaned up N daemon(s).`) and all comments
> use the shorthand; `EXT_WTFT.html` and this doc teach in headings and refer in bodies. Every
> bare `log parser` that survives in the tree is the term being *mentioned* — glossary rule text,
> this record, test assertion strings — never *used* to name the process.
>
> Two corrections landed incidentally, in sentences the rename was rewriting anyway:
>
> - `EXT_WTFT.html:321` and `docs/wtft-incremental-render-spec.md:66,138` quoted a watch-mode
>   footer reading `r to restart log parser`. The code emits `'r' to restart`
>   (`extensions/lib/wtft-daemon-lib.ts:975`) and always has. The #163 backtest had already
>   flagged this (finding 91); it is part of #167's ~30. Corrected rather than renamed, since
>   renaming a quote of a string that does not exist only makes the drift harder to spot later.
> - The architecture diagram's `wtft-daemon (log parser)` gloss was dropped rather than expanded —
>   the box had 5 spare columns and the long form needed 7. See the "when the long form does not
>   fit" rule now in `CONTEXT.md`, which this case is what produced.

### 4.2 Bin vs. bucket, confirmed by reading the code (not guessed)

`extensions/lib/wtft-renderer.ts:218-229`, `getBinInfo(timestamp, config: IntervalConfig,
turnIndex, tz)`: takes an `IntervalConfig` (`{ size, unit, type }`, produced by `parseInterval`)
and a timestamp, and returns which **bin** (`key`, `label`, `dateStr`) that timestamp falls into
— for turn-mode, `binEnd = Math.ceil(turnIndex / size) * size`. This is grouping by time-or-turn
position. It has nothing to do with rendering.

`extensions/wtft.ts:115` / `wtft-renderer.ts:795,804`: `mode: "bucket" | "cumulative"` is the
**render mode** — set by `-c/--cumulative` (default, running sum per bar) vs. `-b/--bucket`
(discrete per-bin total, no running sum). Confirmed distinct concepts: every render, regardless
of mode, first bins interactions via `getBinInfo`; `mode` then decides how each bin's total is
displayed (`wtft-renderer.ts:907` `if (mode === "cumulative")` accumulates across bins in
render order — that step doesn't exist in bucket mode).

Found a third sense while reading: `wtft-renderer.ts:1292`, inside the **cumulative**-mode
overlap-resolution code, `const buckets = new Map<number, {...}[]>()` — a local variable named
`buckets`, unrelated to the `-b/--bucket` flag, grouping same-column markers for the "multiple
categories land on the same terminal column" tie-break. Not user-facing, not a public symbol,
but worth pinning in the glossary anyway: **"bucket" is the more overloaded word of the two** —
it names a render mode, appears in an unrelated local variable, and unrelated code comments use
"binned"/"bucket" informally as synonyms for what the type system calls a bin. **Bin** is the
cleaner term for "the interval/turn-position grouping unit"; **bucket** is reserved for the
render mode only. Glossary encodes both rulings.

### 4.3 Follow-up issues filed

Per #162's explicit instruction that renaming code belongs in its own 5-step cycle:

- Rename `log parser` → `daemon` in `docs/manifests/wtft-cmd.json` (5 occurrences) and
  `docs/EXT_WTFT.html` (8 occurrences) to match the `_Avoid_` ruling. Filed as **#165**.
  *(Superseded — see the reversal note in §4.1. #165 was rewritten 2026-08-10 to apply the
  two-register rule across all 69 occurrences, code included, on one branch.)*
- One tracking issue for `## Language — Merge`, `## Language — Yada`, and the remaining
  extensions without a glossary section yet (mirrors the `## Language — Serve` precedent).
  Filed as **#166**.

(Issue numbers assigned when filed via `gh issue create`; see the Step 1 status comments for the
actual numbers if they differ from this draft — GitHub assigns at creation time, not before.)

### Roads not taken

- **Ruling in favor of "log parser."** It's the user-facing/manifest term today, and changing
  user-facing copy has a cost `_Avoid_`-listing code comments doesn't. But #162 is explicit that
  the ruling should follow evidence, and every non-manifest axis — volume, every filename, both
  spec files, the internal API surface (`checkDaemonHealth`, `renderDaemonStatus`,
  `wtft-daemon-lib.ts`) — says daemon. Ruling the other way would mean renaming 11 filenames and
  131+ call sites to match 5 manifest strings and 8 HTML mentions; the correction runs the
  cheaper direction.
- **Leave bin/bucket unresolved ("they're basically the same, don't worry about it").** #162
  named this the second-strongest split after daemon/log-parser specifically because
  `-c/--cumulative` vs `-b/--bucket` reusing "bucket" for something `getBinInfo` doesn't produce
  is exactly the kind of silent overload the glossary exists to catch.

---

## 5. Spec gate — verification criteria

| # | Check | Expected | How verified |
|---|---|---|---|
| V1 | `node bin/wtft.mjs --help` | Output mentions the turn unit (`t`, and the word "turns") | Manual run after manifest edit, output inspected for the string |
| V2 | `node bin/wtft.mjs --why` | Runs clean, no new errors, existing scenarios unaffected | Manual run, diffed against pre-change output for unrelated scenarios |
| V3 | New/extended test in `tests/wtft-spec-alignment.test.ts` | Brute-force probe of `parseInterval` against the manifest's `-i` flag string; **fails** if a unit the parser accepts is undocumented | `bun test tests/wtft-spec-alignment.test.ts` — exit 0 after the manifest fix; can be proven to catch regressions by reverting the manifest edit locally and re-running (not committed — see V3b) |
| V3b | Regression-proof for V3 | Reverting the manifest's `-i` entry back to `<size><m\|h\|d\|w>` makes V3 fail | Executed at Step 2: reverted `flags`/`desc` in place, ran `node --experimental-strip-types tests/wtft-spec-alignment.test.ts`, confirmed the `#160` block FAILs with the exact "manifest description never mentions turn" message, restored the file, confirmed `git diff` empty |
| V4 | New test asserting every `docs/spec-*.md` on disk is `href`-linked from `docs/EXT_WTFT.html` | PASS on this branch's file set; comment in the test explains why the reverse (every link resolves) is deliberately not asserted — five sibling specs are legitimately absent until merge | New test file, `bun test <file>` exit 0 |
| V5 | `docs/EXT_WTFT.html` flag reference | No flag/behavior text is a second hardcoded copy of manifest content — the old `<ul>` Options block is gone, replaced by a `fetch`-driven render off `data.usage` | Manual diff of the file; `rg -c 'interval.*<size>' docs/EXT_WTFT.html` before/after (should drop from 2 static occurrences to 0, all through the manifest fetch) |
| V6 | `docs/EXT_WTFT.html` `href` count | > 0 (was 0) | `rg -o 'href="[^"]*"' docs/EXT_WTFT.html \| wc -l` |
| V7 | `CONTEXT.md` `## Language — WTFT` section | Exists, every entry has `_Avoid_:`, matches the `## Language — Serve` format | Manual read; `rg -c '_Avoid_:' CONTEXT.md` under the new section should equal the entry count |
| V8 | `bun run build` | Succeeds; no generated `.mjs` hand-edited (none of this branch's changes touch `.ts` sources that build to `.mjs`) | `bun run build && git status --short` shows no unexpected `.mjs` diff |
| V9 | `bun run typecheck` | No new errors beyond any pre-existing known ones | Manual run, diffed against baseline |

Per the CLAUDE.md Step 3 rule, **V1–V9 were not run before the Code Draft commit** — that
handoff to Step 4 is now closed: all nine were run and passed at Step 2/4 of this same pass (this
spec doc is corrected in place first — §2.1, §4.1 — per the ordering rule that Spec Approved
precedes Code Approved). See the Step 4 status comments on #160/#161/#162 for the exact commands
and output.

---

## 6. Step 5 — reconciliation record

Ran the `spec-reconcile` process (skill written during #158, first live use here) over every
file this branch touched (`CONTEXT.md`, `docs/EXT_WTFT.html`, `docs/manifests/wtft-cmd.json`,
this spec doc, the three test files) plus the production file this branch's own evidence cites
as authority (`extensions/lib/wtft-renderer.ts`), read in full rather than only at the quoted
line ranges — file-level blast radius, not symbol-level, per the skill's §1. Every quantitative
claim in §2–§4 above (href count 32, daemon count 131/12-filenames, log-parser count 68,
`_Avoid_` correspondence, spec-index completeness) was re-derived independently with fresh `rg`/
`fd` runs and the two doc-index/glossary-format tests re-executed by hand — all confirmed
accurate as drafted. Two passes: first found the three issues below; second (after fixing them)
found nothing new.

| Artifact | Claim | Contradicted by | Covered by a test? | Action |
|---|---|---|---|---|
| `docs/spec-160-161-162-wtft-spec-surfaces.md` §3.2 (before this commit) | "nav omits `#verification-plan`" | `docs/EXT_WTFT.html:60` — the nav `<a href="#verification-plan">Verification Plan</a>` is present; all 12 headings are linked, none omitted | ✅ `tests/wtft-doc-spec-index.test.ts` (counts total hrefs = 32, which only holds if all 12 nav links exist) | Fixed in this commit — §3.2 point 2 reworded to match the shipped nav |
| `docs/manifests/wtft-cmd.json:232` `examples` | `"cmd": "/wtft -t America/New_York"` | `extensions/lib/wtft-cli-shared.ts:74-76` — "`-t` and `-T` shortcuts are intentionally NOT supported. `-t` was overloaded across --timezone, --tokens, --ticks..."; the parser has no `arg === "-t"` branch anywhere (`:78-260`) | ❌ no test runs manifest `examples` commands against the parser (only the `-i` `usage` entry is gated, by V3/#160) | Fixed in this commit (`-t` → `--tz`); reconciled-against-untested — the `examples` array as a whole has no alignment gate the way `usage`'s `-i` entry now does after #160. Worth a follow-up test extending V3's pattern to `examples`, not filed as its own issue here (out of scope for three already-large issues) |
| `docs/spec-160-161-162-wtft-spec-surfaces.md` §2.1 | "`tests/wtft-spec-alignment.test.ts` imports only `buildWtftLines`, `parseEntryToInteraction`, `classifyInteraction`… no `fs.readFileSync` of the manifest anywhere" (read as present tense) | The file this branch itself ships imports a 4th symbol, `parseInterval`, and does `fs.readFileSync` the manifest at `:453-454` (the new V3 gate) | ✅ `tests/wtft-spec-alignment.test.ts` (the block being described) | Fixed in this commit — reworded to mark explicitly as the pre-fix state that motivated §2.2's new gate, not a claim about the file today |
| `extensions/lib/wtft-renderer.ts:143-149` | JSDoc directly above `parseInterval` (`@param filePath`, `@returns … duplicate message.id entries`, mentions `deduplicateInteractions`) | Describes `parseEntryToInteraction`, which lives in a different file (`wtft-parser.ts:154`) and has no docstring of its own there; `parseInterval` (`val: string` → `IntervalConfig`) has nothing to do with `.jsonl` files or dedup | ❌ no test asserts docstring-to-symbol binding | **Not fixed here** — `wtft-renderer.ts` is outside this branch's declared file ownership (§1) and five sibling branches are editing concurrently; comment-only fixes still need to land in a branch that owns the file. Filed [#174](https://github.com/duppypro/princess-pi-tools/issues/174); reconciled-against-untested |

Re-verified after the fixes: `bun run test` (45/45 suites green, including the three touched by
this branch), `bun run typecheck` (same 2 pre-existing branch-unrelated TS7016 errors), `bun run
build` (`git status --short` shows only the two doc edits above, no `.mjs` diff — V8 holds),
`node bin/wtft.mjs --help` (shows `--tz, --timezone` in the flag reference and the corrected
`/wtft --tz America/New_York` example), `node bin/wtft.mjs --why` (exit 0). Both re-run test
suites that check the edited artifacts mechanically —
`tests/wtft-doc-spec-index.test.ts` (32 hrefs, 11/11 specs linked) and
`tests/context-glossary-format.test.ts` (33 checks) — passed clean on the corrected files.

---

— 👑π🐱 Princess Pi
