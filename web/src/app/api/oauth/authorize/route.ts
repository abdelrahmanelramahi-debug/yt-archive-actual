import { NextRequest, NextResponse } from "next/server";
import {
  siteOrigin, verifyClient, redirectMatches, resourceOk, isLoopback, signCode, clientHash, NO_STORE,
} from "../../../../lib/mcp-auth";
import { verifyIdToken } from "../../../../lib/firebase-admin";

// The consent page (/oauth/authorize) posts here with the sign-in request Claude sent:
//   action "check" -> who is asking and where they'll be sent back (no sign-in needed)
//   action "allow" -> (signed in, not a guest) the address to send the browser back to, with a code
//   action "deny"  -> the address to send the browser back to, with access_denied
// A bad client or return address is never redirected to: the page shows the error instead.
export async function POST(req: NextRequest) {
  const site = siteOrigin(req);
  let b: Record<string, unknown> = {};
  try {
    b = await req.json();
  } catch {
    /* handled below */
  }
  const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
  const clientId = s("client_id");
  const ru = s("redirect_uri");
  const client = clientId ? await verifyClient(site, clientId) : null;
  if (!client || !ru || !redirectMatches(client.ru, ru)) {
    return NextResponse.json({ error: "bad_client" }, { status: 400, headers: NO_STORE });
  }

  // from here on, problems go back to the client on its own return address, as OAuth errors
  const back = (params: Record<string, string>) => {
    const u = new URL(ru);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (s("state")) u.searchParams.set("state", s("state"));
    u.searchParams.set("iss", site);
    return NextResponse.json({ redirect: u.toString() }, { headers: NO_STORE });
  };
  if (s("response_type") !== "code") return back({ error: "unsupported_response_type" });
  if (!s("code_challenge") || s("code_challenge_method") !== "S256") {
    return back({ error: "invalid_request", error_description: "PKCE with S256 is required." });
  }
  if (s("resource") && !resourceOk(site, s("resource"))) {
    return back({ error: "invalid_target", error_description: "Unknown resource." });
  }

  const action = s("action");
  if (action === "check") {
    return NextResponse.json({ client: client.cn, host: new URL(ru).host, loopback: isLoopback(ru) }, { headers: NO_STORE });
  }
  if (action === "deny") return back({ error: "access_denied" });
  if (action !== "allow") return NextResponse.json({ error: "bad_action" }, { status: 400, headers: NO_STORE });

  const auth = await verifyIdToken(req.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "signin" }, { status: 401, headers: NO_STORE });
  if (auth.anon) return NextResponse.json({ error: "guest" }, { status: 403, headers: NO_STORE });
  const code = await signCode(site, { sub: auth.uid, em: auth.email, cid: clientHash(clientId), ru, cc: s("code_challenge") });
  return back({ code });
}
