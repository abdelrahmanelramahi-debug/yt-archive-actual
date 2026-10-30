// Channel visibility enforcement, shared by the ask routes and the channel picker.
// Admins are unrestricted; for everyone else, admin-hidden channels are removed — including from a
// "search everything" request, which matters because the brain treats an empty channel list as
// "all", so a non-admin must always be handed an explicit non-hidden list (never empty-means-all).
import { getHiddenChannels } from "./firebase-admin";

const BRAIN_URL = process.env.BRAIN_URL || "http://127.0.0.1:8000";
const BRAIN_KEY = process.env.BRAIN_KEY || "";

let cache: { slugs: string[]; exp: number } | null = null;

// Every channel slug the brain knows, cached ~5 min (only needed to expand a "search everything"
// request into an explicit list when some channels are hidden).
export async function allChannelSlugs(): Promise<string[]> {
  if (cache && cache.exp > Date.now()) return cache.slugs;
  const r = await fetch(`${BRAIN_URL}/channels`, {
    headers: { ...(BRAIN_KEY ? { "X-Brain-Key": BRAIN_KEY } : {}) },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`channels fetch failed: ${r.status}`);
  const d = (await r.json()) as { channels?: { slug: string }[] };
  const slugs = (d.channels || []).map((c) => c.slug).filter(Boolean);
  cache = { slugs, exp: Date.now() + 5 * 60_000 };
  return slugs;
}

// Resolve what a request may actually search. `channels` is what the browser asked for (undefined =
// everything). Returns the explicit list to hand the brain, or blocked=true when nothing is left to
// search (so the caller returns an empty result instead of calling the brain, which would read the
// empty list as "all").
export async function allowedChannels(
  admin: boolean,
  channels: string[] | undefined
): Promise<{ channels: string[] | undefined; blocked: boolean }> {
  if (admin) return { channels, blocked: false };
  const hidden = await getHiddenChannels();
  if (hidden.length === 0) return { channels, blocked: false }; // nothing hidden: pass through
  const hiddenSet = new Set(hidden);
  const base = channels && channels.length > 0 ? channels : await allChannelSlugs();
  const list = base.filter((s) => !hiddenSet.has(s));
  if (list.length === 0) return { channels: [], blocked: true };
  return { channels: list, blocked: false };
}
