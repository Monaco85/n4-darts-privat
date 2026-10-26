// Baut das fertige Windows-Paket: release/n4-darts-windows.zip.
// Darin: server.mjs und sim.mjs (je eine Datei, ohne node_modules), die gebaute Oberflaeche,
// die Start-Dateien und eine Kurzanleitung. Auf dem PC braucht es nur Node.js 22+.
// Aufruf aus dem n4-darts-Ordner nach `pnpm install`: node scripts/package.mjs
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const out = join(root, "release", "n4-darts");
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32", ...opts });

rmSync(join(root, "release"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

console.log("== Oberflaeche bauen");
run("npx", ["-y", "pnpm@12.14.0", "--filter", "@n4/web", "build"]);
cpSync(join(root, "packages", "web", "dist"), join(out, "web"), { recursive: true });

console.log("== Server und Simulator buendeln");
// Fastify ist CommonJS; im ESM-Bundle braucht es dafuer ein require.
const banner =
  "import { createRequire as __n4Require } from 'node:module'; const require = __n4Require(import.meta.url);";
for (const [entry, file] of [
  ["packages/server/src/main.ts", "server.mjs"],
  ["tools/board-sim/src/cli.ts", "sim.mjs"],
]) {
  run("npx", [
    "-y",
    "esbuild@0.25.11",
    entry,
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node22",
    "--conditions=source",
    `--banner:js=${banner}`,
    "--log-level=warning",
    `--outfile=${join(out, file)}`,
  ]);
}

console.log("== Start-Dateien");
const crlf = (text) => text.replace(/\r?\n/g, "\r\n");
cpSync(join(root, "scripts", "release", "start.ps1"), join(out, "start.ps1"));
writeFileSync(
  join(out, "start.ps1"),
  crlf(readFileSync(join(root, "scripts", "release", "start.ps1"), "utf8")),
);
const cmd = (title, args) =>
  crlf(`@echo off
title ${title}
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" ${args}
echo.
pause
`);
writeFileSync(join(out, "Darts starten.cmd"), cmd("n4-darts", ""));
writeFileSync(join(out, "Darts Simulator.cmd"), cmd("n4-darts - Simulator", "-Simulator"));
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).toString().trim();
writeFileSync(
  join(out, "LIESMICH.txt"),
  crlf(`n4-darts - lokal Darts spielen, ohne Internet (Stand ${commit})

Starten
  Darts starten.cmd    mit dem echten Autodarts-Board (Autodarts muss laufen, Port 3180)
  Darts Simulator.cmd  zum Ausprobieren mit einem Board zum Anklicken

Danach im Browser: http://localhost:3000/station/1
Beenden: das schwarze Fenster schliessen.

Spiele: X01 (301/501/701), Cricket, Around the World, Elimination - allein oder mit 2-8 Spielern.
Daten: Spieler, Spiele und Statistiken liegen im Ordner "data" (n4-darts.db);
       die Statistik je Spieler und Spiel zusaetzlich lesbar in data\\spieler-stats.json.
       Beim Aktualisieren den Ordner "data" behalten!
Voraussetzung: Node.js 22 oder neuer (wird beim ersten Start bei Bedarf installiert).
`),
);

console.log("== ZIP packen");
const zip = join(root, "release", "n4-darts-windows.zip");
run("zip", ["-qr", zip, "n4-darts"], { cwd: join(root, "release"), shell: false });
console.log(`Fertig: ${zip}`);
