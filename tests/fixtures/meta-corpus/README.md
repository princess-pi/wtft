# `.meta.json` corpus

Real Claude Code subagent sidecars, copied unchanged from `~/.claude/projects/*/<session>/subagents/`
(the two Dynamic Workflow children from `subagents/workflows/wf_<id>/`) on the maintainer's host.
`tests/wtft-137-subagent-meta.test.ts` § M7c reads every file here on every host, CI included, so
the reader is checked against the harness's field names as they were at capture. Whether the
harness still writes those names is § M7b's job, on a host that has sidecars. Why they are here rather than hand-written:
`docs/spec-194-p9-housekeeping.md` § H2.

**Captured 2026-09-23, Claude Code 2.1.281.** File mtimes on the source host ran from 2026-08-10 to
2026-09-23.

| File | Shape it stands for |
|---|---|
| `agent-a20ea0d14166e9999` | Dynamic Workflow child: `agentType` and `spawnDepth` only |
| `agent-ab7a653fd7de39292` | Dynamic Workflow child with a `model` |
| `agent-a9b6ca6692517846a` | depth 2, carrying `parentAgentId` |
| `agent-aed7cbd64d6f241d1` | a fork: `isFork`, `model: "inherit"` |
| `agent-ace7ef5933e128a87` | a named agent type (`claude-code-guide`) |
| `agent-a12b520b52dfc5d2a` | a named dispatch (`name`) |
| `agent-a170388e12a7fa3bc` | a dispatch carrying `cwd` |

## Refreshing it

`M7b`, on a host with sidecars, fails when the newest real sidecar no longer matches what the reader
expects, or carries a key that no file here has. When that happens:

1. Find a recent sidecar of the new shape: any `agent-*.meta.json` under `~/.claude/projects` whose keys
   include the new one. Choose one from a repo that is not a client's, and read its `description`
   before you copy it, because this repo is public.
2. Copy it here unchanged, add a row to the table, update the capture line above, and add its name to
   `CORPUS` in the test. A key the reader does not use goes in the test's `IGNORED` list.
3. If the harness renamed a field rather than adding one, fix the reader in
   `extensions/lib/wtft-parser.ts` (`parseSubagentMeta`) and run `bun run build`, since the test
   reads the built bundle, and update `REQUIRED` / `NEAR_UNIVERSAL` in the test. `M7c` then fails on
   the older files here if the reader stopped accepting the old name; decide whether to keep both
   names, then refresh.
