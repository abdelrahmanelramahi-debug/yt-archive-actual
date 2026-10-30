// Channel visibility enforcement, shared by the ask routes and the channel picker.
// Admins are unrestricted; for everyone else, admin-hidden channels are removed — including from a
// "search everything" request, which matters because the brain treats an empty channel list as
// "all", so a non-admin must always be handed an explicit non-hidden list (never empty-means-all).
import { getHiddenChannels, getUserShowChannels, getChannelNames, type ChannelNameOverrides } from "./firebase-admin";

const BRAIN_URL = process.env.BRAIN_URL || "http://127.0.0.1:8000";
const BRAIN_KEY = process.env.BRAIN_KEY || "";

// Admin channel-name overrides ({slug: {en, ar}}), fail-open: a read error just means the brain's own
// names are used. Shared by the ask routes (passed to the brain) and the picker (/api/channels).
export async function channelNameOverrides(): Promise<ChannelNameOverrides> {
  try {
    return await getChannelNames();
  } catch {
    return {};
  }
}

let cache: { list: { slug: string; name: string }[]; exp: number } | null = null;

// Every channel the brain knows (slug + display name), cached ~5 min.
export async function brainChannelList(): Promise<{ slug: string; name: string }[]> {
  if (cache && cache.exp > Date.now()) return cache.list;
  const r = await fetch(`${BRAIN_URL}/channels`, {
    headers: { ...(BRAIN_KEY ? { "X-Brain-Key": BRAIN_KEY } : {}) },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`channels fetch failed: ${r.status}`);
  const d = (await r.json()) as { channels?: { slug: string; name?: string }[] };
  const list = (d.channels || []).map((c) => ({ slug: c.slug, name: c.name || c.slug })).filter((c) => c.slug);
  cache = { list, exp: Date.now() + 5 * 60_000 };
  return list;
}

// Just the slugs (used to expand a "search everything" request into an explicit non-hidden list).
export async function allChannelSlugs(): Promise<string[]> {
  return (await brainChannelList()).map((c) => c.slug);
}

// The channels hidden from one specific account: the global hidden list minus any an admin has
// unhidden just for them.
export async function effectiveHidden(uid: string | null): Promise<Set<string>> {
  const hidden = await getHiddenChannels();
  if (hidden.length === 0 || !uid) return new Set(hidden);
  const show = new Set(await getUserShowChannels(uid));
  return new Set(hidden.filter((s) => !show.has(s)));
}

// Resolve what a request may actually search. `channels` is what the browser asked for (undefined =
// everything). Returns the explicit list to hand the brain, or blocked=true when nothing is left to
// search (so the caller returns an empty result instead of calling the brain, which would read the
// empty list as "all").
export async function allowedChannels(
  admin: boolean,
  channels: string[] | undefined,
  uid: string | null
): Promise<{ channels: string[] | undefined; blocked: boolean }> {
  if (admin) return { channels, blocked: false };
  const hiddenSet = await effectiveHidden(uid);
  if (hiddenSet.size === 0) return { channels, blocked: false }; // this account sees everything
  const base = channels && channels.length > 0 ? channels : await allChannelSlugs();
  const list = base.filter((s) => !hiddenSet.has(s));
  if (list.length === 0) return { channels: [], blocked: true };
  return { channels: list, blocked: false };
}
