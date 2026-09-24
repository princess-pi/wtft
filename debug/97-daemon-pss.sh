#!/usr/bin/env bash
# usage: debug/97-daemon-pss.sh <daemon.mjs> <label> <append-seconds> [node-flags]
# Prints PSS and the live heap (a heap snapshot, which collects garbage first)
# after startup and after the appends. #97's Closer is the live heap.
set -euo pipefail
DAEMON=$(realpath "$1"); LABEL=$2; APPEND=$3; NODE_FLAGS=${4:-}
# Not under /tmp: a test suite's `wtft-daemon --cleanup` kills fixture daemons
# there, and it ended two 30-minute runs early.
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/wtft-97
mkdir -p "$CACHE"
ROOT=$(mktemp -d "$CACHE/run.XXXXXX")
export WTFT_CLAUDE_PROJECTS_DIR=$ROOT/projects XDG_STATE_HOME=$ROOT/state
# Isolated so the daemon's home-relative reap.log (os.homedir()) and its
# tmp-relative pid lease (os.tmpdir(), which it also scans to reap other
# daemons' leases at startup) never touch the caller's real ones.
export HOME=$ROOT/home TMPDIR=$ROOT/tmp
mkdir -p "$HOME" "$TMPDIR"
SID=f0970000-0000-4000-8000-000000000097
PROJ=$ROOT/projects/-tmp-pss; mkdir -p "$PROJ/$SID/subagents"
turn() { printf '{"type":"assistant","timestamp":"%s","cwd":"/tmp/pss","message":{"role":"assistant","id":"%s","model":"claude-opus-5","content":[{"type":"text","text":"t"}],"usage":{"input_tokens":10,"output_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$1"; }
PAD=$(head -c 4000 /dev/zero | tr '\0' x)
USERLINE="{\"type\":\"user\",\"message\":{\"content\":\"$PAD\"}}"
turn root-0 > "$PROJ/$SID.jsonl"

if ! python3 - "$PROJ/$SID/subagents" "$USERLINE" <<'PY'
import sys, json, datetime
d, user = sys.argv[1], sys.argv[2]
for a in range(3):
    with open(f"{d}/agent-{a}.jsonl","w") as f:
        size=0; i=0
        while size < 9*1024*1024:
            if i % 50 == 0:
                line=json.dumps({"type":"assistant","timestamp":datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),"cwd":"/tmp/pss","isSidechain":True,"message":{"role":"assistant","id":f"a{a}-{i}","model":"claude-opus-5","content":[{"type":"text","text":"t"}],"usage":{"input_tokens":10,"output_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}})
            else:
                line=user
            f.write(line+"\n"); size+=len(line)+1; i+=1
PY
then
  echo "[$LABEL] ERROR: fixture generator (python3) failed" >&2
  rm -rf "$ROOT"
  exit 1
fi

# Bytes, not -h: a human-readable rounding could mask a fixture that fell
# just short of the floor the measurement below depends on.
SUBAGENTS_BYTES=$(du -sb "$PROJ/$SID/subagents" | cut -f1)
MIN_BYTES=$((25 * 1024 * 1024))
if [ "$SUBAGENTS_BYTES" -lt "$MIN_BYTES" ]; then
  echo "[$LABEL] ERROR: subagents fixture is only $SUBAGENTS_BYTES bytes, need at least $MIN_BYTES (25 MiB)" >&2
  rm -rf "$ROOT"
  exit 1
fi
echo "[$LABEL] subagents total: $SUBAGENTS_BYTES bytes"

SNAPS=$ROOT/snapshots; mkdir -p "$SNAPS"
(cd "$SNAPS" && exec node --heapsnapshot-signal=SIGUSR2 $NODE_FLAGS "$DAEMON" --session "$PROJ/$SID.jsonl" >/dev/null 2>&1) &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; rm -rf "$ROOT"' EXIT
alive() { kill -0 "$PID" 2>/dev/null; }
pss() { awk '/^Pss:/{s+=$2} END{printf "%.1f", s/1024}' /proc/$PID/smaps_rollup 2>/dev/null; }
# Never report a PSS number for a dead daemon — a 0.0/empty reading would
# otherwise pass silently as a (falsely low) measurement.
sample() {
  if ! alive; then
    echo "[$LABEL] ERROR: daemon (pid $PID) is not running — cannot sample PSS ($1)" >&2
    exit 1
  fi
  local val
  val=$(pss)
  if ! awk -v v="$val" 'BEGIN{exit !(v ~ /^[0-9]+(\.[0-9]+)?$/ && v+0 > 0)}'; then
    echo "[$LABEL] ERROR: PSS sample ($1) is not a positive number: '$val'" >&2
    exit 1
  fi
  echo "[$LABEL] PSS $1: $val MB"
  heap "$1"
}
# The live heap: every node's self size in a snapshot the daemon writes on SIGUSR2.
heap() {
  local before after
  before=$(ls "$SNAPS" | wc -l)
  kill -USR2 "$PID"
  local snap="" size=-1 now
  for _ in $(seq 1 60); do
    sleep 1
    after=$(ls "$SNAPS" | wc -l)
    [ "$after" -gt "$before" ] || continue
    snap=$(ls -t "$SNAPS"/*.heapsnapshot | head -1)
    now=$(stat -c %s "$snap")
    # Written once the size holds still for a second.
    if [ "$now" -gt 0 ] && [ "$now" -eq "$size" ]; then break; fi
    size=$now
  done
  if [ -z "$snap" ]; then
    echo "[$LABEL] ERROR: no heap snapshot written ($1)" >&2
    exit 1
  fi
  echo "[$LABEL] live heap $1: $(node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const f = d.snapshot.meta.node_fields, n = f.length, s = f.indexOf("self_size");
    let t = 0; for (let i = s; i < d.nodes.length; i += n) t += d.nodes[i];
    console.log((t / 1048576).toFixed(2));' "$snap") MB"
  rm -f "$snap"
}

# The daemon's subagent handling is what this script measures; a sample taken
# before it has read a single subagent transcript would be a memory reading
# of an idle process, not of the thing under test. Bounded so a daemon that
# never starts (a bad path, a crash on startup) fails loud instead of hanging.
TAG_GLOB="$PROJ/wtft-tags/$SID.jsonl.wtft-tag.v"*".jsonl"
wait_for_tags() {
  local waited=0
  while true; do
    if ! alive; then
      echo "[$LABEL] ERROR: daemon (pid $PID) is not running — cannot wait for subagent tags" >&2
      exit 1
    fi
    if ls $TAG_GLOB >/dev/null 2>&1 && grep -q '"s":' $TAG_GLOB 2>/dev/null; then
      return 0
    fi
    if [ "$waited" -ge 60 ]; then
      echo "[$LABEL] ERROR: daemon never read the subagent transcripts (no \"s\": tag lines within 60s)" >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}
wait_for_tags
sample "after startup"
end=$((SECONDS+APPEND)); n=0
while [ $SECONDS -lt $end ]; do
  for a in 0 1 2; do for k in 1 2 3 4 5; do echo "$USERLINE" >> "$PROJ/$SID/subagents/agent-$a.jsonl"; done; turn "a$a-live-$n" | sed 's/"cwd"/"isSidechain":true,"cwd"/' >> "$PROJ/$SID/subagents/agent-$a.jsonl"; done
  n=$((n+1)); sleep 5
done
sample "after ${APPEND}s of appends ($n rounds)"
