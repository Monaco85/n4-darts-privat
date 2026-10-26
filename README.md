# n4-darts
offline dart platform using Autodarts scoring capabilities

See `docs/architecture.md` for the design and `docs/adr/` for the key decisions.

## Layout

| Path              | What                                                       |
| ----------------- | ---------------------------------------------------------- |
| `packages/engine` | Pure game rules (X01), no dependencies, shared with the UI |
| `packages/server` | Node server: board gateway, matches, tournaments, API      |
| `packages/web`    | React app: `/station/n`, `/admin`, `/display`              |
| `tools/board-sim` | Fake Autodarts Board Manager for development and tests     |

## Windows (lokal, ohne Internet)

- **Simulator:** `start-windows.cmd` doppelklicken. Installiert bei Bedarf Node.js und die Abhaengigkeiten und startet Server, Oberflaeche und zwei simulierte Boards. Danach oeffnen sich Station 1 (<http://localhost:5173/station/1>) und das Fake-Board (<http://localhost:3180/>).
- **Echtes Board:** Autodarts starten (der Board Manager muss auf Port 3180 antworten, z. B. <http://localhost:3180/api/version>), dann `start-echtes-board.cmd` doppelklicken und die Adresse des Autodarts-PCs eingeben (Enter = dieser PC). Station 1 wird auf dieses Board gestellt; der Simulator laeuft dabei nicht, sonst wuerde er Port 3180 belegen.
- Ohne Windows: `node scripts/n4-start.mjs` (Simulator) bzw. `node scripts/n4-start.mjs --board http://<ip>:3180` nach `pnpm install`.

## Run it locally

Play the whole thing on your laptop with two fake boards instead of real ones.

```sh
pnpm install
pnpm dev:sim
```

This starts four things side by side. Ctrl-C stops all of them.

| Page                               | What it is                                                         |
| ---------------------------------- | ------------------------------------------------------------------ |
| <http://localhost:5173/>           | The app, with links to the stations and admin                      |
| <http://localhost:5173/station/1>  | Station 1: start a match, scoreboard, correct darts                |
| <http://localhost:5173/station/2>  | Station 2                                                          |
| <http://localhost:5173/admin>      | Admin: tonight's tournament, players, stations, matches, history   |
| <http://localhost:5173/display>    | Projector: the tournament with live scores, or the leaderboard     |
| <http://localhost:5173/watch/1>    | Projector: station 1's scoreboard, nothing to press                |
| <http://localhost:5173/players>    | Leaderboard; a name opens that player's stats                      |
| <http://localhost:3180/>           | Fake board for station 1: click the dartboard to throw             |
| <http://localhost:3181/>           | Fake board for station 2                                           |

The app runs on the Vite dev server (:5173), which reloads on every code change and forwards `/api` to the n4-darts server (:3000).

**Playing a leg:** open `/station/1` and a fake board side by side. On the station, pick two or more players (add them right there, or in `/admin`), set the order and press **Start**. Click the board three times, then press **Takeout** on the fake board to end the visit, as a player pulling their darts would. On the fake board you can also:

- tap a listed dart, then a spot on the board, to change it (as if Autodarts corrected itself)
- type a dart like `T20`, `D16`, `BULL` and press enter
- press **Reset** (as if someone pressed reset on the station laptop), **Stop** / **Start**, or **Go offline** to see how the station copes

**Board menu:** the ⋮ next to the board status on a station page stops or starts detection, calibrates the board and resets it, so players never have to leave the kiosk browser. The status shows "Board stopped" while detection is off. The same menu is on every station in `/admin` → Stations.

**Photos:** in `/admin` → Players, tap a player's avatar to add a photo (camera or gallery on a phone), crop it to the circle and save. Photos show on the station, the projector and the stats pages; players without one get their initials.

**Options**, set in front of the command:

```sh
ADMIN_PIN=1234 pnpm dev:sim   # lock /admin behind a PIN (open without one)
PORT=3100 pnpm dev:sim        # server on another port, e.g. when Docker already uses 3000
```

The dev database is `packages/server/data/n4-darts.db`; `pnpm db:reset` (with the server stopped) clears it to start over.

If pnpm 12 isn't installed, put `npx -y pnpm@12.14.0` in front of every `pnpm` command, e.g. `npx -y pnpm@12.14.0 dev:sim`.

### Without the simulator (real boards)

```sh
STATIONS=1=http://192.168.1.139:3180 pnpm dev   # dev mode: app on :5173, server on :3000
pnpm build && pnpm start                        # production mode: everything on :3000
```

`STATIONS` (number = Board Manager address, comma-separated) only seeds the stations on a fresh database; after that it's ignored and you change board addresses in `/admin` → Stations. `pnpm dev` shares its database with `pnpm dev:sim`, so if you've used the simulator, station 1 still points at `localhost:3180`: change it in `/admin`, or start over with `pnpm db:reset`. `pnpm start` keeps its own database in `data/` at the repo root (`DATA_DIR` to change it).

### With Docker

```sh
docker build -t n4-darts .
docker run --rm -p 3000:3000 -v n4-data:/data \
  -e STATIONS=1=http://192.168.1.139:3180 -e ADMIN_PIN=1234 n4-darts
```

Then open <http://localhost:3000>. To run the published image instead, use `ghcr.io/sverbach/n4-darts:latest` in place of `n4-darts`.

## Running a tournament

Everything happens in `/admin` → **Tournament**, on the organiser's phone.

1. **Set it up.** Pick tonight's players and press **Create draft**. Choose the format (groups, how many advance, single or double elimination), the legs per phase and the game (start score, in/out). The draft shows the seeds (by recent 3-dart average; new players last in a random order, ↑/↓ to change), the groups, and how long it'll take. Players and format can still change after starting, until the first match is played.
2. **Start it.** From now on the server runs the evening: it puts the next match on every free station as soon as both players are free (round by round, longest-rested first), builds the knockout when the groups are done, and moves winners (and, in double elimination, losers) on until there's a champion. Players walk up, set who throws first, press **Start** and play. After the checkout, **Done** frees the station; if nobody presses it, that happens by itself after a minute.
3. **Step in when needed.** The Tournament tab shows the stations, the queue, the group tables and the bracket, and refreshes by itself.
   - **Pause** a station to keep it out of the tournament (e.g. for casual throws); its current match carries on.
   - **Hold** a match while a player is away; it's skipped until you release it.
   - **Send back** a match that's waiting on a station but hasn't started; **Play now on…** puts a chosen match on a station out of order; a match can also be kept for **only** one station.
   - **Withdraw** a player who leaves: their remaining matches become walkovers. A **late arrival** can still join during the group phase.
   - Fix a misdetected dart from **Matches → History**. A correction that would change a result a later match already depends on is refused, with that match named.
4. **The end.** The champion, the final placings and the evening's awards (best match average, highest checkout, most 180s, best leg) stay on the tab until you start the next tournament. **End tournament early** stops everything without a champion.

**On the projector:** open `/display` in the projector's browser (full screen, e.g. F11) and leave it. It follows the evening by itself: live scores of every station and what's up next beside the group tables, then the bracket, then the champion, placings and awards. Without a tournament it shows the stations and the leaderboard. Tap a station card (or open `/watch/1`) to put one station's scoreboard on screen; go back to `/display` when you're done. Both pages fit any screen size without scrolling.

**Stats:** every finished match counts towards the players' long-term stats (not walkovers or abandoned matches), whatever kind of match it was. `/players` ranks everyone by rating; a profile shows averages, checkout %, 180s, best leg, results, the average per evening, tournaments and recent matches. Both pages are public, so players can look themselves up on their phones.

**Try it locally:** run `pnpm dev:sim`, add a few players in `/admin`, create and start a tournament, then play the matches that appear on `/station/1` and `/station/2` by clicking the two fake boards (<http://localhost:3180/>, <http://localhost:3181/>). Set every phase to best of 1 for a quick test evening; typing darts on the fake board (`T20`, enter, three times) is faster than clicking.

## Development

Requires Node 22+ and pnpm 12 (`npm i -g pnpm@12`, or prefix the commands with `npx pnpm@12`).

```sh
pnpm install
pnpm test        # all tests, run against TypeScript sources
pnpm lint        # biome
pnpm typecheck
pnpm sim         # fake board on :3180 (station 1's default board)
pnpm dev         # server on :3000 + web dev server (proxies /api to :3000)
pnpm dev:sim     # the same plus two fake boards on :3180/:3181 wired to stations 1 and 2
pnpm build && pnpm start   # production build, served on :3000
pnpm build && pnpm e2e     # browser tests (Playwright, Chromium) against the production build
pnpm e2e --ui              # the same, in Playwright's UI for debugging
```

### Browser tests

`packages/e2e` runs the built app on :4300 with two fake boards on :4381/:4382, a fresh database and the admin PIN 4242, so it can run next to `pnpm dev:sim`. The tests cover the station, the board menu, `/display` and `/watch`, and `/admin` (PIN, a small tournament, a correction), at phone width (390 px) and desktop width (1440 px). They also time each dart from the board to the station page over a 300-dart match: it fails above 150 ms. Run `pnpm build` first, since the tests use the build, not the sources. The first time, install the browser with `pnpm --filter @n4/e2e exec playwright install chromium`. CI runs them in their own job, and on a failure the report and traces are uploaded as the `playwright-report` artifact.

### Board simulator

A fake Autodarts Board Manager (same API as the real one, see `docs/board-manager-api.md`). Each fake board serves a control page at its own address, e.g. <http://localhost:3180/>. Click the dartboard to throw, tap a listed dart and then the board to revise it, and use the buttons for takeout, bounce-out, an outside reset (as if pressed on the laptop), stop/start and offline.

For a full session without a real board, see [Run it locally](#run-it-locally).

```sh
pnpm sim --port 3180                       # one board; --boards 2 for 3180 and 3181. Or by hand:
curl -X POST localhost:3180/sim/dart -d '{"name":"T20"}'   # S20 SO20 D20 T20 25 BULL M17 BOUNCE
curl -X POST localhost:3180/sim/takeout
pnpm sim --replay prototypes/recordings/2026-10-18-board1.txt --speed 10
```

## Running on the server

Every push to `main` that passes CI publishes `ghcr.io/sverbach/n4-darts:latest` (and a tag per commit SHA). On the server, next to `docker-compose.yml`:

```sh
docker compose pull && docker compose up -d   # latest published image
docker compose up -d --build                  # or build from the checkout instead
```

Serves on port 3000 (override with `N4_PORT=8080`). Data lives in the `n4-data` volume.
Stations are managed in `/admin` (Stations tab). On the very first start they're seeded from `N4_STATIONS`, e.g. `N4_STATIONS=1=http://192.168.1.139:3180,2=http://192.168.1.140:3180`; after that the variable is ignored. Lock `/admin` with `N4_ADMIN_PIN=1234`.

Open `http://<server>:3000/station/1` on the station laptop (and on any phone that should control it).

### Behind a reverse proxy

The app is meant for the local network: apart from the `/admin` PIN there's no login, so don't expose it to the internet. If you still put a proxy in front, the live updates (Server-Sent Events on `/api/*/live`) need it to pass messages through straight away. nginx works out of the box: the streams send `X-Accel-Buffering: no`. For other proxies, turn response buffering and compression off for `/api/*/live`; otherwise darts show up seconds late.

### Backups

The server copies its database once a day (at start if the last copy is more than a day old, then whenever a day has passed) to `backups/` next to the database, as `n4-darts-YYYY-MM-DD-HHmm.db` (server time: UTC in Docker unless you set `TZ`), and keeps the newest 30. In Docker that's `/data/backups` in the `n4-data` volume; with `pnpm start` it's `data/backups/`. They're on the same disk as the database, so copy one elsewhere now and then.

To restore one in Docker:

```sh
docker compose stop
docker compose run --rm --no-deps --entrypoint sh n4-darts -c \
  'cd /data && rm -f n4-darts.db-wal n4-darts.db-shm && cp backups/n4-darts-2026-10-20-2315.db n4-darts.db'
docker compose up -d
```

Without Docker: stop the server, copy the backup over `n4-darts.db`, delete `n4-darts.db-wal` and `n4-darts.db-shm`, start it again.
