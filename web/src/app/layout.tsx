import type { Metadata, Viewport } from "next";
import { Inter, Fraunces } from "next/font/google";
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
  themeColor: "#f3f1e9",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${fraunces.variable}`}>
      <body>{children}</body>
    </html>
  );
}
