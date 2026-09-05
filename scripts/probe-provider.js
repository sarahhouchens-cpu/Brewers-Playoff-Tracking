#!/usr/bin/env node
/**
 * Reports what a data provider's key actually unlocks.
 *
 * The repo could never reach these hosts from the machine it was written on, so
 * rather than guessing at endpoint shapes this runs inside the Action — which
 * does have network — and prints what came back.
 *
 * The key is read from the environment and never printed, not even partially.
 * Only status codes, top-level response keys and array lengths are logged, so
 * the output is safe to leave in a public workflow log.
 *
 *   FANTASYPROS_API_KEY=... node scripts/probe-provider.js
 */

const FP_KEY = process.env.FANTASYPROS_API_KEY ?? '';
const FP_BASE = 'https://api.fantasypros.com/public/v2/json';
const ODDS_KEY = process.env.ODDS_API_KEY ?? '';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const season = new Date().getUTCFullYear();

/**
 * Print the nested shape of an object: key names, types and array lengths.
 *
 * Scalars are shown only for a short allow-list of fields whose literal values
 * we need in order to parse them correctly (wind direction units, roof status,
 * team identifiers). Everything else prints as a type so the log stays a
 * structural map rather than a data dump.
 */
const SHOW_VALUE = new Set([
  'status', 'weather', 'temp', 'wind', 'wind_direction', 'deg_offset',
  'chance_rain', 'roof', 'team_id', 'team', 'abbr', 'abbreviation', 'name',
  'league_key', 'public_api_limited', 'tier', 'limit', 'count', 'position',
  'batting_order', 'order', 'lineup_status',
]);

function shape(value, indent = '    ', depth = 0) {
  if (depth > 4) return;
  if (Array.isArray(value)) {
    console.log(`${indent}[array of ${value.length}]`);
    if (value.length) shape(value[0], indent + '  ', depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, val] of Object.entries(value)) {
    if (Array.isArray(val)) {
      console.log(`${indent}${key}: array(${val.length})`);
      if (val.length && depth < 4) shape(val[0], indent + '  ', depth + 1);
    } else if (val && typeof val === 'object') {
      console.log(`${indent}${key}: object`);
      shape(val, indent + '  ', depth + 1);
    } else {
      const show = SHOW_VALUE.has(key) && String(val).length <= 40;
      console.log(`${indent}${key}: ${show ? JSON.stringify(val) : typeof val}`);
    }
  }
}

/** Endpoints worth knowing about, and why we care. */
const TARGETS = [
  ['mlb/lineups', 'Confirmed starting lineups — would fix the empty-board problem'],
  [`mlb/${season}/projections?position=ALL`, 'Player projections'],
  [`mlb/${season}/consensus-rankings`, 'Consensus rankings'],
  ['mlb/injuries', 'Injury report'],
  // These are speculative. If any returns 200 the odds path opens up.
  ['mlb/odds', 'Odds (speculative — not in the public docs)'],
  ['mlb/props', 'Player props (speculative — not in the public docs)'],
  [`mlb/${season}/props`, 'Player props by season (speculative)'],
];

function summarize(value, depth = 0) {
  if (Array.isArray(value)) return `array(${value.length})${value.length && depth < 1 ? ` of ${summarize(value[0], depth + 1)}` : ''}`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    return `{ ${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ', …' : ''} }`;
  }
  return typeof value;
}

async function probe(path, why) {
  const url = `${FP_BASE}/${path}`;
  try {
    const res = await fetch(url, { headers: { 'x-api-key': FP_KEY, Accept: 'application/json' } });
    const label = `${res.status} ${res.statusText}`;

    if (!res.ok) {
      console.log(`  ${path.padEnd(40)} ${label}`);
      return;
    }
    const body = await res.json();
    console.log(`  ${path.padEnd(40)} ${label}  ${summarize(body)}`);

    // One level deeper on the containers that matter, so the adapter can be
    // written against real field names rather than assumed ones.
    for (const [key, val] of Object.entries(body ?? {})) {
      if (Array.isArray(val) && val.length) {
        console.log(`      .${key} → ${summarize(val)}`);
      }
    }
    console.log(`      (${why})`);
  } catch (err) {
    console.log(`  ${path.padEnd(40)} FAILED  ${err.message}`);
  }
}

async function main() {
  console.log('FantasyPros probe');
  console.log(`  key present: ${FP_KEY ? 'yes' : 'NO — set FANTASYPROS_API_KEY'}`);
  if (!FP_KEY) process.exit(1);

  console.log('\nEndpoints:');
  for (const [path, why] of TARGETS) await probe(path, why);

  // The lineups payload is the one we are going to parse, so map it properly.
  console.log('\n--- mlb/lineups, deep structure of one game ---');
  try {
    const res = await fetch(`${FP_BASE}/mlb/lineups`, {
      headers: { 'x-api-key': FP_KEY, Accept: 'application/json' },
    });
    const payload = await res.json();
    const games = payload?.games ?? [];
    console.log(`  games: ${games.length}`);

    const brewers = games.find((g) => /brewer|milwaukee|\bMIL\b/i.test(JSON.stringify(g?.teams ?? {})));
    const sample = brewers ?? games[0];
    if (!sample) return console.log('  no games in the payload right now');

    console.log(`  showing: ${brewers ? 'the Brewers game' : 'the first game (no Brewers game today)'}`);
    shape(sample);
  } catch (err) {
    console.log(`  deep probe failed: ${err.message}`);
  }

  await probeIdSpace();
  await probeTheOddsApi();

  console.log('\nWhat to look for:');
  console.log('  - mlb/lineups returning 200 means the board can be built before StatsAPI posts a lineup.');
  console.log('  - any odds/props endpoint returning 200 would let the parlay pricing use this key.');
  console.log('  - 401/403 means the key is not valid for that endpoint tier.');
  console.log('  - 404 means the endpoint does not exist, which is the expected answer for the odds ones.');
}

