"use client";

import { lazy, startTransition, Suspense, useEffect, useRef, useState } from "react";
import { useAfterLoad } from "../use-after-load";
import { CHAPTERS, CHAPTER_LABELS, type Chapter } from "./story";

// The map's code and data load once the stage arms (after load and idle), so they stay off the first paint.
const StoryMap = lazy(() => import("./story-map"));

/**
 * The night stage: one sticky map behind the story, and the chapters (server-rendered children) scrolling
 * over it. Whichever chapter crosses the middle of the viewport decides what the map draws.
 */
export function StoryStage({ children }: { children: React.ReactNode }) {
  const root = useRef<HTMLElement>(null);
  const [chapter, setChapter] = useState<Chapter>("hero");

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        // A chapter change redraws the map at a new frame; as a transition React does that in small, interruptible slices.
        for (const entry of entries) if (entry.isIntersecting) startTransition(() => setChapter((entry.target as HTMLElement).dataset.chapter as Chapter));
      },
      { rootMargin: "-50% 0px -50% 0px" },
    );
    el.querySelectorAll<HTMLElement>("[data-chapter]").forEach((c) => io.observe(c));
    return () => io.disconnect();
  }, []);

  // The map waits for the page to load and the browser to go idle: the headline paints first, then the map draws in.
  const armed = useAfterLoad();

  const at = CHAPTERS.indexOf(chapter);

  return (
    <section ref={root} className="night relative overflow-x-clip" aria-labelledby="story-title">
      {/* The stage: the map holds still while the chapters scroll over it. */}
      <div className="sticky top-12 h-[calc(100svh-3rem)] overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-[50%] [mask-image:linear-gradient(to_bottom,black_80%,transparent)] lg:inset-y-0 lg:left-[30%] lg:right-0 lg:h-full lg:[mask-image:linear-gradient(to_right,transparent,black_24%)]">
          {armed ? (
            <Suspense fallback={null}>
              <StoryMap chapter={chapter} />
            </Suspense>
          ) : null}
        </div>

        {/* Phones: a thin progress bar, one segment per chapter. */}
        <div aria-hidden="true" className="absolute inset-x-4 top-3 flex gap-1 lg:hidden">
          {CHAPTERS.map((c, i) => (
            <span key={c} className={`h-1 flex-1 rounded-full transition-colors duration-200 ${i <= at ? "bg-signal" : "bg-line"}`} />
          ))}
        </div>
      </div>

      {/* The chapters scroll over the stage; only their cards take the pointer. */}
      <div className="pointer-events-none relative -mt-[calc(100svh-3rem)]">{children}</div>

      {/*
        Desktop: the chapters as a strip map, the way a car's line diagram shows the stops ahead. It comes after
        the chapters in the page, so the keyboard meets the story's own links first, and sticks beside them.
      */}
      <div className="pointer-events-none absolute inset-0 hidden lg:block">
        <nav aria-label="Chapters" className="pointer-events-auto sticky top-[50svh] ml-auto mr-4 w-fit -translate-y-1/2 rounded-md bg-paper/85 px-3 py-3">
          <span aria-hidden="true" className="absolute bottom-[22px] right-[23px] top-[22px] w-0.5 bg-line-strong" />
          <ol className="relative flex flex-col gap-5 pr-1">
            {CHAPTERS.map((c, i) => (
              <li key={c}>
                <a
                  href={`#ch-${c}`}
                  aria-current={c === chapter ? "step" : undefined}
                  className={`group relative flex items-center justify-end gap-3 rounded-sm transition-colors duration-150 ${c === chapter ? "text-ink-900" : "text-ink-500 hover:text-ink-900"}`}
                >
                  <span className="label">{CHAPTER_LABELS[c]}</span>
                  <span
                    aria-hidden="true"
                    className={`size-4 shrink-0 rounded-full border-[3px] transition-colors duration-200 ${
                      i < at ? "border-signal bg-signal" : c === chapter ? "border-signal bg-paper" : "border-line-strong bg-paper"
                    }`}
                  />
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </div>
    </section>
  );
}
