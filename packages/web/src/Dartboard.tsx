import type { DartView } from "@n4/engine";
import type { ReactElement } from "react";
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
}

/** The dartboard with this visit's darts where the board saw them, numbered in throwing order. */
export function Dartboard({ darts, coords }: Props) {
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
      {placed.map(({ dart, i, x, y }) => (
        <g
          key={dart.dartId}
          className={`db-dart ${dart.dartId === latest ? "latest" : ""} ${dart.ignored ? "ignored" : ""}`}
          transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}
        >
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
