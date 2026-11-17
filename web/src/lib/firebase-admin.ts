// Server-side auth + daily cap — WITHOUT firebase-admin (its grpc/native deps don't package
// cleanly into Vercel functions). We verify Firebase ID tokens with `jose` against Google's public
// keys, and read/write the per-user usage doc through the Firestore REST API with a service-account
// access token. Needs: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.
import { jwtVerify, createRemoteJWKSet, importPKCS8, SignJWT } from "jose";

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "latafti";
export const DAILY_CAP = Number(process.env.DAILY_CAP || 20);
export const GUEST_CAP = Number(process.env.GUEST_CAP || 2); // free questions before guests must sign up
// Chat messages are much cheaper than a Research answer, so they have their own daily allowance.
export const CHAT_CAP = Number(process.env.CHAT_CAP || 30);
export const GUEST_CHAT_CAP = Number(process.env.GUEST_CHAT_CAP || 5);
// Searches an account's own Claude may run through the connector (latafti.com/mcp) per day. They make
// no Claude call of ours, so the allowance is roomy; an admin-set `mcpCap` on the account overrides it.
export const MCP_CAP = Number(process.env.MCP_CAP || 200);

// Bootstrap admins by email (comma-separated), set in the environment. Anyone signed in with one
// of these emails is treated as an admin — no custom-claim plumbing needed to get started.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export const isAdminEmail = (email: string) => email !== "" && ADMIN_EMAILS.includes(email.toLowerCase());

const SCOPE_DATASTORE = "https://www.googleapis.com/auth/datastore";
const SCOPE_ADMIN = "https://www.googleapis.com/auth/cloud-platform"; // Firestore + Identity Toolkit

// Firebase ID tokens are RS256 JWTs signed by Google's securetoken service.
const JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")
);

