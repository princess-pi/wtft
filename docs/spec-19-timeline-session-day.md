# The timeline strip describes the session on screen

Issue: https://github.com/princess-pi/wtft/issues/19

The title line's 24-hour strip (surge hours, the clock-face marker, the moon bookends) and the
surge badge after it (`⚡ SURGE`, `APPROACHING`, `ENDING`) used to read the host clock, so a
session from another day was drawn with today's surge hours and today's moon.

## Behaviour

- **The strip is drawn for one instant, the anchor.** The surge hours, the moons at the two local
  midnights and the clock-face marker all come from the anchor's day and hour.
- **A live view anchors on now.** A view is live when its caller says so — the Pi widget and
  `--watch` — or when the newest interaction shown falls in the current local hour.
- **Any other view anchors on the newest interaction shown.** A session that crosses midnight is
  drawn for the day of its newest interaction.
- **The surge badge appears only on a live view.** On any other view the strip still colours the
  surge hours of the anchor's day, and no badge follows it.

## Verification

`tests/wtft-19-timeline-session-day.test.ts`, through `buildWtftLines` with the clock pinned:

- **V1** A DeepSeek fixture whose interactions all fall on a Saturday (after the weekend rule
  began), read on a Monday and on a Saturday: zero surge hours, no badge, the same title line both
  times.
- **V2** The same fixture moved to a Wednesday, read on a Monday: surge hours exactly 01-03 and
  06-09 UTC with `--timezone UTC`, no badge.
- **V3** The Wednesday fixture read as live (the caller says so) during a surge window: the badge
  appears.
