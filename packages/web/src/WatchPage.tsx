import type { MatchView } from "@n4/server/api";
import { Avatar } from "./Avatar.tsx";
import { dartLabel } from "./darts.ts";
import { Logo } from "./Logo.tsx";
import { legsLabel } from "./MatchSetup.tsx";
import { MatchOver, PlayerCards, rulesLabel } from "./StationPage.tsx";
import { useStation } from "./useStation.ts";

/** A station's scoreboard for a TV or the projector: live, with nothing to press. */
export function WatchPage({ id }: { id: number }) {
  const { view, connected } = useStation(id, { watch: true });
  const match = view?.match;

  return (
    <main className="watch">
      <header className="watch-bar">
        <div className="watch-id">
          <Logo width="3em" />
          <span className="watch-name">{view?.name ?? `Station ${id}`}</span>
          {match?.label && <span className="watch-label">· {match.label}</span>}
        </div>
        {!connected ? (
          <span className="status danger">Server offline</span>
        ) : (
          match && match.state.phase !== "notStarted" && <MatchLine match={match} />
        )}
      </header>
      {!view ? (
        <p className="watch-note">Connecting…</p>
      ) : !match ? (
        <p className="watch-note">{view.notice ?? "Free"}</p>
      ) : match.state.phase === "notStarted" ? (
        <NextMatch match={match} />
      ) : match.state.phase === "matchWon" ? (
        <MatchOver match={match} />
      ) : (
        <div className="watch-match">
          <PlayerCards match={match} />
          <WatchVisit match={match} />
        </div>
      )}
    </main>
  );
}

/** "501 · Best of 3 · Leg 2" */
function MatchLine({ match }: { match: MatchView }) {
  const { settings, state } = match;
  return (
    <span className="watch-line">
      {rulesLabel(settings)} · {legsLabel(settings.legsToWin)}
      {settings.legsToWin > 1 && (
        <>
          {" "}
          · Leg <span className="watch-line-leg">{state.legs.length}</span>
        </>
      )}
    </span>
  );
}

function NextMatch({ match }: { match: MatchView }) {
  return (
    <div className="watch-next">
      <span className="watch-next-title">Next</span>
      <div className="watch-next-players">
        {match.players.map((p, i) => (
          <div key={p.id} className="watch-next-player">
            {i > 0 && <span className="watch-vs">vs</span>}
            <div>
              <Avatar player={p} large />
              <span>{p.name}</span>
            </div>
          </div>
        ))}
      </div>
      <span className="label">
        {rulesLabel(match.settings)} · {legsLabel(match.settings.legsToWin)} · Waiting to start
      </span>
    </div>
  );
}

/** The visit in one row: who, three darts, the total. */
function WatchVisit({ match }: { match: MatchView }) {
  const { state, players } = match;
  const visit = state.currentVisit;
  const thrower = players[visit?.player ?? state.currentPlayer]?.name ?? "?";
  const total = visit?.bust ? 0 : (visit?.darts.reduce((sum, d) => sum + d.score, 0) ?? 0);
  // The next dart's slot blinks a cursor while the thrower is at the board.
  const next = state.phase === "throwing" ? (visit?.darts.length ?? 0) : -1;
  return (
    <section className={`watch-visit ${visit?.bust ? "bust" : ""}`} aria-label="Current visit">
      <span className="watch-visit-who label">
        Visit
        <br />
        <span>{thrower}</span>
      </span>
      <div className="watch-darts">
        {[0, 1, 2].map((i) => {
          const dart = visit?.darts[i];
          return (
            <span
              key={dart?.dartId ?? `slot-${i}`}
              className={`watch-dart ${dart ? (dart.ignored ? "ignored" : "") : i === next ? "next" : "empty"}`}
            >
              {dart ? dartLabel(dart.segment) : i === next ? "_" : ""}
            </span>
          );
        })}
      </div>
      <div className="watch-visit-total">
        <span className="label">{visit?.bust ? "" : "Total"}</span>
        <span className={visit?.bust ? "watch-bust" : "watch-total"}>
          {visit?.bust ? "Bust" : String(total).padStart(3, "0")}
        </span>
        <span className="label watch-status">
          {state.phase === "awaitingTakeout" ? "Remove darts" : `${thrower} to throw`}
        </span>
      </div>
    </section>
  );
}
