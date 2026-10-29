#!/usr/bin/env sh
set -e

# Make sure the archive data is present. If /app/output is empty and DATA_ARCHIVE_URL is set,
# download it once (first boot, or a cold start with no persistent volume).
if [ ! -d "output" ] || [ -z "$(ls -A output 2>/dev/null)" ]; then
  if [ -n "$DATA_ARCHIVE_URL" ]; then
    echo "[entrypoint] output/ is empty - downloading archive data from DATA_ARCHIVE_URL ..."
    mkdir -p output
    curl -fL --retry 3 "$DATA_ARCHIVE_URL" -o /tmp/archive.tar.gz
    tar -xzf /tmp/archive.tar.gz -C output
    rm -f /tmp/archive.tar.gz
    echo "[entrypoint] archive data ready."
  else
    echo "[entrypoint] WARNING: no output/ data and no DATA_ARCHIVE_URL set - search will be empty."
  fi
fi

exec uvicorn server:app --host 0.0.0.0 --port "${PORT:-8000}"
