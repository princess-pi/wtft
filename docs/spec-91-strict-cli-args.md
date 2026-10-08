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
Its result carries `usageError`: `undefined` for a call it can read, else one sentence naming the
first argument it cannot. It parses the rest anyway, so the other fields still hold what it could
read. Each caller decides what a refusal does.

**Refused** (`usageError` set):

- **An unknown flag:** any argument starting with `-` that is not a flag wtft takes. That includes
  the `--flag=value` spelling of a flag that takes its value only as the next argument
  (`--session=x`, `--pad=3`), and a lone `-`.
- **A valued flag with no value:** the last argument (`wtft --stop`), or followed by an argument
  starting with `-` (`wtft --stop --json`, `--pad -2`). That next argument is not consumed; it is
  read as an argument of its own.
- **A value the flag cannot use:**
  - `-i`/`--interval`: anything but a whole count and a unit (`7m`, `4h`, `1d`, `1w`, `5t`, `5turns`).
  - `-l`/`--limit`, `-w`/`--width`, `--thinking-budget`: anything but a whole number of 1 or more
    (`abc`, `3.5`, `5x`, `0`).
  - `--pad`: anything but a whole number of 0 or more.
  - `--harness`: anything but `pi`, `claude-code` or `auto`.
  - `--tz`/`--timezone`: a zone the runtime's `Intl` does not know.
  - The `=` spellings, `--interval=`, `--limit=`, `--width=`, `--tz=` and `--timezone=`, take the
    same values; an empty one is refused.
- **A bare word:** any argument that is neither a flag nor a flag's value.

`-s`/`--session`, `--dir`/`--cwd` and `--stop` take any value that does not start with `-`; what
that value names is checked where it is used, as before.

**Bare words.** One gives a word meaning today: `spawn-record`, and only as the CLI's first
argument, where `bin/wtft.ts` dispatches it to its own parser before the report path runs. No
caller in princess-pi-tools passes any other bare word: its callers run `wtft spawn-record …`
(`agent-new`, `claude-nsp-guard`, `pr-review`). So every other bare word is refused, and so is
`spawn-record` anywhere but first (`wtft --json spawn-record` was a report run; it is now a refusal).

**The CLI** (`bin/wtft.ts`): a refused call prints the sentence on stderr and exits **2**. Nothing
else runs: no help, no report, no daemon spawn, no daemon command. `spawn-record`'s own exit 2 is
unchanged, so 2 means *the call was wrong* on both paths. Before this change the report path never
exited 2.

**The Pi extension** (`/wtft`): a refused call shows the sentence as an `error` notification and
does nothing else: no widget change, no config write, no render.

**The chart picker page** (`artifacts/chart-spec/picker.html`) and `renderReport` ignore
`usageError`. The page parses the command line on every keystroke, so a half-typed `-i` is refused
until its value arrives, and it draws what the rest of the line says meanwhile.

**Not changed:** contradictory flags (`--hide --show`, `--cost --tokens`) are still read as before;
the flags a caller does not use (`--json` and the daemon flags in Pi, `-w` in the CLI) are still
accepted there and ignored.

## Verification

`tests/wtft-91-strict-cli-args.test.ts`:

- **P** the parser, in memory: each refused shape above sets `usageError` naming the token, and
  every accepted spelling (each flag, each `=` form, a valued flag followed by its value) leaves it
  `undefined`.
- **C** the built CLI: `wtft --jsonn`, `wtft --limit abc`, `wtft --harness bogus`, `wtft -i 9x`,
  `wtft --stop`, `wtft --stop --json` and `wtft foo` each exit 2 with stdout empty and the offending
  token on stderr, and spawn no daemon. `wtft --json` with a session still prints one JSON object.
- **X** the Pi `/wtft` handler on a recording context: `--jsonn` notifies once at `error` naming
  it, and sets no widget and writes no config.

`tests/wtft-26-json.test.ts` §7 checks that exit 2 is in the manifest's exit-code table, and
`tests/wtft-75-doc-claims.test.ts` that the README names only flags the parser accepts.
