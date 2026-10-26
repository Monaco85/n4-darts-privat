// Long-term stats (display-and-stats spec): numbers per player over every counted match
// (completed, not abandoned, not a walkover, any kind and player count), from the event logs.
// A closed match's numbers are cached until the match changes (e.g. a correction).

import {
  gameOf,
  matchState,
  matchStats,
  type PlayerMatchStats,
  threeDartAverage,
} from "@n4/engine";
import type { FastifyInstance } from "fastify";
import type { Award, LeaderboardRow, PlayerProfile, StatTotals } from "./api.ts";
import type { Db, MatchRecord, StoredEvent } from "./db.ts";
import { RATING_MATCHES } from "./ratings.ts";

/** How many matches a profile lists. */
const RECENT = 20;
/** How many darts the profile's heatmap shows. */
const HEATMAP = 500;
/** An evening that runs past midnight counts to the day it started. */
const EVENING_SHIFT_MS = 6 * 60 * 60 * 1000;
const ALL = Number.MAX_SAFE_INTEGER;

const dayOf = (iso: string) => {
  const at = new Date(Date.parse(iso) - EVENING_SHIFT_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};

export function totalsOf(own: PlayerMatchStats[]): StatTotals {
  const sum = (pick: (s: PlayerMatchStats) => number) => own.reduce((n, s) => n + pick(s), 0);
  const most = (
    pick: (s: PlayerMatchStats) => number | null,
    better: (a: number, b: number) => number,
  ) =>
    own.reduce<number | null>((best, s) => {
      const value = pick(s);
      return value === null ? best : best === null ? value : better(best, value);
    }, null);
  const attempts = sum((s) => s.checkoutAttempts);
  return {
    matches: own.length,
    matchesWon: own.filter((s) => s.won).length,
    legs: sum((s) => s.legsPlayed),
    legsWon: sum((s) => s.legsWon),
    average: threeDartAverage(own),
    first9Average: threeDartAverage(own.map((s) => s.first9)),
    checkoutPercent: attempts === 0 ? null : (sum((s) => s.checkoutHits) / attempts) * 100,
    checkoutAttempts: attempts,
    highestCheckout: most((s) => s.highestCheckout, Math.max),
    bestLeg: most((s) => s.bestLeg, Math.min),
    s180: sum((s) => s.s180),
    s140: sum((s) => s.s140),
    s100: sum((s) => s.s100),
  };
}

type Point = { x: number; y: number };

/**
 * Where each player's darts landed (throwing order, oldest first). Only darts the board saw at a
 * real position: no bounce-outs, no darts added by hand, and none the board got wrong (corrected).
 */
function landedDarts(match: MatchRecord, events: StoredEvent[]): Point[][] {
  const corrected = new Set(events.flatMap((e) => (e.type === "DartCorrected" ? [e.dartId] : [])));
  const where = new Map<string, Point>();
  for (const e of events) {
    const coords = e.coords as Point | undefined;
    if (e.type !== "DartThrown" || !coords || e.bouncer || corrected.has(e.dartId)) continue;
    // Three decimals is far finer than the board can tell, and keeps the JSON small.
    const round = (v: number) => Math.round(v * 1000) / 1000;
    where.set(e.dartId, { x: round(coords.x), y: round(coords.y) });
  }
  const state = matchState(match.settings, events);
  const landed: Point[][] = match.playerIds.map(() => []);
  const visits = state.legs.flatMap((leg) => leg.visits);
  if (state.currentVisit) visits.push(state.currentVisit);
  for (const visit of visits) {
    for (const dart of visit.darts) {
      const point = where.get(dart.dartId);
      if (point) landed[visit.player]?.push(point);
    }
  }
  return landed;
}

export function createStats(db: Db) {
  const cache = new Map<string, { stats: PlayerMatchStats[]; landed: Point[][]; day: string }>();
  db.onChange(({ matchId }) => {
    if (matchId) cache.delete(matchId);
  });

  /** Every player's numbers in a match (throwing order), and the day it was played. */
  function cached(match: MatchRecord) {
    let entry = cache.get(match.id);
    if (!entry) {
      const timed = db.timedEvents(match.id);
      const events = timed.map((t) => t.event);
      entry = {
        stats: matchStats(match.settings, events),
        landed: landedDarts(match, events),
        day: dayOf(timed[0]?.at ?? match.closedAt ?? new Date().toISOString()),
      };
      cache.set(match.id, entry);
    }
    return entry;
  }
  const ofMatch = (match: MatchRecord) => cached(match).stats;

  /** The player's own numbers per counted X01 match, newest first (other games: gameSummary.ts). */
  function countedOf(playerId: string) {
    return db.completedMatchesOf(playerId, ALL).flatMap((match) => {
      if (gameOf(match.settings) !== "x01") return [];
      const own = ofMatch(match)[match.playerIds.indexOf(playerId)];
      return own ? [{ match, own }] : [];
    });
  }

  const ratingFrom = (counted: { own: PlayerMatchStats }[]) =>
    threeDartAverage(counted.slice(0, RATING_MATCHES).map((c) => c.own));

  function leaderboard(): LeaderboardRow[] {
    const rows = db.players().flatMap((player) => {
      const counted = countedOf(player.id);
      if (counted.length === 0) return [];
      const totals = totalsOf(counted.map((c) => c.own));
      return [
        {
          playerId: player.id,
          name: player.name,
          photo: player.photo,
          rating: ratingFrom(counted),
          average: totals.average,
          matches: totals.matches,
          matchesWon: totals.matchesWon,
          s180: totals.s180,
          highestCheckout: totals.highestCheckout,
        },
      ];
    });
    return rows.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || a.name.localeCompare(b.name));
  }

  function profile(playerId: string): PlayerProfile | undefined {
    const player = db.getPlayer(playerId);
    if (!player) return undefined;
    const counted = countedOf(playerId);
    const name = (id: string) => db.getPlayer(id)?.name ?? "?";

    const byDay = new Map<string, PlayerMatchStats[]>();
    for (const { match, own } of [...counted].reverse()) {
      const day = cached(match).day;
      byDay.set(day, [...(byDay.get(day) ?? []), own]);
    }

    const tournaments = db.tournaments().flatMap((t) => {
      const placing =
        t.status === "finished" ? t.placings?.find((p) => p.playerId === playerId) : undefined;
      if (!placing) return [];
      return [
        {
          id: t.id,
          name: t.name,
          date: t.startedAt ?? t.createdAt,
          from: placing.from,
          to: placing.to,
        },
      ];
    });
    const best = tournaments.reduce<PlayerProfile["bestPlacing"]>(
      (b, t) =>
        b === null || t.from < b.from ? { from: t.from, to: t.to, tournament: t.name } : b,
      null,
    );
    const rank = leaderboard().findIndex((row) => row.playerId === playerId);

    return {
      playerId,
      name: player.name,
      photo: player.photo,
      rating: ratingFrom(counted),
      rank: rank < 0 ? null : rank + 1,
      since: byDay.keys().next().value ?? null,
      totals: totalsOf(counted.map((c) => c.own)),
      evenings: [...byDay].map(([day, own]) => ({
        day,
        average: threeDartAverage(own),
        matches: own.length,
      })),
      tournaments,
      tournamentsWon: tournaments.filter((t) => t.from === 1).length,
      bestPlacing: best,
      heatmap: counted
        .flatMap(({ match }) =>
          (cached(match).landed[match.playerIds.indexOf(playerId)] ?? []).toReversed(),
        )
        .slice(0, HEATMAP),
      recent: counted.slice(0, RECENT).map(({ match, own }) => {
        const all = ofMatch(match);
        const others = match.playerIds.flatMap((id, i) => (id === playerId ? [] : [i]));
        return {
          matchId: match.id,
          date: match.closedAt as string,
          opponents: others.map((i) => name(match.playerIds[i] as string)),
          won: own.won,
          legsFor: own.legsWon,
          legsAgainst: Math.max(0, ...others.map((i) => all[i]?.legsWon ?? 0)),
          average: threeDartAverage([own]),
        };
      }),
    };
  }

  /** The best of a tournament's played matches (no walkovers, no abandoned ones). */
  function awards(tournamentId: string): Award[] {
    const name = (id: string) => db.getPlayer(id)?.name ?? "?";
    const own = db
      .tournamentMatches(tournamentId)
      .filter((m) => m.closedAt && !m.abandoned && !m.walkover)
      .flatMap((match) =>
        ofMatch(match).map((stats, i) => ({ playerId: match.playerIds[i] as string, stats })),
      );
    const result: Award[] = [];
    /** The players with the best value (higher or lower is better), if anyone has one. */
    const best = (
      kind: Award["kind"],
      entries: { playerId: string; value: number | null }[],
      lower = false,
    ) => {
      const values = entries.flatMap((e) => (e.value === null ? [] : [e.value]));
      if (values.length === 0) return;
      const top = lower ? Math.min(...values) : Math.max(...values);
      const players = [...new Set(entries.filter((e) => e.value === top).map((e) => e.playerId))];
      result.push({ kind, value: top, players: players.map(name) });
    };
    best(
      "bestAverage",
      own.map((o) => ({ playerId: o.playerId, value: threeDartAverage([o.stats]) })),
    );
    best(
      "highestCheckout",
      own.map((o) => ({ playerId: o.playerId, value: o.stats.highestCheckout })),
    );
    const s180 = new Map<string, number>();
    for (const o of own) s180.set(o.playerId, (s180.get(o.playerId) ?? 0) + o.stats.s180);
    best(
      "most180s",
      [...s180].map(([playerId, count]) => ({ playerId, value: count > 0 ? count : null })),
    );
    best(
      "bestLeg",
      own.map((o) => ({ playerId: o.playerId, value: o.stats.bestLeg })),
      true,
    );
    return result;
  }

  return { ofMatch, leaderboard, profile, awards };
}

export type Stats = ReturnType<typeof createStats>;

export function registerStats(app: FastifyInstance, stats: Stats) {
  app.get("/api/players/stats", async () => stats.leaderboard());
  app.get<{ Params: { id: string } }>("/api/players/:id/stats", async (request, reply) => {
    const profile = stats.profile(request.params.id);
    return profile ?? reply.code(404).send({ error: "no such player" });
  });
}
