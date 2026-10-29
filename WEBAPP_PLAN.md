# YouTube Archive — Web App Plan

Turning the archive into a premium, techy web app with an LLM-style ask bar.
Designed to run locally for you now, and to be hostable for others later without a rewrite.

---

## 1. The core idea (and the one constraint that shapes everything)

An LLM-style ask bar **cannot be static HTML**. The search and the deluxe Q&A run in Python with
the embedding model and indexes loaded in memory. So the archive becomes a **small web app with a
resident backend** that wraps the brains you already have.

We are **not rebuilding the brain.** `ask()`, the semantic + keyword retrieval, and the tagging
data are reused as-is behind a few API endpoints. This is mostly *a frontend + a thin server*.

The deluxe pipeline is a gift here: its stages (decompose -> retrieve 500 moments -> distill ->
synthesize) map exactly onto a Perplexity-style flow — **"Searching 500 moments across 200
videos..." -> "Reading the relevant ones..." -> the answer streams in** with live citations.

---

## 2. Architecture (hosted, so others can use it)

Target: a public website others can visit, deployable, and open to scaling. Vercel is serverless,
so it **cannot** hold the embedding model or ~1.3M vectors resident in RAM, and its Hobby functions
cap near the ~60s our deluxe pipeline needs. So the brain lives in its own small service, and Vercel
hosts the website that talks to it. Two tiers:

```
            Browser (public)
                 |  HTTPS
                 v
      Next.js frontend on VERCEL  ---- auth (login/invite) + per-user cost caps
                 |  HTTPS / SSE  (server-to-server)
                 v
      "Brain" service: FastAPI + uvicorn  (Railway / Render, always-on, ~$5/mo)
             |      |            |
         /ask(SSE) /search    /video /channels /topics
             |      |            |
             v      v            v
         app.py's logic, reused: deluxe ask(), semantic + keyword search, tags
             |
             v
     Data layer:  v1 = on-disk indexes (reuse today's)   ->   v2 = Postgres + pgvector (scale)
```

