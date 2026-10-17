import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  devIndicators: false,
  partialPrefetching: true,
  // The built network ships with the server functions so an empty FalkorDB can be re-seeded.
  outputFileTracingIncludes: {
    "/api/**": ["./data/nyc/*.json", "./data/scenarios.json", "./data/replays/**"],
  },
  serverExternalPackages: ["falkordb"],
  // Self-hosted font files never change under the same name.
  headers: () => [{ source: "/fonts/:file*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] }],
};

export default nextConfig;
