"use client";

import { useState } from "react";
import { idToken } from "../lib/auth";
import { useLang } from "../lib/i18n";

/* "Use in Claude": how to add La Tafti to Claude as a connector (latafti.com/mcp), today's connector
   searches, and a switch that signs Claude out of this account everywhere. */
export default function ClaudePanel({ used, cap, onClose }: { used: number; cap: number; onClose: () => void }) {
  const { t } = useLang();
  // the panel only opens on a click, so it never renders on the server: the origin is safe to read here
  const [address] = useState(() => (typeof window === "undefined" ? "https://latafti.com" : window.location.origin) + "/mcp");
  const [copied, setCopied] = useState("");
  const [disc, setDisc] = useState<"idle" | "confirm" | "busy" | "done" | "error">("idle");
  const command = `claude mcp add --transport http latafti ${address}`;

  async function copy(text: string, which: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(""), 1600);
    } catch {
      /* clipboard blocked: the text is selectable */
    }
  }

  async function disconnect() {
    setDisc("busy");
    try {
      const tok = await idToken();
      const r = await fetch("/api/mcp/disconnect", { method: "POST", headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
      setDisc(r.ok ? "done" : "error");
    } catch {
      setDisc("error");
    }
  }

  const box = "flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2";
  const copyBtn = "shrink-0 rounded-md border border-line px-2 py-1 text-[12px] text-muted transition hover:border-line2 hover:text-ink";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div className="relative z-10 flex max-h-[88vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-line bg-raised shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 dir="auto" className="text-[15px] font-medium text-ink">{t("claude.title")}</h2>
          <button type="button" onClick={onClose} aria-label={t("admin.close")} className="rounded-md p-1.5 text-faint transition hover:bg-line/40 hover:text-ink">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="space-y-4 overflow-y-auto px-4 py-4 text-[13px] leading-relaxed text-muted">
          <p dir="auto">{t("claude.intro")}</p>

          <div>
            <p dir="auto" className="mb-1.5 text-[12px] font-medium text-ink">{t("claude.address")}</p>
            <div className={box}>
              <code dir="ltr" className="min-w-0 flex-1 select-all truncate text-[13px] text-ink">{address}</code>
              <button type="button" onClick={() => copy(address, "address")} className={copyBtn}>
                {copied === "address" ? t("claude.copied") : t("claude.copy")}
              </button>
            </div>
          </div>

          <div>
            <p dir="auto" className="mb-1.5 text-[12px] font-medium text-ink">{t("claude.stepsTitle")}</p>
            <ol className="list-decimal space-y-1 ps-5">
              {["claude.step1", "claude.step2", "claude.step3", "claude.step4"].map((k) => (
                <li key={k} dir="auto">{t(k)}</li>
              ))}
            </ol>
          </div>

          <div>
            <p dir="auto" className="mb-1.5 text-[12px] font-medium text-ink">{t("claude.codeTitle")}</p>
            <div className={box}>
              <code dir="ltr" className="min-w-0 flex-1 select-all break-all text-[12px] text-ink">{command}</code>
              <button type="button" onClick={() => copy(command, "command")} className={copyBtn}>
                {copied === "command" ? t("claude.copied") : t("claude.copy")}
              </button>
            </div>
          </div>

          <p dir="auto" className="text-[12px] text-faint">{t("claude.usage", { used, cap })}</p>

          <div className="border-t border-line pt-3">
            {disc === "done" ? (
              <p dir="auto" className="text-[12px] text-ink">{t("claude.disconnected")}</p>
            ) : disc === "confirm" || disc === "busy" ? (
              <div className="space-y-2">
                <p dir="auto" className="text-[12px] text-ink">{t("claude.confirm")}</p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setDisc("idle")} disabled={disc === "busy"} className="rounded-md border border-line px-3 py-1.5 text-[12px] text-muted transition hover:text-ink disabled:opacity-60">
                    {t("connect.cancel")}
                  </button>
                  <button type="button" onClick={disconnect} disabled={disc === "busy"} className="rounded-md bg-danger px-3 py-1.5 text-[12px] font-medium text-paper transition hover:opacity-90 disabled:opacity-60">
                    {disc === "busy" ? "…" : t("claude.disconnect")}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button type="button" onClick={() => setDisc("confirm")} className="text-[12px] text-faint transition hover:text-danger">
                  {t("claude.disconnect")}
                </button>
                {disc === "error" && <p dir="auto" className="mt-1 text-[12px] text-danger">{t("claude.disconnectFailed")}</p>}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
