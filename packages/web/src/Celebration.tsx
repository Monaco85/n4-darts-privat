// The winner's moment: confetti in the board's colours, a trophy that pops in and a few numbers
// from the match. Pure CSS animation; nothing moves for people who prefer reduced motion.

import { gameOf } from "@n4/engine";
import type { MatchView } from "@n4/server/api";
import type { CSSProperties } from "react";

const COLOURS = ["#e3242f", "#ffffff", "#e3242f", "#f5c542", "#9a9aa2", "#1e9b55"];

/** A fixed pseudo-random sequence, so the confetti looks the same on every render. */
function sequence(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

const PIECES = (() => {
  const next = sequence(42);
  return Array.from({ length: 140 }, (_, i) => ({
    left: next() * 100,
    // The first pieces burst out at once, the rest keep drifting down.
    delay: i < 70 ? next() * 0.8 : 0.8 + next() * 4,
    duration: 3.2 + next() * 2.8,
    drift: (next() - 0.5) * 160,
    spin: 360 + next() * 720,
    size: 7 + next() * 9,
    colour: COLOURS[i % COLOURS.length] as string,
    round: next() > 0.7,
  }));
})();

/** Falling confetti behind the winner; `aria-hidden`, it only decorates. */
export function Confetti() {
  return (
    <div className="confetti" aria-hidden="true">
      {PIECES.map((p, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list that never reorders.
          key={i}
          className={p.round ? "round" : undefined}
          style={
            {
              left: `${p.left}%`,
              width: `${p.size}px`,
              height: `${p.round ? p.size : p.size * 0.45}px`,
              background: p.colour,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.duration}s`,
              "--drift": `${p.drift}px`,
              "--spin": `${p.spin}deg`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

/** A trophy drawn in SVG, so it needs no image file. */
export function Trophy() {
  return (
    <svg className="trophy" viewBox="0 0 64 64" aria-hidden="true">
      <path className="trophy-handles" d="M19 12H10c0 9 4 13 10 13M45 12h9c0 9-4 13-10 13" />
      <path className="trophy-cup" d="M18 8h28v10c0 9-6 16-14 16S18 27 18 18Z" />
      <rect className="trophy-cup" x="29" y="33" width="6" height="9" />
      <rect className="trophy-cup" x="21" y="42" width="22" height="7" rx="1.5" />
      <circle className="trophy-shine" cx="27" cy="16" r="2.5" />
    </svg>
  );
}

/** A few numbers from the winner's match, worded for the game played. */
export function winnerFacts(match: MatchView): { label: string; value: string }[] {
  const { state } = match;
  const winner = state.winner;
  if (winner === null) return [];
  const visits = state.legs.flatMap((leg) => leg.visits);
  if (state.currentVisit) visits.push(state.currentVisit);
  const own = visits.filter((v) => v.player === winner);
  const darts = own.reduce((n, v) => n + v.darts.filter((d) => !d.ignored).length, 0);
  const points = own.reduce(
    (n, v) => n + (v.bust ? 0 : v.darts.filter((d) => !d.ignored).reduce((s, d) => s + d.score, 0)),
    0,
  );
  const last = own.at(-1);
  const finish = last?.checkout
    ? last.darts.filter((d) => !d.ignored).reduce((s, d) => s + d.score, 0)
    : null;
  const per3 = (n: number) => (darts ? ((n / darts) * 3).toFixed(1) : "–");

  switch (gameOf(match.settings)) {
    case "cricket": {
      const marks = own.reduce(
        (n, v) => n + v.darts.reduce((s, d) => s + (d.ignored ? 0 : (d.marks ?? 0)), 0),
        0,
      );
      return [
        { label: "MPR", value: darts ? ((marks / darts) * 3).toFixed(2) : "–" },
        { label: "Points", value: String(state.players[winner]?.remaining ?? 0) },
        { label: "Darts", value: String(darts) },
      ];
    }
    case "atc":
      return [
        { label: "Darts", value: String(darts) },
        { label: "Hit rate", value: darts ? `${Math.round((points / darts) * 100)}%` : "–" },
      ];
    case "elimination":
      return [
        { label: "Average", value: per3(points) },
        { label: "Darts", value: String(darts) },
      ];
    default:
      return [
        { label: "Average", value: per3(points) },
        { label: "Darts", value: String(darts) },
        ...(finish ? [{ label: "Checkout", value: String(finish) }] : []),
      ];
  }
}
