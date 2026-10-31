import { NextRequest, NextResponse } from "next/server";
import { verifyIdToken } from "../../../../lib/firebase-admin";

// Reconnects the page to an answer that is still being written (or just finished) on the brain —
// after a phone switched apps mid-answer, or the page was reloaded. Replays its events from `after`
// on as Server-Sent Events. No new answer, so no daily allowance is used.

const BRAIN_URL = process.env.BRAIN_URL || "http://127.0.0.1:8000";
const BRAIN_KEY = process.env.BRAIN_KEY || "";

export async function GET(req: NextRequest) {
  const auth = await verifyIdToken(req.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id") || "";
  const after = Math.max(0, Number(req.nextUrl.searchParams.get("after")) || 0);
  if (!/^[0-9a-f]{8,64}$/.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const r = await fetch(`${BRAIN_URL}/ask/job?id=${id}&after=${after}`, {
      headers: { ...(BRAIN_KEY ? { "X-Brain-Key": BRAIN_KEY } : {}), "X-User-Id": auth.uid },
    });
    if (!r.ok || !r.body) {
      const data = await r.json().catch(() => ({}));
      return NextResponse.json(data, { status: r.status || 502 });
    }
    return new Response(r.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "Could not reach the search service. (" + msg + ")" }, { status: 502 });
  }
}
