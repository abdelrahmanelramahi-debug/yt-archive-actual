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
# Chat messages are far cheaper than a Research answer, so they have their own, roomier counters.
MAX_CHAT_PER_DAY = int(os.environ.get("MAX_CHAT_PER_DAY", "1500"))
MAX_CHAT_PER_IP_HOUR = int(os.environ.get("MAX_CHAT_PER_IP_HOUR", "120"))
# Claude connector searches make no Claude call of ours (or one tiny one), so their limits are about the
# server's load. They're counted per account, not per IP: every one arrives from Anthropic's servers.
MAX_MCP_PER_DAY = int(os.environ.get("MAX_MCP_PER_DAY", "6000"))
MAX_MCP_PER_USER_HOUR = int(os.environ.get("MAX_MCP_PER_USER_HOUR", "150"))
_LIMITS = {"ask": (MAX_PER_DAY, MAX_PER_IP_HOUR), "chat": (MAX_CHAT_PER_DAY, MAX_CHAT_PER_IP_HOUR),
           "mcp": (MAX_MCP_PER_DAY, MAX_MCP_PER_USER_HOUR)}
_RATE = {"lock": threading.Lock(), "day": "", "count": {}, "who": {}}


def _rate_limited(who, kind="ask"):
    """Returns a message if this request should be blocked, else None (and records the hit). `who` is
    the visitor's IP (or an account, for the connector); `kind` picks the counters: ask | chat | mcp."""
    now = time.time()
    today = time.strftime("%Y-%m-%d", time.gmtime(now))
    day_max, hour_max = _LIMITS[kind]
    what = "searches" if kind == "mcp" else "questions"
    with _RATE["lock"]:
        if _RATE["day"] != today:
            _RATE.update({"day": today, "count": {}, "who": {}})
        if _RATE["count"].get(kind, 0) >= day_max:
            return f"The archive has reached today's limit of {what}. Please try again tomorrow."
        seen = _RATE["who"].setdefault(kind, {})
        hits = [t for t in seen.get(who, []) if now - t < 3600]
        if len(hits) >= hour_max:
            return f"That's a lot of {what} in a short time - please pause a bit and try again."
        hits.append(now)
        seen[who] = hits
        _RATE["count"][kind] = _RATE["count"].get(kind, 0) + 1
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
               channels: str = Query(None), x_brain_key: str = Header(None)):
    """The full transcript of one source video (ordered [{ts, text}]) for the website's per-source
    download button. No Claude call - just the stored captions - so no spend and no rate limit."""
    _check_key(x_brain_key)
    ctx = _ctx()
    # channels: comma-separated slugs this account may see (the website sends it when some are hidden)
    allowed = set(filter(None, channels.split(","))) if channels is not None else None
    return {"video_id": video_id, "lines": brain.full_transcript(ctx, video_id, slug, allowed)}


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
    chat: bool | None = None           # true = chat mode: a short conversational reply (not cached)
    history: list[dict[str, str]] | None = None  # chat: the conversation so far, [{role, content}]


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


def _cache_put(ctx, req, q, answer, sources, coverage, relevant=None):
    if not answer or not sources:  # only real, cited answers are worth reusing
        return
    try:
        con = _cache_db()
        try:
            con.execute("INSERT OR REPLACE INTO cache VALUES (?,?,?,?)",
                        (_cache_key(req, q), _cache_version(ctx), time.time(),
                         json.dumps({"answer": answer, "sources": sources, "coverage": coverage,
                                    "relevant": relevant or []}, ensure_ascii=False)))
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
        if req.chat:  # chat: depends on the conversation, so never cached
            for kind, payload in brain.chat_answer_stream(ctx, q, history=req.history, channels=req.channels,
                                                          mode=req.mode, channel_names=req.channel_names):
                if kind == "status":
                    put("status", {"stage": payload})
                elif kind == "delta":
                    put("delta", {"text": payload})
                elif kind == "source":
                    put("source", payload)
                elif kind == "videos":  # title-search matches, listed as links under the reply
                    put("videos", {"groups": payload})
                elif kind == "done":
                    brain.add_spend("claude", payload["usd"], "web chat")
                    put("done", {"coverage": payload["coverage"], "cost_usd": round(payload["usd"], 4),
                                 "relevant": payload.get("relevant") or []})
            return
        hit = _cache_get(ctx, req, q)
        if hit:  # asked before with the same data: replay the saved answer, no Claude call
            put("status", {"stage": "writing"})
            put("delta", {"text": hit["answer"]})
            for s in hit["sources"]:
                put("source", s)
            put("done", {"coverage": hit["coverage"], "cost_usd": 0.0, "cached": True,
                         "relevant": hit.get("relevant") or []})
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
                put("done", {"coverage": payload["coverage"], "cost_usd": round(payload["usd"], 4),
                             "relevant": payload.get("relevant") or []})
                _cache_put(ctx, req, q, "".join(text), sources, payload["coverage"], payload.get("relevant"))
    except Exception as e:
        put("error", {"error": "Claude credit is used up" if brain.is_credit_error(e)
                      else f"answer failed: {str(e)[:200]}"})
    finally:
        with job["cond"]:
            job["done"] = True
            job["cond"].notify_all()


