#!/bin/sh
# Start uvicorn (studio) in the background and the brain watchdog in the
# background, then tail both logs together so we can see them in `docker logs`.
set -e

cd /app

echo "[entrypoint] starting uvicorn on :8000 (BRAIN_URL=${BRAIN_URL:-unset})"
python -m uvicorn server:app --host 0.0.0.0 --port 8000 \
  >> /var/log/studio.log 2>&1 &
UV_PID=$!

# Watchdog runs inside the same container so docker manages both.
echo "[entrypoint] starting brain watchdog"
python brain_watchdog.py --brain "${BRAIN_URL:-http://host.docker.internal:30010}" --container "${BRAIN_CONTAINER:-qwen-image-sglang}" --interval 30 \
  >> /var/log/watchdog.log 2>&1 &
WD_PID=$!

# Trap signals so both children exit together with the container.
trap "kill $UV_PID $WD_PID 2>/dev/null; exit 0" INT TERM

echo "[entrypoint] uvicorn PID=$UV_PID  watchdog PID=$WD_PID"
wait $UV_PID
