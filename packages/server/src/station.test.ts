import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoardSim, createBoardSim } from "@n4/board-sim";
import type { MatchState } from "@n4/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.ts";
import { type Db, openDb } from "./db.ts";
import type { StationCommand, StationView } from "./station.ts";
import { startStation } from "./stations.ts";

interface Server {
  app: ReturnType<typeof buildApp>;
  db: Db;
  command(command: StationCommand): Promise<{ status: number; body: unknown }>;
  view(): Promise<StationView>;
  stop(): Promise<void>;
}

let sim: BoardSim;
let servers: Server[] = [];
afterEach(async () => {
  for (const server of servers) await server.stop();
  servers = [];
  await sim?.close();
});

const tempDb = () => join(mkdtempSync(join(tmpdir(), "n4-db-")), "test.db");

/** Server with station 1 on the simulator, as main.ts wires it; resolves once the board is online. */
async function startServer(dbPath: string): Promise<Server> {
  const db = openDb(dbPath);
  for (const name of PLAYERS) {
    const id = name.toLowerCase();
    if (!db.getPlayer(id)) db.addPlayer({ id, name, archived: false });
  }
  const running = startStation({ id: 1, boardUrl: sim.url }, db, {
    reconnectDelayMs: 10,
    maxReconnectDelayMs: 20,
  });
  const app = buildApp({ stations: [running.station], db });
  let stopped = false;
  const server: Server = {
    app,
    db,
    async command(command: StationCommand) {
      const res = await app.inject({
        method: "POST",
        url: "/api/stations/1/commands",
        payload: command,
      });
      return { status: res.statusCode, body: res.json() };
    },
    async view() {
      return (await app.inject("/api/stations/1")).json();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      running.close();
      await app.close();
      db.close();
    },
  };
  servers.push(server);
  await vi.waitFor(async () => expect((await server.view()).boardOnline).toBe(true));
  return server;
}

const state = async (server: Server) => (await server.view()).match?.state as MatchState;

/** Throws a dart on the board and waits until the match has recorded it. */
async function throwDart(server: Server, name: string) {
  const before = (await state(server)).currentVisit?.darts.length ?? 0;
  sim.throwDart(name);
  await vi.waitFor(async () =>
    expect((await state(server)).currentVisit?.darts.length).toBe(before + 1),
  );
}

async function takeout(server: Server) {
  const visits = (await state(server)).legs.flatMap((l) => l.visits).length;
  sim.takeout();
  await vi.waitFor(async () =>
    expect((await state(server)).legs.flatMap((l) => l.visits).length).toBe(visits + 1),
  );
}

/** What a finished match looks like, without random dart ids. */
const summary = (s: MatchState) => ({
  phase: s.phase,
  winner: s.winner,
  remaining: s.players.map((p) => p.remaining),
  visits: s.legs.flatMap((l) => l.visits.map((v) => [v.player, ...v.darts.map((d) => d.score)])),
});

/** Seeded into every test database; ids are the lower-cased names. */
const PLAYERS = ["Ann", "Bob", "Cid", "Dee", "Eve"];

const quick = (ids: string[], settings = {}): StationCommand => ({
  type: "quickMatch",
  playerIds: ids,
  settings: { startScore: 101, ...settings },
});

/** Sets up Ann vs Bob (101) as a quick match and starts it. */
async function start(server: Server, ids = ["ann", "bob"], settings = {}) {
  const set = await server.command(quick(ids, settings));
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  const started = await server.command({ type: "startMatch" });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
}

