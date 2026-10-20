#!/usr/bin/env bash
# Observes the Elysium-side safety paths on testnet with a separate test mandate whose HyperCore account holds no
# funds, so nothing can be placed on the exchange. Every step is a real Elysium testnet transaction; the keeper
# and watcher read the real HyperCore testnet book and account. Phases are timestamped in phases.jsonl and the
# mandate's full on-chain record is exported to events.json afterwards.
#
#   STAPLE_KEYSTORE=... STAPLE_KEYSTORE_PASSPHRASE=... scripts/elysium-cases.sh
#
# Phases: fail-closed activation (no watcher yet) -> watcher alive -> keeper stops, watcher pokes the stale
# shutdown with no new ticks -> keeper resumes -> watcher stops, quoting fails closed -> owner pause.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/runs/elysium-cases}"
PY="${STAPLE_PYTHON:-python3}"
STATE="$(mktemp -d)"
mkdir -p "$OUT"
: > "$OUT/phases.jsonl"
DEP="$ROOT/runs/deployment-testnet.json"

ops() { npx --prefix "$ROOT/keeper" tsx "$ROOT/keeper/src/ops.ts" "$@"; }
phase() { # name, note
  echo "{\"t\":$(date +%s%3N),\"phase\":\"$1\",\"note\":\"$2\"}" >> "$OUT/phases.jsonl"
  echo "== $1: $2"
}
pids=()
start() { # name, command... ; each service gets its own process group so stopping it reaches every child
  local name="$1"; shift
  setsid "$@" >> "$STATE/$name.log" 2>&1 &
  eval "PID_$name=$!"
}
stop() { local p; eval "p=\${PID_$1:-}"; [ -n "$p" ] && kill -TERM -- "-$p" 2>/dev/null || true; sleep 2; }
trap 'stop keeper; stop watcher' EXIT

phase create "test mandate with a 6 h expiry; the featured mandate is unchanged"
ID=$(ops create-mandate 6 --no-feature | tail -1 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).id))")
echo "mandate $ID"
export STAPLE_MANDATE_ID="$ID" STAPLE_DEPLOYMENT="$DEP" STAPLE_STATE_DIR="$STATE"
export STAPLE_OWNER_ACCOUNT="$(node -e "console.log(require('$DEP').ownerAccount)")"
export STAPLE_KEEPER_AGENT="$(node -e "console.log(require('$DEP').keeperAgent)")"
export STAPLE_HEALTH_PORT=8797 STAPLE_WATCHER_HEALTH_PORT=8798 STAPLE_WATCH_INTERVAL=10 STAPLE_TICK_MS=5000

phase activate "owner activates; the desk must stay halted until the independent watcher checks in"
ops activate "$ID"
start keeper npx --prefix "$ROOT/keeper" tsx "$ROOT/keeper/src/main.ts"
sleep 45

phase watcher-alive "watcher starts heartbeating; the keeper keeps ticking"
start watcher env PYTHONPATH="$ROOT/watcher" "$PY" -m staple_watcher.main
sleep 75

phase keeper-down "keeper stopped: no new ticks; the watcher's poke must halt quoting once the reference is stale"
stop keeper
sleep 60

phase keeper-up "keeper restarts and reconciles before any new decision"
start keeper npx --prefix "$ROOT/keeper" tsx "$ROOT/keeper/src/main.ts"
sleep 60

phase watcher-down "watcher stopped: the keeper's next ticks must fail closed once the 45 s watcher timeout passes"
stop watcher
sleep 75

phase pause "owner pauses"
stop keeper
ops pause "$ID"

phase export "on-chain record exported"
npx --prefix "$ROOT/keeper" tsx "$ROOT/keeper/src/export-events.ts" "$ID" "$OUT/events.json"
cp "$STATE"/keeper-events-*.jsonl "$OUT/keeper-events.jsonl" 2>/dev/null || true
cp "$STATE"/watcher-log-*.jsonl "$OUT/watcher-log.jsonl" 2>/dev/null || true
echo "done: $OUT"