// A Google OAuth access token minted from the service account, cached ~1h per scope.
const tokenCache = new Map<string, { token: string; exp: number }>();
async function accessToken(scope: string = SCOPE_DATASTORE): Promise<string> {
  const hit = tokenCache.get(scope);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const pem = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !pem) throw new Error("service-account env vars missing");
  const key = await importPKCS8(pem, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(clientEmail)
    .setSubject(clientEmail)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const j = (await r.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("failed to mint access token");
  tokenCache.set(scope, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}

const DOC = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users`;

// Reserve one of today's answers for this user. The cap is per-account: each user has their own
// daily count on users/{uid}, and an optional `cap` field on that doc (set by an admin) overrides
// the global DAILY_CAP default for just that account. Returns the remaining count (or -1 if over)
// together with the effective cap. Read-then-write (no transaction): the tiny concurrency window
// can let a user get one extra, which is fine for a soft cap. The day resets at UTC midnight.
export async function consumeDaily(uid: string, guest = false): Promise<{ remaining: number; cap: number }> {
  return consume(uid, guest, "answer");
}

// The same for one chat message: its own count (chatDay/chatCount) against CHAT_CAP, or an admin-set
// `chatCap` on the account.
export async function consumeChat(uid: string, guest = false): Promise<{ remaining: number; cap: number }> {
  return consume(uid, guest, "chat");
}

// The same for one Claude-connector search (mcpDay/mcpCount against MCP_CAP or `mcpCap`). `gen` is the
// connection generation the caller's token was issued under: if the account has since pressed
// "Disconnect Claude" (which bumps `mcpGen`), the call is refused as revoked and nothing is counted.
export async function consumeMcp(uid: string, gen: number): Promise<{ remaining: number; cap: number; revoked?: boolean }> {
  return consume(uid, false, "mcp", gen);
}

type Counter = "answer" | "chat" | "mcp";
const COUNTER_FIELDS: Record<Counter, [string, string, string]> = {
  answer: ["day", "count", "cap"],
  chat: ["chatDay", "chatCount", "chatCap"],
  mcp: ["mcpDay", "mcpCount", "mcpCap"],
};

async function consume(
  uid: string,
  guest: boolean,
  kind: Counter,
  gen?: number
): Promise<{ remaining: number; cap: number; revoked?: boolean }> {
  const token = await accessToken();
  const auth = { Authorization: `Bearer ${token}` };
  const today = new Date().toISOString().slice(0, 10);
  const [dayF, countF, capF] = COUNTER_FIELDS[kind];

  const get = await fetch(`${DOC}/${uid}`, { headers: auth });
  let count = 0;
  let cap =
    kind === "chat" ? (guest ? GUEST_CHAT_CAP : CHAT_CAP) : kind === "mcp" ? MCP_CAP : guest ? GUEST_CAP : await getDefaultCap();
  if (get.ok) {
    const f = ((await get.json()) as { fields?: Record<string, { stringValue?: string; integerValue?: string }> }).fields || {};
    if (gen !== undefined && Number(f.mcpGen?.integerValue || 0) !== gen) return { remaining: -1, cap, revoked: true };
    if (f[dayF]?.stringValue === today) count = Number(f[countF]?.integerValue || 0);
    if (!guest) {
      const c = Number(f[capF]?.integerValue);
      if (Number.isFinite(c) && c > 0) cap = c; // admin-set per-account override (real accounts only)
    }
  } else if (get.status !== 404) {
    throw new Error(`firestore read failed: ${get.status}`);
  }
  if (count >= cap) return { remaining: -1, cap };

  const next = count + 1;
  // The update mask covers only this counter's fields + updatedAt, so the caps and the other
  // counter are preserved untouched.
  const patch = await fetch(
    `${DOC}/${uid}?updateMask.fieldPaths=${dayF}&updateMask.fieldPaths=${countF}&updateMask.fieldPaths=updatedAt`,
    {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          [dayF]: { stringValue: today },
          [countF]: { integerValue: String(next) },
          updatedAt: { integerValue: String(Date.now()) },
        },
      }),
    }
  );
  if (!patch.ok) throw new Error(`firestore write failed: ${patch.status}`);
  return { remaining: cap - next, cap };
}

// ---- Claude connector ------------------------------------------------------

// The account's connection generation (0 until it first disconnects Claude). Every connector token
// carries the generation it was issued under; bumping it invalidates them all at once.
export async function getMcpGen(uid: string): Promise<number> {
  const token = await accessToken();
  const r = await fetch(`${DOC}/${uid}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return 0;
  if (!r.ok) throw new Error(`user read failed: ${r.status}`);
  const j = (await r.json()) as { fields?: { mcpGen?: { integerValue?: string } } };
  return Number(j.fields?.mcpGen?.integerValue || 0);
}

// "Disconnect Claude": every connector token this account holds stops working.
export async function bumpMcpGen(uid: string): Promise<void> {
  const next = (await getMcpGen(uid)) + 1;
  const token = await accessToken();
  const r = await fetch(`${DOC}/${uid}?updateMask.fieldPaths=mcpGen`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { mcpGen: { integerValue: String(next) } } }),
  });
  if (!r.ok) throw new Error(`disconnect failed: ${r.status}`);
}

