# Admin accounts — plan (not built yet)

Goal: let a few accounts (yours first) act as **admins** who can, for *other*
accounts: raise their daily limit, and control which channels they can see.
This is a design only — nothing here is implemented.

Everything fits the current setup (Firebase Auth + `jose` token verify +
Firestore-REST on Vercel, brain on Railway). The brain stays user-agnostic; all
per-user logic lives in the Next API layer, the only place that knows who the
user is.

---

## 1. Who is an admin

**Recommended: a Firebase custom claim `admin: true`.**
- It rides *inside* the ID token, so `uidFromAuthHeader` (in
  [`firebase-admin.ts`](../web/src/lib/firebase-admin.ts)) can expose it with
  **zero extra Firestore reads** — just also return `payload.admin`.
- Setting a claim does **not** need `firebase-admin`. The Identity Toolkit REST
  API (`accounts:update` with `customAttributes`) accepts the same
  service-account access token we already mint in `accessToken()`.
- Client can read its own claim with `getIdTokenResult()` to show/hide the admin
  UI. (This is cosmetic — the server re-checks the claim on every admin action.)

Alternative: a `users/{uid}.role = "admin"` field. Simpler to set, but costs a
Firestore read on every privileged call and can't gate the token. Prefer the
claim.

> **Caveat:** a claim change only lands in the user's token on the next refresh
> (~1h, or next sign-in / forced `getIdToken(true)`). Fine for admin grants;
> worth noting in the UI.

**Bootstrap:** set your own account's `admin` claim once (a one-off protected
call / tiny script against Identity Toolkit). After that you grant others from
the UI.

---

## 2. Per-account daily limit (easiest win — do first)

Today `consumeDaily(uid)` compares against a single global `DAILY_CAP` (20).

- Add an optional `cap` integer to `users/{uid}`.
- In `consumeDaily`, after reading the doc:
  `const cap = f.cap?.integerValue ? Number(f.cap.integerValue) : DAILY_CAP;`
  then compare `count >= cap` and return `cap - next`. (Decide an "unlimited"
  sentinel, e.g. a very large cap, or treat a special value as no-limit.)
- Admin sets it via the admin API below. No schema migration — absent `cap`
  just means "use the global default".

The client already reads `users/{uid}` live for the usage counter, so showing
"x / cap" instead of "x / 20" is a one-line change once `cap` exists.

---

## 3. Hidden channels

There is **no** channel-visibility concept today — `/channels` returns every
channel with data. Introduce one, enforced server-side.

**Storage**
- Global default: `config/visibility { hiddenChannels: [slug, ...] }` — hidden
  from all non-admins.
- (Optional, later) per-account override on `users/{uid}`:
  `hiddenChannels` (extra hidden) and/or `showChannels` (un-hide for this one
  account). Start with just the global list.

**Enforcement — must be in the Next API layer, not only the picker:**
- [`/api/channels`](../web/src/app/api/channels/route.ts): make it
  authenticated. Verify uid + claim; fetch the brain list; if **not** admin,
  drop hidden slugs before returning. Admins see everything.
- [`/api/ask`](../web/src/app/api/ask/route.ts) +
  [`/api/ask/stream`](../web/src/app/api/ask/stream/route.ts): compute the
  user's allowed slug set and **intersect** it with the requested `channels`
  (and when the user asks "all channels", pass only the allowed ones to the
  brain). This is the real gate — it stops a non-admin from passing a hidden
  slug directly in the POST body to bypass the picker.

Keep visibility logic entirely in Next; the brain needs no changes.

---

## 4. Admin write API (new routes)

New `/api/admin/*` routes, each gated by a `requireAdmin(req)` helper (verify
token → require `admin` claim → 403 otherwise). They mutate *other* users, so
they use the service-account path (Firestore REST + Identity Toolkit) —
client security rules still forbid a user writing another user's docs, which is
correct and stays unchanged.

- `GET  /api/admin/users` — list accounts (Identity Toolkit `accounts:query`)
  joined with their usage/cap docs.
- `POST /api/admin/user-cap` — set `users/{uid}.cap`.
- `POST /api/admin/user-admin` — set/clear the `admin` custom claim.
- `POST /api/admin/visibility` — set `config/visibility.hiddenChannels`
  (and later per-user overrides).

Validate inputs: slugs must exist in the brain's channel list; `cap` within
sane bounds.

---

## 5. Firestore rules

- `users/{uid}.cap` and any `users/{uid}` admin-managed fields: keep
  **server-write-only** (already the case — `allow write: if false`). Admins
  write them through the service account, not the client.
- `config/visibility`: keep **server-only** (no client rule). The client learns
  visibility solely through `/api/channels`, so rules stay tight.
- The existing `chats` subcollection rules are unaffected.

---

## 6. Admin UI

- Show an **"Admin"** entry only when `getIdTokenResult().claims.admin` is true
  (cosmetic gate; server enforces for real). Natural home: below the account
  row in the sidebar, or a dedicated `/admin` route.
- Contents: a user table (email · answers today · cap · admin toggle) and a
  global channel-visibility editor (checkboxes over the channel list). Keep it
  in-theme and minimal.

---

## Suggested sequencing

1. **Phase 1 (small):** per-account `cap` in `consumeDaily` + `POST
   /api/admin/user-cap` + bootstrap your admin claim + show "x / cap". Useful
   immediately.
2. **Phase 2 (medium):** global hidden-channels list + enforcement in
   `/api/channels` and `/api/ask(/stream)` + the visibility editor.
3. **Phase 3 (polish):** user-list table, admin-toggle UI, per-account
   visibility overrides.

## Security checklist

- Every privileged mutation re-verifies the `admin` claim **server-side** —
  never trust a client flag.
- Channel visibility enforced in `/api/ask(/stream)`, not just the picker.
- Claim changes are ~1h-delayed by token refresh — surface that in the UI.
- Validate slugs and cap bounds on every admin write.
