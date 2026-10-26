// Types shared with the web app. Type-only: nothing here may pull in Node modules.

import type { MatchState, Segment, X01Settings } from "@n4/engine";
import type { TableRow } from "./tournament/groups.ts";
import type { Placing, TournamentConfig } from "./tournament/types.ts";

export type { Placing, TableRow, TournamentConfig };

export interface MatchPlayer {
  id: string;
  name: string;
  /** Photo version, see `Player.photo`. */
  photo: string | null;
}

export interface MatchView {
  id: string;
  /** In throwing order: index = the engine's `PlayerIndex`. */
  players: MatchPlayer[];
  settings: X01Settings;
  state: MatchState;
  /** For tournament matches, e.g. "Group A · match 4". */
  label: string | null;
  /**
   * Where the board saw each dart of the current visit (normalised board coordinates, bull at
   * 0,0, y toward 20), by dart id. Corrected, added and bounced darts have none.
   */
  dartCoords?: Record<string, { x: number; y: number }>;
}

/** A match as listed in /admin history. */
export interface MatchSummary {
  id: string;
  station: number | null;
  players: MatchPlayer[];
  settings: X01Settings;
  /** Player id; null while unfinished, when abandoned, or after a correction took the win away. */
  winner: string | null;
  abandoned: boolean;
  closedAt: string | null;
  /** Legs won per player, in throwing order. */
  legsWon: number[];
}

/** A match with every leg and visit, for /admin. */
export interface MatchDetail extends MatchSummary {
  state: MatchState;
  /** What the board first detected, for every dart that was corrected since. */
  originals: Record<string, Segment>;
  /** Darts the board missed that were added by hand on the station. */
  added: string[];
}

export interface StationView {
  id: number;
  name: string;
  boardOnline: boolean;
  /** Detection is running; false after a stop (from the station's menu or the laptop). */
  boardRunning: boolean;
  /** Shown while there's no match, e.g. "Paused for the tournament". */
  notice: string | null;
  match: MatchView | null;
}

export interface Player {
  id: string;
  name: string;
  /** Hidden from pickers; their history stays. */
  archived: boolean;
  /** Version of the player's photo (for `/api/players/:id/photo?v=`); null without one. */
  photo: string | null;
}

/** What the database needs to add or change a player; the photo is managed on its own. */
export type PlayerInput = Omit<Player, "photo">;

/** A station as /admin manages it. */
export interface StationAdminView {
  id: number;
  name: string;
  boardUrl: string;
  boardOnline: boolean;
  boardRunning: boolean;
  /** Has a match (set up or running); can't be removed until it's closed. */
  busy: boolean;
}

/** A player as /admin lists them. */
export interface AdminPlayer extends Player {
  /** 3-dart average over the last 10 completed matches; null for an unseeded player. */
  rating: number | null;
}

export interface AdminSession {
  /** False when the server has no `ADMIN_PIN`: /admin is open. */
  pinRequired: boolean;
  authenticated: boolean;
}

export type StationCommand =
  /** Sets up a match on the station; it starts with `startMatch`. */
  | { type: "quickMatch"; playerIds: string[]; settings?: MatchSettingsInput }
  /** Reorders the players of a match that hasn't started; the first one starts leg 1. */
  | { type: "setOrder"; playerIds: string[] }
  | { type: "startMatch" }
  | { type: "correctDart"; dartId: string; segment: Segment }
  /** Adds a dart the board missed as the visit's next dart. */
  | { type: "addDart"; segment: Segment }
  | { type: "nextPlayer" }
  | { type: "undo" }
  /** Frees the station after the match is won. */
  | { type: "closeMatch" }
  /** Ends the match without a result; one that never started is removed altogether. */
  | { type: "abandonMatch" };

/** What can be chosen when setting up a match; the rules version is always the current one. */
export type MatchSettingsInput = Partial<Omit<X01Settings, "rulesVersion">>;

export interface TournamentEntrantView {
  playerId: string;
  name: string;
  /** 0 = top seed. */
  seed: number;
  group: number;
  withdrawn: boolean;
  photo: string | null;
  rating: number | null;
}

