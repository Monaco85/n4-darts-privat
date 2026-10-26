import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.ts";
import { startBackups } from "./backups.ts";
import { openDb } from "./db.ts";
import { createStationRegistry } from "./stations.ts";

const port = Number(process.env.PORT ?? 3000);
const webDir = process.env.WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
const dataDir = process.env.DATA_DIR ?? "data";
// Seeds the stations once, on a fresh database; after that they're managed in /admin.
const seed = process.env.STATIONS ?? "1=http://localhost:3180";

const adminPin = process.env.ADMIN_PIN || undefined;

mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, "n4-darts.db"));
const backups = startBackups(db, join(dataDir, "backups"));
// MAX_STATIONS=1: one board only (the Windows start scripts set it).
const maxStations = Number(process.env.MAX_STATIONS) || undefined;
const stations = createStationRegistry(db, { seed, maxStations });

const app = buildApp({ webDir, stations, db, adminPin, scheduler: {}, statsDir: dataDir });
await app.listen({ host: "0.0.0.0", port });
console.log(`n4-darts listening on http://0.0.0.0:${port}`);
if (!adminPin) console.warn("ADMIN_PIN is not set: /admin is open to everyone on the network");
if (stations.seeded)
  console.log("stations seeded from STATIONS; manage them in /admin from now on");
else if (process.env.STATIONS) console.log("STATIONS ignored: stations are managed in /admin");
console.log(`player stats are kept in ${join(dataDir, "spieler-stats.json")}`);
for (const config of stations.configs()) {
  console.log(`station ${config.id} (${config.name}) → board ${config.boardUrl}`);
}

const shutdown = async () => {
  backups.stop();
  stations.close();
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
