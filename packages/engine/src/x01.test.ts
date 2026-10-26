import { beforeEach, describe, expect, it } from "vitest";
import { defaultX01Settings, type MatchEvent, matchState, type X01Settings } from "./index.ts";

// Dart notation used in tests: S20 / D20 / T20, 25 (outer bull), BULL (bullseye), M (miss).
let nextId = 0;
beforeEach(() => {
  nextId = 0;
});

function seg(name: string) {
  if (name === "M") return { number: 0, multiplier: 0 } as const;
  if (name === "25") return { number: 25, multiplier: 1 } as const;
  if (name === "BULL") return { number: 25, multiplier: 2 } as const;
  const multiplier = ({ S: 1, D: 2, T: 3 } as const)[name[0] as "S" | "D" | "T"];
  return { number: Number(name.slice(1)), multiplier };
}

const start = (playerCount = 2): MatchEvent => ({ type: "MatchStarted", playerCount });
const dart = (name: string, dartId = `d${++nextId}`): MatchEvent => ({
  type: "DartThrown",
  dartId,
  segment: seg(name),
});
const takeout: MatchEvent = { type: "TakeoutFinished" };

const play = (events: MatchEvent[], settings: Partial<X01Settings> = {}) =>
  matchState({ ...defaultX01Settings, ...settings }, events);

describe("starting a match", () => {
  it("gives both players 301 and the turn to the first player in the order", () => {
    const state = play([start()]);

    expect(state.phase).toBe("throwing");
    expect(state.players.map((p) => p.remaining)).toEqual([301, 301]);
    expect(state.currentPlayer).toBe(0);
  });

  it("starts every player of a bigger match on the starting score", () => {
    const state = play([start(8)]);

    expect(state.players).toHaveLength(8);
    expect(state.players.every((p) => p.remaining === 301 && p.legsWon === 0)).toBe(true);
  });

  it.each([0, 9])("refuses a match with %i players", (count) => {
    expect(() => play([start(count)])).toThrow();
  });

  it("refuses a rules version it doesn't know", () => {
    expect(() => play([start()], { rulesVersion: 2 })).toThrow();
  });
});

describe("more than two players", () => {
  it("passes the turn along the order and back to the first player", () => {
    const state = play([start(3), dart("S1"), takeout, dart("S2"), takeout, dart("S3"), takeout]);

    expect(state.players.map((p) => p.remaining)).toEqual([300, 299, 298]);
    expect(state.currentPlayer).toBe(0);
  });

  it("moves the leg starter one place along the order every leg", () => {
    const won = [dart("D20"), takeout];
    const state = play([start(3), ...won, ...won, ...won, ...won], {
      startScore: 40,
      legsToWin: 5,
    });

    // Each leg is checked out by its starter with the first dart.
    expect(state.legs.map((leg) => [leg.starter, leg.winner])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [0, 0],
      [1, null],
    ]);
    expect(state.currentPlayer).toBe(1);
  });

  it("ends the leg at the first checkout and resets everyone", () => {
    const miss = [dart("M"), takeout];
    const state = play([start(4), ...miss, ...miss, dart("D20"), takeout], {
      startScore: 40,
      legsToWin: 2,
    });

    expect(state.players.map((p) => p.legsWon)).toEqual([0, 0, 1, 0]);
    expect(state.players.map((p) => p.remaining)).toEqual([40, 40, 40, 40]);
    expect(state.legs).toHaveLength(2);
    expect(state.currentPlayer).toBe(1);
  });

  it("wins the match for the first player to reach the legs needed, starter or not", () => {
    const miss = [dart("M"), takeout];
    const state = play(
      [
        start(3),
        // Leg 1, started by player 0: player 2 checks out.
        ...miss,
        ...miss,
        dart("D20"),
        takeout,
        // Leg 2, started by player 1: player 2 checks out again.
        ...miss,
        dart("D20"),
      ],
      { startScore: 40, legsToWin: 2 },
    );

    expect(state.phase).toBe("matchWon");
    expect(state.winner).toBe(2);
    expect(state.players.map((p) => p.legsWon)).toEqual([0, 0, 2]);
  });

  it("undo hands the turn back along the order", () => {
    const state = play([
      start(3),
      dart("S1"),
      takeout,
      dart("S2"),
      takeout,
      { type: "VisitUndone" },
    ]);

    expect(state.players.map((p) => p.remaining)).toEqual([300, 301, 301]);
    expect(state.currentPlayer).toBe(1);
  });
});

