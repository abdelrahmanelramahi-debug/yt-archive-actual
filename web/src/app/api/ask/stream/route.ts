import { NextRequest, NextResponse } from "next/server";
import { verifyIdToken, consumeDaily } from "../../../../lib/firebase-admin";
import { allowedChannels } from "../../../../lib/channels";

// Streams the brain's Server-Sent Events straight through to the browser. Runs server-side only,
// so the brain URL + key never reach the client. The page falls back to /api/ask on any failure.
// (A POST handler is always dynamic, so no route-segment config is needed — and this Next build
// rejects `runtime`/`dynamic` exports under cacheComponents.)

const BRAIN_URL = process.env.BRAIN_URL || "http://127.0.0.1:8000";
const BRAIN_KEY = process.env.BRAIN_KEY || "";

export async function POST(req: NextRequest) {
  // only signed-in users, within their daily allowance (same rule as /api/ask)
  const auth = await verifyIdToken(req.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "Please sign in to ask." }, { status: 401 });
  const uid = auth.uid;

  let body: { question?: string; channels?: string[]; mode?: string; style?: string } = {};
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
  const style = typeof body?.style === "string" ? body.style : undefined;

  // reserve one of today's free answers before spending on Claude (cap is per-account)
  try {
    const res = await consumeDaily(uid, auth.anon);
    if (res.remaining < 0) {
      if (auth.anon) {
        return NextResponse.json(
          { error: `You've used your ${res.cap} free questions. Sign in or create an account to keep going.`, guest: true },
          { status: 429 }
        );
      }
      return NextResponse.json(
        { error: `You've used your ${res.cap} free answers for today. They reset at midnight (UTC).` },
        { status: 429 }
      );
    }
  } catch {
    return NextResponse.json({ error: "Could not check your daily limit — try again." }, { status: 503 });
  }

  // restrict to the channels this account may search (admins are unrestricted)
  let effectiveChannels: string[] | undefined;
  try {
    const allow = await allowedChannels(auth.admin, channels, auth.uid);
    if (allow.blocked) {
      // nothing left to search once hidden channels are removed — end the stream as "empty"
      return new Response(`event: empty\ndata: {}\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
      });
    }
    effectiveChannels = allow.channels;
  } catch {
    return NextResponse.json({ error: "Could not check channel access — try again." }, { status: 503 });
  }

  const clientIp = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  try {
    const r = await fetch(`${BRAIN_URL}/ask/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(BRAIN_KEY ? { "X-Brain-Key": BRAIN_KEY } : {}),
        ...(clientIp ? { "X-Client-IP": clientIp } : {}),
      },
      body: JSON.stringify({ question, channels: effectiveChannels, mode, style }),
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
