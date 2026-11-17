import { NextRequest, NextResponse } from "next/server";
import { siteOrigin, redirectAllowed, signClient, MCP_SCOPE, NO_STORE } from "../../../../lib/mcp-auth";

// Dynamic Client Registration (RFC 7591): Claude registers itself before the first sign-in. Only
// Claude's own return addresses (and loopback, for Claude Code) are accepted. Nothing is stored: the
// client id is a signed token holding the registration.
export async function POST(req: NextRequest) {
  const site = siteOrigin(req);
  const fail = (error: string, error_description: string) =>
    NextResponse.json({ error, error_description }, { status: 400, headers: NO_STORE });

  let body: { redirect_uris?: unknown; client_name?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return fail("invalid_client_metadata", "Send the registration as JSON.");
  }
  const uris = Array.isArray(body.redirect_uris)
    ? [...new Set(body.redirect_uris.filter((u): u is string => typeof u === "string"))]
    : [];
  if (uris.length === 0 || uris.length > 5) return fail("invalid_redirect_uri", "Give one to five redirect_uris.");
  const bad = uris.find((u) => !redirectAllowed(u));
  if (bad) return fail("invalid_redirect_uri", `La Tafti connects to Claude only; this return address isn't allowed: ${bad}`);
  const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : "Claude";

  const clientId = await signClient(site, uris, name);
  return NextResponse.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: MCP_SCOPE,
    },
    { status: 201, headers: NO_STORE }
  );
}
