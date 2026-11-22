# Running the Netquel tracker on a host

The Netquel scraper is the only part of the bot that needs a browser. netquel.com
publishes no API — the leaderboards are painted by a WASM/WebGL client over a
WebSocket — so the tracker drives a real Chrome/Chromium over the DevTools
protocol and reads the rendered tables. Without a browser binary the tracker
switches itself off and the rest of the bot runs normally.

## Is it running?

The boot log says one of these:

```
🛰️ Netquel tracker armed — site tables every 1 day, server boards resident (poll 2s), cards every 10 min.
```

```
🛰️ Netquel tracker disabled — no Chrome/Chromium found on this host.
```

If it says "disabled", the bot is fine; only the board channels and `/reload`
are affected. `/reload` in Discord prints the same reason.

Every one of those lines is also appended to `netquel-tracker.log` next to
`index.js` (with a timestamp, capped at 512 KB), so a panel that shows no
console can still tell you what the tracker did. Open that file in the panel's
file manager after a restart.

## Where the scraper looks for a browser

1. `NETQUEL_CHROME_PATH` (wins over everything)
2. A hand-uploaded folder: `chrome/chrome`, `chrome/chrome-linux64/chrome` or
   `chrome-linux64/chrome` next to `index.js`, the same names in the working
   directory, and `/chrome/chrome` at the container root
3. `.netquel-chrome/chrome-linux64/chrome` (installed by `npm run netquel:install-chrome`)
4. `~/.cache/puppeteer/chrome/*/chrome-linux64/chrome` (puppeteer installs)
5. `~/.cache/ms-playwright/*/chrome-linux/chrome` (Playwright installs)
6. Standard macOS / Windows / Linux locations:
   `/usr/bin/google-chrome`, `/usr/bin/chromium`, `/usr/bin/chromium-browser`,
   `/snap/bin/chromium`, `/opt/google/chrome/chrome`, `/usr/lib/chromium/chromium`

So a browser uploaded as `chrome/chrome`, installed into `.netquel-chrome/` or
into the home directory is picked up with no config at all. If it is not
executable the tracker sets the mode itself; only an unwritable file still needs
`chmod +x`. Anywhere else needs `NETQUEL_CHROME_PATH`.

Uploaded with the panel's file manager? Make sure the whole `chrome-linux64`
folder came along, not just the `chrome` binary — it needs its sibling `.so` and
`.pak` files.

## Route A — the host already has Chromium

Set one variable in the panel and restart:

```
NETQUEL_CHROME_PATH=/usr/bin/chromium
```

