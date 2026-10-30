"use client";

import { useEffect, useRef, useState } from "react";
import { collection, addDoc, deleteDoc, doc, onSnapshot, query, orderBy, limit, serverTimestamp } from "firebase/firestore";
import { useAuth, signOutUser, idToken } from "../lib/auth";
import { useLang, LangToggle, type Lang } from "../lib/i18n";
import { db } from "../lib/firebase";
import SignIn from "./SignIn";
import UpdatePopup from "./UpdatePopup";

const DAILY_CAP = 20; // free answers per user per day (keep in sync with the server's cap)
const GUEST_CAP = 2; // free questions for a guest (anonymous) before they're asked to sign up

// one saved question+answer in the user's history (sources stored light — no transcript windows)
type ChatDoc = { id: string; q: string; answer: string; sources: Source[]; coverage: Coverage; cost_usd?: number | null; style?: string };

type Line = { ts: string | null; text: string };
type Source = {
  n: number;
  timestamp: string;
  title: string;
  channel: string | null;
  date: string | null;
  url: string;
  video_id?: string | null; // lets the card fetch the whole video's transcript on demand
  slug?: string | null; // channel slug (set for keyword channels, so the brain reads the right db)
  context?: Line[]; // a short window of surrounding transcript
  citedIdx?: number; // which line in `context` is the cited moment
};
type Coverage = { moments: number; videos: number; channels: number };
type Answer = {
  q: string;
  empty?: boolean;
  answer: string | null;
  sources: Source[];
  coverage: Coverage;
  cost_usd?: number;
  error?: string;
};
type Channel = { slug: string; name: string; kind: string; en?: string; ar?: string };
type Mode = { id: string; label: string; usd: number };

// A channel's display name in the current interface language: the admin override for that language,
// then the other language's override, then the brain's own name.
function channelName(c: { name: string; en?: string; ar?: string }, lang: Lang): string {
  const pick = lang === "ar" ? c.ar || c.en : c.en || c.ar;
  return (pick || c.name || "").trim() || c.name;
}

// Admin name-override map helpers: drop blank entries, and a stable string for change detection.
type NameMap = Record<string, { en?: string; ar?: string }>;
function cleanNames(n: NameMap): NameMap {
  const out: NameMap = {};
  for (const slug of Object.keys(n)) {
    const en = (n[slug]?.en || "").trim();
    const ar = (n[slug]?.ar || "").trim();
    if (en || ar) out[slug] = { ...(en ? { en } : {}), ...(ar ? { ar } : {}) };
  }
  return out;
}
function normNames(n: NameMap): string {
  const c = cleanNames(n);
  const sorted: NameMap = {};
  for (const k of Object.keys(c).sort()) sorted[k] = c[k];
  return JSON.stringify(sorted);
}

// Typical cost of one deluxe answer, shown up front so nobody is surprised by the bill.
const TYPICAL_COST = 0.08;

// Prices are shown to visitors in AED (UAE dirham), converted from the USD the brain reports.
const AED_PER_USD = 3.6725; // fixed USD peg
const aed = (usd: number) => `AED ${(usd * AED_PER_USD).toFixed(2)}`;

// Hero counts: the real totals, floored to a clean increment with a "+" so they never overstate
// and bump up a step as the archive grows.
function heroVideos(n: number): string {
  if (n >= 1000) return (Math.floor(n / 1000) * 1000).toLocaleString() + "+";
  return n.toLocaleString();
}
function heroMoments(n: number): string {
  if (n >= 1_000_000) {
    const m = Math.round(n / 100_000) / 10; // headline figure, to the nearest 100k (e.g. 1.1M)
    return (Number.isInteger(m) ? m.toString() : m.toFixed(1)) + "M+";
  }
  if (n >= 1000) return Math.round(n / 1000).toLocaleString() + "K+";
  return n.toLocaleString();
}

// keys into the i18n dictionary — the shown + asked text follows the interface language
const EX_KEYS = ["ex.1", "ex.2", "ex.3"];

const STAGE_KEYS = ["stage.1", "stage.2", "stage.3", "stage.4"];
// map the brain's streaming status events onto the stage copy above
const STAGE_IDX: Record<string, number> = { searching: 1, reading: 2, writing: 3 };

// La Tifti wordmark — the uploaded logo, recoloured per theme via a CSS mask.
function Wordmark() {
  return <span className="logo-mark shrink-0" role="img" aria-label="La Tafti · لا تفتي" />;
}

const THEMES = [
  { id: "light", label: "Light" },
  { id: "sepia", label: "Sepia" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

function applyTheme(choice: string) {
  const t =
    choice === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : choice;
  const el = document.documentElement;
  el.setAttribute("data-theme", t);
  el.setAttribute("data-theme-choice", choice);
}

function ThemeIcon({ id }: { id: string }) {
  const p = { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (id === "light")
    return (
      <svg {...p} aria-hidden>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  if (id === "dark")
    return (
      <svg {...p} aria-hidden>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
      </svg>
    );
  if (id === "system")
    return (
      <svg {...p} aria-hidden>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </svg>
    );
  // sepia
  return (
    <svg {...p} aria-hidden>
      <path d="M12 3s6 5.7 6 10a6 6 0 0 1-12 0c0-4.3 6-10 6-10Z" />
    </svg>
  );
}

// Display selector: Light / Sepia / Dark / System, remembered in localStorage.
function ThemeSelector() {
  const [choice, setChoice] = useState("system");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setChoice(document.documentElement.getAttribute("data-theme-choice") || "system");
  }, []);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  useEffect(() => {
    if (choice !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = () => applyTheme("system");
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, [choice]);

  function pick(c: string) {
    setChoice(c);
    try {
      localStorage.setItem("theme", c);
    } catch {
      /* ignore */
    }
    applyTheme(c);
    setOpen(false);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Display theme"
        className="grid h-9 w-9 place-items-center rounded-lg border border-line text-muted transition hover:border-line2 hover:text-ink"
      >
        <ThemeIcon id={choice} />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1.5 w-36 rounded-xl border border-line bg-raised p-1 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.3)]">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => pick(t.id)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] transition ${
                choice === t.id ? "text-accent" : "text-muted hover:bg-paper hover:text-ink"
              }`}
            >
              <ThemeIcon id={t.id} />
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Depth selector: Quick / Standard / Deep, each with its own typical cost.
function ModePicker({ modes, mode, onChange }: { modes: Mode[]; mode: string; onChange: (id: string) => void }) {
  if (!modes.length) return null;
  return (
    <div className="inline-flex rounded-xl border border-line bg-raised/70 p-0.5">
      {modes.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onChange(m.id)}
          title={`${m.label} — about ${aed(m.usd)} per answer`}
          className={`rounded-[9px] px-3 py-1.5 text-[13px] font-medium transition ${
            mode === m.id ? "bg-accent text-paper shadow-sm" : "text-muted hover:text-ink"
          }`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

// Which channels to search. Defaults to all; a subset narrows the search (and the cost).
function ChannelPicker({
  channels,
  selected,
  onChange,
  compact,
  dropUp = true,
}: {
  channels: Channel[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  compact?: boolean;
  dropUp?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { lang, t } = useLang();
  const all = selected.size === channels.length;
  const label = all ? "All channels" : selected.size === 0 ? "No channels" : `${selected.size} of ${channels.length}`;

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function toggle(slug: string) {
    const next = new Set(selected);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    onChange(next);
  }

  return (
    <div className="relative" ref={ref}>
      {compact ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={`Channels: ${label}`}
          title={label}
          className={`grid h-9 w-9 place-items-center rounded-xl border bg-raised/70 transition hover:border-line2 ${
            all ? "border-line text-muted" : "border-accent/60 text-accent"
          }`}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M4 7h16M7 12h10M10 17h4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-raised/70 px-3 py-1.5 text-[13px] font-medium text-ink transition hover:border-line2"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden className="text-muted">
            <path d="M4 7h16M7 12h10M10 17h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          {label}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden className="text-faint">
            <path d={dropUp ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      {open && (
        <div
          className={`absolute left-0 z-30 max-h-80 w-72 overflow-auto rounded-xl border border-line bg-raised p-1.5 ${
            dropUp
              ? "bottom-full mb-1.5 shadow-[0_-16px_40px_-16px_rgba(35,33,27,0.4)]"
              : "top-full mt-1.5 shadow-[0_16px_40px_-16px_rgba(35,33,27,0.4)]"
          }`}
        >
          <div className="flex items-center justify-between px-2 py-1 text-xs">
            {all ? (
              <button type="button" className="font-medium text-accent hover:underline" onClick={() => onChange(new Set())}>
                {t("channels.deselectAll")}
              </button>
            ) : (
              <>
                <button type="button" className="font-medium text-accent hover:underline" onClick={() => onChange(new Set(channels.map((c) => c.slug)))}>
                  {t("channels.selectAll")}
                </button>
                <button type="button" className="text-muted hover:text-ink" onClick={() => onChange(new Set())}>
                  {t("channels.clear")}
                </button>
              </>
            )}
          </div>
          {channels.map((c) => (
            <label
              key={c.slug}
              className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-paper"
            >
              <input
                type="checkbox"
                checked={selected.has(c.slug)}
                onChange={() => toggle(c.slug)}
                className="h-4 w-4 shrink-0 accent-[var(--color-accent)]"
              />
              <span className="min-w-0 flex-1 truncate text-sm text-ink" dir="auto">
                {channelName(c, lang)}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// Compact depth selector holding the depths, their cost, and the explainer. Opens up above the ask
// bar on the phone landing; opens down once the controls sit at the top (after a question is asked).
function ModeDropup({ modes, mode, onChange, dropUp = true }: { modes: Mode[]; mode: string; onChange: (id: string) => void; dropUp?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = modes.find((m) => m.id === mode);
  const keeps: Record<string, string> = { quick: "~120", standard: "~500", deep: "~1,000", custom: "you set" };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!modes.length) return null;
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 rounded-xl border border-line bg-raised/70 px-3 py-1.5 text-[13px] font-medium text-ink transition hover:border-line2"
      >
        {current?.label ?? "Depth"}
        <span className="text-gold2">≈ {aed(current?.usd ?? TYPICAL_COST)}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden className="text-faint">
          <path d={dropUp ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          className={`absolute right-0 z-30 w-64 rounded-xl border border-line bg-raised p-1.5 ${
            dropUp
              ? "bottom-full mb-1.5 shadow-[0_-16px_40px_-16px_rgba(35,33,27,0.4)]"
              : "top-full mt-1.5 shadow-[0_16px_40px_-16px_rgba(35,33,27,0.4)]"
          }`}
        >
          {modes.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                onChange(m.id);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-[13px] transition ${
                mode === m.id ? "bg-accent/10 text-accent" : "text-ink hover:bg-paper"
              }`}
            >
              <span className="font-medium">{m.label}</span>
              <span className="text-faint">
                keeps {keeps[m.id] ?? "?"} · {aed(m.usd)}
              </span>
            </button>
          ))}
          <p className="mt-1.5 border-t border-line px-2.5 pt-2 text-[12px] leading-relaxed text-muted">
            Every depth searches <strong className="font-semibold text-ink">all 1.1M moments</strong> — it only
            changes how many of the best it keeps.
          </p>
        </div>
      )}
    </div>
  );
}

