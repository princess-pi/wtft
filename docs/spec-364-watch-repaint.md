# Spec 364: `--watch` overwrites only the lines that changed

Module: `extensions/lib/watch-repaint.ts` (`repaint`), called from `render` in `watchTagFile`
(`extensions/lib/wtft-daemon-lib.ts`). Test: `tests/wtft-364-watch-repaint.test.ts`.

## Behaviour

A `--watch` refresh never erases the screen:

- **Only changed lines are written.** A line is written when its text differs from the last
  frame's line at the same index, or it starts on a different screen row. Usually that is one row;
  a new row or a new scale changes more.
- **Every written line covers the old one.** It is padded with spaces to one cell short of the
  terminal's width, or three cells short when it holds a non-ASCII character (the title's emoji,
  whose widths terminals disagree on). The same two cells of slack are what the title already
  keeps before the daemon status goes inline. A line wider than the terminal is padded to fill
  every row it wraps onto, on its last row by the same rule. The slack means a line whose width
  the renderer misjudges cannot wrap and shift every row below it. The frame records how far each
  row's text and padding reach, and a line written over a row that reached further is padded that
  far too, so nothing of the old line is left. The first frame is written the same way.
- **A shorter frame** writes spaces over each row it no longer covers.
- **The cursor** ends where it did before: column 0 of the row after the frame.

## Where it still erases

- **The terminal's width changed.** The terminal has rewrapped the old frame, so its rows are no
  longer where the last frame put them and the old frame's top cannot be found. That refresh
  clears the visible screen and writes the frame from its top.
- **A wrapped line holds a non-ASCII character,** in the new frame or the last one. A terminal wraps a double-width character early
  when it would straddle the last column, so the rows it takes cannot be counted. That refresh
  moves to the old frame's top, erases to the end of the screen, and writes every line.
- **The frame does not fit the terminal's rows.** Rows scrolled off the top cannot be reached with
  the cursor, so that refresh erases from the old frame's top too. The placeholder rows are
  trimmed first so a frame fits, counted by the same layout (`frameRows`), which keeps this rare.
- **Exit (`q`, Ctrl+C) and the error teardown** erase the live frame and print the final chart
  once. They are not refreshes. The erase moves up the frame's rows to its top (`eraseFrame`),
  or clears the visible screen when the frame holds a wrapped non-ASCII line, whose rows cannot be
  counted.
