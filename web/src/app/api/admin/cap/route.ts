import { NextRequest, NextResponse } from "next/server";
import { verifyIdToken, setUserCap } from "../../../../lib/firebase-admin";

// Admin only: set (or clear, with cap: null) another account's per-day answer limit.
export async function POST(req: NextRequest) {
  const a = await verifyIdToken(req.headers.get("authorization"));
  if (!a) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  if (!a.admin) return NextResponse.json({ error: "Admins only." }, { status: 403 });

  let body: { uid?: string; cap?: number | null } = {};
  try {
    body = await req.json();
  } catch {
    /* ignore */
  }
  const uid = String(body?.uid ?? "").trim();
  if (!uid) return NextResponse.json({ error: "Missing account." }, { status: 400 });

  const cap = body?.cap === null || body?.cap === undefined ? null : Number(body.cap);
  if (cap !== null && (!Number.isFinite(cap) || cap < 0 || cap > 100000)) {
    return NextResponse.json({ error: "Cap must be between 0 and 100000, or blank to reset." }, { status: 400 });
  }

  try {
    await setUserCap(uid, cap);
    return NextResponse.json({ ok: true, cap });
  } catch {
    return NextResponse.json({ error: "Could not update the limit." }, { status: 503 });
  }
}
