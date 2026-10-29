import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";

// Streams the brain's Server-Sent Events straight through to the browser. Runs server-side only,
// so the brain URL + key never reach the client. The page falls back to /api/ask on any failure.
// (A POST handler is always dynamic, so no route-segment config is needed — and this Next build
// rejects `runtime`/`dynamic` exports under cacheComponents.)

const BRAIN_URL = process.env.BRAIN_URL || "http://127.0.0.1:8000";
const BRAIN_KEY = process.env.BRAIN_KEY || "";
const ACCESS_CODE = process.env.ACCESS_CODE || "";
const gateToken = () => createHash("sha256").update(ACCESS_CODE).digest("hex");

export async function POST(req: NextRequest) {
  // same invite gate as /api/ask
  if (ACCESS_CODE) {
    const c = req.cookies.get("gate")?.value;
    if (!c || c !== gateToken()) {
      return NextResponse.json({ error: "Please enter your access code first." }, { status: 401 });
    }
  }

  let body: { question?: string; channels?: string[]; mode?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* ignore bad body */
  }
  const question = String(body?.question ?? "").trim();
  if (!question) {
    return NextResponse.json({ error: "Please type a question." }, { status: 400 });
  }
  const channels = Array.isArray(body?.channels) ? body.channels : undefined;
  const mode = typeof body?.mode === "string" ? body.mode : undefined;
  const clientIp = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();

  try {
    const r = await fetch(`${BRAIN_URL}/ask/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(BRAIN_KEY ? { "X-Brain-Key": BRAIN_KEY } : {}),
        ...(clientIp ? { "X-Client-IP": clientIp } : {}),
      },
      body: JSON.stringify({ question, channels, mode }),
    });
    if (!r.ok || !r.body) {
      const data = await r.json().catch(() => ({ error: "The brain returned an unexpected response." }));
      return NextResponse.json(data, { status: r.status || 502 });
    }
    // pass the SSE body through unbuffered
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
    return NextResponse.json(
      { error: "Could not reach the search service. (" + msg + ")" },
      { status: 502 }
    );
  }
}
