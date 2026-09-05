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

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectBatter, weatherPower, pitcherContactFactor } from '../lib/projections.js';
import { buildParlays, withEdge, describeLeg, MARKET_LABELS } from '../lib/parlay.js';
import { decimalToAmerican } from '../lib/odds.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const API = 'https://statsapi.mlb.com/api/v1';
const BREWERS = 158;
const TZ = 'America/Chicago';

const args = new Set(process.argv.slice(2));
const DEMO = args.has('--demo');
const DRY_RUN = args.has('--dry-run');

const ODDS_KEY = process.env.ODDS_API_KEY ?? '';
const ODDS_BASE = process.env.ODDS_API_BASE ?? 'https://api.the-odds-api.com/v4';

const FP_KEY = process.env.FANTASYPROS_API_KEY ?? '';
const FP_BASE = 'https://api.fantasypros.com/public/v2/json';

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
async function venueConditions(gamePk) {
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

    return {
      roofClosed: /roof closed|dome/i.test(condition),
      temperatureF,
      windMph,
      windDirection,
      description: [condition, wind].filter(Boolean).join(' · ') || 'Conditions unavailable',
    };
  } catch {
    return { roofClosed: false, temperatureF: 72, windMph: 0, windDirection: 'none', description: 'Conditions unavailable' };
  }
}

/**
 * Confirmed lineup from FantasyPros, used only when StatsAPI has not posted one.
 *
 * StatsAPI's lineup hydrate is usually empty until an hour or so before first
 * pitch, and without a lineup there are no batters to project and the board
 * comes up empty. This fills that window.
 */
