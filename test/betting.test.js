import test from 'node:test';
import assert from 'node:assert/strict';

import {
  americanToDecimal, decimalToAmerican, formatAmerican,
  impliedProbability, devig, parlayDecimal, payout, profit,
  parlayProbability, expectedValue,
} from '../lib/odds.js';
import {
  blendRates, normalize, applyContext, weatherPower,
  totalBasesDistribution, projectBatter, pitcherContactFactor,
  RATE_WEIGHTS, PA_DISTRIBUTION,
} from '../lib/projections.js';
import {
  buildParlays, validateParlay, isEligibleLeg, withEdge,
  PAYOUT_WINDOW, STAKE,
} from '../lib/parlay.js';
import * as projections from '../lib/projections.js';

const require_projections = () => projections;

import * as oddsLib from '../lib/odds.js';
const projections_odds = () => oddsLib;

import * as parlayLibModule from '../lib/parlay.js';
const parlayLib = () => parlayLibModule;

const near = (a, b, tol = 1e-6, msg) => assert.ok(Math.abs(a - b) < tol, msg ?? `${a} !~= ${b}`);

/* ---------------------------------------------------------------- odds --- */

test('American to decimal, both signs', () => {
  near(americanToDecimal(100), 2.0);
  near(americanToDecimal(150), 2.5);
  near(americanToDecimal(-120), 1 + 100 / 120);
  near(americanToDecimal(-200), 1.5);
});

test('decimal to American round-trips', () => {
  for (const a of [-350, -200, -120, -110, 100, 150, 275, 900]) {
    assert.equal(decimalToAmerican(americanToDecimal(a)), a);
  }
});

test('odds formatting keeps the sign a book shows', () => {
  assert.equal(formatAmerican(150), '+150');
  assert.equal(formatAmerican(-120), '-120');
});

test('devig strips the book margin so probabilities sum to one', () => {
  const fair = devig([americanToDecimal(-120), americanToDecimal(-110)]);
  near(fair.reduce((a, b) => a + b, 0), 1);
  assert.ok(fair[0] > fair[1], 'the favourite keeps the larger share');
  // Vigged implied probability overstates the true chance.
  assert.ok(fair[0] < impliedProbability(americanToDecimal(-120)));
});

test('parlay odds multiply and pay out on the stake', () => {
  const legs = [{ americanOdds: 100 }, { americanOdds: 100 }, { americanOdds: 100 }];
  near(parlayDecimal(legs), 8);
  near(payout(5, 8), 40);
  near(profit(5, 8), 35);
});

test('parlay probability penalises legs sharing a game', () => {
  const independent = [
    { modelProbability: 0.6, gamePk: 1 },
    { modelProbability: 0.6, gamePk: 2 },
    { modelProbability: 0.6, gamePk: 3 },
  ];
  const stacked = [
    { modelProbability: 0.6, gamePk: 1 },
    { modelProbability: 0.6, gamePk: 1 },
    { modelProbability: 0.6, gamePk: 1 },
  ];
  near(parlayProbability(independent), 0.216);
  assert.ok(parlayProbability(stacked) < parlayProbability(independent),
    'same-game legs are correlated, so the naive product is too generous');
});

test('expected value turns positive only when the price beats the model', () => {
  // True 50% shot priced at +120 is a good bet; at -120 it is not.
  assert.ok(expectedValue(5, americanToDecimal(120), 0.5) > 0);
  assert.ok(expectedValue(5, americanToDecimal(-120), 0.5) < 0);
});

/* ---------------------------------------------------------- projections --- */

const leagueish = { single: 0.15, double: 0.045, triple: 0.004, homeRun: 0.032 };

test('normalize turns rates into a real distribution', () => {
  const r = normalize(leagueish);
  near(r.single + r.double + r.triple + r.homeRun + r.out, 1);
  assert.ok(r.out > 0.7);
});

test('normalize clamps impossible rates instead of producing negative outs', () => {
  const r = normalize({ single: 0.8, double: 0.4, triple: 0.1, homeRun: 0.2 });
  assert.ok(r.out >= 0, 'out never goes negative');
  near(r.single + r.double + r.triple + r.homeRun + r.out, 1);
});