- **Frontend (Vercel):** Next.js — the native, scalable, "others can access" path. Handles the UI,
  auth, cost caps, and streams answers to the browser. (Hosted + public is why Next.js is now the
  right call, rather than the no-build approach I'd have used for a localhost-only tool.)
- **Brain service:** FastAPI + uvicorn on a small always-on host. Loads the model + indexes **once**
  and runs your existing search + deluxe Q&A. This is nearly all your current Python, just hosted.
  Reachable only by the Vercel app (not the public), behind a shared secret.
- **Data layer:** starts on today's on-disk embeddings + SQLite FTS (fast to ship), and **scales by
  moving vectors to managed Postgres + pgvector** later — isolated behind the search function, so
  scaling is a switch, not a rewrite, and the brain service becomes stateless/horizontally scalable.
- **One enabling refactor** (Phase 0): `ask()` currently prints to the terminal. We split its
  *logic* from its *printing* so it can be called programmatically and stream structured events
  (stage updates, answer chunks, citations). The CLI keeps working unchanged.

### Stack decision

| Layer | Choice | Why |
|---|---|---|
| Frontend / host | **Next.js on Vercel** | native to your Vercel, scalable, best for a public site + streaming |
| Brain service | **FastAPI + uvicorn** on Railway/Render | keeps the model warm; runs the long multi-step pipeline a serverless function can't |
| Streaming | **SSE** | one-way server->browser; simple |
| Data (v1 -> v2) | **on-disk now -> Postgres + pgvector** | ship fast, then scale the data layer behind one function |
| Auth | **login/invite + per-user daily cost caps** | a public ask bar spends real Claude money; this is mandatory before it's reachable |

### Why not run everything on Vercel?

Serverless has no persistent process, can't keep a multi-GB index in RAM, and Hobby functions time
out before the deluxe pipeline finishes. We'd also have to re-embed the whole corpus with an API
model for query/corpus consistency. The two-tier split avoids all of that and reuses your code. If
we ever want pure-Vercel, it's a later optimization (pgvector + an embedding API + a Pro plan).

---

## 3. API endpoints

| Endpoint | Method | Returns |
|---|---|---|
| `/api/ask` | POST (SSE) | streams: `stage` events (decomposing, searching N, reading, synthesizing), then `token` events (the answer), then a final `done` event with citations + coverage |
| `/api/search` | GET `?q=` | ranked semantic + keyword hits: video, timestamp, snippet, score |
| `/api/channels` | GET | channel cards: name, counts, hours, language |
| `/api/channel/{slug}` | GET | that channel's videos |
| `/api/video/{id}` | GET | transcript chunks, timestamps, tags, claims, summary |
| `/api/topics` | GET | topic list + counts; `/api/topic/{name}` -> its moments |
| `/api/health` | GET | model/index load status (for a warm-up screen) |
| *(hosted, later)* `/api/auth/*`, `/api/usage` | — | sign-in, per-user spend/usage |

---

## 4. The experience (what it looks and feels like)

- **Ask-first landing.** Big centered ask bar, a few example questions, recent questions. Dark,
  techy, generous whitespace, a refined accent color, Inter + a mono face. Premium, calm, fast.
- **Streaming answer.** A live status line shows the pipeline working, then the answer types in.
  Inline `[1]`,`[2]` citations are clickable chips.
- **Sources rail.** Each cited moment as a card — channel, video title, timestamp, the exact quote
  — click to jump to that second on YouTube. Plus the coverage line ("drew on 500 moments across
  111 videos; cited 204 from 6 channels").
- **Browse.** Channel grid, a topic explorer (you already generate topics), per-video pages with
  the transcript, jump-to-timestamp, and that video's claims + summary.
- **Search.** Instant keyword + semantic results as you type.

---

## 5. Designed for "shareable later" (baked in now, built when you flip it on)

You chose to plan for hosting others eventually. We design these seams now so it's a switch, not a
rewrite — but we do **not** build or expose them until you ask:

- **`HOSTED` config flag**, off by default. Localhost mode = no auth, bound to `127.0.0.1`.
- **Auth seam:** a FastAPI dependency on protected routes. Localhost = pass-through. Hosted = plug
  in a provider (simple access token first; OAuth/Google later).
- **Per-user cost caps:** each deluxe ask costs ~$0.12-0.20. We reuse your spend-ledger idea to cap
  spend per user per day and show it. A web ask bar makes it very easy to run lots of queries, so
  this matters even for just you.
- **Rate limiting** seam on `/api/ask`.
- **CORS + configurable bind host/port**, so a real deployment doesn't need code edits.

### Hosting reality check (so there are no surprises later)

The embeddings currently live in RAM. Your archive is ~1.3M search chunks. Rough memory:
`bge-small` (English, 384-dim) ~2 GB; `multilingual-e5-large` (Arabic, 1024-dim) ~5 GB. That's fine
on your PC, but a hosted box needs that much RAM, **or** we move vectors to a disk-backed vector DB
(FAISS / sqlite-vss / Qdrant). That swap is isolated behind the search function, so it's a Phase-5
decision, not a blocker now.

---

## 6. Phased rollout (the CLI keeps working the entire time)

**Phase 0 — Make the brain callable (no new UI, no behavior change).** *(in progress)*
- Split `ask()` into `searchable_channels()` + `load_search()` (load model/indexes once) and
  `answer_question(ctx, q)` (one question -> structured result: answer, candidates, citations,
  coverage, cost). Add a streaming variant for the final synthesis so the web UI can type the answer.
- CLI `ask()` becomes a thin wrapper over these — identical terminal output.
- *Done when:* the CLI behaves exactly as before and the two functions are importable and tested.

**Phase 1 — Brain service (FastAPI).**
- `server.py`: load everything at startup; `/ask` (SSE), `/search`, `/health`, protected by a shared
  secret. Run it locally first, then deploy to Railway/Render.
- *Done when:* `curl`-ing `/ask` streams a real cited answer.

**Phase 2 — Next.js frontend + the premium ask experience.**
- Next.js app on Vercel: ask-first landing, streaming answer, citation chips, source cards,
  coverage line. Design system (dark/light, type, spacing). Calls the brain service server-side.
- Deploy to Vercel (I have your Vercel access).
- *Done when:* the public URL streams a cited answer with the premium look.

**Phase 3 — Auth + cost caps (before it's truly shared).**
- Login/invite gate on the frontend; per-user daily spend cap + global cap; per-IP rate limit on
  `/ask`. *This gates going public — not optional.*

**Phase 4 — Browse + search pages.**
- Channel grid, topic explorer, per-video pages, search page. Reuses `videos.json`, `topics.json`,
  chunks via the brain's data endpoints.

**Phase 5 — Polish + scale-readiness.**
- Responsive, warm-up screen, perf, empty/error states. When traffic/size warrants: move vectors to
  Postgres + pgvector so the brain service is stateless and scales horizontally.

### Deployment & accounts
- **Vercel:** confirmed (Hobby plan, GitHub-linked). Frontend deploys here.
- **GitHub:** needed for a clean repo + Vercel auto-deploy; please grant access, or I can deploy to
  Vercel directly from local files to start.
- **Brain host:** Railway or Render (~$5/mo) — needed because Vercel can't hold the model/pipeline.
- **Secrets:** your API keys live only in the brain service's env (never in the frontend/browser).

---

## 7. Risks & honest tradeoffs

- **Scope:** this is a real project — a focused multi-session build, not an afternoon. Phases 0-2
  are the heart; 3-4 are breadth; 5 is a separate effort.
- **The Phase 0 refactor** (streaming out of `ask()`) is the one place we touch core logic. We do it
  carefully, keep the CLI output identical, and test before/after.
- **Memory at scale** (hosting): the embeddings-in-RAM approach needs a beefy host or a vector-DB
  swap. Fine locally; planned for hosting.
- **Cost at scale:** ~$0.15/ask × many users needs caps + probably auth before it's public.
- **Maintainability:** we deliberately avoid a Node build pipeline so you can keep running this
  yourself. React stays an option if you later decide the polish is worth the upkeep.

---

## 8. Open decisions (to confirm before/while building)

1. Frontend: confirm **lightweight (Tailwind CDN + htmx)** vs React. (Recommended: lightweight.)
2. Visual direction: a quick mockup first, or design live in Phase 2?
3. For hosting later: rough audience size (handful of friends vs public) — drives auth + vector-DB.
4. New file layout: `server.py` + `web/` (static assets) alongside `app.py`, keeping one repo.

---

## 9. Suggested first step

Start with **Phase 0 + Phase 1** as one slice: make `ask()` streamable, stand up `server.py`, and
get a real cited answer streaming into a bare browser page. That proves the whole architecture with
the least risk, and everything visual builds on top of it. The CLI stays fully intact throughout.
