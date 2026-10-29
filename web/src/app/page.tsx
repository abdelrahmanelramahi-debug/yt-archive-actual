"use client";

import { useEffect, useRef, useState } from "react";

type Line = { ts: string | null; text: string };
type Source = {
  n: number;
  timestamp: string;
  title: string;
  channel: string | null;
  date: string | null;
  url: string;
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
type Channel = { slug: string; name: string; kind: string };
type Mode = { id: string; label: string; usd: number };

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

const EXAMPLES = [
  "What is the correct belief about Allah's names and attributes?", // broad (aqeedah)
  "Is wudu valid with seawater?", // niche (fiqh) - serendipity
  'How do the scholars respond to John 1:1, "the Word was God"?', // niche (christian polemic)
];

const STAGES = [
  "Breaking your question into angles",
  "Searching a million moments",
  "Reading the most relevant ones",
  "Writing a grounded answer",
];
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

function Gate({ onOk }: { onOk: () => void }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      const d = await r.json();
      if (r.ok && d.ok) onOk();
      else setErr(d.error || "That code isn't right.");
    } catch {
      setErr("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-[82vh] items-center justify-center px-5">
      <div className="fade-up w-full max-w-sm">
        <div className="mb-7 flex justify-center">
          <Wordmark />
        </div>
        <h1 className="text-center font-serif text-2xl font-medium tracking-tight text-ink">
          An invitation is required
        </h1>
        <p className="mt-2 text-center text-[15px] leading-relaxed text-muted">
          Enter your access code to open the archive.
        </p>
        <form onSubmit={submit} className="mt-6">
          <input
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Access code"
            className="w-full rounded-xl border border-line bg-raised px-4 py-3 text-[16px] text-ink shadow-sm outline-none transition placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-accent/10"
          />
          {err && <p className="mt-2 text-sm text-danger">{err}</p>}
          <button
            type="submit"
            disabled={!code.trim() || busy}
            className="mt-3 w-full rounded-xl bg-accent py-3 text-sm font-medium text-paper transition enabled:hover:bg-accent2 disabled:opacity-40"
          >
            {busy ? "Checking…" : "Enter"}
          </button>
        </form>
      </div>
    </main>
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
}: {
  channels: Channel[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
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
            <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1.5 max-h-80 w-72 overflow-auto rounded-xl border border-line bg-raised p-1.5 shadow-[0_-16px_40px_-16px_rgba(35,33,27,0.4)]">
          <div className="flex items-center justify-between px-2 py-1 text-xs">
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => onChange(new Set(channels.map((c) => c.slug)))}>
              Select all
            </button>
            <button type="button" className="text-muted hover:text-ink" onClick={() => onChange(new Set())}>
              Clear
            </button>
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
                {c.name}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// Mobile depth selector: a drop-up holding the depths, their cost, and the explainer.
function ModeDropup({ modes, mode, onChange }: { modes: Mode[]; mode: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = modes.find((m) => m.id === mode);
  const keeps: Record<string, string> = { quick: "~120", standard: "~500", deep: "~1,000" };

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
          <path d="m6 15 6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-30 mb-1.5 w-64 rounded-xl border border-line bg-raised p-1.5 shadow-[0_-16px_40px_-16px_rgba(35,33,27,0.4)]">
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
  const keeps: Record<string, string> = { quick: "~120", standard: "~500", deep: "~1,000" };
  const when: Record<string, string> = {
    quick: "a fast gist",
    standard: "most questions",
    deep: "broad or contested topics",
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

export default function Home() {
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "streaming" | "done" | "error">("idle");
  const [result, setResult] = useState<Answer | null>(null);
  const [streamText, setStreamText] = useState(""); // the answer so far, while it streams
  const [streamSources, setStreamSources] = useState<Source[]>([]); // evidences, as they stream in
  const [live, setLive] = useState(false); // a stream is in flight (so the stage copy follows events)
  const [error, setError] = useState<string>("");
  const [stage, setStage] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [modes, setModes] = useState<Mode[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState("standard");
  const [totals, setTotals] = useState<{ moments: number; videos: number } | null>(null);

  // check whether this visitor is through the invite gate
  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then((d) => setAuthed(!!d.authed))
      .catch(() => setAuthed(false));
  }, []);

  // load the channel list + depth modes for the pickers, once through the gate
  useEffect(() => {
    if (!authed) return;
    fetch("/api/channels")
      .then((r) => r.json())
      .then((d) => {
        const chs: Channel[] = Array.isArray(d.channels) ? d.channels : [];
        setChannels(chs);
        setSelected(new Set(chs.map((c) => c.slug)));
        if (Array.isArray(d.modes) && d.modes.length) setModes(d.modes);
        if (d.default_mode) setMode(d.default_mode);
        if (typeof d.total_moments === "number" && typeof d.total_videos === "number") {
          setTotals({ moments: d.total_moments, videos: d.total_videos });
        }
      })
      .catch(() => {});
  }, [authed]);

  // cycle the loading stage copy while we wait — only for the non-streaming fallback; when a stream
  // is live the real status events drive the stage instead.
  useEffect(() => {
    if (status !== "loading" || live) return;
    setStage(0);
    const id = setInterval(() => setStage((s) => Math.min(s + 1, STAGES.length - 1)), 2600);
    return () => clearInterval(id);
  }, [status, live]);

  async function ask(question: string) {
    const text = question.trim();
    if (!text || status === "loading" || status === "streaming") return;
    setAsked(text);
    setStatus("loading");
    setStage(0);
    setStreamText("");
    setStreamSources([]);
    setResult(null);
    setError("");
    setReturnY(null);
    const useSubset = channels.length > 0 && selected.size > 0 && selected.size < channels.length;
    const payload = { question: text, mode, channels: useSubset ? [...selected] : undefined };
    // Prefer the streaming answer; fall back to the one-shot endpoint if a stream can't be opened.
    setLive(true);
    try {
      await streamAnswer(text, payload);
      return;
    } catch {
      /* stream unavailable — fall through to /api/ask */
    }
    setLive(false);
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data: Answer = await r.json();
      if (!r.ok || data.error) {
        setError(data.error || "Something went wrong.");
        setStatus("error");
        return;
      }
      setResult(data);
      setStatus("done");
    } catch {
      setError("Could not reach the server.");
      setStatus("error");
    }
  }

  // Open the SSE stream and drive the UI from its events. Returns once a terminal event (done /
  // empty / handled error) is reached; throws before any answer text shows so ask() can fall back.
  async function streamAnswer(text: string, payload: object) {
    const r = await fetch("/api/ask/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok || !r.body) throw new Error("stream unavailable");
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let acc = "";
    const srcs: Source[] = []; // evidences accumulate as their citations stream in
    let gotDelta = false;
    let done: { coverage: Coverage; cost_usd?: number } | null = null;
    const EMPTY_COV: Coverage = { moments: 0, videos: 0, channels: 0 };

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
          setStreamText(acc);
        } else if (ev === "source") {
          srcs.push(obj as Source);
          setStreamSources([...srcs]);
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
            setError(obj.error || "Something went wrong.");
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
      return;
    }
    if (gotDelta) {
      // stream ended mid-answer: keep what we have, with whatever evidences arrived
      setResult({ q: text, empty: false, answer: acc, sources: srcs, coverage: EMPTY_COV });
      setStatus("done");
      setLive(false);
      return;
    }
    throw new Error("no data"); // nothing arrived — let ask() fall back
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    ask(q);
  }

  // the logo returns to the landing hero (soft reset, no reload)
  function goHome() {
    setAsked(null);
    setResult(null);
    setStatus("idle");
    setError("");
    setQ("");
    setReturnY(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function scrollToSource(n: number) {
    const el = document.getElementById(`src-${n}`);
    if (!el) return;
    setReturnY(window.scrollY); // remember where the citation was, for the jump-back button
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("src-hit");
    setTimeout(() => el.classList.remove("src-hit"), 1600);
  }

  const [returnY, setReturnY] = useState<number | null>(null);
  const landing = status === "idle";
  const noneSelected = channels.length > 0 && selected.size === 0;
  const modeUsd = modes.find((m) => m.id === mode)?.usd ?? TYPICAL_COST;

  if (authed === null) {
    return <main className="grid min-h-[70vh] place-items-center text-sm text-faint">Loading…</main>;
  }
  if (!authed) {
    return <Gate onOk={() => setAuthed(true)} />;
  }

  return (
    <main className={`mx-auto w-full max-w-3xl px-5 ${landing ? "pb-10" : "pb-28"}`}>
      {/* header: identity + persistent cost */}
      <header className="flex items-center justify-between py-6">
        <button
          type="button"
          onClick={goHome}
          aria-label="La Tafti — back to home"
          className="-m-1 rounded-md p-1 transition hover:opacity-75"
        >
          <Wordmark />
        </button>
        <ThemeSelector />
      </header>

      {/* hero + suggestions + ask (ask block anchored to the bottom of the viewport on landing) */}
      <section className={landing ? "flex min-h-[calc(100dvh-6rem)] flex-col pt-6" : "pt-5"}>
        {landing && (
          <div className="fade-up mb-6 sm:mb-8">
            <h1 className="max-w-2xl text-balance font-serif text-[1.6rem] font-medium leading-[1.14] tracking-tight text-ink sm:text-[2.7rem] sm:leading-[1.12]">
              Ask across the archive
            </h1>
            <p className="mt-3 max-w-xl text-[14px] leading-relaxed text-muted sm:mt-4 sm:text-[16px]">
              Not a fatwa — the words of the scholars themselves, drawn from thousands of hours of
              lectures and debates and traced to the exact moment they were said, with a timestamp
              you can open on the video.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3 sm:mt-7 sm:gap-x-10 sm:gap-y-4">
              <Stat n={totals ? heroVideos(totals.videos) : "20,000+"} label="videos" />
              <span className="hidden h-10 w-px bg-line sm:block" />
              <Stat n={totals ? heroMoments(totals.moments) : "1.1M+"} label="searchable moments" />
              <span className="hidden h-10 w-px bg-line sm:block" />
              <Stat n={String(channels.length || 19)} label="channels" />
            </div>
          </div>
        )}

        {/* anchored to the bottom of the viewport on landing */}
        <div className={landing ? "mt-auto" : ""}>
          {/* suggestions */}
          {landing && (
            <div className="fade-up mb-5">
              <p className="mb-2.5 text-xs text-faint">Try one of these</p>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => {
                      setQ(ex);
                      ask(ex);
                    }}
                    className="rounded-lg border border-line bg-raised/60 px-3.5 py-2 text-left text-[13.5px] text-muted transition hover:border-line2 hover:text-ink"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* controls ABOVE the bar: scope / cost on top, the pickers sit right above the bar */}
          {channels.length > 0 && (
            <>
              {/* mobile: channel icon + mode drop-up on one compact line, right-aligned */}
              <div className="mb-4 flex items-center justify-end gap-2 sm:hidden">
                <ChannelPicker channels={channels} selected={selected} onChange={setSelected} compact />
                <ModeDropup modes={modes} mode={mode} onChange={setMode} />
                {noneSelected && <span className="text-[13px] text-danger">Pick a channel</span>}
              </div>

              {/* desktop: channel + scope (left); mode + cost + explainer (right) */}
              <div className="mb-3 hidden sm:flex sm:flex-row sm:items-end sm:justify-between sm:gap-3">
                <div className="flex flex-col items-start gap-2">
                  {noneSelected ? (
                    <p className="text-[13px] text-danger">Pick at least one channel.</p>
                  ) : (
                    <p className="text-[13px] text-faint">
                      {selected.size} channel{selected.size === 1 ? "" : "s"}
                    </p>
                  )}
                  <ChannelPicker channels={channels} selected={selected} onChange={setSelected} />
                </div>
                <div className="flex flex-col items-end gap-2">
                  <ModeExplainer modes={modes} />
                  <p className="text-[13px] text-gold2">≈ {aed(modeUsd)} per answer</p>
                  <ModePicker modes={modes} mode={mode} onChange={setMode} />
                </div>
              </div>
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
                placeholder="Ask anything…  (English or Arabic)"
                /* 16px keeps iOS Safari from auto-zooming when the field is focused */
                className="max-h-40 flex-1 resize-none bg-transparent py-2 text-[16px] leading-relaxed text-ink outline-none placeholder:text-faint"
              />
              <button
                type="submit"
                disabled={!q.trim() || status === "loading" || noneSelected}
                aria-label="Ask"
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
          <div className="flex items-start justify-between gap-4">
            <h2 dir="auto" className="min-w-0 font-serif text-[1.4rem] font-medium leading-snug text-ink">
              {asked}
            </h2>
            {(status === "done" && result && !result.empty && result.sources.length > 0) ||
            (status === "streaming" && streamSources.length > 0) ? (
              <button
                type="button"
                onClick={() => document.getElementById("sources")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                className="mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-raised/60 px-2.5 py-1 text-[12px] text-muted transition hover:border-line2 hover:text-ink"
              >
                Skip to videos
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M12 5v14M12 19l-6-6M12 19l6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ) : status === "loading" || status === "streaming" ? (
              // sources aren't ready yet: show the chip with a glow rotating round its border
              <span
                className="skip-loading mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-raised/60 px-2.5 py-1 text-[12px] text-muted"
                aria-label="Finding the videos"
                title="Finding the videos…"
              >
                Skip to videos
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden className="opacity-60">
                  <path d="M12 5v14M12 19l-6-6M12 19l6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            ) : null}
          </div>

          {status === "loading" && <Loading stage={stage} />}

          {status === "streaming" && (
            <StreamingAnswer text={streamText} sources={streamSources} question={asked ?? undefined} onCite={scrollToSource} />
          )}

          {status === "error" && (
            <div className="mt-5 rounded-xl border border-danger/25 bg-danger/[0.06] px-4 py-3 text-sm text-danger">
              {error}
            </div>
          )}

          {status === "done" && result && <AnswerView result={result} onCite={scrollToSource} />}
        </section>
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
  );
}

function Loading({ stage }: { stage: number }) {
  return (
    <div className="fade-up mt-6">
      <div className="relative h-0.5 w-full overflow-hidden rounded-full bg-line sweep" />
      <p className="mt-4 text-sm text-muted">{STAGES[stage]}…</p>
      <p className="mt-1 text-xs text-faint">A thorough answer takes a few moments.</p>
    </div>
  );
}

/* The answer as it streams in, with a blinking caret, and the evidences appearing beneath it as
   the answer references them. AnswerView takes over (with the cost line) once the stream finishes. */
function StreamingAnswer({ text, sources, question, onCite }: { text: string; sources: Source[]; question?: string; onCite: (n: number) => void }) {
  return (
    <div className="fade-up mt-6">
      <article className="max-w-[66ch] text-[16px] leading-[1.8] text-ink">
        {renderAnswer(stripEchoedQuestion(text, question), onCite)}
        <span
          className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.18em] animate-pulse bg-accent align-middle"
          aria-hidden
        />
      </article>
      <SourcesList sources={sources} />
    </div>
  );
}

/* The cited evidences. Each streams in as the answer first references it. */
function SourcesList({ sources }: { sources: Source[] }) {
  if (!sources.length) return null;
  return (
    <div id="sources" className="mt-7">
      <h3 className="mb-3 font-serif text-sm font-medium text-muted">Sources</h3>
      <div className="space-y-2">
        {sources.map((s) => (
          <SourceCard key={s.n} s={s} />
        ))}
      </div>
    </div>
  );
}

function AnswerView({ result, onCite }: { result: Answer; onCite: (n: number) => void }) {
  if (result.empty || !result.answer) {
    return (
      <div className="mt-5 rounded-xl border border-line bg-raised px-4 py-3 text-sm text-muted">
        Nothing matched that one. Try different words, or ask in Arabic.
      </div>
    );
  }
  const cov = result.coverage;
  return (
    <div className="fade-up mt-6">
      <article className="max-w-[66ch] text-[16px] leading-[1.8] text-ink">
        {renderAnswer(stripEchoedQuestion(result.answer, result.q), onCite)}
      </article>

      {/* provenance + actual cost (clear, echoing the header pill) */}
      <div className="mt-7 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-4 text-[13px] text-faint">
        {typeof result.cost_usd === "number" && (
          <span className="inline-flex items-center rounded-full border border-gold/45 bg-gold/[0.06] px-2.5 py-1 font-medium text-gold2">
            This answer cost {aed(result.cost_usd)}
            <span className="ml-1.5 text-faint">· ${result.cost_usd.toFixed(2)}</span>
          </span>
        )}
        <span>
          Drew on {cov.moments.toLocaleString()} moments across {cov.videos.toLocaleString()} videos
          {result.sources.length
            ? ` · cited ${result.sources.length} from ${cov.channels} channel${cov.channels === 1 ? "" : "s"}`
            : ""}
          .
        </span>
      </div>

      <SourcesList sources={result.sources} />
    </div>
  );
}

/* A cited source. The title + timestamp (and the arrow icon) link out to the moment on YouTube;
   clicking the 3-line transcript peek opens the surrounding transcript in a scrollable panel with
   the cited line centred (cited line in full contrast, neighbours greyed). */
function SourceCard({ s }: { s: Source }) {
  const [open, setOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
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
                {open ? "Hide transcript" : "Read transcript"}
              </span>
            </button>
          ) : cited ? (
            <span className="mt-2 block text-[13px] leading-snug text-ink" dir="auto">
              {cited.text}
            </span>
          ) : null}
        </div>
        <a
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open this moment on YouTube"
          className="mt-0.5 shrink-0 rounded-md p-1 text-faint transition hover:bg-line/40 hover:text-accent"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M7 17 17 7M9 7h8v8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </a>
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

function renderAnswer(text: string, onCite: (n: number) => void) {
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
        <h3 key={key++} dir="auto" className="mb-2 mt-6 font-serif text-[1.15rem] font-medium text-ink">
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
        <ul key={k} className="my-3 space-y-1.5 pl-1">
          {items.map((it, li) => (
            <li key={li} dir="auto" className="flex gap-2.5">
              <span className="mt-[0.7em] h-1 w-1 shrink-0 rounded-full bg-gold" />
              <span>{inline(it, `${k}-${li}`, onCite)}</span>
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
      <p key={key++} dir="auto" className="my-3.5">
        {inline(para.join(" "), `p-${key}`, onCite)}
      </p>
    );
  }

  return out;
}

/* inline: **bold** and [n] / [n, m] citations */
function inline(text: string, key: string, onCite: (n: number) => void) {
  // split on bold and citation tokens, keeping them
  const parts = text.split(/(\*\*[^*]+\*\*|\[\d+(?:\s*,\s*\d+)*\])/g).filter(Boolean);
  return parts.map((p, i) => {
    const bold = p.match(/^\*\*([^*]+)\*\*$/);
    if (bold) {
      return (
        <strong key={`${key}-${i}`} className="font-semibold text-ink">
          {bold[1]}
        </strong>
      );
    }
    const cite = p.match(/^\[(\d+(?:\s*,\s*\d+)*)\]$/);
    if (cite) {
      const nums = cite[1].split(",").map((x) => parseInt(x.trim(), 10));
      return (
        <span key={`${key}-${i}`} className="cites">
          {nums.map((n, j) => (
            <span key={j}>
              <sup className="cite" onClick={() => onCite(n)} title={`Jump to source ${n}`}>
                {n}
              </sup>
              {j < nums.length - 1 ? <span className="cite-sep" /> : ""}
            </span>
          ))}
        </span>
      );
    }
    return <span key={`${key}-${i}`}>{p}</span>;
  });
}
