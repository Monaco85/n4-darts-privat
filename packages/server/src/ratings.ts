// A player's rating: their 3-dart average over recent completed matches, used for seeding
// (GLOSSARY.md: Rating).

import { dartStats, gameOf, threeDartAverage } from "@n4/engine";
import type { Db, MatchRecord } from "./db.ts";

/** How many of a player's most recent completed matches count. */
export const RATING_MATCHES = 10;

export function ratingOf(db: Db, playerId: string): number | null {
  // Usually every recent match is X01; only look further back when other games are in between.
  const isX01 = (match: MatchRecord) => gameOf(match.settings) === "x01";
  const recent = db.completedMatchesOf(playerId, RATING_MATCHES);
  const x01 = (
    recent.every(isX01) || recent.length < RATING_MATCHES
      ? recent.filter(isX01)
      : db.completedMatchesOf(playerId, Number.MAX_SAFE_INTEGER).filter(isX01)
  ).slice(0, RATING_MATCHES);
  const stats = x01.flatMap((match) => {
    const index = match.playerIds.indexOf(playerId);
    const own = dartStats(match.settings, db.events(match.id))[index];
    return own ? [own] : [];
  });
  return threeDartAverage(stats);
}
