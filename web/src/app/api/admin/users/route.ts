import { NextRequest, NextResponse } from "next/server";
import { verifyIdToken, listUsers, readUserMeta, DAILY_CAP } from "../../../../lib/firebase-admin";

// Admin only: every account with its effective daily cap and today's usage, for the admin panel.
export async function GET(req: NextRequest) {
  const a = await verifyIdToken(req.headers.get("authorization"));
  if (!a) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  if (!a.admin) return NextResponse.json({ error: "Admins only." }, { status: 403 });

  try {
    const users = await listUsers();
    const meta = await readUserMeta(users.map((u) => u.uid));
    const today = new Date().toISOString().slice(0, 10);
    const rows = users
      .map((u) => {
        const m = meta[u.uid];
        return {
          uid: u.uid,
          email: u.email,
          cap: m?.cap ?? null, // null = using the default
          usedToday: m && m.day === today ? m.count : 0,
        };
      })
      .sort((x, y) => (x.email || "").localeCompare(y.email || ""));
    return NextResponse.json({ users: rows, defaultCap: DAILY_CAP });
  } catch {
    return NextResponse.json({ error: "Could not load accounts." }, { status: 503 });
  }
}
