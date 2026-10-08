# The Pi widget's refresh timer ends with its session

Issue: https://github.com/princess-pi/wtft/issues/381

## Behaviour

- **The refresh timer belongs to one session.** `session_start` arms it; `session_shutdown`, which
  Pi fires before a quit, a reload, or a session replacement (new, resume, fork), clears it and
  drops the ctx it was drawing with. Print mode quits through the same event. Pi's own type for the
  event says it is "Fired before an extension runtime is torn down due to quit, reload, or session
  replacement".
- **No tick touches a ctx Pi has retired.** After `session_shutdown` no timer callback runs, so Pi's
  "ctx is stale after session replacement or reload" error cannot come from the refresh timer.
- **The next session arms its own timer**, drawing with that session's ctx.
- **The `session_shutdown` handler is idempotent**: a second one, or one with no timer armed, does
  nothing.

## Verification

`tests/wtft-381-pi-timer-stale-ctx.test.ts` drives the extension with a fake Pi whose ctx throws
Pi's stale-ctx error on any access once retired, and a fake `setInterval`/`clearInterval`:

- **V1** `session_start` arms one timer, and a tick draws the widget (fixture precondition).
- **V2** `session_shutdown` clears that timer.
- **V3** With the first ctx retired, running the first timer's callback anyway throws nothing and
  touches that ctx zero times.
- **V4** A second `session_shutdown` throws nothing and clears nothing more.
- **V5** A new `session_start` arms a fresh timer, and its tick draws with the new ctx.

Closer, live: `pi -p "reply with exactly: ok"` prints zero lines matching `stale after session`.
