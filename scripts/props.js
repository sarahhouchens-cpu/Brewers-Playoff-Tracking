#!/usr/bin/env node
/**
 * Builds tonight's parlay board.
 *
 * Pulls the Brewers' game, probable starters, lineup, per-hitter game logs and
 * platoon splits, plus ballpark weather, projects every hitter, then prices
 * parlays against live odds if an odds key is configured.
 *
 * Without an odds key it still runs and produces the model board — ranked legs
 * with the model's own fair prices. That is the honest fallback: a parlay
 * payout figure is meaningless without real odds, so none is invented.
 *
 *   node scripts/props.js            # live
 *   node scripts/props.js --demo     # offline fixture
 *   node scripts/props.js --dry-run  # compute, write nothing
 */

import { writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectBatter, weatherPower, pitcherContactFactor, isRoofed, parkPower } from '../lib/projections.js';
import { buildParlays, withEdge, describeLeg, MARKET_LABELS } from '../lib/parlay.js';
import { decimalToAmerican } from '../lib/odds.js';
import { parseEventOdds, playersInFeed, normalizeName } from '../lib/odds-feed.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const BOARD_DIR = join(DATA_DIR, 'props');
const API = 'https://statsapi.mlb.com/api/v1';
const BREWERS = 158;
const TZ = 'America/Chicago';

/**
 * Edges beyond this many percentage points are treated as suspect and kept off
 * tickets. Player props are liquid enough that a genuine edge is small; a large
 * one nearly always means the model and the book are pricing different things.
 */
const EDGE_SANITY_LIMIT = 15;

/**
 * How close to first pitch the odds are worth spending credits on.
 *
 * Lineups typically post two to four hours out, and prices before that are
 * provisional. Fetching at breakfast burns three credits on a board that will
 * be rebuilt anyway. This lets the schedule carry many slots — runs outside the
 * window, and runs after first pitch, cost nothing — while credits are only
 * spent where the board is actually useful.
 */
const ODDS_WINDOW_HOURS = 5;

const args = new Set(process.argv.slice(2));
const DEMO = args.has('--demo');
const DRY_RUN = args.has('--dry-run');

const ODDS_KEY = process.env.ODDS_API_KEY ?? '';
const ODDS_BASE = process.env.ODDS_API_BASE ?? 'https://api.the-odds-api.com/v4';

