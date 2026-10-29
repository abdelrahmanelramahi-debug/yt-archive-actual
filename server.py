"""Brain service for the YouTube archive web app.

A small FastAPI server that loads the search indexes + embedding model once at startup and exposes
the existing search and deluxe Q&A over HTTP, so a separate web frontend can use them. It reuses
app.py's logic directly - there is no second copy of the "brain".

Run locally:
    .\\.venv\\Scripts\\python.exe -m uvicorn server:app --host 127.0.0.1 --port 8000

Only the frontend should call this. Set BRAIN_KEY in the environment and send it as the
`X-Brain-Key` header; with no BRAIN_KEY set (local dev) requests are open. API keys live only here
(read from .env by app.py), never in the frontend or the browser.
"""
import os
import threading
import time
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import app as brain

STATE = {}
BRAIN_KEY = os.environ.get("BRAIN_KEY")  # shared secret the frontend sends; unset = open (local dev)
# Comma-separated list of allowed frontend origins; "*" (default) is for local dev only.
ALLOW_ORIGINS = [o.strip() for o in os.environ.get("ALLOW_ORIGINS", "*").split(",") if o.strip()]

# Spend caps (protect the Claude bill). Enforced here because the brain is one resident process with
# memory - a serverless frontend can't hold a reliable counter. The frontend forwards each visitor's
# real IP as X-Client-IP so the per-person limit works even though every call arrives from Vercel.
MAX_PER_DAY = int(os.environ.get("MAX_PER_DAY", "300"))        # total questions across everyone / UTC day
MAX_PER_IP_HOUR = int(os.environ.get("MAX_PER_IP_HOUR", "30"))  # questions per visitor per hour
_RATE = {"lock": threading.Lock(), "day": "", "day_count": 0, "ip": {}}


def _rate_limited(ip):
    """Returns a message if this request should be blocked, else None (and records the hit)."""
    now = time.time()
    today = time.strftime("%Y-%m-%d", time.gmtime(now))
    with _RATE["lock"]:
        if _RATE["day"] != today:
            _RATE.update({"day": today, "day_count": 0, "ip": {}})
        if _RATE["day_count"] >= MAX_PER_DAY:
            return "The archive has reached today's question limit. Please try again tomorrow."
        hits = [t for t in _RATE["ip"].get(ip, []) if now - t < 3600]
        if len(hits) >= MAX_PER_IP_HOUR:
            return "That's a lot of questions in a short time - please pause a bit and try again."
        hits.append(now)
        _RATE["ip"][ip] = hits
        _RATE["day_count"] += 1
        return None


@asynccontextmanager
async def lifespan(_app):
    # load the model + indexes once, so every request is fast
    settings = brain.load_settings()
    ready = brain.searchable_channels(settings)
    STATE["settings"] = settings
    STATE["ctx"] = brain.load_search(settings, ready) if ready else None
    yield
    STATE.clear()


app = FastAPI(title="YT Archive Brain", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=ALLOW_ORIGINS,
                   allow_methods=["GET", "POST"], allow_headers=["*"])


def _check_key(x_brain_key):
    if BRAIN_KEY and x_brain_key != BRAIN_KEY:
        raise HTTPException(status_code=401, detail="bad or missing X-Brain-Key")


def _ctx():
    ctx = STATE.get("ctx")
    if ctx is None:
        raise HTTPException(status_code=503, detail="search not ready - run Update in the CLI first")
    return ctx


def _sources(candidates, cited):
    """The cited moments as plain JSON the frontend can render as source cards."""
    return [{"n": n, "timestamp": candidates[n - 1]["timestamp"], "title": candidates[n - 1]["title"],
             "channel": candidates[n - 1].get("channel"), "date": candidates[n - 1].get("date"),
             "url": candidates[n - 1]["url"]} for n in cited]


