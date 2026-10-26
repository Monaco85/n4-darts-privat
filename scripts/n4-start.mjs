// Startet n4-darts mit genau einem Dartautomaten: Server (:3000) und Web-Oberflaeche (:5173), dazu
//  - ohne Argument ein simuliertes Board (:3180), oder
//  - mit `--board <adresse>` das echte Autodarts-Board (Board Manager 2, Port 3180) fuer Station 1.
// Aufruf aus dem n4-darts-Ordner: node scripts/n4-start.mjs [--board http://localhost:3180]
// (oder start-windows.cmd / start-echtes-board.cmd doppelklicken)
import { spawn } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { board: { type: "string" } } });
const board = values.board?.replace(/\/+$/, "") ?? null;
const real = board !== null;

const root = join(import.meta.dirname, "..");
const env = {
  ...process.env,
  STATIONS: `1=${real ? board : "http://localhost:3180"}`,
  // Ein Dartautomat: weitere Stationen werden beim Start entfernt und lassen sich nicht anlegen.
  MAX_STATIONS: "1",
};
const parts = [
  ...(real
    ? []
    : [
        [
          "sim   ",
          "tools/board-sim",
          ["--experimental-strip-types", "src/cli.ts", "--boards", "1"],
        ],
      ]),
  [
    "server",
    "packages/server",
    ["--watch", "--conditions=source", "--experimental-strip-types", "src/main.ts"],
  ],
  ["web   ", "packages/web", [join("node_modules", "vite", "bin", "vite.js")]],
];

const kids = parts.map(([tag, dir, args]) => {
  const p = spawn(process.execPath, args, { cwd: join(root, dir), env });
  const out = (d) => {
    for (const line of String(d).split(/\r?\n/)) if (line) console.log(`[${tag}] ${line}`);
  };
  p.stdout.on("data", out);
  p.stderr.on("data", out);
  p.on("exit", (c) => console.log(`[${tag}] beendet (Code ${c})`));
  return p;
});

const stop = () => {
  for (const k of kids) k.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function up(url, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Station 1 auf das echte Board stellen (STATIONS gilt nur fuer eine neue Datenbank). */
async function pointStationAtBoard() {
  const body = JSON.stringify({ name: "Station 1", boardUrl: board });
  const headers = { "content-type": "application/json" };
  const res = await fetch("http://localhost:3000/api/admin/stations/1", {
    method: "PATCH",
    headers,
    body,
  });
  if (res.status === 404) {
    await fetch("http://localhost:3000/api/admin/stations", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: 1, name: "Station 1", boardUrl: board }),
    });
  } else if (!res.ok) {
    console.log(
      `Hinweis: Station 1 nicht umgestellt (${res.status}). In /admin -> Stations pruefen.`,
    );
  }
}

/** Fragt den Board Manager nach seiner Version; null, wenn niemand antwortet. */
async function boardVersion() {
  try {
    const res = await fetch(`${board}/api/version`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? (await res.text()).trim() : null;
  } catch {
    return null;
  }
}

const ready =
  (await up("http://localhost:5173/")) && (await up("http://localhost:3000/api/health"));
if (!ready) {
  console.log("Start hat zu lange gedauert - siehe Meldungen oben.");
} else {
  if (real) await pointStationAtBoard();
  else await up("http://localhost:3180/");
  const version = real ? await boardVersion() : null;

  console.log("\n================================================");
  console.log(" n4-darts laeuft!");
  console.log("  Station 1 : http://localhost:5173/station/1");
  if (real) {
    console.log(`  Board     : ${board}`);
    console.log(
      version
        ? `  Autodarts Board Manager gefunden, Version ${version}`
        : "  ACHTUNG: Unter dieser Adresse antwortet kein Autodarts Board Manager!\n" +
            "           Laeuft Autodarts? Stimmt die Adresse? Siehe README-Abschnitt Windows.",
    );
  } else {
    console.log("  Fake-Board: http://localhost:3180/");
  }
  console.log("  Admin     : http://localhost:5173/admin");
  console.log(" Beenden: dieses Fenster schliessen oder Strg+C");
  console.log("================================================\n");
  if (process.platform === "win32" && !process.env.N4_NO_BROWSER) {
    spawn("explorer.exe", ["http://localhost:5173/station/1"], { detached: true });
    if (!real) spawn("explorer.exe", ["http://localhost:3180/"], { detached: true });
  }
}
