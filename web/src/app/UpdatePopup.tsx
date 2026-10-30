"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useLang } from "../lib/i18n";

const ICON = "mt-0.5 shrink-0 text-accent";
const Verbatim = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden className={ICON}>
    <path d="M9.5 5H6a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1.5c0 2.5-1 3.8-3 4.5M20 5h-3.5a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2H18c0 2.5-1 3.8-3 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const WhoSaid = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden className={ICON}>
    <path d="M16 21v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 19.5V21M10 12.5a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5ZM20 21v-1.5a3.5 3.5 0 0 0-2.6-3.4M16 5.2a3.75 3.75 0 0 1 0 7.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const History = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden className={ICON}>
    <path d="M3 3v5h5M3.05 13a9 9 0 1 0 2.13-5.5L3 8M12 7v5l3 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const Arabic = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden className={ICON}>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
    <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
const Answers = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden className={ICON}>
    <path d="M12 3l1.9 4.8L19 9l-4.3 2.6L16 17l-4-2.8L8 17l1.3-5.4L5 9l5.1-1.2L12 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  </svg>
);

// Updates, newest first. Add a new entry at the TOP (with a fresh id) to re-show the pop-up; older
// entries stay as flip-back pages. The id of the top entry is what "seen" is tracked against.
const UPDATES: { id: string; items: { key: string; icon: ReactNode }[] }[] = [
  {
    id: "2026-10-30b",
    items: [
      { key: "verbatim", icon: Verbatim },
      { key: "whosaid", icon: WhoSaid },
    ],
  },
  {
    id: "2026-10-30",
    items: [
      { key: "history", icon: History },
      { key: "arabic", icon: Arabic },
      { key: "answers", icon: Answers },
    ],
  },
];
const LATEST_ID = UPDATES[0].id;

export default function UpdatePopup() {
  const { t, dir } = useLang();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);

  useEffect(() => {
    try {
      if (localStorage.getItem("seenUpdate") !== LATEST_ID) setOpen(true);
    } catch {
      /* ignore */
    }
  }, []);

  function dismiss() {
    try {
      localStorage.setItem("seenUpdate", LATEST_ID);
    } catch {
      /* ignore */
    }
    setOpen(false);
  }

  if (!open) return null;
  const multi = UPDATES.length > 1;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-black/50" onClick={dismiss} aria-hidden />
      <div className="fade-up relative z-10 w-full max-w-sm overflow-hidden rounded-2xl border border-line bg-raised shadow-xl">
        <div className="px-6 pb-2 pt-6">
          <span className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-full bg-accent/10 text-accent">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M12 3l1.9 4.8L19 9l-4.3 2.6L16 17l-4-2.8L8 17l1.3-5.4L5 9l5.1-1.2L12 3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            </svg>
          </span>
          <h2 className="font-serif text-xl font-medium text-ink">{t("whatsnew.title")}</h2>
        </div>

        {/* paged content — the track slides; kept dir=ltr so the transform is predictable, while each
            page's own content follows the interface language */}
        <div className="overflow-hidden py-4" dir="ltr">
          <div
            className="flex transition-transform duration-300 ease-[cubic-bezier(0.2,0.7,0.2,1)]"
            style={{ transform: `translateX(-${page * 100}%)` }}
          >
            {UPDATES.map((u) => (
              <ul key={u.id} dir={dir} className="w-full shrink-0 list-none space-y-4 px-6">
                {u.items.map((it) => (
                  <li key={it.key} className="flex items-start gap-3">
                    {it.icon}
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink">{t(`whatsnew.${it.key}.t`)}</p>
                      <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{t(`whatsnew.${it.key}.b`)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            ))}
          </div>
        </div>

        {multi && (
          <div className="flex items-center justify-center gap-3 pb-0.5" dir="ltr">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              aria-label="Newer update"
              className="rounded-md p-1 text-faint transition enabled:hover:text-ink disabled:opacity-25"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="m15 6-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <div className="flex items-center gap-1.5">
              {UPDATES.map((u, i) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => setPage(i)}
                  aria-label={`Update ${i + 1}`}
                  className={`h-1.5 rounded-full transition-all duration-300 ${i === page ? "w-4 bg-accent" : "w-1.5 bg-line2"}`}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(UPDATES.length - 1, p + 1))}
              disabled={page === UPDATES.length - 1}
              aria-label="Older update"
              className="rounded-md p-1 text-faint transition enabled:hover:text-ink disabled:opacity-25"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        )}

        <div className="px-6 pb-6 pt-3">
          <button
            type="button"
            onClick={dismiss}
            className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-paper transition hover:bg-accent2"
          >
            {t("whatsnew.dismiss")}
          </button>
        </div>
      </div>
    </div>
  );
}
