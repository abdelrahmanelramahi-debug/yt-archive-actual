import { NextRequest, NextResponse } from "next/server";
import { verifyIdToken } from "../../../lib/firebase-admin";

// Server-side only: fetch the text of an answer's relevant moments (cited or not) from the brain, for
// the "download all relevant moments" button. Stored captions only, so no spend and no daily allowance.
const BRAIN_URL = process.env.BRAIN_URL || "http://127.0.0.1:8000";
const BRAIN_KEY = process.env.BRAIN_KEY || "";
const MAX_REFS = 5000;

export async function POST(req: NextRequest) {
  const auth = await verifyIdToken(req.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "Please sign in." }, { status: 401 });

  let body: { refs?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* ignore bad body */
  }
  // only well-formed {c, s} string pairs go to the brain
  const refs = (Array.isArray(body?.refs) ? body.refs : [])
    .filter(
      (r): r is { c: string; s: string } =>
        !!r && typeof (r as { c?: unknown }).c === "string" && typeof (r as { s?: unknown }).s === "string",
    )
    .slice(0, MAX_REFS)
    .map((r) => ({ c: r.c.slice(0, 200), s: r.s.slice(0, 200) }));
  if (!refs.length) return NextResponse.json({ moments: [] });

  try {
    const r = await fetch(`${BRAIN_URL}/moments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(BRAIN_KEY ? { "X-Brain-Key": BRAIN_KEY } : {}) },
      body: JSON.stringify({ refs }),
      cache: "no-store",
    });
    const data = await r.json().catch(() => ({ moments: [] }));
    return NextResponse.json(data, { status: r.status });
  } catch {
    return NextResponse.json({ error: "Could not load the moments." }, { status: 502 });
  }
}