/** The active tournament as /admin shows it. */
export interface TournamentAdminView {
  tournament: {
    id: string;
    name: string;
    status: "draft" | "running" | "finished";
    config: TournamentConfig;
    startedAt: string | null;
    finishedAt: string | null;
  } | null;
  /** In seed order. */
  entrants: TournamentEntrantView[];
  /** Player ids per group. */
  groups: string[][];
  /** Whole tournament (draft) or what's left of it (running), in minutes. */
  estimateMinutes: number | null;
  /** Why it can't start yet; empty when it can. */
  problems: string[];
  /** Once started. */
  progress: TournamentProgress | null;
}

export interface TournamentMatchView {
  matchId: string | null;
  slot: string;
  label: string;
  /** Names; null while a knockout slot waits for an earlier result. */
  players: [string | null, string | null];
  /** The same players with their photos, for avatars. */
  sides: [MatchPlayer | null, MatchPlayer | null];
  /** Legs won, once played. */
  legs: [number, number] | null;
  winner: string | null;
  status: "waiting" | "queued" | "on-station" | "playing" | "played" | "walkover";
  station: number | null;
}

export interface QueueEntryView {
  matchId: string;
  label: string;
  players: MatchPlayer[];
  /** Both players free. */
  ready: boolean;
  held: boolean;
  pinnedStation: number | null;
}

export interface TournamentStationView {
  id: number;
  name: string;
  boardOnline: boolean;
  paused: boolean;
  match: {
    id: string;
    label: string | null;
    players: string[];
    started: boolean;
    /** E.g. "Ann 121 · Bob 301", "Ann won". */
    summary: string;
  } | null;
}

export interface TournamentProgress {
  phase: "groups" | "knockout" | "finished";
  played: number;
  total: number;
  /** ISO time; null once finished. */
  expectedEnd: string | null;
  stations: TournamentStationView[];
  queue: QueueEntryView[];
  groups: {
    name: string;
    table: (TableRow & { name: string; photo: string | null })[];
    fixtures: TournamentMatchView[];
  }[];
  /** Knockout rounds, in order, once the groups are done. */
  bracket: {
    section: "winners" | "losers" | "final";
    name: string;
    matches: TournamentMatchView[];
  }[];
  placings: (MatchPlayer & { from: number; to: number })[] | null;
  /** The evening's awards, once finished with a champion; categories nobody scored in are left out. */
  awards: Award[] | null;
  /** Ended by the organiser before a champion. */
  endedEarly: boolean;
}

export interface Award {
  kind: "bestAverage" | "highestCheckout" | "most180s" | "bestLeg";
  /** The 3-dart average, the checkout, the number of 180s, or the darts in the leg. */
  value: number;
  /** Names; more than one on a tie. */
  players: string[];
}

/** A station's match in short, for the projector. */
export interface ScoreCard {
  matchId: string;
  label: string | null;
  /** In throwing order. */
  players: (MatchPlayer & { legsWon: number; remaining: number })[];
  legsToWin: number;
  startScore: number;
  phase: MatchState["phase"];
  /** Whose visit it is, while the match is on. */
  throwing: number | null;
  /** The darts of the visit in progress. */
  visit: { segment: Segment; score: number; ignored: boolean }[];
  winner: number | null;
}

export interface DisplayStation {
  id: number;
  name: string;
  boardOnline: boolean;
  paused: boolean;
  match: ScoreCard | null;
}

/** What /display shows: the running or just finished tournament, or just the stations. */
export interface DisplayView {
  tournament: {
    name: string;
    phase: TournamentProgress["phase"];
    played: number;
    total: number;
    endedEarly: boolean;
  } | null;
  stations: DisplayStation[];
  /** The next queued matches. */
  upNext: { label: string; players: MatchPlayer[] }[];
  groups: TournamentProgress["groups"];
  bracket: TournamentProgress["bracket"];
  placings: TournamentProgress["placings"];
  awards: TournamentProgress["awards"];
  /** The leaderboard's top 10, while there's no tournament. */
  leaderboard: LeaderboardRow[];
}

