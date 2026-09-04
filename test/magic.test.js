import test from 'node:test';
import assert from 'node:assert/strict';

import {
  magicNumber,
  eliminationNumber,
  firstTeamOut,
  computeRaces,
  headlineRace,
  diffRaces,
} from '../lib/magic.js';
import { fixtureTeams, BREWERS_ID } from './fixture-standings.js';

const racesFor = (teams = fixtureTeams) => computeRaces(teams, BREWERS_ID);
const race = (key, teams) => racesFor(teams).races.find((r) => r.key === key);

test('magicNumber: 163 - leader wins - chaser losses', () => {
  // Brewers 87 wins, Padres 67 losses -> 163 - 87 - 67 = 9
  assert.equal(magicNumber(87, 67), 9);
  assert.equal(magicNumber(90, 64), 9);
});

test('magicNumber clamps at zero once clinched', () => {
  assert.equal(magicNumber(100, 63), 0);
  assert.equal(magicNumber(120, 80), 0, 'never reports a negative magic number');
});

test('eliminationNumber is the chaser magic number, mirrored', () => {
  // Brewers 54 losses, Padres 74 wins -> 163 - 74 - 54 = 35
  assert.equal(eliminationNumber(54, 74), 35);
});

test('firstTeamOut returns the 7th team in the playoff standings', () => {
  const nl = fixtureTeams.filter((t) => t.leagueId === 104);
  const out = firstTeamOut(nl);
  // Leaders MIL/PHI/LAD; wild cards CHC/NYM/SF; San Diego is first out.
  assert.equal(out.abbrev, 'SD');
});

test('firstTeamOut skips division leaders with weak records', () => {
  // Drag every NL Central team down so the division leader has a worse record
  // than several non-leaders. The leader must still be treated as IN.
  const teams = fixtureTeams.map((t) =>
    t.divisionId === 205 ? { ...t, wins: 60, losses: t.losses + 20 } : t
  );
  const weakLeader = { ...teams.find((t) => t.id === BREWERS_ID), wins: 62, losses: 79 };
  const nl = teams.map((t) => (t.id === BREWERS_ID ? weakLeader : t)).filter((t) => t.leagueId === 104);

  const out = firstTeamOut(nl);
  assert.notEqual(out.divisionId, 205, 'a division leader is never the first team out');
});

test('the four September 4 magic numbers', () => {
  assert.equal(race('berth').magic, 9, 'playoff berth');
  assert.equal(race('division').magic, 14, 'NL Central');
  assert.equal(race('leagueSeed').magic, 19, 'NL No. 1 seed');
});

test('each race picks its own chaser', () => {
  assert.equal(race('berth').chaser.abbrev, 'SD');
  assert.equal(race('division').chaser.abbrev, 'CHC');
  assert.equal(race('leagueSeed').chaser.abbrev, 'PHI');
});

test('best-record chaser is league-agnostic, not "best AL team"', () => {
  // Yankees 85-56 (.603) beat the Phillies 84-57 (.596), so they are the chaser.
  assert.equal(race('bestRecord').chaser.abbrev, 'NYY');
  assert.equal(race('bestRecord').magic, magicNumber(87, 56));

  // Give the Dodgers the best record in baseball: an NL team must now be the
  // chaser for the MLB-wide number.
  const nlBest = fixtureTeams.map((t) =>
    t.abbrev === 'LAD' ? { ...t, wins: 95, losses: 46 } : t
  );
  assert.equal(race('bestRecord', nlBest).chaser.abbrev, 'LAD');
});

test('games remaining comes off the 162-game schedule', () => {
  const result = racesFor();
  assert.equal(result.gamesPlayed, 141);
  assert.equal(result.gamesRemaining, 21);
});

