# Spec 364: `--watch` overwrites only the lines that changed

Module: `extensions/lib/watch-repaint.ts` (`repaint`), called from `render` in `watchTagFile`
(`extensions/lib/wtft-daemon-lib.ts`). Test: `tests/wtft-364-watch-repaint.test.ts`.

## Behaviour

A `--watch` refresh never erases the screen:

- **Only changed lines are written.** A line is written when its text differs from the last
  frame's line at the same index, or it starts on a different screen row. Usually that is one row;
  a new row or a new scale changes more.
- **Every written line covers the old one.** It is padded with spaces to the terminal's width less
  one cell, and a line wider than the terminal is padded to fill every row it wraps onto, less one
  cell on its last. Stopping one cell short means a line whose width the renderer misjudges by one
  cell (an emoji) cannot wrap and shift every row below it. The frame records which rows hold text
  in the last column (a line exactly as wide as the terminal, such as the tick row, and every row
  of a wrapped line but its last), and a line written over one of those rows is padded through the
  last column. The first frame is written the same way.
- **A shorter frame** writes spaces over each row it no longer covers.
- **The cursor** ends where it did before: column 0 of the row after the frame.

## Where it still erases

- **The terminal's width changed.** The terminal has rewrapped the old frame, so its rows are no
  longer where the last frame put them and the old frame's top cannot be found. That refresh
  clears the visible screen and writes the frame from its top.
- **A wrapped line holds a non-ASCII character.** A terminal wraps a double-width character early
  when it would straddle the last column, so the rows it takes cannot be counted. That refresh
  moves to the old frame's top, erases to the end of the screen, and writes every line.
- **The frame does not fit the terminal's rows.** Rows scrolled off the top cannot be reached with
  the cursor, so that refresh erases from the old frame's top too. The placeholder rows are
  trimmed first so a frame fits, counted by the same layout (`frameRows`), which keeps this rare.
- **Exit (`q`, Ctrl+C) and the error teardown** erase the live frame and print the final chart
  once. They are not refreshes.