async function fantasyProsLineup() {
  if (!FP_KEY) return [];
  try {
    const res = await fetch(`${FP_BASE}/mlb/lineups`, {
      headers: { 'x-api-key': FP_KEY, Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const payload = await res.json();

    // Shape is unverified until the probe runs, so accept several plausible
    // containers rather than committing to one and crashing on the others.
    const teams = payload?.lineups ?? payload?.teams ?? payload?.data ?? [];
    const brewers = (Array.isArray(teams) ? teams : []).find((t) =>
      /brewers|milwaukee|\bMIL\b/i.test(JSON.stringify(t?.team ?? t?.name ?? ''))
    );
    const players = brewers?.players ?? brewers?.lineup ?? [];
    return (Array.isArray(players) ? players : [])
      .map((p) => ({ id: p?.mlb_id ?? p?.player_id ?? p?.id, fullName: p?.name ?? p?.player_name }))
      .filter((p) => p.id && p.fullName);
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------------- odds --- */

/**
 * Live player props, if a key is configured.
 *
 * Returns a map of `${playerName}|${market}` to { americanOdds,
 * oppositeAmericanOdds }. An empty map means model-only mode — never invented
 * prices.
 */
async function fetchOdds(gameDate) {
  if (!ODDS_KEY) return { map: new Map(), status: 'no-key' };

  const markets = 'batter_hits,batter_total_bases,batter_home_runs';
  try {
    const events = await getJSON(
      `${ODDS_BASE}/sports/baseball_mlb/events?apiKey=${ODDS_KEY}&dateFormat=iso`
    );
    const event = (events ?? []).find(
      (e) => /Brewers/i.test(`${e.home_team} ${e.away_team}`) && String(e.commence_time).startsWith(gameDate)
    );
    if (!event) return { map: new Map(), status: 'no-event' };

    const odds = await getJSON(
      `${ODDS_BASE}/sports/baseball_mlb/events/${event.id}/odds` +
        `?apiKey=${ODDS_KEY}&regions=us&markets=${markets}&oddsFormat=american`
    );

    const map = new Map();
    for (const book of odds?.bookmakers ?? []) {
      for (const market of book?.markets ?? []) {
        for (const outcome of market?.outcomes ?? []) {
          const key = normalizeMarket(market.key, outcome.point, outcome.name);
          if (!key) continue;
          const id = `${outcome.description ?? outcome.name}|${key}`;
          if (!map.has(id)) map.set(id, { americanOdds: outcome.price, book: book.title });
          else if (/under/i.test(outcome.name)) map.get(id).oppositeAmericanOdds = outcome.price;
        }
      }
    }
    return { map, status: map.size ? 'ok' : 'no-props' };
  } catch (err) {
    return { map: new Map(), status: `error: ${err.message}` };
  }
}

/** Map a book's market naming onto ours. Unknown markets are dropped. */
function normalizeMarket(marketKey, point, name) {
  if (!/over/i.test(name ?? '') && !/under/i.test(name ?? '')) return null;
  const line = Number(point);
  if (marketKey === 'batter_hits') return line >= 1.5 ? 'hits_2' : 'hits_1';
  if (marketKey === 'batter_total_bases') return line >= 2.5 ? 'total_bases_3' : 'total_bases_2';
  // Only the single-home-run market is ever allowed on a ticket.
  if (marketKey === 'batter_home_runs' && line < 1.5) return 'home_run_1';
  return null;
}

/* ----------------------------------------------------------------- run --- */

async function buildBoard(date) {
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

  if (!lineup.length) {
    const fallback = await fantasyProsLineup();
    if (fallback.length) {
      lineup = fallback;
      lineupSource = 'fantasypros';
    }
  }

  const conditions = await venueConditions(game.gamePk);
  const power = weatherPower(conditions);

  const [starterAvg, penContact] = await Promise.all([
    pitcherOpponentAvg(starter?.id, season),
    bullpenContact(opponent?.id, season),
  ]);
  const starterContact = pitcherContactFactor(starterAvg ?? 0.243);

  const batters = lineup.length ? lineup.slice(0, 9) : [];
  const legs = [];

  for (const [index, player] of batters.entries()) {
    const views = await hitterViews(player.id, season, starterHand);
    if (!views.season) continue;

    const projection = projectBatter({
      views,
      lineupSlot: index + 1,
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
        lineupSlot: index + 1,
        market,
        marketLabel: MARKET_LABELS[market],
        modelProbability: probability,
        modelFairOdds: decimalToAmerican(1 / Math.min(0.98, Math.max(0.02, probability))),
        gamePk: game.gamePk,
      });
    }
  }

  const { map: oddsMap, status: oddsStatus } = await fetchOdds(date);

  const priced = legs.map((leg) => {
    const quote = oddsMap.get(`${leg.playerName}|${leg.market}`);
    if (!quote) return { ...leg, americanOdds: null, edge: null };
    return withEdge({ ...leg, americanOdds: quote.americanOdds, oppositeAmericanOdds: quote.oppositeAmericanOdds, book: quote.book });
  });

  const bettable = priced.filter((l) => l.americanOdds != null);
  const parlays = bettable.length ? buildParlays(bettable) : [];

  return {
    date,
    status: 'ok',
    oddsStatus,
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
    factors: { starterContact, bullpenContact: penContact, power },
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

async function main() {
  if (DEMO) {
    const { demoBoard } = await import('../test/fixture-props.js');
    await write(demoBoard());
    return;
  }

  const today = await buildBoard(centralDate());

  // Grade yesterday so the seven-day record fills in as days pass.
  const history = [];
  for (let offset = -1; offset >= -7; offset--) {
    const date = centralDate(offset);
    try {
      const board = await gradeDay(await buildBoard(date));
      if (board.status === 'ok') history.push(board);
    } catch { /* a missing day is not fatal */ }
  }

  await write({ ...today, history, generatedAt: new Date().toISOString(), source: 'live' });
}

async function write(board) {
  console.log(`Board for ${board.date}: ${board.status}, ${board.legs?.length ?? 0} legs, ${board.parlays?.length ?? 0} parlays`);
  console.log(`Odds: ${board.oddsStatus ?? 'n/a'}${ODDS_KEY ? '' : ' (no ODDS_API_KEY set — model-only mode)'}`);
  console.log(`Lineup source: ${board.lineupSource ?? 'n/a'}`);
  if (DRY_RUN) return console.log('--dry-run: nothing written.');

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, 'props-latest.json'), JSON.stringify(board, null, 2));
}

main().catch((err) => {
  console.error('\nProps update failed:', err.message);
  process.exit(1);
});
