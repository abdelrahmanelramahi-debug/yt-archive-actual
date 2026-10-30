// Server-side auth + daily cap — WITHOUT firebase-admin (its grpc/native deps don't package
// cleanly into Vercel functions). We verify Firebase ID tokens with `jose` against Google's public
// keys, and read/write the per-user usage doc through the Firestore REST API with a service-account
// access token. Needs: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.
import { jwtVerify, createRemoteJWKSet, importPKCS8, SignJWT } from "jose";

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "latafti";
export const DAILY_CAP = Number(process.env.DAILY_CAP || 20);
export const GUEST_CAP = Number(process.env.GUEST_CAP || 2); // free questions before guests must sign up

// Bootstrap admins by email (comma-separated), set in the environment. Anyone signed in with one
// of these emails is treated as an admin — no custom-claim plumbing needed to get started.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const SCOPE_DATASTORE = "https://www.googleapis.com/auth/datastore";
const SCOPE_ADMIN = "https://www.googleapis.com/auth/cloud-platform"; // Firestore + Identity Toolkit

// Firebase ID tokens are RS256 JWTs signed by Google's securetoken service.
const JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")
);

// Verify the Firebase ID token from the Authorization header; returns the uid, or null if invalid.
export async function uidFromAuthHeader(authHeader: string | null): Promise<string | null> {
  const m = (authHeader || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    const { payload } = await jwtVerify(m[1], JWKS, {
      issuer: `https://securetoken.google.com/${PROJECT_ID}`,
      audience: PROJECT_ID,
    });
    return (payload.sub as string) || null;
  } catch {
    return null;
  }
}

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
  const token = await accessToken();
  const auth = { Authorization: `Bearer ${token}` };
  const today = new Date().toISOString().slice(0, 10);

  const get = await fetch(`${DOC}/${uid}`, { headers: auth });
  let count = 0;
  let cap = guest ? GUEST_CAP : DAILY_CAP;
  if (get.ok) {
    const f = ((await get.json()) as { fields?: Record<string, { stringValue?: string; integerValue?: string }> }).fields || {};
    if (f.day?.stringValue === today) count = Number(f.count?.integerValue || 0);
    if (!guest) {
      const c = Number(f.cap?.integerValue);
      if (Number.isFinite(c) && c > 0) cap = c; // admin-set per-account override (real accounts only)
    }
  } else if (get.status !== 404) {
    throw new Error(`firestore read failed: ${get.status}`);
  }
  if (count >= cap) return { remaining: -1, cap };

  const next = count + 1;
  // The update mask covers only day/count/updatedAt, so an admin-set `cap` is preserved untouched.
  const patch = await fetch(
    `${DOC}/${uid}?updateMask.fieldPaths=day&updateMask.fieldPaths=count&updateMask.fieldPaths=updatedAt`,
    {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          day: { stringValue: today },
          count: { integerValue: String(next) },
          updatedAt: { integerValue: String(Date.now()) },
        },
      }),
    }
  );
  if (!patch.ok) throw new Error(`firestore write failed: ${patch.status}`);
  return { remaining: cap - next, cap };
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
