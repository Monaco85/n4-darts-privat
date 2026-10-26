// A station: one board, at most one open match, and everyone watching it (GLOSSARY.md).
// Board events and station commands become events in the match's log; the match state is
// always derived from that log (docs/adr/0002).

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  defaultX01Settings,
  isSegment,
  MAX_PLAYERS,
  type MatchState,
  MIN_PLAYERS,
  matchState,
  RULES_VERSION,
  type Segment,
} from "@n4/engine";
import type { MatchSettingsInput, StationCommand, StationView } from "./api.ts";
import {
  type BoardEvent,
  type BoardThrow,
  type DetectedDart,
  type GatewayStats,
  toDetectedDart,
} from "./board/gateway.ts";
import type { Db, StoredEvent } from "./db.ts";
import { diagnostics } from "./diagnostics.ts";
import { matchPlayer } from "./players.ts";

export type { StationCommand, StationView };

/** The part of the board gateway a station needs to send commands. */
export interface BoardControl {
  reset(): Promise<void>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  calibrate?(): Promise<void>;
  /** How the board connection is doing, for /admin diagnostics. */
  stats?(): GatewayStats;
}

export type BoardAction = "start" | "stop" | "calibrate" | "reset";

export class CommandError extends Error {}

export interface Station {
  readonly id: number;
  view(): StationView;
  handleBoardEvent(event: BoardEvent): void;
  command(command: StationCommand): Promise<StationView>;
  /** Corrects a dart of the station's match; `admin` when the organiser does it from /admin. */
  correct(dartId: string, segment: Segment, source: "station" | "admin"): StationView;
  /** Puts a new match on the station, not yet started; throws if the station is busy. */
  assign(match: { playerIds: string[]; settings?: MatchSettingsInput | undefined }): StationView;
  /** Puts an existing match (a tournament match from the queue) on the station; throws if busy. */
  take(matchId: string): StationView;
  /** Sends the station's match back to the queue, if it hasn't started; true if it did. */
  release(): boolean;
  /** Forgets the station's match without touching the database, if it's this one and hasn't started. */
  drop(matchId: string): boolean;
  /** A line for the station page while it has no match, e.g. "Paused for the tournament". */
  setNotice(notice: string | null): void;
  subscribe(listener: (view: StationView) => void): () => void;
  /** Sends a command to the board; throws a `CommandError` the station page can show. */
  boardCommand(action: BoardAction): Promise<void>;
  /** The board connection's numbers, if the board reports them. */
  boardStats(): GatewayStats | null;
}

