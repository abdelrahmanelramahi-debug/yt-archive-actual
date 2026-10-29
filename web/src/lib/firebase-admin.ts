// Server-side auth + daily cap — WITHOUT firebase-admin (its grpc/native deps don't package
// cleanly into Vercel functions). We verify Firebase ID tokens with `jose` against Google's public
// keys, and read/write the per-user usage doc through the Firestore REST API with a service-account
// access token. Needs: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.
import { jwtVerify, createRemoteJWKSet, importPKCS8, SignJWT } from "jose";

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "latafti";
export const DAILY_CAP = Number(process.env.DAILY_CAP || 20);

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

// A Google OAuth access token (datastore scope) minted from the service account, cached ~1h.
let cached: { token: string; exp: number } | null = null;
async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const pem = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !pem) throw new Error("service-account env vars missing");
  const key = await importPKCS8(pem, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/datastore" })
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
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return j.access_token;
}

const DOC = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users`;

// Reserve one of today's answers for this user. Returns how many remain, or -1 if over the cap.
// A read-then-write (no transaction): the tiny concurrency window can let a user get one extra,
// which is fine for a soft daily cap. The day resets at UTC midnight.
export async function consumeDaily(uid: string): Promise<number> {
  const token = await accessToken();
  const auth = { Authorization: `Bearer ${token}` };
  const today = new Date().toISOString().slice(0, 10);

  const get = await fetch(`${DOC}/${uid}`, { headers: auth });
  let count = 0;
  if (get.ok) {
    const f = ((await get.json()) as { fields?: Record<string, { stringValue?: string; integerValue?: string }> }).fields || {};
    if (f.day?.stringValue === today) count = Number(f.count?.integerValue || 0);
  } else if (get.status !== 404) {
    throw new Error(`firestore read failed: ${get.status}`);
  }
  if (count >= DAILY_CAP) return -1;

  const next = count + 1;
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
  return DAILY_CAP - next;
}
