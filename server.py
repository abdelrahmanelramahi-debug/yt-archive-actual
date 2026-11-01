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
import hmac
import json
import os
import re
import threading
import time
import uuid
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
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
    # constant-time compare so the key can't be guessed from response timing
    if BRAIN_KEY and not hmac.compare_digest(x_brain_key or "", BRAIN_KEY):
        raise HTTPException(status_code=401, detail="bad or missing X-Brain-Key")


def _ctx():
    ctx = STATE.get("ctx")
    if ctx is None:
        raise HTTPException(status_code=503, detail="search not ready - run Update in the CLI first")
    return ctx


def _sources(ctx, candidates, cited):
    """The cited moments as plain JSON the frontend can render as source cards (each with a short
    transcript window). The one-shot /ask returns them all at once; the stream sends them one by one."""
    return [brain.source_json(ctx, candidates[n - 1], n) for n in cited]


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


@app.get("/transcript")
def transcript(video_id: str = Query(..., min_length=1), slug: str = Query(None),
               x_brain_key: str = Header(None)):
    """The full transcript of one source video (ordered [{ts, text}]) for the website's per-source
    download button. No Claude call - just the stored captions - so no spend and no rate limit."""
    _check_key(x_brain_key)
    ctx = _ctx()
    return {"video_id": video_id, "lines": brain.full_transcript(ctx, video_id, slug)}


@app.get("/channels")
def channels(x_brain_key: str = Header(None)):
    """The channels available to search (for the website's channel picker) and the depth modes."""
    _check_key(x_brain_key)
    ctx = STATE.get("ctx")
    chans = ctx["channels_meta"] if ctx else []
    modes = [{"id": k, "label": v["label"], "usd": v["usd"]} for k, v in brain.MODES.items()]
    return {"channels": chans, "modes": modes, "default_mode": brain.DEFAULT_MODE,
            "total_moments": ctx["total_moments"] if ctx else 0,
            "total_videos": ctx.get("total_videos", 0) if ctx else 0}


class AskRequest(BaseModel):
    question: str
    channels: list[str] | None = None  # slugs to limit the search to; None/empty = all
    mode: str | None = None            # quick | standard | deep
    style: str | None = None           # topical (default) | verbatim
    channel_names: dict[str, dict[str, str]] | None = None  # slug -> {en, ar} admin name overrides
    cand_max: int | None = None        # admin "custom" depth: moments to read in (clamped in the brain)
    answer_max: int | None = None      # admin "custom" depth: answer length in tokens (clamped)
    fresh: bool | None = None          # true = skip the answer cache and write a new answer


# Answer cache: the same question (same words, channels, depth and style) asked again is served from the
# saved answer - instant and free. Matching is EXACT after light normalisation (case, punctuation, spacing,
# Arabic harakat and letter forms), never "similar": a reworded question can mean something different, so
# it gets its own answer. Every entry is tied to the data + code version, so a publish or a code change
# starts the cache afresh; entries also expire after CACHE_TTL. It lives on the volume (output/), which
# the entrypoint keeps across restarts (it only clears channel folders).
CACHE_PATH = brain.OUTPUT / "answer_cache.db"
CACHE_TTL = 30 * 24 * 3600
_CACHE = {"ver": None}


def _cache_db():
    import sqlite3
    con = sqlite3.connect(CACHE_PATH, timeout=10)
    con.execute("CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, ver TEXT, t REAL, data TEXT)")
    return con


def _cache_version(ctx):
    """Changes whenever what an answer depends on changes: the data, the code, the channel names."""
    import hashlib
    if _CACHE["ver"] is None:
        h = hashlib.sha256()
        for f in (brain.ROOT / "app.py", brain.ROOT / "server.py", brain.OUTPUT / ".data-stamp"):
            try:
                h.update(f.read_bytes())
            except OSError:
                h.update(b"-")
        h.update(str(ctx.get("total_moments")).encode())
        h.update(json.dumps(ctx.get("channels_meta"), sort_keys=True, ensure_ascii=False).encode())
        _CACHE["ver"] = h.hexdigest()[:24]
    return _CACHE["ver"]


