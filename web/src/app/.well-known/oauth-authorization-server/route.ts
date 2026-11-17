import { NextRequest, NextResponse } from "next/server";
import { siteOrigin, MCP_SCOPE } from "../../../lib/mcp-auth";

// Authorization-server metadata (RFC 8414) for the Claude connector's sign-in.
export function GET(req: NextRequest) {
  const site = siteOrigin(req);
  return NextResponse.json(
    {
      issuer: site,
      authorization_endpoint: `${site}/oauth/authorize`,
      token_endpoint: `${site}/api/oauth/token`,
      registration_endpoint: `${site}/api/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [MCP_SCOPE],
      authorization_response_iss_parameter_supported: true,
      service_documentation: site,
    },
    { headers: { "Cache-Control": "public, max-age=3600" } }
  );
}
