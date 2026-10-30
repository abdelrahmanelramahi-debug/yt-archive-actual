import { NextRequest, NextResponse } from "next/server";
import { verifyIdToken, listUsers, readUserMeta, getHiddenChannels, getDefaultCap } from "../../../../lib/firebase-admin";
import { brainChannelList } from "../../../../lib/channels";

// Admin only: every account with its effective daily cap, today's usage, and any per-account channel
// exceptions — plus the globally-hidden channels (with names) those exceptions apply to.
export async function GET(req: NextRequest) {
  const auth = await verifyIdToken(req.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  if (!auth.admin) return NextResponse.json({ error: "Admins only." }, { status: 403 });

  try {
    const [users, hidden, defaultCap] = await Promise.all([listUsers(), getHiddenChannels(), getDefaultCap()]);
    const meta = await readUserMeta(users.map((u) => u.uid));

    let hiddenChannels: { slug: string; name: string }[] = [];
    if (hidden.length) {
      const names = new Map((await brainChannelList()).map((c) => [c.slug, c.name]));
      hiddenChannels = hidden.map((s) => ({ slug: s, name: names.get(s) || s }));
    }

    const today = new Date().toISOString().slice(0, 10);
    const rows = users
      .map((u) => {
        const m = meta[u.uid];
        return {
          uid: u.uid,
          email: u.email,
          cap: m?.cap ?? null, // null = using the default
          usedToday: m && m.day === today ? m.count : 0,
          show: m?.show ?? [], // globally-hidden channels unhidden just for this account
        };
      })
      .sort((x, y) => (x.email || "").localeCompare(y.email || ""));

    return NextResponse.json({ users: rows, defaultCap, hiddenChannels });
  } catch {
    return NextResponse.json({ error: "Could not load accounts." }, { status: 503 });
  }
}
