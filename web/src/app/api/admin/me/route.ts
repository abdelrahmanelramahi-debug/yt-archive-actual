import { NextRequest, NextResponse } from "next/server";
import { verifyIdToken } from "../../../../lib/firebase-admin";

// Tells the client whether the signed-in account is an admin, so it can show the admin UI.
// (The admin endpoints still re-check this server-side — this is only for showing/hiding.)
export async function GET(req: NextRequest) {
  const a = await verifyIdToken(req.headers.get("authorization"));
  return NextResponse.json({ admin: !!a?.admin });
}
