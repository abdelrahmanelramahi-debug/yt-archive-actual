import type { Metadata, Viewport } from "next";
import { Inter, Fraunces } from "next/font/google";
import Script from "next/script";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

// Characterful literary serif — carries the page's identity (headline + question).
const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
  axes: ["opsz", "SOFT"],
});

export const metadata: Metadata = {
  title: "La Tifti · لا تفتي",
  description:
    "Not a fatwa — the words of the scholars themselves, traced to the moment they were said. Ask across thousands of hours of lectures and debates, with timestamps.",
};

// Pinch-zoom stays enabled (no maximum-scale); the 16px inputs are what stop focus auto-zoom.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f3ed" },
    { media: "(prefers-color-scheme: dark)", color: "#16150f" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Set the theme before paint so there's no flash of the wrong colours.
  const themeInit = `(function(){try{var c=localStorage.getItem('theme')||'sepia';var t=c==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):c;var e=document.documentElement;e.setAttribute('data-theme',t);e.setAttribute('data-theme-choice',c);}catch(e){document.documentElement.setAttribute('data-theme','sepia');}})();`;
  return (
    <html lang="en" className={`${inter.variable} ${fraunces.variable}`} data-theme="sepia" suppressHydrationWarning>
      <body>
        <Script id="theme-init" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: themeInit }} />
        {children}
      </body>
    </html>
  );
}
