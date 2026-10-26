// X01 rules as a pure fold over a match's event log (docs/adr/0002, 0003).
// The other games (Cricket, Around the World, Elimination) live in games.ts.

import { gameState } from "./games.ts";

/** A player's place in the match's throwing order; player 0 starts leg 1. */
export type PlayerIndex = number;

/** One player may play alone (practice); a tournament still pairs players up. */
export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 8;

/** Bumped whenever the rules change, so old matches replay under the rules they were played with. */
export const RULES_VERSION = 1;

/** Where a dart landed: the bullseye is `{ number: 25, multiplier: 2 }`, a miss has multiplier 0. */
export interface Segment {
  number: number;
  multiplier: 0 | 1 | 2 | 3;
}

/** Whether a value from outside (a request body) is a segment a dart can land in. */
export function isSegment(value: unknown): value is Segment {
  const { number, multiplier } = (value ?? {}) as Partial<Segment>;
  if (typeof number !== "number" || typeof multiplier !== "number") return false;
  const validNumber = number === 25 || (Number.isInteger(number) && number >= 0 && number <= 20);
  return validNumber && [0, 1, 2, 3].includes(multiplier);
}

export type InRule = "straight" | "double" | "master" | "bull";
export type OutRule = "straight" | "double" | "master";

/** What is played: X01 (301/501/701), Cricket, Around the World or Elimination. */
export type GameMode = "x01" | "cricket" | "atc" | "elimination";
export const GAME_MODES: readonly GameMode[] = ["x01", "cricket", "atc", "elimination"];

export interface X01Settings {
  /** Missing on matches from before there were other games: X01. */
  game?: GameMode;
  /** X01: the score to bring down to zero. Elimination: the score to reach exactly. */
  startScore: number;
  inRule: InRule;
  outRule: OutRule;
  legsToWin: number;
  rulesVersion: number;
}

/** The game a match plays; older matches have none and are X01. */
export const gameOf = (settings: Pick<X01Settings, "game">): GameMode => settings.game ?? "x01";

export const defaultX01Settings: X01Settings = {
  game: "x01",
  startScore: 301,
  inRule: "straight",
  outRule: "straight",
  legsToWin: 1,
  rulesVersion: RULES_VERSION,
};

export type MatchEvent =
  | { type: "MatchStarted"; playerCount: number }
  | { type: "DartThrown"; dartId: string; segment: Segment }
  | { type: "DartCorrected"; dartId: string; segment: Segment }
  | { type: "TakeoutFinished" }
  | { type: "VisitEndedManually" }
  | { type: "VisitUndone" };

export interface PlayerState {
  /**
   * The player's headline number. X01: left to score. Cricket: points. Around the World: the
   * number to hit next (25 = bull, 0 = done). Elimination: the score so far.
   */
  remaining: number;
  legsWon: number;
  /** Whether the in rule has been met this leg. */
  isIn: boolean;
  /** Cricket: marks on 20, 19, 18, 17, 16, 15 and bull (`CRICKET_TARGETS`), 3 = closed. */
  marks?: number[];
  /** Around the World: how many targets are done (0–21). */
  progress?: number;
}

export type Phase = "notStarted" | "throwing" | "awaitingTakeout" | "matchWon";

export interface DartView {
  dartId: string;
  segment: Segment;
  score: number;
  /** Thrown after the visit was already over (third dart, bust or checkout); counts for nothing. */
  ignored: boolean;
  /** Cricket: marks this dart scored on an open or closing number. */
  marks?: number;
}

export interface VisitView {
  player: PlayerIndex;
  darts: DartView[];
  /** Went below zero (or broke the out rule): the visit scores nothing. */
  bust: boolean;
  /** Finished the leg. */
  checkout: boolean;
  /** Elimination: players this visit sent back to zero. */
  eliminated?: PlayerIndex[];
}

export interface LegView {
  starter: PlayerIndex;
  /** Closed visits, in order. The visit in progress is `MatchState.currentVisit`. */
  visits: VisitView[];
  winner: PlayerIndex | null;
}

export interface MatchState {
  phase: Phase;
  /** One entry per player, in throwing order. */
  players: PlayerState[];
  currentPlayer: PlayerIndex;
  /** The visit in progress, until takeout. */
  currentVisit: VisitView | null;
  legs: LegView[];
  winner: PlayerIndex | null;
}

export interface RawVisit {
  darts: { dartId: string; segment: Segment }[];
  /** Ended by takeout or manually; only the last visit can be open. */
  closed: boolean;
}

