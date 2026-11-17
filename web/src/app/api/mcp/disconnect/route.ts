import { NextRequest, NextResponse } from "next/server";
import { verifyIdToken, bumpMcpGen } from "../../../../lib/firebase-admin";

// "Disconnect Claude": every connector token this account holds stops working at once. Claude asks the
// person to connect again the next time it tries to search.
export async function POST(req: NextRequest) {
  const auth = await verifyIdToken(req.headers.get("authorization"));
  if (!auth || auth.anon) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  try {
    await bumpMcpGen(auth.uid);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Could not disconnect - try again." }, { status: 503 });
  }
}
