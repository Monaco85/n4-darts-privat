import {
  ATC_TARGETS,
  CRICKET_TARGETS,
  checkoutRoute,
  type DartView,
  gameOf,
  MAX_PLAYERS,
  MIN_PLAYERS,
  type PlayerIndex,
  type Segment,
  type X01Settings,
} from "@n4/engine";
import type { MatchView, StationCommand } from "@n4/server/api";
import { Fragment, type ReactNode, useState } from "react";
import { Avatar } from "./Avatar.tsx";
import { BoardMenu, type MatchAction } from "./BoardMenu.tsx";
import { Dartboard } from "./Dartboard.tsx";
import { dartLabel } from "./darts.ts";
import { Logo } from "./Logo.tsx";
import {
  defaultSetupSettings,
  legsLabel,
  PlayerPicker,
  SettingsFields,
  type SetupSettings,
} from "./MatchSetup.tsx";
import { PixelIcon } from "./PixelIcon.tsx";
import { SegmentPicker } from "./SegmentPicker.tsx";
import { useStation } from "./useStation.ts";

type Send = (command: StationCommand) => Promise<string | null>;

export function StationPage({ id }: { id: number }) {
  const { view, connected, send } = useStation(id);
  const [error, setError] = useState<string | null>(null);

  const run: Send = async (command) => {
    const message = await send(command);
    setError(message);
    return message;
  };

  const match = view?.match ?? null;
  return (
    <main className="station">
      <header className="station-bar">
        <div className="station-id">
          <Logo width="86px" className="wide-only" />
          <span className="station-name">{view?.name ?? `Station ${id}`}</span>
        </div>
        <BoardMenu
          stationId={id}
          online={view?.boardOnline ?? false}
          running={view?.boardRunning ?? true}
          connected={connected}
          matchAction={match ? matchAction(match, run) : undefined}
        />
      </header>
      {match && <SettingsStrip match={match} />}
      <div className="station-body">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!view ? (
          <p className="hint">Connecting…</p>
        ) : !match ? (
          <QuickMatch send={run} notice={view.notice} />
        ) : match.state.phase === "notStarted" ? (
          <Lineup match={match} send={run} />
        ) : (
          <Match match={match} send={run} />
        )}
      </div>
    </main>
  );
}

/** Ending the match, from the board menu; a tournament match is only held or sent back from /admin. */
function matchAction(match: MatchView, send: Send): MatchAction | undefined {
  const phase = match.state.phase;
  if (phase === "notStarted") {
    if (match.label) return undefined;
    return { label: "Cancel match", run: () => void send({ type: "abandonMatch" }) };
  }
  if (phase === "matchWon") return undefined;
  const question = match.label
    ? "End this match? It goes back in the queue and is played again."
    : "End this match without a result?";
  return {
    label: "End match",
    note: match.label ? "Goes back in the queue" : undefined,
    run: () => {
      if (confirm(question)) void send({ type: "abandonMatch" });
    },
  };
}

const IN_RULES = { straight: "", double: "Double in", master: "Master in", bull: "Bull in" };
const OUT_RULES = { straight: "Single out", double: "Double out", master: "Master out" };

/** "501 · Double in · Double out", "Cricket", "Elimination · 301". */
export function rulesLabel(settings: X01Settings) {
  switch (gameOf(settings)) {
    case "cricket":
      return "Cricket";
    case "atc":
      return "Around the World";
    case "elimination":
      return `Elimination · ${settings.startScore}`;
    default:
      return [settings.startScore, IN_RULES[settings.inRule], OUT_RULES[settings.outRule]]
        .filter(Boolean)
        .join(" · ");
  }
}

/** The match label, rules, legs and which leg: "Group A … 501 · Double out · Best of 3 · Leg 2". */
function SettingsStrip({ match }: { match: MatchView }) {
  const { settings, state, label } = match;
  const legs = legsLabel(settings.legsToWin);
  const leg = settings.legsToWin > 1 && state.legs.length > 0 ? ` · Leg ${state.legs.length}` : "";
  return (
    <div className="settings-strip label">
      {label ? (
        <>
          <span className="settings-strip-label">{label}</span>
          <span>
            {rulesLabel(settings)} · {legs}
            {leg}
          </span>
        </>
      ) : (
        <>
          <span>{rulesLabel(settings)}</span>
          <span>
            {legs}
            {leg}
          </span>
        </>
      )}
    </div>
  );
}

