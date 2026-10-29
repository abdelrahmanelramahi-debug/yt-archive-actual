"use client";

import { useEffect, useRef, useState } from "react";

type Source = {
  n: number;
  timestamp: string;
  title: string;
  channel: string | null;
  date: string | null;
  url: string;
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

const EXAMPLES = [
  "What are the conditions for a valid wudu?",
  "How do the scholars respond to the trinity?",
  "What is said about patience during hardship?",
  "Explain tawheed al-uluhiyyah simply.",
];

const STAGES = [
  "Breaking your question into angles",
  "Searching a million moments",
  "Reading the most relevant ones",
  "Writing a grounded answer",
];

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
    <main className="flex min-h-[80vh] items-center justify-center px-5">
      <div className="fade-up w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <div className="grid h-7 w-7 place-items-center rounded-lg bg-accent/15 text-accent">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M4 6.5C4 5 5 4 6.5 4H18a2 2 0 0 1 2 2v12.5a1.5 1.5 0 0 1-1.5 1.5H6.5A2.5 2.5 0 0 1 4 17.5V6.5Z" stroke="currentColor" strokeWidth="1.6" />
              <path d="M8 8.5h7M8 12h7M8 15.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </div>
          <span className="text-[15px] font-medium text-fg">The Archive</span>
        </div>
        <h1 className="text-center text-lg font-medium text-fg">This archive is invite-only</h1>
        <p className="mt-1.5 text-center text-sm text-muted">Enter your access code to continue.</p>
        <form onSubmit={submit} className="mt-5">
          <input
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Access code"
            className="w-full rounded-xl border border-line bg-surface px-4 py-3 text-[15px] text-fg outline-none transition placeholder:text-faint focus:border-line2"
          />
          {err && <p className="mt-2 text-sm text-[#f0a8b0]">{err}</p>}
          <button
            type="submit"
            disabled={!code.trim() || busy}
            className="mt-3 w-full rounded-xl bg-accent py-3 text-sm font-medium text-ink transition enabled:hover:bg-accent2 disabled:opacity-40"
          >
            {busy ? "Checking…" : "Enter"}
          </button>
        </form>
      </div>
    </main>
  );
}

