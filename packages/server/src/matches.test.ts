import { afterEach, describe, expect, it } from "vitest";
import type { MatchDetail, MatchSummary, StationView } from "./api.ts";
import { buildApp } from "./app.ts";
import { type Db, openDb } from "./db.ts";
import { createStation, type Station } from "./station.ts";

let db: Db;
afterEach(() => db?.close());

/** Two stations on boards that accept every command; no simulator needed for assigning. */
function setup(adminPin?: string) {
  db = openDb(":memory:");
  for (const name of ["Ann", "Bob", "Cid"]) {
    db.addPlayer({ id: name.toLowerCase(), name, archived: false });
  }
  const board = { reset: async () => {} };
  const stations = [1, 2].map((id) => createStation({ id, db, board }));
  const app = buildApp({ db, stations, adminPin });
  /** Plays darts on a station as if its board detected them; `/` is a takeout. */
  const play = (stationId: number, darts: string) => {
    const station = stations[stationId - 1] as Station;
    let index = 0;
    for (const dart of darts.split(" ")) {
      if (dart === "/") {
        station.handleBoardEvent({ type: "TakeoutFinished" });
        index = 0;
        continue;
      }
      const multiplier = ({ S: 1, D: 2, T: 3 } as const)[dart[0] as "S" | "D" | "T"];
      const segment = { number: Number(dart.slice(1)), multiplier };
      station.handleBoardEvent({
        type: "DartDetected",
        index: index++,
        segment,
        name: dart,
        coords: { x: 0, y: 0 },
        bouncer: false,
      });
    }
  };
  const command = (stationId: number, type: "startMatch" | "closeMatch" | "abandonMatch") =>
    app.inject({ method: "POST", url: `/api/stations/${stationId}/commands`, payload: { type } });
  const create = (payload: object) =>
    app.inject({ method: "POST", url: "/api/admin/matches", payload });
  const station = async (id: number): Promise<StationView> =>
    (await app.inject(`/api/stations/${id}`)).json();
  return { app, create, station, play, command };
}

describe("creating matches in /admin", () => {
  it("puts a new match on the chosen station, ready to start", async () => {
    const { create, station } = setup();

    const res = await create({
      station: 2,
      playerIds: ["ann", "bob", "cid"],
      settings: { startScore: 501, outRule: "double", legsToWin: 2 },
    });

    expect(res.statusCode).toBe(201);
    const view = await station(2);
    expect(view.match?.players.map((p) => p.name)).toEqual(["Ann", "Bob", "Cid"]);
    expect(view.match?.settings).toMatchObject({
      startScore: 501,
      outRule: "double",
      legsToWin: 2,
    });
    expect(view.match?.state.phase).toBe("notStarted");
    expect((await station(1)).match).toBeNull();
  });

  it("refuses a station that already has a match", async () => {
    const { create } = setup();
    await create({ station: 1, playerIds: ["ann", "bob"] });

    const res = await create({ station: 1, playerIds: ["cid", "bob"] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already has a match/);
  });

  it("refuses an unknown station and invalid players", async () => {
    const { create } = setup();

    expect((await create({ station: 9, playerIds: ["ann", "bob"] })).statusCode).toBe(404);
    expect((await create({ station: 1, playerIds: [] })).statusCode).toBe(409);
    expect((await create({ station: 1, playerIds: "ann" })).statusCode).toBe(400);
  });

  it("abandons a station's match from /admin", async () => {
    const { app, create, station } = setup();
    await create({ station: 1, playerIds: ["ann", "bob"] });

    const res = await app.inject({ method: "POST", url: "/api/admin/stations/1/abandon" });

    expect(res.statusCode).toBe(200);
    expect((await station(1)).match).toBeNull();
    expect((await create({ station: 1, playerIds: ["cid", "bob"] })).statusCode).toBe(201);
  });

  it("needs the admin PIN", async () => {
    const { app, create } = setup("1234");

    expect((await create({ station: 1, playerIds: ["ann", "bob"] })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: "/api/admin/stations/1/abandon" })).statusCode,
    ).toBe(401);
  });
});