/** Pick players from the list (or add one), choose settings, then go to the lineup. */
function QuickMatch({ send, notice }: { send: Send; notice: string | null }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [settings, setSettings] = useState<SetupSettings>(defaultSetupSettings);

  return (
    <div className="quick-match">
      {notice && <p className="notice">{notice}</p>}
      <section className="quick-match-players">
        <div>
          <h1>New match</h1>
          <p className="hint">
            Pick {MIN_PLAYERS}–{MAX_PLAYERS} players. You can change the order next.
          </p>
        </div>
        <PlayerPicker title="Players" picked={picked} onChange={setPicked} />
      </section>
      <section className="quick-match-settings">
        <span className="label">Match settings</span>
        <SettingsFields value={settings} onChange={setSettings} playerCount={picked.length} />
        <button
          type="button"
          className="primary cta"
          disabled={picked.length < MIN_PLAYERS}
          onClick={() => send({ type: "quickMatch", playerIds: picked, settings })}
        >
          Continue <PixelIcon name="arrow" height="0.9em" />
        </button>
      </section>
    </div>
  );
}

/** A match set up but not started: settle the throwing order, then start. */
function Lineup({ match, send }: { match: MatchView; send: Send }) {
  const ids = match.players.map((p) => p.id);
  const setOrder = (playerIds: string[]) => send({ type: "setOrder", playerIds });
  const move = (from: number, to: number) => {
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved as string);
    void setOrder(next);
  };
  const shuffle = () => {
    const next = [...ids];
    for (let i = next.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [next[i], next[j]] = [next[j] as string, next[i] as string];
    }
    void setOrder(next);
  };
  const { legsToWin } = match.settings;

  return (
    <div className="lineup">
      <div className="lineup-head">
        {match.label && <span className="match-label">{match.label}</span>}
        <h1>
          {match.players.length === 2
            ? match.players.map((p) => p.name).join(" vs ")
            : match.players.length === 1
              ? `${match.players[0]?.name} alone`
              : "Next match"}
        </h1>
        <p className="hint">
          {rulesLabel(match.settings)}, {legsLabel(legsToWin).toLowerCase()}.
          {match.players.length > 1 ? " Top of the list throws first." : " Solo practice."}
        </p>
      </div>
      <ol className="lineup-list">
        {match.players.map((p, i) => (
          <li key={p.id}>
            <span className="lineup-position">{String(i + 1).padStart(2, "0")}</span>
            <Avatar player={p} />
            <span className="lineup-name">{p.name}</span>
            <button
              type="button"
              aria-label={`Move ${p.name} up`}
              disabled={i === 0}
              onClick={() => move(i, i - 1)}
            >
              <PixelIcon name="up" />
            </button>
            <button
              type="button"
              aria-label={`Move ${p.name} down`}
              disabled={i === match.players.length - 1}
              onClick={() => move(i, i + 1)}
            >
              <PixelIcon name="down" />
            </button>
          </li>
        ))}
      </ol>
      <div className="controls">
        <button type="button" onClick={shuffle}>
          Shuffle
        </button>
        <button type="button" className="primary cta" onClick={() => send({ type: "startMatch" })}>
          Start <PixelIcon name="arrow" height="0.9em" />
        </button>
      </div>
    </div>
  );
}

/** Numbers to light on the board: the next target (Around the World) or the open ones (Cricket). */
function boardTargets(match: MatchView): number[] {
  const thrower = match.state.players[match.state.currentPlayer];
  if (!thrower || match.state.phase === "matchWon") return [];
  switch (gameOf(match.settings)) {
    case "atc":
      return thrower.remaining > 0 ? [thrower.remaining] : [];
    case "cricket":
      return CRICKET_TARGETS.filter((_, i) => (thrower.marks?.[i] ?? 0) < 3);
    default:
      return [];
  }
}

