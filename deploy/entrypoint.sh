#!/usr/bin/env sh
set -e

# The brain loads one data archive (DATA_ARCHIVE_URL) at startup. We re-download it whenever it has
# CHANGED, so adding or updating channels actually reaches the live site after a redeploy. "Changed"
# is detected from the archive's own headers (size / ETag / Last-Modified) - so overwriting the same
# release asset counts - plus an optional DATA_ARCHIVE_VERSION env you can bump to force a refresh.
# The stamp lives on the persistent volume, so an unchanged archive is never re-downloaded.

mkdir -p output
STAMP="output/.data-stamp"

want=""
if [ -n "$DATA_ARCHIVE_URL" ]; then
  # HEAD the archive (following redirects to the real asset) and fingerprint it.
  val="$(curl -fsSLI "$DATA_ARCHIVE_URL" 2>/dev/null | tr -d '\r' \
    | grep -iE '^(content-length|last-modified|etag):' | sort | tr '\n' '|' || true)"
  want="ver=${DATA_ARCHIVE_VERSION:-};url=${DATA_ARCHIVE_URL};${val}"
fi

have=""
[ -f "$STAMP" ] && have="$(cat "$STAMP")"

if [ -n "$DATA_ARCHIVE_URL" ] && [ "$want" != "$have" ]; then
  echo "[entrypoint] data archive changed (or first boot) - downloading ..."
  if curl -fL --retry 3 "$DATA_ARCHIVE_URL" -o /tmp/archive.tar.gz; then
    echo "[entrypoint] extracting ..."
    # The volume only has room for ONE copy of the data, so clear the previous channel directories
    # first - extracting on top of them (plus channels since removed, plus any half-written leftovers)
    # overflowed it. Top-level files such as the spend ledger are kept; every directory here came
    # from a previous archive. The stamp goes too, so a failed extract is retried on the next start.
    find output -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +
    rm -f "$STAMP"
    tar -xzf /tmp/archive.tar.gz -C output
    rm -f /tmp/archive.tar.gz
    printf '%s' "$want" > "$STAMP"
    echo "[entrypoint] data refreshed."
  else
    # Don't take the service down over a bad refresh - serve the data we already have.
    echo "[entrypoint] WARNING: download failed - keeping existing data."
  fi
elif [ -n "$DATA_ARCHIVE_URL" ]; then
  echo "[entrypoint] data archive unchanged - reusing existing data."
else
  echo "[entrypoint] WARNING: no DATA_ARCHIVE_URL set - search will be empty until data is loaded."
fi

exec uvicorn server:app --host 0.0.0.0 --port "${PORT:-8000}"
