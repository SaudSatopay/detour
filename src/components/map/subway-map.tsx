"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapModel, MapStation } from "@/lib/network/map";
import type { CutHighlight, FlowHighlight } from "@/lib/graph/tools/types";

export interface Overloaded {
  kind: "RUNS" | "BUS";
  id: number;
  pct: number;
}

export interface MapOverlay {
  closedEids?: number[];
  flows?: FlowHighlight[];
  overloaded?: Overloaded[];
  cut?: CutHighlight[];
  shuttles?: { from: string; to: string; busesPerHour: number; capacity: number }[];
  path?: string[];
  pathEids?: number[];
  /** Station id -> hops from the closure. */
  depth?: Record<string, number>;
  stations?: string[];
}

/** A screen-pixel rectangle pinned to a corner of the map (an overlay such as a card or legend) where labels are not drawn. */
export interface LabelExclusion {
  anchor: "tl" | "tr" | "bl" | "br";
  w: number;
  h: number;
  /** Only when the viewport (not the map) is at least / at most this wide: overlays move at CSS breakpoints. */
  minWidth?: number;
  maxWidth?: number;
}

const NO_EXCLUSIONS: LabelExclusion[] = [];

interface Props {
  model: MapModel;
  overlay?: MapOverlay;
  focus?: string[];
  selected?: string | null;
  onSelect?: (id: string) => void;
  label: string;
  className?: string;
  showLabels?: "major" | "none";
  interactive?: boolean;
  exclude?: LabelExclusion[];
}

type View = { k: number; x: number; y: number };

/** The view that fits the given stations (the incident), or the whole network. */
function computeFit(model: MapModel, ids?: string[]): View {
  const pts: MapStation[] = [];
  if (ids?.length) {
    for (const id of ids) {
      const s = model.stations.get(id);
      if (s) pts.push(s);
    }
  }
  // No focus: the whole network, Staten Island included, so no line is cut at the pane edge.
  if (!pts.length) for (const s of model.stations.values()) pts.push(s);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const pad = ids?.length ? 60 : 12;
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad;
  const maxY = Math.max(...ys) + pad;
  const k = Math.min(8, Math.max(1, Math.min(model.width / (maxX - minX), model.height / (maxY - minY))));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { k, x: model.width / 2 - cx * k, y: model.height / 2 - cy * k };
}

type Line = { key: string; route: string; x1: number; y1: number; x2: number; y2: number };

/*
 * The heavy layers are memoized: a new trace step changes the overlay (flows, cut, shuttles), not
 * the network, so about 1,500 base lines and 445 stations are not re-rendered on every step.
 */
const BaseLines = memo(function BaseLines({ lines, model, width, faded }: { lines: Line[]; model: MapModel; width: number; faded: boolean }) {
  return (
    <g opacity={faded ? 0.32 : 0.9} style={{ transition: "opacity 280ms var(--ease-out)" }}>
      {lines.map((l) => (
        <line key={l.key} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke={`#${model.routes.get(l.route)?.color ?? "808183"}`} strokeWidth={width} strokeLinecap="round" />
      ))}
    </g>
  );
});

const Stations = memo(function Stations({
  model,
  depth,
  emphasized,
  unit,
  onSelect,
}: {
  model: MapModel;
  depth: Record<string, number> | undefined;
  emphasized: Set<string>;
  unit: number;
  onSelect?: (id: string) => void;
}) {
  const sw = (px: number) => px * unit;
  return (
    <g>
      {[...model.stations.values()].map((s) => {
        const hop = depth?.[s.id];
        const em = emphasized.has(s.id);
        const r = sw(em ? 4.2 : s.routes.length > 2 ? 2.6 : 1.9);
        return (
          <circle
            key={s.id}
            cx={s.x}
            cy={s.y}
            r={hop !== undefined ? sw(2.4 + Math.max(0, 4 - hop) * 0.7) : r}
            fill={hop !== undefined ? "var(--crit)" : em ? "var(--signal)" : "var(--map-station)"}
            fillOpacity={hop !== undefined ? Math.max(0.3, 1 - hop * 0.11) : 1}
            stroke={em ? "var(--ink-900)" : "var(--ink-700)"}
            strokeWidth={sw(em ? 1.4 : 0.8)}
            onClick={onSelect ? () => onSelect(s.id) : undefined}
            className={onSelect ? "cursor-pointer" : undefined}
          >
            <title>{`${s.label}${s.ada === 1 ? " · step-free" : ""}`}</title>
          </circle>
        );
      })}
    </g>
  );
});