/** Who throws after the current visit: the next player, or the next leg's starter after a checkout. */
function upNext(match: MatchView): PlayerIndex {
  const { state, players } = match;
  const leg = state.legs.at(-1);
  const after = state.currentVisit?.checkout && leg ? leg.starter : state.currentPlayer;
  return (after + 1) % players.length;
}

function Match({ match, send }: { match: MatchView; send: Send }) {
  const [correcting, setCorrecting] = useState<DartView | null>(null);
  const [adding, setAdding] = useState(false);

  if (match.state.phase === "matchWon") {
    return (
      <MatchOver match={match}>
        <div className="controls">
          <button type="button" onClick={() => send({ type: "undo" })}>
            Undo
          </button>
          <button
            type="button"
            className="primary cta"
            onClick={() => send({ type: "closeMatch" })}
          >
            Done <PixelIcon name="arrow" height="0.9em" />
          </button>
        </div>
      </MatchOver>
    );
  }

  const visit = match.state.currentVisit;
  const dartIndex = correcting ? (visit?.darts.indexOf(correcting) ?? -1) : -1;
  const thrower = match.players[visit?.player ?? match.state.currentPlayer];
  return (
    <section className="match">
      <PlayerCards match={match} hints />
      <VisitPanel match={match} onDart={setCorrecting} onAdd={() => setAdding(true)} hints />

      <div className="match-stage">
        <div className="stage-board">
          <Dartboard
            darts={visit?.darts ?? []}
            coords={match.dartCoords ?? {}}
            highlight={boardTargets(match)}
            onDart={setCorrecting}
          />
        </div>
        <div className="match-actions">
          <button
            type="button"
            className="primary cta next-player"
            onClick={() => send({ type: "nextPlayer" })}
          >
            <span>
              Next player <PixelIcon name="arrow" height="0.9em" />
            </span>
            <span className="next-player-up">Up: {match.players[upNext(match)]?.name}</span>
          </button>
          <button type="button" onClick={() => send({ type: "undo" })}>
            Undo
          </button>
        </div>
      </div>

      {correcting && (
        <SegmentPicker
          title={`Correct ${dartLabel(correcting.segment)}`}
          context={[thrower?.name, dartIndex >= 0 ? `Dart ${dartIndex + 1}` : null]
            .filter(Boolean)
            .join(" · ")}
          current={correcting.segment}
          onCancel={() => setCorrecting(null)}
          onPick={(segment) => {
            setCorrecting(null);
            void send({ type: "correctDart", dartId: correcting.dartId, segment });
          }}
        />
      )}
      {adding && (
        <SegmentPicker
          title={`Add dart ${(visit?.darts.length ?? 0) + 1}`}
          context={[thrower?.name, "Missed by the board"].filter(Boolean).join(" · ")}
          onCancel={() => setAdding(false)}
          onPick={(segment) => {
            setAdding(false);
            void send({ type: "addDart", segment });
          }}
        />
      )}
    </section>
  );
}

/** "Game shot", the winner and the legs; `children` go below (the station's buttons). */
export function MatchOver({ match, children }: { match: MatchView; children?: ReactNode }) {
  const { state, players, settings } = match;
  const winner = state.winner ?? 0;
  const winnerPlayer = players[winner];
  return (
    <section className="match-over">
      <h1 className="game-shot">Game shot</h1>
      <div className="match-over-result">
        {winnerPlayer && (
          <span className="avatar-frame">
            <Avatar player={winnerPlayer} large />
          </span>
        )}
        <div className="match-over-text">
          <p className="match-over-winner">{winnerPlayer?.name ?? "?"} wins</p>
          {settings.legsToWin > 1 &&
            (players.length === 2 ? (
              <div className="legs-result">
                {state.players.map((p, i) => (
                  <Fragment key={players[i]?.id ?? i}>
                    {i > 0 && <span className="legs-dash">–</span>}
                    <div className={i === winner ? "won" : ""}>
                      <span className="legs-number">{p.legsWon}</span>
                      <span className="label">{players[i]?.name}</span>
                    </div>
                  </Fragment>
                ))}
              </div>
            ) : (
              <p className="label">{state.players[winner]?.legsWon} legs</p>
            ))}
        </div>
      </div>
      {children}
    </section>
  );
}