describe("match history", () => {
  /** Ann vs Bob, 40, first to 2: Ann wins leg 1, Bob leg 2, Ann leg 3 (with an S20 that could be corrected). */
  async function playedMatch(ctx: ReturnType<typeof setup>) {
    await ctx.create({
      station: 1,
      playerIds: ["ann", "bob"],
      settings: { startScore: 40, legsToWin: 2 },
    });
    await ctx.command(1, "startMatch");
    ctx.play(1, "D20 /"); // leg 1: Ann
    ctx.play(1, "D20 /"); // leg 2: Bob starts and wins
    ctx.play(1, "S20 S20 /"); // leg 3: Ann
    const id = (await ctx.station(1)).match?.id as string;
    await ctx.command(1, "closeMatch");
    return id;
  }

  const history = async (app: ReturnType<typeof setup>["app"]) =>
    (await app.inject("/api/admin/matches")).json() as MatchSummary[];
  const detail = async (app: ReturnType<typeof setup>["app"], id: string) =>
    (await app.inject(`/api/admin/matches/${id}`)).json() as MatchDetail;

  it("lists finished and abandoned matches, newest first, with the legs score", async () => {
    const ctx = setup();
    const won = await playedMatch(ctx);
    await ctx.create({ station: 1, playerIds: ["cid", "bob"] });
    await ctx.command(1, "startMatch");
    ctx.play(1, "T20");
    const abandoned = (await ctx.station(1)).match?.id as string;
    await ctx.command(1, "abandonMatch");

    const list = await history(ctx.app);
    expect(list.map((m) => m.id)).toEqual([abandoned, won]);
    expect(list[1]).toMatchObject({
      players: [
        { id: "ann", name: "Ann" },
        { id: "bob", name: "Bob" },
      ],
      winner: "ann",
      abandoned: false,
      legsWon: [2, 1],
    });
    expect(list[0]).toMatchObject({ winner: null, abandoned: true, legsWon: [0, 0] });
  });

  it("shows every leg and visit of a match", async () => {
    const ctx = setup();
    const id = await playedMatch(ctx);

    const match = await detail(ctx.app, id);
    expect(match.state.legs.map((l) => [l.starter, l.winner])).toEqual([
      [0, 0],
      [1, 1],
      [0, 0],
    ]);
    expect(match.closedAt).not.toBeNull();
    expect((await ctx.app.inject("/api/admin/matches/nope")).statusCode).toBe(404);
  });

  it("lets the organiser correct a dart of a finished match; the result follows", async () => {
    const ctx = setup();
    const id = await playedMatch(ctx);
    const leg3 = (await detail(ctx.app, id)).state.legs[2];
    const dart = leg3?.visits[0]?.darts[1];

    // Ann's second S20 in leg 3 was really an S19: no checkout, so Ann hasn't won.
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/admin/matches/${id}/corrections`,
      payload: { dartId: dart?.dartId, segment: { number: 19, multiplier: 1 } },
    });
    expect(res.statusCode).toBe(200);

    const match = await detail(ctx.app, id);
    expect(match.state.winner).toBeNull();
    expect(match.originals[dart?.dartId as string]).toEqual({ number: 20, multiplier: 1 });
    expect(match.winner).toBeNull();
    expect((await history(ctx.app))[0]).toMatchObject({ winner: null, legsWon: [1, 1] });
    expect(db.events(id).at(-1)).toMatchObject({ type: "DartCorrected", source: "admin" });
  });

  it("corrects a running match through its station, so the station updates live", async () => {
    const ctx = setup();
    await ctx.create({ station: 2, playerIds: ["ann", "bob"] });
    await ctx.command(2, "startMatch");
    ctx.play(2, "S1 /");
    const id = (await ctx.station(2)).match?.id as string;
    const dart = (await ctx.station(2)).match?.state.legs[0]?.visits[0]?.darts[0];

    await ctx.app.inject({
      method: "POST",
      url: `/api/admin/matches/${id}/corrections`,
      payload: { dartId: dart?.dartId, segment: { number: 20, multiplier: 3 } },
    });

    expect((await ctx.station(2)).match?.state.players[0]?.remaining).toBe(241);
  });

  it("refuses a correction for a dart that isn't in the match", async () => {
    const ctx = setup();
    const id = await playedMatch(ctx);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/admin/matches/${id}/corrections`,
      payload: { dartId: "nope", segment: { number: 20, multiplier: 3 } },
    });
    expect(res.statusCode).toBe(404);
  });
});