export default function Home() {
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<Answer | null>(null);
  const [error, setError] = useState<string>("");
  const [stage, setStage] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);

  // check whether this visitor is through the invite gate
  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then((d) => setAuthed(!!d.authed))
      .catch(() => setAuthed(false));
  }, []);

  // cycle the loading stage copy while we wait (real token streaming comes next)
  useEffect(() => {
    if (status !== "loading") return;
    setStage(0);
    const id = setInterval(() => setStage((s) => Math.min(s + 1, STAGES.length - 1)), 2600);
    return () => clearInterval(id);
  }, [status]);

  async function ask(question: string) {
    const text = question.trim();
    if (!text || status === "loading") return;
    setAsked(text);
    setStatus("loading");
    setResult(null);
    setError("");
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text }),
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

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    ask(q);
  }

  function scrollToSource(n: number) {
    const el = document.getElementById(`src-${n}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("src-hit");
    setTimeout(() => el.classList.remove("src-hit"), 1600);
  }

  const landing = status === "idle";

  if (authed === null) {
    return <main className="grid min-h-[70vh] place-items-center text-sm text-faint">Loading…</main>;
  }
  if (!authed) {
    return <Gate onOk={() => setAuthed(true)} />;
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-5 pb-28">
      {/* header */}
      <header className="flex items-center justify-between py-6">
        <div className="flex items-center gap-2.5">
          <div className="grid h-7 w-7 place-items-center rounded-lg bg-accent/15 text-accent">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M4 6.5C4 5 5 4 6.5 4H18a2 2 0 0 1 2 2v12.5a1.5 1.5 0 0 1-1.5 1.5H6.5A2.5 2.5 0 0 1 4 17.5V6.5Z" stroke="currentColor" strokeWidth="1.6" />
              <path d="M8 8.5h7M8 12h7M8 15.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </div>
          <span className="text-[15px] font-medium tracking-tight text-fg">The Archive</span>
        </div>
        <span className="text-xs text-faint">grounded in real moments</span>
      </header>

      {/* hero */}
      <section className={landing ? "pt-[14vh]" : "pt-6"}>
        {landing && (
          <div className="fade-up mb-8 text-center">
            <h1 className="text-balance text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
              Ask across thousands of hours
              <br className="hidden sm:block" /> of lectures and debates
            </h1>
            <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-muted">
              Every answer is built from real transcript moments — with timestamps you can open on the video.
            </p>
          </div>
        )}

        {/* ask bar */}
        <form onSubmit={onSubmit} className="sticky top-3 z-10">
          <div className="group flex items-end gap-2 rounded-2xl border border-line bg-surface/80 p-2 pl-4 shadow-[0_8px_40px_-12px_rgba(0,0,0,0.6)] backdrop-blur transition-colors focus-within:border-line2">
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
              className="max-h-40 flex-1 resize-none bg-transparent py-2 text-[15px] leading-relaxed text-fg outline-none placeholder:text-faint"
            />
            <button
              type="submit"
              disabled={!q.trim() || status === "loading"}
              aria-label="Ask"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-ink transition enabled:hover:bg-accent2 disabled:opacity-35"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </form>

        {landing && (
          <div className="fade-up mt-5 flex flex-wrap justify-center gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                onClick={() => {
                  setQ(ex);
                  ask(ex);
                }}
                className="rounded-full border border-line bg-surface/50 px-3.5 py-1.5 text-[13px] text-muted transition hover:border-line2 hover:text-fg"
              >
                {ex}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* conversation area */}
      {asked && (
        <section className="mt-8">
          <h2 dir="auto" className="text-lg font-medium leading-snug text-fg">
            {asked}
          </h2>

          {status === "loading" && <Loading stage={stage} />}

          {status === "error" && (
            <div className="mt-5 rounded-xl border border-[#4a2630] bg-[#241619] px-4 py-3 text-sm text-[#f0a8b0]">
              {error}
            </div>
          )}

          {status === "done" && result && (
            <AnswerView result={result} onCite={scrollToSource} />
          )}
        </section>
      )}
    </main>
  );
}

function Loading({ stage }: { stage: number }) {
  return (
    <div className="fade-up mt-6">
      <div className="flex items-center gap-2.5 text-sm text-muted">
        <span className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1.5 w-1.5 rounded-full bg-accent"
              style={{ animation: "pulseDot 1.1s ease-in-out infinite", animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </span>
        <span>{STAGES[stage]}…</span>
      </div>
      <div className="mt-5 space-y-3">
        {[90, 100, 96, 70].map((w, i) => (
          <div key={i} className="shimmer h-3.5 rounded" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}

function AnswerView({ result, onCite }: { result: Answer; onCite: (n: number) => void }) {
  if (result.empty || !result.answer) {
    return (
      <div className="mt-5 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-muted">
        Nothing matched that one. Try different words, or ask in Arabic.
      </div>
    );
  }
  const cov = result.coverage;
  return (
    <div className="fade-up mt-6">
      <article className="text-[15px] leading-[1.75] text-fg">
        {renderAnswer(result.answer, onCite)}
      </article>

      <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
        <span>
          Drew on {cov.moments.toLocaleString()} moments across {cov.videos.toLocaleString()} videos
          {result.sources.length ? ` · cited ${result.sources.length} from ${cov.channels} channel${cov.channels === 1 ? "" : "s"}` : ""}.
        </span>
        {typeof result.cost_usd === "number" && <span>· ${result.cost_usd.toFixed(3)}</span>}
      </div>

      {result.sources.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-faint">Sources</h3>
          <div className="space-y-2">
            {result.sources.map((s) => (
              <a
                key={s.n}
                id={`src-${s.n}`}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 transition hover:border-line2 hover:bg-surface2"
              >
                <span className="mt-0.5 grid h-6 min-w-6 place-items-center rounded-md bg-accent/15 px-1.5 text-xs font-semibold text-accent2">
                  {s.n}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-sm text-fg" dir="auto">
                    {s.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-faint">
                    <span className="text-muted">{s.timestamp}</span>
                    {s.channel ? ` · ${s.channel}` : ""}
                    {s.date ? ` · ${s.date}` : ""}
                  </span>
                </span>
                <svg className="mt-0.5 shrink-0 text-faint" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M7 17 17 7M9 7h8v8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* Lightweight renderer: paragraphs, headings, bullets, **bold**, and [n] citation chips. */
function renderAnswer(text: string, onCite: (n: number) => void) {
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim());
  return blocks.map((block, bi) => {
    const lines = block.split("\n");
    const isList = lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l));
    if (isList) {
      return (
        <ul key={bi} className="my-3 space-y-1.5 pl-1">
          {lines.map((l, li) => (
            <li key={li} dir="auto" className="flex gap-2.5">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-accent2/70" />
              <span>{inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ""), `${bi}-${li}`, onCite)}</span>
            </li>
          ))}
        </ul>
      );
    }
    const heading = block.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      return (
        <h3 key={bi} dir="auto" className="mb-2 mt-5 text-base font-semibold text-fg">
          {inline(heading[2], `h-${bi}`, onCite)}
        </h3>
      );
    }
    return (
      <p key={bi} dir="auto" className="my-3">
        {inline(block.replace(/\n/g, " "), `p-${bi}`, onCite)}
      </p>
    );
  });
}

/* inline: **bold** and [n] / [n, m] citations */
function inline(text: string, key: string, onCite: (n: number) => void) {
  // split on bold and citation tokens, keeping them
  const parts = text.split(/(\*\*[^*]+\*\*|\[\d+(?:\s*,\s*\d+)*\])/g).filter(Boolean);
  return parts.map((p, i) => {
    const bold = p.match(/^\*\*([^*]+)\*\*$/);
    if (bold) {
      return (
        <strong key={`${key}-${i}`} className="font-semibold text-fg">
          {bold[1]}
        </strong>
      );
    }
    const cite = p.match(/^\[(\d+(?:\s*,\s*\d+)*)\]$/);
    if (cite) {
      const nums = cite[1].split(",").map((x) => parseInt(x.trim(), 10));
      return (
        <span key={`${key}-${i}`}>
          {nums.map((n, j) => (
            <span key={j}>
              <sup className="cite" onClick={() => onCite(n)} title={`Jump to source ${n}`}>
                {n}
              </sup>
              {j < nums.length - 1 ? "" : ""}
            </span>
          ))}
        </span>
      );
    }
    return <span key={`${key}-${i}`}>{p}</span>;
  });
}
