import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // firebase-admin has dynamic requires + native deps; let it load at runtime instead of being
  // bundled, or the API routes crash (500) when it's imported on Vercel.
  serverExternalPackages: ["firebase-admin"],
  // ...and force its (heavy, dynamically-required) dep trees into the serverless function, or
  // Node File Trace misses files and the route 500s on Vercel even though it works locally.
  outputFileTracingIncludes: {
    "/api/ask": ["node_modules/firebase-admin/**/*", "node_modules/@google-cloud/**/*", "node_modules/@grpc/**/*", "node_modules/@opentelemetry/**/*", "node_modules/google-gax/**/*", "node_modules/protobufjs/**/*", "node_modules/google-auth-library/**/*", "node_modules/gaxios/**/*", "node_modules/gcp-metadata/**/*"],
    "/api/ask/stream": ["node_modules/firebase-admin/**/*", "node_modules/@google-cloud/**/*", "node_modules/@grpc/**/*", "node_modules/@opentelemetry/**/*", "node_modules/google-gax/**/*", "node_modules/protobufjs/**/*", "node_modules/google-auth-library/**/*", "node_modules/gaxios/**/*", "node_modules/gcp-metadata/**/*"],
  },
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
