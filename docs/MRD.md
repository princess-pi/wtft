# Market Requirements — tools built for Duppy and his agents

> **What this is.** This is a *market* requirements document (MRD): it describes the
> market — the audience — for the tools in this repository. It is not a product requirement
> and not a spec. Every product requirement (PRD, spec, `--help` contract, guard) for a
> tool in this repo is read against this document, because the audience decides how much
> security, how much error handling, and whether we build a wall or a tripwire.

## Audience

The tools are built for **one developer — Duppy — and his AI agents, on one machine** (a
headless VPS).

There is no hostile user and no multi-tenant boundary: no one is trying to break the tools.
The person running the tools is the person who wrote them, plus agents working on his behalf.
Nothing is sold to strangers; nothing runs as a public service. The tools do ingest
third-party text — web pages, issue and PR bodies, review comments — and that text is
untrusted *data*, treated as data never instructions. That is data hygiene, not an adversary.

## Tripwire, not a wall

Guidance lives in prose — the workflow skill, `CLAUDE.md`, `AGENTS.md`, tool `--help`. The
prose is the source of truth, and the agents are expected to follow it.

Guards exist for one reason only: at the current state of the art, LLMs commonly **forget or
bypass** prose. A guard is belt-and-suspenders — a **tripwire**, a reminder — **not a security
wall**. It is not defending against an adversary, because there is none.

That single fact determines how every guard is built:

> **Never reproduce a parser to enforce a guard.** If detecting a forbidden invocation would
> require re-implementing a command-line parser — Bash's, a shell's, a config format's — the
> check is in the wrong place. Put the check where the input has already been parsed.

Three placements, chosen by what the command is:

1. **A third-party command → a shim.** Put a PATH wrapper in front of the real binary and
   check its already-assembled `$@`. Worked example: `claude-nsp-guard`, deployed as
   `~/bin/claude`, which drops `--no-session-persistence` from `$@`, unsets
   `CLAUDE_CODE_SKIP_PROMPT_HISTORY` from the environment, then `exec`s the real CLI.
2. **Another command that already parses → build it in.** Do not add a detector beside it;
   extend the existing argument handling.
3. **Our own command → build the check into the command.** The command already receives the
   resolved arguments, so the check goes in its own arg handling. Worked example: `pr-review`
   refuses `--accept-lens-failure` when agent-harness env vars are set, inside its own parser.

**Corollary.** A guard that reads *raw command text* (a PreToolUse hook matching substrings,
for example) and tries to catch every quoting, escaping, expansion and globbing form is the
wrong shape. It will either re-derive the Bash parser or leak bypasses — usually both, a few
review rounds apart. A guard that cannot read the input it checks **refuses, never passes**;
an unreadable check is a fail-open verdict.

## Error handling — let the OS speak

The same audience sets the error-handling bar: **rely on the OS to report what is wrong, and
on the agent or human to read that report and fix it.** Do not write code that pre-checks,
catches, wraps, retries, or auto-fixes an error the OS already surfaces — a file that does not
exist, a permission denied, a missing command, running out of memory — unless a requirement
can name a specific harm the OS report would not surface.

## The market this does not serve

A different market — a service expected to run 24/7 unattended and self-heal, or anything
multi-tenant — would carry a much higher bar: adversarial inputs, near-complete
exception handling, automatic recovery. Nothing in these repos is that. The difference is
the audience, not the quality of the code.

## How product requirements use this

Every product requirement for these tools is read against this MRD. A requirement that asks
for adversary-proofing, or for error handling the OS already provides, is out of scope for
this market — and if it is kept, it must name the specific harm that makes the OS report
insufficient.