def _start_job(ctx, q, req, uid):
    """Register a new answer job (dropping ones past JOB_TTL) and start writing it in the background."""
    now = time.time()
    job = {"id": uuid.uuid4().hex, "uid": uid or "", "t": now, "events": [], "done": False,
           "cond": threading.Condition(), "q": q, "mode": req.mode or brain.DEFAULT_MODE,
           "style": req.style or "topical"}
    with JOBS_LOCK:
        for k in [k for k, j in JOBS.items() if now - j["t"] > JOB_TTL]:
            del JOBS[k]
        JOBS[job["id"]] = job
    threading.Thread(target=_run_job, args=(job, ctx, q, req), daemon=True).start()
    return job


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
    blocked = _rate_limited(ip, "chat" if req.chat else "ask")
    if blocked:
        raise HTTPException(status_code=429, detail=blocked)
    job = _start_job(ctx, q, req, x_user_id)

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
                "coverage": hit["coverage"], "cost_usd": 0.0, "cached": True, "relevant": hit.get("relevant") or []}
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
    _cache_put(ctx, req, q, res["answer"], sources, res["coverage"], res.get("relevant"))
    return {"q": q, "empty": False, "answer": res["answer"], "sources": sources,
            "coverage": res["coverage"], "cost_usd": round(res["usd"], 4), "relevant": res.get("relevant") or []}


MOMENTS_MAX = 5000  # refs per request: well above the deepest answer's relevant set


class McpCall(BaseModel):
    tool: str
    arguments: dict | None = None
    channels: list[str] | None = None  # what this account may see; None = everything (admins)
    channel_names: dict[str, dict[str, str]] | None = None  # slug -> {en, ar} admin name overrides


@app.post("/mcp/call")
def mcp_call(req: McpCall, x_brain_key: str = Header(None), x_user_id: str = Header(None)):
    """One tool call from an account's Claude, via the website's /mcp endpoint (which has already checked
    who is asking, their daily allowance and their channels). Read-only: plain text back for Claude."""
    _check_key(x_brain_key)
    ctx = _ctx()
    if req.channels is not None and not req.channels:
        return {"text": "There are no channels to search.", "is_error": True}
    blocked = _rate_limited(x_user_id or "?", "mcp")
    if blocked:
        return {"text": blocked, "is_error": True}
    try:
        text, is_error = brain.mcp_tool(ctx, req.tool, req.arguments or {}, req.channels, req.channel_names)
    except Exception as e:
        print(f"mcp {req.tool} failed: {type(e).__name__}: {str(e)[:200]}", flush=True)
        return {"text": "The archive couldn't run that just now - try again.", "is_error": True}
    return {"text": text, "is_error": is_error}


class McpResearch(BaseModel):
    question: str | None = None   # start a new answer...
    job_id: str | None = None     # ...or keep waiting for one already started
    channels: list[str] | None = None
    mode: str | None = None
    style: str | None = None
    channel_names: dict[str, dict[str, str]] | None = None
    wait: float | None = None     # seconds to wait for the answer before replying "still writing"