test('a Brewers win drops every magic number by one', () => {
  const before = racesFor().races;
  const after = racesFor(
    fixtureTeams.map((t) => (t.id === BREWERS_ID ? { ...t, wins: t.wins + 1 } : t))
  ).races;

  for (const r of after) {
    const prev = before.find((p) => p.key === r.key);
    assert.equal(r.magic, prev.magic - 1, `${r.key} should fall by exactly 1`);
  }
});

test('a Brewers loss moves nothing', () => {
  const before = racesFor().races;
  const after = racesFor(
    fixtureTeams.map((t) => (t.id === BREWERS_ID ? { ...t, losses: t.losses + 1 } : t))
  ).races;

  for (const r of after) {
    assert.equal(r.magic, before.find((p) => p.key === r.key).magic, `${r.key} must not move`);
  }
});

test('a chaser loss moves only that race', () => {
  const before = racesFor().races;
  const after = racesFor(
    fixtureTeams.map((t) => (t.abbrev === 'CHC' ? { ...t, losses: t.losses + 1 } : t))
  ).races;

  const magicOf = (rs, key) => rs.find((r) => r.key === key).magic;
  assert.equal(magicOf(after, 'division'), magicOf(before, 'division') - 1);
  assert.equal(magicOf(after, 'berth'), magicOf(before, 'berth'));
  assert.equal(magicOf(after, 'leagueSeed'), magicOf(before, 'leagueSeed'));
  assert.equal(magicOf(after, 'bestRecord'), magicOf(before, 'bestRecord'));
});

test('headlineRace leads with the berth, then walks up the ladder', () => {
  assert.equal(headlineRace(racesFor().races).key, 'berth');

  // Win enough to clinch the berth outright (163 - 96 - 67 = 0) while the
  // division is still live. Tanking the chaser would not work here: another
  // team simply inherits the first-out slot.
  const clinched = fixtureTeams.map((t) =>
    t.id === BREWERS_ID ? { ...t, wins: 96 } : t
  );
  const races = racesFor(clinched).races;
  assert.ok(races.find((r) => r.key === 'division').magic > 0, 'division still live');
  assert.equal(races.find((r) => r.key === 'berth').clinched, true);
  assert.equal(headlineRace(races).key, 'division', 'promotes the next unclinched race');
});

test('diffRaces reports per-race movement', () => {
  const before = racesFor().races;
  const after = racesFor(
    fixtureTeams.map((t) => (t.id === BREWERS_ID ? { ...t, wins: t.wins + 1 } : t))
  ).races;

  for (const d of diffRaces(after, before)) {
    assert.equal(d.delta, -1);
    assert.equal(d.chaserChanged, false);
  }
});

test('diffRaces flags a chaser swap that makes the number rise', () => {
  const before = racesFor().races;

  // San Diego surges past the Giants; Arizona collapses into the first-out
  // slot with fewer losses than San Diego had, pushing the berth number UP.
  const shuffled = fixtureTeams.map((t) => {
    if (t.abbrev === 'SD') return { ...t, wins: 80, losses: 61 };
    if (t.abbrev === 'SF') return { ...t, wins: 79, losses: 62 };
    if (t.abbrev === 'ARI') return { ...t, wins: 78, losses: 63 };
    return t;
  });
  const after = racesFor(shuffled).races;
  const berthDiff = diffRaces(after, before).find((d) => d.key === 'berth');

  assert.equal(after.find((r) => r.key === 'berth').chaser.abbrev, 'ARI');
  assert.equal(berthDiff.chaserChanged, true);
  assert.equal(berthDiff.previousChaser.abbrev, 'SD');
  assert.ok(berthDiff.delta > 0, 'the magic number rose even without a Brewers loss');
});

test('diffRaces tolerates a missing previous snapshot', () => {
  for (const d of diffRaces(racesFor().races, null)) {
    assert.equal(d.delta, null);
  }
});

test('computeRaces fails loudly on an unknown team id', () => {
  assert.throws(() => computeRaces(fixtureTeams, 999), /not found in standings/);
});