/** Ann 66 (one dart corrected), Bob 60, Ann checks out 35. Optionally restarts the server mid-visit. */
async function playMatch(restart: boolean) {
  sim = await createBoardSim();
  const dbPath = tempDb();
  let server = await startServer(dbPath);
  await start(server);

  await throwDart(server, "T20");
  await throwDart(server, "S1");
  await throwDart(server, "S1");
  const misdetected = (await state(server)).currentVisit?.darts[1]?.dartId as string;
  await server.command({
    type: "correctDart",
    dartId: misdetected,
    segment: { number: 5, multiplier: 1 },
  });
  await takeout(server);

  for (const _ of [1, 2, 3]) await throwDart(server, "S20");
  await takeout(server);

  await throwDart(server, "S20");
  if (restart) {
    await server.stop();
    sim.throwDart("S10"); // thrown while the server is down
    server = await startServer(dbPath);
    await vi.waitFor(async () => expect((await state(server)).currentVisit?.darts).toHaveLength(2));
  } else {
    await throwDart(server, "S10");
  }
  await throwDart(server, "S5");
  await takeout(server);

  return summary(await state(server));
}

describe("playing a match at a station", () => {
  it("plays a full leg from the board, with a correction from the station", async () => {
    expect(await playMatch(false)).toEqual({
      phase: "matchWon",
      winner: 0,
      remaining: [0, 41],
      visits: [
        [0, 60, 5, 1],
        [1, 20, 20, 20],
        [0, 20, 10, 5],
      ],
    });
  });

  it("ends up in the same state when the server restarts mid-visit", async () => {
    const restarted = await playMatch(true);
    await sim.close();
    expect(restarted).toEqual(await playMatch(false));
  });

  it("notices a takeout and a new visit that happened while the server was down", async () => {
    sim = await createBoardSim();
    const dbPath = tempDb();
    const first = await startServer(dbPath);
    await start(first);
    await throwDart(first, "S20");
    await first.stop();

    sim.takeout();
    sim.throwDart("T20"); // Bob, as many darts as Ann had logged
    const second = await startServer(dbPath);

    await vi.waitFor(async () => {
      const s = await state(second);
      expect(s.currentVisit).toMatchObject({ player: 1, darts: [{ score: 60 }] });
      expect(s.players.map((p) => p.remaining)).toEqual([81, 41]);
    });
  });

  it("ignores darts while no match is running", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());

    sim.throwDart("T20");
    await server.command(quick(["ann", "bob"]));
    sim.throwDart("T20"); // set up but not started yet
    await server.command({ type: "startMatch" });
    await throwDart(server, "S1");

    expect((await state(server)).currentVisit?.darts.map((d) => d.score)).toEqual([1]);
  });

  it("applies the board's own revision of a dart", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());
    await start(server);
    await throwDart(server, "S1");

    sim.reviseDart(0, "T20");

    await vi.waitFor(async () => expect((await state(server)).players[0]?.remaining).toBe(41));
  });

  it("passes the turn on 'next player' and clears the board", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());
    await start(server);
    await throwDart(server, "S20");

    await server.command({ type: "nextPlayer" });
    await throwDart(server, "T20");

    const s = await state(server);
    expect(s.currentPlayer).toBe(1);
    expect(s.players.map((p) => p.remaining)).toEqual([81, 41]);
  });

  it("refuses a second match until the first is closed", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());
    await start(server);

    expect((await server.command(quick(["cid", "dee"]))).status).toBe(409);
    await server.command({ type: "abandonMatch" });
    expect((await server.command(quick(["cid", "dee"]))).status).toBe(200);
  });

  it("pushes every change to live viewers", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    const address = server.app.addresses()[0];
    const res = await fetch(`http://127.0.0.1:${address?.port}/api/stations/1/live`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const next = async (): Promise<StationView> => {
      const { value } = await reader.read();
      return JSON.parse(decoder.decode(value).replace(/^data: /, ""));
    };

    expect((await next()).match).toBeNull();
    await server.command(quick(["ann", "bob"]));
    expect((await next()).match?.players.map((p) => p.name)).toEqual(["Ann", "Bob"]);
    await server.command({ type: "startMatch" });
    await next();
    sim.throwDart("T20");
    expect((await next()).match?.state.players[0]?.remaining).toBe(41);
    await reader.cancel();
  });
});

