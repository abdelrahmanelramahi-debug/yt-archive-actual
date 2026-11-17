import { NextRequest, NextResponse } from "next/server";
import { verifyIdToken, consumeDaily, consumeChat, refundUse } from "../../../../lib/firebase-admin";
import { withoutCost } from "../../../../lib/no-cost";
import { allowedChannels, channelNameOverrides } from "../../../../lib/channels";

// Streams the brain's Server-Sent Events straight through to the browser. Runs server-side only,
// so the brain URL + key never reach the client. The page falls back to /api/ask on any failure.
// (A POST handler is always dynamic, so no route-segment config is needed — and this Next build
// rejects `runtime`/`dynamic` exports under cacheComponents.)

const BRAIN_URL = process.env.BRAIN_URL || "http://127.0.0.1:8000";
const BRAIN_KEY = process.env.BRAIN_KEY || "";

// The brain couldn't take the question (it restarts for a few minutes after each update): give the
// use back and tell the page, which shows its "updating" notice.
const updating = () =>
  NextResponse.json(
    { error: "La Tafti is being updated. Your question wasn't counted - please ask again in a few minutes.", updating: true },
    { status: 503 }
  );

export async function POST(req: NextRequest) {
  // only signed-in users, within their daily allowance (same rule as /api/ask)
  const auth = await verifyIdToken(req.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "Please sign in to ask." }, { status: 401 });
  const uid = auth.uid;

  let body: {
    question?: string;
    channels?: string[];
    mode?: string;
    style?: string;
    cand_max?: number;
    answer_max?: number;
    chat?: boolean;
    history?: { role?: unknown; content?: unknown }[];
  } = {};
  try {
    body = await req.json();
  } catch {
    /* ignore bad body */
  }
  const question = String(body?.question ?? "").trim();
  if (!question) {
    return NextResponse.json({ error: "Please type a question." }, { status: 400 });
  }
  const channels = Array.isArray(body?.channels) ? body.channels : undefined;
  const mode = typeof body?.mode === "string" ? body.mode : undefined;
  const style = typeof body?.style === "string" ? body.style : undefined;
  // chat mode: one message in a conversation (its own, cheaper daily allowance). The earlier turns
  // come from the page; the brain re-checks and clips them, so this only bounds the size.
  const chat = body?.chat === true;
  const history = chat && Array.isArray(body?.history)
    ? body.history
        .slice(-12)
        .filter((h) => (h?.role === "user" || h?.role === "assistant") && typeof h?.content === "string")
        .map((h) => ({ role: h.role as string, content: (h.content as string).slice(0, 8000) }))
    : undefined;
  // the "custom" depth (admin only): moments + answer length. Honoured only for admins; the brain
  // clamps them. Non-admins can't widen their own budget by hand-crafting a request.
  const candMax = auth.admin && Number.isFinite(body?.cand_max) ? Math.round(body.cand_max as number) : undefined;
  const answerMax = auth.admin && Number.isFinite(body?.answer_max) ? Math.round(body.answer_max as number) : undefined;

  // reserve one of today's free answers before spending on Claude (cap is per-account)
  try {
    const res = chat ? await consumeChat(uid, auth.anon) : await consumeDaily(uid, auth.anon);
    if (res.remaining < 0) {
      if (auth.anon) {
        return NextResponse.json(
          { error: `You've used your ${res.cap} free ${chat ? "chat messages" : "questions"}. Sign in or create an account to keep going.`, guest: true },
          { status: 429 }
        );
      }
      return NextResponse.json(
        {
          error: chat
            ? `You've used your ${res.cap} chat messages for today. They reset at midnight (UTC) — Research still works.`
            : `You've used your ${res.cap} free answers for today. They reset at midnight (UTC).`,
        },
        { status: 429 }
      );
    }
  } catch {
    return NextResponse.json({ error: "Could not check your daily limit — try again." }, { status: 503 });
  }

  // restrict to the channels this account may search (admins are unrestricted)
  let effectiveChannels: string[] | undefined;
  try {
    const allow = await allowedChannels(auth.admin, channels, auth.uid);
    if (allow.blocked) {
      // nothing left to search once hidden channels are removed — end the stream as "empty"
      return new Response(`event: empty\ndata: {}\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
      });
    }
    effectiveChannels = allow.channels;
  } catch {
    return NextResponse.json({ error: "Could not check channel access — try again." }, { status: 503 });
  }

  const names = await channelNameOverrides();
  const clientIp = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  try {
    const r = await fetch(`${BRAIN_URL}/ask/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(BRAIN_KEY ? { "X-Brain-Key": BRAIN_KEY } : {}),
        ...(clientIp ? { "X-Client-IP": clientIp } : {}),
        "X-User-Id": uid, // the answer job is theirs alone to reconnect to (/api/ask/job)
      },
      body: JSON.stringify({
        question,
        channels: effectiveChannels,
        mode,
        style,
        channel_names: Object.keys(names).length ? names : undefined,
        cand_max: chat ? undefined : candMax,
        answer_max: chat ? undefined : answerMax,
        ...(chat ? { chat: true, history } : {}),
      }),
    });
    if (!r.ok || !r.body) {
      await refundUse(uid, chat ? "chat" : "answer");
      if (r.status >= 500) return updating();
      const data = await r.json().catch(() => ({ error: "The brain returned an unexpected response." }));
      return NextResponse.json(data, { status: r.status || 502 });
    }
    // pass the SSE body through unbuffered (what it cost is for admins only)
    return new Response(auth.admin ? r.body : withoutCost(r.body), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch {
    await refundUse(uid, chat ? "chat" : "answer");
    return updating();
  }
}