test('blendRates weights season, recent form and platoon split', () => {
  const hot = { single: 0.25, double: 0.08, triple: 0.01, homeRun: 0.06 };
  const blended = blendRates({ season: leagueish, last15: hot, platoon: leagueish });
  assert.ok(blended.single > leagueish.single, 'a hot streak lifts the blend');
  assert.ok(blended.single < hot.single, 'but never all the way to the hot-streak rate');
});

test('blendRates handles a missing view by reweighting the rest', () => {
  const blended = blendRates({ season: leagueish, last15: null, platoon: null });
  near(blended.single, normalize(leagueish).single, 1e-9);
});

test('season carries more weight than recent form', () => {
  assert.ok(RATE_WEIGHTS.season > RATE_WEIGHTS.last15,
    'last-15 is ~60 PA and too noisy to outweigh the season sample');
});

test('applyContext scales power without touching singles', () => {
  const base = normalize(leagueish);
  const boosted = applyContext(base, { contact: 1, power: 1.15 });
  near(boosted.single, base.single, 1e-9, 'singles are not a power outcome');
  assert.ok(boosted.homeRun > base.homeRun);
});

test('a closed roof makes weather irrelevant', () => {
  assert.equal(weatherPower({ roofClosed: true, temperatureF: 40, windMph: 20, windDirection: 'in' }), 1);
});

test('wind direction moves power the right way', () => {
  const out = weatherPower({ windMph: 15, windDirection: 'out' });
  const inward = weatherPower({ windMph: 15, windDirection: 'in' });
  assert.ok(out > 1 && inward < 1);
  assert.ok(out > inward);
});

test('total bases distribution is a valid distribution', () => {
  const dist = totalBasesDistribution(normalize(leagueish), PA_DISTRIBUTION[3]);
  near(dist.reduce((a, b) => a + b, 0), 1, 1e-9);
  assert.ok(dist.every((p) => p >= 0));
});

test('lineup slot changes the projection through plate appearances', () => {
  const views = { season: leagueish, last15: leagueish, platoon: leagueish };
  const leadoff = projectBatter({ views, lineupSlot: 1 });
  const ninth = projectBatter({ views, lineupSlot: 9 });
  assert.ok(leadoff.probability.totalBases2 > ninth.probability.totalBases2,
    'more trips to the plate means more chances');
  assert.ok(leadoff.expectedTotalBases > ninth.expectedTotalBases);
});

test('a tougher starter suppresses every contact outcome', () => {
  const views = { season: leagueish, last15: leagueish, platoon: leagueish };
  const easy = projectBatter({ views, lineupSlot: 3, starterContact: 1.2 });
  const tough = projectBatter({ views, lineupSlot: 3, starterContact: 0.8 });
  assert.ok(tough.probability.hit1 < easy.probability.hit1);
  assert.ok(tough.probability.totalBases2 < easy.probability.totalBases2);
});

test('bullpen exposure is blended, not ignored', () => {
  const views = { season: leagueish, last15: leagueish, platoon: leagueish };
  const nasty = projectBatter({ views, lineupSlot: 3, starterContact: 1, bullpenContact: 0.7 });
  const neutral = projectBatter({ views, lineupSlot: 3, starterContact: 1, bullpenContact: 1 });
  assert.ok(nasty.probability.hit1 < neutral.probability.hit1,
    'a shutdown bullpen lowers the projection even with the same starter');
});

test('projected probabilities are ordered sensibly', () => {
  const p = projectBatter({
    views: { season: leagueish, last15: leagueish, platoon: leagueish },
    lineupSlot: 2,
  }).probability;
  assert.ok(p.hit1 > p.hit2, '1+ hit is easier than 2+');
  assert.ok(p.totalBases2 > p.totalBases3, '2+ bases is easier than 3+');
  assert.ok(p.hit1 > p.homeRun1, 'a hit is far likelier than a homer');
  for (const v of Object.values(p)) assert.ok(v > 0 && v < 1, 'every probability is a real probability');
});

test('projected 1+ hit lands in a believable band for a league-average bat', () => {
  const p = projectBatter({
    views: { season: leagueish, last15: leagueish, platoon: leagueish },
    lineupSlot: 3,
  }).probability;
  // Real-world 1+ hit props sit around -160 to -200, i.e. roughly 60-67%.
  assert.ok(p.hit1 > 0.5 && p.hit1 < 0.75, `got ${p.hit1}`);
});

