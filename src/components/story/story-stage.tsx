"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SubwayMap } from "@/components/map/subway-map";
import { useMapModel } from "@/components/map/use-map-model";
import { CHAPTERS, CHAPTER_LABELS, mapLabelFor, overlayFor, storyFocus, type Chapter, type Story } from "./story";

let storyRequest: Promise<Story> | null = null;

function loadStory(): Promise<Story> {
  storyRequest ??= fetch("/map/story-l-canarsie.json")
    .then((r) => {
      if (!r.ok) throw new Error(`Story data failed to load (${r.status})`);
      return r.json() as Promise<Story>;
    })
    .catch((error) => {
      storyRequest = null;
      throw error;
    });
  return storyRequest;
}

/**
 * The night stage: one sticky map behind the story, and the chapters (server-rendered children) scrolling
 * over it. Whichever chapter crosses the middle of the viewport decides what the map draws.
 */
export function StoryStage({ children }: { children: React.ReactNode }) {
  const root = useRef<HTMLElement>(null);
  const { model } = useMapModel();
  const [story, setStory] = useState<Story | null>(null);
  const [chapter, setChapter] = useState<Chapter>("hero");
  const [intro, setIntro] = useState<0 | 1 | 2>(0);

  useEffect(() => {
    let live = true;
    loadStory().then(
      (s) => live && setStory(s),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) setChapter((entry.target as HTMLElement).dataset.chapter as Chapter);
      },
      { rootMargin: "-50% 0px -50% 0px" },
    );
    el.querySelectorAll<HTMLElement>("[data-chapter]").forEach((c) => io.observe(c));
    return () => io.disconnect();
  }, []);

  // The opening plays once: the network, then the closure, then the displaced riders' flow.
  useEffect(() => {
    if (!story || !model) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timers = reduce ? [setTimeout(() => setIntro(2), 0)] : [setTimeout(() => setIntro(1), 300), setTimeout(() => setIntro(2), 900)];
    return () => timers.forEach(clearTimeout);
  }, [story, model]);

  const overlay = useMemo(() => (story ? overlayFor(story, chapter, intro) : {}), [story, chapter, intro]);
  const focus = useMemo(() => (story ? storyFocus(story) : undefined), [story]);
  const at = CHAPTERS.indexOf(chapter);

  return (
    <section ref={root} className="night relative overflow-x-clip" aria-labelledby="story-title">
      {/* The stage: the map holds still while the chapters scroll over it. */}
      <div className="sticky top-12 h-[calc(100svh-3rem)] overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-[60%] [mask-image:linear-gradient(to_bottom,black_72%,transparent)] lg:inset-y-0 lg:left-[30%] lg:right-0 lg:h-full lg:[mask-image:linear-gradient(to_right,transparent,black_24%)]">
          {model && story ? (
            <SubwayMap model={model} overlay={overlay} focus={focus} interactive={false} showLabels="major" label={mapLabelFor(story, chapter)} className="h-full w-full" />
          ) : null}
        </div>

        {/* Phones: a thin progress bar, one segment per chapter. */}
        <div aria-hidden="true" className="absolute inset-x-4 top-3 flex gap-1 lg:hidden">
          {CHAPTERS.map((c, i) => (
            <span key={c} className={`h-1 flex-1 rounded-full transition-colors duration-200 ${i <= at ? "bg-signal" : "bg-line"}`} />
          ))}
        </div>

        {/* Desktop: the chapters as a strip map, the way a car's line diagram shows the stops ahead. */}
        <nav aria-label="Chapters" className="absolute right-6 top-1/2 z-10 hidden -translate-y-1/2 lg:block">
          <ol className="relative flex flex-col gap-5 pr-1">
            <span aria-hidden="true" className="absolute bottom-2 right-[7px] top-2 w-0.5 bg-line-strong" />
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

      {/* The chapters scroll over the stage; only their cards take the pointer, so the strip map stays clickable. */}
      <div className="pointer-events-none relative -mt-[calc(100svh-3rem)]">{children}</div>
    </section>
  );
}
