import { NextRequest, NextResponse } from "next/server";
import { verifyIdToken, getHiddenChannels, setHiddenChannels } from "../../../../lib/firebase-admin";
import { brainChannelList } from "../../../../lib/channels";

// Admin only: read/write which channels are hidden from non-admin accounts (globally).
export async function GET(req: NextRequest) {
  const auth = await verifyIdToken(req.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  if (!auth.admin) return NextResponse.json({ error: "Admins only." }, { status: 403 });
  try {
    const [channels, hidden] = await Promise.all([brainChannelList(), getHiddenChannels()]);
    return NextResponse.json({ channels, hidden });
  } catch {
    return NextResponse.json({ error: "Could not load channels." }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await verifyIdToken(req.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  if (!auth.admin) return NextResponse.json({ error: "Admins only." }, { status: 403 });

  let body: { hidden?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* ignore */
  }
  const requested = Array.isArray(body?.hidden) ? body.hidden.map((s) => String(s)) : null;
  if (!requested) return NextResponse.json({ error: "Expected a hidden list." }, { status: 400 });

  try {
    // keep only slugs that actually exist, so a stale UI can't persist junk
    const valid = new Set((await brainChannelList()).map((c) => c.slug));
    const hidden = [...new Set(requested.filter((s) => valid.has(s)))];
    await setHiddenChannels(hidden);
    return NextResponse.json({ ok: true, hidden });
  } catch {
    return NextResponse.json({ error: "Could not save channel visibility." }, { status: 503 });
  }
}
