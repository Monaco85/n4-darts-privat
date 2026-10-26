import type { DartView } from "@n4/engine";
import type { MatchDetail, MatchSummary } from "@n4/server/api";
import { useEffect, useState } from "react";
import { dartLabel } from "./darts.ts";
import { legsLabel } from "./MatchSetup.tsx";
import { PixelIcon } from "./PixelIcon.tsx";
import { SegmentPicker } from "./SegmentPicker.tsx";
import { rulesLabel } from "./StationPage.tsx";
import { useLive } from "./useLive.ts";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";

function result(match: MatchSummary) {
  if (match.abandoned) return "Abandoned";
  const winner = match.players.find((p) => p.id === match.winner);
  if (!winner) return match.closedAt ? "No winner (corrected)" : "In progress";
  const legs = match.settings.legsToWin > 1 ? ` ${match.legsWon.join("–")}` : "";
  return `${winner.name} won${legs}`;
}

export function MatchHistory({ onOpen }: { onOpen(id: string): void }) {
  const [matches, setMatches] = useState<MatchSummary[] | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/admin/matches").catch(() => null);
      if (res?.ok) setMatches(await res.json());
    })();
  }, []);

  if (!matches) return <p className="hint">Loading…</p>;
  if (matches.length === 0) return <p className="hint">No finished matches yet.</p>;
  return (
    <div className="history table-panel">
      <div className="history-head label">
        <span>Players</span>
        <span>Result</span>
        <span>When</span>
      </div>
      <ul className="history-list">
        {matches.map((m) => (
          <li key={m.id}>
            <button type="button" onClick={() => onOpen(m.id)}>
              <span className="history-players">{m.players.map((p) => p.name).join(" vs ")}</span>
              <span className={`history-result ${m.abandoned || !m.winner ? "muted" : ""}`}>
                {result(m)}
              </span>
              <span className="history-when">{when(m.closedAt)}</span>
              <PixelIcon name="arrow" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MatchDetailView({ id, onBack }: { id: string; onBack(): void }) {
  const live = useLive<MatchDetail>(`/api/admin/matches/${id}/live`);
  const match = live.view;
  const [error, setError] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<DartView | null>(null);

  const correct = async (dartId: string, segment: DartView["segment"]) => {
    const res = await fetch(`/api/admin/matches/${id}/corrections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dartId, segment }),
    }).catch(() => null);
    if (!res) return setError("Server not reachable");
    if (!res.ok) {
      // E.g. a tournament result a later match already depends on.
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return setError(body.error ?? "Correction failed");
    }
    setError(null); // The corrected match arrives through the live stream.
  };

  const name = (i: number) => match?.players[i]?.name ?? "?";

  return (
    <div className="match-detail">
      <button type="button" className="back" onClick={onBack}>
        <PixelIcon name="back" height="0.7em" /> Matches
      </button>
      {(error ?? live.failed) && (
        <p className="error" role="alert">
          {error ?? "Couldn't load the match"}
        </p>
      )}
      {!match ? (
        <p className="hint">Loading…</p>
      ) : (
        <>
          <div className="detail-head">
            <div className="admin-head">
              {!match.closedAt && <span className="run-state running">Live</span>}
              <h1>{match.players.map((p) => p.name).join(" vs ")}</h1>
              <p className="hint">
                {rulesLabel(match.settings)}, {legsLabel(match.settings.legsToWin).toLowerCase()}
                {match.station !== null && ` · station ${match.station}`} · {result(match)}
                {match.closedAt && ` · ${when(match.closedAt)}`}
              </p>
            </div>
            <span className="match-label">Tap a dart to correct it.</span>
          </div>
          {match.state.legs.map((leg, legIndex) => (
            // Only the last leg can be without darts, so the first dart identifies a leg.
            <details
              key={leg.visits[0]?.darts[0]?.dartId ?? "current-leg"}
              className="leg"
              open={legIndex === match.state.legs.length - 1}
            >
              <summary>
                <PixelIcon name="caret" /> Leg {legIndex + 1} · {name(leg.starter)} starts
                {leg.winner !== null && ` · ${name(leg.winner)} won`}
              </summary>
              <ol className="visit-list">
                {[
                  ...leg.visits,
                  ...(legIndex === match.state.legs.length - 1 && match.state.currentVisit
                    ? [match.state.currentVisit]
                    : []),
                ].map((visit, visitIndex) => (
                  <li
                    key={visit.darts[0]?.dartId ?? `visit-${visitIndex}`}
                    className={visit.bust ? "bust" : ""}
                  >
                    <span className="visit-player">{name(visit.player)}</span>
                    <span className="visit-darts">
                      {visit.darts.map((dart) => {
                        const original = match.originals[dart.dartId];
                        const added = match.added.includes(dart.dartId);
                        return (
                          <button
                            type="button"
                            key={dart.dartId}
                            className={`${dart.ignored ? "ignored" : ""} ${original ? "corrected" : ""} ${added ? "added" : ""}`}
                            onClick={() => setCorrecting(dart)}
                            aria-label={`Correct ${dartLabel(dart.segment)}`}
                            title={added ? "Added by hand: the board missed it" : undefined}
                          >
                            {original && <s>{dartLabel(original)}</s>}
                            <span>{dartLabel(dart.segment)}</span>
                            {added && <small>added</small>}
                          </button>
                        );
                      })}
                    </span>
                    <span className="visit-score">
                      {visit.bust ? "Bust" : visit.darts.reduce((sum, d) => sum + d.score, 0)}
                      {visit.checkout && " ✓"}
                    </span>
                  </li>
                ))}
              </ol>
            </details>
          ))}
        </>
      )}
      {correcting && (
        <SegmentPicker
          title={`Correct ${dartLabel(correcting.segment)}`}
          current={correcting.segment}
          onCancel={() => setCorrecting(null)}
          onPick={(segment) => {
            setCorrecting(null);
            void correct(correcting.dartId, segment);
          }}
        />
      )}
    </div>
  );
}