export function createStation(options: { id: number; db: Db; board: BoardControl }): Station {
  const { id, db, board } = options;
  const listeners = new Set<(view: StationView) => void>();

  let match = db.openMatchOn(id) ?? null;
  let events: StoredEvent[] = match ? db.events(match.id) : [];
  let boardOnline = false;
  let boardRunning = true;
  /** Whether the board's darts have been matched against the log since this process started. */
  let synced = false;
  /** Dart ids of the darts currently on the board, by the board's index (0–2). */
  let boardDarts: string[] = [];
  let notice: string | null = null;

  const state = () => (match ? matchState(match.settings, events) : null);

  function view(): StationView {
    const current = state();
    return {
      id,
      name: db.getStationConfig(id)?.name ?? `Station ${id}`,
      boardOnline,
      boardRunning,
      notice: match ? null : notice,
      match:
        match && current
          ? {
              id: match.id,
              players: match.playerIds.map((playerId) => matchPlayer(db, playerId)),
              settings: match.settings,
              state: current,
              label: match.label,
              dartCoords: visitCoords(current),
            }
          : null,
    };
  }

  /** Board positions of the current visit's darts, for the station's dartboard. */
  function visitCoords(current: MatchState): Record<string, { x: number; y: number }> {
    const ids = new Set((current.currentVisit?.darts ?? []).map((d) => d.dartId));
    const corrected = new Set(
      events.flatMap((e) => (e.type === "DartCorrected" ? [e.dartId] : [])),
    );
    const coords: Record<string, { x: number; y: number }> = {};
    for (const e of events) {
      if (e.type !== "DartThrown" || !ids.has(e.dartId) || corrected.has(e.dartId)) continue;
      const at = e.coords as { x: number; y: number } | undefined;
      if (at && !e.bouncer) coords[e.dartId] = { x: at.x, y: at.y };
    }
    return coords;
  }

  function notify() {
    const current = view();
    for (const listener of listeners) listener(current);
  }

  function append(event: StoredEvent) {
    if (!match) return;
    db.append(match.id, event);
    events.push(event);
    // Keep the recorded result in step with the log: a win can be undone or corrected away.
    const winner = state()?.winner ?? null;
    const winnerId = winner === null ? null : (match.playerIds[winner] ?? null);
    if (winnerId !== match.winner) {
      db.setWinner(match.id, winnerId);
      match.winner = winnerId;
    }
  }

  /** Checks a list of players for a match; throws a CommandError if it can't be played. */
  function checkPlayers(playerIds: string[]) {
    if (playerIds.length < MIN_PLAYERS || playerIds.length > MAX_PLAYERS) {
      throw new CommandError(`a match needs ${MIN_PLAYERS}–${MAX_PLAYERS} players`);
    }
    if (new Set(playerIds).size !== playerIds.length) {
      throw new CommandError("a player can only be in a match once");
    }
    for (const playerId of playerIds) {
      const player = db.getPlayer(playerId);
      if (!player) throw new CommandError("no such player");
      if (player.archived) throw new CommandError(`${player.name} is archived`);
    }
  }

  function assign(input: { playerIds: string[]; settings?: MatchSettingsInput | undefined }) {
    if (match) throw new CommandError("station already has a match; close it first");
    checkPlayers(input.playerIds);
    const settings = { ...defaultX01Settings, ...input.settings, rulesVersion: RULES_VERSION };
    if (!Number.isInteger(settings.startScore) || settings.startScore < 2) {
      throw new CommandError("start score must be a whole number of at least 2");
    }
    if (!Number.isInteger(settings.legsToWin) || settings.legsToWin < 1) {
      throw new CommandError("legs to win must be a whole number of at least 1");
    }
    const matchId = randomUUID();
    db.createMatch({ id: matchId, station: id, settings, playerIds: [...input.playerIds] });
    match = db.getMatch(matchId) ?? null;
    events = [];
    notify();
    return view();
  }

  function correct(dartId: string, segment: Segment, source: "station" | "admin") {
    if (!match) throw new CommandError("no match on this station");
    append({ type: "DartCorrected", dartId, segment, source });
    notify();
    return view();
  }

  function take(matchId: string) {
    if (match) throw new CommandError("station already has a match; close it first");
    const next = db.getMatch(matchId);
    if (!next || next.closedAt) throw new CommandError("no such open match");
    db.setStation(matchId, id);
    match = { ...next, station: id };
    events = db.events(matchId);
    notify();
    return view();
  }

  function release() {
    if (!match || state()?.phase !== "notStarted") return false;
    db.setStation(match.id, null);
    clearMatch();
    notify();
    return true;
  }

  function drop(matchId: string) {
    if (match?.id !== matchId || state()?.phase !== "notStarted") return false;
    clearMatch();
    notify();
    return true;
  }

  function setNotice(next: string | null) {
    if (next === notice) return;
    notice = next;
    if (!match) notify();
  }

  function clearMatch() {
    match = null;
    events = [];
    boardDarts = [];
  }

  /** Darts count while a match is being played; strays are ignored (docs/architecture.md). */
  function acceptingDarts() {
    const phase = state()?.phase;
    return phase === "throwing" || phase === "awaitingTakeout";
  }

  function recordDart({ index, segment, name, coords, bouncer }: DetectedDart) {
    const dartId = randomUUID();
    boardDarts[index] = dartId;
    append({ type: "DartThrown", dartId, segment, name, coords, bouncer });
  }

  /**
   * After a server restart the log and the board may disagree: darts may have been thrown, or
   * pulled, while nobody was listening. Brings the log in line with what's on the board.
   */
  function syncWithBoard(throws: BoardThrow[]) {
    synced = true;
    if (!acceptingDarts()) return;
    // A board dart is a logged one if it sits at exactly the recorded coordinates. Darts added by
    // hand have none: the board never saw them, so they're not expected on it.
    const coordsOf = new Map(
      events.flatMap((e) =>
        e.type === "DartThrown" && e.coords
          ? [[e.dartId, e.coords as BoardThrow["coords"]] as const]
          : [],
      ),
    );
    const logged = (state()?.currentVisit?.darts ?? []).filter((d) => coordsOf.has(d.dartId));
    const stillOnBoard = logged.every((dart, i) => {
      const recorded = coordsOf.get(dart.dartId);
      const now = throws[i]?.coords;
      return recorded && now && recorded.x === now.x && recorded.y === now.y;
    });
    if (!stillOnBoard) {
      // The logged visit's darts were pulled while we were away.
      append({ type: "TakeoutFinished" });
      for (const [i, t] of throws.entries()) recordDart(toDetectedDart(i, t));
      return;
    }
    boardDarts = logged.map((d) => d.dartId);
    for (let i = logged.length; i < throws.length; i++) {
      recordDart(toDetectedDart(i, throws[i] as BoardThrow));
    }
  }

  /** Resets we asked for whose `BoardReset` hasn't come back yet. */
  let ownResets = 0;

  async function resetBoard() {
    boardDarts = [];
    ownResets += 1;
    await board.reset().catch(() => {
      // Board offline: it'll be out of sync until the next takeout; nothing better to do here.
      ownResets = Math.max(0, ownResets - 1);
    });
  }

  function applyBoardEvent(event: BoardEvent) {
    switch (event.type) {
      case "BoardOnline":
        boardOnline = true;
        boardRunning = event.snapshot.running;
        if (!synced) syncWithBoard(event.snapshot.throws ?? []);
        break;
      case "BoardOffline":
        boardOnline = false;
        // A reset we sent may never be answered now.
        ownResets = 0;
        break;
      case "DartDetected":
        if (!acceptingDarts()) return;
        recordDart(event);
        break;
      case "DartRevised": {
        const dartId = boardDarts[event.index];
        if (!dartId || !acceptingDarts()) return;
        append({ type: "DartCorrected", dartId, segment: event.segment, source: "board" });
        break;
      }
      case "TakeoutFinished": {
        boardDarts = [];
        const current = state();
        // A visit without darts doesn't end: that would skip the player. Also close the winning
        // visit, so it lands in the leg history.
        if (
          current?.currentVisit?.darts.length &&
          (acceptingDarts() || current.phase === "matchWon")
        ) {
          append({ type: "TakeoutFinished" });
        }
        break;
      }
      case "BoardStarted":
      case "BoardStopped":
        boardRunning = event.type === "BoardStarted";
        break;
      case "BoardReset":
        boardDarts = [];
        if (ownResets > 0) {
          ownResets -= 1;
          return;
        }
        // Pressed on the laptop. The logged darts stand (players-and-matches spec). Mid-visit the
        // visit carries on with the next darts; a finished visit ends here, because the board is
        // clear and won't see a takeout, and the next player's darts must count.
        if (state()?.phase !== "awaitingTakeout") return;
        append({ type: "TakeoutFinished", source: "reset" });
        break;
      default:
        return;
    }
    notify();
  }

  function handleBoardEvent(event: BoardEvent) {
    const before = events.length;
    applyBoardEvent(event);
    // A recorded dart has reached the station's streams now (notify writes to them).
    if (event.type === "DartDetected" && event.receivedAt !== undefined && events.length > before) {
      diagnostics.dart(id, event.name, performance.now() - event.receivedAt);
    }
  }

  async function command(cmd: StationCommand): Promise<StationView> {
    switch (cmd.type) {
      case "quickMatch":
        return assign({ playerIds: cmd.playerIds, settings: cmd.settings });
      case "setOrder": {
        if (!match || state()?.phase !== "notStarted") {
          throw new CommandError("the order can only change before the match starts");
        }
        const same =
          cmd.playerIds.length === match.playerIds.length &&
          [...cmd.playerIds].sort().join() === [...match.playerIds].sort().join();
        if (!same) throw new CommandError("the order has to contain the match's players");
        db.setOrder(match.id, cmd.playerIds);
        match.playerIds = [...cmd.playerIds];
        break;
      }
      case "startMatch":
        if (!match) throw new CommandError("no match on this station");
        if (state()?.phase !== "notStarted")
          throw new CommandError("the match has already started");
        // Clear the board first, so leftover darts can't count for the new match.
        await resetBoard();
        append({ type: "MatchStarted", playerCount: match.playerIds.length });
        break;
      case "correctDart":
        if (!isSegment(cmd.segment)) throw new CommandError("not a valid segment");
        return correct(cmd.dartId, cmd.segment, "station");
      case "addDart": {
        if (!isSegment(cmd.segment)) throw new CommandError("not a valid segment");
        const current = state();
        if (current?.phase !== "throwing" || (current.currentVisit?.darts.length ?? 0) >= 3) {
          throw new CommandError("a dart can only be added while a visit has fewer than 3");
        }
        // Not on the board, so not in `boardDarts`: the board's own darts keep their indexes.
        append({
          type: "DartThrown",
          dartId: randomUUID(),
          segment: cmd.segment,
          source: "manual",
        });
        break;
      }
      case "nextPlayer":
        if (!match) throw new CommandError("no match on this station");
        append({ type: "VisitEndedManually" });
        await resetBoard();
        break;
      case "undo":
        if (!match) throw new CommandError("no match on this station");
        append({ type: "VisitUndone" });
        // The undone darts may still be on the board; make it forget them so pulling them
        // doesn't end the visit.
        await resetBoard();
        break;
      case "closeMatch":
        if (!match) break;
        if (match.winner === null) {
          throw new CommandError("the match isn't won yet; abandon it to end it without a result");
        }
        db.closeMatch(match.id);
        clearMatch();
        break;
      case "abandonMatch":
        if (!match) break;
        if (state()?.phase !== "notStarted") db.closeMatch(match.id, { abandoned: true });
        // A tournament match goes back to the queue (an abandoned one is played again).
        else if (match.tournamentId) db.setStation(match.id, null);
        else db.deleteMatch(match.id);
        clearMatch();
        break;
    }
    notify();
    return view();
  }

  return {
    id,
    view,
    handleBoardEvent,
    command,
    correct,
    assign,
    take,
    release,
    drop,
    setNotice,
    boardStats: () => board.stats?.() ?? null,
    async boardCommand(action) {
      const send = action === "reset" ? board.reset : board[action];
      if (!send) throw new CommandError("this board can't do that");
      try {
        // A reset from the menu is like one pressed on the laptop: it isn't counted as our own,
        // so a visit waiting for takeout ends (the cleared board won't see one).
        await send.call(board);
      } catch {
        throw new CommandError(
          action === "calibrate"
            ? "Calibration failed: the board didn't answer"
            : "The board didn't answer",
        );
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
