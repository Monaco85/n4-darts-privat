import type { DartView, Segment } from "@n4/engine";
import { type PointerEvent, type ReactElement, useState } from "react";
import { dartLabel } from "./darts.ts";

/** Clockwise from the top, as on the board. */
const ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];

/** Regulation radii in mm; the board's coordinates put the outside of the double ring at 0.99. */
const R = {
  bull: 6.35,
  outerBull: 15.9,
  trebleInner: 99,
  trebleOuter: 107,
  doubleInner: 162,
  doubleOuter: 170,
  numbers: 196,
  frame: 222,
};
const MM_PER_UNIT = 170 / 0.99;

/** A point on the board, `deg` clockwise from the top, `r` mm from the bull (SVG y points down). */
function point(deg: number, r: number) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [r * Math.cos(a), r * Math.sin(a)] as const;
}

function wedge(from: number, to: number, r1: number, r2: number) {
  const [ax, ay] = point(from, r2);
  const [bx, by] = point(to, r2);
  const [cx, cy] = point(to, r1);
  const [dx, dy] = point(from, r1);
  const f = (n: number) => n.toFixed(2);
  return `M${f(ax)} ${f(ay)}A${r2} ${r2} 0 0 1 ${f(bx)} ${f(by)}L${f(cx)} ${f(cy)}A${r1} ${r1} 0 0 0 ${f(dx)} ${f(dy)}Z`;
}

/** The static board, drawn once. */
const BOARD = (() => {
  const parts: ReactElement[] = [];
  ORDER.forEach((n, i) => {
    const from = i * 18 - 9;
    const to = from + 18;
    const dark = i % 2 === 0;
    const bed = dark ? "db-bed-dark" : "db-bed-light";
    const ring = dark ? "db-ring-red" : "db-ring-green";
    parts.push(
      <path key={`si${n}`} className={bed} d={wedge(from, to, R.outerBull, R.trebleInner)} />,
      <path key={`t${n}`} className={ring} d={wedge(from, to, R.trebleInner, R.trebleOuter)} />,
      <path key={`so${n}`} className={bed} d={wedge(from, to, R.trebleOuter, R.doubleInner)} />,
      <path key={`d${n}`} className={ring} d={wedge(from, to, R.doubleInner, R.doubleOuter)} />,
    );
    const [x, y] = point(i * 18, R.numbers);
    parts.push(
      <text key={`n${n}`} className="db-number" x={x} y={y} dominantBaseline="central">
        {n}
      </text>,
    );
  });
  return parts;
})();

interface Props {
  darts: DartView[];
  coords: Record<string, { x: number; y: number }>;
  /** Numbers to light up (25 = bull): the next target, or the numbers still open. */
  highlight?: number[];
  /** Tapping a dart on the board, e.g. to correct it. */
  onDart?: (dart: DartView) => void;
}

