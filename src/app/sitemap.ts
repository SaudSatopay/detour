import type { MetadataRoute } from "next";

const site = process.env.NEXT_PUBLIC_SITE_URL ?? "https://detour-orpin.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/control", "/riders", "/memory", "/proof"].map((path) => ({ url: `${site}${path}`, changeFrequency: "weekly", priority: path ? 0.8 : 1 }));
}
