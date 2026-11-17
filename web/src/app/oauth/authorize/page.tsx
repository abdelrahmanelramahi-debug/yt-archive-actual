import type { Metadata } from "next";
import { Suspense } from "react";
import Consent from "./Consent";

export const metadata: Metadata = {
  title: "Connect Claude · La Tafti",
  robots: { index: false },
};

// Where Claude sends someone to sign in and allow the La Tafti connector (see lib/mcp-auth.ts).
export default function AuthorizePage() {
  return (
    <Suspense fallback={null}>
      <Consent />
    </Suspense>
  );
}