/** A player's long-term numbers over their counted matches. */
export interface StatTotals {
  matches: number;
  matchesWon: number;
  legs: number;
  legsWon: number;
  average: number | null;
  first9Average: number | null;
  /** Share of darts at a one-dart finish that finished, in double-out matches; null without any. */
  checkoutPercent: number | null;
  checkoutAttempts: number;
  highestCheckout: number | null;
  /** Fewest darts in a won leg. */
  bestLeg: number | null;
  s180: number;
  s140: number;
  s100: number;
}

export interface LeaderboardRow {
  playerId: string;
  name: string;
  photo: string | null;
  /** 3-dart average over the last 10 counted matches. */
  rating: number | null;
  average: number | null;
  matches: number;
  matchesWon: number;
  s180: number;
  highestCheckout: number | null;
}

export interface PlayerProfile {
  playerId: string;
  name: string;
  photo: string | null;
  rating: number | null;
  /** Position on the leaderboard; null without a counted match. */
  rank: number | null;
  /** The day (YYYY-MM-DD) of the first counted match. */
  since: string | null;
  totals: StatTotals;
  /** One entry per day played (an evening past midnight counts to the day it started), oldest first. */
  evenings: { day: string; average: number | null; matches: number }[];
  /** Finished tournaments the player was in, newest first. */
  tournaments: { id: string; name: string; date: string; from: number; to: number }[];
  tournamentsWon: number;
  /** The best finish, and the (latest) tournament it was in. */
  bestPlacing: { from: number; to: number; tournament: string } | null;
  /**
   * Where the player's last 500 board-detected darts landed, newest first: normalised board
   * coordinates (bull ≈ (0,0), double ring ≈ radius 0.95, `y` toward 20; misses beyond 1).
   */
  heatmap: { x: number; y: number }[];
  /** The last 20 counted matches, newest first. */
  recent: {
    matchId: string;
    date: string;
    opponents: string[];
    won: boolean;
    legsFor: number;
    /** The best opponent's legs. */
    legsAgainst: number;
    average: number | null;
  }[];
}

/** What a live stream shows, for /admin diagnostics. */
export type StreamKind =
  | "station"
  | "watch"
  | "display"
  | "admin tournament"
  | "stations"
  | "admin stations"
  | "match detail";

/** One board connection, for /admin diagnostics. */
export interface BoardDiagnostics {
  station: number;
  name: string;
  online: boolean;
  /** Times the connection was opened again since the server started. */
  reconnects: number;
  /** Seconds since the board last sent anything; null if it never has. */
  sinceMessageSeconds: number | null;
  /** The last reset, start or stop sent to the board, and how long it took to answer. */
  lastCommand: { name: string; ms: number; ok: boolean; at: string } | null;
}

/** GET /api/admin/diagnostics: whether the server keeps up (diagnostics ticket). */
export interface DiagnosticsView {
  startedAt: string;
  /** How long the event loop was blocked, over the last minute (or the `seconds` measured so far). */
  eventLoop: { seconds: number; p50Ms: number; p99Ms: number; maxMs: number };
  streams: {
    kind: StreamKind;
    /** E.g. "Station 1" or a match id. */
    label: string | null;
    client: string;
    userAgent: string;
    openSeconds: number;
    updates: number;
  }[];
  /** Per kind of stream, how long computing its view took, over the last minute. */
  views: { kind: StreamKind; perMinute: number; averageMs: number | null; maxMs: number | null }[];
  database: { writesPerMinute: number; slowestMs: number | null; slowestWrite: string | null };
  boards: BoardDiagnostics[];
  /** The last 20 darts: from the board's message to the station's streams, newest first. */
  darts: { station: number; name: string; ms: number; at: string }[];
  /** This request: whether it came through a proxy. */
  request: {
    client: string;
    host: string | null;
    proxied: boolean;
    headers: Record<string, string>;
  };
}
