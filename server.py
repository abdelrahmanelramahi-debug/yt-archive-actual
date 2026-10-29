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
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import app as brain

STATE = {}
BRAIN_KEY = os.environ.get("BRAIN_KEY")  # shared secret the frontend sends; unset = open (local dev)
# Comma-separated list of allowed frontend origins; "*" (default) is for local dev only.
ALLOW_ORIGINS = [o.strip() for o in os.environ.get("ALLOW_ORIGINS", "*").split(",") if o.strip()]


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
    return {"ok": True, "ready": ctx is not None,
            "moments": ctx["total_moments"] if ctx else 0,
            "channels": len(ctx["scope"]) if ctx else 0}


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


class AskRequest(BaseModel):
    question: str


@app.post("/ask")
def ask(req: AskRequest, x_brain_key: str = Header(None)):
    """The full deluxe Q&A for one question. Returns the cited answer + sources as JSON.
    (Token-by-token streaming is added in Phase 2.)"""
    _check_key(x_brain_key)
    ctx = _ctx()
    q = (req.question or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="empty question")
    try:
        res = brain.answer_question(ctx, q)
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
