import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";

// Invite gate. Set ACCESS_CODE in the environment to turn it on; unset = open (local dev).
const ACCESS_CODE = process.env.ACCESS_CODE || "";
const token = () => createHash("sha256").update(ACCESS_CODE).digest("hex");

export async function POST(req: NextRequest) {
  if (!ACCESS_CODE) return NextResponse.json({ ok: true }); // gate off
  let code = "";
  try {
    code = (await req.json())?.code ?? "";
  } catch {
    /* ignore */
  }
  if (String(code).trim() !== ACCESS_CODE) {
    return NextResponse.json({ ok: false, error: "That code isn't right." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set("gate", token(), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
