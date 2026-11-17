import { NextRequest, NextResponse } from "next/server";
import {
  siteOrigin, verifyCode, verifyRefresh, issueTokens, clientHash, pkceOk, NO_STORE,
} from "../../../../lib/mcp-auth";
import { markCodeUsed, getMcpGen, accountActive } from "../../../../lib/firebase-admin";

// The token endpoint: swaps the one-time sign-in code for an access + refresh token, and renews them.
// Claude sends form-encoded bodies (RFC 6749); JSON is accepted too.
export async function POST(req: NextRequest) {
  const site = siteOrigin(req);
  const fail = (error: string, error_description: string, status = 400) =>
    NextResponse.json({ error, error_description }, { status, headers: NO_STORE });

  let form: URLSearchParams;
  try {
    if ((req.headers.get("content-type") || "").includes("application/json")) {
      const j = (await req.json()) as Record<string, unknown>;
      form = new URLSearchParams(Object.entries(j || {}).map(([k, v]) => [k, String(v)]));
    } else {
      form = new URLSearchParams(await req.text());
    }
  } catch {
    return fail("invalid_request", "Unreadable request body.");
  }
  // a public client sends its id in the body; accept HTTP Basic too, in case a client uses it
  let clientId = form.get("client_id") || "";
  const basic = (req.headers.get("authorization") || "").match(/^Basic\s+(.+)$/i);
  if (!clientId && basic) {
    try {
      clientId = decodeURIComponent(Buffer.from(basic[1], "base64").toString().split(":")[0]);
    } catch {
      /* ignore */
    }
  }

  try {
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const code = await verifyCode(site, form.get("code"));
      if (!code) return fail("invalid_grant", "The sign-in code is invalid or has expired.");
      if (!clientId || code.cid !== clientHash(clientId)) return fail("invalid_grant", "The code was issued to another client.");
      if (form.get("redirect_uri") !== code.ru) return fail("invalid_grant", "redirect_uri doesn't match the sign-in request.");
      if (!pkceOk(form.get("code_verifier") || "", code.cc)) return fail("invalid_grant", "The PKCE code_verifier doesn't match.");
      if (!(await markCodeUsed(code.jti))) return fail("invalid_grant", "The sign-in code was already used.");
      const gen = await getMcpGen(code.sub);
      return NextResponse.json(await issueTokens(site, { sub: code.sub, em: code.em, gen, cid: code.cid }), { headers: NO_STORE });
    }
    if (grant === "refresh_token") {
      const rt = await verifyRefresh(site, form.get("refresh_token"));
      if (!rt) return fail("invalid_grant", "The refresh token is invalid or has expired.");
      if (clientId && rt.cid !== clientHash(clientId)) return fail("invalid_grant", "The refresh token belongs to another client.");
      const [gen, active] = await Promise.all([getMcpGen(rt.sub), accountActive(rt.sub)]);
      if (!active) return fail("invalid_grant", "The La Tafti account no longer exists.");
      if (gen !== rt.gen) return fail("invalid_grant", "Claude was disconnected from this La Tafti account. Connect again.");
      return NextResponse.json(await issueTokens(site, rt), { headers: NO_STORE });
    }
    return fail("unsupported_grant_type", "Use authorization_code or refresh_token.");
  } catch {
    // a passing Firestore / Google hiccup: say so, rather than invalid_grant (which would sign the person out)
    return fail("temporarily_unavailable", "Could not reach the account service. Try again shortly.", 503);
  }
}
