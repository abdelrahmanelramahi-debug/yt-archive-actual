"use client";

import { useState } from "react";
import { signInWithGoogle, signUpEmail, signInEmail, continueAsGuest } from "../lib/auth";
import { useLang, LangToggle } from "../lib/i18n";

// map Firebase's error codes to a dictionary key ("" = silent, e.g. the user closed the popup)
function errKey(e: unknown): string {
  const code = (e as { code?: string })?.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found"))
    return "signin.err.wrong";
  if (code.includes("email-already-in-use")) return "signin.err.inUse";
  if (code.includes("weak-password")) return "signin.err.weak";
  if (code.includes("invalid-email")) return "signin.err.invalidEmail";
  if (code.includes("popup-closed") || code.includes("cancelled-popup")) return "";
  if (code.includes("operation-not-allowed") || code.includes("admin-restricted-operation")) return "signin.err.guestOff";
  if (code.includes("too-many-requests")) return "signin.err.tooMany";
  return "signin.err.generic";
}

// the guest limit prompt sets this so we open straight into the right mode
function initialMode(): "in" | "up" {
  try {
    const m = localStorage.getItem("authMode");
    localStorage.removeItem("authMode");
    if (m === "up") return "up";
  } catch {
    /* ignore */
  }
  return "in";
}

export default function SignIn() {
  const { t } = useLang();
  const friendly = (e: unknown) => {
    const k = errKey(e);
    return k ? t(k) : "";
  };
  const [mode, setMode] = useState<"in" | "up">(initialMode);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function withGoogle() {
    setErr("");
    setBusy(true);
    try {
      await signInWithGoogle();
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  async function asGuest() {
    setErr("");
    setBusy(true);
    try {
      await continueAsGuest();
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (mode === "up") await signUpEmail(email.trim(), pw);
      else await signInEmail(email.trim(), pw);
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  const field =
    "w-full rounded-lg border border-line bg-raised px-3.5 py-2.5 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none";

  return (
    <main className="relative mx-auto flex min-h-[100dvh] w-full max-w-sm flex-col justify-center px-5 pb-16">
      <div className="absolute end-0 top-5">
        <LangToggle />
      </div>
      <div className="fade-up">
        <span className="logo-mark" role="img" aria-label="La Tafti · لا تفتي" />
        <h1 dir="auto" className="mt-6 font-serif text-[1.7rem] font-medium leading-tight text-ink">
          {mode === "up" ? t("signin.createTitle") : t("signin.welcome")}
        </h1>
        <p dir="auto" className="mt-2 text-sm leading-relaxed text-muted">
          {t("signin.tagline")}
        </p>

        <button
          type="button"
          onClick={withGoogle}
          disabled={busy}
          className="mt-7 flex w-full items-center justify-center gap-2.5 rounded-lg border border-line bg-raised px-4 py-2.5 text-sm font-medium text-ink transition hover:border-line2 disabled:opacity-60"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden>
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
            <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z" />
          </svg>
          {t("signin.google")}
        </button>

        <div className="my-5 flex items-center gap-3 text-xs text-faint">
          <span className="h-px flex-1 bg-line" /> {t("signin.or")} <span className="h-px flex-1 bg-line" />
        </div>

        <form onSubmit={submit} className="space-y-2.5">
          <input type="email" required autoComplete="email" dir="auto" placeholder={t("signin.email")} value={email} onChange={(e) => setEmail(e.target.value)} className={field} />
          <input type="password" required autoComplete={mode === "up" ? "new-password" : "current-password"} dir="auto" placeholder={t("signin.password")} value={pw} onChange={(e) => setPw(e.target.value)} className={field} />
          {err && <p className="text-[13px] text-danger">{err}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-paper transition hover:bg-accent2 disabled:opacity-60"
          >
            {busy ? "…" : mode === "up" ? t("signin.create") : t("signin.signIn")}
          </button>
        </form>

        <button
          type="button"
          onClick={asGuest}
          disabled={busy}
          className="mt-3 w-full rounded-lg border border-line bg-raised px-4 py-2.5 text-sm font-medium text-muted transition hover:border-line2 hover:text-ink disabled:opacity-60"
        >
          {t("signin.guest")}
        </button>
        <p className="mt-1.5 text-center text-[11px] text-faint">{t("signin.guestHint")}</p>

        <p className="mt-4 text-[13px] text-muted">
          {mode === "up" ? t("signin.haveAccount") : t("signin.newHere")}
          <button
            type="button"
            onClick={() => {
              setMode(mode === "up" ? "in" : "up");
              setErr("");
            }}
            className="font-medium text-accent hover:underline"
          >
            {mode === "up" ? t("signin.signInShort") : t("signin.createOne")}
          </button>
        </p>
        <p className="mt-6 text-[11px] leading-relaxed text-faint">
          {t("signin.agree").split("{terms}")[0]}
          <a href="/terms" className="underline transition hover:text-ink">{t("signin.terms")}</a>
          {t("signin.agree").split("{terms}")[1]?.split("{privacy}")[0]}
          <a href="/privacy" className="underline transition hover:text-ink">{t("signin.privacy")}</a>
          {t("signin.agree").split("{privacy}")[1] ?? "."}
        </p>
      </div>
    </main>
  );
}