describe("a dart the board missed", () => {
  const add = (server: Server, number: number, multiplier: 0 | 1 | 2 | 3) =>
    server.command({ type: "addDart", segment: { number, multiplier } });

  it("is added by hand, counts, and the visit ends on takeout as usual", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());
    await start(server);
    await throwDart(server, "S20");
    await throwDart(server, "S20");
    sim.missDart();

    expect((await add(server, 20, 3)).status).toBe(200);
    expect((await state(server)).phase).toBe("awaitingTakeout");
    // Detection catches up after all: a 4th dart, which counts for nothing.
    await throwDart(server, "T20");
    expect((await state(server)).currentVisit?.darts.map((d) => [d.score, d.ignored])).toEqual([
      [20, false],
      [20, false],
      [60, false],
      [0, true],
    ]);
    await takeout(server);

    const s = await state(server);
    expect(s.players.map((p) => p.remaining)).toEqual([1, 101]);
    expect(s.currentPlayer).toBe(1);
    const detail = (
      await server.app.inject(`/api/admin/matches/${(await server.view()).match?.id}`)
    ).json();
    expect(detail.added).toEqual([s.legs[0]?.visits[0]?.darts[2]?.dartId]);
  });

  it("can be all three darts of a visit, a checkout or a bust", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());
    await start(server, ["ann", "bob"], { startScore: 101, outRule: "double" });
    for (const _ of [1, 2, 3]) await add(server, 20, 1);
    sim.missDart();
    await takeout(server);

    // Bob busts with an added dart: 60 + 60 leaves no double out of 101.
    await throwDart(server, "T20");
    await add(server, 20, 2);
    expect((await state(server)).currentVisit?.bust).toBe(true);
    await takeout(server);

    // Ann checks out 41 with D16 added after S9.
    await throwDart(server, "S9");
    await add(server, 16, 2);
    const s = await state(server);
    expect(s.phase).toBe("matchWon");
    expect(s.winner).toBe(0);
  });

  it("is refused once the visit has three darts or isn't being thrown", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());
    await server.command(quick(["ann", "bob"]));
    expect((await add(server, 20, 1)).status).toBe(409);
    await server.command({ type: "startMatch" });
    for (const _ of [1, 2, 3]) await throwDart(server, "S1");
    expect((await add(server, 20, 1)).status).toBe(409);
    expect((await add(server, 21, 1)).status).toBe(409);
  });

  it("isn't taken for a pulled dart when the server restarts mid-visit", async () => {
    sim = await createBoardSim();
    const dbPath = tempDb();
    const first = await startServer(dbPath);
    await start(first);
    await throwDart(first, "S20");
    sim.missDart();
    await add(first, 5, 1);
    await first.stop();

    sim.throwDart("S1"); // thrown while the server is down
    const second = await startServer(dbPath);
    await vi.waitFor(async () =>
      expect((await state(second)).currentVisit?.darts.map((d) => d.score)).toEqual([20, 5, 1]),
    );
    await takeout(second);
    expect((await state(second)).players.map((p) => p.remaining)).toEqual([75, 101]);
  });
});

