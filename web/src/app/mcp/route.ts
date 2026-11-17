import { NextRequest, NextResponse } from "next/server";
import { siteOrigin, verifyAccess, metadataUrl, MCP_SCOPE, type Grant } from "../../lib/mcp-auth";
import { consumeMcp, isAdminEmail } from "../../lib/firebase-admin";
import { allowedChannels, channelNameOverrides } from "../../lib/channels";

// The Claude connector: an MCP server (Streamable HTTP, stateless, JSON replies) that lets an account's
// own Claude search the archive. Every request needs a La Tafti access token; without one Claude gets a
// 401 pointing at the sign-in metadata and starts the sign-in. Tool calls count against the account's
// daily connector allowance and stay within the channels it may see; the brain does the searching.

const BRAIN_URL = process.env.BRAIN_URL || "http://127.0.0.1:8000";
const BRAIN_KEY = process.env.BRAIN_KEY || "";

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `La Tafti (لا تفتي, "don't issue fatwas") is a searchable archive of Islamic scholars' lectures, lessons and Q&A sessions, transcribed from tens of thousands of videos in Arabic and English. Use it whenever the user asks what the scholars say about a ruling, a topic, a hadith or a book.

Searching well:
- Call search_lectures a few times from different angles, and always give arabic_terms: the Arabic words a scholar would actually say. Many channels are matched only by their exact Arabic words.
- Use find_videos when the user names a book, a lesson series or a lecture, and read_transcript to read around a passage before relying on it.

Answering: base any ruling only on what the scholars say in the passages, say which scholar said what, and link each point to its passage's URL. Don't give rulings from your own knowledge. If the archive doesn't cover the question, say so plainly instead of filling the gap.`;

const CHANNELS_ARG = {
  type: "array",
  items: { type: "string" },
  description: "Only these channels (slugs from list_channels). Leave out to search every channel.",
};
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: "search_lectures",
    title: "Search the scholars' lectures",
    description:
      "Search what the scholars actually said across the archive's transcribed lectures and Q&A (Arabic and English). Returns passages of speech, best first, each with the channel, video title, date, a YouTube link that opens at that moment, and a video_id. Matches by meaning and by exact words. For a thorough answer, call it a few times from different angles.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The question or topic, in English or Arabic." },
        arabic_terms: {
          type: "array",
          items: { type: "string" },
          maxItems: 12,
          description:
            'Arabic words or short phrases a scholar would say about this, e.g. ["السبلان", "إعفاء اللحية"]. Many channels are matched only by their exact Arabic words, so always include some; rare technical terms are found first.',
        },
        other_phrasings: {
          type: "array",
          items: { type: "string" },
          maxItems: 5,
          description: "Other ways to put the search, searched together with the query.",
        },
        channels: CHANNELS_ARG,
        max_results: { type: "integer", minimum: 1, maximum: 40, default: 20, description: "How many passages to return (default 20)." },
      },
      required: ["query"],
    },
    annotations: { title: "Search the scholars' lectures", ...READ_ONLY },
  },
  {
    name: "find_videos",
    title: "Find videos by title",
    description:
      'Find videos by their title: a lesson series on a book (e.g. "الآجرومية", "Kitab at-Tawhid"), a named lecture, or a topic likely to be in titles. Returns the matching series, each with its videos in lesson order (links and video_ids) and any lesson numbers missing from the archive.',
    inputSchema: {
      type: "object",
      properties: {
        titles: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 4,
          description: "Phrases from the titles, e.g. both the Arabic and the English name of the book.",
        },
        channels: CHANNELS_ARG,
      },
      required: ["titles"],
    },
    annotations: { title: "Find videos by title", ...READ_ONLY },
  },
  {
    name: "read_transcript",
    title: "Read a video's transcript",
    description:
      "Read part of one video's transcript, with timestamps: the context around a passage (start a minute or two before it), or a whole short lesson. Up to 20 minutes per call; call again to carry on.",
    inputSchema: {
      type: "object",
      properties: {
        video_id: { type: "string", description: "The video_id from search_lectures or find_videos (a YouTube link works too)." },
        start: { type: "string", description: 'Where to start, as a time like "25:29" or "1:02:03" (default: the beginning).' },
        minutes: { type: "number", minimum: 0.5, maximum: 20, default: 5, description: "How many minutes to read (default 5)." },
      },
      required: ["video_id"],
    },
    annotations: { title: "Read a video's transcript", ...READ_ONLY },
  },
  {
    name: "list_channels",
    title: "List the channels",
    description:
      "List the scholars' channels in the archive: each one's slug (to limit a search), name, number of videos, and whether it is searched by meaning or by exact Arabic words.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "List the channels", ...READ_ONLY },
  },
];

