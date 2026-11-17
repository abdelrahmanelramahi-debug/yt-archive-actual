import { NextResponse, connection } from "next/server";

// Is the brain up? While it restarts for an update (a few minutes after each change goes live) it
// can't search, and the page shows an "updating" notice instead of failing questions.
const BRAIN_URL = process.env.BRAIN_URL || "http://127.0.0.1:8000";

export async function GET() {
  await connection(); // checked fresh on every request, never prerendered
  let up = false;
  try {
    const r = await fetch(`${BRAIN_URL}/health`, { cache: "no-store", signal: AbortSignal.timeout(6000) });
    up = r.ok && ((await r.json()) as { ready?: boolean }).ready === true;
  } catch {
    up = false;
  }
  return NextResponse.json({ up }, { headers: { "Cache-Control": "no-store" } });
}
