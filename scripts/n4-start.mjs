// Startet n4-darts mit zwei simulierten Boards: Server (:3000), Web (:5173), Board-Sim (:3180/:3181).
// Aufruf aus dem n4-darts-Ordner: node scripts/n4-start.mjs (oder start-windows.cmd doppelklicken)
import { spawn } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const env = { ...process.env, STATIONS: "1=http://localhost:3180,2=http://localhost:3181" };
const parts = [
  ["sim   ", "tools/board-sim", ["--experimental-strip-types", "src/cli.ts", "--boards", "2"]],
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

async function up(url) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

if ((await up("http://localhost:5173/")) && (await up("http://localhost:3180/"))) {
  console.log("\n================================================");
  console.log(" n4-darts laeuft!");
  console.log("  Station 1 : http://localhost:5173/station/1");
  console.log("  Fake-Board: http://localhost:3180/");
  console.log("  Admin     : http://localhost:5173/admin");
  console.log(" Beenden: dieses Fenster schliessen oder Strg+C");
  console.log("================================================\n");
  if (process.platform === "win32" && !process.env.N4_NO_BROWSER) {
    spawn("explorer.exe", ["http://localhost:5173/station/1"], { detached: true });
    spawn("explorer.exe", ["http://localhost:3180/"], { detached: true });
  }
} else {
  console.log("Start hat zu lange gedauert - siehe Meldungen oben.");
}
