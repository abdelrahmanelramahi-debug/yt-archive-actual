import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";

// Runs server-side only (Node runtime by default): the brain URL and key never reach the browser.
const BRAIN_URL = process.env.BRAIN_URL || "http://127.0.0.1:8000";
const BRAIN_KEY = process.env.BRAIN_KEY || "";
const ACCESS_CODE = process.env.ACCESS_CODE || "";
const gateToken = () => createHash("sha256").update(ACCESS_CODE).digest("hex");

export async function POST(req: NextRequest) {
  // invite gate: only visitors who entered the access code may ask (spends real money)
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

  // forward the real visitor IP so the brain's per-person limit works (all calls arrive from Vercel)
  const clientIp = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  try {
    const r = await fetch(`${BRAIN_URL}/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(BRAIN_KEY ? { "X-Brain-Key": BRAIN_KEY } : {}),
        ...(clientIp ? { "X-Client-IP": clientIp } : {}),
      },
      body: JSON.stringify({ question, channels, mode }),
    });
    const data = await r.json().catch(() => ({ error: "The brain returned an unexpected response." }));
    return NextResponse.json(data, { status: r.status });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "Could not reach the search service. (" + msg + ")" },
      { status: 502 }
    );
  }
}
