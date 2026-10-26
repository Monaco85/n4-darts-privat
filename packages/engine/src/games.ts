// Cricket, Around the World and Elimination, folded over the same event log as X01 (x01.ts).
// Every game fills the same MatchState, so the server, the station and the history need no
// game-specific plumbing; `PlayerState.remaining` is each game's headline number.

import {
  gameOf,
  type LegView,
  MAX_PLAYERS,
  type MatchEvent,
  type MatchState,
  MIN_PLAYERS,
  matchState,
  type Phase,
  type PlayerIndex,
  type PlayerState,
  type RawVisit,
  type VisitView,
  visitsOf,
  type X01Settings,
} from "./x01.ts";

/** Cricket's numbers, in the order they are shown; 25 is the bull. */
export const CRICKET_TARGETS = [20, 19, 18, 17, 16, 15, 25] as const;

/** Around the World: 1 to 20, then the bull. */
export const ATC_TARGETS = [...Array.from({ length: 20 }, (_, i) => i + 1), 25] as const;

interface VisitResult {
  view: VisitView;
  /** No more darts count: three thrown, a bust or the leg won. */
  over: boolean;
  /** The thrower won the leg with this visit. */
  legWon: boolean;
}

interface Rules {
  /** A player at the start of a leg. */
  fresh(settings: X01Settings): PlayerState;
  /** Scores one visit; may change every player (Elimination sends others back). */
  visit(
    raw: RawVisit,
    thrower: PlayerIndex,
    players: PlayerState[],
    settings: X01Settings,
  ): VisitResult;
}

// ---------- Cricket ----------

const cricket: Rules = {
  fresh: () => ({ remaining: 0, legsWon: 0, isIn: true, marks: CRICKET_TARGETS.map(() => 0) }),

  visit(raw, thrower, players) {
    const view: VisitView = { player: thrower, darts: [], bust: false, checkout: false };
    const me = players[thrower] as PlayerState;
    const marks = me.marks as number[];
    let over = false;
    let legWon = false;
    for (const { dartId, segment } of raw.darts) {
      if (over) {
        view.darts.push({ dartId, segment, score: 0, ignored: true, marks: 0 });
        continue;
      }
      const index = CRICKET_TARGETS.indexOf(segment.number as (typeof CRICKET_TARGETS)[number]);
      let score = 0;
      let hit = 0;
      if (index >= 0 && segment.multiplier > 0) {
        hit = segment.multiplier;
        const before = marks[index] ?? 0;
        const after = before + hit;
        marks[index] = Math.min(after, 3);
        // Marks beyond the third score, while any opponent still has the number open.
        const extra = Math.max(0, after - 3) - Math.max(0, before - 3);
        const open = players.some((p, i) => i !== thrower && (p.marks?.[index] ?? 0) < 3);
        if (extra > 0 && open) score = extra * (CRICKET_TARGETS[index] as number);
        hit = Math.min(after, 3) - Math.min(before, 3) + (score > 0 ? extra : 0);
      }
      me.remaining += score;
      view.darts.push({ dartId, segment, score, ignored: false, marks: hit });
      const closedAll = marks.every((m) => m >= 3);
      const ahead = players.every((p, i) => i === thrower || p.remaining <= me.remaining);
      if (closedAll && ahead) {
        legWon = true;
        view.checkout = true;
      }
      over = legWon || view.darts.length === 3;
    }
    return { view, over, legWon };
  },
};

// ---------- Around the World ----------

const atc: Rules = {
  fresh: () => ({ remaining: ATC_TARGETS[0], legsWon: 0, isIn: true, progress: 0 }),

  visit(raw, thrower, players) {
    const view: VisitView = { player: thrower, darts: [], bust: false, checkout: false };
    const me = players[thrower] as PlayerState;
    let over = false;
    let legWon = false;
    for (const { dartId, segment } of raw.darts) {
      if (over) {
        view.darts.push({ dartId, segment, score: 0, ignored: true });
        continue;
      }
      const target = ATC_TARGETS[me.progress ?? 0];
      const hit = segment.multiplier > 0 && segment.number === target;
      if (hit) me.progress = (me.progress ?? 0) + 1;
      me.remaining = ATC_TARGETS[me.progress ?? 0] ?? 0;
      view.darts.push({ dartId, segment, score: hit ? 1 : 0, ignored: false });
      if ((me.progress ?? 0) >= ATC_TARGETS.length) {
        legWon = true;
        view.checkout = true;
      }
      over = legWon || view.darts.length === 3;
    }
    return { view, over, legWon };
  },
};

// ---------- Elimination ----------

/**
 * Count up from zero to exactly `startScore`; going over is a bust. A visit that ends on an
 * opponent's score sends that opponent back to zero.
 */
const elimination: Rules = {
  fresh: () => ({ remaining: 0, legsWon: 0, isIn: true }),

  visit(raw, thrower, players, settings) {
    const view: VisitView = { player: thrower, darts: [], bust: false, checkout: false };
    const me = players[thrower] as PlayerState;
    const before = me.remaining;
    let score = before;
    let over = false;
    for (const { dartId, segment } of raw.darts) {
      if (over) {
        view.darts.push({ dartId, segment, score: 0, ignored: true });
        continue;
      }
      const points = segment.number * segment.multiplier;
      view.darts.push({ dartId, segment, score: points, ignored: false });
      score += points;
      if (score > settings.startScore) {
        view.bust = true;
        score = before;
      } else if (score === settings.startScore) {
        view.checkout = true;
      }
      over = view.bust || view.checkout || view.darts.length === 3;
    }
    me.remaining = score;
    // The visit's end: three darts, or fewer and the darts were pulled.
    if ((over || raw.closed) && !view.bust && score > 0) {
      const eliminated = players.flatMap((p, i) =>
        i !== thrower && p.remaining === score ? [i] : [],
      );
      for (const i of eliminated) (players[i] as PlayerState).remaining = 0;
      if (eliminated.length) view.eliminated = eliminated;
    }
    return { view, over, legWon: view.checkout };
  },
};

