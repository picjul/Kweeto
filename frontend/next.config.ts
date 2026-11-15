import { readFileSync } from "node:fs";
import type { NextConfig } from "next";

// one version for the whole app: package.json (kept equal to backend/app/__init__.py __version__)
const version: string = JSON.parse(readFileSync(`${process.cwd()}/package.json`, "utf8")).version;

// Docker (see ../Dockerfile): the image builds with KWEETO_STANDALONE=1 and an empty NEXT_PUBLIC_API_URL, so the
// browser calls /api and /files on the frontend's own origin and Next.js forwards them to the backend that runs in
// the same container. One port, no CORS. Local development is unchanged (the browser talks to :8000 directly).
const standalone = process.env.KWEETO_STANDALONE === "1";
const backend = process.env.KWEETO_BACKEND_URL ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_KWEETO_VERSION: version },
  eslint: { ignoreDuringBuilds: true },
  // a separate build folder (e.g. ".next-test") lets a test build run while `next dev` uses .next
  distDir: process.env.KWEETO_DIST_DIR || ".next",
  ...(standalone && {
    output: "standalone",
    experimental: { proxyTimeout: 30 * 60 * 1000 }, // long uploads and exports go through the proxy
    async rewrites() {
      return [
        { source: "/api/:path*", destination: `${backend}/api/:path*` },
        { source: "/files/:path*", destination: `${backend}/files/:path*` },
      ];
    },
  }),
};

export default nextConfig;