// A single headline figure, for the scale strip on the landing page.
function Stat({ n, label }: { n: string; label: string }) {
  return (
    <div>
      <div className="font-serif text-[1.5rem] font-medium leading-none tracking-tight text-ink sm:text-[1.8rem]">{n}</div>
      <div className="mt-1.5 text-xs text-faint">{label}</div>
    </div>
  );
}

// Collapsible explainer for the depth modes, under the picker.
function ModeExplainer({ modes }: { modes: Mode[] }) {
  const [open, setOpen] = useState(false);
  if (!modes.length) return null;
  const keeps: Record<string, string> = { quick: "~120", standard: "~500", deep: "~1,000", custom: "you set" };
  const when: Record<string, string> = {
    quick: "a fast gist",
    standard: "most questions",
    deep: "broad or contested topics",
    custom: "admin: dial it in",
  };
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 text-xs text-muted transition hover:text-ink"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
          <path d="M12 11v5M12 8h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        How the depths differ
      </button>
      {open && (
        <div className="fade-up mt-2 max-w-md rounded-xl border border-line bg-raised/60 p-3.5 text-[13px] leading-relaxed">
          <p className="text-ink">
            Every depth searches <strong className="font-semibold">all 1.1M moments</strong> — it only changes how
            many of the best it keeps, so the obscure finds surface either way.
          </p>
          <div className="mt-2.5 space-y-1.5">
            {modes.map((m) => (
              <div key={m.id} className="flex items-baseline gap-2">
                <span className="w-[4.5rem] shrink-0 font-medium text-ink">{m.label}</span>
                <span className="text-muted">
                  keeps <span className="text-gold2">{keeps[m.id] ?? "?"}</span> · ≈ {aed(m.usd)} · {when[m.id] ?? ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Rough "up to" cost of the admin custom depth: moments drive the cheap read (map) step, answer
// tokens drive the pricier write (reduce) step. Calibrated to the standard presets; the real cost
// always comes back with the answer. An over-estimate, since the answer rarely fills its whole budget.
const CUSTOM_MOMENTS_MAX = 10000;
const CUSTOM_TOKENS_MAX = 32000;
function estimateCost(moments: number, tokens: number): number {
  return 0.01 + moments * 0.00012 + tokens * 0.00001;
}

// One labelled control: a number box for an exact value + a slider to dial it, with a help line.
function Dial({
  label, value, min, max, step, unit, help, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  unit?: string; help: string; onChange: (n: number) => void;
}) {
  const clamp = (n: number) => Math.max(min, Math.min(max, Math.round(n / step) * step));
  return (
    <div className="mb-3.5 last:mb-0">
      <div className="flex items-baseline justify-between gap-2">
        <label className="font-medium text-ink">{label}</label>
        <span className="inline-flex items-baseline gap-1">
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange(clamp(Number(e.target.value) || min))}
            className="w-20 rounded-md border border-line bg-paper px-2 py-1 text-right text-[13px] tabular-nums text-ink outline-none focus:border-accent"
          />
          {unit && <span className="text-[12px] text-faint">{unit}</span>}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        className="mt-2 w-full accent-accent"
      />
      <p className="mt-1 text-[12px] leading-relaxed text-muted">{help}</p>
    </div>
  );
}

// Admin-only "Custom" depth: dial the moments read in and the answer's max length, with a live
// cost estimate. The brain clamps both; the helper text explains the limits and diminishing returns.
function CustomControls({
  moments, tokens, onMoments, onTokens, usd,
}: {
  moments: number; tokens: number; onMoments: (n: number) => void; onTokens: (n: number) => void; usd: number;
}) {
  const { t } = useLang();
  return (
    <div dir="auto" className="fade-up mt-3 w-full max-w-md rounded-xl border border-gold/30 bg-gold/[0.04] p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-ink">{t("custom.title")}</span>
        <span className="text-[13px] text-gold2">{t("custom.upto", { price: aed(usd) })}</span>
      </div>
      <Dial
        label={t("custom.moments.label")}
        value={moments}
        min={50}
        max={CUSTOM_MOMENTS_MAX}
        step={50}
        unit={t("custom.moments.unit")}
        help={t("custom.moments.help")}
        onChange={onMoments}
      />
      <Dial
        label={t("custom.tokens.label")}
        value={tokens}
        min={2000}
        max={CUSTOM_TOKENS_MAX}
        step={1000}
        unit={t("custom.tokens.unit")}
        help={t("custom.tokens.help")}
        onChange={onTokens}
      />
      <p className="mt-1 border-t border-gold/20 pt-2.5 text-[12px] leading-relaxed text-muted">{t("custom.note")}</p>
    </div>
  );
}

export default function Home() {
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "streaming" | "done" | "error">("idle");
  const [result, setResult] = useState<Answer | null>(null);
  const [streamText, setStreamText] = useState(""); // the answer so far, while it streams
  const [live, setLive] = useState(false); // a stream is in flight (so the stage copy follows events)
  const [error, setError] = useState<string>("");
  const [stage, setStage] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { user, loading: authLoading } = useAuth();
  const { t } = useLang();
  const [usedToday, setUsedToday] = useState(0);
  const [dailyCap, setDailyCap] = useState(DAILY_CAP); // per-account; an admin can raise it
  const [channels, setChannels] = useState<Channel[]>([]);
  const [modes, setModes] = useState<Mode[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState("standard");
  const [customMoments, setCustomMoments] = useState(1500); // admin "custom" depth: moments read in
  const [customTokens, setCustomTokens] = useState(16000);  // admin "custom" depth: answer length (tokens)
  const [style, setStyle] = useState<"topical" | "verbatim">("topical"); // how the answer is written
  const [answerStyle, setAnswerStyle] = useState<"topical" | "verbatim">("topical"); // the displayed answer's style
  const [totals, setTotals] = useState<{ moments: number; videos: number } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true); // open by default (desktop)
  const [chats, setChats] = useState<ChatDoc[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [guestOpen, setGuestOpen] = useState(false);

  // start collapsed on phones (where it's a full-screen overlay)
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 640) setSidebarOpen(false);
  }, []);

  // iOS tints the top/bottom safe-area strips (behind the status bar and home indicator) from
  // <meta theme-color>. On phones the sidebar's translucent backdrop paints over those strips and
  // iOS can leave the darkened blend stuck there after it closes. Re-point the meta on every
  // toggle — dimmed while open (so the bars match the backdrop), paper when closed — which forces
  // iOS to repaint the strips, so nothing stale is left behind.
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) return;
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    const paper = dark ? "#16150f" : "#fafaf8";
    const dim = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const b = (c: number) => Math.round(c * 0.6);
      return "#" + ((1 << 24) + (b((n >> 16) & 255) << 16) + (b((n >> 8) & 255) << 8) + b(n & 255)).toString(16).slice(1);
    };
    const mobile = window.matchMedia("(max-width: 639px)").matches;
    meta.setAttribute("content", mobile && sidebarOpen ? dim(paper) : paper);
  }, [sidebarOpen]);

  // live daily usage for the signed-in user (the server writes it; the rules let a user read their own)
  useEffect(() => {
    if (!user) {
      setUsedToday(0);
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    return onSnapshot(
      doc(db, "users", user.uid),
      (snap) => {
        const d = snap.data() as { day?: string; count?: number; cap?: number } | undefined;
        setUsedToday(d && d.day === today ? d.count ?? 0 : 0);
        setDailyCap(typeof d?.cap === "number" && d.cap > 0 ? d.cap : DAILY_CAP);
      },
      () => setUsedToday(0)
    );
  }, [user]);

  // the user's saved chat history (newest first), read live from their own subcollection
  useEffect(() => {
    if (!user) {
      setChats([]);
      return;
    }
    const qy = query(collection(db, "users", user.uid, "chats"), orderBy("createdAt", "desc"), limit(40));
    return onSnapshot(
      qy,
      (snap) => setChats(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ChatDoc, "id">) }))),
      () => setChats([])
    );
  }, [user]);

  // is this account an admin? (only controls whether the admin panel is offered; the server
  // re-checks on every admin action, so this can't grant anything on its own)
  useEffect(() => {
    if (!user) {
      setIsAdmin(false);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const token = await idToken();
        if (!token) return;
        const r = await fetch("/api/admin/me", { headers: { Authorization: `Bearer ${token}` } });
        const d = await r.json().catch(() => ({}));
        if (alive) setIsAdmin(!!d.admin);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, [user]);

  // save one answered question to history; load / delete past ones from the sidebar
  async function saveChat(q: string, answer: string | null, sources: Source[], coverage: Coverage, cost?: number) {
    if (!user || !answer) return;
    try {
      await addDoc(collection(db, "users", user.uid, "chats"), {
        q,
        answer,
        // keep the transcript window + cited line so a reopened chat shows its transcripts
        sources: sources.map((s) => ({
          n: s.n,
          timestamp: s.timestamp,
          title: s.title,
          channel: s.channel ?? null,
          date: s.date ?? null,
          url: s.url,
          video_id: s.video_id ?? null,
          slug: s.slug ?? null,
          context: (s.context ?? []).map((l) => ({ ts: l.ts ?? null, text: l.text })),
          citedIdx: s.citedIdx ?? 0,
        })),
        coverage,
        cost_usd: cost ?? null,
        // the style the answer was actually asked in (`style`); answerStyle is the displayed copy and
        // lags a render behind when saving right after asking, so it would save the wrong style.
        style,
        createdAt: serverTimestamp(),
      });
    } catch {
      /* best-effort: never block the answer on a history write */
    }
  }

  function openChat(c: ChatDoc) {
    setAsked(c.q);
    setAnswerStyle(c.style === "verbatim" ? "verbatim" : "topical");
    setResult({ q: c.q, empty: false, answer: c.answer, sources: c.sources || [], coverage: c.coverage, cost_usd: c.cost_usd ?? undefined });
    setStatus("done");
    setStreamText("");
    setError("");
    setReturnY(null);
    setCurrentChatId(c.id);
    if (window.innerWidth < 640) setSidebarOpen(false);
    window.scrollTo({ top: 0 });
  }

  async function deleteChat(id: string) {
    if (!user) return;
    if (currentChatId === id) newChat();
    try {
      await deleteDoc(doc(db, "users", user.uid, "chats", id));
    } catch {
      /* ignore */
    }
  }

  // load the channel list + depth modes for the pickers, once signed in. The token lets the server
  // hide admin-hidden channels from non-admins.
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const token = await idToken();
        const r = await fetch("/api/channels", token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
        const d = await r.json();
        const chs: Channel[] = Array.isArray(d.channels) ? d.channels : [];
        setChannels(chs);
        setSelected(new Set(chs.map((c) => c.slug)));
        if (Array.isArray(d.modes) && d.modes.length) setModes(d.modes);
        if (d.default_mode) setMode(d.default_mode);
        if (typeof d.total_moments === "number" && typeof d.total_videos === "number") {
          setTotals({ moments: d.total_moments, videos: d.total_videos });
        }
      } catch {
        /* ignore */
      }
    })();
  }, [user]);

  // cycle the loading stage copy while we wait — only for the non-streaming fallback; when a stream
  // is live the real status events drive the stage instead.
  useEffect(() => {
    if (status !== "loading" || live) return;
    setStage(0);
    const id = setInterval(() => setStage((s) => Math.min(s + 1, STAGE_KEYS.length - 1)), 2600);
    return () => clearInterval(id);
  }, [status, live]);

  async function ask(question: string) {
    const text = question.trim();
    if (!text || status === "loading" || status === "streaming") return;
    // a guest who's used their free questions is nudged to sign up rather than asking again
    if (user?.isAnonymous && usedToday >= GUEST_CAP) {
      setGuestOpen(true);
      return;
    }
    setAsked(text);
    setAnswerStyle(style);
    setStatus("loading");
    setStage(0);
    setStreamText("");
    setResult(null);
    setError("");
    setReturnY(null);
    setCiteToast(null);
    const token = await idToken();
    if (!token) {
      setError(t("err.signInAgain"));
      setStatus("error");
      return;
    }
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    const useSubset = channels.length > 0 && selected.size > 0 && selected.size < channels.length;
    const custom = mode === "custom" && isAdmin ? { cand_max: customMoments, answer_max: customTokens } : {};
    const payload = { question: text, mode, style, channels: useSubset ? [...selected] : undefined, ...custom };
    // Prefer the streaming answer; fall back to the one-shot endpoint if a stream can't be opened.
    setLive(true);
    try {
      await streamAnswer(text, payload, headers);
      return;
    } catch {
      /* stream unavailable — fall through to /api/ask */
    }
    setLive(false);
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const data: Answer & { guest?: boolean } = await r.json();
      if (!r.ok || data.error) {
        if (data.guest) {
          setGuestOpen(true);
          setStatus("idle");
          return;
        }
        setError(data.error || t("err.generic"));
        setStatus("error");
        return;
      }
      setResult(data);
      setStatus("done");
      setCurrentChatId(null);
      saveChat(text, data.answer, data.sources || [], data.coverage, data.cost_usd);
    } catch {
      setError(t("err.server"));
      setStatus("error");
    }
  }

  // Open the SSE stream and drive the UI from its events. Returns once a terminal event (done /
  // empty / handled error) is reached; throws before any answer text shows so ask() can fall back.
  async function streamAnswer(text: string, payload: object, headers: HeadersInit) {
    const r = await fetch("/api/ask/stream", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!r.ok || !r.body) {
      // 404/405 = the stream route isn't there (old deploy) -> fall back to /api/ask. Anything else
      // (sign-in, daily cap, brain error) is shown directly, so it isn't retried and double-counted.
      if (r.status && r.status !== 404 && r.status !== 405) {
        const data = await r.json().catch(() => ({}));
        if ((data as { guest?: boolean }).guest) {
          setGuestOpen(true);
          setStatus("idle");
          setLive(false);
          return;
        }
        setError((data as { error?: string }).error || t("err.generic"));
        setStatus("error");
        setLive(false);
        return;
      }
      throw new Error("stream unavailable");
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let acc = "";
    const srcs: Source[] = []; // evidences accumulate as their citations stream in
    let gotDelta = false;
    let done: { coverage: Coverage; cost_usd?: number } | null = null;
    const EMPTY_COV: Coverage = { moments: 0, videos: 0, channels: 0 };
    // Coalesce token updates to one render per frame — re-parsing the whole answer on every token
    // janks the stream on phones.
    let rafPending = false;
    const flush = () => {
      rafPending = false;
      setStreamText(acc);
    };
    const scheduleRender = () => {
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(flush);
      }
    };

    for (;;) {
      const { done: fin, value } = await reader.read();
      if (fin) break;
      buf += dec.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let ev = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        let obj: { stage?: string; text?: string; error?: string; coverage?: Coverage; cost_usd?: number } & Partial<Source>;
        try {
          obj = JSON.parse(data);
        } catch {
          continue;
        }
        if (ev === "status") {
          setStage(STAGE_IDX[obj.stage ?? ""] ?? 1);
        } else if (ev === "delta") {
          if (!gotDelta) setStatus("streaming");
          gotDelta = true;
          acc += obj.text || "";
          scheduleRender();
        } else if (ev === "source") {
          // the brain now streams sources after the answer; collect them and show them once it's done
          srcs.push(obj as Source);
        } else if (ev === "empty") {
          setResult({ q: text, empty: true, answer: null, sources: [], coverage: EMPTY_COV });
          setStatus("done");
          setLive(false);
          return;
        } else if (ev === "done") {
          done = { coverage: obj.coverage || EMPTY_COV, cost_usd: obj.cost_usd };
        } else if (ev === "error") {
          if (gotDelta) {
            // answer already started showing — surface the error rather than silently re-running
            setError(obj.error || t("err.generic"));
            setStatus("error");
            setLive(false);
            return;
          }
          throw new Error(obj.error || "stream error");
        }
      }
    }
    if (done) {
      setResult({ q: text, empty: false, answer: acc, sources: srcs, coverage: done.coverage, cost_usd: done.cost_usd });
      setStatus("done");
      setLive(false);
      setCurrentChatId(null);
      saveChat(text, acc, srcs, done.coverage, done.cost_usd);
      return;
    }
    if (gotDelta) {
      // stream ended mid-answer: keep what we have, with whatever evidences arrived
      setResult({ q: text, empty: false, answer: acc, sources: srcs, coverage: EMPTY_COV });
      setStatus("done");
      setLive(false);
      setCurrentChatId(null);
      saveChat(text, acc, srcs, EMPTY_COV);
      return;
    }
    throw new Error("no data"); // nothing arrived — let ask() fall back
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    ask(q);
  }

  // start a fresh question — the landing hero + empty ask bar (a soft reset, no reload)
  function newChat() {
    setAsked(null);
    setResult(null);
    setStatus("idle");
    setError("");
    setQ("");
    setStreamText("");
    setReturnY(null);
    setCiteToast(null);
    setCurrentChatId(null);
    if (window.innerWidth < 640) setSidebarOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function scrollToSource(n: number, e?: React.MouseEvent) {
    const el = document.getElementById(`src-${n}`);
    if (!el) {
      // the sources stream in after the answer: a citation can be clicked before its card exists.
      // Tell the reader it's still loading (rather than the click doing nothing), near the cursor.
      const msg = status === "done" ? t("cite.missing") : t("cite.loading");
      const x = e ? Math.min(Math.max(e.clientX, 130), window.innerWidth - 130) : window.innerWidth / 2;
      const y = e ? e.clientY : 120;
      setCiteToast({ x, y, msg });
      return;
    }
    setReturnY(window.scrollY); // remember where the citation was, for the jump-back button
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("src-hit");
    setTimeout(() => el.classList.remove("src-hit"), 1600);
  }

  const [returnY, setReturnY] = useState<number | null>(null);
  const [citeToast, setCiteToast] = useState<{ x: number; y: number; msg: string } | null>(null);
  // the "still loading" note fades itself out; it also clears whenever a new question starts
  useEffect(() => {
    if (!citeToast) return;
    const id = setTimeout(() => setCiteToast(null), 2800);
    return () => clearTimeout(id);
  }, [citeToast]);
  const landing = status === "idle";
  const noneSelected = channels.length > 0 && selected.size === 0;
  // admins get a 4th "Custom" depth whose cost tracks the dials; everyone else sees the server's modes
  const customUsd = estimateCost(customMoments, customTokens);
  const displayModes: Mode[] = isAdmin ? [...modes, { id: "custom", label: t("mode.custom"), usd: customUsd }] : modes;
  const modeUsd = displayModes.find((m) => m.id === mode)?.usd ?? TYPICAL_COST;

  if (authLoading) {
    return <main className="grid min-h-[70vh] place-items-center text-sm text-faint">Loading…</main>;
  }
  if (!user) {
    return <SignIn />;
  }

  return (
    <>
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen(false)}
        onClose={() => setSidebarOpen(false)}
        chats={chats}
        currentChatId={currentChatId}
        onOpenChat={openChat}
        onDeleteChat={deleteChat}
        onNew={newChat}
        email={user.email ?? ""}
        usedToday={usedToday}
        dailyCap={user.isAnonymous ? GUEST_CAP : dailyCap}
        isGuest={!!user.isAnonymous}
        isAdmin={isAdmin}
        onOpenAdmin={() => setAdminOpen(true)}
      />
      {adminOpen && <AdminPanel onClose={() => setAdminOpen(false)} />}
      {guestOpen && <GuestPrompt onClose={() => setGuestOpen(false)} />}
      {!user.isAnonymous && <UpdatePopup />}
      <div className={`transition-[margin] duration-200 ${sidebarOpen ? "ltr:sm:ml-[264px] rtl:sm:mr-[264px]" : ""}`}>
        <main className={`mx-auto w-full max-w-3xl px-5 ${landing ? "pb-10" : "pb-28"}`}>
          {/* top bar: open the sidebar (always on phones; on desktop only when it's collapsed) */}
          <div className="flex items-center gap-1 py-4 sm:py-5">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label={t("aria.openMenu")}
              className={`-ml-1 rounded-md p-1.5 text-faint transition hover:bg-line/40 hover:text-ink ${sidebarOpen ? "sm:hidden" : ""}`}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
            <button type="button" onClick={newChat} aria-label="La Tafti" className="rounded-md p-1 transition hover:opacity-75 sm:hidden">
              <Wordmark />
            </button>
            <div className="ms-auto">
              <LangToggle />
            </div>
          </div>

          {/* hero + suggestions + ask (ask block anchored to the bottom of the viewport on landing) */}
      <section className={landing ? "flex min-h-[calc(100dvh-6rem)] flex-col pt-6" : "pt-5"}>
        {landing && (
          <div className="fade-up mb-6 sm:mb-8">
            <h1 dir="auto" className="max-w-2xl text-balance font-serif text-[1.6rem] font-medium leading-[1.14] tracking-tight text-ink sm:text-[2.7rem] sm:leading-[1.12]">
              {t("hero.title")}
            </h1>
            <p dir="auto" className="mt-3 max-w-xl text-[14px] leading-relaxed text-muted sm:mt-4 sm:text-[16px]">
              {t("hero.subtitle")}
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3 sm:mt-7 sm:gap-x-10 sm:gap-y-4">
              <Stat n={totals ? heroVideos(totals.videos) : "20,000+"} label={t("hero.videos")} />
              <span className="hidden h-10 w-px bg-line sm:block" />
              <Stat n={totals ? heroMoments(totals.moments) : "1.1M+"} label={t("hero.moments")} />
              <span className="hidden h-10 w-px bg-line sm:block" />
              <Stat n={String(channels.length || 19)} label={t("hero.channels")} />
            </div>
          </div>
        )}

        {/* anchored to the bottom of the viewport on landing */}
        <div className={landing ? "mt-auto" : ""}>
          {/* suggestions */}
          {landing && (
            <div className="fade-up mb-5">
              <p className="mb-2.5 text-xs text-faint">{t("hero.try")}</p>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                {EX_KEYS.map((k) => {
                  const ex = t(k);
                  return (
                    <button
                      key={k}
                      dir="auto"
                      onClick={() => {
                        setQ(ex);
                        ask(ex);
                      }}
                      className="rounded-lg border border-line bg-raised/60 px-3.5 py-2 text-start text-[13.5px] text-muted transition hover:border-line2 hover:text-ink"
                    >
                      {ex}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* controls ABOVE the bar: scope / cost on top, the pickers sit right above the bar */}
          {channels.length > 0 && (
            <>
              {/* compact dropdowns: always on phones, and on desktop too once a question is asked
                  (the ask bar sits at the top then, so the expanded controls would just clutter) */}
              <div className={`mb-4 flex items-center justify-end gap-2 ${landing ? "sm:hidden" : ""}`}>
                <StyleToggle value={style} onChange={setStyle} />
                <ChannelPicker channels={channels} selected={selected} onChange={setSelected} compact dropUp={landing} />
                <ModeDropup modes={displayModes} mode={mode} onChange={setMode} dropUp={landing} />
                {noneSelected && <span className="text-[13px] text-danger">{t("controls.pickChannel")}</span>}
              </div>

              {/* desktop landing only: channel + scope (left); mode + cost + explainer (right) */}
              <div className={landing ? "mb-3 hidden sm:flex sm:flex-row sm:items-end sm:justify-between sm:gap-3" : "hidden"}>
                <div className="flex flex-col items-start gap-2">
                  {noneSelected ? (
                    <p className="text-[13px] text-danger">{t("controls.pickOne")}</p>
                  ) : (
                    <p className="text-[13px] text-faint">
                      {t("controls.channelCount", { n: selected.size, s: selected.size === 1 ? "" : "s" })}
                    </p>
                  )}
                  <ChannelPicker channels={channels} selected={selected} onChange={setSelected} />
                </div>
                <div className="flex flex-col items-end gap-2">
                  <ModeExplainer modes={displayModes} />
                  <p className="text-[13px] text-gold2">{t("controls.perAnswer", { price: aed(modeUsd) })}</p>
                  <div className="flex items-center gap-2">
                    <StyleToggle value={style} onChange={setStyle} />
                    <ModePicker modes={displayModes} mode={mode} onChange={setMode} />
                  </div>
                </div>
              </div>

              {/* admin "Custom" depth: the two dials + live estimate, shown when that mode is picked */}
              {mode === "custom" && isAdmin && (
                <div className="mb-3 flex justify-end">
                  <CustomControls
                    moments={customMoments}
                    tokens={customTokens}
                    onMoments={setCustomMoments}
                    onTokens={setCustomTokens}
                    usd={customUsd}
                  />
                </div>
              )}
            </>
          )}

          {/* ask bar */}
          <form onSubmit={onSubmit}>
            <div className="group flex items-end gap-2 rounded-2xl border border-line bg-raised/90 p-2 pl-4 shadow-[0_2px_8px_rgba(35,33,27,0.04),0_14px_40px_-20px_rgba(35,33,27,0.25)] backdrop-blur transition focus-within:border-accent focus-within:shadow-[0_2px_8px_rgba(15,107,87,0.06),0_14px_40px_-18px_rgba(15,107,87,0.3)]">
              <textarea
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    ask(q);
                  }
                }}
                rows={1}
                dir="auto"
                placeholder={t("ask.placeholder")}
                /* 16px keeps iOS Safari from auto-zooming when the field is focused */
                className="max-h-40 flex-1 resize-none bg-transparent py-2 text-[16px] leading-relaxed text-ink outline-none placeholder:text-faint"
              />
              <button
                type="submit"
                disabled={!q.trim() || status === "loading" || noneSelected}
                aria-label={t("ask.submit")}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-paper transition enabled:hover:bg-accent2 disabled:opacity-30"
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </form>
        </div>

      </section>

      {/* conversation area */}
      {asked && (
        <section className="mt-9">
          {/* topical answers are AI-synthesized, so flag that up front (verbatim quotes don't need it) */}
          {answerStyle === "topical" && (status === "streaming" || (status === "done" && result && !result.empty)) && (
            <div dir="auto" className="mb-5 flex items-start gap-2 rounded-lg border border-gold/30 bg-gold/[0.05] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-gold2">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden className="mt-0.5 shrink-0">
                <path d="M12 9v4m0 4h.01M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>{t("style.disclaimer")}</span>
            </div>
          )}
          <div className="flex items-start justify-between gap-4">
            <h2 dir="auto" className="min-w-0 font-serif text-[1.4rem] font-medium leading-snug text-ink">
              {asked}
            </h2>
            {status === "done" && result && !result.empty && result.sources.length > 0 ? (
              <button
                type="button"
                onClick={() => document.getElementById("sources")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                className="mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-raised/60 px-2.5 py-1 text-[12px] text-muted transition hover:border-line2 hover:text-ink"
              >
                {t("answer.skip")}
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M12 5v14M12 19l-6-6M12 19l6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ) : status === "loading" || status === "streaming" ? (
              // sources aren't ready yet: show the chip with a glow rotating round its border
              <span
                className="skip-loading mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-raised/60 px-2.5 py-1 text-[12px] text-muted"
                aria-label={t("answer.findingVideos")}
                title={`${t("answer.findingVideos")}…`}
              >
                {t("answer.skip")}
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden className="opacity-60">
                  <path d="M12 5v14M12 19l-6-6M12 19l6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            ) : null}
          </div>

          {status === "loading" && <Loading stage={stage} />}

          {status === "streaming" && (
            <StreamingAnswer text={streamText} question={asked ?? undefined} onCite={scrollToSource} />
          )}

          {status === "error" && (
            <div className="mt-5 rounded-xl border border-danger/25 bg-danger/[0.06] px-4 py-3 text-sm text-danger">
              {error}
            </div>
          )}

          {status === "done" && result && <AnswerView result={result} onCite={scrollToSource} />}
        </section>
      )}

      {/* citation clicked before its source card exists yet (sources stream in after the answer) */}
      {citeToast && (
        <div
          role="status"
          dir="auto"
          style={{ left: citeToast.x, top: Math.max(citeToast.y - 12, 12) }}
          className="fade-up pointer-events-none fixed z-50 max-w-[240px] -translate-x-1/2 -translate-y-full rounded-lg border border-line bg-raised px-3 py-2 text-center text-[12.5px] leading-snug text-ink shadow-[0_12px_34px_-10px_rgba(35,33,27,0.45)]"
        >
          {citeToast.msg}
        </div>
      )}

      {/* jump-back: appears after a citation jump, returns you to where you were reading */}
      {returnY !== null && (
        <button
          type="button"
          aria-label="Back to where you were"
          onClick={() => {
            window.scrollTo({ top: returnY, behavior: "smooth" });
            setReturnY(null);
          }}
          className="fixed bottom-6 left-1/2 z-40 grid h-11 w-11 -translate-x-1/2 place-items-center rounded-full bg-accent text-paper shadow-[0_8px_30px_-6px_rgba(15,107,87,0.5)] transition hover:bg-accent2"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
        </main>
      </div>
    </>
  );
}

/* Collapsible left panel (like an LLM): the user's saved chat history, a "new question" button,
   and the display + account settings at the bottom. An overlay on phones, pinned on desktop. */
function Sidebar({
  open,
  onToggle,
  onClose,
  chats,
  currentChatId,
  onOpenChat,
  onDeleteChat,
  onNew,
  email,
  usedToday,
  dailyCap,
  isGuest,
  isAdmin,
  onOpenAdmin,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  chats: ChatDoc[];
  currentChatId: string | null;
  onOpenChat: (c: ChatDoc) => void;
  onDeleteChat: (id: string) => void;
  onNew: () => void;
  email: string;
  usedToday: number;
  dailyCap: number;
  isGuest: boolean;
  isAdmin: boolean;
  onOpenAdmin: () => void;
}) {
  const { t } = useLang();
  return (
    <>
      {/* kept mounted and faded (not abruptly unmounted) so iOS repaints the safe-area strips cleanly */}
      <div
        onClick={onClose}
        aria-hidden
        className={`fixed inset-0 z-30 bg-black/40 transition-opacity duration-200 sm:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <aside
        className={`fixed inset-y-0 start-0 z-40 flex w-[264px] flex-col border-line bg-raised transition-transform duration-200 ltr:left-0 ltr:border-r rtl:right-0 rtl:border-l ${
          open ? "translate-x-0" : "ltr:-translate-x-full rtl:translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between px-3 py-3">
          <button type="button" onClick={onNew} aria-label="La Tafti — new question" className="-m-1 rounded-md p-1 transition hover:opacity-75">
            <Wordmark />
          </button>
          <button type="button" onClick={onToggle} aria-label={t("aria.collapse")} title={t("aria.collapse")} className="rounded-md p-1.5 text-faint transition hover:bg-line/40 hover:text-ink">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden className="rtl:-scale-x-100">
              <path d="m15 6-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        <div className="px-3 pb-2">
          <button type="button" onClick={onNew} className="flex w-full items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2 text-sm font-medium text-ink transition hover:border-line2">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            {t("sidebar.new")}
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-1">
          {chats.length === 0 ? (
            <p className="px-2 py-3 text-[12px] leading-relaxed text-faint">{t("sidebar.empty")}</p>
          ) : (
            chats.map((c) => (
              <div
                key={c.id}
                className={`group/chat relative rounded-lg transition ${c.id === currentChatId ? "bg-line/60" : "hover:bg-line/30"}`}
              >
                <button type="button" onClick={() => onOpenChat(c)} dir="auto" title={c.q} className="block w-full truncate rounded-lg px-2.5 py-2 pe-7 text-start text-[13px] text-ink">
                  {c.q}
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteChat(c.id)}
                  aria-label={t("aria.deleteQuestion")}
                  title={t("aria.deleteQuestion")}
                  className="absolute end-1 top-1/2 -translate-y-1/2 rounded p-1 text-faint opacity-100 transition hover:text-danger sm:opacity-0 sm:group-hover/chat:opacity-100"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            ))
          )}
        </nav>

        <div className="space-y-2.5 border-t border-line p-3">
          <div className="flex items-center justify-between text-[13px] text-muted">
            <span>{t("sidebar.theme")}</span>
            <ThemeSelector />
          </div>
          {isAdmin && (
            <button
              type="button"
              onClick={onOpenAdmin}
              className="flex w-full items-center gap-2 border-t border-line pt-2.5 text-start text-[13px] text-muted transition hover:text-ink"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 3 4 6v6c0 4.5 3.2 7.3 8 9 4.8-1.7 8-4.5 8-9V6l-8-3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              </svg>
              {t("sidebar.admin")}
            </button>
          )}
          <div className="flex items-center justify-between gap-2 border-t border-line pt-2.5">
            <div className="min-w-0">
              <p className="truncate text-[12px] text-ink" dir={isGuest ? "auto" : "ltr"} title={email}>
                {isGuest ? t("guest.label") : email || "Signed in"}
              </p>
              <p className="text-[11px] text-faint">
                {isGuest
                  ? t("guest.usage", { used: usedToday, cap: dailyCap })
                  : t("sidebar.answersToday", { used: usedToday, cap: dailyCap })}
              </p>
            </div>
            <button type="button" onClick={() => signOutUser()} aria-label={t("aria.signout")} title={t("aria.signout")} className="shrink-0 rounded-md p-1.5 text-faint transition hover:bg-line/40 hover:text-ink rtl:-scale-x-100">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M15 12H3m0 0 3.5-3.5M3 12l3.5 3.5M9 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          <div className="flex items-center gap-2 pt-0.5 text-[11px] text-faint">
            <a href="/privacy" className="transition hover:text-ink">{t("footer.privacy")}</a>
            <span aria-hidden>·</span>
            <a href="/terms" className="transition hover:text-ink">{t("footer.terms")}</a>
          </div>
        </div>
      </aside>
    </>
  );
}

/* Admin-only: raise or reset each account's per-day answer limit. Every action is re-checked
   server-side, so this panel can't grant anything the caller isn't already allowed to do. */
type AdminUser = { uid: string; email: string; cap: number | null; usedToday: number; show: string[] };
type NamedChannel = { slug: string; name: string };

function AdminPanel({ onClose }: { onClose: () => void }) {
  const { t } = useLang();
  const [tab, setTab] = useState<"accounts" | "channels">("accounts");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div className="relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-raised shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex gap-1">
            {(["accounts", "channels"] as const).map((tb) => (
              <button
                key={tb}
                type="button"
                onClick={() => setTab(tb)}
                className={`rounded-md px-3 py-1.5 text-[13px] transition ${
                  tab === tb ? "bg-line/60 text-ink" : "text-muted hover:text-ink"
                }`}
              >
                {t(tb === "accounts" ? "admin.tab.accounts" : "admin.tab.channels")}
              </button>
            ))}
          </div>
          <button type="button" onClick={onClose} aria-label={t("admin.close")} className="rounded-md p-1.5 text-faint transition hover:bg-line/40 hover:text-ink">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {tab === "accounts" ? <AccountsTab /> : <ChannelsTab />}
      </div>
    </div>
  );
}

function AccountsTab() {
  const { t } = useLang();
  const [rows, setRows] = useState<AdminUser[]>([]);
  const [defaultCap, setDefaultCap] = useState(DAILY_CAP);
  const [defaultVal, setDefaultVal] = useState(""); // the default-cap input (site-wide, admin-editable)
  const [savingDefault, setSavingDefault] = useState(false);
  const [hiddenChannels, setHiddenChannels] = useState<NamedChannel[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [err, setErr] = useState("");
  const [savingUid, setSavingUid] = useState<string | null>(null);
  const [savingChUid, setSavingChUid] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const token = await idToken();
        const r = await fetch("/api/admin/users", { headers: { Authorization: `Bearer ${token}` } });
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        if (!r.ok) {
          setErr(d.error || t("admin.couldntLoadAccounts"));
          setStatus("error");
          return;
        }
        setRows(d.users || []);
        setDefaultCap(d.defaultCap ?? DAILY_CAP);
        setDefaultVal(String(d.defaultCap ?? DAILY_CAP));
        setHiddenChannels(Array.isArray(d.hiddenChannels) ? d.hiddenChannels : []);
        setStatus("ready");
      } catch {
        if (alive) {
          setErr(t("admin.couldntReach"));
          setStatus("error");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // set the site-wide default daily limit for everyone (admin only; the brain re-checks on each ask)
  async function saveDefaultCap() {
    const n = Number(defaultVal);
    if (!Number.isFinite(n) || n < 1) return;
    setSavingDefault(true);
    try {
      const token = await idToken();
      const r = await fetch("/api/admin/cap", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ defaultCap: n }),
      });
      if (r.ok) setDefaultCap(n);
    } finally {
      setSavingDefault(false);
    }
  }

  async function saveCap(uid: string, cap: number | null) {
    setSavingUid(uid);
    try {
      const token = await idToken();
      const r = await fetch("/api/admin/cap", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ uid, cap }),
      });
      if (r.ok) setRows((rs) => rs.map((u) => (u.uid === uid ? { ...u, cap } : u)));
    } finally {
      setSavingUid(null);
    }
  }

  async function saveChannels(uid: string, show: string[]) {
    setSavingChUid(uid);
    try {
      const token = await idToken();
      const r = await fetch("/api/admin/user-channels", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ uid, show }),
      });
      if (r.ok) {
        const d = await r.json().catch(() => ({}));
        const saved = Array.isArray(d.show) ? d.show : show;
        setRows((rs) => rs.map((u) => (u.uid === uid ? { ...u, show: saved } : u)));
      }
    } finally {
      setSavingChUid(null);
    }
  }

  return (
    <>
      <p className="px-5 pt-3 text-[12px] leading-relaxed text-faint">
        {t("admin.accounts.help", { cap: defaultCap })}
        {hiddenChannels.length > 0 ? t("admin.accounts.helpChannels") : ""}
      </p>
      <div className="flex items-center gap-2 px-5 pb-1 pt-2">
        <span className="text-[12px] font-medium text-ink">{t("admin.defaultCapLabel")}</span>
        <input
          inputMode="numeric"
          value={defaultVal}
          onChange={(e) => setDefaultVal(e.target.value.replace(/[^0-9]/g, ""))}
          placeholder={String(defaultCap)}
          aria-label={t("admin.defaultCapLabel")}
          className="w-16 rounded-md border border-line bg-paper px-2 py-1 text-end text-[13px] text-ink outline-none focus:border-line2"
        />
        <button
          type="button"
          onClick={saveDefaultCap}
          disabled={savingDefault || defaultVal.trim() === "" || Number(defaultVal) === defaultCap}
          className="shrink-0 rounded-md border border-line px-2.5 py-1 text-[12px] text-muted transition enabled:hover:border-line2 enabled:hover:text-ink disabled:opacity-40"
        >
          {savingDefault ? "…" : t("admin.save")}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {status === "loading" && <p className="px-2 py-6 text-center text-sm text-faint">{t("admin.loading")}</p>}
        {status === "error" && <p className="px-2 py-6 text-center text-sm text-danger">{err}</p>}
        {status === "ready" && rows.length === 0 && <p className="px-2 py-6 text-center text-sm text-faint">{t("admin.noAccounts")}</p>}
        {status === "ready" &&
          rows.map((u) => (
            <AdminRow
              key={u.uid}
              user={u}
              defaultCap={defaultCap}
              hiddenChannels={hiddenChannels}
              saving={savingUid === u.uid}
              savingChannels={savingChUid === u.uid}
              onSave={(cap) => saveCap(u.uid, cap)}
              onSaveChannels={(show) => saveChannels(u.uid, show)}
            />
          ))}
      </div>
    </>
  );
}

