#!/bin/zsh
# Fire two agent turns at the same time through the isolated test Gateway and
# report what the mock one-slot server saw. Usage: test/run-two.sh <label>
P=${0:A:h:h}
export OPENCLAW_STATE_DIR=$P/.test-state OPENCLAW_CONFIG_PATH=$P/.test-state/openclaw.json OPENCLAW_WORKSPACE_DIR=$P/.test-state/workspace
label=${1:-run}; stamp=$(date +%H%M%S)
before=$(curl -s http://127.0.0.1:18796/stats)
for n in ${=TURNS:-1 2}; do
  ( s=$(date +%s); out=$(openclaw agent --session-key "$label-$stamp-$n" --timeout 150 -m "Say hello, turn $n." 2>&1 | grep -v "codex failed" | tail -1 | cut -c1-160); echo "turn $n: ${out} [$(( $(date +%s) - s ))s]" ) &
done
wait
after=$(curl -s http://127.0.0.1:18796/stats)
python3 - "$before" "$after" <<'PY'
import json,sys
b,a=json.loads(sys.argv[1]),json.loads(sys.argv[2])
print("mock server this run: accepted=%d rejected429=%d maxInFlight=%d" % (a["accepted"]-b["accepted"], a["rejected429"]-b["rejected429"], a["maxInFlight"]))
for l in a["log"][len(b["log"]):]: print("  ", l)
PY