type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
const REVOKED = Symbol("revoked");

const toolText = (text: string, isError = false) => ({ content: [{ type: "text", text }], isError });

async function callTool(params: Record<string, unknown>, g: Grant) {
  const name = String(params?.name || "");
  const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
  let used;
  try {
    used = await consumeMcp(g.sub, g.gen);
  } catch {
    return toolText("Couldn't check your La Tafti allowance just now - try again in a moment.", true);
  }
  if (used.revoked) return REVOKED;
  if (used.remaining < 0) {
    return toolText(`This La Tafti account has used today's ${used.cap} searches. They reset at midnight (UTC).`, true);
  }
  let channels: string[] | undefined;
  try {
    const allow = await allowedChannels(isAdminEmail(g.em), undefined, g.sub);
    if (allow.blocked) return toolText("There are no channels this account can search.", true);
    channels = allow.channels;
  } catch {
    return toolText("Couldn't check which channels you can search - try again in a moment.", true);
  }
  const names = await channelNameOverrides();
  try {
    const r = await fetch(`${BRAIN_URL}/mcp/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(BRAIN_KEY ? { "X-Brain-Key": BRAIN_KEY } : {}),
        "X-User-Id": g.sub,
      },
      body: JSON.stringify({
        tool: name,
        arguments: args,
        channels,
        channel_names: Object.keys(names).length ? names : undefined,
      }),
      signal: AbortSignal.timeout(55_000),
    });
    if (!r.ok) return toolText("The archive is busy or restarting - try again in a minute.", true);
    const d = (await r.json()) as { text?: string; is_error?: boolean };
    return toolText(String(d.text || ""), !!d.is_error);
  } catch {
    return toolText("Couldn't reach the archive - try again in a minute.", true);
  }
}

async function handle(m: Rpc, g: Grant) {
  if (!m || typeof m !== "object" || typeof m.method !== "string") {
    // a response or something unreadable: nothing to answer unless it carries an id
    return m && typeof m === "object" && "id" in m && !("result" in m || "error" in m)
      ? { jsonrpc: "2.0", id: m.id ?? null, error: { code: -32600, message: "Invalid request" } }
      : null;
  }
  const notification = m.id === undefined || m.id === null;
  const ok = (result: unknown) => (notification ? null : { jsonrpc: "2.0", id: m.id, result });
  const p = m.params && typeof m.params === "object" ? m.params : {};
  switch (m.method) {
    case "initialize": {
      const asked = String(p.protocolVersion || "");
      return ok({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "latafti", title: "La Tafti", version: "1.0.0", websiteUrl: "https://latafti.com" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      if (!TOOLS.some((t) => t.name === p.name)) {
        return notification ? null : { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `Unknown tool: ${String(p.name)}` } };
      }
      const res = await callTool(p, g);
      return res === REVOKED ? REVOKED : ok(res);
    }
    default:
      if (notification || m.method.startsWith("notifications/")) return null;
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
  }
}

function unauthorized(site: string, invalid: boolean) {
  const challenge =
    `Bearer resource_metadata="${metadataUrl(site)}", scope="${MCP_SCOPE}"` + (invalid ? `, error="invalid_token"` : "");
  return NextResponse.json(
    { error: invalid ? "invalid_token" : "unauthorized", error_description: "Sign in to La Tafti to use this connector." },
    { status: 401, headers: { "WWW-Authenticate": challenge } }
  );
}

export async function POST(req: NextRequest) {
  const site = siteOrigin(req);
  const token = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1];
  const grant = token ? await verifyAccess(site, token) : null;
  if (!grant) return unauthorized(site, !!token);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  const many = Array.isArray(body);
  const msgs = (many ? body : [body]) as Rpc[];
  if (msgs.length === 0 || msgs.length > 20) {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }, { status: 400 });
  }
  const out = await Promise.all(msgs.map((m) => handle(m, grant)));
  if (out.includes(REVOKED)) return unauthorized(site, true); // disconnected: Claude must sign in again
  const replies = out.filter((x) => x !== null);
  if (replies.length === 0) return new Response(null, { status: 202 }); // notifications only
  return NextResponse.json(many ? replies : replies[0], { headers: { "Cache-Control": "no-store" } });
}

// No server-to-client stream and no sessions: this server only answers POSTs.
export function GET() {
  return new Response("La Tafti's Claude connector takes MCP requests by POST.", { status: 405, headers: { Allow: "POST" } });
}

export function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
