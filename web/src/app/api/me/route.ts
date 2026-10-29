import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";

const ACCESS_CODE = process.env.ACCESS_CODE || "";
const token = () => createHash("sha256").update(ACCESS_CODE).digest("hex");

export async function GET(req: NextRequest) {
  if (!ACCESS_CODE) return NextResponse.json({ authed: true, gate: false });
  const c = req.cookies.get("gate")?.value;
  return NextResponse.json({ authed: !!c && c === token(), gate: true });
}