/**
 * Are FantasyPros' lineup player_ids MLB ids?
 *
 * The lineup entries carry no player name, so the whole model depends on being
 * able to join them to StatsAPI. If these ids resolve against StatsAPI's people
 * endpoint the join is free; if not, a name-matching table is needed.
 */
async function probeIdSpace() {
  console.log('\n--- Are FantasyPros lineup ids MLB ids? ---');
  if (!FP_KEY) return console.log('  no FantasyPros key');

  try {
    const res = await fetch(`${FP_BASE}/mlb/lineups`, {
      headers: { 'x-api-key': FP_KEY, Accept: 'application/json' },
    });
    const games = (await res.json())?.games ?? [];
    const game = games.find((g) => g?.hitters?.MIL) ?? games.find((g) => g?.hitters);
    const side = game?.hitters?.MIL ? 'MIL' : Object.keys(game?.hitters ?? {})[0];
    const slots = game?.hitters?.[side] ?? {};

    for (const slot of ['1', '2']) {
      const id = slots[slot]?.player_id;
      if (!id) continue;
      const mlb = await fetch(`https://statsapi.mlb.com/api/v1/people/${id}`);
      const person = mlb.ok ? (await mlb.json())?.people?.[0] : null;
      console.log(`  ${side} slot ${slot}: player_id=${id} → StatsAPI ${mlb.status}` +
        (person ? ` = ${person.fullName} (${person.primaryPosition?.abbreviation})` : ' (no match)'));
    }
    console.log('  A name coming back means the ids are MLB ids and the join is free.');
  } catch (err) {
    console.log(`  failed: ${err.message}`);
  }
}

/** Does the Odds API key actually return MLB player props? */
async function probeTheOddsApi() {
  console.log('\n--- The Odds API ---');
  if (!ODDS_KEY) {
    console.log('  ODDS_API_KEY is empty.');
    console.log('  The workflow maps secrets.TheOdds_API_Key onto it — if that secret exists');
    console.log('  under a different name, the mapping in .github/workflows/probe.yml is wrong.');
    return;
  }
  console.log(`  key present: yes (${ODDS_KEY.length} chars)`);

  const quota = (res) => {
    const remaining = res.headers.get('x-requests-remaining');
    const used = res.headers.get('x-requests-used');
    return remaining ? `  [quota: ${used} used, ${remaining} remaining]` : '';
  };

  try {
    const sports = await fetch(`${ODDS_BASE}/sports?apiKey=${ODDS_KEY}`);
    console.log(`  /sports                                  ${sports.status} ${sports.statusText}${quota(sports)}`);
    if (!sports.ok) {
      console.log('  Key rejected — check it was pasted whole, with no stray whitespace.');
      return;
    }

    const evRes = await fetch(`${ODDS_BASE}/sports/baseball_mlb/events?apiKey=${ODDS_KEY}`);
    const events = evRes.ok ? await evRes.json() : [];
    console.log(`  /baseball_mlb/events                     ${evRes.status} ${evRes.statusText}  ${events.length} events${quota(evRes)}`);

    const brewers = events.find((e) => /brewers/i.test(`${e.home_team} ${e.away_team}`));
    const target = brewers ?? events[0];
    if (!target) return console.log('  no MLB events listed right now');
    console.log(`  using: ${target.away_team} @ ${target.home_team}${brewers ? '  (Brewers game)' : '  (no Brewers game listed)'}`);

    // The decisive call: player props for one event.
    const markets = 'batter_hits,batter_total_bases,batter_home_runs';
    const oddsRes = await fetch(
      `${ODDS_BASE}/sports/baseball_mlb/events/${target.id}/odds` +
      `?apiKey=${ODDS_KEY}&regions=us&markets=${markets}&oddsFormat=american`
    );
    console.log(`  /events/{id}/odds  (player props)        ${oddsRes.status} ${oddsRes.statusText}${quota(oddsRes)}`);

    if (!oddsRes.ok) {
      console.log(`  body: ${(await oddsRes.text()).slice(0, 300)}`);
      console.log('  A 422 here usually means player props are not on this plan.');
      return;
    }

    const odds = await oddsRes.json();
    const books = odds?.bookmakers ?? [];
    console.log(`  bookmakers: ${books.length}`);
    for (const book of books.slice(0, 3)) {
      for (const market of book?.markets ?? []) {
        const o = market?.outcomes?.[0];
        console.log(`    ${book.title} / ${market.key}: ${market.outcomes?.length ?? 0} outcomes` +
          (o ? ` — e.g. ${JSON.stringify({ name: o.name, description: o.description, point: o.point, price: o.price })}` : ''));
      }
    }
    console.log('  Outcomes carrying a player name in `description` is what the adapter needs.');
  } catch (err) {
    console.log(`  failed: ${err.message}`);
  }
}

main().catch((err) => {
  console.error('Probe failed:', err.message);
  process.exit(1);
});