// Spend a sign-in code: true the first time, false if it was already used. Creating the marker doc
// fails with 409 when it exists, so two exchanges of one code can't both succeed.
export async function markCodeUsed(id: string): Promise<boolean> {
  const token = await accessToken();
  const r = await fetch(`${FS_DB}/oauthCodes?documentId=${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { at: { integerValue: String(Date.now()) } } }),
  });
  if (r.status === 409) return false;
  if (!r.ok) throw new Error(`code record failed: ${r.status}`);
  return true;
}

// ---- History (users/{uid}/chats), for the connector: Claude's Research answers are saved there like
// the website's, and Claude can list and reopen the account's past questions. Firestore REST speaks
// typed values, so plain objects are converted both ways.

type FsValue = Record<string, unknown>;

function toFs(v: unknown): FsValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  if (typeof v === "object") {
    const fields: Record<string, FsValue> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) fields[k] = toFs(x);
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

function fromFs(v: FsValue): unknown {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (((v.arrayValue as { values?: FsValue[] }) || {}).values || []).map(fromFs);
  if ("mapValue" in v) return fromFields(((v.mapValue as { fields?: Record<string, FsValue> }) || {}).fields);
  return null;
}

const fromFields = (f?: Record<string, FsValue>) =>
  Object.fromEntries(Object.entries(f || {}).map(([k, x]) => [k, fromFs(x)])) as Record<string, unknown>;

// Save one answered question to the account's history (as the website does after an answer).
export async function saveHistory(uid: string, item: Record<string, unknown>): Promise<void> {
  const token = await accessToken();
  const fields = (toFs({ ...item, createdAt: new Date() }).mapValue as { fields: Record<string, FsValue> }).fields;
  const r = await fetch(`${DOC}/${uid}/chats`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) throw new Error(`history save failed: ${r.status}`);
}

export type HistoryItem = { id: string; q: string; kind: string; createdAt: string; style: string; via: string };

// The account's most recent saved questions, newest first (just their headings).
export async function listHistory(uid: string, n = 25): Promise<HistoryItem[]> {
  const token = await accessToken();
  const mask = ["q", "kind", "createdAt", "style", "via"].map((f) => `mask.fieldPaths=${f}`).join("&");
  const r = await fetch(`${DOC}/${uid}/chats?pageSize=${n}&orderBy=${encodeURIComponent("createdAt desc")}&${mask}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`history list failed: ${r.status}`);
  const j = (await r.json()) as { documents?: { name: string; fields?: Record<string, FsValue> }[] };
  return (j.documents || []).map((d) => {
    const f = fromFields(d.fields);
    return {
      id: d.name.split("/").pop() || "",
      q: String(f.q || ""),
      kind: f.kind === "chat" ? "chat" : "research",
      createdAt: String(f.createdAt || ""),
      style: String(f.style || ""),
      via: String(f.via || ""),
    };
  });
}

// One saved question in full, or null if there's no such item in this account's history.
export async function getHistory(uid: string, id: string): Promise<Record<string, unknown> | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const token = await accessToken();
  const r = await fetch(`${DOC}/${uid}/chats/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`history read failed: ${r.status}`);
  const j = (await r.json()) as { fields?: Record<string, FsValue> };
  return fromFields(j.fields);
}

// Whether the account still exists and isn't disabled (checked when Claude renews its access).
export async function accountActive(uid: string): Promise<boolean> {
  const token = await accessToken(SCOPE_ADMIN);
  const r = await fetch(`${IDTK}/accounts:lookup`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ localId: [uid] }),
  });
  if (!r.ok) throw new Error(`account lookup failed: ${r.status}`);
  const j = (await r.json()) as { users?: { disabled?: boolean }[] };
  return !!j.users?.length && !j.users[0].disabled;
}

// ---- Admin -----------------------------------------------------------------

// Verify the ID token and also say whether the account is an admin (by the ADMIN_EMAILS env, or a
// future `admin` custom claim). Returns null if the token is invalid.
export async function verifyIdToken(
  authHeader: string | null
): Promise<{ uid: string; email: string; admin: boolean; anon: boolean } | null> {
  const m = (authHeader || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    const { payload } = await jwtVerify(m[1], JWKS, {
      issuer: `https://securetoken.google.com/${PROJECT_ID}`,
      audience: PROJECT_ID,
    });
    const uid = (payload.sub as string) || "";
    const email = ((payload.email as string) || "").toLowerCase();
    const anon = (payload.firebase as { sign_in_provider?: string } | undefined)?.sign_in_provider === "anonymous";
    const admin = !anon && (payload.admin === true || (email !== "" && ADMIN_EMAILS.includes(email)));
    return uid ? { uid, email, admin, anon } : null;
  } catch {
    return null;
  }
}

