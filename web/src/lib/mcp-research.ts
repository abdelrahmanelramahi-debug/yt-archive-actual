// The connector's Research and history tools (see app/mcp/route.ts). Research asks the brain for the
// same answer the website writes: it counts against the account's daily answers, is saved to the
// account's history once finished, and comes back to Claude as text with its numbered sources.
import { saveHistory, listHistory, getHistory } from "./firebase-admin";

const BRAIN_URL = process.env.BRAIN_URL || "http://127.0.0.1:8000";
const BRAIN_KEY = process.env.BRAIN_KEY || "";
const TEXT_MAX = 60000; // characters one tool reply holds, at most

type Line = { ts?: string | null; text?: string };
type Quote = { kind?: string; ref?: string; book_en?: string; num?: string; ar_full?: string; en?: string };
type Source = {
  n: number;
  timestamp?: string;
  title?: string;
  channel?: string | null;
  date?: string | null;
  url?: string;
  video_id?: string | null;
  slug?: string | null;
  context?: Line[];
  citedIdx?: number;
  quotes?: Quote[];
};
type Coverage = { moments?: number; videos?: number; channels?: number };
type Reply = {
  state: "done" | "running" | "empty" | "error" | "gone";
  job_id?: string;
  q?: string;
  mode?: string;
  style?: string;
  stage?: string;
  written?: number;
  error?: string;
  answer?: string;
  sources?: Source[];
  coverage?: Coverage;
  cost_usd?: number;
  cached?: boolean;
  relevant?: { c: string; s: string }[];
  first?: boolean;
};

export type ToolResult = { content: { type: "text"; text: string }[]; isError: boolean };
export const toolText = (text: string, isError = false): ToolResult => ({ content: [{ type: "text", text }], isError });

const clip = (s: string) => (s.length > TEXT_MAX ? s.slice(0, TEXT_MAX) + "\n\n(cut short here)" : s);

// as the website stores a source card in history: the transcript window kept, the long hadith text dropped
const lightSource = (s: Source) => ({
  n: s.n,
  timestamp: s.timestamp ?? "",
  title: s.title ?? "",
  channel: s.channel ?? null,
  date: s.date ?? null,
  url: s.url ?? "",
  video_id: s.video_id ?? null,
  slug: s.slug ?? null,
  context: (s.context ?? []).map((l) => ({ ts: l.ts ?? null, text: l.text ?? "" })),
  citedIdx: s.citedIdx ?? 0,
  ...(s.quotes?.length ? { quotes: s.quotes.map((q) => (q.kind === "hadith" ? { ...q, ar_full: "", en: "" } : q)) } : {}),
});

