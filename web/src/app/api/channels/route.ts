import { NextRequest, NextResponse } from "next/server";
import { verifyIdToken } from "../../../lib/firebase-admin";
import { effectiveHidden, channelNameOverrides } from "../../../lib/channels";

// Server-side only: fetch the channel list + depth modes from the brain for the pickers.
// Non-admins don't see channels an admin has hidden (actual access is enforced in /api/ask too).
const BRAIN_URL = process.env.BRAIN_URL || "http://127.0.0.1:8000";
const BRAIN_KEY = process.env.BRAIN_KEY || "";

export async function GET(req: NextRequest) {
  const auth = await verifyIdToken(req.headers.get("authorization"));
  try {
    const r = await fetch(`${BRAIN_URL}/channels`, {
      headers: { ...(BRAIN_KEY ? { "X-Brain-Key": BRAIN_KEY } : {}) },
      cache: "no-store",
    });
    const data = await r.json().catch(() => ({ channels: [], modes: [] }));
    if (!auth?.admin && data && Array.isArray(data.channels)) {
      // Fail open here (the picker only lists names); real content access is gated in /api/ask.
      try {
        const hidden = await effectiveHidden(auth?.uid ?? null);
        if (hidden.size) data.channels = data.channels.filter((c: { slug: string }) => !hidden.has(c.slug));
      } catch {
        /* leave the list as-is on a transient visibility read error */
      }
    }
    // attach admin name overrides so the picker can show each channel in the viewer's language
    if (data && Array.isArray(data.channels)) {
      const names = await channelNameOverrides();
      if (Object.keys(names).length) {
        data.channels = data.channels.map((c: { slug: string }) => {
          const o = names[c.slug];
          return o ? { ...c, en: o.en, ar: o.ar } : c;
        });
      }
    }
    return NextResponse.json(data, { status: r.status });
  } catch {
    return NextResponse.json({ channels: [], modes: [] }, { status: 502 });
  }
}
