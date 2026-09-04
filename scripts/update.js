#!/usr/bin/env node
/**
 * Fetches MLB standings + the day's scores, computes the Brewers' four magic
 * numbers, and writes them to data/.
 *
 * Runs on a GitHub Actions schedule. Nothing here runs in the browser — the
 * site only ever reads the JSON this produces, which is why the page has no
 * CORS dependency and stays up even when MLB's API doesn't.
 *
 *   node scripts/update.js            # live
 *   node scripts/update.js --demo     # offline, uses the test fixture
 *   node scripts/update.js --dry-run  # fetch + compute, write nothing
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeRaces, headlineRace, diffRaces } from '../lib/magic.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const API = 'https://statsapi.mlb.com/api/v1';
const TEAM_NAME = 'Milwaukee Brewers';
const TZ = 'America/Chicago';

const args = new Set(process.argv.slice(2));
const DEMO = args.has('--demo');
const DRY_RUN = args.has('--dry-run');

/** YYYY-MM-DD in Central time — the Brewers' own calendar day. */
function centralDate(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

async function getJSON(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'brewers-playoff-tracking' },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
  return res.json();
}

/**
 * Turn the standings + teams responses into the flat shape lib/magic.js wants.
 *
 * MLB's payload is nested and the exact field names are the one thing this repo
 * could not verify before first run, so every lookup is optional-chained and a
 * miss produces a diagnostic rather than a crash deep in the math.
 */
function normalize(standings, teamsPayload) {
  const meta = new Map();
  for (const t of teamsPayload?.teams ?? []) {
    meta.set(t.id, {
      name: t.name ?? t.teamName ?? null,
      abbrev: t.abbreviation ?? t.teamCode?.toUpperCase() ?? String(t.id),
      leagueId: t.league?.id ?? null,
      divisionId: t.division?.id ?? null,
    });
  }

  const teams = [];
  for (const record of standings?.records ?? []) {
    for (const tr of record?.teamRecords ?? []) {
      const id = tr?.team?.id;
      if (id == null) continue;
      const extra = meta.get(id) ?? {};
      teams.push({
        id,
        name: extra.name ?? tr.team?.name ?? `Team ${id}`,
        abbrev: extra.abbrev ?? String(id),
        wins: Number(tr.wins ?? 0),
        losses: Number(tr.losses ?? 0),
        // Prefer the standings grouping; fall back to the teams endpoint.
        leagueId: record?.league?.id ?? extra.leagueId ?? null,
        divisionId: record?.division?.id ?? extra.divisionId ?? null,
      });
    }
  }
  return teams;
}

function assertUsable(teams) {
  const problems = [];
  if (teams.length < 30) problems.push(`parsed only ${teams.length} teams, expected 30`);
  if (teams.some((t) => t.divisionId == null)) problems.push('some teams have no divisionId');
  if (teams.some((t) => t.leagueId == null)) problems.push('some teams have no leagueId');
  if (!teams.some((t) => t.name === TEAM_NAME)) {
    const sample = teams.slice(0, 3).map((t) => t.name).join(', ');
    problems.push(`no team named "${TEAM_NAME}" (first names parsed: ${sample})`);
  }
  if (teams.every((t) => t.wins === 0)) problems.push('every team has 0 wins');
  if (problems.length) throw new Error(`Standings response not usable:\n  - ${problems.join('\n  - ')}`);
}

/** Pull finals for the most recent slate that actually has any. */
async function fetchRecentFinals() {
  for (const offset of [0, -1, -2]) {
    const date = centralDate(offset);
    const payload = await getJSON(`${API}/schedule?sportId=1&date=${date}`);
    const games = (payload?.dates ?? []).flatMap((d) => d?.games ?? []);
    const finals = games
      .filter((g) => /final|completed/i.test(g?.status?.detailedState ?? ''))
      .map((g) => ({
        homeId: g?.teams?.home?.team?.id,
        awayId: g?.teams?.away?.team?.id,
        homeName: g?.teams?.home?.team?.name,
        awayName: g?.teams?.away?.team?.name,
        homeScore: Number(g?.teams?.home?.score ?? 0),
        awayScore: Number(g?.teams?.away?.score ?? 0),
      }))
      .filter((g) => g.homeId != null && g.awayId != null);

    if (finals.length) return { date, finals };
  }
  return { date: centralDate(), finals: [] };
}

/**
 * Build the feed: only games that can touch a magic number, each annotated with
 * what it moved and why. Everything else in the day's slate is dropped.
 */
