#!/usr/bin/env bash
# usage: measure.sh <daemon.mjs> <label> <append-seconds>
set -u
DAEMON=$1; LABEL=$2; APPEND=$3
ROOT=$(mktemp -d)
export WTFT_CLAUDE_PROJECTS_DIR=$ROOT/projects XDG_STATE_HOME=$ROOT/state
SID=f0970000-0000-4000-8000-000000000097
PROJ=$ROOT/projects/-tmp-pss; mkdir -p $PROJ/$SID/subagents
turn() { printf '{"type":"assistant","timestamp":"%s","cwd":"/tmp/pss","message":{"role":"assistant","id":"%s","model":"claude-opus-5","content":[{"type":"text","text":"t"}],"usage":{"input_tokens":10,"output_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$1"; }
PAD=$(head -c 4000 /dev/zero | tr '\0' x)
USERLINE="{\"type\":\"user\",\"message\":{\"content\":\"$PAD\"}}"
turn root-0 > $PROJ/$SID.jsonl
python3 - "$PROJ/$SID/subagents" "$USERLINE" <<'PY'
import sys, json, datetime
d, user = sys.argv[1], sys.argv[2]
for a in range(3):
    with open(f"{d}/agent-{a}.jsonl","w") as f:
        size=0; i=0
        while size < 9*1024*1024:
            if i % 50 == 0:
                line=json.dumps({"type":"assistant","timestamp":datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%S.000Z"),"cwd":"/tmp/pss","isSidechain":True,"message":{"role":"assistant","id":f"a{a}-{i}","model":"claude-opus-5","content":[{"type":"text","text":"t"}],"usage":{"input_tokens":10,"output_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}})
            else:
                line=user
            f.write(line+"\n"); size+=len(line)+1; i+=1
PY
du -sh $PROJ/$SID/subagents | cut -f1 | sed "s/^/[$LABEL] subagents total: /"
node $DAEMON --session $PROJ/$SID.jsonl >/dev/null 2>&1 &
PID=$!
pss() { awk '/^Pss:/{s+=$2} END{printf "%.1f", s/1024}' /proc/$PID/smaps_rollup 2>/dev/null; }
sleep 25; echo "[$LABEL] PSS after startup: $(pss) MB"
end=$((SECONDS+APPEND)); n=0
while [ $SECONDS -lt $end ]; do
  for a in 0 1 2; do for k in 1 2 3 4 5; do echo "$USERLINE" >> $PROJ/$SID/subagents/agent-$a.jsonl; done; turn "a$a-live-$n" | sed 's/"cwd"/"isSidechain":true,"cwd"/' >> $PROJ/$SID/subagents/agent-$a.jsonl; done
  n=$((n+1)); sleep 5
done
echo "[$LABEL] PSS after ${APPEND}s of appends ($n rounds): $(pss) MB"
kill $PID 2>/dev/null; wait $PID 2>/dev/null
rm -rf $ROOT
