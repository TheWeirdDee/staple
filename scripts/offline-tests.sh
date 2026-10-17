#!/usr/bin/env bash
# Runs every offline suite and records pass/fail counts with the commit to runs/offline-tests.json.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="${STAPLE_PYTHON:-python3}"
cd "$ROOT"
out=()
rec() { out+=("{\"suite\":\"$1\",\"passed\":$2,\"failed\":$3,\"command\":\"$4\"}"); }
f=$(cd contracts && forge test 2>&1); p=$(echo "$f" | grep -o '[0-9]* passed' | awk '{s+=$1} END {print s+0}'); x=$(echo "$f" | grep -o '[0-9]* failed' | awk '{s+=$1} END {print s+0}')
rec "Contracts (Foundry): lifecycle, reservations, signatures, shutdowns, vectors, fuzz" "$p" "$x" "cd contracts && forge test"
for pkg in reference keeper; do
  f=$(pnpm --filter "@staple/$pkg" test 2>&1); p=$(echo "$f" | grep -oE 'Tests +[0-9]+ passed' | grep -o '[0-9]*' | head -1); x=$(echo "$f" | grep -oE '[0-9]+ failed' | grep -o '[0-9]*' | head -1)
  case $pkg in reference) n="Reference quote engine, frozen vectors, policy";; keeper) n="Keeper: local node + exchange test double, SDK signing vectors";; esac
  rec "$n" "${p:-0}" "${x:-0}" "pnpm --filter @staple/$pkg test"
done
f=$(cd watcher && $PY -m pytest -q 2>&1 | tail -1); p=$(echo "$f" | grep -o '[0-9]* passed' | grep -o '[0-9]*'); x=$(echo "$f" | grep -o '[0-9]* failed' | grep -o '[0-9]*')
rec "Watcher reconciliation, guard signing, keystore" "${p:-0}" "${x:-0}" "cd watcher && python -m pytest"
f=$(cd sampler && $PY -m pytest -q 2>&1 | tail -1); p=$(echo "$f" | grep -o '[0-9]* passed' | grep -o '[0-9]*'); x=$(echo "$f" | grep -o '[0-9]* failed' | grep -o '[0-9]*')
rec "Sampler metric computation" "${p:-0}" "${x:-0}" "cd sampler && python -m pytest"
commit=$(git rev-parse HEAD)
(IFS=,; echo "{\"commit\":\"$commit\",\"ranAt\":\"$(date -u +%FT%TZ)\",\"suites\":[${out[*]}]}") > runs/offline-tests.json
cat runs/offline-tests.json
