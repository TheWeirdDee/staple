#!/usr/bin/env bash
# Runs the testnet services (sampler, watcher, keeper, campaign controller) for a bounded time, each under its
# own restart-on-failure supervisor, then stops them cleanly. Used by .github/workflows/services.yml and usable
# on any Linux host (see docs/runbook.md). Keys come from an encrypted keystore; nothing secret is printed.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DURATION_MIN="${STAPLE_RUN_MINUTES:-340}"
STATE="${STAPLE_STATE_DIR:-$ROOT/state}"
PY="${STAPLE_PYTHON:-python3}"
mkdir -p "$STATE"
export STAPLE_STATE_DIR="$STATE"
DEP="$ROOT/runs/deployment-testnet.json"
export STAPLE_DEPLOYMENT="$DEP"
MID=$(node -e "console.log(require('$DEP').featuredMandate)")
export STAPLE_MANDATE_ID="$MID"
export STAPLE_OWNER_ACCOUNT="${STAPLE_OWNER_ACCOUNT:-$(node -e "console.log(require('$DEP').ownerAccount)")}"
export STAPLE_KEEPER_AGENT="$(node -e "console.log(require('$DEP').keeperAgent)")"
SAMPLER_OUT="$STATE/sampler"

supervise() { # name, command...
  local name="$1"; shift
  ( while true; do
      echo "{\"t\":$(date +%s%3N),\"service\":\"$name\",\"event\":\"start\"}" >> "$STATE/supervisor.jsonl"
      "$@" >> "$STATE/$name.log" 2>&1
      code=$?
      echo "{\"t\":$(date +%s%3N),\"service\":\"$name\",\"event\":\"exit\",\"code\":$code}" >> "$STATE/supervisor.jsonl"
      [ -f "$STATE/.stop" ] && break
      sleep 5
    done ) &
  echo $! > "$STATE/$name.pid"
}

rm -f "$STATE/.stop"
supervise sampler "$PY" "$ROOT/sampler/sampler.py" --coin PURR/USDC --out "$SAMPLER_OUT"
supervise watcher env PYTHONPATH="$ROOT/watcher" "$PY" -m staple_watcher.main
supervise keeper npx --prefix "$ROOT/keeper" tsx "$ROOT/keeper/src/main.ts"
if [ -n "${STAPLE_CAMPAIGN_START:-}" ]; then
  supervise campaign npx --prefix "$ROOT/keeper" tsx "$ROOT/keeper/src/campaign.ts"
fi

end=$(( $(date +%s) + DURATION_MIN * 60 ))
while [ "$(date +%s)" -lt "$end" ]; do
  sleep 60
  k=$(curl -s -o /dev/null -w '%{http_code}' localhost:${STAPLE_HEALTH_PORT:-8787} || true)
  w=$(curl -s -o /dev/null -w '%{http_code}' localhost:${STAPLE_WATCHER_HEALTH_PORT:-8788} || true)
  echo "{\"t\":$(date +%s%3N),\"keeper\":\"$k\",\"watcher\":\"$w\"}" >> "$STATE/health.jsonl"
  minute=$(( ${minute:-0} + 1 ))
  if [ -n "${STAPLE_PUBLISH:-}" ] && [ $(( minute % 30 )) -eq 0 ]; then "$ROOT/deploy/publish-data.sh" partial || true; fi
done

# Services run under npx/tsx wrappers, so signal every descendant, not just the supervisor's direct child.
killtree() { # pid
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done
  kill -TERM "$1" 2>/dev/null
}
touch "$STATE/.stop"
for n in campaign keeper watcher sampler; do
  [ -f "$STATE/$n.pid" ] && killtree "$(cat "$STATE/$n.pid")"
done
sleep 5
[ -n "${STAPLE_PUBLISH:-}" ] && "$ROOT/deploy/publish-data.sh" final || true
echo "services stopped after ${DURATION_MIN} min"