describe("a visit", () => {
  it("lowers the thrower's remaining score dart by dart", () => {
    const state = play([start(), dart("T20"), dart("S5")]);

    expect(state.players[0]?.remaining).toBe(236);
    expect(state.currentVisit?.darts.map((d) => d.score)).toEqual([60, 5]);
    expect(state.phase).toBe("throwing");
  });

  it("waits for takeout after three darts and ignores any further dart", () => {
    const state = play([start(), dart("T20"), dart("T20"), dart("T20"), dart("T20")]);

    expect(state.phase).toBe("awaitingTakeout");
    expect(state.players[0]?.remaining).toBe(121);
    expect(state.currentVisit?.darts.map((d) => d.ignored)).toEqual([false, false, false, true]);
  });
});

describe("ending a visit", () => {
  const nextPlayer: MatchEvent = { type: "VisitEndedManually" };

  it("passes the turn on takeout, keeping the thrower's score", () => {
    const state = play([start(), dart("T20"), dart("T20"), dart("T20"), takeout, dart("S1")]);

    expect(state.players.map((p) => p.remaining)).toEqual([121, 300]);
    expect(state.currentPlayer).toBe(1);
    expect(state.currentVisit?.darts.map((d) => d.score)).toEqual([1]);
  });

  it("passes the turn on takeout after fewer than three darts", () => {
    const state = play([start(), dart("S20"), takeout]);

    expect(state.currentPlayer).toBe(1);
    expect(state.currentVisit).toBeNull();
    expect(state.phase).toBe("throwing");
  });

  it("passes the turn when ended manually, even with no darts detected", () => {
    const state = play([start(), nextPlayer, dart("S20"), takeout, nextPlayer]);

    expect(state.players.map((p) => p.remaining)).toEqual([301, 281]);
    expect(state.currentPlayer).toBe(1);
  });
});

describe("straight out", () => {
  it("busts below zero: the visit scores nothing and later darts are ignored", () => {
    const state = play([start(), dart("S20"), dart("T20"), dart("S1")], { startScore: 40 });

    expect(state.phase).toBe("awaitingTakeout");
    expect(state.currentVisit?.bust).toBe(true);
    expect(state.players[0]?.remaining).toBe(40);
    expect(state.currentVisit?.darts.map((d) => d.ignored)).toEqual([false, false, true]);
  });

  it("keeps the pre-bust score after takeout", () => {
    const state = play([start(), dart("T20"), takeout], { startScore: 40 });

    expect(state.players[0]?.remaining).toBe(40);
    expect(state.currentPlayer).toBe(1);
  });

  it("wins the match by reaching exactly zero with any dart", () => {
    const state = play([start(), dart("S20"), dart("S20"), dart("S1")], { startScore: 40 });

    expect(state.phase).toBe("matchWon");
    expect(state.winner).toBe(0);
    expect(state.players[0]).toMatchObject({ remaining: 0, legsWon: 1 });
    expect(state.currentVisit?.darts.map((d) => d.ignored)).toEqual([false, false, true]);
  });
});

