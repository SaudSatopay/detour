import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // The built network ships with the server functions so an empty FalkorDB can be re-seeded.
  outputFileTracingIncludes: {
    "/api/**": ["./data/nyc/*.json", "./data/scenarios.json", "./data/replays/**"],
  },
  serverExternalPackages: ["falkordb"],
};

export default nextConfig;
