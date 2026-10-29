import { initializeApp, getApps, cert, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

// Server side: verifies who's asking and enforces the per-user daily cap. Needs a service-account
// key in the environment: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.
let app: App | null = null;
function admin(): App {
  if (app) return app;
  if (getApps().length) return (app = getApps()[0]);
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"); // Vercel stores the newlines escaped
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("firebase-admin is not configured (service-account env vars missing)");
  }
  return (app = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) }));
}

export const DAILY_CAP = Number(process.env.DAILY_CAP || 20);

// Verify the Firebase ID token from the Authorization header. Returns the uid, or null if missing/invalid.
export async function uidFromAuthHeader(authHeader: string | null): Promise<string | null> {
  const m = (authHeader || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    return (await getAuth(admin()).verifyIdToken(m[1])).uid;
  } catch {
    return null;
  }
}

// Reserve one of today's answers for this user, atomically. Returns how many remain after this one,
// or -1 if they're already at the cap. The day resets at UTC midnight.
export async function consumeDaily(uid: string): Promise<number> {
  const db = getFirestore(admin());
  const ref = db.collection("users").doc(uid);
  const today = new Date().toISOString().slice(0, 10);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.exists ? (snap.data() as { day?: string; count?: number }) : {};
    const count = d.day === today ? d.count ?? 0 : 0;
    if (count >= DAILY_CAP) return -1;
    tx.set(ref, { day: today, count: count + 1, updatedAt: Date.now() }, { merge: true });
    return DAILY_CAP - (count + 1);
  });
}