describe("legs", () => {
  const firstTo2 = { startScore: 40, legsToWin: 2 };

  it("waits for takeout after a won leg that doesn't decide the match", () => {
    const state = play([start(), dart("D20")], firstTo2);

    expect(state.phase).toBe("awaitingTakeout");
    expect(state.winner).toBeNull();
    expect(state.players[0]?.legsWon).toBe(1);
  });

  it("resets both scores and lets the other player start the next leg", () => {
    // Player 0 starts leg 1, player 1 wins it, so player 1 also starts leg 2.
    const state = play([start(), dart("S1"), takeout, dart("D20"), takeout], firstTo2);

    expect(state.players.map((p) => p.remaining)).toEqual([40, 40]);
    expect(state.players.map((p) => p.legsWon)).toEqual([0, 1]);
    expect(state.currentPlayer).toBe(1);
    expect(state.phase).toBe("throwing");
  });

  it("alternates the starting player every leg", () => {
    const state = play([start(), dart("D20"), takeout, dart("D20"), takeout, dart("S1"), takeout], {
      startScore: 40,
      legsToWin: 3,
    });

    // Leg 1: player 0 starts and wins. Leg 2: player 1 starts and wins. Leg 3: player 0 starts.
    expect(state.legs.map((leg) => [leg.starter, leg.winner])).toEqual([
      [0, 0],
      [1, 1],
      [0, null],
    ]);
    expect(state.currentPlayer).toBe(1);
  });

  it("wins the match on the deciding leg", () => {
    const state = play([start(), dart("D20"), takeout, dart("S1"), takeout, dart("D20")], firstTo2);

    expect(state.phase).toBe("matchWon");
    expect(state.winner).toBe(0);
  });
});

describe("double out", () => {
  const doubleOut = { startScore: 40, outRule: "double" } as const;

  it("busts when reaching zero with a single", () => {
    const state = play([start(), dart("S20"), dart("S20")], doubleOut);

    expect(state.currentVisit?.bust).toBe(true);
    expect(state.players[0]?.remaining).toBe(40);
  });

  it("busts when leaving 1", () => {
    const state = play([start(), dart("S19"), dart("S20")], doubleOut);

    expect(state.currentVisit?.bust).toBe(true);
    expect(state.players[0]?.remaining).toBe(40);
  });

  it("wins with a double", () => {
    expect(play([start(), dart("S20"), dart("D10")], doubleOut).winner).toBe(0);
  });

  it("counts the bullseye as a double", () => {
    expect(play([start(), dart("BULL")], { ...doubleOut, startScore: 50 }).winner).toBe(0);
  });
});

describe("master out", () => {
  const masterOut = { startScore: 60, outRule: "master" } as const;

  it("wins with a treble", () => {
    expect(play([start(), dart("T20")], masterOut).winner).toBe(0);
  });

  it("busts when reaching zero with a single", () => {
    const state = play([start(), dart("S20"), dart("S20"), dart("S20")], masterOut);

    expect(state.currentVisit?.bust).toBe(true);
    expect(state.players[0]?.remaining).toBe(60);
  });
});

describe("in rules", () => {
  it("double in: darts before the first double score nothing, the double and later darts count", () => {
    const state = play([start(), dart("T20"), dart("D10"), dart("S5")], { inRule: "double" });

    expect(state.currentVisit?.darts.map((d) => d.score)).toEqual([0, 20, 5]);
    expect(state.players[0]).toMatchObject({ remaining: 276, isIn: true });
  });

  it("double in: stays in for later visits", () => {
    const state = play([start(), dart("D1"), takeout, takeout, dart("S20")], { inRule: "double" });

    expect(state.players[0]?.remaining).toBe(279);
  });

  it("double in: has to get in again in every leg", () => {
    const state = play([start(), dart("D20"), takeout, takeout, dart("S1")], {
      inRule: "double",
      startScore: 40,
      legsToWin: 2,
    });

    // Leg 2 is started by player 1, who passes; player 0's single doesn't count yet.
    expect(state.players[0]).toMatchObject({ remaining: 40, isIn: false });
  });

  it("master in: a treble gets the player in", () => {
    const state = play([start(), dart("S20"), dart("T20")], { inRule: "master" });

    expect(state.players[0]?.remaining).toBe(241);
  });

  it("bull in: only the outer bull or bullseye gets the player in", () => {
    const state = play([start(), dart("D20"), dart("25"), dart("S20")], { inRule: "bull" });

    expect(state.currentVisit?.darts.map((d) => d.score)).toEqual([0, 25, 20]);
  });
});

