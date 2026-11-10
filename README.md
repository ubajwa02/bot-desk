# Bot Desk

Bot Desk is a small iPhone app (an installable web app): one Home Screen icon for everything, with five tabs.

| Tab | What it shows | Where the data comes from |
| --- | --- | --- |
| **Status** | What's broken, needs you, running or paused, plus problems. Statuses only, no numbers. | Team Desk collector (`latest.json`), encrypted |
| **Trading** | ORB Signals, Contra-ORB, SPY 0DTE: total, last 7 days, last session, running line, recent trades, in $ | Team Desk collector, encrypted |
| **NBA** | Record since start, tonight's games, picks with DK/FD bet-slip links, last night's results, parlays and lotto, by market, by day. Soccer below. | nba-picks `site/data.json` + collector, encrypted |
| **Stocks** | Tech-market mood, coming events, why stocks moved, your stocks with the call and what to wait for | Fundamental Researcher's public snapshot (`fr-dashboard/data/home.json`) |
| **Jobs** | JobBoard counts: sent, needs you, tries, health, kill switch. Never job titles or employers. | JobBoard's counts-only `status.json`, encrypted |

## Install on iPhone

1. Open the setup link from your Claude thread in **Safari** (`https://ubajwa02.github.io/bot-desk/#k=…`).
2. Tap **Share**, then **Add to Home Screen**, then **Add**.
3. Open **Bot Desk** from the Home Screen. If it asks for the key, paste it (Safari's page has a **Copy key** button).
4. To get alerts: in the app tap **Turn on alerts**, allow notifications, then copy the **alert code** and send it to Claude
   in the thread once. Needs iOS 16.4 or newer, and only works from the Home Screen app, not a Safari tab.

## How it works

```
Team Desk collector (Claude, 6x a day)
   └─ latest.json ──┐
nba-picks data.json ┼─> tools/publish.py ──┬─> desk.enc.json on the `data` branch (AES-256-GCM, encrypted)
JobBoard status.json┘
                                         └─> Web Push alert to each phone, only for new problems
iPhone app (this repo, GitHub Pages) ──> fetches desk.enc.json ──> decrypts on the phone with its key
                                    └─> Stocks tab reads ubajwa02.github.io/fr-dashboard/data/home.json (already public)
```

* **Hosting:** GitHub Pages from `main` (root). Free for a public repo.
* **Privacy:** the repo is public, so it holds only app code. The status file is encrypted; the 256-bit key is never in
  the repo and lives only on your phone and in the Claude project's private files. The alert-signing private key and the
  phone subscriptions are kept there too.
* **Offline:** the app shell is cached by the service worker, and the last statuses stay on the phone.
* **Badge:** the Home Screen icon shows the number of Broken + Needs-you rows (iOS 16.4+).

## Files

| Path | What |
| --- | --- |
| `index.html`, `app.css`, `app.js`, `config.js` | The app. `config.js` holds only public settings (data address, public alert key). |
| `sw.js` | Offline cache, push notifications, badge. |
| `manifest.webmanifest`, `icons/` | App name, icon, standalone mode. |
| `tools/publish.py` | Builds and encrypts the status file, uploads it to the `data` branch, sends alerts. |
| `tools/webpush.py` | Web Push sender (RFC 8291 + VAPID) using only `cryptography`. |
| `tests/` | `python3 -m unittest discover -s tests` |

## Refresh step (run by the collector after `collect.py`)

```
python3 -I tools/publish.py all --latest latest.json --secrets <private secrets folder>
```

`publish.py` reads nba-picks `site/data.json` and JobBoard's `status.json` with `gh` (both private repos). If either
can't be read, that tab says so and everything else still publishes. `--nba FILE` / `--jobs FILE` use local copies.