test('pitcher contact factor is clamped against absurd inputs', () => {
  assert.equal(pitcherContactFactor(0), 1, 'missing data falls back to neutral');
  assert.ok(pitcherContactFactor(0.400) <= 1.3);
  assert.ok(pitcherContactFactor(0.100) >= 0.75);
});

/* -------------------------------------------------------------- parlays --- */

const leg = (id, market, odds, prob, gamePk = 1) => ({
  playerId: id, playerName: `Player ${id}`, market,
  americanOdds: odds, modelProbability: prob, gamePk, edge: 2,
});

test('banned markets can never become a leg', () => {
  assert.equal(isEligibleLeg(leg(1, 'home_run_2', 900, 0.05)), false);
  assert.equal(isEligibleLeg(leg(1, 'home_run_multi', 2000, 0.01)), false);
  assert.equal(isEligibleLeg(leg(1, 'grand_slam', 5000, 0.005)), false);
  assert.equal(isEligibleLeg(leg(1, 'total_bases_2', 150, 0.45)), true);
});

test('a ticket may carry at most one home run leg', () => {
  const two = [
    leg(1, 'home_run_1', 400, 0.12),
    leg(2, 'home_run_1', 420, 0.11),
    leg(3, 'hits_1', -150, 0.62),
  ];
  assert.equal(validateParlay(two), false);

  const one = [
    leg(1, 'home_run_1', 400, 0.12),
    leg(2, 'total_bases_2', 130, 0.46),
    leg(3, 'hits_1', -150, 0.62),
  ];
  assert.equal(validateParlay(one), true);
});

test('the same player cannot appear twice', () => {
  const dupe = [
    leg(1, 'hits_1', -150, 0.62),
    leg(1, 'total_bases_2', 130, 0.46),
    leg(2, 'hits_1', -140, 0.6),
  ];
  assert.equal(validateParlay(dupe), false);
});

test('leg count stays between three and five', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => leg(i + 1, 'hits_1', -150, 0.62));
  assert.equal(validateParlay(mk(2)), false);
  assert.equal(validateParlay(mk(3)), true);
  assert.equal(validateParlay(mk(5)), true);
  assert.equal(validateParlay(mk(6)), false);
});

test('built parlays all land inside the payout window', () => {
  const candidates = [
    leg(1, 'total_bases_2', 145, 0.44, 1),
    leg(2, 'hits_1', -140, 0.60, 2),
    leg(3, 'total_bases_2', 160, 0.42, 3),
    leg(4, 'hits_2', 260, 0.30, 4),
    leg(5, 'home_run_1', 380, 0.13, 5),
    leg(6, 'total_bases_3', 300, 0.27, 6),
    leg(7, 'hits_1', -125, 0.58, 7),
  ];
  const tickets = buildParlays(candidates);
  assert.ok(tickets.length > 0, 'expected at least one qualifying ticket');
  for (const t of tickets) {
    assert.ok(t.payout >= PAYOUT_WINDOW.min && t.payout <= PAYOUT_WINDOW.max,
      `payout ${t.payout} outside window`);
    assert.equal(validateParlay(t.legs), true);
    assert.equal(t.stake, STAKE);
  }
});

test('build refuses to emit a ticket containing a banned market', () => {
  const candidates = [
    leg(1, 'home_run_2', 1200, 0.02, 1),
    leg(2, 'home_run_multi', 2500, 0.01, 2),
    leg(3, 'total_bases_2', 145, 0.44, 3),
    leg(4, 'hits_1', -140, 0.60, 4),
    leg(5, 'total_bases_2', 170, 0.41, 5),
    leg(6, 'hits_2', 240, 0.31, 6),
  ];
  for (const t of buildParlays(candidates)) {
    for (const l of t.legs) {
      assert.ok(!['home_run_2', 'home_run_multi', 'grand_slam'].includes(l.market));
    }
  }
});

test('tickets are ranked by expected value', () => {
  const candidates = [
    leg(1, 'total_bases_2', 145, 0.44, 1),
    leg(2, 'hits_1', -140, 0.60, 2),
    leg(3, 'total_bases_2', 160, 0.42, 3),
    leg(4, 'hits_2', 260, 0.30, 4),
    leg(5, 'total_bases_3', 300, 0.27, 5),
    leg(6, 'hits_1', -125, 0.58, 6),
  ];
  const tickets = buildParlays(candidates);
  for (let i = 1; i < tickets.length; i++) {
    assert.ok(tickets[i - 1].expectedValue >= tickets[i].expectedValue);
  }
});

