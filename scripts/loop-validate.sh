#!/usr/bin/env bash
#
# Ralph loop — run scripts/validate.js repeatedly until it exits 0 (i.e.
# all cases pass) or until a max-iteration budget is reached. Between
# iterations a cool-down sleep gives upstream rate limits room to clear.
#
# Usage:
#   scripts/loop-validate.sh                  # default: 30 iterations
#   scripts/loop-validate.sh 100              # try 100 iterations
#   COOLDOWN_SEC=120 scripts/loop-validate.sh # longer rest between runs
#
# Each iteration writes its own captures/validate/iter-N/ directory and
# leaves a summary.json that the loop reads to decide if we're done.

set -u

PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$PROJECT_ROOT"

MAX_ITER="${1:-30}"
COOLDOWN_SEC="${COOLDOWN_SEC:-60}"
START_TS="$(date +%s)"

echo "[loop] starting up to $MAX_ITER iterations, cooldown ${COOLDOWN_SEC}s between"
echo "[loop] project root: $PROJECT_ROOT"

for ((i = 1; i <= MAX_ITER; i++)); do
  TAG="iter-loop-$i"
  echo
  echo "=== [loop] iteration $i / $MAX_ITER  (tag=$TAG, elapsed=$(( $(date +%s) - START_TS ))s) ==="
  if node scripts/validate.js --tag "$TAG"; then
    echo "=== [loop] converged at iteration $i — all cases passed ==="
    echo "[loop] summary: captures/validate/$TAG/summary.json"
    exit 0
  fi
  SUMMARY="captures/validate/$TAG/summary.json"
  if [[ -f "$SUMMARY" ]]; then
    echo "[loop] failures: $(python3 -c "import json; print(json.load(open('$SUMMARY'))['failures'])")"
  fi
  if (( i < MAX_ITER )); then
    echo "[loop] cooling down ${COOLDOWN_SEC}s before next iteration…"
    sleep "$COOLDOWN_SEC"
  fi
done

echo "=== [loop] did not converge in $MAX_ITER iterations ==="
exit 1
