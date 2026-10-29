import { NextRequest, NextResponse } from "next/server";

// Runs server-side only: the brain URL and key never reach the browser.
export const runtime = "nodejs";
export const maxDuration = 60;

const BRAIN_URL = process.env.BRAIN_URL || "http://127.0.0.1:8000";
const BRAIN_KEY = process.env.BRAIN_KEY || "";

export async function POST(req: NextRequest) {
  let question = "";
  try {
    question = (await req.json())?.question ?? "";
  } catch {
    /* ignore bad body */
  }
  question = String(question).trim();
  if (!question) {
    return NextResponse.json({ error: "Please type a question." }, { status: 400 });
  }
  try {
    const r = await fetch(`${BRAIN_URL}/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(BRAIN_KEY ? { "X-Brain-Key": BRAIN_KEY } : {}),
      },
      body: JSON.stringify({ question }),
    });
    const data = await r.json().catch(() => ({ error: "The brain returned an unexpected response." }));
    return NextResponse.json(data, { status: r.status });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "Could not reach the search service. Is it running? (" + msg + ")" },
      { status: 502 }
    );
  }
}