function buildFeed(finals, result, brewersId) {
  const { races } = result;

  // One chaser can front several races (e.g. best-in-NL and best-in-MLB).
  const chaserRaces = new Map();
  for (const race of races) {
    if (!race.chaser) continue;
    const list = chaserRaces.get(race.chaser.id) ?? [];
    list.push(race);
    chaserRaces.set(race.chaser.id, list);
  }

  const cards = [];
  for (const g of finals) {
    const winnerId = g.homeScore > g.awayScore ? g.homeId : g.awayId;
    const involves = (id) => g.homeId === id || g.awayId === id;
    const score = () => {
      const [wName, wRuns, lName, lRuns] =
        g.homeScore > g.awayScore
          ? [g.homeName, g.homeScore, g.awayName, g.awayScore]
          : [g.awayName, g.awayScore, g.homeName, g.homeScore];
      return `${wName} ${wRuns}, ${lName} ${lRuns}`;
    };

    if (involves(brewersId)) {
      const won = winnerId === brewersId;
      cards.push({
        kind: won ? 'brewers-win' : 'brewers-loss',
        tag: 'Brewers · Final',
        score: score(),
        why: won
          ? 'A win drops every magic number by one — the only result that moves all four at once.'
          : 'A loss never raises a magic number. It just burns a game off the schedule.',
        impacts: won ? races.map((r) => ({ key: r.key, label: r.label, delta: -1 })) : [],
      });
      continue;
    }

    const affected = chaserRaces.get(g.homeId) ?? chaserRaces.get(g.awayId);
    if (!affected) continue;

    const chaserId = chaserRaces.has(g.homeId) ? g.homeId : g.awayId;
    const chaserLost = winnerId !== chaserId;
    const names = affected.map((r) => r.label).join(' and ');
    const chaserName = chaserId === g.homeId ? g.homeName : g.awayName;

    cards.push({
      kind: chaserLost ? 'chaser-loss' : 'chaser-win',
      tag: `Chaser · ${affected[0].label}`,
      score: score(),
      why: chaserLost
        ? `${chaserName} is the team the ${names} number is measured against, so their loss trims it by one.`
        : `${chaserName} holds the mark for ${names}. A win for them doesn't raise the number — it just removes a chance for it to fall.`,
      impacts: chaserLost ? affected.map((r) => ({ key: r.key, label: r.label, delta: -1 })) : [],
    });
  }

  // Brewers first, then games that moved something, then the rest.
  const rank = (c) => (c.tag.startsWith('Brewers') ? 0 : c.impacts.length ? 1 : 2);
  return cards.sort((a, b) => rank(a) - rank(b));
}

async function readPrevious() {
  try {
    return JSON.parse(await readFile(join(DATA_DIR, 'latest.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function loadTeams() {
  if (DEMO) {
    const { fixtureTeams } = await import('../test/fixture-standings.js');
    return { teams: fixtureTeams, raw: null };
  }

  const season = new Date().getUTCFullYear();
  const [standings, teamsPayload] = await Promise.all([
    getJSON(`${API}/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`),
    getJSON(`${API}/teams?sportId=1&season=${season}`),
  ]);

  const teams = normalize(standings, teamsPayload);
  return { teams, raw: { standings, teamsPayload } };
}

async function main() {
  const { teams, raw } = await loadTeams();

  try {
    assertUsable(teams);
  } catch (err) {
    // First-run safety net: dump enough of the response to fix the parser
    // without needing network access from wherever this is being debugged.
    if (raw) {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(
        join(DATA_DIR, '_debug-raw.json'),
        JSON.stringify(
          {
            standingsTopLevelKeys: Object.keys(raw.standings ?? {}),
            firstRecord: raw.standings?.records?.[0],
            firstTeam: raw.teamsPayload?.teams?.[0],
          },
          null,
          2
        )
      );
      console.error('Wrote data/_debug-raw.json with the response shape.');
    }
    throw err;
  }

  const brewers = teams.find((t) => t.name === TEAM_NAME);
  const result = computeRaces(teams, brewers.id);
  const previous = await readPrevious();

  let date, finals;
  if (DEMO) {
    ({ fixtureFinals: finals } = await import('../test/fixture-finals.js'));
    date = '2026-09-04';
  } else {
    ({ date, finals } = await fetchRecentFinals());
  }

  const snapshot = {
    source: DEMO ? 'demo' : 'live',
    generatedAt: new Date().toISOString(),
    slateDate: date,
    team: result.team,
    gamesPlayed: result.gamesPlayed,
    gamesRemaining: result.gamesRemaining,
    races: result.races,
    headline: headlineRace(result.races).key,
    deltas: diffRaces(result.races, previous?.races ?? null),
    feed: buildFeed(finals, result, brewers.id),
  };

  for (const race of snapshot.races) {
    const chaser = race.chaser ? `${race.chaser.abbrev} ${race.chaser.wins}-${race.chaser.losses}` : '—';
    console.log(`${race.label.padEnd(18)} ${String(race.magic).padStart(3)}   vs ${chaser}`);
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: nothing written.');
    return;
  }

  await mkdir(DATA_DIR, { recursive: true });
  const json = JSON.stringify(snapshot, null, 2);
  await writeFile(join(DATA_DIR, 'latest.json'), json);
  await writeFile(join(DATA_DIR, `${snapshot.slateDate}.json`), json);
  console.log(`\nWrote data/latest.json and data/${snapshot.slateDate}.json`);
}

main().catch((err) => {
  console.error('\nUpdate failed:', err.message);
  process.exit(1);
});
