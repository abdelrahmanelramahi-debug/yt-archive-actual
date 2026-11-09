import { NextRequest, NextResponse } from "next/server";
import { verifyIdToken } from "../../../lib/firebase-admin";
import { allowedChannels } from "../../../lib/channels";

// Server-side only: fetch one source video's full transcript from the brain for the download button.
// Any signed-in visitor (guests included) may download; the brain reads only its stored captions.
const BRAIN_URL = process.env.BRAIN_URL || "http://127.0.0.1:8000";
const BRAIN_KEY = process.env.BRAIN_KEY || "";

export async function GET(req: NextRequest) {
  const auth = await verifyIdToken(req.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "Please sign in." }, { status: 401 });

  const videoId = req.nextUrl.searchParams.get("video_id") || "";
  const slug = req.nextUrl.searchParams.get("slug") || "";
  if (!videoId) return NextResponse.json({ error: "Missing video." }, { status: 400 });

  const qs = new URLSearchParams({ video_id: videoId });
  if (slug) qs.set("slug", slug);
  // hidden channels stay hidden here too: the brain returns nothing for a video outside this account's channels
  try {
    const a = await allowedChannels(!!auth.admin, undefined, auth.uid);
    if (a.blocked) return NextResponse.json({ video_id: videoId, lines: [] });
    if (a.channels) qs.set("channels", a.channels.join(","));
  } catch {
    return NextResponse.json({ error: "Could not load transcript." }, { status: 503 });
  }
  try {
    const r = await fetch(`${BRAIN_URL}/transcript?${qs}`, {
      headers: { ...(BRAIN_KEY ? { "X-Brain-Key": BRAIN_KEY } : {}) },
      cache: "no-store",
    });
    const data = await r.json().catch(() => ({ lines: [] }));
    return NextResponse.json(data, { status: r.status });
  } catch {
    return NextResponse.json({ error: "Could not load transcript." }, { status: 502 });
  }
}
