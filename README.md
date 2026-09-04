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
| `test/` | 17 tests covering the math, chaser selection, and diffing. |
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

## Data source

[MLB Stats API](https://statsapi.mlb.com/api/v1/standings?leagueId=104&standingsTypes=regularSeason) —
free and unauthenticated. Not affiliated with or endorsed by the Milwaukee Brewers
or Major League Baseball.
