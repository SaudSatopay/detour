"use client";

import { useSyncExternalStore } from "react";
import { THEME_KEY } from "@/lib/theme";

type Scheme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";
const systemScheme = (): Scheme => (window.matchMedia(DARK_QUERY).matches ? "dark" : "light");

function currentScheme(): Scheme {
  const set = document.documentElement.dataset.theme;
  return set === "light" || set === "dark" ? set : systemScheme();
}

// The scheme lives on <html>; the switch subscribes to it and to the system preference.
const listeners = new Set<() => void>();
function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener("change", onChange);
  return () => {
    listeners.delete(onChange);
    media.removeEventListener("change", onChange);
  };
}
const serverScheme = () => null;

/**
 * Flips between paper and night service. Picking the scheme the system already prefers goes back to
 * following the system, so the switch never strands someone on a stale choice.
 */
function apply(next: Scheme) {
  const root = document.documentElement;
  try {
    if (next === systemScheme()) {
      delete root.dataset.theme;
      localStorage.removeItem(THEME_KEY);
    } else {
      root.dataset.theme = next;
      localStorage.setItem(THEME_KEY, next);
    }
  } catch {
    root.dataset.theme = next;
  }
  listeners.forEach((l) => l());
}

export function ThemeSwitch() {
  const scheme = useSyncExternalStore(subscribe, currentScheme, serverScheme);

  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    const next: Scheme = currentScheme() === "dark" ? "light" : "dark";
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !("startViewTransition" in document)) return apply(next);
    // The new theme spreads from the switch as a circle.
    const box = e.currentTarget.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const transition = document.startViewTransition(() => apply(next));
    transition.ready
      .then(() =>
        document.documentElement.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
          { duration: 450, easing: "cubic-bezier(0.65, 0, 0.35, 1)", pseudoElement: "::view-transition-new(root)" },
        ),
      )
      .catch(() => undefined);
  };

  const dark = scheme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={scheme ? `Switch to the ${dark ? "light" : "dark"} theme` : "Switch theme"}
      title={dark ? "Light theme" : "Dark theme"}
      className="grid size-8 shrink-0 place-items-center rounded-sm text-sign-ink/80 transition-colors duration-150 hover:bg-sign-ink/10 hover:text-sign-ink"
    >
      <svg viewBox="0 0 20 20" className="size-[18px]" aria-hidden="true">
        {dark ? (
          // Paper: a sun of eight rays.
          <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" fill="none">
            <circle cx="10" cy="10" r="3.6" />
            <path d="M10 1.8v2.1M10 16.1v2.1M1.8 10h2.1M16.1 10h2.1M4.2 4.2l1.5 1.5M14.3 14.3l1.5 1.5M4.2 15.8l1.5-1.5M14.3 5.7l1.5-1.5" />
          </g>
        ) : (
          // Night service: a crescent.
          <path d="M15.6 12.6A6.6 6.6 0 0 1 7.4 4.4a6.6 6.6 0 1 0 8.2 8.2Z" fill="currentColor" />
        )}
      </svg>
    </button>
  );
}
