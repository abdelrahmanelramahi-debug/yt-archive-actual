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

// Typical cost of one deluxe answer, shown up front so nobody is surprised by the bill.
const TYPICAL_COST = 0.08;

// Prices are shown to visitors in AED (UAE dirham), converted from the USD the brain reports.
const AED_PER_USD = 3.6725; // fixed USD peg
const aed = (usd: number) => `AED ${(usd * AED_PER_USD).toFixed(2)}`;

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

// Pure type wordmark — Latin name beside the Arabic it comes from. No icon: a
// generic glyph here is the first thing that reads as templated.
function Wordmark() {
  return (
    <div className="flex shrink-0 items-baseline gap-2.5">
      <span className="font-serif text-[19px] font-medium tracking-tight text-ink">La Tifti</span>
      <span className="text-[15px] text-faint" dir="rtl" lang="ar">
        لا تفتي
      </span>
    </div>
  );
}

// Brass cost pill — persistent, top of page, so the price is clear before anyone asks.
function CostPill() {
  return (
    <span
      title="Each question runs a full search and a written, cited answer. Cost varies a little with length."
      className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-gold/45 bg-gold/[0.06] px-2.5 py-1 text-xs font-medium text-gold2"
    >
      ≈ {aed(TYPICAL_COST)} per question
    </span>
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
      {/* header: identity + persistent cost */}
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-6">
        <Wordmark />
        <CostPill />
      </header>

      {/* hero */}
      <section className={landing ? "pt-[12vh]" : "pt-5"}>
        {landing && (
          <div className="fade-up mb-9">
            <h1 className="max-w-2xl text-balance font-serif text-[2.1rem] font-medium leading-[1.12] tracking-tight text-ink sm:text-[2.7rem]">
              Ask across the archive
            </h1>
            <p className="mt-4 max-w-xl text-[16px] leading-relaxed text-muted">
              Not a fatwa — the words of the scholars themselves, drawn from thousands of hours of
              lectures and debates and traced to the exact moment they were said, with a timestamp
              you can open on the video.
            </p>
          </div>
        )}

        {/* ask bar */}
        <form onSubmit={onSubmit} className="sticky top-3 z-10">
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
              disabled={!q.trim() || status === "loading"}
              aria-label="Ask"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-paper transition enabled:hover:bg-accent2 disabled:opacity-30"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </form>

        {/* cost + scope, shown before you send */}
        {landing && (
          <p className="fade-up mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-faint">
            <span className="text-gold2">≈ {aed(TYPICAL_COST)} per answer</span>
            <span className="text-line2">·</span>
            <span>drawn from a million+ moments across 19 channels</span>
          </p>
        )}

        {landing && (
          <div className="fade-up mt-7">
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
      </section>

      {/* conversation area */}
      {asked && (
        <section className="mt-9">
          <h2 dir="auto" className="font-serif text-[1.4rem] font-medium leading-snug text-ink">
            {asked}
          </h2>

          {status === "loading" && <Loading stage={stage} />}

          {status === "error" && (
            <div className="mt-5 rounded-xl border border-danger/25 bg-danger/[0.06] px-4 py-3 text-sm text-danger">
              {error}
            </div>
          )}

          {status === "done" && result && <AnswerView result={result} onCite={scrollToSource} />}
        </section>
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
        {renderAnswer(result.answer, onCite)}
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

      {result.sources.length > 0 && (
        <div className="mt-7">
          <h3 className="mb-3 font-serif text-sm font-medium text-muted">Sources</h3>
          <div className="space-y-2">
            {result.sources.map((s) => (
              <a
                key={s.n}
                id={`src-${s.n}`}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-3.5 rounded-xl border border-line bg-raised px-4 py-3 transition hover:border-line2 hover:shadow-[0_8px_24px_-16px_rgba(35,33,27,0.35)]"
              >
                <span className="mt-0.5 min-w-6 font-serif text-[15px] font-semibold tabular-nums text-gold">
                  {s.n}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-sm text-ink" dir="auto">
                    {s.title}
                  </span>
                  <span className="mt-1 block text-xs text-faint">
                    <span className="font-medium text-accent">{s.timestamp}</span>
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

/* Lightweight renderer: paragraphs, headings, bullets, **bold**, and [n] citation chips.
   Line-based so a "### Heading" is caught even when the model glues it to the next line. */
const HEADING = /^\s*(#{1,4})\s+(.*)$/;
const BULLET = /^\s*([-*•]|\d+[.)])\s+/;

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
        <span key={`${key}-${i}`}>
          {nums.map((n, j) => (
            <span key={j}>
              <sup className="cite" onClick={() => onCite(n)} title={`Jump to source ${n}`}>
                {n}
              </sup>
              {j < nums.length - 1 ? <span className="cite-sep"> </span> : ""}
            </span>
          ))}
        </span>
      );
    }
    return <span key={`${key}-${i}`}>{p}</span>;
  });
}
