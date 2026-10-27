// Baut die fertigen Pakete: release/n4-darts-windows.zip und release/n4-darts-linux.tar.gz.
// Darin: server.mjs und sim.mjs (je eine Datei, ohne node_modules), die gebaute Oberflaeche,
// die Start-Dateien, die Anleitung und eine Kurzanleitung. Auf dem PC braucht es nur Node.js 22+.
// Aufruf aus dem n4-darts-Ordner nach `pnpm install`: node scripts/package.mjs
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Gemeinsam fuer beide Pakete; Linux bekommt danach eine Kopie ohne die Windows-Dateien.
cpSync(join(root, "docs", "anleitung.html"), join(out, "anleitung.html"));
cpSync(join(root, "packages", "web", "dist"), join(root, "release", "linux", "n4-darts", "web"), {
  recursive: true,
});
for (const file of ["server.mjs", "sim.mjs", "anleitung.html"])
  cpSync(join(out, file), join(root, "release", "linux", "n4-darts", file));

console.log("== Start-Dateien (Windows)");
const crlf = (text) => text.replace(/\r?\n/g, "\r\n");
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

Ausfuehrliche Anleitung: anleitung.html (im Browser oeffnen)

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

console.log("== Start-Dateien (Linux)");
const linux = join(root, "release", "linux", "n4-darts");
const lf = (text) => text.replace(/\r\n/g, "\n");
const script = (name, text) => {
  writeFileSync(join(linux, name), lf(text));
  chmodSync(join(linux, name), 0o755);
};
script("start.sh", readFileSync(join(root, "scripts", "release", "start.sh"), "utf8"));
script("autostart.sh", readFileSync(join(root, "scripts", "release", "autostart.sh"), "utf8"));
const wrapper = (args) => `#!/usr/bin/env bash
exec "$(dirname "$(readlink -f "\${BASH_SOURCE[0]}")")/start.sh" ${args}"$@"
`;
script("darts-starten.sh", wrapper(""));
script("darts-simulator.sh", wrapper("--simulator "));
writeFileSync(
  join(linux, "LIESMICH.txt"),
  `n4-darts - lokal Darts spielen, ohne Internet (Stand ${commit}, Linux)

Ausfuehrliche Anleitung: anleitung.html (im Browser oeffnen)

Starten (im Terminal in diesem Ordner)
  ./darts-starten.sh     mit dem echten Autodarts-Board (Autodarts muss laufen, Port 3180)
  ./darts-simulator.sh   zum Ausprobieren mit einem Board zum Anklicken
  Optionen: --board 192.168.178.50 (Adresse vorgeben), --no-browser (keinen Browser oeffnen)

Danach im Browser: http://localhost:3000/station/1
Beenden: Strg+C im Terminal.

Autostart beim Einschalten:  ./autostart.sh   (mit --kiosk: Station im Vollbild nach dem Anmelden)
Autostart abschalten:        ./autostart.sh --entfernen

Spiele: X01 (301/501/701), Cricket, Around the World, Elimination - allein oder mit 2-8 Spielern.
Daten: Spieler, Spiele und Statistiken liegen im Ordner "data" (n4-darts.db);
       die Statistik je Spieler und Spiel zusaetzlich lesbar in data/spieler-stats.json.
       Beim Aktualisieren den Ordner "data" behalten!
Voraussetzung: Node.js 22 oder neuer. Fehlt es, laedt start.sh es einmalig in den Ordner "node"
(ohne Root-Rechte, x64 und arm64).
`,
);

console.log("== Pakete packen");
const zip = join(root, "release", "n4-darts-windows.zip");
run("zip", ["-qr", zip, "n4-darts"], { cwd: join(root, "release"), shell: false });
const tgz = join(root, "release", "n4-darts-linux.tar.gz");
run("tar", ["-czf", tgz, "--owner=0", "--group=0", "n4-darts"], {
  cwd: join(root, "release", "linux"),
  shell: false,
});
console.log(`Fertig: ${zip}\nFertig: ${tgz}`);
