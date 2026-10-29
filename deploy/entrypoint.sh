#!/usr/bin/env sh
set -e

# Fetch the archive data once. We key off a marker file (not folder-emptiness) because a mounted
# volume starts with a lost+found directory, which would otherwise look "non-empty" and skip the
# download. The marker lives on the persistent volume, so later boots reuse the data.
if [ ! -f "output/.data-ready" ]; then
  if [ -n "$DATA_ARCHIVE_URL" ]; then
    echo "[entrypoint] no data marker - downloading archive data from DATA_ARCHIVE_URL ..."
    mkdir -p output
    curl -fL --retry 3 "$DATA_ARCHIVE_URL" -o /tmp/archive.tar.gz
    echo "[entrypoint] extracting ..."
    tar -xzf /tmp/archive.tar.gz -C output
    rm -f /tmp/archive.tar.gz
    touch output/.data-ready
    echo "[entrypoint] archive data ready."
  else
    echo "[entrypoint] WARNING: no DATA_ARCHIVE_URL and no data - search will be empty."
  fi
else
  echo "[entrypoint] data marker found - reusing existing data."
fi

exec uvicorn server:app --host 0.0.0.0 --port "${PORT:-8000}"
