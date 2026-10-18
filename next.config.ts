import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  devIndicators: false,
  partialPrefetching: true,
  // The built network and the MTA records snapshot ship with the server functions, so an empty FalkorDB can be re-seeded.
  outputFileTracingIncludes: {
    "/api/**": ["./data/nyc/*.json", "./data/scenarios.json", "./data/replays/**", "./data/agency/*.json"],
  },
  serverExternalPackages: ["falkordb"],
  // Self-hosted font files never change under the same name.
  headers: () => [{ source: "/fonts/:file*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] }],
};

export default nextConfig;
