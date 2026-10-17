import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible_Mono, Barlow_Condensed } from "next/font/google";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { paletteItems } from "@/lib/palette";
import { THEME_BOOT } from "@/lib/theme";
import "./globals.css";

const display = Barlow_Condensed({
  variable: "--font-barlow-condensed",
  subsets: ["latin"],
  weight: ["600", "700"],
  display: "swap",
});

const mono = Atkinson_Hyperlegible_Mono({
  variable: "--font-atkinson-mono",
  subsets: ["latin"],
  display: "swap",
  // Numbers and Cypher only, never the largest paint: load it without a preload.
  preload: false,
  adjustFontFallback: false,
  fallback: ["ui-monospace", "Consolas", "monospace"],
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://detour-orpin.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Detour: when a subway line breaks, measure what the city can still carry",
    template: "%s · Detour",
  },
  description:
    "Agents on a FalkorDB graph of the New York City subway, built from MTA open data. They find who a closure strands, measure what the rest of the network can absorb with max flow, test shuttle bridges on forked graphs, and route every remembered rider around the break.",
  applicationName: "Detour",
  openGraph: {
    type: "website",
    siteName: "Detour",
    title: "Detour: subway disruption agents on a FalkorDB graph",
    description: "Max flow, min cut and forked graphs on the real NYC subway. Built for Graph Hacks.",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Detour: with the L closed, displaced riders' fastest paths overload the G at 244%, and max flow says 93% can still move.",
      },
    ],
  },
  twitter: { card: "summary_large_image", images: ["/og.png"] },
};

export const viewport: Viewport = {
  // The browser bar matches the station-sign header: --sign in light (oklch 0.17 0.008 260) and dark (oklch 0.13 0.008 260).
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#0d1013" },
    { media: "(prefers-color-scheme: dark)", color: "#06070a" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The boot script may set data-theme before React hydrates, so the attribute is allowed to differ.
    <html lang="en" className={`${display.variable} ${mono.variable} h-full`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        {/* The body face's regular weight (globals.css); the bold loads only where a page sets bold body text. */}
        <link rel="preload" href="/fonts/atkinson-hyperlegible-next-400.woff2" as="font" type="font/woff2" crossOrigin="" />
      </head>
      <body className="flex min-h-full flex-col">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:bg-panel focus:px-3 focus:py-2">
          Skip to content
        </a>
        <SiteHeader palette={paletteItems()} />
        <main id="main" className="flex flex-1 flex-col">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