describe("corrections", () => {
  const correct = (dartId: string, name: string): MatchEvent => ({
    type: "DartCorrected",
    dartId,
    segment: seg(name),
  });

  it("rescores a dart of the current visit", () => {
    const state = play([start(), dart("S1", "a"), correct("a", "T20")]);

    expect(state.players[0]?.remaining).toBe(241);
    expect(state.currentVisit?.darts[0]).toMatchObject({ dartId: "a", score: 60 });
  });

  it("can turn a bust into a normal visit", () => {
    const state = play([start(), dart("S20"), dart("T20", "b"), correct("b", "S10")], {
      startScore: 40,
    });

    expect(state.currentVisit?.bust).toBe(false);
    expect(state.players[0]?.remaining).toBe(10);
    expect(state.phase).toBe("throwing");
  });

  it("can turn a normal visit into a bust", () => {
    const state = play([start(), dart("S20"), dart("S10", "b"), correct("b", "T20")], {
      startScore: 40,
    });

    expect(state.currentVisit?.bust).toBe(true);
    expect(state.players[0]?.remaining).toBe(40);
  });

  it("rescores a dart from an earlier visit", () => {
    const state = play([
      start(),
      dart("S1", "a"),
      takeout,
      dart("S20"),
      takeout,
      correct("a", "S5"),
    ]);

    expect(state.players.map((p) => p.remaining)).toEqual([296, 281]);
  });

  it("ignores a correction for an unknown dart", () => {
    const state = play([start(), dart("S1"), correct("nope", "T20")]);

    expect(state.players[0]?.remaining).toBe(300);
  });
});

describe("undo", () => {
  const undo: MatchEvent = { type: "VisitUndone" };

  it("clears the darts of the current visit", () => {
    const state = play([start(), dart("T20"), dart("T20"), undo]);

    expect(state.players[0]?.remaining).toBe(301);
    expect(state.currentPlayer).toBe(0);
    expect(state.currentVisit).toBeNull();
  });

  it("with no darts thrown yet, gives the turn back to the previous player", () => {
    const state = play([start(), dart("T20"), takeout, undo]);

    expect(state.players[0]?.remaining).toBe(301);
    expect(state.currentPlayer).toBe(0);
  });

  it("goes back one visit per undo", () => {
    const state = play([start(), dart("T20"), takeout, dart("S20"), takeout, undo, undo]);

    expect(state.players.map((p) => p.remaining)).toEqual([301, 301]);
    expect(state.currentPlayer).toBe(0);
  });

  it("un-wins a leg when undoing across the leg boundary", () => {
    const state = play([start(), dart("D20"), takeout, undo], { startScore: 40, legsToWin: 2 });

    expect(state.players[0]).toMatchObject({ remaining: 40, legsWon: 0 });
    expect(state.legs).toHaveLength(1);
    expect(state.currentPlayer).toBe(0);
  });

  it("un-wins a won match", () => {
    const state = play([start(), dart("D20"), undo], { startScore: 40 });

    expect(state.phase).toBe("throwing");
    expect(state.winner).toBeNull();
  });
});

describe("edges", () => {
  it("checks out on the third dart", () => {
    const state = play([start(), dart("S1"), dart("S1"), dart("D19")], {
      startScore: 40,
      outRule: "double",
    });

    expect(state.winner).toBe(0);
  });

  it("ignores everything logged before the match started", () => {
    const state = play([dart("T20"), takeout, start(), dart("S1")]);

    expect(state.players.map((p) => p.remaining)).toEqual([300, 301]);
    expect(state.currentPlayer).toBe(0);
  });
});

describe("leg history", () => {
  it("records every visit of a leg, including the match-winning one after takeout", () => {
    const state = play([start(), dart("S20"), takeout, dart("S1"), takeout, dart("S20"), takeout], {
      startScore: 40,
    });

    expect(state.phase).toBe("matchWon");
    expect(state.legs[0]?.visits.map((v) => [v.player, v.checkout])).toEqual([
      [0, false],
      [1, false],
      [0, true],
    ]);
    expect(state.currentVisit).toBeNull();
  });
});