const RULES: Record<Exclude<ReturnType<typeof gameOf>, "x01">, Rules> = {
  cricket,
  atc,
  elimination,
};

/** The state of a Cricket, Around the World or Elimination match; same shape as X01's. */
export function gameState(settings: X01Settings, events: MatchEvent[]): MatchState {
  const game = gameOf(settings);
  if (game === "x01") throw new Error("gameState is for the other games; X01 is matchState");
  const rules = RULES[game];
  const startIndex = events.findIndex((e) => e.type === "MatchStarted");
  const started = events[startIndex];
  if (started?.type !== "MatchStarted") {
    return {
      phase: "notStarted",
      players: [],
      currentPlayer: 0,
      currentVisit: null,
      legs: [],
      winner: null,
    };
  }
  const count = started.playerCount;
  if (!Number.isInteger(count) || count < MIN_PLAYERS || count > MAX_PLAYERS) {
    throw new Error(`a match needs ${MIN_PLAYERS}–${MAX_PLAYERS} players, got ${count}`);
  }
  let players = Array.from({ length: count }, () => rules.fresh(settings));
  const next = (p: PlayerIndex): PlayerIndex => (p + 1) % count;

  let currentPlayer: PlayerIndex = 0;
  let leg: LegView = { starter: currentPlayer, visits: [], winner: null };
  const legs = [leg];
  let currentVisit: VisitView | null = null;
  let visitOver = false;
  let winner: PlayerIndex | null = null;
  for (const raw of visitsOf(events.slice(startIndex + 1))) {
    // Score on a copy, so an open visit can be replaced when its darts change.
    const working: PlayerState[] = players.map((p) =>
      p.marks ? { ...p, marks: [...p.marks] } : { ...p },
    );
    const result = rules.visit(raw, currentPlayer, working, settings);
    visitOver = result.over;
    if (!raw.closed) {
      players = working;
      if (result.legWon) {
        const thrower = players[currentPlayer] as PlayerState;
        thrower.legsWon += 1;
        leg.winner = currentPlayer;
        if (thrower.legsWon >= settings.legsToWin) winner = currentPlayer;
      }
      currentVisit = result.view;
      continue;
    }
    players = working;
    leg.visits.push(result.view);
    currentVisit = null;
    visitOver = false;
    if (result.legWon) {
      const thrower = players[currentPlayer] as PlayerState;
      thrower.legsWon += 1;
      leg.winner = currentPlayer;
      if (thrower.legsWon >= settings.legsToWin) {
        winner = currentPlayer;
        break;
      }
      players = players.map((p) => ({ ...rules.fresh(settings), legsWon: p.legsWon }));
      leg = { starter: next(leg.starter), visits: [], winner: null };
      legs.push(leg);
      currentPlayer = leg.starter;
    } else {
      currentPlayer = next(currentPlayer);
    }
  }

  const phase: Phase = winner !== null ? "matchWon" : visitOver ? "awaitingTakeout" : "throwing";
  return { phase, players, currentPlayer, currentVisit, legs, winner };
}

/** One player's numbers in a match of any game, for the local stats file and the player page. */
export interface GamePlayerStats {
  game: ReturnType<typeof gameOf>;
  won: boolean;
  legsPlayed: number;
  legsWon: number;
  darts: number;
  /** X01 and Elimination: points scored. Around the World: targets hit. Cricket: points. */
  points: number;
  /** Cricket: marks scored (for marks per round). */
  marks: number;
  /** Fewest darts in a leg the player won. */
  bestLeg: number | null;
}

/** Per player, in throwing order; busts count their darts for no points. */
export function gameStats(settings: X01Settings, events: MatchEvent[]): GamePlayerStats[] {
  const game = gameOf(settings);
  const state = matchState(settings, events);
  const stats: GamePlayerStats[] = state.players.map((_, p) => ({
    game,
    won: state.winner === p,
    legsPlayed: 0,
    legsWon: 0,
    darts: 0,
    points: 0,
    marks: 0,
    bestLeg: null,
  }));
  state.legs.forEach((leg, l) => {
    const visits =
      l === state.legs.length - 1 && state.currentVisit
        ? [...leg.visits, state.currentVisit]
        : leg.visits;
    const legDarts = stats.map(() => 0);
    for (const visit of visits) {
      const s = stats[visit.player];
      if (!s) continue;
      const counted = visit.darts.filter((d) => !d.ignored);
      s.darts += counted.length;
      legDarts[visit.player] = (legDarts[visit.player] ?? 0) + counted.length;
      if (!visit.bust) s.points += counted.reduce((sum, d) => sum + d.score, 0);
      s.marks += counted.reduce((sum, d) => sum + (d.marks ?? 0), 0);
    }
    if (leg.winner === null) return;
    for (const s of stats) s.legsPlayed += 1;
    const w = stats[leg.winner];
    if (!w) return;
    w.legsWon += 1;
    const darts = legDarts[leg.winner] ?? 0;
    w.bestLeg = w.bestLeg === null ? darts : Math.min(w.bestLeg, darts);
  });
  return stats;
}
