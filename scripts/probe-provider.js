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

  console.log('\nWhat to look for:');
  console.log('  - mlb/lineups returning 200 means the board can be built before StatsAPI posts a lineup.');
  console.log('  - any odds/props endpoint returning 200 would let the parlay pricing use this key.');
  console.log('  - 401/403 means the key is not valid for that endpoint tier.');
  console.log('  - 404 means the endpoint does not exist, which is the expected answer for the odds ones.');
}

main().catch((err) => {
  console.error('Probe failed:', err.message);
  process.exit(1);
});
