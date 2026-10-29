# Brain service container. Runs the FastAPI server that serves search + the deluxe Q&A.
# Works on any container host (Railway, Render, Fly, Hugging Face Spaces, etc.).
#
# The archive data (output/, ~2.8GB) is NOT in the image. It is provided at runtime either by a
# mounted volume at /app/output, or downloaded once on first boot from DATA_ARCHIVE_URL.
# API keys (ANTHROPIC_API_KEY, APIFY_TOKEN, YOUTUBE_API_KEY) and BRAIN_KEY come from host env vars.

FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl zstd ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-server.txt ./
RUN pip install --no-cache-dir -r requirements-server.txt

COPY app.py server.py settings.json ./
COPY deploy/entrypoint.sh ./deploy/entrypoint.sh
RUN chmod +x ./deploy/entrypoint.sh

ENV PORT=8000
EXPOSE 8000

CMD ["./deploy/entrypoint.sh"]