(use whatever `which chromium chromium-browser google-chrome` would print — ask
the host if you can't check).

## Route B — upload Chrome without a console

This needs only the panel's file manager, no shell.

1. On your own computer, download the Linux 64-bit Chrome build directly:

   <https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.78/linux64/chrome-linux64.zip>

   (~194 MB. This is the Stable channel build current at the time of writing.)

   To get a newer one later, open the download page
   <https://googlechromelabs.github.io/chrome-for-testing/> — it is a normal web
   page with a **Stable** section and a platform picker. The raw JSON index
   (`.../last-known-good-versions-with-downloads.json`) also lists every URL, but
   it opens as plain text, not as a page — that is probably why it looked broken.

   Direct links follow one pattern, so you can bump the version by hand:

   `https://storage.googleapis.com/chrome-for-testing-public/<version>/linux64/chrome-linux64.zip`

2. Download and unzip it. You get a folder named `chrome-linux64` containing an
   executable named `chrome`.
3. Upload that whole folder into the server's file manager, e.g.
   `/home/container/chrome/chrome-linux64/`.
4. Point the bot at it:

```
NETQUEL_CHROME_PATH=/home/container/chrome/chrome-linux64/chrome
```

5. Restart. The log should now say "armed".

If Chrome exits immediately on start, add:

```
NETQUEL_CHROME_NO_SANDBOX=1
```

Most game panels run without user namespaces, so Chrome's sandbox cannot start.
This is a real trade-off (the browser is no longer sandboxed) which is why it is
opt-in rather than automatic.

## Route B2 — let the bot install it (no console, no upload)

The bot installs its own browser. `scripts/install-netquel-chrome.js` runs in
two places:

- from `package.json`'s `postinstall`, whenever the panel installs dependencies;
- **at boot**, when the tracker finds no browser at all (panels that only
  restart the process never run `npm install`, so this is the path that usually
  matters). The boot log then says
  `🛰️ Netquel tracker: no browser found — downloading one now` and, a minute
  later, `🛰️ Netquel browser ready: …` followed by `armed`.

On a Linux host with no browser it downloads the official Chrome for Testing
build into `.netquel-chrome/` next to the bot and unpacks it there; the scraper
looks in that folder first, so a restart is all that's left. Upload
`package.json`, `scripts/install-netquel-chrome.js` and
`systems/netquel/netquelService.js` to get this behaviour, then restart.

- Skips itself off Linux and whenever a browser already exists.
- Never fails `npm install` — every error exits 0 and prints what to do.
- Needs `unzip`, `python3` or `bsdtar` on the host to unpack; if none exists,
  fall back to Route B (upload the zip yourself).
- Uses ~200 MB down and ~350 MB on disk.

You can also run it directly from the panel if it offers a script runner:

```
npm run netquel:install-chrome
```

## Route C — the panel has a startup command / install script

If the panel runs a command you control, install and run in one line (Debian/
Ubuntu image, network access, writable home):

```
npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer && node index.js
```

The install prints the binary path; the scraper finds it in
`~/.cache/puppeteer` automatically on the next boot.

## When Chrome starts but the boards still fail

| Log line | Meaning | Fix |
|---|---|---|
| `Browser exited during startup (code N)` | Sandbox or missing library | Set `NETQUEL_CHROME_NO_SANDBOX=1`; if it persists, see the `ldd` check below |
| `error while loading shared libraries: libnss3.so` | Container lacks Chrome's system libraries | Host must install `libnss3 libatk1.0-0 libatk-bridge2.0-0 libgbm1 libasound2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libcups2 libdrm2 libpango-1.0-0 libcairo2` — no root means host support |
| `Browser started but never exposed a debugging target` | Chrome is up but its sandbox can't start (normal on game panels), or the renderer died — the `Browser said: …` tail names the cause | The tracker already retries once without the sandbox automatically; if it still fails, read the quoted stderr |
| `The Netquel client reported "WebGL2 unsupported"` | SwiftShader could not initialise | Host CPU/emulation limits; a different host is the answer |
| `Timed out waiting for the leaderboard to render` | Page loaded, feed never painted | Usually network blocking `wss://` to netquel.com |

Library check, if you ever do get a shell:

```
ldd ~/.cache/puppeteer/chrome/*/chrome-linux64/chrome | grep "not found"
```

No output means every dependency is present.

## Route D — run the bot on a small VPS

The browsers are heavy (roughly 300–500 MB RAM each, and a core during a
sweep), which is why shared game hosts usually can't do it. A ~$5/mo VPS where
you control the OS lets you:

```
sudo apt update && sudo apt install -y chromium
NETQUEL_CHROME_PATH=/usr/bin/chromium
```

No code changes required.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `NETQUEL_CHROME_PATH` | auto-detect | Chrome/Chromium binary |
| `NETQUEL_CHROME_NO_SANDBOX` | off | `1` adds `--no-sandbox --disable-setuid-sandbox` |
| `NETQUEL_FFA_CHANNEL_ID` | built-in | Channel for the FFA board message |
| `NETQUEL_FORGE_CHANNEL_ID` | built-in | Channel for the Forge board message |
| `NETQUEL_SITE_REFRESH_SECONDS` | `86400` | How often the day/week/all tables reload; they are history, so once a day (15s floor) |
| `NETQUEL_SITE_REFRESH_MINUTES` | — | Older spelling of the same setting; used when the seconds var is unset |
| `NETQUEL_SERVER_REFRESH_SECONDS` | `30` | Sweep cadence, resident board-edit cadence (minimum gap between Discord edits per mode) and resident health-check interval (20s floor) |
| `NETQUEL_BOARD_MODE` | `resident` | `resident` keeps a joined tab per (mode, server) and polls the HUD; `sweep` is the old page-load-per-board path |
| `NETQUEL_RESIDENT_LIMIT` | `6` | Max resident tabs (6 = both modes on three servers; 3 = one mode) |
| `NETQUEL_RESIDENT_POLL_SECONDS` | `2` | HUD read cadence in resident mode (push updates still arrive immediately; Discord edits are capped separately) |
| `NETQUEL_RESIDENT_FPS` | `5` | Cap the game render loop in resident tabs; `0` means uncapped (60 fps). Timer-driven so hidden tabs keep updating |
| `NETQUEL_PUBLISH_MIN_MS` | `2000` | Burst-coalescing delay for Discord board edits; the actual per-channel cadence is capped by `NETQUEL_SERVER_REFRESH_SECONDS` |
| `NETQUEL_BLOCK_ADS` | `1` | Block ad/analytics requests in the tracker browsers |
| `NETQUEL_CARD_REFRESH_MINUTES` | `10` | How often the full profile-card pass runs; tracked enemies are captured on sight every cycle |
| `NETQUEL_DIRECT_SERVERS` | `1` | `0` forces the old wall-hop path instead of the numbered server hosts |
| `NETQUEL_REFRESH_MINUTES` | — | Older spelling of the server cadence; used when the seconds var is unset |

The per-server boards are the live data. Each Cloud server answers on its own
host (`4.netquel.com` is `Cloud/4`), so the tracker opens the server directly
instead of starting a match and flying through two walls. Channels are edited
as boards arrive rather than after the whole pass; resident mode caps that
edit cadence at `NETQUEL_SERVER_REFRESH_SECONDS` (see below).

`NETQUEL_BOARD_MODE=sweep` still pays one page load plus an arena entry per
board, which measured 48-115s for a six-board pass; that is why a 30-second
cadence did not mean 30-second boards. The default, `resident`, removes the
re-entry (see below).

Profile cards — the join date, high score, rank, streak and clan behind a name —
are captured by a separate, budgeted pass every 10 minutes. It reads one server
per turn and yields the browser to any board pass that comes due, so it never
holds the live boards behind a whole sweep. Each run clicks a rolling few names
per server; tracked enemies are clicked on every fast pass, and
`/netquel-players` refreshes its own names on demand. The site setting only
controls how often the historical day/week/all embeds are re-read (and edited).

## Resident live boards (fast refresh)

Resident mode (the default) keeps one joined game tab per (mode, server)
instead of re-entering the game for every read. The sweep costs a page load, a
WASM boot, a Play click and an arena wait per board (~10-15s); a resident
refresh is a DOM read every `NETQUEL_RESIDENT_POLL_SECONDS` (2s by default),
with a `MutationObserver` push as soon as the HUD repaints.

Measured on the development Mac (FFA + Forge on three servers, six tabs):
about 13s per tab to join at startup, then ~1 core and ~1 GB of summed RSS
while all six stream. That is why the six-tab default is safe here; measure the
actual host before raising `NETQUEL_RESIDENT_LIMIT`.

- One Chrome hosts every resident tab, with its profile in
  `.netquel-resident-profile/`. `NETQUEL_RESIDENT_LIMIT` caps the tabs (6 is
  FFA + Forge on three servers; 3 is FFA only).
- The clients render in software, so CPU scales with the tab count. The game
  loop is capped at `NETQUEL_RESIDENT_FPS` (5 by default; `0` means uncapped
  60 fps) and ad/analytics requests are blocked (`NETQUEL_BLOCK_ADS=0`
  disables that). The cap is timer-driven, not native `requestAnimationFrame`:
  Chrome stops native frames for hidden tabs, so a native wrapper leaves every
  background board frozen on its last painted score while only the foreground
  tab advances. The resident page script also reports the document as visible
  and focused so the client's `visibilitychange` handler does not pause the
  match. Measure three tabs, then six, on the actual host before raising the
  limit.
- HUDs are read every `NETQUEL_RESIDENT_POLL_SECONDS`, but each mode's
  Discord message is edited at most once per `NETQUEL_SERVER_REFRESH_SECONDS`
  (30s). A quiet board still gets a heartbeat edit, so its `Updated` stamp
  reflects the last read instead of going stale. The in-memory snapshot and
  alerts still use every read.
- A dead tab, a client that leaves the arena, or a client that hops servers is
  re-joined automatically. The health check runs every
  `NETQUEL_SERVER_REFRESH_SECONDS` (30s).
- Each resident tab is also a real player, so it dies. The death screen hides
  the HUD behind `Play Again`; the tab is brought to the foreground, respawned
  and its board republished. If the button does not take, it falls back to a
  full arena rejoin. A profile-stats panel is never read as a board, and a
  hidden/stale tab can no longer freeze its board indefinitely.
- The bot keeps a ship in each arena while residents are on; that is the cost
  of the fast path. `NETQUEL_BOARD_MODE=sweep` returns to the old behaviour,
  which stays available for `/reload scope:servers` and as the fallback.

A healthy startup logs one line per tab:

```
🛰️ Netquel resident FFA Spiral: 7 row(s) · push on
```

## The resident site browser

The day/week/all tables are rendered by one Chrome that stays running for the
whole life of the tracker, with its profile in `.netquel-site-profile/` next to
`index.js`. The game client is a WASM download: a cold profile costs ~7s per
mode, a warm reload is ~1-1.5s, so the browser is deliberately kept instead of
being relaunched for every pass. The tables are read once a day by default, so
the browser sits idle between those passes.

- It costs memory. Measured while idle on macOS: **~660 MB summed RSS across 11
  processes** (shared pages are counted more than once there; the main browser
  process was ~180 MB), so budget a few hundred MB of real extra RAM. That is
  the price of never paying a cold start again.
- It is one visible tab, never two: Chrome freezes a background tab, and a
  frozen tab never paints the leaderboard.
- It is separate from the in-game server sweep. A server pass takes tens of
  seconds and no longer delays the tables: the site pass is not queued behind it.
- If a reload hangs, the tracker stops the stuck load, retries once, then
  relaunches the browser (with backoff) instead of disabling itself.
- The profile is removed when the tracker stops, so the next boot pays one cold
  render and is warm from then on. Delete the folder by hand if a killed run
  ever leaves it unusable — the tracker rebuilds it automatically as well.

A tracked enemy on a live server board pings the staff role, but at most once
per enemy per 10 minutes across every board. An AFK row still posts its
sighting without a ping. Separately, a live server-board score of 50,000+ pings
once per visit, whether or not the name is on the enemy list.

In `NETQUEL_BOARD_MODE=sweep`, a healthy pass logs the real cost:

```
🛰️ Netquel site boards reloaded in 2.4s (6 site boards; 1 channel(s) updated, 0 alert(s)).
🛰️ Netquel server boards refreshed in 24s (0 site + 6 server boards — FFA: Spiral, Zenith, Vortex | Forge: …).
```

`/reload` defaults to the site tables; `/reload scope:servers` (or
`scope:all`) still runs the manual in-game sweep.

## The resident game browser

The in-game per-server sweep has its own resident browser, with its profile in
`.netquel-sweep-profile/` next to `index.js`. In resident mode this browser
still serves the card pass and manual `/reload scope:servers` runs. It is a
second Chrome on purpose:
the site browser and the game client are both software-rendered, and running
two clients in one process starves the sweep.

- The browser is kept between sweeps and parked on `about:blank`, so it is not
  sitting in a match while idle, but the process and its cached WASM client stay
  warm. It is warmed at boot; a killed browser is relaunched automatically on
  the next sweep (with launch backoff if it cannot start).
- It costs memory like the site browser — budget another few hundred MB. CPU is
  low while parked; it only works during a sweep.
- The pass opens each numbered server host directly (`NETQUEL_DIRECT_SERVERS=1`,
  the default), so there is no wall hop. If a host stops pinning its server,
  the tracker detects the mismatch and falls back to the old hop path.
- In sweep mode, server boards refresh every `NETQUEL_SERVER_REFRESH_SECONDS`
  (30s by default), and each finished board is published immediately.
- A rolling, budgeted card pass runs on its own slower timer
  (`NETQUEL_CARD_REFRESH_MINUTES`, 10 by default), one server at a time. In
  resident mode it no longer blocks live boards, because the resident tabs are
  independent of this browser.
- `/netquel-players` uses the same browser queue, so an on-demand card refresh
  waits for a running pass instead of starting a second game client; it also
  walks the numbered hosts directly.

A healthy boot logs:

```
🛰️ Netquel game browser warm.
```
