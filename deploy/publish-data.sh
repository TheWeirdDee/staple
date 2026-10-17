#!/usr/bin/env bash
# Publishes raw run data to the `campaign-data` branch: completed hourly sampler files as they close, and the
# keeper/watcher/campaign/supervisor logs of this run at the end. Exactly one file per commit, each staged by
# exact path, so every raw file is individually hash-pinned in git history.
set -euo pipefail
MODE="${1:-partial}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${STAPLE_STATE_DIR:-$ROOT/state}"
CID="${STAPLE_CAMPAIGN_ID:-baseline}"
RUN="${GITHUB_RUN_ID:-local-$(date +%s)}"
WT="$STATE/data-wt"
BR=campaign-data
cd "$ROOT"
git config user.name "staple-services" ; git config user.email "staple-services@users.noreply.github.com"
if [ ! -d "$WT/.git" ] && [ ! -f "$WT/.git" ]; then
  if git ls-remote --exit-code --heads origin "$BR" >/dev/null 2>&1; then
    git fetch -q --depth 1 origin "$BR"
    git worktree add -q "$WT" FETCH_HEAD
    (cd "$WT" && git checkout -q -B "$BR")
  else
    git worktree add -q --detach "$WT"
    (cd "$WT" && git checkout -q --orphan "$BR" && git rm -rqf . && git clean -fdq)
  fi
fi
DEST="$WT/runs/campaign-$CID"
mkdir -p "$DEST/sampler" "$DEST/logs"
CUR_HOUR=$(date -u +%Y%m%d%H)
commit_one() { # src, relpath under worktree, message
  local src="$1" rel="$2" msg="$3"
  mkdir -p "$(dirname "$WT/$rel")"
  if [ -f "$WT/$rel" ] && cmp -s "$src" "$WT/$rel"; then return 0; fi
  cp "$src" "$WT/$rel"
  (cd "$WT" && git add -- "$rel" && n=$(git diff --cached --name-only | wc -l) && [ "$n" -eq 1 ] && git commit -q -m "$msg")
}
for f in "$STATE"/sampler/*.jsonl; do
  [ -e "$f" ] || continue
  b=$(basename "$f"); h=$(echo "$b" | grep -o '[0-9]\{10\}')
  if [ "$MODE" = final ] || [ "$h" != "$CUR_HOUR" ]; then
    commit_one "$f" "runs/campaign-$CID/sampler/$b" "data($CID): sampler $b"
  fi
done
if [ "$MODE" = final ]; then
  for f in "$STATE"/keeper-events-*.jsonl "$STATE"/watcher-log-*.jsonl "$STATE"/supervisor.jsonl "$STATE"/health.jsonl "$STATE"/campaign-*/schedule.jsonl "$STATE"/campaign-*/taker.jsonl; do
    [ -e "$f" ] || continue
    b=$(basename "$f" .jsonl)
    commit_one "$f" "runs/campaign-$CID/logs/$b-run$RUN.jsonl" "data($CID): $b log of run $RUN"
  done
fi
(cd "$WT" && for i in 1 2 3 4; do git push -q origin "$BR" && break; sleep $((2**i)); done)
