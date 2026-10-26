import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultX01Settings,
  gameStats,
  type MatchEvent,
  matchState,
  type X01Settings,
} from "./index.ts";

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
const takeout: MatchEvent = { type: "TakeoutFinished" };
/** One visit: the darts, then the takeout. */
const visit = (...names: string[]): MatchEvent[] => [
  ...names.map(
    (name): MatchEvent => ({ type: "DartThrown", dartId: `d${++nextId}`, segment: seg(name) }),
  ),
  takeout,
];

const play = (
  game: NonNullable<X01Settings["game"]>,
  events: MatchEvent[],
  settings: Partial<X01Settings> = {},
) => matchState({ ...defaultX01Settings, ...settings, game }, events);

describe("playing alone", () => {
  it("X01 with one player keeps the turn and can be won", () => {
    const state = play("x01", [start(1), ...visit("T20", "T20", "T20"), ...visit("T20", "S1")], {
      startScore: 241,
    });
    expect(state.currentPlayer).toBe(0);
    expect(state.winner).toBe(0);
    expect(state.phase).toBe("matchWon");
  });

  it("Cricket alone is won by closing every number", () => {
    const events = [start(1)];
    for (const n of [20, 19, 18, 17, 16, 15]) events.push(...visit(`T${n}`));
    events.push(...visit("BULL", "25"));
    const state = play("cricket", events);
    expect(state.winner).toBe(0);
  });
});

describe("Cricket", () => {
  it("counts marks and closes a number at three", () => {
    const state = play("cricket", [start(), ...visit("S20", "D20", "M")]);
    expect(state.players[0]?.marks).toEqual([3, 0, 0, 0, 0, 0, 0]);
    expect(state.players[0]?.remaining).toBe(0);
    expect(state.currentPlayer).toBe(1);
  });

  it("scores on a closed number while an opponent still has it open", () => {
    const state = play("cricket", [start(), ...visit("T20", "T20", "S20")]);
    expect(state.players[0]?.remaining).toBe(80);
    const darts = state.legs[0]?.visits[0]?.darts ?? [];
    expect(darts.map((d) => d.score)).toEqual([0, 60, 20]);
    expect(darts.map((d) => d.marks)).toEqual([3, 3, 1]);
  });

  it("scores nothing on a number every player has closed", () => {
    const state = play("cricket", [start(), ...visit("T20"), ...visit("T20"), ...visit("T20")]);
    expect(state.players.map((p) => p.remaining)).toEqual([0, 0]);
  });

  it("needs the most points to win, not just every number closed", () => {
    const events = [start(), ...visit("T20", "T20", "T20")]; // player 1: 120 points
    events.push(...visit("M")); // player 2
    for (const n of [19, 18, 17, 16, 15]) {
      events.push(...visit(`T${n}`), ...visit(`T${n}`)); // both close the rest
    }
    events.push(...visit("BULL", "25"), ...visit("M")); // player 1 closes the bull: wins
    const state = play("cricket", events);
    expect(state.winner).toBe(0);
  });

  it("does not win while behind on points", () => {
    const events = [start(), ...visit("M"), ...visit("T20", "T20", "T20")]; // player 2: 120
    for (const n of [20, 19, 18, 17, 16, 15]) events.push(...visit(`T${n}`), ...visit("M"));
    events.push(...visit("BULL", "25"));
    const state = play("cricket", events);
    expect(state.players[0]?.marks?.every((m) => m === 3)).toBe(true);
    expect(state.winner).toBeNull();
  });
});

describe("Around the World", () => {
  it("moves on with every hit of the number in turn, any ring", () => {
    const state = play("atc", [start(), ...visit("S1", "T2", "S4")]);
    expect(state.players[0]?.progress).toBe(2);
    expect(state.players[0]?.remaining).toBe(3);
  });

  it("ends on the bull after 1 to 20", () => {
    const events = [start(1)];
    for (let n = 1; n <= 20; n += 3) {
      events.push(...visit(...[n, n + 1, n + 2].filter((x) => x <= 20).map((x) => `S${x}`)));
    }
    events.push(...visit("25"));
    const state = play("atc", events);
    expect(state.winner).toBe(0);
    expect(gameStats({ ...defaultX01Settings, game: "atc" }, events)[0]?.bestLeg).toBe(21);
  });
});

describe("Elimination", () => {
  const settings = { startScore: 101 };

  it("counts up and busts when going over the target", () => {
    const state = play(
      "elimination",
      [start(), ...visit("T20"), ...visit("S1"), ...visit("T20", "S20", "S5")],
      settings,
    );
    expect(state.players[0]?.remaining).toBe(60);
    expect(state.legs[0]?.visits[2]?.bust).toBe(true);
  });

  it("sends an opponent back to zero by landing on their score", () => {
    const state = play("elimination", [start(), ...visit("S20"), ...visit("S10", "S10")], settings);
    expect(state.players.map((p) => p.remaining)).toEqual([0, 20]);
    expect(state.legs[0]?.visits[1]?.eliminated).toEqual([0]);
  });

  it("is won by reaching the target exactly", () => {
    const state = play(
      "elimination",
      [start(), ...visit("T20", "S20", "S1"), ...visit("M"), ...visit("S20")],
      settings,
    );
    expect(state.winner).toBe(0);
  });
});
