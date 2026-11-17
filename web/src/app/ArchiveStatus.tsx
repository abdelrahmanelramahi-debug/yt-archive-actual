"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLang } from "../lib/i18n";

// After each update the archive (the "brain" that searches) restarts for a few minutes and can't
// answer. The page checks /api/status - on load, every minute, when the tab comes back, and right away
// if a question comes back "updating" - and shows a notice until it's ready again, then says so.
export type ArchiveState = "ok" | "updating" | "back";

export function useArchiveStatus() {
  const [state, setState] = useState<ArchiveState>("ok");

  const check = useCallback(async () => {
    try {
      const r = await fetch("/api/status", { cache: "no-store" });
      const d = (await r.json()) as { up?: boolean };
      setState((s) => (d.up ? (s === "updating" ? "back" : s) : "updating"));
    } catch {
      /* the visitor is offline: that says nothing about the archive */
    }
  }, []);

  // a question came back "updating": show the notice now and keep checking
  const markUpdating = useCallback(() => setState("updating"), []);

  useEffect(() => {
    const first = setTimeout(check, 0);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(first);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check]);

  // every 10 s while updating, every minute otherwise (only while the tab is in view)
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, state === "updating" ? 10_000 : 60_000);
    return () => clearInterval(id);
  }, [state, check]);

  // "ready again" shows for a few seconds, then goes
  const backTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (state !== "back") return;
    backTimer.current = setTimeout(() => setState("ok"), 8000);
    return () => {
      if (backTimer.current) clearTimeout(backTimer.current);
    };
  }, [state]);

  return { state, markUpdating };
}

export function StatusBanner({ state }: { state: ArchiveState }) {
  const { t } = useLang();
  if (state === "ok") return null;
  const updating = state === "updating";
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-40 flex justify-center px-4" role="status" aria-live="polite">
      <div
        className={`fade-up pointer-events-auto flex max-w-md items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px] leading-relaxed shadow-lg ${
          updating ? "border-gold/50 bg-raised text-ink" : "border-accent/40 bg-raised text-ink"
        }`}
      >
        {updating ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden className="mt-0.5 shrink-0 animate-spin text-gold2">
            <path d="M12 3a9 9 0 1 0 9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden className="mt-0.5 shrink-0 text-accent">
            <path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        <span dir="auto">{t(updating ? "status.updating" : "status.back")}</span>
      </div>
    </div>
  );
}