test('withEdge devigs when both sides are known', () => {
  const scored = withEdge({ ...leg(1, 'total_bases_2', 130, 0.50), oppositeAmericanOdds: -160 });
  assert.ok(scored.fairProbability > 0 && scored.fairProbability < 1);
  assert.ok(scored.fairProbability < scored.impliedProbability,
    'the fair price is always kinder than the vigged one');
  near(scored.edge, (0.50 - scored.fairProbability) * 100, 1e-9);
});

test('withEdge refuses to invent an edge from a one-sided price', () => {
  const scored = withEdge(leg(1, 'total_bases_2', 130, 0.50));
  assert.equal(scored.fairProbability, null);
  assert.equal(scored.edge, null, 'no opposite side means no honest edge number');
});

test('the board does not return six versions of the same ticket', () => {
  const candidates = [
    leg(1, 'total_bases_2', 145, 0.44, 1),
    leg(2, 'hits_1', -140, 0.60, 2),
    leg(3, 'total_bases_2', 160, 0.42, 3),
    leg(4, 'hits_2', 260, 0.30, 4),
    leg(5, 'total_bases_3', 300, 0.27, 5),
    leg(6, 'hits_1', -125, 0.58, 6),
    leg(7, 'total_bases_2', 150, 0.43, 7),
    leg(8, 'hits_1', -135, 0.59, 8),
    leg(9, 'home_run_1', 400, 0.12, 9),
  ];
  const tickets = buildParlays(candidates, { limit: 6, maxLegRepeat: 2 });
  const uses = new Map();
  for (const t of tickets) {
    for (const l of t.legs) {
      const k = `${l.playerId}|${l.market}`;
      uses.set(k, (uses.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of uses) {
    assert.ok(n <= 2, `leg ${k} appeared on ${n} tickets, cap is 2`);
  }
});

/* ----------------------------------------------------------- park factor --- */

test('park power reflects the venue, not the team', () => {
  const { parkPower } = require_projections();
  assert.ok(parkPower('Great American Ball Park') > 1.1, 'Cincinnati is homer-friendly');
  assert.ok(parkPower('Oracle Park') < 0.9, 'San Francisco suppresses power');
  assert.equal(parkPower('Some Unlisted Field'), 1, 'unknown parks play neutral');
});

test('a closed roof still keeps the park factor', () => {
  const { weatherPower } = require_projections();
  // Weather is neutralised, but the ballpark's dimensions do not close with it.
  const closed = weatherPower({ roofClosed: true, venue: 'American Family Field', temperatureF: 40, windMph: 20, windDirection: 'in' });
  assert.ok(closed > 1, 'American Family Field plays slightly hitter-friendly indoors');
  assert.equal(weatherPower({ roofClosed: true, venue: 'Some Unlisted Field' }), 1);
});

test('roof status is a property of the venue', () => {
  const { isRoofed } = require_projections();
  assert.equal(isRoofed('American Family Field'), true);
  assert.equal(isRoofed('Great American Ball Park'), false, 'Cincinnati is open air');
});

test('a hot night in Cincinnati compounds park and weather', () => {
  const { weatherPower } = require_projections();
  const cincy = weatherPower({ venue: 'Great American Ball Park', temperatureF: 93, windMph: 11, windDirection: 'out' });
  const neutral = weatherPower({ venue: 'Some Unlisted Field', temperatureF: 72, windMph: 0 });
  assert.ok(cincy > neutral * 1.1, `expected a clear boost, got ${cincy} vs ${neutral}`);
  assert.ok(cincy <= 1.35, 'still clamped against runaway multipliers');
});

/* -------------------------------------------------- missing-price guards --- */

test('a missing price is not a valid price', () => {
  const { isValidAmerican } = projections_odds();
  for (const bad of [null, undefined, '', 0, NaN, 'abc', {}]) {
    assert.equal(isValidAmerican(bad), false, `${JSON.stringify(bad)} should be rejected`);
  }
  for (const good of [100, -110, '150', -350]) {
    assert.equal(isValidAmerican(good), true, `${good} should be accepted`);
  }
});

test('a leg with no price never becomes eligible', () => {
  // Number(null) is 0 and passes isFinite, which is how a null price once
  // reached the odds converter and crashed the nightly job.
  assert.equal(isEligibleLeg({ ...leg(1, 'hits_1', -150, 0.6), americanOdds: null }), false);
  assert.equal(isEligibleLeg({ ...leg(1, 'hits_1', -150, 0.6), americanOdds: 0 }), false);
});

test('withEdge survives an over with no under posted', () => {
  const scored = withEdge({ ...leg(1, 'total_bases_2', 130, 0.5), oppositeAmericanOdds: null });
  assert.equal(scored.fairProbability, null);
  assert.equal(scored.edge, null);
  assert.ok(scored.impliedProbability > 0, 'the over is still priced');
});

test('buildParlays ignores unpriced legs instead of throwing', () => {
  const candidates = [
    { ...leg(1, 'hits_1', -140, 0.60, 1) },
    { ...leg(2, 'total_bases_2', 145, 0.44, 2) },
    { ...leg(3, 'total_bases_2', 160, 0.42, 3) },
    { ...leg(4, 'hits_2', 260, 0.30, 4), americanOdds: null },
    { ...leg(5, 'hits_1', -125, 0.58, 5), americanOdds: undefined },
  ];
  assert.doesNotThrow(() => buildParlays(candidates));
  for (const t of buildParlays(candidates)) {
    for (const l of t.legs) assert.ok(l.americanOdds, 'every leg on a ticket has a real price');
  }
});

/* ------------------------------------------------------- payout window --- */

test('tickets must clear the $100 floor but have no ceiling', () => {
  const { PAYOUT_WINDOW } = parlayLib();
  assert.equal(PAYOUT_WINDOW.min, 100);
  assert.equal(PAYOUT_WINDOW.max, Infinity);
});

test('a ticket paying well over $200 is allowed', () => {
  const longshot = [
    leg(1, 'total_bases_3', 330, 0.27, 1),
    leg(2, 'total_bases_3', 340, 0.26, 2),
    leg(3, 'hits_2', 280, 0.29, 3),
    leg(4, 'home_run_1', 420, 0.12, 4),
  ];
  const tickets = buildParlays(longshot, { limit: 5 });
  assert.ok(tickets.length > 0, 'a long ticket should qualify');
  assert.ok(tickets.some((t) => t.payout > 200), 'payouts above $200 are kept');
  for (const t of tickets) assert.ok(t.payout >= 100, 'the floor still applies');
});

test('a ticket paying under $100 is still rejected', () => {
  const shortish = [
    leg(1, 'hits_1', -200, 0.68, 1),
    leg(2, 'hits_1', -210, 0.69, 2),
    leg(3, 'hits_1', -190, 0.67, 3),
  ];
  for (const t of buildParlays(shortish)) assert.ok(t.payout >= 100);
});

test('the board spreads across payout bands instead of only long shots', () => {
  // A mix that can produce both short and long tickets. Ranking on expected
  // value alone would fill every slot with the longest ones.
  const candidates = [
    leg(1, 'hits_1', -140, 0.62, 1),
    leg(2, 'hits_1', -130, 0.61, 2),
    leg(3, 'hits_1', -125, 0.60, 3),
    leg(4, 'total_bases_2', 140, 0.45, 4),
    leg(5, 'total_bases_2', 150, 0.44, 5),
    leg(6, 'total_bases_3', 330, 0.28, 6),
    leg(7, 'total_bases_3', 350, 0.27, 7),
    leg(8, 'hits_2', 280, 0.30, 8),
    leg(9, 'home_run_1', 450, 0.13, 9),
  ];
  const tickets = buildParlays(candidates, { limit: 6, maxPerBand: 3 });
  const counts = {};
  for (const t of tickets) counts[t.band] = (counts[t.band] ?? 0) + 1;
  for (const [band, n] of Object.entries(counts)) {
    assert.ok(n <= 3, `${band} band returned ${n} tickets, cap is 3`);
  }
  assert.ok(Object.keys(counts).length > 1, 'expected more than one payout band represented');
});

test('every ticket carries its band label', () => {
  const { payoutBand } = parlayLib();
  assert.equal(payoutBand(150), 'short');
  assert.equal(payoutBand(250), 'medium');
  assert.equal(payoutBand(900), 'long');
});
