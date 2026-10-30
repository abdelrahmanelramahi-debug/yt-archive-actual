import { NextRequest, NextResponse } from "next/server";
import {
  verifyIdToken,
  getHiddenChannels,
  setHiddenChannels,
  getChannelNames,
  setChannelNames,
  type ChannelNameOverrides,
} from "../../../../lib/firebase-admin";
import { brainChannelList } from "../../../../lib/channels";

// Admin only: read/write which channels are hidden from non-admin accounts (globally) and the
// per-channel display-name overrides (English/Arabic) shown in the picker and answer headings.
export async function GET(req: NextRequest) {
  const auth = await verifyIdToken(req.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  if (!auth.admin) return NextResponse.json({ error: "Admins only." }, { status: 403 });
  try {
    const [channels, hidden, names] = await Promise.all([
      brainChannelList(),
      getHiddenChannels(),
      getChannelNames(),
    ]);
    return NextResponse.json({ channels, hidden, names });
  } catch {
    return NextResponse.json({ error: "Could not load channels." }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await verifyIdToken(req.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  if (!auth.admin) return NextResponse.json({ error: "Admins only." }, { status: 403 });

  let body: { hidden?: unknown; names?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* ignore */
  }
  const hasHidden = Array.isArray(body?.hidden);
  const hasNames = !!body?.names && typeof body.names === "object" && !Array.isArray(body.names);
  if (!hasHidden && !hasNames) return NextResponse.json({ error: "Nothing to save." }, { status: 400 });

  try {
    // keep only slugs that actually exist, so a stale UI can't persist junk
    const valid = new Set((await brainChannelList()).map((c) => c.slug));
    const out: { ok: true; hidden?: string[]; names?: ChannelNameOverrides } = { ok: true };

    if (hasHidden) {
      const requested = (body.hidden as unknown[]).map((s) => String(s));
      const hidden = [...new Set(requested.filter((s) => valid.has(s)))];
      await setHiddenChannels(hidden);
      out.hidden = hidden;
    }
    if (hasNames) {
      const raw = body.names as Record<string, { en?: unknown; ar?: unknown }>;
      const names: ChannelNameOverrides = {};
      for (const [slug, v] of Object.entries(raw)) {
        if (!valid.has(slug) || !v || typeof v !== "object") continue;
        const en = typeof v.en === "string" ? v.en.trim().slice(0, 120) : "";
        const ar = typeof v.ar === "string" ? v.ar.trim().slice(0, 120) : "";
        if (en || ar) names[slug] = { ...(en ? { en } : {}), ...(ar ? { ar } : {}) };
      }
      await setChannelNames(names);
      out.names = names;
    }
    return NextResponse.json(out);
  } catch {
    return NextResponse.json({ error: "Could not save." }, { status: 503 });
  }
}
