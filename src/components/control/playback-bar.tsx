"use client";

import { useRef } from "react";
import type { StepMark } from "./run-state";

export const SPEEDS = [1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

interface Props {
  /** The finished steps, in call order. */
  steps: StepMark[];
  /** 1-based step on screen. */
  position: number;
  following: boolean;
  /** A run is still streaming. */
  running: boolean;
  playing: boolean;
  speed: Speed;
  onGo: (step: number) => void;
  onPlay: () => void;
  onSpeed: (speed: Speed) => void;
  onLatest: () => void;
}

const iconButton =
  "grid size-9 shrink-0 place-items-center rounded-md transition-colors duration-150 ease-out motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-40 @[40rem]:size-8";

/**
 * Moves through a run one tool step at a time. The scrubber is a strip map: one station dot per step,
 * the current one ringed in the agents' signal color. Keyboard, pointer drag and tick clicks all land on a step.
 */
export function PlaybackBar({ steps, position, following, running, playing, speed, onGo, onPlay, onSpeed, onLatest }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const total = steps.length;
  if (!total) return null;
  const at = Math.min(Math.max(position, 1), total);
  const current = steps[at - 1];
  const text = `Step ${at} of ${total}: ${current.title}`;
  const pct = (i: number) => (total === 1 ? 0 : (i / (total - 1)) * 100);
  const go = (k: number) => {
    const next = Math.min(Math.max(k, 1), total);
    if (next !== at) onGo(next);
  };
  const pick = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r?.width) return;
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    go(Math.round(f * (total - 1)) + 1);
  };

  return (
    <div className="@container border-t border-line bg-panel px-3 py-2">
      <div role="group" aria-label="Run playback" className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 @[40rem]:flex">
        <div className="flex items-center gap-1 @[40rem]:order-1">
          <button type="button" aria-label="Previous step" disabled={at <= 1} onClick={() => go(at - 1)} className={`${iconButton} text-ink-700 enabled:hover:bg-sunk enabled:hover:text-ink-900`}>
            <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
              <path d="M4 3v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <path d="M12.5 3.5v9L6 8z" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            aria-label={playing ? "Pause" : "Play"}
            disabled={total < 2}
            onClick={onPlay}
            className={`${iconButton} bg-ink-900 text-paper enabled:hover:bg-ink-700`}
          >
            {playing ? (
              <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
                <path d="M5 3.5v9M11 3.5v9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
                <path d="M5 3v10l8.5-5z" fill="currentColor" />
              </svg>
            )}
          </button>
          <button type="button" aria-label="Next step" disabled={at >= total} onClick={() => go(at + 1)} className={`${iconButton} text-ink-700 enabled:hover:bg-sunk enabled:hover:text-ink-900`}>
            <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
              <path d="M12 3v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <path d="M3.5 3.5v9L10 8z" fill="currentColor" />
            </svg>
          </button>
        </div>

        <p className="flex min-w-0 flex-col leading-tight @[40rem]:order-3 @[40rem]:w-40 @[40rem]:shrink-0">
          <span className="label tabular text-ink-500">
            Step {at} of {total}
          </span>
          <span className="truncate font-display text-base font-semibold text-ink-900" title={current.title}>
            {current.title}
          </span>
        </p>

        <div role="group" aria-label="Playback speed" className="flex items-center rounded-md border border-line p-0.5 @[40rem]:order-4">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={speed === s}
              aria-label={`${s}x speed`}
              onClick={() => onSpeed(s)}
              className={`label tabular rounded-sm px-1.5 py-0.5 transition-colors duration-150 ease-out motion-reduce:transition-none ${
                speed === s ? "bg-ink-900 text-paper" : "text-ink-500 hover:text-ink-900"
              }`}
            >
              {s}x
            </button>
          ))}
        </div>

        <div className="col-span-3 flex min-w-0 items-center gap-2 @[40rem]:order-2 @[40rem]:flex-1">
          <div
            role="slider"
            tabIndex={0}
            aria-label="Run step"
            aria-valuemin={1}
            aria-valuemax={total}
            aria-valuenow={at}
            aria-valuetext={text}
            className="relative h-8 min-w-0 flex-1 cursor-pointer touch-none rounded-md px-2"
            onKeyDown={(e) => {
              const next =
                e.key === "ArrowLeft" || e.key === "ArrowDown"
                  ? at - 1
                  : e.key === "ArrowRight" || e.key === "ArrowUp"
                    ? at + 1
                    : e.key === "Home"
                      ? 1
                      : e.key === "End"
                        ? total
                        : null;
              if (next === null) return;
              e.preventDefault();
              go(next);
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              e.currentTarget.focus();
              pick(e.clientX);
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) pick(e.clientX);
            }}
          >
            <div ref={track} className="relative h-full">
              <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-line-strong" />
              <span
                aria-hidden="true"
                className="absolute inset-x-0 top-1/2 h-0.5 origin-left -translate-y-1/2 rounded-full bg-signal transition-transform duration-150 ease-out motion-reduce:transition-none"
                style={{ transform: `scaleX(${pct(at - 1) / 100})` }}
              />
              {steps.map((s, i) => {
                const n = i + 1;
                const tone =
                  n === at ? "size-3.5 border-2 border-signal bg-panel shadow-lift" : n < at ? "size-2 bg-signal" : "size-2 border border-line-strong bg-panel";
                return (
                  <span
                    key={`${s.agent}:${s.id}`}
                    aria-hidden="true"
                    title={`${n}. ${s.title}`}
                    className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-150 ease-out motion-reduce:transition-none ${tone}`}
                    style={{ left: `${pct(i)}%` }}
                  />
                );
              })}
            </div>
          </div>
          {running ? <span aria-hidden="true" title="A step is running" className="size-2 shrink-0 animate-pulse rounded-full bg-signal motion-reduce:animate-none" /> : null}
          {!following ? (
            <button
              type="button"
              onClick={onLatest}
              className="label shrink-0 rounded-sm border border-line-strong px-2 py-1 text-ink-900 transition-colors duration-150 ease-out hover:bg-sunk motion-reduce:transition-none"
            >
              Back to latest
            </button>
          ) : null}
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {following ? "" : text}
      </p>
    </div>
  );
}
