import { NextRequest, NextResponse } from "next/server";
import { verifyIdToken, setUserCap, setDefaultCap } from "../../../../lib/firebase-admin";

// Admin only: set the site-wide default daily limit ({ defaultCap }), or one account's limit
// ({ uid, cap }; cap: null clears it back to the default).
export async function POST(req: NextRequest) {
  const a = await verifyIdToken(req.headers.get("authorization"));
  if (!a) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  if (!a.admin) return NextResponse.json({ error: "Admins only." }, { status: 403 });

  let body: { uid?: string; cap?: number | null; defaultCap?: number } = {};
  try {
    body = await req.json();
  } catch {
    /* ignore */
  }

  // site-wide default for everyone (no uid)
  if (body?.defaultCap !== undefined) {
    const dc = Number(body.defaultCap);
    if (!Number.isFinite(dc) || dc < 1 || dc > 100000) {
      return NextResponse.json({ error: "Default must be between 1 and 100000." }, { status: 400 });
    }
    try {
      await setDefaultCap(dc);
      return NextResponse.json({ ok: true, defaultCap: Math.floor(dc) });
    } catch {
      return NextResponse.json({ error: "Could not update the default." }, { status: 503 });
    }
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
