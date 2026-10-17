"use client";

import { useEffect, useMemo, useState } from "react";
import { SubwayMap, type LabelExclusion } from "@/components/map/subway-map";
import { useMapModel } from "@/components/map/use-map-model";
import { focusFor, mapLabelFor, overlayFor, type Chapter, type Story } from "./story";

// Desktop: no station names under the headline (the opening), under a chapter card (the rest) or under the chapter
// rail. Phones keep the map above the words, so nothing is excluded there.
const UNDER_RAIL: LabelExclusion = { anchor: "r", w: 210, h: 340, minWidth: 1024 };
const CLEAR_OF_HEADLINE: LabelExclusion[] = [{ anchor: "tl", w: 430, h: 4000, minWidth: 1024 }, UNDER_RAIL];
const CLEAR_OF_CARD: LabelExclusion[] = [{ anchor: "tl", w: 230, h: 4000, minWidth: 1024 }, UNDER_RAIL];

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

/** The sticky map: loads the network and the story, plays the opening, then draws whatever the chapter asks for. */
export default function StoryMap({ chapter }: { chapter: Chapter }) {
  const { model } = useMapModel();
  const [story, setStory] = useState<Story | null>(null);
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

  // The opening plays once: the network, then the closure, then the displaced riders' flow.
  useEffect(() => {
    if (!story || !model) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timers = reduce ? [setTimeout(() => setIntro(2), 0)] : [setTimeout(() => setIntro(1), 300), setTimeout(() => setIntro(2), 900)];
    return () => timers.forEach(clearTimeout);
  }, [story, model]);

  const overlay = useMemo(() => (story ? overlayFor(story, chapter, intro) : {}), [story, chapter, intro]);
  const focus = useMemo(() => (story ? focusFor(story, chapter) : undefined), [story, chapter]);
  if (!model || !story) return null;
  return (
    <div className="fade-in relative h-full w-full">
      <SubwayMap
        model={model}
        overlay={overlay}
        focus={focus}
        exclude={chapter === "hero" ? CLEAR_OF_HEADLINE : CLEAR_OF_CARD}
        interactive={false}
        showLabels="major"
        label={mapLabelFor(story, chapter)}
        className="h-full w-full"
      />
      {/* Each chapter frames its own evidence; a short dip to night makes the cut to the new frame read as a cut. */}
      <div key={chapter} aria-hidden="true" className="dip pointer-events-none absolute inset-0 bg-paper" />
    </div>
  );
}
