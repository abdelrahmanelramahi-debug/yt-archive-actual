import { NextRequest, NextResponse } from "next/server";
import { verifyIdToken, getHiddenChannels, setUserShowChannels } from "../../../../lib/firebase-admin";

// Admin only: for one account, set which globally-hidden channels are shown to them anyway.
export async function POST(req: NextRequest) {
  const auth = await verifyIdToken(req.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  if (!auth.admin) return NextResponse.json({ error: "Admins only." }, { status: 403 });

  let body: { uid?: string; show?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* ignore */
  }
  const uid = String(body?.uid ?? "").trim();
  if (!uid) return NextResponse.json({ error: "Missing account." }, { status: 400 });
  const requested = Array.isArray(body?.show) ? body.show.map((s) => String(s)) : null;
  if (!requested) return NextResponse.json({ error: "Expected a show list." }, { status: 400 });

  try {
    // an exception only means something for a channel that's actually hidden — drop anything else
    const hidden = new Set(await getHiddenChannels());
    const show = [...new Set(requested.filter((s) => hidden.has(s)))];
    await setUserShowChannels(uid, show);
    return NextResponse.json({ ok: true, show });
  } catch {
    return NextResponse.json({ error: "Could not update channel access." }, { status: 503 });
  }
}