def _norm_question(q):
    t = brain._AR_DIAC.sub("", q or "").translate(brain._AR_TR).lower()
    return " ".join(re.findall(r"\w+", t))


def _cache_key(req, q):
    import hashlib
    k = {"q": _norm_question(q), "ch": sorted(req.channels or []), "mode": req.mode or brain.DEFAULT_MODE,
         "style": req.style or "topical", "names": req.channel_names or {}, "cm": req.cand_max, "am": req.answer_max}
    return hashlib.sha256(json.dumps(k, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _cache_get(ctx, req, q):
    if req.fresh or not _norm_question(q):
        return None
    try:
        con = _cache_db()
        try:
            row = con.execute("SELECT data, t FROM cache WHERE key=? AND ver=?",
                              (_cache_key(req, q), _cache_version(ctx))).fetchone()
        finally:
            con.close()
    except Exception:
        return None  # the cache is an extra: on any trouble, just answer normally
    if not row or time.time() - row[1] > CACHE_TTL:
        return None
    try:
        return json.loads(row[0])
    except ValueError:
        return None


def _cache_put(ctx, req, q, answer, sources, coverage):
    if not answer or not sources:  # only real, cited answers are worth reusing
        return
    try:
        con = _cache_db()
        try:
            con.execute("INSERT OR REPLACE INTO cache VALUES (?,?,?,?)",
                        (_cache_key(req, q), _cache_version(ctx), time.time(),
                         json.dumps({"answer": answer, "sources": sources, "coverage": coverage}, ensure_ascii=False)))
            # tidy: drop other versions and expired entries (cheap: the table stays small)
            con.execute("DELETE FROM cache WHERE ver != ? OR t < ?", (_cache_version(ctx), time.time() - CACHE_TTL))
            con.commit()
        finally:
            con.close()
    except Exception:
        pass


def _sse(event, data):
    """Format one Server-Sent Event. ensure_ascii=False keeps Arabic answers compact."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# Answers run as background jobs, so one keeps writing when the reader's connection drops (a phone
# switching apps suspends the page). The stream just follows the job; the page reconnects with
# /ask/job and picks up from the last event it got. Jobs live in memory for JOB_TTL seconds.
JOBS = {}
JOBS_LOCK = threading.Lock()
JOB_TTL = 30 * 60


def _run_job(job, ctx, q, req):
    def put(event, data):
        with job["cond"]:
            job["events"].append(_sse(event, data))
            job["cond"].notify_all()

    try:
        hit = _cache_get(ctx, req, q)
        if hit:  # asked before with the same data: replay the saved answer, no Claude call
            put("status", {"stage": "writing"})
            put("delta", {"text": hit["answer"]})
            for s in hit["sources"]:
                put("source", s)
            put("done", {"coverage": hit["coverage"], "cost_usd": 0.0, "cached": True})
            return
        text, sources = [], []
        for kind, payload in brain.answer_question_stream(ctx, q, channels=req.channels, mode=req.mode, style=req.style, channel_names=req.channel_names, cand_max=req.cand_max, answer_max=req.answer_max):
            if kind == "status":
                put("status", {"stage": payload})
            elif kind == "delta":
                text.append(payload)
                put("delta", {"text": payload})
            elif kind == "source":  # one cited moment, streamed in as the answer references it
                sources.append(payload)
                put("source", payload)
            elif kind == "empty":
                put("empty", {})
            elif kind == "done":
                brain.add_spend("claude", payload["usd"], "web question")
                put("done", {"coverage": payload["coverage"], "cost_usd": round(payload["usd"], 4)})
                _cache_put(ctx, req, q, "".join(text), sources, payload["coverage"])
    except Exception as e:
        put("error", {"error": "Claude credit is used up" if brain.is_credit_error(e)
                      else f"answer failed: {str(e)[:200]}"})
    finally:
        with job["cond"]:
            job["done"] = True
            job["cond"].notify_all()


def _follow(job, after):
    """SSE for a job from event `after` on, live until it finishes. A comment line every 15 s of
    quiet keeps proxies from closing the connection while Claude is still reading."""
    i = max(0, after)
    while True:
        with job["cond"]:
            if i >= len(job["events"]) and not job["done"]:
                job["cond"].wait(timeout=15)
            batch, finished = job["events"][i:], job["done"]
        for ev in batch:
            yield ev
        i += len(batch)
        if finished and i >= len(job["events"]):
            return
        if not batch:
            yield ": ping\n\n"


@app.post("/ask/stream")
def ask_stream(req: AskRequest, request: Request, x_brain_key: str = Header(None),
               x_client_ip: str = Header(None), x_user_id: str = Header(None)):
    """The deluxe Q&A streamed as Server-Sent Events: first 'job' (its id, for reconnecting), then
    'status' (searching/reading/writing), many 'delta' (answer text as it writes), the 'source's,
    then 'done' (coverage + cost), 'empty' or 'error'. Same answer as /ask - the frontend falls back
    to /ask when a stream can't be opened at all."""
    _check_key(x_brain_key)
    ctx = _ctx()
    q = (req.question or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="empty question")
    ip = (x_client_ip or (request.client.host if request.client else "") or "unknown").split(",")[0].strip()
    blocked = _rate_limited(ip)
    if blocked:
        raise HTTPException(status_code=429, detail=blocked)
    now = time.time()
    job = {"id": uuid.uuid4().hex, "uid": x_user_id or "", "t": now, "events": [], "done": False,
           "cond": threading.Condition()}
    with JOBS_LOCK:
        for k in [k for k, j in JOBS.items() if now - j["t"] > JOB_TTL]:
            del JOBS[k]
        JOBS[job["id"]] = job
    threading.Thread(target=_run_job, args=(job, ctx, q, req), daemon=True).start()

    def gen():
        yield _sse("job", {"id": job["id"]})
        yield from _follow(job, 0)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/ask/job")
def ask_job(id: str = Query(..., min_length=8), after: int = 0, x_brain_key: str = Header(None),
            x_user_id: str = Header(None)):
    """Reconnect to an answer still running (or finished in the last half hour): its events from
    number `after` on. Only the account that asked can read it. No Claude call, no spend."""
    _check_key(x_brain_key)
    with JOBS_LOCK:
        job = JOBS.get(id)
    if job is None or (job["uid"] and job["uid"] != (x_user_id or "")):
        raise HTTPException(status_code=404, detail="that answer is no longer available")
    return StreamingResponse(_follow(job, after), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/ask")
def ask(req: AskRequest, request: Request, x_brain_key: str = Header(None),
        x_client_ip: str = Header(None)):
    """The full deluxe Q&A for one question. Returns the cited answer + sources as JSON. The website
    uses /ask/stream for a live answer and falls back to this when a stream can't be opened."""
    _check_key(x_brain_key)
    ctx = _ctx()
    q = (req.question or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="empty question")
    ip = (x_client_ip or (request.client.host if request.client else "") or "unknown").split(",")[0].strip()
    blocked = _rate_limited(ip)
    if blocked:
        raise HTTPException(status_code=429, detail=blocked)
    hit = _cache_get(ctx, req, q)
    if hit:
        return {"q": q, "empty": False, "answer": hit["answer"], "sources": hit["sources"],
                "coverage": hit["coverage"], "cost_usd": 0.0, "cached": True}
    try:
        res = brain.answer_question(ctx, q, channels=req.channels, mode=req.mode, style=req.style, channel_names=req.channel_names, cand_max=req.cand_max, answer_max=req.answer_max)
    except Exception as e:
        if brain.is_credit_error(e):
            raise HTTPException(status_code=402, detail="Claude credit is used up")
        raise HTTPException(status_code=500, detail=f"answer failed: {str(e)[:200]}")
    if res["empty"]:
        return {"q": q, "empty": True, "answer": None, "sources": [], "coverage": res["coverage"]}
    brain.add_spend("claude", res["usd"], "web question")
    sources = _sources(ctx, res["candidates"], res["cited"])
    _cache_put(ctx, req, q, res["answer"], sources, res["coverage"])
    return {"q": q, "empty": False, "answer": res["answer"], "sources": sources,
            "coverage": res["coverage"], "cost_usd": round(res["usd"], 4)}