/** The dartboard with this visit's darts where the board saw them, numbered in throwing order. */
export function Dartboard({ darts, coords, highlight = [], onDart }: Props) {
  const placed = darts.flatMap((dart, i) => {
    const at = coords[dart.dartId];
    return at ? [{ dart, i, x: at.x * MM_PER_UNIT, y: -at.y * MM_PER_UNIT }] : [];
  });
  const latest = placed.at(-1)?.dart.dartId;

  return (
    <svg
      className="dartboard"
      viewBox={`${-R.frame} ${-R.frame} ${R.frame * 2} ${R.frame * 2}`}
      role="img"
      aria-label={
        placed.length
          ? `Dartboard: ${placed.map((p) => dartLabel(p.dart.segment)).join(", ")}`
          : "Dartboard"
      }
    >
      <circle className="db-frame" r={R.frame} />
      {BOARD}
      <circle className="db-ring-green" r={R.outerBull} />
      <circle className="db-ring-red" r={R.bull} />
      <circle className="db-wire" r={R.doubleOuter} />
      {highlight.map((n) => {
        if (n === 25) return <circle key="hb" className="db-target" r={R.outerBull} />;
        const i = ORDER.indexOf(n);
        if (i < 0) return null;
        const from = i * 18 - 9;
        const [x, y] = point(i * 18, R.numbers);
        return (
          <g key={`h${n}`}>
            <path className="db-target" d={wedge(from, from + 18, R.outerBull, R.doubleOuter)} />
            <circle className="db-target-number" cx={x} cy={y} r={17} />
            <text className="db-number db-number-target" x={x} y={y} dominantBaseline="central">
              {n}
            </text>
          </g>
        );
      })}
      {placed.map(({ dart, i, x, y }) => (
        <g
          key={dart.dartId}
          className={`db-dart ${dart.dartId === latest ? "latest" : ""} ${dart.ignored ? "ignored" : ""}`}
          transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}
          {...(onDart && {
            role: "button",
            tabIndex: 0,
            "aria-label": `Dart ${i + 1} on the board: ${dartLabel(dart.segment)}, tap to correct`,
            onClick: () => onDart(dart),
            onKeyDown: (e: { key: string }) => {
              if (e.key === "Enter" || e.key === " ") onDart(dart);
            },
            style: { cursor: "pointer" },
          })}
        >
          {/* A bigger, invisible target than the dot, for fingers. */}
          {onDart && <circle className="db-dart-hit" r={28} />}
          <circle className="db-dart-halo" r={15} />
          <circle className="db-dart-dot" r={9} />
          <text className="db-dart-index" dominantBaseline="central">
            {i + 1}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** Where a point on the board lands, in mm from the bull (y down, as in the SVG). */
export function segmentAt(
  x: number,
  y: number,
): { segment: Segment; band: [number, number]; index: number } {
  const r = Math.hypot(x, y);
  // Clockwise from the top, like ORDER; each wedge spans ±9° around its number.
  const degrees = ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
  const index = Math.round(degrees / 18) % 20;
  const number = ORDER[index] as number;
  if (r <= R.bull) return { segment: { number: 25, multiplier: 2 }, band: [0, R.bull], index: -1 };
  if (r <= R.outerBull) {
    return { segment: { number: 25, multiplier: 1 }, band: [R.bull, R.outerBull], index: -1 };
  }
  if (r < R.trebleInner)
    return { segment: { number, multiplier: 1 }, band: [R.outerBull, R.trebleInner], index };
  if (r <= R.trebleOuter)
    return { segment: { number, multiplier: 3 }, band: [R.trebleInner, R.trebleOuter], index };
  if (r < R.doubleInner)
    return { segment: { number, multiplier: 1 }, band: [R.trebleOuter, R.doubleInner], index };
  if (r <= R.doubleOuter)
    return { segment: { number, multiplier: 2 }, band: [R.doubleInner, R.doubleOuter], index };
  return { segment: { number: 0, multiplier: 0 }, band: [R.doubleOuter, R.frame], index: -2 };
}

/**
 * A big board to correct a dart by touch: press, slide to the right field (it lights up and its
 * name shows above the finger), and release to log it. Lifting off the board logs nothing.
 */
export function TouchDartboard({ onPick }: { onPick(segment: Segment): void }) {
  const [aim, setAim] = useState<{
    x: number;
    y: number;
    hit: ReturnType<typeof segmentAt>;
  } | null>(null);

  const at = (e: PointerEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
    if (Math.hypot(p.x, p.y) > R.frame) return null;
    return { x: p.x, y: p.y, hit: segmentAt(p.x, p.y) };
  };

  const shape = aim ? aimShape(aim.hit) : null;
  const label = aim ? dartLabel(aim.hit.segment) : "";
  // Keep the bubble on the board and clear of the finger.
  const bubbleY = aim ? Math.max(-R.frame + 34, aim.y - 70) : 0;
  const bubbleX = aim ? Math.min(R.frame - 60, Math.max(-R.frame + 60, aim.x)) : 0;

  return (
    <svg
      className="dartboard touch-board"
      viewBox={`${-R.frame} ${-R.frame} ${R.frame * 2} ${R.frame * 2}`}
      role="img"
      aria-label="Touch the field where the dart is, release to log it"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setAim(at(e));
      }}
      onPointerMove={(e) => {
        if (aim !== null || e.buttons) setAim(at(e));
      }}
      onPointerUp={(e) => {
        const final = at(e);
        setAim(null);
        if (final) onPick(final.hit.segment);
      }}
      onPointerCancel={() => setAim(null)}
    >
      <circle className="db-frame" r={R.frame} />
      {BOARD}
      <circle className="db-ring-green" r={R.outerBull} />
      <circle className="db-ring-red" r={R.bull} />
      <circle className="db-wire" r={R.doubleOuter} />
      {shape}
      {aim && (
        <g className="touch-aim" pointerEvents="none">
          <circle cx={aim.x} cy={aim.y} r={6} className="touch-dot" />
          <g transform={`translate(${bubbleX.toFixed(1)} ${bubbleY.toFixed(1)})`}>
            <rect x={-56} y={-26} width={112} height={52} rx={14} className="touch-bubble" />
            <text className="touch-label" dominantBaseline="central">
              {label}
            </text>
          </g>
        </g>
      )}
    </svg>
  );
}

/** The aimed field, outlined. */
function aimShape(hit: ReturnType<typeof segmentAt>) {
  const [r1, r2] = hit.band;
  if (hit.index === -1) {
    return r1 === 0 ? (
      <circle className="touch-field" r={r2} />
    ) : (
      <path
        className="touch-field"
        fillRule="evenodd"
        d={`M${-r2} 0a${r2} ${r2} 0 1 0 ${2 * r2} 0a${r2} ${r2} 0 1 0 ${-2 * r2} 0ZM${-r1} 0a${r1} ${r1} 0 1 0 ${2 * r1} 0a${r1} ${r1} 0 1 0 ${-2 * r1} 0Z`}
      />
    );
  }
  if (hit.index === -2) {
    return (
      <path
        className="touch-field miss"
        fillRule="evenodd"
        d={`M${-r2} 0a${r2} ${r2} 0 1 0 ${2 * r2} 0a${r2} ${r2} 0 1 0 ${-2 * r2} 0ZM${-r1} 0a${r1} ${r1} 0 1 0 ${2 * r1} 0a${r1} ${r1} 0 1 0 ${-2 * r1} 0Z`}
      />
    );
  }
  const from = hit.index * 18 - 9;
  return <path className="touch-field" d={wedge(from, from + 18, r1, r2)} />;
}
