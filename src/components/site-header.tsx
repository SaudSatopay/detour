"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { PaletteItem } from "@/lib/palette";
import { CommandPalette } from "./command-palette";
import { ThemeSwitch } from "./theme-switch";

const NAV = [
  { href: "/control", label: "Control room", short: "Control" },
  { href: "/riders", label: "Riders", short: "Riders" },
  { href: "/memory", label: "Memory", short: "Memory" },
  { href: "/proof", label: "Proof", short: "Proof" },
] as const;

export function DetourMark({ className = "" }: { className?: string }) {
  // Two tracks; the lower one bends around a break. Our own mark, not a route bullet.
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <path d="M3 11 H29" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" fill="none" />
      <path d="M3 21 H10 L14 26 H18 L22 21 H29" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M12.5 17.5 L19.5 17.5" stroke="var(--crit)" strokeWidth="3.2" strokeLinecap="round" />
    </svg>
  );
}

export function SiteHeader({ palette }: { palette: PaletteItem[] }) {
  const pathname = usePathname();
  return (
    <header className="sign-band sign-rule sticky top-0 z-40">
      <div className="mx-auto flex h-12 max-w-[1440px] items-center gap-2 px-3 pt-1 min-[400px]:gap-3 min-[400px]:px-4 sm:gap-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-display text-xl font-bold tracking-wide" aria-label="Detour home">
          <DetourMark className="size-6" />
          <span className="hidden min-[400px]:inline">Detour</span>
        </Link>
        <nav aria-label="Primary" className="ml-auto flex items-center gap-0.5 sm:ml-6 sm:gap-1">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`label whitespace-nowrap rounded-sm px-1.5 py-1.5 transition-colors duration-150 min-[400px]:px-2 sm:px-2.5 ${
                  active ? "bg-sign-ink text-sign" : "text-sign-ink/80 hover:text-sign-ink"
                }`}
              >
                <span className="sm:hidden">{item.short}</span>
                <span className="hidden sm:inline">{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-1 sm:ml-auto sm:gap-4">
          <CommandPalette items={palette} />
          <a href="https://github.com/SaudSatopay/detour" className="label hidden text-sign-ink/80 transition-colors duration-150 hover:text-sign-ink sm:block">
            Source
          </a>
          <ThemeSwitch />
        </div>
      </div>
    </header>
  );
}
