# NBA Bracket Dashboard

Live dashboard for the **LakeShow 2027 Champions** ESPN Playoff Challenge group.

Single-file HTML, no build step, no backend. Open `index.html` in any browser.

## What it does

- **Leaderboard** — current points and possible points for all 10 members
- **Win probability** — Monte Carlo simulation (10,000 trials) of the remaining playoffs, scoring each user's bracket against simulated outcomes
- **Picks vs. reality** — bracket view per member with team logos, a champion card, and live correct/wrong/eliminated indicators
- **Live scores** — today's games pulled from ESPN's public scoreboard, refreshed every 60 seconds
- **Auto-sync** — series winners and game counts pulled from ESPN every 5 minutes; no manual updates needed

## Live URL

GitHub Pages: `https://<your-username>.github.io/nba-bracket-dashboard/` (set up via Settings → Pages → main → /).

## Editing picks or scoring

Open the **⚙︎ Edit data** disclosure at the bottom of the page. Paste an updated JSON blob, click "Save & redraw." Changes persist in the visitor's browser via `localStorage` — to update the canonical version everyone sees, edit `index.html` in this repo and push.

## Tech notes

- Uses ESPN's public scoreboard API (`site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard`) — no auth required
- Logos served from ESPN's CDN (`a.espncdn.com/i/teamlogos/nba/500/`)
- All math runs client-side; opening the page is enough to refresh everything