interface ScoreboardProps {
  match: MatchView;
  /** Darts can be tapped to correct them. */
  onDart?: (dart: DartView) => void;
  /** The next empty slot can be tapped to add a dart the board missed. */
  onAdd?: () => void;
  /** Show the thrower's checkout route on wide screens. */
  hints?: boolean;
}

/** Scores, the current visit and whose turn it is. */
export function Scoreboard(props: ScoreboardProps) {
  return (
    <>
      <PlayerCards match={props.match} hints={props.hints ?? false} />
      <VisitPanel {...props} />
    </>
  );
}

/** The route to finish this visit for the thrower, or null when there's none to show. */
function checkoutHint(match: MatchView): Segment[] | null {
  const { state, settings } = match;
  if (gameOf(settings) !== "x01") return null;
  const thrower = state.players[state.currentPlayer];
  if (state.phase !== "throwing" || !thrower?.isIn) return null;
  const thrown = state.currentVisit?.darts.filter((d) => !d.ignored).length ?? 0;
  return checkoutRoute(thrower.remaining, 3 - thrown, settings.outRule);
}

/** Points, darts and three-dart average over the whole match, per player. */
function averages(match: MatchView): (number | null)[] {
  const { state } = match;
  const points = state.players.map(() => 0);
  const darts = state.players.map(() => 0);
  const add = (visit: NonNullable<MatchView["state"]["currentVisit"]>) => {
    const counted = visit.darts.filter((d) => !d.ignored);
    darts[visit.player] = (darts[visit.player] ?? 0) + counted.length;
    if (!visit.bust) {
      points[visit.player] = (points[visit.player] ?? 0) + counted.reduce((n, d) => n + d.score, 0);
    }
  };
  for (const leg of state.legs) for (const visit of leg.visits) add(visit);
  if (state.currentVisit) add(state.currentVisit);
  return points.map((p, i) => (darts[i] ? (p / (darts[i] as number)) * 3 : null));
}

/** Where a player starts a leg: X01 counts down, the others count up from zero. */
function legStart(match: MatchView): number {
  return gameOf(match.settings) === "x01" ? match.settings.startScore : 0;
}

/**
 * This leg's visits for a player, newest first: what was scored and where that left them
 * (X01: left; Elimination and Cricket: total; Around the World: targets done).
 */
function legHistory(match: MatchView, player: PlayerIndex) {
  const leg = match.state.legs.at(-1);
  const down = gameOf(match.settings) === "x01";
  const at = match.players.map(() => legStart(match));
  const rows: { scored: string; left: number }[] = [];
  for (const visit of leg?.visits ?? []) {
    const scored = visit.darts.filter((d) => !d.ignored).reduce((n, d) => n + d.score, 0);
    const before = at[visit.player] ?? 0;
    if (!visit.bust) at[visit.player] = before + (down ? -scored : scored);
    if (visit.player === player) {
      rows.push({ scored: visit.bust ? "Bust" : String(scored), left: at[player] ?? 0 });
    }
    // Elimination: whoever this visit landed on goes back to zero.
    for (const out of visit.eliminated ?? []) {
      at[out] = 0;
      if (out === player) rows.push({ scored: "Out", left: 0 });
    }
  }
  return rows.reverse();
}

/** The headline number on a card: Around the World shows the target, Bull or done. */
function headline(match: MatchView, remaining: number): string {
  if (gameOf(match.settings) !== "atc") return String(remaining);
  if (remaining === 0) return "✓";
  return remaining === 25 ? "Bull" : String(remaining);
}

/** The line under the name: average, marks per round, progress or target. */
function metaLine(
  match: MatchView,
  player: MatchView["state"]["players"][number],
  average: number | null,
  last: string | undefined,
  marksPerRound: number | null,
): string {
  const fmt = (n: number | null, digits = 1) => (n === null ? "–" : n.toFixed(digits));
  switch (gameOf(match.settings)) {
    case "cricket":
      return `MPR ${fmt(marksPerRound, 2)}`;
    case "atc":
      return `${player.progress ?? 0} / ${ATC_TARGETS.length} done`;
    case "elimination":
      return `Target ${match.settings.startScore} · Ø ${fmt(average)}${last ? ` · Last ${last}` : ""}`;
    default:
      return `Ø ${fmt(average)}${last ? ` · Last ${last}` : ""}`;
  }
}