MCP_RESEARCH_WAIT = 50  # one connector call waits this long at most; Claude calls again to keep waiting
_SSE_RE = re.compile(r"event: (\w+)\ndata: (.*)\n\n$", re.S)


def _job_result(job):
    """What an answer job has produced so far, read back from its events: (stage, answer text,
    sources, final event name, final payload) - the final event is done / empty / error, or None."""
    stage, text, sources, end, final = "", [], [], None, {}
    for ev in list(job["events"]):
        m = _SSE_RE.match(ev)
        if not m:
            continue
        kind, data = m.group(1), json.loads(m.group(2))
        if kind == "status":
            stage = data.get("stage") or stage
        elif kind == "delta":
            text.append(data.get("text") or "")
        elif kind == "source":
            sources.append(data)
        elif kind in ("done", "empty", "error"):
            end, final = kind, data
    return stage, "".join(text), sources, end, final


@app.post("/mcp/research")
def mcp_research(req: McpResearch, x_brain_key: str = Header(None), x_user_id: str = Header(None)):
    """A Research answer for an account's Claude: the same job, cache and spend as a question asked on
    the website (the website has already counted it against the account's daily answers). Waits up to
    `wait` seconds; an answer still being written comes back as "running" with its job id, and the
    connector calls again with that id to keep waiting. Returns the answer as data; the website words
    it for Claude and saves it to the account's history."""
    _check_key(x_brain_key)
    ctx = _ctx()
    uid = x_user_id or ""
    if req.job_id:
        with JOBS_LOCK:
            job = JOBS.get(req.job_id)
        if job is None or job["uid"] != uid:
            return {"state": "gone"}
    else:
        q = (req.question or "").strip()[:2000]
        if not q:
            return {"state": "error", "error": "Give a question to research."}
        if req.channels is not None and not req.channels:
            return {"state": "error", "error": "There are no channels to search."}
        blocked = _rate_limited(f"user:{uid}", "ask")  # every connector call comes from Anthropic's IPs
        if blocked:
            return {"state": "error", "error": blocked}
        mode = req.mode if req.mode in brain.MODES else None
        style = req.style if req.style in ("topical", "verbatim") else None
        ask = AskRequest(question=q, channels=req.channels, mode=mode, style=style, channel_names=req.channel_names)
        job = _start_job(ctx, q, ask, uid)
    deadline = time.time() + max(1.0, min(110.0, req.wait or MCP_RESEARCH_WAIT))
    with job["cond"]:
        while not job["done"]:
            left = deadline - time.time()
            if left <= 0:
                break
            job["cond"].wait(timeout=left)
    stage, answer, sources, end, final = _job_result(job)
    out = {"job_id": job["id"], "q": job.get("q", ""), "mode": job.get("mode"), "style": job.get("style")}
    if end is None:
        return {**out, "state": "running", "stage": stage, "written": len(answer)}
    if end == "error":
        return {**out, "state": "error", "error": final.get("error") or "the answer failed"}
    if end == "empty":
        return {**out, "state": "empty"}
    with job["cond"]:  # the website saves a finished answer to history once: say whether this is the first time
        first = not job.get("delivered")
        job["delivered"] = True
    return {**out, "state": "done", "answer": answer, "sources": sources, "first": first,
            "coverage": final.get("coverage"), "cost_usd": final.get("cost_usd"),
            "cached": bool(final.get("cached")), "relevant": final.get("relevant") or []}


class MomentsRequest(BaseModel):
    refs: list[dict[str, str]]  # [{"c": chunk id, "s": channel slug}] from an answer's "relevant"
    channels: list[str] | None = None  # slugs this account may see; None = all (no hidden channels)


@app.post("/moments")
def moments(req: MomentsRequest, x_brain_key: str = Header(None)):
    """The text of an answer's relevant moments (cited or not), for the website's "download all
    relevant moments". Stored captions only - no Claude call, no spend."""
    _check_key(x_brain_key)
    ctx = _ctx()
    refs = [r for r in req.refs[:MOMENTS_MAX] if isinstance(r.get("c"), str)]
    allowed = set(req.channels) if req.channels is not None else None
    return {"moments": brain.moments_json(ctx, refs, allowed)}

