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