/** Groups the event log into visits, independent of scoring. Corrections replace segments in place. */
export function visitsOf(events: MatchEvent[]): RawVisit[] {
  const corrected = new Map<string, Segment>();
  for (const event of events) {
    if (event.type === "DartCorrected") corrected.set(event.dartId, event.segment);
  }

  const visits: RawVisit[] = [];
  const open = () => {
    const last = visits.at(-1);
    if (last && !last.closed) return last;
    const visit: RawVisit = { darts: [], closed: false };
    visits.push(visit);
    return visit;
  };
  for (const event of events) {
    switch (event.type) {
      case "DartThrown":
        open().darts.push({
          dartId: event.dartId,
          segment: corrected.get(event.dartId) ?? event.segment,
        });
        break;
      case "TakeoutFinished":
      case "VisitEndedManually":
        open().closed = true;
        break;
      case "VisitUndone":
        // Drops the visit in progress if it has darts, otherwise the last finished one.
        visits.pop();
        break;
    }
  }
  return visits;
}

export function matchState(settings: X01Settings, events: MatchEvent[]): MatchState {
  if (settings.rulesVersion !== RULES_VERSION) {
    throw new Error(`unknown X01 rules version ${settings.rulesVersion}`);
  }
  if (gameOf(settings) !== "x01") return gameState(settings, events);
  const startIndex = events.findIndex((e) => e.type === "MatchStarted");
  const started = events[startIndex];
  const inFromStart = settings.inRule === "straight";
  const player = (): PlayerState => ({
    remaining: settings.startScore,
    legsWon: 0,
    isIn: inFromStart,
  });
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
  const players = Array.from({ length: count }, player);
  const next = (p: PlayerIndex): PlayerIndex => (p + 1) % count;

  let currentPlayer: PlayerIndex = 0;
  let leg: LegView = { starter: currentPlayer, visits: [], winner: null };
  const legs = [leg];
  let currentVisit: VisitView | null = null;
  let visitOver = false;
  let winner: PlayerIndex | null = null;
  for (const raw of visitsOf(events.slice(startIndex + 1))) {
    const thrower = players[currentPlayer] as PlayerState;
    const visit = scoreVisit(raw, currentPlayer, thrower, settings);
    thrower.remaining = visit.remainingAfter;
    thrower.isIn = visit.isInAfter;
    visitOver = visit.over;
    if (visit.checkout) {
      thrower.legsWon += 1;
      leg.winner = currentPlayer;
      if (thrower.legsWon >= settings.legsToWin) winner = currentPlayer;
    }
    if (!raw.closed) {
      currentVisit = visit.view;
      continue;
    }

    leg.visits.push(visit.view);
    currentVisit = null;
    visitOver = false;
    if (winner !== null) break;
    if (leg.winner !== null) {
      for (const p of players) {
        p.remaining = settings.startScore;
        p.isIn = inFromStart;
      }
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

function getsIn(dart: Segment, inRule: InRule): boolean {
  switch (inRule) {
    case "straight":
      return true;
    case "double":
      return dart.multiplier === 2;
    case "master":
      return dart.multiplier >= 2;
    case "bull":
      return dart.number === 25 && dart.multiplier > 0;
  }
}

/** Multipliers a leg may be finished with; anything else reaching zero is a bust. */
const finishingMultipliers: Record<OutRule, readonly number[]> = {
  straight: [1, 2, 3],
  double: [2],
  master: [2, 3],
};

function isBust(remaining: number, lastDart: Segment, outRule: OutRule): boolean {
  if (remaining < 0) return true;
  // With double or master out, 1 can never be finished.
  if (remaining === 1 && outRule !== "straight") return true;
  return remaining === 0 && !finishingMultipliers[outRule].includes(lastDart.multiplier);
}

function scoreVisit(
  raw: RawVisit,
  player: PlayerIndex,
  before: PlayerState,
  settings: X01Settings,
) {
  const view: VisitView = { player, darts: [], bust: false, checkout: false };
  let remaining = before.remaining;
  let isIn = before.isIn;
  let over = false;
  for (const { dartId, segment } of raw.darts) {
    if (over) {
      view.darts.push({ dartId, segment, score: 0, ignored: true });
      continue;
    }
    isIn ||= getsIn(segment, settings.inRule);
    const score = isIn ? segment.number * segment.multiplier : 0;
    view.darts.push({ dartId, segment, score, ignored: false });
    remaining -= score;
    if (isBust(remaining, segment, settings.outRule)) {
      view.bust = true;
      remaining = before.remaining;
      isIn = before.isIn;
    } else if (remaining === 0) {
      view.checkout = true;
    }
    over = view.bust || view.checkout || view.darts.length === 3;
  }
  return { view, remainingAfter: remaining, isInAfter: isIn, over, checkout: view.checkout };
}
