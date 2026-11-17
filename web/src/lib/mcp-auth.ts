// Sign-in for the Claude connector (latafti.com/mcp): a small OAuth 2.1 authorization server, as Claude
// expects (https://claude.com/docs/connectors/building/authentication). Claude registers itself
// (/api/oauth/register), sends the person to /oauth/authorize to sign in and press Allow, swaps the
// one-time code for tokens (/api/oauth/token), then calls /mcp with the access token.
//
// Everything is a signed token (HS256, with a key derived from a server secret), so nothing needs
// storing except a marker per spent code (single use). Access tokens last an hour; Claude renews them
// with the refresh token, which re-checks the account. "Disconnect Claude" bumps the account's
// generation (users/{uid}.mcpGen), and every token issued before it stops working.
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { createHash, createHmac, randomUUID } from "node:crypto";

export const MCP_SCOPE = "search";
export const ACCESS_TTL = 3600; // seconds
const REFRESH_TTL = 90 * 24 * 3600;
const CODE_TTL = 300;

// Where Claude's apps (web, Desktop, mobile) come back after sign-in; Claude Code uses a loopback
// address on any port. Nothing else may register: La Tafti connects to Claude only.
const HOSTED_CALLBACKS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];

let keyCache: Uint8Array | null = null;
function key(): Uint8Array {
  if (keyCache) return keyCache;
  // the live site always has the service-account key; a local dev server may have no secret at all
  const material =
    process.env.MCP_SECRET ||
    process.env.FIREBASE_PRIVATE_KEY ||
    process.env.BRAIN_KEY ||
    (process.env.NODE_ENV === "production" ? "" : "latafti-local-dev-only");
  if (!material) throw new Error("no server secret to sign connector tokens with");
  keyCache = new Uint8Array(createHmac("sha256", material).update("latafti-mcp-oauth-v1").digest());
  return keyCache;
}

// This site's origin as the caller reached it (latafti.com in production, localhost in development).
// The issuer, the resource and every endpoint are built from it, so they always agree.
export function siteOrigin(req: Request): string {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, "");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (!host) return new URL(req.url).origin;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() || (local ? "http" : "https");
  return `${proto}://${host}`;
}

export const resourceUrl = (site: string) => `${site}/mcp`;
export const metadataUrl = (site: string) => `${site}/.well-known/oauth-protected-resource/mcp`;

// the resource Claude names must be this connector (with or without a trailing slash)
export const resourceOk = (site: string, r: string) => [resourceUrl(site), `${resourceUrl(site)}/`, site, `${site}/`].includes(r);

const isLoopbackUrl = (u: URL) => u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);

export function isLoopback(uri: string): boolean {
  try {
    return isLoopbackUrl(new URL(uri));
  } catch {
    return false;
  }
}

// May a client register this return address at all?
export function redirectAllowed(uri: string): boolean {
  if (HOSTED_CALLBACKS.includes(uri)) return true;
  try {
    const u = new URL(uri);
    return isLoopbackUrl(u) && !u.username && !u.password && !u.hash;
  } catch {
    return false;
  }
}

// Does the return address in a sign-in request match one the client registered? Exact, except that a
// loopback address may use any port (Claude Code picks a fresh one each time).
export function redirectMatches(registered: string[], uri: string): boolean {
  if (registered.includes(uri)) return true;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (!isLoopbackUrl(u) || u.username || u.password || u.hash) return false;
  return registered.some((r) => {
    try {
      const x = new URL(r);
      return isLoopbackUrl(x) && x.pathname === u.pathname && x.search === u.search;
    } catch {
      return false;
    }
  });
}

// a short, stable fingerprint of a client id, to tie codes and refresh tokens to the client they were issued to
export const clientHash = (clientId: string) => createHash("sha256").update(clientId).digest("base64url").slice(0, 22);

// the PKCE check: the verifier Claude kept must hash to the challenge it sent at sign-in
export function pkceOk(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

type Kind = "client" | "code" | "access" | "refresh";

async function sign(site: string, kind: Kind, claims: Record<string, unknown>, ttl: number | null, aud?: string) {
  const now = Math.floor(Date.now() / 1000);
  let jwt = new SignJWT({ ...claims, t: kind }).setProtectedHeader({ alg: "HS256" }).setIssuer(site).setIssuedAt(now);
  if (ttl) jwt = jwt.setExpirationTime(now + ttl).setJti(randomUUID());
  if (aud) jwt = jwt.setAudience(aud);
  return jwt.sign(key());
}

async function verify(site: string, kind: Kind, token: string | null | undefined, aud?: string): Promise<JWTPayload | null> {
  if (!token || token.length > 4000) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { issuer: site, algorithms: ["HS256"], ...(aud ? { audience: aud } : {}) });
    return payload.t === kind ? payload : null;
  } catch {
    return null;
  }
}

// ---- clients (Dynamic Client Registration): the client id itself carries the registration ----

export const signClient = (site: string, redirectUris: string[], name: string) =>
  sign(site, "client", { ru: redirectUris, cn: name }, null);

export async function verifyClient(site: string, clientId: string): Promise<{ ru: string[]; cn: string } | null> {
  const p = await verify(site, "client", clientId);
  if (!p || !Array.isArray(p.ru)) return null;
  return { ru: (p.ru as unknown[]).filter((x): x is string => typeof x === "string"), cn: String(p.cn || "Claude") };
}

// ---- one-time sign-in codes ----

export type CodeClaims = { sub: string; em: string; cid: string; ru: string; cc: string; jti: string };

export const signCode = (site: string, c: Omit<CodeClaims, "jti">) =>
  sign(site, "code", { sub: c.sub, em: c.em, cid: c.cid, ru: c.ru, cc: c.cc }, CODE_TTL);

export async function verifyCode(site: string, code: string | null): Promise<CodeClaims | null> {
  const p = await verify(site, "code", code);
  if (!p || typeof p.sub !== "string" || typeof p.jti !== "string") return null;
  return { sub: p.sub, em: String(p.em || ""), cid: String(p.cid || ""), ru: String(p.ru || ""), cc: String(p.cc || ""), jti: p.jti };
}

// ---- access + refresh tokens ----

export type Grant = { sub: string; em: string; gen: number; cid: string };

export async function issueTokens(site: string, g: Grant) {
  const [access, refresh] = await Promise.all([
    sign(site, "access", { sub: g.sub, em: g.em, gen: g.gen, scope: MCP_SCOPE }, ACCESS_TTL, resourceUrl(site)),
    sign(site, "refresh", { sub: g.sub, em: g.em, gen: g.gen, cid: g.cid }, REFRESH_TTL),
  ]);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: MCP_SCOPE };
}

const asGrant = (p: JWTPayload | null): Grant | null =>
  p && typeof p.sub === "string" && typeof p.gen === "number"
    ? { sub: p.sub, em: String(p.em || ""), gen: p.gen, cid: String(p.cid || "") }
    : null;

export const verifyAccess = async (site: string, token: string | null | undefined) =>
  asGrant(await verify(site, "access", token, resourceUrl(site)));

export const verifyRefresh = async (site: string, token: string | null) => asGrant(await verify(site, "refresh", token));

// OAuth responses must never be cached
export const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };
