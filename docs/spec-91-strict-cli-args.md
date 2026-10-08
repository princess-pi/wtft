# A wtft call it cannot read is refused

Module: `extensions/lib/wtft-cli-shared.ts` · Seam: `parseWtftCliArgs`, tested in `tests/wtft-91-strict-cli-args.test.ts`

## The gap

`parseWtftCliArgs` matched each argument against its known flags and dropped anything else. A
typo'd `--jsonn` rendered the ANSI chart and exited 0, which a caller checking `$?` cannot tell from
a good `--json` run. A valued flag that could not use its value kept the default and left the value
to be read as one more argument, and `--stop` took the next argument whatever it was, so
`wtft --stop --json` sent `--json` to the daemon as a session path.

## Behaviour

**The parser returns the refusal; it never exits.** `parseWtftCliArgs(argv)` stays a pure function.
Its result carries `usageError`: `undefined` for a call it can read, else one sentence saying why
the first argument it cannot read was refused. It parses the rest anyway, so the other fields still hold what it could
read. Each caller decides what a refusal does.

**Refused** (`usageError` set):

- **An unknown flag:** any argument starting with `-` that is not a flag wtft takes. That includes
  the `--flag=value` spelling of a flag that takes its value only as the next argument
  (`--session=x`, `--pad=3`), a short flag with `=` (`-i=7m`), short flags run together (`-hW`),
  `--`, and a lone `-`.
- **A valued flag with no value:** the last argument (`wtft --stop`), followed by an empty argument,
  or followed by an argument starting with `-` (`wtft --stop --json`, `--pad -2`, `--tz -05:00`).
  That next argument is not consumed; it is read as an argument of its own. A value that starts
  with `-` is given with `=` where the flag has that spelling (`--tz=-05:00`).
- **A value the flag cannot use:**
  - `-i`/`--interval`: anything but a whole count of 1 or more and a unit (`7m`, `4h`, `1d`, `1w`,
    `5t`, `5turns`).
  - `-l`/`--limit`, `-w`/`--width`, `--thinking-budget`: anything but a whole number of 1 or more
    (`abc`, `3.5`, `5x`, `0`).
  - `--pad`: anything but a whole number of 0 or more.
  - `--harness`: anything but `pi`, `claude-code` or `auto`.
  - `--tz`/`--timezone`: a zone the runtime's `Intl` does not know.
  - The `=` spellings, `--interval=`, `--limit=`, `--width=`, `--tz=` and `--timezone=`, take the
    same values; an empty one is refused.
- **A bare word:** any argument that is neither a flag nor a flag's value.

`-s`/`--session`, `--dir`/`--cwd` and `--stop` take any non-empty value that does not start with
`-`; what that value names is checked where it is used, as before.

**Bare words.** One gives a word meaning today: `spawn-record`, and only as the CLI's first
argument, where `bin/wtft.ts` dispatches it to its own parser before the report path runs. No
caller in princess-pi-tools passes any other bare word: its callers run `wtft spawn-record …`
(`agent-new`, `claude-nsp-guard`, `pr-review`). So every other bare word is refused, and so is
`spawn-record` anywhere but first (`wtft --json spawn-record` was a report run; it is now a refusal).

**The CLI** (`bin/wtft.ts`): a refused call prints the sentence on stderr, nothing on stdout, and
exits **2**. The refusal comes before anything the call asks for: no help, no report, no daemon
spawn, no daemon command, and no `-p` refusal. From a deleted working directory it moves to the
home directory, silently, and neither moves to `--dir` nor warns. `spawn-record`'s own exit 2 is
unchanged.

**The Pi extension** (`/wtft`): a refused call shows the sentence as an `error` notification and
does nothing else: no widget change, no config write, no render.

**The chart picker page** (`artifacts/chart-spec/picker.html`) and `renderReport` ignore
`usageError`. The page parses the command line on every keystroke, so a half-typed `-i` sets it
until its value arrives, and the page draws what the rest of the line says meanwhile.

**Not changed:** contradictory flags (`--hide --show`, `--cost --tokens`) are still read as before;
a well-formed flag a caller does not use (`--json` and the daemon flags in Pi, `-w` in the CLI) is
still accepted there and ignored.

## Verification

`tests/wtft-91-strict-cli-args.test.ts`:

- **P** the parser, in memory: each refused shape above sets `usageError` naming the token, and
  every accepted spelling (each flag, each `=` form, a valued flag followed by its value) leaves it
  `undefined`.
- **C** the built CLI: `wtft --jsonn`, `wtft --limit abc`, `wtft --harness bogus`, `wtft -i 9x`,
  `wtft --stop`, `wtft --stop --json`, `wtft foo` and `wtft --help --bogus` each exit 2 with stdout
  empty and the offending token on stderr, and write no daemon log, lease or pid file.
  `wtft --dir rel --bogus` from a deleted working directory exits 2 with one line on stderr.
- **X** the Pi `/wtft` handler on a recording context: `--jsonn` notifies once at `error` naming
  it, and sets no widget and writes no config.

`tests/wtft-26-json.test.ts` §1 checks that `wtft --json` with a session still prints one JSON
object, §7 that exit 2 is in the manifest's exit-code table, and
`tests/wtft-75-doc-claims.test.ts` that the README names only flags the parser accepts.

## Reconciliation

| Artifact | Claim | Contradicted by | Covered by a test? | Action |
|---|---|---|---|---|
| manifest `-i`, `-l`, `-w`, `--harness`, `--stop`, `spawn-record`; README; spec-26 | a bad value or bare `--stop` is ignored; `wtft --json spawn-record` is a report run | `parseWtftCliArgs` refuses them | ✅ P3, P4, C | Fixed |
| manifest exit 2 row, README, spec-26, spec-116 | the report path never exits 2 | the CLI exits 2 on `usageError` | ✅ C | Fixed |
| this spec, manifest `-i` | a whole count and a unit | `-i 0h` was accepted, then drawn as 1h | ✅ P4 | Code now refuses a 0 count |
| this spec | nothing else runs | from a deleted working directory the move to `--dir`, its warning and its exit 1 ran first | ✅ C | Code now skips them on a refused call |
| manifest description, exit 2 row, README, spec-26 | stderr names the argument; nothing about `--help`/`--json`/`-p` | the refusal wins over all three, and names the flag for a dash-led value | ✅ C | Fixed: "says why", precedence stated |
| spec-26 suppressed flags | passing one alongside `--json` is not an error | a malformed one is refused | ✅ C | Fixed: "well-formed" |
| chart-spec `spec.mdx`, `picker.html` | the CLI ignores `-w` | the CLI refuses a malformed `-w` | ✅ P4 | Claim deleted |
| `CONTEXT.md` **CLI** | refuses only `-p` | also exits 2 on a call it cannot read | ✅ C | Fixed |
| README spawn-record mechanism table | "PATH shim" | `_Avoid_` term in `CONTEXT.md` | — | Fixed |

Pre-existing spawn-record, `-p` and exit-table gaps outside these files are filed as
https://github.com/princess-pi/wtft/issues/481. princess-pi-tools `research/` drafts and frozen
backtest transcripts still describe the old ignore-silently parser; they are history and stay.