const Labels = memo(function Labels({ labels, emphasized, unit }: { labels: { s: MapStation; size: number }[]; emphasized: Set<string>; unit: number }) {
  const sw = (px: number) => px * unit;
  return (
    <g style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>
      {labels.map(({ s, size }) => (
        <text
          key={`t${s.id}`}
          x={s.x + sw(5)}
          y={s.y - sw(4)}
          fontSize={sw(size)}
          fill={emphasized.has(s.id) ? "var(--ink-900)" : "var(--ink-700)"}
          stroke="var(--paper)"
          strokeWidth={sw(3)}
          paintOrder="stroke"
          pointerEvents="none"
        >
          {s.name}
        </text>
      ))}
    </g>
  );
});

const SPACING = 2.4;

const ZOOM_CONTROLS: LabelExclusion = { anchor: "br", w: 56, h: 136 };

export function SubwayMap({ model, overlay = {}, focus, selected, onSelect, label, className = "", showLabels = "major", interactive = true, exclude = NO_EXCLUSIONS }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View>(() => computeFit(model, focus));
  const [hidden, setHidden] = useState(false);
  const [scalePx, setScalePx] = useState(2);
  const [box, setBox] = useState({ w: 0, h: 0, vw: 0 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; id: number } | null>(null);
  const hasOverlay = Boolean(overlay.closedEids?.length || overlay.flows?.length || overlay.path?.length || overlay.depth);

  const unit = scalePx / view.k;
  // Corridor geometry: a perpendicular offset per route so shared track shows every line side by side.
  const geometry = useMemo(() => {
    const lines: { key: string; route: string; x1: number; y1: number; x2: number; y2: number }[] = [];
    const offsetOf = new Map<string, { nx: number; ny: number; o: number }>();
    for (const c of model.corridors) {
      const a = model.stations.get(c.a);
      const b = model.stations.get(c.b);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      c.routes.forEach((route, i) => {
        const o = (i - (c.routes.length - 1) / 2) * SPACING * unit;
        offsetOf.set(`${c.key}|${route}`, { nx, ny, o });
        lines.push({ key: `${c.key}|${route}`, route, x1: a.x + nx * o, y1: a.y + ny * o, x2: b.x + nx * o, y2: b.y + ny * o });
      });
    }
    return { lines, offsetOf };
  }, [model, unit]);

  const segmentLine = useCallback(
    (eid: number) => {
      const s = model.segments.get(eid);
      if (!s) return null;
      const a = model.stations.get(s.from);
      const b = model.stations.get(s.to);
      if (!a || !b) return null;
      const key = s.from < s.to ? `${s.from}~${s.to}` : `${s.to}~${s.from}`;
      const off = geometry.offsetOf.get(`${key}|${s.route}`);
      const o = off ? off.o : 0;
      const nx = off?.nx ?? 0;
      const ny = off?.ny ?? 0;
      return { x1: a.x + nx * o, y1: a.y + ny * o, x2: b.x + nx * o, y2: b.y + ny * o, route: s.route };
    },
    [model, geometry],
  );

  const stationLine = useCallback(
    (from: string, to: string) => {
      const a = model.stations.get(from);
      const b = model.stations.get(to);
      if (!a || !b) return null;
      return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    },
    [model],
  );

  const focusKey = focus?.join(",") ?? "";
  const fitTo = useCallback((ids?: string[]) => setView(computeFit(model, ids)), [model]);
  // Refit when the focus changes (derived during render, not in an effect).
  const [fitKey, setFitKey] = useState(focusKey);
  if (fitKey !== focusKey) {
    setFitKey(focusKey);
    setView(computeFit(model, focusKey ? focusKey.split(",") : undefined));
  }

  // Viewbox units per screen pixel, so strokes, labels and offsets stay a constant size on screen.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width && height) {
        setScalePx(Math.max(model.width / width, model.height / height));
        setBox({ w: width, h: height, vw: window.innerWidth });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [model]);

  // Pause the flow animation when the map is off-screen or the tab is hidden.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setHidden(!entry.isIntersecting));
    io.observe(el);
    const onVis = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const toLocal = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const scale = Math.max(model.width / rect.width, model.height / rect.height);
    const offX = (rect.width * scale - model.width) / 2;
    const offY = (rect.height * scale - model.height) / 2;
    return { x: (clientX - rect.left) * scale - offX, y: (clientY - rect.top) * scale - offY, scale };
  };

  const zoomAt = (factor: number, px: number, py: number) =>
    setView((v) => {
      const k = Math.min(10, Math.max(0.8, v.k * factor));
      const f = k / v.k;
      return { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f };
    });

  const onWheel = (e: React.WheelEvent) => {
    if (!interactive) return;
    const p = toLocal(e.clientX, e.clientY);
    zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, p.x, p.y);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!interactive || e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, id: e.pointerId };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const { scale } = toLocal(e.clientX, e.clientY);
    setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x) * scale, y: d.vy + (e.clientY - d.y) * scale }));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const k = view.k;
  /** Screen pixels to viewbox units at the current zoom. */
  const sw = (px: number) => px * unit;
  const closed = useMemo(() => new Set(overlay.closedEids ?? []), [overlay.closedEids]);
  const overloaded = useMemo(() => new Map((overlay.overloaded ?? []).filter((o) => o.kind === "RUNS").map((o) => [o.id, o.pct])), [overlay.overloaded]);
  const emphasized = useMemo(() => new Set([...(overlay.stations ?? []), ...(overlay.path ?? []), ...(selected ? [selected] : [])]), [overlay.stations, overlay.path, selected]);
  const maxFlow = Math.max(1, ...(overlay.flows ?? []).map((f) => f.flow));

  const majorLabels = useMemo(() => {
    const ranked = [...model.stations.values()].sort((a, b) => b.entries - a.entries).slice(0, k > 2.5 ? 90 : k > 1.5 ? 45 : 22);
    return new Set(ranked.map((s) => s.id));
  }, [model, k]);

  // Labels placed greedily in priority order (the step's evidence first, then by ridership); a label whose
  // box would overlap one already placed is skipped, so names never print over each other.
  const labels = useMemo(() => {
    const candidates = [...model.stations.values()]
      .filter((s) => majorLabels.has(s.id) || emphasized.has(s.id))
      .sort((a, b) => Number(emphasized.has(b.id)) - Number(emphasized.has(a.id)) || b.entries - a.entries);
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const out: { s: MapStation; size: number }[] = [];
    const pad = 2 * unit;
    // Screen pixels to model coordinates (the SVG letterboxes the view box into the element).
    const offX = (box.w * scalePx - model.width) / 2;
    const offY = (box.h * scalePx - model.height) / 2;
    const toModel = (sx: number, sy: number) => ({ x: (sx * scalePx - offX - view.x) / view.k, y: (sy * scalePx - offY - view.y) / view.k });
    const seen0 = toModel(0, 0);
    const seen1 = toModel(box.w, box.h);
    const active = [...exclude, ...(interactive ? [ZOOM_CONTROLS] : [])].filter((e) => box.vw >= (e.minWidth ?? 0) && box.vw <= (e.maxWidth ?? Infinity));
    const blocked = (box.w ? active : []).map((e) => {
      const x0 = e.anchor.endsWith("l") ? 0 : box.w - e.w;
      const y0 = e.anchor.startsWith("t") ? 0 : box.h - e.h;
      const a = toModel(x0, y0);
      const b = toModel(x0 + e.w, y0 + e.h);
      return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
    });
    for (const s of candidates) {
      const size = emphasized.has(s.id) ? 13 : 11;
      const x0 = s.x + 5 * unit;
      const base = s.y - 4 * unit;
      // Barlow Condensed runs about half an em per character.
      const rect = { x0, x1: x0 + s.name.length * size * 0.5 * unit, y0: base - 0.8 * size * unit, y1: base + 0.25 * size * unit };
      const hits = (p: { x0: number; y0: number; x1: number; y1: number }) => rect.x0 - pad < p.x1 && rect.x1 + pad > p.x0 && rect.y0 - pad < p.y1 && rect.y1 + pad > p.y0;
      // Not clipped at the pane edge, not under an overlay, not over another label.
      if (box.w && (rect.x0 < seen0.x || rect.x1 > seen1.x || rect.y0 < seen0.y || rect.y1 > seen1.y)) continue;
      if (blocked.some(hits) || placed.some(hits)) continue;
      placed.push(rect);
      out.push({ s, size });
    }
    return out;
  }, [model, majorLabels, emphasized, unit, scalePx, box, view, exclude, interactive]);

  return (
    <div className={`relative ${className}`}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${model.width} ${model.height}`}
        role="img"
        aria-label={label}
        className={`block h-full w-full touch-none select-none ${interactive ? "cursor-grab active:cursor-grabbing" : ""} ${hidden ? "paused" : ""}`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          <pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="4" height="4" fill="var(--crit-wash)" />
            <line x1="0" y1="0" x2="0" y2="4" stroke="var(--crit)" strokeWidth="2" />
          </pattern>
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${k})`}>
          {/* Base network: every route in its GTFS color, side by side on shared track. */}
          <BaseLines lines={geometry.lines} model={model} width={sw(2.2)} faded={hasOverlay} />

          {/* Closed segments. */}
          {[...closed].map((eid) => {
            const l = segmentLine(eid);
            if (!l) return null;
            return (
              <g key={`c${eid}`} className="fade-in">
                <line {...l} stroke="var(--crit)" strokeWidth={sw(4.6)} strokeLinecap="round" opacity={0.25} />
                <line {...l} stroke="var(--crit)" strokeWidth={sw(1.8)} strokeDasharray={`${sw(2.2)} ${sw(1.6)}`} />
              </g>
            );
          })}

          {/* Displaced riders' flow: thickness by riders per hour, dashes move in travel direction. */}
          {(overlay.flows ?? []).map((f) => {
            const l = f.kind === "RUNS" ? segmentLine(f.id) : stationLine(f.from, f.to);
            if (!l) return null;
            const pct = f.kind === "RUNS" ? overloaded.get(f.id) : undefined;
            const width = sw(1.4 + 6.5 * Math.sqrt(f.flow / maxFlow));
            const speed = `${Math.max(0.6, 2.2 - 1.6 * (f.flow / maxFlow))}s`;
            return (
              <g key={`f${f.kind}${f.id}${f.from}`}>
                {pct ? <line {...l} stroke="var(--crit)" strokeWidth={width + sw(3)} strokeLinecap="round" opacity={0.35} /> : null}
                <line
                  {...l}
                  className="flow"
                  stroke={pct ? "var(--crit)" : "var(--signal)"}
                  strokeWidth={width}
                  style={{ ["--flow-speed" as string]: speed, strokeDasharray: f.kind === "WALK" ? `${sw(1)} ${sw(3)}` : undefined }}
                />
              </g>
            );
          })}

          {/* Min cut: the binding segments. */}
          {(overlay.cut ?? []).map((c) => {
            const l = c.kind === "RUNS" ? segmentLine(c.id) : stationLine(c.from, c.to);
            if (!l) return null;
            return <line key={`x${c.kind}${c.id}${c.from}`} {...l} stroke="url(#hatch)" strokeWidth={sw(6)} strokeLinecap="round" />;
          })}

          {/* Shuttle-bus bridges draw themselves in. */}
          {(overlay.shuttles ?? []).map((s) => {
            const a = model.stations.get(s.from);
            const b = model.stations.get(s.to);
            if (!a || !b) return null;
            const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.18;
            const my = (a.y + b.y) / 2 - (b.x - a.x) * 0.18;
            const d = `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`;
            const len = Math.hypot(b.x - a.x, b.y - a.y) * 1.2;
            return (
              <g key={`s${s.from}${s.to}`}>
                <path d={d} fill="none" stroke="var(--signal)" strokeWidth={sw(3.2)} strokeLinecap="round" className="draw-in" style={{ ["--len" as string]: len }} opacity={0.3} />
                <path d={d} fill="none" stroke="var(--signal-strong)" strokeWidth={sw(1.6)} strokeDasharray={`${sw(3)} ${sw(2)}`} strokeLinecap="round" />
              </g>
            );
          })}

          {/* A rider's route. */}
          {overlay.path && overlay.path.length > 1 ? (
            <polyline
              points={overlay.path
                .map((id) => model.stations.get(id))
                .filter(Boolean)
                .map((s) => `${s!.x},${s!.y}`)
                .join(" ")}
              fill="none"
              stroke="var(--ink-900)"
              strokeWidth={sw(3.4)}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : null}

          {/* Stations. */}
          <Stations model={model} depth={overlay.depth} emphasized={emphasized} unit={unit} onSelect={onSelect} />

          {/* Labels: busiest stations at this zoom, plus anything emphasized. */}
          {showLabels === "major" ? <Labels labels={labels} emphasized={emphasized} unit={unit} /> : null}
        </g>
      </svg>

      {interactive ? (
        <div className="absolute bottom-3 right-3 flex flex-col overflow-hidden rounded-md border border-line bg-panel shadow-lift">
          <button type="button" aria-label="Zoom in" className="grid size-9 place-items-center text-ink-700 transition-colors duration-150 hover:bg-sunk hover:text-ink-900" onClick={() => zoomAt(1.4, model.width / 2, model.height / 2)}>
            <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
          <button type="button" aria-label="Zoom out" className="grid size-9 place-items-center border-t border-line text-ink-700 transition-colors duration-150 hover:bg-sunk hover:text-ink-900" onClick={() => zoomAt(1 / 1.4, model.width / 2, model.height / 2)}>
            <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true"><path d="M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
          <button type="button" aria-label="Fit the map to the incident" className="grid size-9 place-items-center border-t border-line text-ink-700 transition-colors duration-150 hover:bg-sunk hover:text-ink-900" onClick={() => fitTo(focus)}>
            <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      ) : null}
    </div>
  );
}
