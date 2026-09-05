# Brewers Magic Number Tracker

A single-page site tracking how close the Milwaukee Brewers are to clinching, plus
the daily results that move each number and why.

Four magic numbers, each measured against a **different chaser**:

| Race | Chaser | What it wins |
| --- | --- | --- |
| Playoff berth | The team first out of the NL playoff field | October baseball |
| NL Central | Second place in the division | The division title |
| No. 1 seed, NL | Best record among other NL teams | A first-round bye into the NLDS |
| Best record, MLB | Best record anywhere in baseball | World Series home-field advantage |

That last one is not a "seed" — MLB seeds 1–6 within each league separately. The
best overall record wins World Series home field instead, and the chaser can be in
either league, so it is not simply "the best AL team."

## How it works

```
M = 163 − Brewers wins − chaser losses
```

The 163 is 162 games plus one, because the extra game is what turns a tie into a
clinch. Consequences worth knowing:

- A **Brewers win** drops all four numbers by one. It is the only result that does.
- A **Brewers loss** moves nothing. Losses never raise a magic number.
- A **chaser loss** drops only that race's number.
- If the chaser changes overnight, a number can **rise** even after a win. The feed
  flags this rather than letting it look like a bug.

MLB now breaks ties mathematically instead of playing a Game 163, so where the
Brewers already own the head-to-head tiebreaker the true number is one lower than
this formula reports. The conservative standard formula is what ships.

## Architecture

Nothing runs server-side at request time, and the browser never calls MLB.

```
GitHub Action (scheduled)          Static site (GitHub Pages)
  scripts/update.js                  index.html
    ↓ fetches MLB Stats API          assets/app.js
    ↓ lib/magic.js computes            ↓ fetches
    → data/latest.json ──────────────→ data/latest.json
    → data/YYYY-MM-DD.json
```

Writing the data to the repo means no CORS dependency, a permanent day-by-day
history for the feed, free hosting, and a page that stays up even when MLB's API
does not.

| Path | Role |
| --- | --- |
| `lib/magic.js` | Pure math. No I/O, no DOM. Runs in Node and the browser. |
| `scripts/update.js` | Fetches, computes, writes `data/`. |
| `lib/odds.js` | Odds conversion, devigging, parlay pricing, expected value. |
| `lib/projections.js` | The hitter model. Pure math. |
| `lib/parlay.js` | Ticket assembly and the rules that constrain it. |
| `scripts/props.js` | Builds the nightly bet board. |
| `test/` | 49 tests covering the magic numbers, the odds math, the model, and the parlay rules. |
| `assets/app.js` | Renders `data/latest.json`. Formats only — never computes. |
| `.github/workflows/update.yml` | The schedule. |

## Local development

No dependencies to install.

```bash
npm test                  # run the math tests
npm run update:demo       # rebuild data/ from the offline fixture
node scripts/update.js --dry-run   # hit the live API, print, write nothing
python3 -m http.server 8000        # then open http://localhost:8000
```

`--demo` uses a synthetic 30-team league in `test/fixture-standings.js`, anchored on
the real September 4, 2026 Brewers record (87–54) and built so the numbers come out
to the published 9 / 14 / 19. It lets the whole pipeline run with no network.

## Setup: two repo settings

Both are one-time, and the site will not update itself until they are done.

1. **Let the Action commit its results.**
   Settings → Actions → General → Workflow permissions → **Read and write permissions** → Save.

2. **Turn on Pages.**
   Settings → Pages → Source: *Deploy from a branch* → pick the branch and `/ (root)` → Save.

Then run the workflow once by hand to confirm: Actions → *Update magic numbers* → **Run workflow**.

### If that first run fails

Expected, and easy to fix. The MLB API response shape was never verified before
first run, so the parser in `scripts/update.js` may need a field name adjusted. On
failure the job uploads a `debug-raw.json` artifact showing the actual response
structure — open it from the run's summary page. The `assertUsable` check exists so
this surfaces as a clear message instead of a wrong number on the page.

## Bet board

A second tab projects Brewers hitters for tonight and, when odds are available,
assembles parlays under fixed rules: 3-5 legs, a $100-$200 return on a $5 stake,
weighted toward hits and total bases, at most one home run leg, and never a
"player hits 2+ home runs" market.

### The model

Each hitter's per-plate-appearance outcome rates are blended from three views —
season (45%), last 15 games (30%), and platoon split against tonight's probable
starter (25%) — then adjusted for the pitchers he will actually face and for
park and weather, and convolved over an uncertain number of plate appearances.

Convolving matters: across 3-5 trips the total-bases distribution is lumpy and
discrete, and "2+ total bases" depends on exactly that lumpiness. A normal
approximation would smooth away the thing being priced.

| Input | How it enters |
| --- | --- |
| Recent form | Last 15 games, capped at 30% — roughly 60 PA, too noisy to outweigh the season |
| Platoon split | vs. LHP/RHP matching the probable starter |
| Starter | Opponent batting average, clamped to a 0.75-1.30 contact multiplier |
| Bullpen | Mean opponent average of rested relievers, blended by expected exposure |
| Park and weather | Temperature and wind, applied only to extra-base outcomes; a closed roof zeroes it out |
| Lineup slot | Sets the plate-appearance distribution |

### Odds

Set an `ODDS_API_KEY` repository secret to enable live prices. Without one the
board still runs in **model-only mode**: ranked legs with the model's own fair
prices and no parlay payouts. That is deliberate — a payout figure computed from
invented odds is worse than no figure, so none is produced.

Edges are computed against the **devigged** two-way price. Where only one side
of a market is available the edge is reported as null rather than measured
against a vigged number, which would flatter the model.

Note that historical player-prop odds are a paid product on every provider
surveyed, so the "past 7 days" view grades the model's own board against actual
results rather than replaying real historical prices. It fills in as the job
runs each day.

### Caveats

Parlay legs from the same game are correlated — shared pitcher, park and game
state — so the combined probability is shaded down per shared game but remains
optimistic. Every added leg multiplies the house edge along with the payout.

## Data source

[MLB Stats API](https://statsapi.mlb.com/api/v1/standings?leagueId=104&standingsTypes=regularSeason) —
free and unauthenticated. Not affiliated with or endorsed by the Milwaukee Brewers
or Major League Baseball.