@app.get("/health")
def health():
    ctx = STATE.get("ctx")
    settings = STATE.get("settings") or {}
    # diagnostics so we can tell *why* it isn't ready (data missing vs key missing)
    diag = {"anthropic_key": bool(brain.need_key("ANTHROPIC_API_KEY")),
            "data_url_set": bool(os.environ.get("DATA_ARCHIVE_URL")),
            "output_dir": str(brain.OUTPUT)}
    try:
        diag["output_entries"] = sorted(p.name for p in brain.OUTPUT.iterdir())[:30]
    except Exception as e:
        diag["output_entries"] = f"error: {str(e)[:120]}"
    try:
        diag["channels_with_data"] = len(brain.searchable_channels(settings)) if settings else 0
    except Exception as e:
        diag["channels_with_data"] = f"error: {str(e)[:120]}"
    return {"ok": True, "ready": ctx is not None,
            "moments": ctx["total_moments"] if ctx else 0,
            "channels": len(ctx["scope"]) if ctx else 0, **diag}


@app.get("/search")
def search(q: str = Query(..., min_length=1), k: int = 20, x_brain_key: str = Header(None)):
    """Fast semantic search (no Claude call): embed the query once and return the top-k moments."""
    _check_key(x_brain_key)
    ctx = _ctx()
    hits = []
    if ctx["mat"] is not None and ctx["embedder"] is not None:
        qv = np.array(list(ctx["embedder"].query_embed([brain.query_text(ctx["model_name"], q)]))[0],
                      dtype=np.float32)
        qv /= np.linalg.norm(qv) + 1e-9
        scores = ctx["mat"] @ qv
        for i in np.argsort(-scores)[:max(1, min(k, 100))]:
            c = ctx["chunks"][int(i)]
            hits.append({"score": round(float(scores[int(i)]), 4), "timestamp": c["timestamp"],
                         "title": c["title"], "channel": c.get("channel"), "date": c.get("date"),
                         "url": c["url"], "text": c["text"][:300]})
    return {"q": q, "results": hits}


@app.get("/channels")
def channels(x_brain_key: str = Header(None)):
    """The channels available to search (for the website's channel picker) and the depth modes."""
    _check_key(x_brain_key)
    ctx = STATE.get("ctx")
    chans = ctx["channels_meta"] if ctx else []
    modes = [{"id": k, "label": v["label"], "usd": v["usd"]} for k, v in brain.MODES.items()]
    return {"channels": chans, "modes": modes, "default_mode": brain.DEFAULT_MODE}


class AskRequest(BaseModel):
    question: str
    channels: list[str] | None = None  # slugs to limit the search to; None/empty = all
    mode: str | None = None            # quick | standard | deep


@app.post("/ask")
def ask(req: AskRequest, request: Request, x_brain_key: str = Header(None),
        x_client_ip: str = Header(None)):
    """The full deluxe Q&A for one question. Returns the cited answer + sources as JSON.
    (Token-by-token streaming is added in Phase 2.)"""
    _check_key(x_brain_key)
    ctx = _ctx()
    q = (req.question or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="empty question")
    ip = (x_client_ip or (request.client.host if request.client else "") or "unknown").split(",")[0].strip()
    blocked = _rate_limited(ip)
    if blocked:
        raise HTTPException(status_code=429, detail=blocked)
    try:
        res = brain.answer_question(ctx, q, channels=req.channels, mode=req.mode)
    except Exception as e:
        msg = str(e).lower()
        if "credit" in msg or "billing" in msg:
            raise HTTPException(status_code=402, detail="Claude credit is used up")
        raise HTTPException(status_code=500, detail=f"answer failed: {str(e)[:200]}")
    if res["empty"]:
        return {"q": q, "empty": True, "answer": None, "sources": [], "coverage": res["coverage"]}
    brain.add_spend("claude", res["usd"], "web question")
    return {"q": q, "empty": False, "answer": res["answer"],
            "sources": _sources(res["candidates"], res["cited"]),
            "coverage": res["coverage"], "cost_usd": round(res["usd"], 4)}
