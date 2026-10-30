"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useLang } from "../lib/i18n";

// Bump this whenever there's a new batch worth announcing — each new id shows the pop-up once per
// browser. Keep the item list below in sync with what actually shipped.
const UPDATE_ID = "2026-10-30";

const ICON = "mt-0.5 shrink-0 text-accent";
const ITEMS: { key: string; icon: ReactNode }[] = [
  {
    key: "history",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden className={ICON}>
        <path d="M3 3v5h5M3.05 13a9 9 0 1 0 2.13-5.5L3 8M12 7v5l3 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: "arabic",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden className={ICON}>
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
        <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "answers",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden className={ICON}>
        <path d="M12 3l1.9 4.8L19 9l-4.3 2.6L16 17l-4-2.8L8 17l1.3-5.4L5 9l5.1-1.2L12 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export default function UpdatePopup() {
  const { t } = useLang();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem("seenUpdate") !== UPDATE_ID) setOpen(true);
    } catch {
      /* ignore */
    }
  }, []);

  function dismiss() {
    try {
      localStorage.setItem("seenUpdate", UPDATE_ID);
    } catch {
      /* ignore */
    }
    setOpen(false);
  }

  if (!open) return null;

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

        <div className="space-y-4 px-6 py-4">
          {ITEMS.map((it) => (
            <div key={it.key} className="flex items-start gap-3">
              {it.icon}
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{t(`whatsnew.${it.key}.t`)}</p>
                <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{t(`whatsnew.${it.key}.b`)}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="px-6 pb-6 pt-2">
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
