import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Canonical domain: send the old auto-assigned Vercel URL to latafti.com (preview deploys, which
  // use a longer yt-archive-actual-<hash>.vercel.app host, are left alone).
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "yt-archive-actual.vercel.app" }],
        destination: "https://latafti.com/:path*",
        permanent: true,
      },
    ];
  },
  // Serve Firebase Auth's sign-in helper from our own domain so it's same-site with the app. iOS
  // Safari (and other browsers that block cross-site storage) otherwise break Google sign-in with
  // "missing initial state" because the handler on *.firebaseapp.com can't reach the state saved on
  // latafti.com. With authDomain set to latafti.com, the browser stays on latafti.com throughout and
  // these paths transparently proxy to the real Firebase handler.
  async rewrites() {
    return [
      { source: "/__/auth/:path*", destination: "https://latafti.firebaseapp.com/__/auth/:path*" },
      { source: "/__/firebase/:path*", destination: "https://latafti.firebaseapp.com/__/firebase/:path*" },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
