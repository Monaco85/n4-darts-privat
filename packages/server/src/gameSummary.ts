// Every player's numbers per game (X01, Cricket, Around the World, Elimination), from the
// local database. Served at /api/players/games and written to `spieler-stats.json` in the data
// folder after every change, so the stats are also a plain file on the PC.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GameMode, type GamePlayerStats, gameOf, gameStats } from "@n4/engine";
import type { FastifyInstance } from "fastify";
import type { Db } from "./db.ts";
import type { Stats } from "./stats.ts";

export interface GameTotals {
  matches: number;
  won: number;
  legs: number;
  legsWon: number;
  darts: number;
  /** Fewest darts in a leg won. */
  bestLeg: number | null;
  /** X01 and Elimination: points per 3 darts. Cricket: marks per round. Around the World: hits per 3 darts. */
  perRound: number | null;
}

export interface PlayerGames {
  playerId: string;
  name: string;
  games: Record<GameMode, GameTotals>;
  /** X01 extras from the long-term stats. */
  x01: { highestCheckout: number | null; s180: number; first9Average: number | null };
}

const empty = (): GameTotals => ({
  matches: 0,
  won: 0,
  legs: 0,
  legsWon: 0,
  darts: 0,
  bestLeg: null,
  perRound: null,
});

export function createGameSummary(db: Db, stats: Stats) {
  const cache = new Map<string, GamePlayerStats[]>();
  db.onChange(({ matchId }) => {
    if (matchId) cache.delete(matchId);
  });

  function all(): PlayerGames[] {
    return db.players().map((player) => {
      const games: Record<GameMode, GameTotals> = {
        x01: empty(),
        cricket: empty(),
        atc: empty(),
        elimination: empty(),
      };
      const raw: Record<GameMode, { points: number; marks: number }> = {
        x01: { points: 0, marks: 0 },
        cricket: { points: 0, marks: 0 },
        atc: { points: 0, marks: 0 },
        elimination: { points: 0, marks: 0 },
      };
      for (const match of db.completedMatchesOf(player.id, Number.MAX_SAFE_INTEGER)) {
        let perPlayer = cache.get(match.id);
        if (!perPlayer) {
          perPlayer = gameStats(match.settings, db.events(match.id));
          cache.set(match.id, perPlayer);
        }
        const own = perPlayer[match.playerIds.indexOf(player.id)];
        if (!own) continue;
        const game = gameOf(match.settings);
        const t = games[game];
        t.matches += 1;
        if (own.won) t.won += 1;
        t.legs += own.legsPlayed;
        t.legsWon += own.legsWon;
        t.darts += own.darts;
        if (own.bestLeg !== null) t.bestLeg = Math.min(t.bestLeg ?? own.bestLeg, own.bestLeg);
        raw[game].points += own.points;
        raw[game].marks += own.marks;
      }
      for (const game of Object.keys(games) as GameMode[]) {
        const t = games[game];
        if (t.darts === 0) continue;
        const amount = game === "cricket" ? raw[game].marks : raw[game].points;
        t.perRound = Math.round((amount / t.darts) * 3 * 100) / 100;
      }
      const totals = stats.profile(player.id)?.totals;
      return {
        playerId: player.id,
        name: player.name,
        games,
        x01: {
          highestCheckout: totals?.highestCheckout ?? null,
          s180: totals?.s180 ?? 0,
          first9Average: totals?.first9Average ?? null,
        },
      };
    });
  }

  return { all };
}

export type GameSummary = ReturnType<typeof createGameSummary>;

/** Keeps `spieler-stats.json` in the data folder up to date (a second after the last change). */
export function writeStatsFile(db: Db, summary: GameSummary, dataDir: string) {
  const path = join(dataDir, "spieler-stats.json");
  const write = () => {
    try {
      const players = summary.all();
      writeFileSync(
        path,
        `${JSON.stringify({ aktualisiert: new Date().toISOString(), spieler: players }, null, 2)}\n`,
      );
    } catch (error) {
      console.warn(`spieler-stats.json not written: ${(error as Error).message}`);
    }
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = db.onChange(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(write, 1000);
  });
  write();
  return {
    path,
    stop() {
      stop();
      if (timer) clearTimeout(timer);
    },
  };
}

export function registerGameSummary(app: FastifyInstance, summary: GameSummary) {
  app.get("/api/players/games", async () => summary.all());
}
