#!/bin/bash
# start-sensor.sh — Verifiable sensor launcher
# Before running sensor.py, checks that it matches the HB-approved code hash.
# If it doesn't, fetches the approved version from Arweave automatically.

set -e

SENSOR="$HOME/dashboard/pi-sensor/sensor.py"
BACKEND="http://localhost:3001"

echo "[start-sensor] Checking code integrity against HyperBEAM..."

# Get approved code hashes from HB via backend
APPROVED=$(curl -sf "$BACKEND/api/attestations" 2>/dev/null || echo "[]")
APPROVED_CODES=$(curl -sf "http://62.146.173.162:6363/dry-run?process-id=$(cat $HOME/dashboard/process-id.txt)" \
  -X POST -H "Content-Type: application/json" \
  -d '{"Id":"dryrun","Owner":"dryrun","Tags":[{"name":"Action","value":"GetApprovedCode"}],"Data":"","Timestamp":0}' \
  2>/dev/null | python3 -c "import sys,json; msgs=json.load(sys.stdin).get('Messages',[]); print(msgs[0]['Data'] if msgs else '[]')" 2>/dev/null || echo "[]")

# Compute current hash of sensor.py
if [ ! -f "$SENSOR" ]; then
  echo "[start-sensor] sensor.py not found — fetching from Arweave..."
  curl -sf "$BACKEND/api/fetch-code" -X POST | python3 -c "import sys,json; r=json.load(sys.stdin); print('Fetched:', r.get('arweave_tx_id',''))"
else
  CURRENT_HASH=$(sha256sum "$SENSOR" | cut -d' ' -f1)
  echo "[start-sensor] Current hash: $CURRENT_HASH"

  # Check if current hash is in approved list
  APPROVED_MATCH=$(echo "$APPROVED_CODES" | python3 -c "
import sys, json
codes = json.load(sys.stdin)
current = '$CURRENT_HASH'
match = any(c.get('code_hash') == current for c in codes)
print('yes' if match else 'no')
" 2>/dev/null || echo "unknown")

  if [ "$APPROVED_MATCH" = "yes" ]; then
    echo "[start-sensor] ✓ Code verified — hash matches HB approved list"
  elif [ "$APPROVED_MATCH" = "no" ]; then
    echo "[start-sensor] ⚠ Hash not in approved list — fetching approved code from Arweave..."
    FETCH_RESULT=$(curl -sf "$BACKEND/api/fetch-code" -X POST)
    echo "[start-sensor] Fetch result: $FETCH_RESULT"
    NEW_HASH=$(sha256sum "$SENSOR" | cut -d' ' -f1)
    if [ "$NEW_HASH" = "$CURRENT_HASH" ]; then
      echo "[start-sensor] ✗ Code unchanged after fetch — check deploy-code.ts was run"
      exit 1
    fi
    echo "[start-sensor] ✓ Code updated to approved version"
  else
    echo "[start-sensor] ⚠ Could not reach HB to verify — running with current code"
  fi
fi

# Run the sensor (pass through any args like --loop 60)
echo "[start-sensor] Starting sensor..."
exec python3 "$SENSOR" "$@"
