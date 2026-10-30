import { NextRequest, NextResponse } from "next/server";
import { verifyIdToken, consumeDaily } from "../../../lib/firebase-admin";
import { allowedChannels } from "../../../lib/channels";

// Runs server-side only (Node runtime by default): the brain URL and key never reach the browser.
const BRAIN_URL = process.env.BRAIN_URL || "http://127.0.0.1:8000";
const BRAIN_KEY = process.env.BRAIN_KEY || "";

export async function POST(req: NextRequest) {
  // only signed-in users may ask (it spends real money), and only within their daily allowance
  const auth = await verifyIdToken(req.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "Please sign in to ask." }, { status: 401 });
  const uid = auth.uid;

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

  // reserve one of today's free answers before spending on Claude (cap is per-account)
  let remaining: number;
  try {
    const res = await consumeDaily(uid);
    remaining = res.remaining;
    if (res.remaining < 0) {
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
    const allow = await allowedChannels(auth.admin, channels);
    if (allow.blocked) {
      return NextResponse.json(
        { q: question, empty: true, answer: null, sources: [], coverage: { moments: 0, videos: 0, channels: 0 }, remaining },
        { status: 200 }
      );
    }
    effectiveChannels = allow.channels;
  } catch {
    return NextResponse.json({ error: "Could not check channel access — try again." }, { status: 503 });
  }

  const clientIp = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  try {
    const r = await fetch(`${BRAIN_URL}/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(BRAIN_KEY ? { "X-Brain-Key": BRAIN_KEY } : {}),
        ...(clientIp ? { "X-Client-IP": clientIp } : {}),
      },
      body: JSON.stringify({ question, channels: effectiveChannels, mode }),
    });
    const data = await r.json().catch(() => ({ error: "The brain returned an unexpected response." }));
    if (data && typeof data === "object") (data as { remaining?: number }).remaining = remaining;
    return NextResponse.json(data, { status: r.status });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "Could not reach the search service. (" + msg + ")" }, { status: 502 });
  }
}