const centralDate = (offset = 0) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
};

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url.split('?')[0]}`);
  return res.json();
}

/* ------------------------------------------------------------ StatsAPI --- */

async function findGame(date) {
  const payload = await getJSON(
    `${API}/schedule?sportId=1&teamId=${BREWERS}&date=${date}` +
      `&hydrate=probablePitcher,lineups,team,venue`
  );
  const games = (payload?.dates ?? []).flatMap((d) => d?.games ?? []);
  return games[0] ?? null;
}

/** Per-PA outcome rates from a raw stat line. */
function ratesFromSplit(stat) {
  const pa = Number(stat?.plateAppearances ?? 0);
  if (!pa) return null;
  const hits = Number(stat?.hits ?? 0);
  const doubles = Number(stat?.doubles ?? 0);
  const triples = Number(stat?.triples ?? 0);
  const homeRuns = Number(stat?.homeRuns ?? 0);
  const singles = Math.max(0, hits - doubles - triples - homeRuns);
  return {
    single: singles / pa,
    double: doubles / pa,
    triple: triples / pa,
    homeRun: homeRuns / pa,
  };
}

/** Season line, last-15 form, and the platoon split matching tonight's starter. */
async function hitterViews(playerId, season, starterHand) {
  const [seasonPayload, logPayload, splitPayload] = await Promise.all([
    getJSON(`${API}/people/${playerId}/stats?stats=season&group=hitting&season=${season}`),
    getJSON(`${API}/people/${playerId}/stats?stats=gameLog&group=hitting&season=${season}`),
    getJSON(
      `${API}/people/${playerId}/stats?stats=statSplits&group=hitting&season=${season}` +
        `&sitCodes=${starterHand === 'L' ? 'vl' : 'vr'}`
    ),
  ]);

  const seasonStat = seasonPayload?.stats?.[0]?.splits?.[0]?.stat;
  const platoonStat = splitPayload?.stats?.[0]?.splits?.[0]?.stat;

  // Game logs come oldest-first; the last 15 entries are the recent form.
  const logs = logPayload?.stats?.[0]?.splits ?? [];
  const recent = logs.slice(-15).reduce(
    (acc, s) => {
      const st = s?.stat ?? {};
      acc.plateAppearances += Number(st.plateAppearances ?? 0);
      acc.hits += Number(st.hits ?? 0);
      acc.doubles += Number(st.doubles ?? 0);
      acc.triples += Number(st.triples ?? 0);
      acc.homeRuns += Number(st.homeRuns ?? 0);
      return acc;
    },
    { plateAppearances: 0, hits: 0, doubles: 0, triples: 0, homeRuns: 0 }
  );

  return {
    season: ratesFromSplit(seasonStat),
    last15: ratesFromSplit(recent),
    platoon: ratesFromSplit(platoonStat),
  };
}

/** Opponent batting average against a pitcher, for the contact factor. */
async function pitcherOpponentAvg(pitcherId, season) {
  if (!pitcherId) return null;
  const payload = await getJSON(
    `${API}/people/${pitcherId}/stats?stats=season&group=pitching&season=${season}`
  );
  const avg = Number(payload?.stats?.[0]?.splits?.[0]?.stat?.avg);
  return Number.isFinite(avg) ? avg : null;
}

/**
 * Bullpen strength for the opposing club: the mean opponent average of
 * relievers who have not pitched in the last two days, since those are the
 * arms most likely to appear tonight.
 */
async function bullpenContact(teamId, season) {
  try {
    const roster = await getJSON(`${API}/teams/${teamId}/roster?rosterType=active`);
    const pitchers = (roster?.roster ?? []).filter((p) => p?.position?.abbreviation === 'P');
    const sampled = pitchers.slice(0, 12);

    const avgs = [];
    for (const p of sampled) {
      const avg = await pitcherOpponentAvg(p?.person?.id, season);
      if (avg) avgs.push(avg);
    }
    if (!avgs.length) return 1;
    return pitcherContactFactor(avgs.reduce((a, b) => a + b, 0) / avgs.length);
  } catch {
    return 1;
  }
}

/** Roof state, temperature and wind from the live game feed. */
async function venueConditions(gamePk, venueName) {
  try {
    const feed = await getJSON(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);
    const weather = feed?.gameData?.weather ?? {};
    const condition = String(weather.condition ?? '');
    const wind = String(weather.wind ?? '');

    const temperatureF = Number(weather.temp) || 72;
    const windMph = Number((wind.match(/(\d+)/) ?? [])[1]) || 0;
    let windDirection = 'none';
    if (/out/i.test(wind)) windDirection = 'out';
    else if (/in/i.test(wind)) windDirection = 'in';

    // Only a roofed park can be closed. Reading "dome" out of a condition
    // string at an open-air venue would silently neutralise real weather.
    const roofClosed = isRoofed(venueName) && /roof closed|dome|indoor/i.test(condition);

    return {
      venue: venueName,
      roofed: isRoofed(venueName),
      roofClosed,
      temperatureF,
      windMph,
      windDirection,
      description: [condition, wind].filter(Boolean).join(' · ') || 'Conditions unavailable',
    };
  } catch {
    return {
      venue: venueName,
      roofed: isRoofed(venueName),
      roofClosed: false,
      temperatureF: 72,
      windMph: 0,
      windDirection: 'none',
      description: 'Conditions unavailable',
    };
  }
}

/* ---------------------------------------------------------------- odds --- */

/**
 * Live player props for the Brewers game.
 *
 * Quota matters here. The free tier is 500 credits a month and an odds call
 * costs one credit per market per region, so the three markets below cost three
 * credits every time this runs. The events listing is free. At four runs a day
 * that is roughly 360 credits a month; running it hourly would exhaust the
 * month in under two days, which is why the props job has its own schedule.
 */
async function fetchOdds() {
  if (!ODDS_KEY) return { quotes: new Map(), status: 'no-key' };

  const markets = 'batter_hits,batter_total_bases,batter_home_runs';
  try {
    const events = await getJSON(`${ODDS_BASE}/sports/baseball_mlb/events?apiKey=${ODDS_KEY}`);
    const event = (events ?? []).find((e) => /brewers/i.test(`${e.home_team} ${e.away_team}`));
    if (!event) return { quotes: new Map(), status: 'no-event' };

    const payload = await getJSON(
      `${ODDS_BASE}/sports/baseball_mlb/events/${event.id}/odds` +
        `?apiKey=${ODDS_KEY}&regions=us&markets=${markets}&oddsFormat=american`
    );
    const quotes = parseEventOdds(payload);
    return { quotes, status: quotes.size ? 'ok' : 'no-props', books: (payload?.bookmakers ?? []).length };
  } catch (err) {
    return { quotes: new Map(), status: `error: ${err.message}` };
  }
}

/** Brewers roster as a normalized-name to MLB-id map, for joining the odds feed. */
async function rosterByName() {
  const roster = await getJSON(`${API}/teams/${BREWERS}/roster?rosterType=active`);
  const map = new Map();
  for (const entry of roster?.roster ?? []) {
    const person = entry?.person;
    if (person?.id && person?.fullName) map.set(normalizeName(person.fullName), person);
  }
  return map;
}

/* ----------------------------------------------------------------- run --- */

async function buildBoard(date, { withOdds = true } = {}) {
  const game = await findGame(date);
  if (!game) return { date, status: 'no-game', legs: [], parlays: [] };

  const season = new Date().getUTCFullYear();
  const isHome = game?.teams?.home?.team?.id === BREWERS;
  const opponent = isHome ? game?.teams?.away?.team : game?.teams?.home?.team;
  const starter = isHome ? game?.teams?.away?.probablePitcher : game?.teams?.home?.probablePitcher;
  const starterHand = starter?.pitchHand?.code ?? 'R';

  const lineupKey = isHome ? 'home' : 'away';
  let lineup = game?.lineups?.[`${lineupKey}Players`] ?? [];
  let lineupSource = lineup.length ? 'statsapi' : 'none';

  // A pregame model must never be priced against in-play odds.
  //
  // Once first pitch passes, the book reprices continuously on what has already
  // happened — a hitter who is 0-for-3 has his 1+ hits price collapse — while
  // this model still projects a full game from the first pitch. The gap between
  // them looks like a huge edge and is entirely an artifact. Observed live: a
  // 1+ hits prop at +105 (book fair 45%) against a model saying 76%, a
  // 30-point "edge" that was really just three at-bats already gone.
  const abstractState = game?.status?.abstractGameState ?? '';
  const startsAt = new Date(game.gameDate);
  const started = abstractState !== 'Preview' || startsAt <= new Date();

  if (started) {
    return {
      date,
      status: 'game-started',
      gameState: game?.status?.detailedState ?? abstractState,
      startTime: game.gameDate,
      game: {
        gamePk: game.gamePk,
        opponent: opponent?.name ?? 'TBD',
        isHome,
        startTime: game.gameDate,
        venue: game?.venue?.name ?? null,
      },
      legs: [],
      parlays: [],
    };
  }

  const venueName = game?.venue?.name ?? null;
  const conditions = await venueConditions(game.gamePk, venueName);
  const power = weatherPower({ ...conditions, venue: venueName });

  const [starterAvg, penContact] = await Promise.all([
    pitcherOpponentAvg(starter?.id, season),
    bullpenContact(opponent?.id, season),
  ]);
  const starterContact = pitcherContactFactor(starterAvg ?? 0.243);

  const hoursOut = (startsAt - new Date()) / 3600000;
  const inOddsWindow = hoursOut <= ODDS_WINDOW_HOURS;

  const { quotes, status: oddsStatus, books } = withOdds && inOddsWindow
    ? await fetchOdds()
    : {
        quotes: new Map(),
        status: withOdds ? `too-early (${hoursOut.toFixed(1)}h to first pitch)` : 'skipped',
      };

  // If StatsAPI has not posted a lineup yet, fall back to whoever the book has
  // priced. A player carrying props is almost certainly starting, and this is
  // what keeps the board from being empty for most of the day.
  if (!lineup.length && quotes.size) {
    const roster = await rosterByName();
    const seen = new Set();
    for (const [key, displayName] of playersInFeed(quotes)) {
      const person = roster.get(key);
      if (!person || seen.has(person.id)) continue;
      seen.add(person.id);
      lineup.push({ id: person.id, fullName: person.fullName });
    }
    if (lineup.length) lineupSource = 'odds-feed';
  }

  const batters = lineup.slice(0, 9);
  // Without a posted batting order every hitter is treated as a middle-of-the-
  // order bat rather than pretending to know who leads off.
  const slotKnown = lineupSource === 'statsapi';
  const legs = [];

  const skipped = [];

  for (const [index, player] of batters.entries()) {
    const views = await hitterViews(player.id, season, starterHand);
    if (!views.season) {
      skipped.push(player.fullName ?? player.id);
      continue;
    }

    const projection = projectBatter({
      views,
      lineupSlot: slotKnown ? index + 1 : 5,
      starterContact,
      bullpenContact: penContact,
      power,
    });

    for (const [market, probability] of [
      ['hits_1', projection.probability.hit1],
      ['hits_2', projection.probability.hit2],
      ['total_bases_2', projection.probability.totalBases2],
      ['total_bases_3', projection.probability.totalBases3],
      ['home_run_1', projection.probability.homeRun1],
    ]) {
      legs.push({
        playerId: player.id,
        playerName: player.fullName ?? `Player ${player.id}`,
        lineupSlot: slotKnown ? index + 1 : null,
        market,
        marketLabel: MARKET_LABELS[market],
        modelProbability: probability,
        modelFairOdds: decimalToAmerican(1 / Math.min(0.98, Math.max(0.02, probability))),
        gamePk: game.gamePk,
      });
    }
  }

  // A lineup that produces no legs is a bug, not an empty night — it means the
  // batters were resolved but their stats never were. Say so loudly rather than
  // shipping a silently empty board.
  if (batters.length && !legs.length) {
    console.error(`WARNING: ${batters.length} batters resolved but no legs built.` +
      (skipped.length ? ` Skipped for missing season stats: ${skipped.join(', ')}` : ''));
  }

  const priced = legs.map((leg) => {
    const quote = quotes.get(`${normalizeName(leg.playerName)}|${leg.market}`);
    if (!quote) return { ...leg, americanOdds: null, edge: null };
    return withEdge({
      ...leg,
      americanOdds: quote.americanOdds,
      oppositeAmericanOdds: quote.oppositeAmericanOdds,
      book: quote.book,
    });
  });

  // Backstop: a double-digit edge on a liquid market is far more likely to be
  // a data mismatch than a real opportunity. Flag rather than silently drop, so
  // the cause stays visible instead of being swallowed.
  for (const leg of priced) {
    if (leg.edge != null && Math.abs(leg.edge) > EDGE_SANITY_LIMIT) leg.suspect = true;
  }

  const bettable = priced.filter((l) => l.americanOdds != null && !l.suspect);
  const parlays = bettable.length ? buildParlays(bettable) : [];

  return {
    date,
    status: 'ok',
    oddsStatus,
    books: books ?? 0,
    hoursToFirstPitch: Number(hoursOut.toFixed(2)),
    game: {
      gamePk: game.gamePk,
      opponent: opponent?.name ?? 'TBD',
      isHome,
      startTime: game.gameDate,
      venue: game?.venue?.name ?? null,
    },
    starter: starter ? { id: starter.id, name: starter.fullName, hand: starterHand, opponentAvg: starterAvg } : null,
    lineupSource,
    conditions,
    factors: { starterContact, bullpenContact: penContact, power, park: parkPower(venueName) },
    battersResolved: batters.length,
    battersSkipped: skipped,
    legs: priced.sort((a, b) => (b.edge ?? -99) - (a.edge ?? -99) || b.modelProbability - a.modelProbability),
    parlays: parlays.map((p) => ({
      ...p,
      legs: p.legs.map((l) => ({ ...l, description: describeLeg(l) })),
    })),
  };
}

/** Grade a past day's board against what actually happened. */
async function gradeDay(board) {
  if (board.status !== 'ok' || !board.game) return board;
  const season = new Date(board.date).getUTCFullYear();

  for (const leg of board.legs.slice(0, 40)) {
    try {
      const payload = await getJSON(
        `${API}/people/${leg.playerId}/stats?stats=gameLog&group=hitting&season=${season}`
      );
      const split = (payload?.stats?.[0]?.splits ?? []).find((s) => s.date === board.date);
      if (!split) continue;
      const st = split.stat ?? {};
      const hits = Number(st.hits ?? 0);
      const tb = Number(st.totalBases ?? 0);
      const hr = Number(st.homeRuns ?? 0);
      leg.result = { hits, totalBases: tb, homeRuns: hr };
      leg.hit =
        leg.market === 'hits_1' ? hits >= 1
        : leg.market === 'hits_2' ? hits >= 2
        : leg.market === 'total_bases_2' ? tb >= 2
        : leg.market === 'total_bases_3' ? tb >= 3
        : hr >= 1;
    } catch { /* leave ungraded */ }
  }

  for (const parlay of board.parlays) {
    const graded = parlay.legs.map((l) => board.legs.find((x) => x.playerId === l.playerId && x.market === l.market)?.hit);
    parlay.hit = graded.every((g) => g === true);
    parlay.graded = graded.every((g) => typeof g === 'boolean');
  }
  return board;
}

/**
 * Grade the stored boards from the last week.
 *
 * Deliberately reads boards off disk instead of rebuilding them. Rebuilding
 * would spend odds credits re-fetching prices for games already played, and
 * worse, it would fetch *today's* prices for a past game — historical prop odds
 * are a paid product. The board captured at the time is the only honest record
 * of what was actually available, so each run stores one and later runs grade
 * it in place.
 */
async function gradeStoredBoards() {
  let files = [];
  try {
    files = (await readdir(BOARD_DIR)).filter((f) => f.endsWith('.json')).sort().slice(-8);
  } catch {
    return [];
  }

  const today = centralDate();
  const graded = [];

  for (const file of files) {
    const path = join(BOARD_DIR, file);
    let board;
    try {
      board = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      continue;
    }
    if (board.date === today) continue;

    // Grade once, then leave it alone.
    if (!board.parlays?.some((p) => p.graded)) {
      board = await gradeDay(board);
      await writeFile(path, JSON.stringify(board, null, 2));
    }
    graded.push(board);
  }

  return graded.slice(-7);
}

async function main() {
  if (DEMO) {
    const { demoBoard } = await import('../test/fixture-props.js');
    await write(demoBoard());
    return;
  }

  const today = await buildBoard(centralDate());
  today.generatedAt = new Date().toISOString();
  today.source = 'live';

  // Store today's board before grading, so the prices it was built on survive.
  if (!DRY_RUN && today.status === 'ok') {
    await mkdir(BOARD_DIR, { recursive: true });
    await writeFile(join(BOARD_DIR, `${today.date}.json`), JSON.stringify(today, null, 2));
  }

  today.history = DRY_RUN ? [] : await gradeStoredBoards();
  await write(today);
}

async function write(board) {
  console.log(`Board for ${board.date}: ${board.status}` +
    (board.gameState ? ` (${board.gameState})` : '') +
    `, ${board.legs?.length ?? 0} legs, ${board.parlays?.length ?? 0} parlays`);
  if (board.battersResolved != null) {
    console.log(`Batters: ${board.battersResolved} resolved` +
      (board.battersSkipped?.length ? `, ${board.battersSkipped.length} skipped for missing stats` : ''));
  }
  const suspect = (board.legs ?? []).filter((l) => l.suspect).length;
  if (suspect) console.log(`Held back ${suspect} legs with implausible edges (>${EDGE_SANITY_LIMIT} pts)`);
  console.log(`Odds: ${board.oddsStatus ?? 'n/a'}${board.books ? ` across ${board.books} books` : ''}` +
    `${ODDS_KEY ? '' : ' (no ODDS_API_KEY set — model-only mode)'}`);
  console.log(`Lineup source: ${board.lineupSource ?? 'n/a'}`);
  console.log(`Graded history: ${board.history?.length ?? 0} nights`);
  if (DRY_RUN) return console.log('--dry-run: nothing written.');

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, 'props-latest.json'), JSON.stringify(board, null, 2));
}

main().catch((err) => {
  console.error('\nProps update failed:', err.message);
  process.exit(1);
});