describe("setting up a match", () => {
  it("shows a quick match on the station before it starts, and ignores darts until then", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());
    await server.command(quick(["ann", "bob", "cid"]));

    const view = await server.view();
    expect(view.match?.players.map((p) => p.name)).toEqual(["Ann", "Bob", "Cid"]);
    expect(view.match?.state.phase).toBe("notStarted");
  });

  it("lets the players change the order until the match starts", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());
    await server.command(quick(["ann", "bob", "cid"]));

    expect(
      (await server.command({ type: "setOrder", playerIds: ["cid", "ann", "bob"] })).status,
    ).toBe(200);
    expect((await server.command({ type: "setOrder", playerIds: ["cid", "ann"] })).status).toBe(
      409,
    );
    expect(
      (await server.command({ type: "setOrder", playerIds: ["cid", "ann", "dee"] })).status,
    ).toBe(409);
    await server.command({ type: "startMatch" });

    const view = await server.view();
    expect(view.match?.players.map((p) => p.name)).toEqual(["Cid", "Ann", "Bob"]);
    expect(view.match?.state.currentPlayer).toBe(0);
    expect(
      (await server.command({ type: "setOrder", playerIds: ["ann", "bob", "cid"] })).status,
    ).toBe(409);
  });

  it.each([
    ["no players", []],
    ["nine players", ["ann", "bob", "cid", "dee", "eve", "ann", "bob", "cid", "dee"]],
    ["the same player twice", ["ann", "ann"]],
    ["an unknown player", ["ann", "zed"]],
  ])("refuses a match with %s", async (_, ids) => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());

    expect((await server.command(quick(ids))).status).toBe(409);
  });

  it("lets one player practise alone", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());

    expect((await server.command(quick(["ann"]))).status).toBe(200);
  });

  it("refuses an unknown game", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());

    const res = await server.command({
      type: "quickMatch",
      playerIds: ["ann", "bob"],
      settings: { game: "golf" as never },
    });
    expect(res.status).toBe(409);
  });

  it("refuses an archived player", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());
    server.db.updatePlayer({ id: "bob", name: "Bob", archived: true });

    expect((await server.command(quick(["ann", "bob"]))).status).toBe(409);
  });

  it("shows a renamed player's new name", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());
    await start(server);
    server.db.updatePlayer({ id: "bob", name: "Bobby", archived: false });

    expect((await server.view()).match?.players.map((p) => p.name)).toEqual(["Ann", "Bobby"]);
  });

  it("cancelling a match that never started leaves no trace", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());
    await server.command(quick(["ann", "bob"]));
    const id = (await server.view()).match?.id as string;

    await server.command({ type: "abandonMatch" });

    expect((await server.view()).match).toBeNull();
    expect(server.db.getMatch(id)).toBeUndefined();
    expect(server.db.playerHasMatches("ann")).toBe(false);
  });
});

describe("matches with more players", () => {
  it("plays a 4-player first-to-2 match to the end, the starter moving on every leg", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());
    await start(server, ["ann", "bob", "cid", "dee"], { startScore: 40, legsToWin: 2 });

    // Leg 1, started by Ann: Bob checks out.
    await throwDart(server, "M3");
    await takeout(server);
    await throwDart(server, "D20");
    await takeout(server);
    // Leg 2, started by Bob: Bob checks out straight away.
    expect((await state(server)).currentPlayer).toBe(1);
    await throwDart(server, "D20");
    await takeout(server);

    const s = await state(server);
    expect(s.phase).toBe("matchWon");
    expect(s.legs.map((l) => [l.starter, l.winner])).toEqual([
      [0, 1],
      [1, 1],
    ]);
    const id = (await server.view()).match?.id as string;
    expect(server.db.getMatch(id)?.winner).toBe("bob");

    expect((await server.command({ type: "closeMatch" })).status).toBe(200);
    expect((await server.view()).match).toBeNull();
    expect(server.db.getMatch(id)).toMatchObject({ winner: "bob", abandoned: false });
    expect(server.db.getMatch(id)?.closedAt).not.toBeNull();
  });

  it("takes the recorded win back when the winning visit is undone", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());
    await start(server, ["ann", "bob", "cid"], { startScore: 40 });
    await throwDart(server, "D20");
    const id = (await server.view()).match?.id as string;
    expect(server.db.getMatch(id)?.winner).toBe("ann");

    await server.command({ type: "undo" });

    expect(server.db.getMatch(id)?.winner).toBeNull();
    expect((await server.command({ type: "closeMatch" })).status).toBe(409);
  });

  it("abandons a match mid-leg: closed, no winner, station free", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());
    await start(server, ["ann", "bob", "cid", "dee"]);
    await throwDart(server, "T20");
    const id = (await server.view()).match?.id as string;

    expect((await server.command({ type: "abandonMatch" })).status).toBe(200);

    expect((await server.view()).match).toBeNull();
    expect(server.db.getMatch(id)).toMatchObject({ winner: null, abandoned: true });
    expect(server.db.events(id).length).toBeGreaterThan(1);
  });

  it("resumes a 3-player match after a server restart", async () => {
    sim = await createBoardSim();
    const dbPath = tempDb();
    let server = await startServer(dbPath);
    await start(server, ["ann", "bob", "cid"]);
    await throwDart(server, "T20");
    await takeout(server);
    await throwDart(server, "S20");
    await server.stop();

    server = await startServer(dbPath);
    await throwDart(server, "S1");
    await takeout(server);

    const s = await state(server);
    expect(s.players.map((p) => p.remaining)).toEqual([41, 80, 101]);
    expect(s.currentPlayer).toBe(2);
    expect((await server.view()).match?.players.map((p) => p.name)).toEqual(["Ann", "Bob", "Cid"]);
  });
});

