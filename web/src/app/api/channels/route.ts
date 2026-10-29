import { NextResponse } from "next/server";

// Server-side only: fetch the channel list + depth modes from the brain for the pickers.
const BRAIN_URL = process.env.BRAIN_URL || "http://127.0.0.1:8000";
const BRAIN_KEY = process.env.BRAIN_KEY || "";

export async function GET() {
  try {
    const r = await fetch(`${BRAIN_URL}/channels`, {
      headers: { ...(BRAIN_KEY ? { "X-Brain-Key": BRAIN_KEY } : {}) },
      cache: "no-store",
    });
    const data = await r.json().catch(() => ({ channels: [], modes: [] }));
    return NextResponse.json(data, { status: r.status });
  } catch {
    return NextResponse.json({ channels: [], modes: [] }, { status: 502 });
  }
}