/** Cricket marks per round over the match, per player. */
function marksPerRound(match: MatchView): (number | null)[] {
  const { state } = match;
  const marks = state.players.map(() => 0);
  const darts = state.players.map(() => 0);
  const visits = state.legs.flatMap((leg) => leg.visits);
  if (state.currentVisit) visits.push(state.currentVisit);
  for (const visit of visits) {
    for (const d of visit.darts) {
      if (d.ignored) continue;
      darts[visit.player] = (darts[visit.player] ?? 0) + 1;
      marks[visit.player] = (marks[visit.player] ?? 0) + (d.marks ?? 0);
    }
  }
  return marks.map((m, i) => (darts[i] ? (m / (darts[i] as number)) * 3 : null));
}

/** One cricket mark count drawn as on a chalkboard: /, X, or a circled X when closed. */
function Mark({ count }: { count: number }) {
  if (count <= 0) return <span className="mark empty" />;
  return (
    <svg className={`mark m${Math.min(count, 3)}`} viewBox="0 0 20 20" aria-hidden="true">
      <line x1="4" y1="16" x2="16" y2="4" />
      {count >= 2 && <line x1="4" y1="4" x2="16" y2="16" />}
      {count >= 3 && <circle cx="10" cy="10" r="8" />}
    </svg>
  );
}

/** Around the World: 1 to 20 and the bull, done ones lit. */
function AtcProgress({ done }: { done: number }) {
  return (
    <ol className="atc-progress" aria-label={`${done} of ${ATC_TARGETS.length} done`}>
      {ATC_TARGETS.map((n, i) => (
        <li key={n} className={i < done ? "done" : i === done ? "next" : undefined}>
          {n === 25 ? "B" : n}
        </li>
      ))}
    </ol>
  );
}

/** A player's cricket marks: one row per number, 20 down to the bull. */
function CricketMarks({ marks }: { marks: number[] }) {
  return (
    <ol className="cricket-marks" aria-label="Marks">
      {CRICKET_TARGETS.map((n, i) => (
        <li key={n} className={(marks[i] ?? 0) >= 3 ? "closed" : undefined}>
          <span>{n === 25 ? "B" : n}</span>
          <Mark count={marks[i] ?? 0} />
        </li>
      ))}
    </ol>
  );
}

/**
 * A card per player: the score big, name and legs below, the average, and this leg's visits
 * beside it; the thrower's card lit. With `hints`, the thrower's card shows the checkout route.
 */
