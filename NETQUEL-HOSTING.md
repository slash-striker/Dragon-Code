# Running the Netquel tracker on a host

The Netquel scraper is the only part of the bot that needs a browser. netquel.com
publishes no API — the leaderboards are painted by a WASM/WebGL client over a
WebSocket — so the tracker drives a real Chrome/Chromium over the DevTools
protocol and reads the rendered tables. Without a browser binary the tracker
switches itself off and the rest of the bot runs normally.

## Is it running?

The boot log says one of these:

```
🛰️ Netquel tracker armed — site tables every 2 minute(s), server sweep every 10 minute(s).
```

```
🛰️ Netquel tracker disabled — no Chrome/Chromium found on this host.
```

If it says "disabled", the bot is fine; only the board channels, `/reload` and
`/target` are affected. `/reload` in Discord prints the same reason.

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

The browser is heavy (roughly 300–500 MB RAM and a core during a sweep), which
is why shared game hosts usually can't do it. A ~$5/mo VPS where you control the
OS lets you:

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
| `NETQUEL_SITE_REFRESH_MINUTES` | `2` | How often the day/week/all tables refresh |
| `NETQUEL_REFRESH_MINUTES` | `10` | How often the in-game server sweep runs |
