#!/usr/bin/env bash
# tests/wtft-daemon.test.sh — Integration tests for wtft-daemon
# Run after any daemon change to verify behavior sticks.
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

PASS=0
FAIL=0

assert() {
  if eval "$2"; then
    echo -e "  ${GREEN}PASS${NC} $1"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} $1"
    FAIL=$((FAIL + 1))
  fi
}

kill_daemons() {
  for pidfile in /tmp/wtft-daemon-*.pid; do
    [ -f "$pidfile" ] || continue
    kill $(cat "$pidfile") 2>/dev/null || true
    rm -f "$pidfile"
  done
  sleep 0.5
}

cleanup() {
  kill_daemons
  rm -f /tmp/wtft-daemon-test*.jsonl /tmp/wtft-daemon-test*.classified.jsonl /tmp/wtft-daemon-*.pid
}
trap cleanup EXIT

echo "=== wtft-daemon integration tests ==="
echo ""

DAEMON="./bin/wtft-daemon.mjs"
SESSION="/tmp/wtft-daemon-test-session.jsonl"
CLASSIFIED="${SESSION}.classified.jsonl"

# Setup: create fake session
cat > "$SESSION" << 'JSONLEOF'
{"type":"assistant","message":{"role":"assistant","timestamp":"2026-07-04T10:00:00Z","model":"claude-sonnet-4-20250514","usage":{"input_tokens":100,"output_tokens":50},"content":[{"type":"text","text":"Let me read the spec."},{"type":"toolCall","name":"read","arguments":{"path":"docs/spec.md"}}]}}
{"type":"assistant","message":{"role":"assistant","timestamp":"2026-07-04T10:01:00Z","model":"claude-sonnet-4-20250514","usage":{"input_tokens":200,"output_tokens":100},"content":[{"type":"text","text":"Now I'll write the code."},{"type":"toolCall","name":"write","arguments":{"path":"src/main.ts"}}]}}
JSONLEOF

# ── Test 1: daemon starts, classifies, exits cleanly on SIGTERM ──
echo "1. Basic lifecycle"
kill_daemons
rm -f "$CLASSIFIED"

$DAEMON --session "$SESSION" &
DAEMON_PID=$!
sleep 2

assert "classified.jsonl created" \
  "[ -f '$CLASSIFIED' ]"

assert "classifier version header present" \
  "head -1 '$CLASSIFIED' | grep -q '_cv'"

assert "classified entries have NO txt field" \
  "! grep -q '\"txt\"' '$CLASSIFIED'"

assert "classified has required fields (t, c, cat)" \
  "grep -q '\"t\":' '$CLASSIFIED' && grep -q '\"c\":' '$CLASSIFIED' && grep -q '\"cat\":' '$CLASSIFIED'"

assert "heartbeat uses range format {first,last}" \
  "grep -q '\"_hb\":{\"first\":' '$CLASSIFIED'"

# Send SIGTERM — daemon should exit cleanly
kill -TERM $DAEMON_PID
sleep 1

assert "daemon exited on SIGTERM" \
  "! kill -0 $DAEMON_PID 2>/dev/null"

assert "stop heartbeat written" \
  "grep -q '\"_hb\":\"stop\"' '$CLASSIFIED'"

kill_daemons
rm -f "$CLASSIFIED"

# ── Test 2: management commands ──
echo ""
echo "2. Management commands"

$DAEMON --session "$SESSION" &
sleep 1

assert "--list shows RUNNING daemon" \
  "$DAEMON --list 2>&1 | grep -q 'RUNNING'"

assert "--list shows session path" \
  "$DAEMON --list 2>&1 | grep -q 'wtft-daemon-test-session'"

# ── Test 3: --restart re-launches (CRITICAL) ──
echo ""
echo "3. --restart re-launches"

OLD_PID=$(cat /tmp/wtft-daemon-*.pid 2>/dev/null | head -1)
assert "old daemon has PID file" \
  "[ -n '$OLD_PID' ]"

$DAEMON --restart >/dev/null 2>&1
sleep 1

assert "old daemon no longer running" \
  "! kill -0 $OLD_PID 2>/dev/null"

assert "new daemon is running after restart" \
  "$DAEMON --list 2>&1 | grep -q 'RUNNING'"

NEW_PID=$(cat /tmp/wtft-daemon-*.pid 2>/dev/null | head -1)
assert "new PID differs from old" \
  "[ '$NEW_PID' != '$OLD_PID' ]"

# ── Test 4: --stop ──
echo ""
echo "4. --stop"

$DAEMON --stop "$SESSION" >/dev/null 2>&1
sleep 1

assert "daemon stopped" \
  "! $DAEMON --list 2>&1 | grep -q 'RUNNING'"

assert "PID file cleaned up" \
  "[ -z \"\$(ls /tmp/wtft-daemon-*.pid 2>/dev/null || true)\" ]"

kill_daemons

# ── Test 5: singleton ──
echo ""
echo "5. Singleton (only one daemon per session)"

rm -f "$CLASSIFIED"
$DAEMON --session "$SESSION" &
PID1=$!
sleep 1

$DAEMON --session "$SESSION" &
PID2=$!
sleep 1

assert "second daemon exited (singleton enforced)" \
  "! kill -0 $PID2 2>/dev/null"

assert "first daemon still running" \
  "kill -0 $PID1 2>/dev/null"

kill_daemons

# ── Test 6: recursion guard ──
echo ""
echo "6. Recursion guard"

touch "$CLASSIFIED"
ERR=$($DAEMON --session "$CLASSIFIED" 2>&1 || true)
if echo "$ERR" | grep -q "refusing to watch"; then
  echo -e "  ${GREEN}PASS${NC} refuses .classified.jsonl as input"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${NC} refuses .classified.jsonl as input"
  FAIL=$((FAIL + 1))
fi
rm -f "$CLASSIFIED"

# ── Test 7: --cleanup ──
echo ""
echo "7. --cleanup"

FAKE_SESSION="/tmp/wtft-daemon-test-fake.jsonl"
touch "$FAKE_SESSION"

$DAEMON --session "$FAKE_SESSION" &
FAKE_PID=$!
sleep 1

rm -f "$FAKE_SESSION"
$DAEMON --cleanup >/dev/null 2>&1
sleep 1

assert "daemon for deleted session killed" \
  "! kill -0 $FAKE_PID 2>/dev/null"

kill_daemons

# ── Results ──
echo ""
echo "──────────────────────────────"
echo -e "Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
[ $FAIL -eq 0 ] || exit 1