export function PlayerCards({ match, hints = false }: { match: MatchView; hints?: boolean }) {
  const { state, players, settings } = match;
  const game = gameOf(settings);
  const route = hints ? checkoutHint(match) : null;
  const avg = averages(match);
  const mpr = game === "cricket" ? marksPerRound(match) : [];
  const size = players.length > 2 ? "many" : players.length === 1 ? "solo" : "";

  return (
    <div className={`scoreboard ${size} game-${game}`}>
      {state.players.map((player, p) => {
        const active = state.currentPlayer === p;
        const history = legHistory(match, p);
        const average = avg[p] ?? null;
        return (
          <div key={players[p]?.id ?? p} className={`player ${active ? "active" : ""}`}>
            <div className="player-main">
              <div className="remaining">{headline(match, player.remaining)}</div>
              <div className="player-id">
                {settings.legsToWin > 1 && <span className="legs-badge">{player.legsWon}</span>}
                {players[p] && <Avatar player={players[p]} />}
                <span className="player-name">{players[p]?.name ?? "?"}</span>
              </div>
              <div className="player-meta">
                {!player.isIn ? (
                  <span className="not-in">Not in</span>
                ) : (
                  metaLine(match, player, average, history[0]?.scored, mpr[p] ?? null)
                )}
              </div>
              {hints && (
                <div className="checkout wide-only">
                  {(active ? (route ?? []) : []).map((segment, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a route can repeat a field (T20 T20 Bull).
                    <span key={i} className={i === 0 ? "checkout-next" : undefined}>
                      {dartLabel(segment)}
                    </span>
                  ))}
                </div>
              )}
            </div>
            {game === "cricket" ? (
              <CricketMarks marks={player.marks ?? []} />
            ) : game === "atc" ? (
              <AtcProgress done={player.progress ?? 0} />
            ) : (
              <ol className="player-history wide-only" aria-label="This leg">
                <li className="history-start">
                  <span />
                  <span>{legStart(match)}</span>
                </li>
                {[...history].reverse().map((row, i) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: visits have no id; order is fixed.
                    key={i}
                    className={row.scored === "Bust" || row.scored === "Out" ? "bust" : undefined}
                  >
                    <span>{row.scored}</span>
                    <span>{row.left}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The visit in progress: three dart tiles, the total or bust, and what happens next. */
function VisitPanel(props: ScoreboardProps) {
  const { match, onDart, onAdd } = props;
  const { state, players } = match;
  const visit = state.currentVisit;
  const visitTotal = visit?.bust ? 0 : (visit?.darts.reduce((sum, d) => sum + d.score, 0) ?? 0);
  const nameOf = (player: PlayerIndex) => players[player]?.name ?? "?";
  // The dart that broke the visit, shown in red.
  const bustDart = visit?.bust ? visit.darts.findLast((d) => !d.ignored) : undefined;
  // The rest of the checkout route fills the empty slots, as a suggestion.
  const route = props.hints ? (checkoutHint(match) ?? []) : [];
  const thrown = visit?.darts.length ?? 0;

  return (
    <section className={`visit ${visit?.bust ? "bust" : ""}`} aria-label="Current visit">
      <div className="visit-head label">
        <span>
          Visit · {nameOf(visit?.player ?? state.currentPlayer)}
          {visit && onDart && <span className="wide-only"> · Tap a dart to correct it</span>}
        </span>
        {visit?.bust ? (
          <span className="visit-bust">Bust</span>
        ) : (
          <span>
            Total <span className="visit-total">{visit ? visitTotal : ""}</span>
          </span>
        )}
      </div>
      <div className="darts">
        {[0, 1, 2].map((i) => {
          const dart = visit?.darts[i];
          if (!dart && onAdd && state.phase === "throwing" && i === thrown) {
            const suggestion = route[0];
            return (
              <button
                type="button"
                key={`add-${i}`}
                className={`dart add ${suggestion ? "suggested" : ""}`}
                onClick={onAdd}
                aria-label={`Add dart ${i + 1}`}
              >
                <span className="dart-index label">D{i + 1}</span>
                {suggestion && <span className="dart-label">{dartLabel(suggestion)}</span>}
                <span className="dart-add label">+ Add</span>
              </button>
            );
          }
          if (!dart) {
            const suggestion = route[i - thrown];
            return (
              <span key={`empty-${i}`} className={`dart empty ${suggestion ? "suggested" : ""}`}>
                <span className="dart-index label">D{i + 1}</span>
                {suggestion && <span className="dart-label">{dartLabel(suggestion)}</span>}
              </span>
            );
          }
          const className = `dart ${dart.ignored ? "ignored" : ""} ${dart === bustDart ? "busted" : ""}`;
          const content = (
            <>
              <span className="dart-index label">{dart.ignored ? "Ignored" : `D${i + 1}`}</span>
              <span className="dart-label">{dartLabel(dart.segment)}</span>
            </>
          );
          return onDart ? (
            <button
              type="button"
              key={dart.dartId}
              className={className}
              onClick={() => onDart(dart)}
              aria-label={`Correct dart ${i + 1}: ${dartLabel(dart.segment)}`}
            >
              {content}
            </button>
          ) : (
            <span key={dart.dartId} className={className}>
              {content}
            </span>
          );
        })}
      </div>
      {state.phase === "awaitingTakeout" ? (
        <p className="visit-status" role="status">
          Remove darts
        </p>
      ) : (
        <p className="visit-status waiting">{nameOf(state.currentPlayer)} to throw</p>
      )}
      {visit && onDart && <p className="label narrow-only">Tap a dart to correct it</p>}
    </section>
  );
}
