---
description: Careful, incremental refactor pass (daily = light, weekly = deep themed audit)
argument-hint: daily | weekly
---

You are doing a **refactoring pass** on this project. Mode: **$ARGUMENTS** (default to `daily` if empty).

## What this project is — read before touching anything
A personal YouTube-lecture archive + Q&A tool. The brain is **single-file `app.py`** (~4.7k lines), plus `server.py` (FastAPI brain for the website), `web/` (Next.js frontend), and `deploy/` + `Dockerfile`. It is **live and deployed** (Vercel frontend + Railway brain + data on a GitHub release).

Deliberate design choices — do NOT "fix" these:
- `app.py` stays **one file**. Do not split it into modules/packages.
- It's a **personal tool**, not an enterprise app: no mandatory test suite, no web-security dogma (CSRF middleware, WAFs, auth frameworks), no heavy abstraction/DI/typing ceremony. Match the existing plain, direct style and comment density.
- Windows-first, UTF-8; no em-dashes in user-facing output; the console shows `channel_label` (Latin) for Arabic channel names on purpose.

## Prime directive: do no harm, never regress
- **Newer code is intentional.** Never revert, downgrade, or "simplify away" a recent change because it looks unusual or redundant — assume there is a reason. If unsure, check `git log` / `git blame` and nearby comments first. This command must never force-undo newer logic.
- **Preserve behavior.** A refactor keeps what the code *does* and improves how it reads and holds up. If a change would alter behavior, that's a fix/feature — name it and get the OK, don't slip it in under "refactor".
- **It is live.** Verify before and after: `py_compile` on `app.py` + `server.py`; for `web/`, the dev server must still compile; actually exercise the path you touched. If you cannot convince yourself a change is safe, **leave it and note it**.
- **Small, reviewable diffs.** Several tiny safe edits beat one sweeping rewrite. One concern per change. Never do a mass rewrite of a working file.

## Principles to apply (data / computer science / security)
- **Data integrity:** atomic writes (tmp file + `os.replace`, see `write_json`), defensive reads (`read_obj`/`read_list`), no silent data loss, consistent on-disk schemas.
- **Correctness:** edge cases, error handling that doesn't swallow real failures, resource cleanup (close files / SQLite connections), no races in the parallel download/index/map paths.
- **Security:** never log or commit secrets (keep `_SECRET_ENV` and `.gitignore` honest); validate external input; keep SQL parameterized; no `shell=True` / `eval` / `pickle` of untrusted data; constant-time compares for auth secrets; least privilege on tokens (e.g. the fine-grained `GITHUB_TOKEN`).
- **Phantom code:** delete dead/unreachable code, unused imports/variables/functions, commented-out blocks, and stale TODOs. If nothing uses it, it goes.
- **Redundancy:** fold genuine copy-paste into a shared helper where it actually clarifies — but do not over-DRY or abstract prematurely.
- **Readability & organization:** clear names, related functions grouped together, style consistent with the surrounding code, comments that match the code. Keep related things near each other within the single file.
- **Editability:** leave it easy for the next person to change — no hidden coupling, no clever one-liners that hide intent.
- **Efficiency:** avoid needless O(n^2) or repeated work, but do not micro-optimize or add typing/docstring ceremony just to add it.

## Scope by mode

### daily — light and fast (a few minutes)
- Look mainly at **recent / uncommitted work** (`git diff`, the last commit or two) and anything obviously off right next to it.
- Safe wins only: unused imports/variables, dead code, typos, a clearly wrong edge case in freshly touched code, a comment that no longer matches the code.
- Do **not** audit the whole codebase or make structural changes. Note anything bigger for a weekly pass instead of doing it now.

### weekly — deeper, one theme
- Pick **one** theme and rotate it week to week: `security` -> `data integrity` -> `error handling & resource cleanup` -> `performance` -> `readability/naming`.
- Audit that theme across the codebase, apply the **safe, verified** fixes, and list anything larger that needs discussion rather than doing it blind.
- Still incremental: a handful of solid improvements, never a rewrite.

## Process
1. Say the mode and what you will look at.
2. Audit, then list findings — each as: what, where (`file:line`), why it matters, and the risk of fixing it.
3. Apply only the safe, behavior-preserving fixes. Ask before anything risky or behavior-changing.
4. Verify (compile / exercise the touched path).
5. Report what changed and what you deliberately left alone and why. Commit only what the user approves, and only after it verifies.

End with a short, honest summary. **"Nothing worth changing" is a valid and good outcome — do not invent work.**
