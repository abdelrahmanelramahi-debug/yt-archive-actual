"use client";

import { useState } from "react";
import { signInWithGoogle, signUpEmail, signInEmail } from "../lib/auth";

// map Firebase's error codes to something a person can read
function friendly(e: unknown): string {
  const code = (e as { code?: string })?.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found"))
    return "Wrong email or password.";
  if (code.includes("email-already-in-use")) return "That email already has an account — try signing in.";
  if (code.includes("weak-password")) return "Password should be at least 6 characters.";
  if (code.includes("invalid-email")) return "That doesn't look like a valid email.";
  if (code.includes("popup-closed") || code.includes("cancelled-popup")) return "";
  if (code.includes("too-many-requests")) return "Too many tries — wait a moment and try again.";
  return "Something went wrong. Please try again.";
}

export default function SignIn() {
  const [mode, setMode] = useState<"in" | "up">("in");
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
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-sm flex-col justify-center px-5 pb-16">
      <div className="fade-up">
        <span className="logo-mark" role="img" aria-label="La Tafti · لا تفتي" />
        <h1 className="mt-6 font-serif text-[1.7rem] font-medium leading-tight text-ink">
          {mode === "up" ? "Create your account" : "Welcome back"}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Ask across the archive — the words of the scholars themselves, traced to the moment they were said.
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
          Continue with Google
        </button>

        <div className="my-5 flex items-center gap-3 text-xs text-faint">
          <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
        </div>

        <form onSubmit={submit} className="space-y-2.5">
          <input type="email" required autoComplete="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className={field} />
          <input type="password" required autoComplete={mode === "up" ? "new-password" : "current-password"} placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} className={field} />
          {err && <p className="text-[13px] text-danger">{err}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-paper transition hover:bg-accent2 disabled:opacity-60"
          >
            {busy ? "…" : mode === "up" ? "Create account" : "Sign in"}
          </button>
        </form>

        <p className="mt-4 text-[13px] text-muted">
          {mode === "up" ? "Already have an account? " : "New here? "}
          <button
            type="button"
            onClick={() => {
              setMode(mode === "up" ? "in" : "up");
              setErr("");
            }}
            className="font-medium text-accent hover:underline"
          >
            {mode === "up" ? "Sign in" : "Create one"}
          </button>
        </p>
      </div>
    </main>
  );
}