describe("a reset pressed on the station laptop", () => {
  const remaining = async (server: Server) => (await state(server)).players.map((p) => p.remaining);

  it("mid-visit keeps the logged darts and carries on with the next ones", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());
    await start(server);
    await throwDart(server, "S20");

    sim.reset();
    await throwDart(server, "S5");
    await throwDart(server, "S1");

    const s = await state(server);
    expect(s.currentVisit?.darts.map((d) => d.score)).toEqual([20, 5, 1]);
    expect(s.phase).toBe("awaitingTakeout");
    await takeout(server);
    expect((await state(server)).currentPlayer).toBe(1);
    expect(await remaining(server)).toEqual([75, 101]);
  });

  it("while waiting for takeout ends the visit, so the next player's darts count", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());
    await start(server);
    for (const _ of [1, 2, 3]) await throwDart(server, "S20");
    expect((await state(server)).phase).toBe("awaitingTakeout");

    sim.reset();
    await vi.waitFor(async () => expect((await state(server)).currentPlayer).toBe(1));
    await throwDart(server, "T20");

    expect(await remaining(server)).toEqual([41, 41]);
  });

  it("doesn't count the server's own resets", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());
    await start(server);
    await throwDart(server, "S20");
    // Undo resets the board; that reset mustn't look like one pressed on the laptop.
    await server.command({ type: "undo" });
    for (const _ of [1, 2, 3]) await throwDart(server, "S20");
    await server.command({ type: "undo" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const s = await state(server);
    expect(s.currentPlayer).toBe(0);
    expect(s.legs[0]?.visits).toEqual([]);
  });
});

describe("the board menu", () => {
  const board = (server: Server, action: string) =>
    server.app.inject({ method: "POST", url: "/api/stations/1/board", payload: { action } });

  it("stops and starts detection, and the station shows it", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());
    expect((await server.view()).boardRunning).toBe(true);

    expect((await board(server, "stop")).statusCode).toBe(200);
    await vi.waitFor(async () => expect((await server.view()).boardRunning).toBe(false));
    expect(sim.state.running).toBe(false);

    await board(server, "start");
    await vi.waitFor(async () => expect((await server.view()).boardRunning).toBe(true));
  });

  it("calibrates and resets the board", async () => {
    sim = await createBoardSim({ calibrationMs: 50 });
    const server = await startServer(tempDb());
    const statuses: string[] = [];
    const ws = new WebSocket(`${sim.url.replace("http", "ws")}/api/events`);
    ws.onmessage = (e) => statuses.push(JSON.parse(String(e.data)).data?.status ?? "");
    await new Promise((resolve) => ws.addEventListener("open", resolve));

    expect((await board(server, "calibrate")).statusCode).toBe(200);
    await vi.waitFor(() => expect(statuses).toContain("Calibrating"));
    sim.throwDart("S5");
    await vi.waitFor(() => expect(sim.state.numThrows).toBe(1));
    expect((await board(server, "reset")).statusCode).toBe(200);
    await vi.waitFor(() => expect(sim.state.numThrows).toBe(0));
    ws.close();
  });

  it("answers with an error when the board is offline, and refuses unknown actions", async () => {
    sim = await createBoardSim();
    const server = await startServer(tempDb());
    sim.setOnline(false);

    const res = await board(server, "stop");
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/didn't answer/);
    expect((await board(server, "explode")).statusCode).toBe(400);
  });
});