const IDTK = `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}`;
const FS_DB = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// Every account (for the admin panel). Paged defensively.
export async function listUsers(): Promise<{ uid: string; email: string }[]> {
  const token = await accessToken(SCOPE_ADMIN);
  const out: { uid: string; email: string }[] = [];
  let pageToken = "";
  for (let i = 0; i < 25; i++) {
    const url = `${IDTK}/accounts:batchGet?maxResults=200${pageToken ? `&nextPageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`list users failed: ${r.status}`);
    const j = (await r.json()) as { users?: { localId: string; email?: string }[]; nextPageToken?: string };
    for (const u of j.users || []) out.push({ uid: u.localId, email: u.email || "" });
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return out;
}

type UserMeta = { cap: number | null; count: number; day: string | null; show: string[] };

const strArray = (v?: { arrayValue?: { values?: { stringValue?: string }[] } }) =>
  (v?.arrayValue?.values || []).map((x) => x.stringValue || "").filter(Boolean);

// Per-user cap, today's usage, and per-account shown channels, read in one batch.
export async function readUserMeta(uids: string[]): Promise<Record<string, UserMeta>> {
  const out: Record<string, UserMeta> = {};
  if (uids.length === 0) return out;
  const token = await accessToken();
  const base = `projects/${PROJECT_ID}/databases/(default)/documents/users/`;
  const r = await fetch(`${FS_DB}:batchGet`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ documents: uids.map((u) => base + u) }),
  });
  if (!r.ok) throw new Error(`batchGet failed: ${r.status}`);
  const arr = (await r.json()) as {
    found?: {
      name: string;
      fields?: Record<string, { stringValue?: string; integerValue?: string; arrayValue?: { values?: { stringValue?: string }[] } }>;
    };
  }[];
  for (const row of arr) {
    if (!row.found) continue;
    const uid = row.found.name.split("/").pop() || "";
    const f = row.found.fields || {};
    out[uid] = {
      cap: f.cap?.integerValue != null ? Number(f.cap.integerValue) : null,
      count: Number(f.count?.integerValue || 0),
      day: f.day?.stringValue ?? null,
      show: strArray(f.showChannels),
    };
  }
  return out;
}

