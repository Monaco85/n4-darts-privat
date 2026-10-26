import {
  type BoardGateway,
  type BoardGatewayOptions,
  createBoardGateway,
} from "./board/gateway.ts";
import type { Db, StationConfig } from "./db.ts";
import { createStation, type Station } from "./station.ts";

export type { StationConfig };

/** Parses `STATIONS`, e.g. `1=http://192.168.1.139:3180,2=http://192.168.1.140:3180`. */
export function parseStationsConfig(value: string): Omit<StationConfig, "name">[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, boardUrl] = entry.split("=");
      if (!id || !boardUrl || !Number.isInteger(Number(id))) {
        throw new Error(`STATIONS entry "${entry}" should look like 1=http://host:3180`);
      }
      return { id: Number(id), boardUrl };
    });
}

/** Where the server looks stations up; a fixed list in tests, the registry in production. */
export interface StationDirectory {
  get(id: number): Station | undefined;
  /** By station number. */
  list(): Station[];
}

export const isRegistry = (stations: StationDirectory): stations is StationRegistry =>
  "add" in stations;

export const fixedDirectory = (stations: Station[]): StationDirectory => {
  const byId = new Map(stations.map((s) => [s.id, s]));
  return { get: (id) => byId.get(id), list: () => [...byId.values()] };
};

export class StationConfigError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409) {
    super(message);
    this.status = status;
  }
}

/** The stations configured in /admin, each wired to its board; changes apply immediately. */
export interface StationRegistry extends StationDirectory {
  configs(): StationConfig[];
  /** Without an id, the station gets the number after the highest one. */
  add(input: { id?: unknown; name?: unknown; boardUrl?: unknown }): StationConfig;
  update(id: number, changes: { name?: unknown; boardUrl?: unknown }): StationConfig;
  /** Refused while the station has a match. */
  remove(id: number): void;
  /** Whether this start seeded the stations from `STATIONS`. */
  readonly seeded: boolean;
  close(): void;
}

function checkUrl(value: unknown): string {
  try {
    const url = new URL(String(value));
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  } catch {}
  throw new StationConfigError("the board address should look like http://192.168.1.139:3180", 400);
}

const cleanName = (value: unknown, id: number) =>
  String(value ?? "")
    .trim()
    .replace(/\s+/g, " ") || `Station ${id}`;

export function createStationRegistry(
  db: Db,
  options: {
    seed?: string | undefined;
    gatewayOptions?: Partial<BoardGatewayOptions>;
    /** At most this many stations (boards); extra ones without a match are removed at start. */
    maxStations?: number | undefined;
  } = {},
): StationRegistry {
  interface Entry {
    station: Station;
    gateway: BoardGateway;
  }
  const entries = new Map<number, Entry>();

  function connect(entry: Entry, boardUrl: string) {
    entry.gateway = createBoardGateway({
      ...options.gatewayOptions,
      url: boardUrl,
      onEvent: (event) => entry.station.handleBoardEvent(event),
    });
  }

  function start(config: StationConfig) {
    const entry = {} as Entry;
    entry.station = createStation({
      id: config.id,
      db,
      board: {
        reset: () => entry.gateway.reset(),
        start: () => entry.gateway.start(),
        stop: () => entry.gateway.stop(),
        calibrate: () => entry.gateway.calibrate(),
        stats: () => entry.gateway.stats(),
      },
    });
    connect(entry, config.boardUrl);
    entries.set(config.id, entry);
  }

  // Seed once per database, so removing every station in /admin doesn't bring them back.
  let seeded = false;
  if (options.seed && !db.stationsSeeded() && db.stationConfigs().length === 0) {
    for (const { id, boardUrl } of parseStationsConfig(options.seed)) {
      db.saveStation({ id, name: `Station ${id}`, boardUrl });
    }
    seeded = true;
  }
  if (options.seed) db.markStationsSeeded();
  const max = options.maxStations;
  const configs = [...db.stationConfigs()].sort((a, b) => a.id - b.id);
  for (const [i, config] of configs.entries()) {
    if (max !== undefined && i >= max && !db.openMatchOn(config.id)) {
      db.deleteStation(config.id);
      continue;
    }
    start(config);
  }

  const sorted = () => [...entries.entries()].sort(([a], [b]) => a - b).map(([, e]) => e);

  return {
    seeded,
    get: (id) => entries.get(id)?.station,
    list: () => sorted().map((e) => e.station),
    configs: () => db.stationConfigs(),
    add(input) {
      const highest = Math.max(0, ...entries.keys());
      const id = input.id === undefined ? highest + 1 : Number(input.id);
      if (!Number.isInteger(id) || id < 1) {
        throw new StationConfigError("the station number must be a whole number from 1", 400);
      }
      if (entries.has(id)) throw new StationConfigError(`station ${id} already exists`, 409);
      if (max !== undefined && entries.size >= max) {
        throw new StationConfigError(
          max === 1 ? "only one board is set up here" : `at most ${max} boards`,
          409,
        );
      }
      const config = { id, name: cleanName(input.name, id), boardUrl: checkUrl(input.boardUrl) };
      db.saveStation(config);
      start(config);
      return config;
    },
    update(id, changes) {
      const entry = entries.get(id);
      const current = db.getStationConfig(id);
      if (!entry || !current) throw new StationConfigError("no such station", 404);
      const config = {
        id,
        name: changes.name === undefined ? current.name : cleanName(changes.name, id),
        boardUrl: changes.boardUrl === undefined ? current.boardUrl : checkUrl(changes.boardUrl),
      };
      db.saveStation(config);
      if (config.boardUrl !== current.boardUrl) {
        // Same station (its match and live viewers stay), different board.
        entry.gateway.close();
        entry.station.handleBoardEvent({ type: "BoardOffline" });
        connect(entry, config.boardUrl);
      }
      return config;
    },
    remove(id) {
      const entry = entries.get(id);
      if (!entry) throw new StationConfigError("no such station", 404);
      if (entry.station.view().match) {
        throw new StationConfigError("the station has a match; close or end it first", 409);
      }
      entry.gateway.close();
      entries.delete(id);
      db.deleteStation(id);
    },
    close() {
      for (const entry of entries.values()) entry.gateway.close();
    },
  };
}

export interface RunningStation {
  station: Station;
  close(): void;
}

/** A single station wired to its board, outside the registry (tests). */
export function startStation(
  config: Omit<StationConfig, "name">,
  db: Db,
  gatewayOptions: Partial<BoardGatewayOptions> = {},
): RunningStation {
  const station = createStation({
    id: config.id,
    db,
    board: {
      reset: () => gateway.reset(),
      start: () => gateway.start(),
      stop: () => gateway.stop(),
      calibrate: () => gateway.calibrate(),
      stats: () => gateway.stats(),
    },
  });
  const gateway = createBoardGateway({
    ...gatewayOptions,
    url: config.boardUrl,
    onEvent: (event) => station.handleBoardEvent(event),
  });
  return { station, close: () => gateway.close() };
}
