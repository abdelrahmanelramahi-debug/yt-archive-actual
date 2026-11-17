import { NextRequest, NextResponse } from "next/server";
import { siteOrigin, resourceUrl, MCP_SCOPE } from "../../../lib/mcp-auth";

// Protected-resource metadata (RFC 9728) for the Claude connector at /mcp: tells Claude which
// authorization server signs people in. Served here and at /mcp below, where Claude looks first.
export function GET(req: NextRequest) {
  const site = siteOrigin(req);
  return NextResponse.json(
    {
      resource: resourceUrl(site),
      authorization_servers: [site],
      scopes_supported: [MCP_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "La Tafti",
      resource_documentation: site,
    },
    { headers: { "Cache-Control": "public, max-age=3600" } }
  );
}