// Channels shown to one account even when globally hidden (admin-granted exceptions).
export async function getUserShowChannels(uid: string): Promise<string[]> {
  const token = await accessToken();
  const r = await fetch(`${FS_DB}/users/${uid}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`user read failed: ${r.status}`);
  const j = (await r.json()) as { fields?: { showChannels?: { arrayValue?: { values?: { stringValue?: string }[] } } } };
  return strArray(j.fields?.showChannels);
}

export async function setUserShowChannels(uid: string, slugs: string[]): Promise<void> {
  const token = await accessToken();
  const values = slugs.map((s) => ({ stringValue: s }));
  const r = await fetch(`${FS_DB}/users/${uid}?updateMask.fieldPaths=showChannels`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { showChannels: { arrayValue: { values } } } }),
  });
  if (!r.ok) throw new Error(`set show channels failed: ${r.status}`);
}

// Set (or clear, with null) a per-account daily cap. Clearing falls back to the global default.
export async function setUserCap(uid: string, cap: number | null): Promise<void> {
  const token = await accessToken();
  const body =
    cap != null && cap > 0
      ? { fields: { cap: { integerValue: String(Math.floor(cap)) } } }
      : { fields: {} }; // empty + the mask below removes the field
  const r = await fetch(`${FS_DB}/users/${uid}?updateMask.fieldPaths=cap`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`set cap failed: ${r.status}`);
}

// Channels hidden from non-admin accounts, stored as one list on config/visibility.
const VIS_DOC = `${FS_DB}/config/visibility`;

export async function getHiddenChannels(): Promise<string[]> {
  const token = await accessToken();
  const r = await fetch(VIS_DOC, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`visibility read failed: ${r.status}`);
  const j = (await r.json()) as { fields?: { hidden?: { arrayValue?: { values?: { stringValue?: string }[] } } } };
  return (j.fields?.hidden?.arrayValue?.values || []).map((v) => v.stringValue || "").filter(Boolean);
}

export async function setHiddenChannels(slugs: string[]): Promise<void> {
  const token = await accessToken();
  const values = slugs.map((s) => ({ stringValue: s }));
  const r = await fetch(`${VIS_DOC}?updateMask.fieldPaths=hidden`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { hidden: { arrayValue: { values } } } }),
  });
  if (!r.ok) throw new Error(`visibility write failed: ${r.status}`);
}

// Admin-set display names per channel, English and/or Arabic, overriding the terminal-set name.
// Stored as one map on config/channelNames ({ names: { <slug>: { en, ar } } }); the brain's own name
// stays the fallback. Only non-empty names are kept.
export type ChannelNameOverrides = Record<string, { en?: string; ar?: string }>;
const NAMES_DOC = `${FS_DB}/config/channelNames`;

export async function getChannelNames(): Promise<ChannelNameOverrides> {
  const token = await accessToken();
  const r = await fetch(NAMES_DOC, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return {};
  if (!r.ok) throw new Error(`channel names read failed: ${r.status}`);
  const j = (await r.json()) as {
    fields?: { names?: { mapValue?: { fields?: Record<string, { mapValue?: { fields?: Record<string, { stringValue?: string }> } }> } } };
  };
  const out: ChannelNameOverrides = {};
  for (const [slug, v] of Object.entries(j.fields?.names?.mapValue?.fields || {})) {
    const f = v.mapValue?.fields || {};
    const en = f.en?.stringValue?.trim();
    const ar = f.ar?.stringValue?.trim();
    if (en || ar) out[slug] = { ...(en ? { en } : {}), ...(ar ? { ar } : {}) };
  }
  return out;
}

export async function setChannelNames(names: ChannelNameOverrides): Promise<void> {
  const token = await accessToken();
  const fields: Record<string, { mapValue: { fields: Record<string, { stringValue: string }> } }> = {};
  for (const [slug, v] of Object.entries(names)) {
    const inner: Record<string, { stringValue: string }> = {};
    if (v.en && v.en.trim()) inner.en = { stringValue: v.en.trim() };
    if (v.ar && v.ar.trim()) inner.ar = { stringValue: v.ar.trim() };
    if (Object.keys(inner).length) fields[slug] = { mapValue: { fields: inner } };
  }
  const r = await fetch(`${NAMES_DOC}?updateMask.fieldPaths=names`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { names: { mapValue: { fields } } } }),
  });
  if (!r.ok) throw new Error(`channel names write failed: ${r.status}`);
}

// Site-wide default daily answer cap for real (non-guest) accounts, admin-editable, stored on
// config/limits. Falls back to the DAILY_CAP env default when unset. Cached briefly so it isn't read
// from Firestore on every question.
const LIMITS_DOC = `${FS_DB}/config/limits`;
let capCache: { val: number; exp: number } | null = null;

export async function getDefaultCap(): Promise<number> {
  if (capCache && capCache.exp > Date.now()) return capCache.val;
  let val = DAILY_CAP;
  try {
    const token = await accessToken();
    const r = await fetch(LIMITS_DOC, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) {
      const j = (await r.json()) as { fields?: { dailyCap?: { integerValue?: string } } };
      const n = Number(j.fields?.dailyCap?.integerValue);
      if (Number.isFinite(n) && n > 0) val = n;
    }
  } catch {
    val = DAILY_CAP; // fail safe to the env default on any read error
  }
  capCache = { val, exp: Date.now() + 60_000 };
  return val;
}

export async function setDefaultCap(cap: number): Promise<void> {
  const token = await accessToken();
  const r = await fetch(`${LIMITS_DOC}?updateMask.fieldPaths=dailyCap`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { dailyCap: { integerValue: String(Math.floor(cap)) } } }),
  });
  if (!r.ok) throw new Error(`limits write failed: ${r.status}`);
  capCache = { val: Math.floor(cap), exp: Date.now() + 60_000 };
}
