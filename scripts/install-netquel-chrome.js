#!/usr/bin/env node
/*
 * Best-effort Chrome installer for the Netquel tracker.
 *
 * Some hosts give you a file manager and a restart button but no shell, so
 * there is nowhere to run `apt install chromium`. This script downloads the
 * official Chrome for Testing build into `.netquel-chrome/` next to the bot,
 * which the scraper already looks in, so a plain restart is enough.
 *
 * It runs from two places:
 *   - `npm install` (package.json postinstall),
 *   - the bot's own boot, when startNetquelTracker finds no browser at all
 *     (a panel that only restarts the process, without reinstalling, still
 *     gets a browser this way).
 *
 * It is deliberately non-fatal: every failure reports what went wrong and
 * exits 0, because it also runs from `npm install` and must never break a
 * deployment. It is a no-op off Linux, or when a browser already exists.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, '.netquel-chrome');
const INDEX_URL = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
const PINNED_VERSION = '157.0.8103.78';

/* Already usable in our own folder? Leave it alone. */
function existingBrowser() {
    const arch = process.arch === 'arm64' ? 'linux-arm64' : 'linux64';
    const candidates = [
        path.join(TARGET, `chrome-${arch}`, 'chrome'),
        path.join(TARGET, 'chrome-linux64', 'chrome'),
        path.join(TARGET, 'chrome-linux-arm64', 'chrome')
    ];
    return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

async function resolveDownload(platform, log) {
    try {
        const response = await fetch(INDEX_URL, { signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const stable = data?.channels?.Stable;
        const entry = (stable?.downloads?.chrome ?? []).find(item => item.platform === platform);
        if (entry?.url) return entry.url;
        throw new Error('Stable linux build not listed');
    } catch (error) {
        log(`could not read the version index (${error.message}); using the pinned ${PINNED_VERSION} build`);
        return `https://storage.googleapis.com/chrome-for-testing-public/${PINNED_VERSION}/${platform}/chrome-${platform}.zip`;
    }
}

async function download(url, destination, log) {
    const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0;
    log(`downloading ${Math.round(total / 1_048_576)} MB from ${url}`);

    const { Readable } = require('node:stream');
    const { pipeline } = require('node:stream/promises');
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
}

function extract(zipPath, destination, log) {
    const attempts = [
        ['unzip', ['-q', '-o', zipPath, '-d', destination]],
        ['python3', ['-m', 'zipfile', '-e', zipPath, destination]],
        ['bsdtar', ['-xf', zipPath, '-C', destination]]
    ];

    let tried = 0;
    for (const [command, args] of attempts) {
        const result = spawnSync(command, args, { stdio: 'inherit' });
        if (result.error?.code === 'ENOENT') continue;
        tried += 1;
        if (result.status === 0) return true;
        log(`${command} failed (exit ${result.status})`);
    }
    if (!tried) log('no unzip, python3 or bsdtar on this host');
    return false;
}

/*
 * Returns { ok, path?, skipped?, message }. Never throws; `log` receives
 * progress lines so callers decide where they go (console, a log file, …).
 */
async function ensureChrome(log = () => {}) {
    if (process.platform !== 'linux') {
        return { ok: false, skipped: true, message: `skipped — this host is ${process.platform}, not Linux` };
    }

    const already = existingBrowser();
    if (already) return { ok: true, path: already, message: `already installed at ${already}` };

    // A system browser makes this unnecessary.
    try {
        const system = require('../systems/netquel/netquelSource').locateChrome();
        if (system) return { ok: true, path: system, message: `skipped — a browser already exists at ${system}` };
    } catch {
        // Fall through: installing a local copy is still useful.
    }

    const platform = process.arch === 'arm64' ? 'linux-arm64' : 'linux64';
    fs.mkdirSync(TARGET, { recursive: true });
    const zipPath = path.join(TARGET, 'chrome.zip');

    try {
        const url = await resolveDownload(platform, log);
        await download(url, zipPath, log);
    } catch (error) {
        return {
            ok: false,
            message: `download failed: ${error.message} — upload the zip yourself and set NETQUEL_CHROME_PATH (NETQUEL-HOSTING.md, route B).`
        };
    }

    if (!extract(zipPath, TARGET, log)) {
        return {
            ok: false,
            message: 'could not unpack the download (no unzip, python3 or bsdtar) — unzip it on your computer, upload the chrome-* folder, and set NETQUEL_CHROME_PATH (NETQUEL-HOSTING.md, route B).'
        };
    }

    fs.rmSync(zipPath, { force: true });

    const binary = existingBrowser();
    if (!binary) {
        return { ok: false, message: 'unpacked the download but found no chrome binary — see NETQUEL-HOSTING.md.' };
    }

    try {
        fs.chmodSync(binary, 0o755);
    } catch {
        // Extracted files are usually already executable.
    }

    return { ok: true, path: binary, message: `installed at ${binary}` };
}

if (require.main === module) {
    ensureChrome(message => console.log(`[netquel-chrome] ${message}`))
        .then(result => {
            console.log(`[netquel-chrome] ${result.message}`);
            if (result.ok) console.log('[netquel-chrome] restart the bot; the tracker picks it up automatically.');
            process.exit(0);
        })
        .catch(error => {
            // Never fail npm install because of an optional browser.
            console.log(`[netquel-chrome] unexpected error: ${error?.message ?? error}`);
            process.exit(0);
        });
}

module.exports = { ensureChrome };