/* Choose which channels are hidden from non-admin accounts (enforced server-side in /api/ask too). */
function ChannelsTab() {
  const { t } = useLang();
  const [channels, setChannels] = useState<{ slug: string; name: string }[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<NameMap>({});
  const [origHidden, setOrigHidden] = useState("[]");
  const [origNames, setOrigNames] = useState("{}");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const token = await idToken();
        const r = await fetch("/api/admin/channels", { headers: { Authorization: `Bearer ${token}` } });
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        if (!r.ok) {
          setErr(d.error || t("admin.couldntLoadChannels"));
          setStatus("error");
          return;
        }
        const hid: string[] = Array.isArray(d.hidden) ? d.hidden : [];
        const nm: NameMap = d.names && typeof d.names === "object" ? d.names : {};
        setChannels(Array.isArray(d.channels) ? d.channels : []);
        setHidden(new Set(hid));
        setNames(nm);
        setOrigHidden(JSON.stringify([...hid].sort()));
        setOrigNames(normNames(nm));
        setStatus("ready");
      } catch {
        if (alive) {
          setErr(t("admin.couldntReach"));
          setStatus("error");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const dirty = JSON.stringify([...hidden].sort()) !== origHidden || normNames(names) !== origNames;

  function toggle(slug: string) {
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  function setName(slug: string, field: "en" | "ar", value: string) {
    setNames((n) => ({ ...n, [slug]: { ...n[slug], [field]: value } }));
  }

  async function save() {
    setSaving(true);
    try {
      const token = await idToken();
      const clean = cleanNames(names);
      const r = await fetch("/api/admin/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ hidden: [...hidden], names: clean }),
      });
      if (r.ok) {
        setOrigHidden(JSON.stringify([...hidden].sort()));
        setOrigNames(normNames(clean));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <p className="px-5 pt-3 text-[12px] leading-relaxed text-faint">{t("admin.channels.help")}</p>
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {status === "loading" && <p className="px-2 py-6 text-center text-sm text-faint">{t("admin.loading")}</p>}
        {status === "error" && <p className="px-2 py-6 text-center text-sm text-danger">{err}</p>}
        {status === "ready" && channels.length === 0 && <p className="px-2 py-6 text-center text-sm text-faint">{t("admin.noChannels")}</p>}
        {status === "ready" &&
          channels.map((c) => {
            const isHidden = hidden.has(c.slug);
            const nm = names[c.slug] || {};
            return (
              <div key={c.slug} className="rounded-lg px-2 py-2 hover:bg-line/20">
                <div className="flex items-center justify-between gap-2">
                  <span className={`min-w-0 flex-1 truncate text-[13px] ${isHidden ? "text-faint line-through" : "text-ink"}`} title={c.name}>
                    {c.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggle(c.slug)}
                    className={`shrink-0 rounded-md border px-2.5 py-1 text-[12px] transition ${
                      isHidden
                        ? "border-line text-faint hover:text-ink"
                        : "border-accent/40 text-accent hover:border-accent"
                    }`}
                  >
                    {isHidden ? t("admin.hidden") : t("admin.visible")}
                  </button>
                </div>
                <div className="mt-1.5 flex gap-1.5">
                  <input
                    value={nm.en ?? ""}
                    onChange={(e) => setName(c.slug, "en", e.target.value)}
                    placeholder={t("admin.channels.enName")}
                    dir="ltr"
                    className="min-w-0 flex-1 rounded-md border border-line bg-paper px-2 py-1 text-[12px] text-ink outline-none transition focus:border-accent"
                  />
                  <input
                    value={nm.ar ?? ""}
                    onChange={(e) => setName(c.slug, "ar", e.target.value)}
                    placeholder={t("admin.channels.arName")}
                    dir="rtl"
                    className="min-w-0 flex-1 rounded-md border border-line bg-paper px-2 py-1 text-[12px] text-ink outline-none transition focus:border-accent"
                  />
                </div>
              </div>
            );
          })}
      </div>
      {status === "ready" && (
        <div className="flex items-center justify-end border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            className="rounded-md border border-line px-3 py-1.5 text-[13px] text-muted transition enabled:hover:border-line2 enabled:hover:text-ink disabled:opacity-40"
          >
            {saving ? t("admin.saving") : t("admin.saveChanges")}
          </button>
        </div>
      )}
    </>
  );
}

function AdminRow({
  user,
  defaultCap,
  hiddenChannels,
  saving,
  savingChannels,
  onSave,
  onSaveChannels,
}: {
  user: AdminUser;
  defaultCap: number;
  hiddenChannels: NamedChannel[];
  saving: boolean;
  savingChannels: boolean;
  onSave: (cap: number | null) => void;
  onSaveChannels: (show: string[]) => void;
}) {
  const { t } = useLang();
  const [val, setVal] = useState(user.cap != null ? String(user.cap) : "");
  const [expanded, setExpanded] = useState(false);
  const [show, setShow] = useState<Set<string>>(new Set(user.show));
  const norm = val.trim() === "" ? null : Number(val);
  const dirty = norm !== user.cap;
  const showDirty = JSON.stringify([...show].sort()) !== JSON.stringify([...user.show].sort());

  return (
    <div className="rounded-lg px-2 py-2 hover:bg-line/20">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] text-ink" dir="ltr" title={user.email}>{user.email || user.uid}</p>
          <p className="text-[11px] text-faint">
            {t("admin.today", { used: user.usedToday, cap: user.cap ?? defaultCap })}
            {user.cap == null ? t("admin.default") : ""}
          </p>
        </div>
        <input
          inputMode="numeric"
          value={val}
          onChange={(e) => setVal(e.target.value.replace(/[^0-9]/g, ""))}
          placeholder={String(defaultCap)}
          aria-label={`Daily limit for ${user.email || user.uid}`}
          className="w-16 rounded-md border border-line bg-paper px-2 py-1 text-end text-[13px] text-ink outline-none focus:border-line2"
        />
        <button
          type="button"
          onClick={() => onSave(norm)}
          disabled={saving || !dirty}
          className="shrink-0 rounded-md border border-line px-2.5 py-1 text-[12px] text-muted transition enabled:hover:border-line2 enabled:hover:text-ink disabled:opacity-40"
        >
          {saving ? "…" : t("admin.save")}
        </button>
      </div>

      {hiddenChannels.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="mt-1.5 flex items-center gap-1 text-[11px] text-faint transition hover:text-ink"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden className={`transition-transform rtl:-scale-x-100 ${expanded ? "rotate-90" : ""}`}>
              <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {t("admin.channelAccess")}{show.size ? t("admin.shownCount", { n: show.size }) : ""}
          </button>
          {expanded && (
            <div className="mt-1.5 space-y-1 rounded-md border border-line/70 p-2">
              {hiddenChannels.map((c) => {
                const on = show.has(c.slug);
                return (
                  <div key={c.slug} className="flex items-center justify-between gap-2">
                    <span className={`min-w-0 flex-1 truncate text-[12px] ${on ? "text-ink" : "text-faint"}`} title={c.name}>{c.name}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setShow((s) => {
                          const n = new Set(s);
                          if (n.has(c.slug)) n.delete(c.slug);
                          else n.add(c.slug);
                          return n;
                        })
                      }
                      className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] transition ${
                        on ? "border-accent/40 text-accent hover:border-accent" : "border-line text-faint hover:text-ink"
                      }`}
                    >
                      {on ? t("admin.shown") : t("admin.hidden")}
                    </button>
                  </div>
                );
              })}
              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  onClick={() => onSaveChannels([...show])}
                  disabled={savingChannels || !showDirty}
                  className="rounded-md border border-line px-2.5 py-1 text-[11px] text-muted transition enabled:hover:border-line2 enabled:hover:text-ink disabled:opacity-40"
                >
                  {savingChannels ? "…" : t("admin.saveAccess")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* Topical (synthesized, the default) vs. Verbatim (the speakers' own words, original language). */
function StyleToggle({ value, onChange }: { value: "topical" | "verbatim"; onChange: (s: "topical" | "verbatim") => void }) {
  const { t } = useLang();
  return (
    <div className="inline-flex shrink-0 rounded-lg border border-line bg-raised/60 p-0.5 text-[12px]">
      {(["topical", "verbatim"] as const).map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          className={`rounded-md px-2.5 py-1 transition ${value === s ? "bg-accent/12 font-medium text-accent" : "text-faint hover:text-ink"}`}
        >
          {t(`style.${s}`)}
        </button>
      ))}
    </div>
  );
}

/* Shown when a guest has used their free questions — nudges them to sign up or sign in.
   Choosing an option ends the guest session, which drops back to the sign-in screen. */
function GuestPrompt({ onClose }: { onClose: () => void }) {
  const { t } = useLang();
  function go(mode: "in" | "up") {
    try {
      localStorage.setItem("authMode", mode);
    } catch {
      /* ignore */
    }
    signOutUser();
  }
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div className="fade-up relative z-10 w-full max-w-sm overflow-hidden rounded-2xl border border-line bg-raised shadow-xl">
        <div className="px-6 pb-2 pt-6">
          <span className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-full bg-accent/10 text-accent">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
              <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
              <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </span>
          <h2 dir="auto" className="font-serif text-xl font-medium text-ink">{t("guest.prompt.title")}</h2>
          <p dir="auto" className="mt-2 text-sm leading-relaxed text-muted">{t("guest.prompt.body")}</p>
        </div>
        <div className="space-y-2.5 px-6 pb-6 pt-3">
          <button type="button" onClick={() => go("up")} className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-paper transition hover:bg-accent2">
            {t("guest.prompt.create")}
          </button>
          <button type="button" onClick={() => go("in")} className="w-full rounded-lg border border-line bg-raised px-4 py-2.5 text-sm font-medium text-muted transition hover:border-line2 hover:text-ink">
            {t("guest.prompt.signin")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Loading({ stage }: { stage: number }) {
  const { t } = useLang();
  return (
    <div className="fade-up mt-6">
      <div className="relative h-0.5 w-full overflow-hidden rounded-full bg-line sweep" />
      <p className="mt-4 text-sm text-muted">{t(STAGE_KEYS[stage])}…</p>
      <p className="mt-1 text-xs text-faint">{t("loading.note")}</p>
    </div>
  );
}

/* The answer as it streams in, with a blinking caret, and the evidences appearing beneath it as
   the answer references them. AnswerView takes over (with the cost line) once the stream finishes. */
function StreamingAnswer({ text, question, onCite }: { text: string; question?: string; onCite: (n: number, e?: React.MouseEvent) => void }) {
  // The evidences are intentionally not shown here — they stream in after the answer and appear once
  // it's done, so the text stays smooth while it writes.
  return (
    <div className="fade-up mt-6">
      <article dir={answerDir(stripEchoedQuestion(text, question))} className="max-w-[66ch] text-[16px] leading-[1.8] text-ink">
        {renderAnswer(stripEchoedQuestion(text, question), onCite)}
        <span
          className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.18em] animate-pulse bg-accent align-middle"
          aria-hidden
        />
      </article>
    </div>
  );
}

/* The cited evidences. Each streams in as the answer first references it. */
function SourcesList({ sources }: { sources: Source[] }) {
  const { t } = useLang();
  if (!sources.length) return null;
  return (
    <div id="sources" className="mt-7">
      <h3 className="mb-3 font-serif text-sm font-medium text-muted">{t("sources.title")}</h3>
      <div className="space-y-2">
        {sources.map((s) => (
          <SourceCard key={s.n} s={s} />
        ))}
      </div>
    </div>
  );
}

function AnswerView({ result, onCite }: { result: Answer; onCite: (n: number, e?: React.MouseEvent) => void }) {
  const { t } = useLang();
  if (result.empty || !result.answer) {
    return (
      <div className="mt-5 rounded-xl border border-line bg-raised px-4 py-3 text-sm text-muted">
        {t("answer.empty")}
      </div>
    );
  }
  const cov = result.coverage;
  return (
    <div className="fade-up mt-6">
      <article dir={answerDir(stripEchoedQuestion(result.answer, result.q))} className="max-w-[66ch] text-[16px] leading-[1.8] text-ink">
        {renderAnswer(stripEchoedQuestion(result.answer, result.q), onCite)}
      </article>

      {/* provenance + actual cost (clear, echoing the header pill) */}
      <div className="mt-7 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-4 text-[13px] text-faint">
        {typeof result.cost_usd === "number" && (
          <span className="inline-flex items-center rounded-full border border-gold/45 bg-gold/[0.06] px-2.5 py-1 font-medium text-gold2">
            {t("answer.cost", { cost: aed(result.cost_usd) })}
            <span className="mx-1.5 text-faint">· ${result.cost_usd.toFixed(2)}</span>
          </span>
        )}
        <span dir="auto">
          {t("answer.coverage", { moments: cov.moments.toLocaleString(), videos: cov.videos.toLocaleString() })}
          {result.sources.length
            ? t("answer.cited", { n: result.sources.length, channels: cov.channels, s: cov.channels === 1 ? "" : "s" })
            : ""}
          .
        </span>
      </div>

      <SourcesList sources={result.sources} />
    </div>
  );
}

/* Save a source video's transcript as a plain-text file the reader can keep: a short header
   (title, channel, date, link) then one line per segment, each prefixed with its timestamp. */
function buildTranscriptFile(s: Source, lines: Line[]) {
  const head = [
    s.title || "",
    [s.channel, s.date].filter(Boolean).join(" · "),
    s.url || "",
  ].filter(Boolean).join("\n");
  const body = lines.map((l) => (l.ts ? `[${l.ts}] ${l.text}` : l.text)).join("\n");
  const blob = new Blob([`${head}\n\n${body}\n`], { type: "text/plain;charset=utf-8" });
  const name =
    `${s.channel ? s.channel + " - " : ""}${s.title || s.url || "transcript"}`
      .replace(/[\\/:*?"<>|\n\r]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "transcript";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* A cited source. The title + timestamp (and the arrow icon) link out to the moment on YouTube;
   clicking the 3-line transcript peek opens the surrounding transcript in a scrollable panel with
   the cited line centred (cited line in full contrast, neighbours greyed). */
function SourceCard({ s }: { s: Source }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [dl, setDl] = useState<"idle" | "loading" | "error">("idle");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Download the whole video's transcript. Fetch it from the brain when we have the video id;
  // for an old saved chat (no id) fall back to the transcript window we already hold.
  async function downloadTranscript() {
    if (dl === "loading") return;
    if (!s.video_id) {
      const ctx = s.context ?? [];
      if (ctx.length) buildTranscriptFile(s, ctx);
      return;
    }
    setDl("loading");
    try {
      const token = await idToken();
      const qs = new URLSearchParams({ video_id: s.video_id });
      if (s.slug) qs.set("slug", s.slug);
      const r = await fetch(`/api/transcript?${qs}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
      const data = await r.json().catch(() => ({}));
      const lines: Line[] = Array.isArray(data?.lines) ? data.lines : [];
      if (!r.ok || !lines.length) throw new Error("no transcript");
      buildTranscriptFile(s, lines);
      setDl("idle");
    } catch {
      setDl("error");
      setTimeout(() => setDl("idle"), 2200);
    }
  }

  const citedRef = useRef<HTMLParagraphElement>(null);
  const ctx = s.context ?? [];
  const ci = s.citedIdx ?? 0;
  const prev = ci > 0 ? ctx[ci - 1] : null;
  const cited = ctx[ci];
  const next = ci < ctx.length - 1 ? ctx[ci + 1] : null;

  // When the transcript opens, centre the cited line inside its own scroll box (not the page).
  // Measure against the box's own rect so it works regardless of the nearest positioned ancestor.
  useEffect(() => {
    if (!open) return;
    const box = scrollRef.current, line = citedRef.current;
    if (!box || !line) return;
    const rel = line.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTop = rel - box.clientHeight / 2 + line.clientHeight / 2;
  }, [open]);

  return (
    <div
      id={`src-${s.n}`}
      className="overflow-hidden rounded-xl border border-line bg-raised transition hover:border-line2"
    >
      <div className="flex items-start gap-3.5 px-4 py-3">
        <span className="mt-0.5 min-w-6 font-serif text-[15px] font-semibold tabular-nums text-gold">
          {s.n}
        </span>
        <div className="min-w-0 flex-1">
          {/* only the title + timestamp link out to the video */}
          <a href={s.url} target="_blank" rel="noopener noreferrer" className="group block">
            <span className="line-clamp-2 text-sm text-ink group-hover:underline" dir="auto">
              {s.title}
            </span>
            <span className="mt-1 block text-xs text-faint">
              <span className="font-medium text-accent group-hover:underline">{s.timestamp}</span>
              {s.channel ? ` · ${s.channel}` : ""}
              {s.date ? ` · ${s.date}` : ""}
            </span>
          </a>
          {/* the preview opens the transcript (it does not go to the video) */}
          {ctx.length > 1 ? (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="group/tr -mx-1 mt-1.5 block w-full rounded-md px-1 py-0.5 text-left transition hover:bg-line/20"
            >
              {!open && cited && (
                <span className="block text-[13px] leading-snug" dir="auto">
                  {prev && <span className="block truncate text-faint/60">{prev.text}</span>}
                  <span className="block line-clamp-2 text-ink">{cited.text}</span>
                  {next && <span className="block truncate text-faint/60">{next.text}</span>}
                </span>
              )}
              <span className="mt-1 flex items-center gap-1 text-[11px] font-medium text-faint transition group-hover/tr:text-ink">
                <svg
                  width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden
                  className={`transition-transform ${open ? "rotate-180" : ""}`}
                >
                  <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {open ? t("source.hide") : t("source.read")}
              </span>
            </button>
          ) : cited ? (
            <span className="mt-2 block text-[13px] leading-snug text-ink" dir="auto">
              {cited.text}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={downloadTranscript}
            disabled={dl === "loading"}
            aria-label={dl === "error" ? t("source.dlError") : t("source.download")}
            title={dl === "error" ? t("source.dlError") : t("source.download")}
            className={`rounded-md p-1 transition hover:bg-line/40 disabled:opacity-60 ${
              dl === "error" ? "text-danger" : "text-faint hover:text-accent"
            }`}
          >
            {dl === "loading" ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden className="animate-spin">
                <path d="M12 3a9 9 0 1 0 9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 19h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
          <a
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t("source.open")}
            title={t("source.open")}
            className="rounded-md p-1 text-faint transition hover:bg-line/40 hover:text-accent"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M7 17 17 7M9 7h8v8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        </div>
      </div>
      {open && ctx.length > 0 && (
        <div
          ref={scrollRef}
          className="transcript-scroll max-h-56 overflow-y-auto border-t border-line px-4 py-3"
        >
          {ctx.map((ln, i) => (
            <p
              key={i}
              ref={i === ci ? citedRef : undefined}
              dir="auto"
              className={`py-1 text-[13px] leading-relaxed ${
                i === ci ? "font-medium text-ink" : "text-faint/70"
              }`}
            >
              {ln.ts && <span className="mr-2 align-middle text-[10px] tabular-nums text-muted/70">{ln.ts}</span>}
              {ln.text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/* Lightweight renderer: paragraphs, headings, bullets, **bold**, and [n] citation chips.
   Line-based so a "### Heading" is caught even when the model glues it to the next line. */
const HEADING = /^\s*(#{1,4})\s+(.*)$/;
const BULLET = /^\s*([-*•]|\d+[.)])\s+/;

/* The model often opens by echoing the question as a heading; the page already shows the
   question above the answer, so drop that leading echo to avoid a duplicate. */
function stripEchoedQuestion(answer: string, question?: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const q = norm(question || "");
  if (!q) return answer;
  const lines = answer.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++; // skip any leading blank lines
  const m = i < lines.length ? lines[i].match(HEADING) : null;
  if (m) {
    const h = norm(m[2]);
    if (h === q || (h.length >= 8 && (q.includes(h) || h.includes(q)))) {
      return lines.slice(i + 1).join("\n").replace(/^\n+/, "");
    }
  }
  return answer;
}

// One base direction for the whole answer, from its dominant script, so headings, bullets and quotes
// all align the same way instead of each block picking its own (an English channel heading drifting
// left over right-aligned Arabic quotes, or an Arabic speaker label flipping an English quote). Mixed
// English/Arabic within a line is still ordered correctly by the browser's bidi algorithm. Verbatim
// answers are mostly their quotes, so they follow the quotes' script.
function answerDir(text: string): "rtl" | "ltr" {
  const ar = (text.match(/[؀-ۿ]/g) || []).length;
  const lat = (text.match(/[A-Za-z]/g) || []).length;
  return ar > lat ? "rtl" : "ltr";
}

function renderAnswer(text: string, onCite: (n: number, e?: React.MouseEvent) => void) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const h = line.match(HEADING);
    if (h) {
      out.push(
        <h3 key={key++} className="mb-2 mt-6 font-serif text-[1.15rem] font-medium text-ink">
          {inline(h[2], `h-${key}`, onCite)}
        </h3>
      );
      i++;
      continue;
    }

    if (BULLET.test(line)) {
      const items: string[] = [];
      while (i < lines.length && BULLET.test(lines[i])) {
        items.push(lines[i].replace(BULLET, ""));
        i++;
      }
      const k = key++;
      out.push(
        <ul key={k} className="my-3 space-y-1.5 ps-1">
          {items.map((it, li) => (
            <li key={li} className="flex gap-2.5">
              <span className="mt-[0.7em] h-1 w-1 shrink-0 rounded-full bg-gold" />
              <span className="min-w-0 flex-1">{inline(it, `${k}-${li}`, onCite)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // gather a paragraph: consecutive lines that aren't blank, headings, or bullets
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !HEADING.test(lines[i]) && !BULLET.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(
      <p key={key++} className="my-3.5">
        {inline(para.join(" "), `p-${key}`, onCite)}
      </p>
    );
  }

  return out;
}

/* inline: **bold** (may contain *italic*), *italic*, and [n] / [n, m] citations.
   Bold is matched lazily so it spans nested single-* italics; italics are parsed within. */
function inline(text: string, key: string, onCite: (n: number, e?: React.MouseEvent) => void) {
  const nodes: React.ReactNode[] = [];
  // 1) pull out citation chips first (they don't nest with emphasis)
  const parts = text.split(/(\[\d+(?:\s*,\s*\d+)*\])/g).filter(Boolean);
  parts.forEach((p, pi) => {
    const cite = p.match(/^\[(\d+(?:\s*,\s*\d+)*)\]$/);
    if (cite) {
      const nums = cite[1].split(",").map((x) => parseInt(x.trim(), 10));
      nodes.push(
        <span key={`${key}-c${pi}`} dir="ltr" className="cites">
          {nums.map((n, j) => (
            <span key={j}>
              <sup className="cite" onClick={(e) => onCite(n, e)} title={`Jump to source ${n}`}>
                {n}
              </sup>
              {j < nums.length - 1 ? <span className="cite-sep" /> : ""}
            </span>
          ))}
        </span>
      );
      return;
    }
    // 2) bold spans (lazy, so **a *b* c** is one bold with an italic inside)
    p.split(/(\*\*.+?\*\*)/g)
      .filter(Boolean)
      .forEach((seg, si) => {
        const b = seg.match(/^\*\*(.+?)\*\*$/);
        if (b) {
          nodes.push(
            <strong key={`${key}-${pi}-b${si}`} className="font-semibold text-ink">
              {italics(b[1], `${key}-${pi}-b${si}`)}
            </strong>
          );
        } else {
          italics(seg, `${key}-${pi}-${si}`).forEach((n) => nodes.push(n));
        }
      });
  });
  return nodes;
}

/* the italic pass, used on plain text and inside bold */
function italics(text: string, key: string) {
  return text
    .split(/(\*[^*]+\*)/g)
    .filter(Boolean)
    .map((seg, i) => {
      const m = seg.match(/^\*([^*]+)\*$/);
      return m ? (
        <em key={`${key}-i${i}`} className="italic">
          {m[1]}
        </em>
      ) : (
        <span key={`${key}-i${i}`}>{seg}</span>
      );
    });
}
