# Spec 165 — a subagent transcript dropped at READ marks the widget total provisional

**Issue:** [#165](https://github.com/princess-pi/wtft/issues/165) ·
**Test:** `tests/wtft-165-widget-subagent-drop.test.ts`

## The gap

The widget set its provisional flag from discovery alone. Discovery lists a subagent transcript
by **stat**, so a file whose READ then fails — mode 000, vanished, an EACCES that arrived between
the two — passes discovery, is dropped by the loader, and leaves the widget rendering a total
short by that file's whole cost with nothing said. The parser's warning goes to stderr, which the
TUI never shows.

The repro in the issue named a corrupt transcript. That is wrong and stays wrong: `parseSessionFile`
skips unparseable lines one at a time and never throws, which is [#94](https://github.com/princess-pi/wtft/issues/94).
Only a READ failure reaches this path.

## The fix

`loadSubagentInteractionsChecked(files, …)` returns `{ interactions, dropped }`. A file's turns are
pushed only once the whole file has classified, so a file in `dropped` contributes **none** of its
turns rather than a partial total. The widget sets its flag when `dropped` is non-empty, and
resets it on every render pass — including before the no-session early return, so one render's
flag cannot leak into the next.

The line reads **"some transcripts could not be counted — total is provisional"**. Not "read or
parsed": a file is dropped for any throw in the load, and the printed claim has to match why.

Every surface that prints a total carries it, not only the widget: the pager, `/wtft --tokens`,
`/wtft --other`, and the pager's own "no cost history" arm, which is exactly the state a session
reaches when every transcript is unreadable.

## Scope — what this does NOT close

The tag's own provisional verdict is a second cause, with its own line:
[#176](https://github.com/princess-pi/wtft/issues/176), `docs/spec-176-134-135-report-honesty.md`.

The CLI has no gap **in the modes that scan** — `--json`, `--tokens` and the non-pending empty
arms. A plain `wtft` run that renders bins never calls `scanSessionUncounted`, so it cannot
report `subagent-unreadable`, and exits 0 with the cost absent unless the tag's own verdict is
provisional; that scope predates this branch and is stated beside the exit code.

## Closer

`tests/wtft-165-widget-subagent-drop.test.ts` drives the built widget (`pi/wtft.js`) through a fake
`pi`/`ctx` with a separate sink per surface, fires `agent_settled` with a mode-000 subagent file,
and asserts the rendered lines carry the provisional line. Control and recovery renders show none.
