"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth, idToken, signOutUser } from "../../../lib/auth";
import { useLang, LangToggle } from "../../../lib/i18n";
import SignIn from "../../SignIn";

const MCP_CAP = 200; // the daily connector allowance (server default MCP_CAP)
const PARAMS = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope", "resource"];

type Info = { client: string; host: string; loopback: boolean };

export default function Consent() {
  const { t } = useLang();
  const sp = useSearchParams();
  const { user, loading } = useAuth();
  const request = useMemo(() => Object.fromEntries(PARAMS.map((k) => [k, sp.get(k) || ""])), [sp]);
  const [info, setInfo] = useState<Info | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // check the request first: a bad one shows an error here (never a redirect)
  useEffect(() => {
    let live = true;
    fetch("/api/oauth/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, action: "check" }),
    })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!live) return;
        if (d.redirect) window.location.replace(d.redirect); // the client's own request was malformed: tell it
        else if (!r.ok) setErr("connect.err.badRequest");
        else setInfo(d as Info);
      })
      .catch(() => live && setErr("connect.err.network"));
    return () => {
      live = false;
    };
  }, [request]);

  async function decide(action: "allow" | "deny") {
    setBusy(true);
    setErr("");
    try {
      const tok = action === "allow" ? await idToken() : null;
      const r = await fetch("/api/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify({ ...request, action }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.redirect) {
        window.location.replace(d.redirect); // back to Claude (stays "busy" while the browser leaves)
        return;
      }
      setErr(d.error === "guest" ? "connect.err.guest" : "connect.err.failed");
    } catch {
      setErr("connect.err.network");
    }
    setBusy(false);
  }

  if (err === "connect.err.badRequest") {
    return (
      <Shell>
        <h1 dir="auto" className="mt-6 font-serif text-[1.6rem] font-medium leading-tight text-ink">{t("connect.badTitle")}</h1>
        <p dir="auto" className="mt-2 text-sm leading-relaxed text-muted">{t("connect.err.badRequest")}</p>
      </Shell>
    );
  }
  if (loading || (!info && !err)) return <Shell />;
  if (!user) return <SignIn title={t("connect.signinTitle")} tagline={t("connect.signinTagline")} noGuest />;

  if (user.isAnonymous) {
    return (
      <Shell>
        <h1 dir="auto" className="mt-6 font-serif text-[1.6rem] font-medium leading-tight text-ink">{t("connect.title")}</h1>
        <p dir="auto" className="mt-2 text-sm leading-relaxed text-muted">{t("connect.err.guest")}</p>
        <button type="button" onClick={() => signOutUser()} className="mt-6 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-paper transition hover:bg-accent2">
          {t("connect.signin")}
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 dir="auto" className="mt-6 font-serif text-[1.6rem] font-medium leading-tight text-ink">{t("connect.title")}</h1>
      <p dir="auto" className="mt-2 text-sm leading-relaxed text-muted">
        {t("connect.asking", { client: info?.client || "Claude" })}
      </p>

      <div className="mt-6 rounded-xl border border-line bg-raised p-4">
        <p dir="auto" className="text-[13px] font-medium text-ink">{t("connect.can")}</p>
        <ul className="mt-2.5 space-y-2 text-[13px] text-muted">
          {[t("connect.can1"), t("connect.can2"), t("connect.can3", { cap: MCP_CAP })].map((x) => (
            <li key={x} dir="auto" className="flex gap-2">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden className="mt-0.5 shrink-0 text-accent">
                <path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>{x}</span>
            </li>
          ))}
        </ul>
        <p dir="auto" className="mt-3 border-t border-line pt-3 text-[12px] leading-relaxed text-faint">{t("connect.cannot")}</p>
      </div>

      <p className="mt-4 text-[12px] text-faint">
        <span dir="auto">{t("connect.as")} </span>
        <span dir="ltr" className="text-ink">{user.email}</span>
        <span aria-hidden> · </span>
        <button type="button" onClick={() => signOutUser()} className="text-accent hover:underline">{t("connect.notYou")}</button>
      </p>

      {info?.loopback && (
        <p dir="auto" className="mt-4 rounded-lg border border-gold/40 bg-gold/10 px-3 py-2 text-[12px] leading-relaxed text-ink">
          {t("connect.loopback", { host: info.host })}
        </p>
      )}
      {err && <p dir="auto" className="mt-4 text-[13px] text-danger">{t(err)}</p>}

      <div className="mt-6 flex gap-2.5">
        <button type="button" onClick={() => decide("deny")} disabled={busy} className="flex-1 rounded-lg border border-line bg-raised px-4 py-2.5 text-sm font-medium text-muted transition hover:border-line2 hover:text-ink disabled:opacity-60">
          {t("connect.cancel")}
        </button>
        <button type="button" onClick={() => decide("allow")} disabled={busy} className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-paper transition hover:bg-accent2 disabled:opacity-60">
          {busy ? "…" : t("connect.allow")}
        </button>
      </div>
      {info && !info.loopback && (
        <p dir="auto" className="mt-3 text-center text-[11px] text-faint">{t("connect.back", { host: info.host })}</p>
      )}
      <p dir="auto" className="mt-6 text-[11px] leading-relaxed text-faint">{t("connect.later")}</p>
    </Shell>
  );
}

function Shell({ children }: { children?: React.ReactNode }) {
  return (
    <main className="relative mx-auto flex min-h-[100dvh] w-full max-w-sm flex-col justify-center px-5 pb-16">
      <div className="absolute end-0 top-5">
        <LangToggle />
      </div>
      <div className="fade-up">
        <span className="logo-mark" role="img" aria-label="La Tafti" />
        {children}
      </div>
    </main>
  );
}
