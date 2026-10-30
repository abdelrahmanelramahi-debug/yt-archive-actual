import Link from "next/link";
import { ReactNode } from "react";

// Shared frame for the /privacy and /terms pages: back-to-home link, title, content, footer.
export function LegalShell({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 sm:py-14">
      <Link href="/" className="inline-flex items-center gap-1.5 text-[13px] text-muted transition hover:text-ink">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="font-serif text-accent">La Tafti</span>
      </Link>
      <h1 className="mt-6 font-serif text-[1.9rem] font-medium leading-tight text-ink">{title}</h1>
      <p className="mt-1.5 text-[13px] text-faint">Last updated {updated}</p>
      <article className="legal mt-7">{children}</article>
      <footer className="mt-14 border-t border-line pt-5 text-[13px] text-faint">
        <Link href="/" className="transition hover:text-ink">Home</Link>
        <span className="mx-2.5">·</span>
        <Link href="/privacy" className="transition hover:text-ink">Privacy</Link>
        <span className="mx-2.5">·</span>
        <Link href="/terms" className="transition hover:text-ink">Terms</Link>
      </footer>
    </main>
  );
}
