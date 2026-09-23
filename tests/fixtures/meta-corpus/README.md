# `.meta.json` corpus

Real Claude Code subagent sidecars, copied byte for byte from `~/.claude/projects/*/<session>/subagents/`
on the maintainer's host. `tests/wtft-137-subagent-meta.test.ts` § M7c reads every file here, so the
harness field names are checked on every host, CI included. Why they are here rather than hand-written:
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

`M7b`, on a host with `~/.claude`, fails when the newest real sidecar carries a key that no file here
has. When that happens:

1. Find a recent sidecar of the new shape: any `agent-*.meta.json` under `~/.claude/projects` whose keys
   include the new one. Choose one from a repo that is not a client's, and read its `description`
   before you copy it, because this repo is public.
2. Copy it here unchanged, add a row to the table, and update the capture line above.
3. If the harness renamed a field rather than adding one, `M7c` fails on the older files too. Fix the
   reader in `extensions/lib/wtft-parser.ts` (`parseSubagentMeta`) first, then refresh.