function sourceLines(sources: Source[]): string {
  return sources
    .map((s) => {
      const head = [s.channel, s.title ? `"${s.title}"` : "", s.date || "", s.timestamp ? `at ${s.timestamp}` : ""]
        .filter(Boolean)
        .join(" | ");
      const line = s.context?.[s.citedIdx ?? 0]?.text?.trim() || "";
      const said = line.length > 400 ? line.slice(0, 400) + "…" : line; // read_transcript gives the rest
      const recites = (s.quotes || [])
        .map((q) => (q.kind === "quran" ? `Quran ${q.ref}` : q.book_en ? `${q.book_en} ${q.num ?? ""}`.trim() : ""))
        .filter(Boolean);
      return [
        `[${s.n}] ${head}`,
        s.url || "",
        said ? `> ${said}` : "",
        recites.length ? `(recites ${recites.join("; ")})` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

const STAGES: Record<string, string> = {
  searching: "searching the archive",
  reading: "reading the moments it found",
  writing: "writing the answer",
};

function wordReply(d: Reply, left?: number): ToolResult {
  switch (d.state) {
    case "gone":
      return toolText("That research answer is no longer available (they are kept for 30 minutes). Ask again with research.", true);
    case "error":
      return toolText(`The research answer failed: ${d.error || "unknown error"}.`, true);
    case "empty":
      return toolText(
        "La Tafti found nothing in the archive that addresses this question. Tell the user so, rather than answering from your own knowledge."
      );
    case "running": {
      const stage = STAGES[d.stage || ""] || "working on it";
      const sofar = d.stage === "writing" && d.written ? `, ${d.written} characters so far` : "";
      return toolText(
        `La Tafti is still on this research answer (${stage}${sofar}). Call check_research with job_id "${d.job_id}" to keep waiting; ` +
          "each call waits up to about a minute, and a Deep answer can take a few minutes. It doesn't use another daily answer." +
          (left !== undefined ? ` This account has ${left} Research answer${left === 1 ? "" : "s"} left today.` : "")
      );
    }
    case "done": {
      const cov = d.coverage || {};
      const sources = d.sources || [];
      const head =
        `La Tafti Research answer (${d.mode || "standard"} depth, ${d.style || "topical"} style)` +
        (d.cached ? ", served free from an identical earlier question" : "") +
        `. It read ${cov.moments ?? "?"} moments across ${cov.videos ?? "?"} videos and cites ${sources.length} of them.` +
        (left !== undefined ? ` This account has ${left} Research answer${left === 1 ? "" : "s"} left today.` : "") +
        "\nGive the user this answer faithfully: you may format or shorten it, but add no rulings of your own, and keep each [n] citation linked to its source below. It is also saved in their La Tafti history.";
      return toolText(clip(`${head}\n\n---\n${(d.answer || "").trim()}\n---\n\nSources:\n${sourceLines(sources)}`));
    }
  }
}

// Ask the brain to start an answer (question) or keep waiting for one (jobId), then word the reply.
// A finished answer is saved to the account's history the first time it is handed over.
export async function research(
  uid: string,
  body: { question?: string; job_id?: string; channels?: string[]; mode?: string; style?: string; channel_names?: unknown },
  left?: number
): Promise<ToolResult> {
  let d: Reply;
  try {
    const r = await fetch(`${BRAIN_URL}/mcp/research`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(BRAIN_KEY ? { "X-Brain-Key": BRAIN_KEY } : {}), "X-User-Id": uid },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(110_000),
    });
    if (!r.ok) return toolText("The archive is busy or restarting - try again in a minute.", true);
    d = (await r.json()) as Reply;
  } catch {
    return toolText("Couldn't reach the archive - try again in a minute.", true);
  }
  if (d.state === "done" && d.first && d.answer) {
    try {
      await saveHistory(uid, {
        q: d.q || body.question || "",
        answer: d.answer,
        sources: (d.sources || []).map(lightSource),
        coverage: d.coverage || { moments: 0, videos: 0, channels: 0 },
        cost_usd: d.cost_usd ?? null,
        relevant: (d.relevant || []).map((x) => ({ c: x.c, s: x.s })),
        style: d.style || "topical",
        via: "claude",
      });
    } catch {
      /* best-effort, as on the website: never lose the answer over a history write */
    }
  }
  return wordReply(d, left);
}

const day = (iso: string) => (iso ? iso.slice(0, 10) : "");

export async function historyList(uid: string): Promise<ToolResult> {
  const items = await listHistory(uid, 30);
  if (!items.length) return toolText("This La Tafti account has no saved questions yet.");
  const lines = items.map(
    (h) => `${h.id} | ${day(h.createdAt)} | ${h.kind === "chat" ? "Chat" : "Research"}${h.via === "claude" ? " (asked through Claude)" : ""} | ${h.q}`
  );
  return toolText(
    `The account's ${items.length} most recent saved questions, newest first (id | date | kind | question). open_saved reads one in full:\n` +
      lines.join("\n")
  );
}

export async function historyOpen(uid: string, id: string): Promise<ToolResult> {
  const doc = await getHistory(uid, id);
  if (!doc) return toolText("There's no saved question with that id in this account. my_history lists them.", true);
  const when = day(String(doc.createdAt || ""));
  if (doc.kind === "chat") {
    const turns = (Array.isArray(doc.turns) ? doc.turns : []) as { q?: string; answer?: string; sources?: Source[] }[];
    const body = turns
      .map((t, i) => {
        const src = t.sources?.length ? `\n\nSources for this reply:\n${sourceLines(t.sources)}` : "";
        return `Message ${i + 1}: ${t.q || ""}\n\nLa Tafti's reply:\n${(t.answer || "").trim()}${src}`;
      })
      .join("\n\n======\n\n");
    return toolText(clip(`Saved Chat conversation (${when}):\n\n${body}`));
  }
  const sources = (Array.isArray(doc.sources) ? doc.sources : []) as Source[];
  return toolText(
    clip(
      `Saved Research answer (${when}${doc.style ? `, ${doc.style} style` : ""}) to: ${doc.q || ""}\n\n---\n${String(doc.answer || "").trim()}\n---\n\nSources:\n${sourceLines(sources)}`
    )
  );
}
