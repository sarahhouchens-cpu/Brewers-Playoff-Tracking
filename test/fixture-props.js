/**
 * An offline parlay board, generated through the real model so every number is
 * internally consistent with lib/projections.js.
 *
 * Rates and odds here are invented for demonstration. The board is stamped
 * source: 'demo' and the page shows an example-data banner, because a parlay
 * priced off made-up odds is worse than no parlay at all.
 */

import { projectBatter, weatherPower, pitcherContactFactor } from '../lib/projections.js';
import { buildParlays, withEdge, describeLeg, MARKET_LABELS } from '../lib/parlay.js';
import { decimalToAmerican } from '../lib/odds.js';

const HITTERS = [
  { id: 9001, name: 'Jackson Chourio',  slot: 1, rates: { single: 0.178, double: 0.055, triple: 0.006, homeRun: 0.040 } },
  { id: 9002, name: 'William Contreras', slot: 2, rates: { single: 0.172, double: 0.052, triple: 0.003, homeRun: 0.036 } },
  { id: 9003, name: 'Christian Yelich',  slot: 3, rates: { single: 0.168, double: 0.048, triple: 0.005, homeRun: 0.038 } },
  { id: 9004, name: 'Rhys Hoskins',      slot: 4, rates: { single: 0.140, double: 0.046, triple: 0.001, homeRun: 0.050 } },
  { id: 9005, name: 'Sal Frelick',       slot: 5, rates: { single: 0.182, double: 0.038, triple: 0.007, homeRun: 0.014 } },
  { id: 9006, name: 'Brice Turang',      slot: 6, rates: { single: 0.160, double: 0.036, triple: 0.005, homeRun: 0.016 } },
  { id: 9007, name: 'Joey Ortiz',        slot: 7, rates: { single: 0.148, double: 0.042, triple: 0.003, homeRun: 0.022 } },
  { id: 9008, name: 'Garrett Mitchell',  slot: 8, rates: { single: 0.152, double: 0.040, triple: 0.006, homeRun: 0.030 } },
  { id: 9009, name: 'Eric Haase',        slot: 9, rates: { single: 0.120, double: 0.034, triple: 0.001, homeRun: 0.028 } },
];

/** Invented prices, roughly where a book would sit for each projection. */
const PRICES = {
  hits_1: [-165, 140],
  hits_2: [265, -350],
  total_bases_2: [125, -155],
  total_bases_3: [330, -430],
  home_run_1: [420, -560],
};

export function demoBoard() {
  const conditions = {
    roofClosed: false,
    temperatureF: 78,
    windMph: 9,
    windDirection: 'out',
    description: 'Partly cloudy · 9 mph, out to left',
  };
  const power = weatherPower(conditions);
  const starterContact = pitcherContactFactor(0.229);
  const bullpenContactFactor = pitcherContactFactor(0.238);

  const legs = [];
  for (const hitter of HITTERS) {
    const projection = projectBatter({
      views: { season: hitter.rates, last15: hitter.rates, platoon: hitter.rates },
      lineupSlot: hitter.slot,
      starterContact,
      bullpenContact: bullpenContactFactor,
      power,
    });

    for (const [market, probability] of [
      ['hits_1', projection.probability.hit1],
      ['hits_2', projection.probability.hit2],
      ['total_bases_2', projection.probability.totalBases2],
      ['total_bases_3', projection.probability.totalBases3],
      ['home_run_1', projection.probability.homeRun1],
    ]) {
      const [over, under] = PRICES[market];
      legs.push(
        withEdge({
          playerId: hitter.id,
          playerName: hitter.name,
          lineupSlot: hitter.slot,
          market,
          marketLabel: MARKET_LABELS[market],
          modelProbability: probability,
          modelFairOdds: decimalToAmerican(1 / Math.min(0.98, Math.max(0.02, probability))),
          americanOdds: over,
          oppositeAmericanOdds: under,
          book: 'Demo Book',
          gamePk: 999001,
        })
      );
    }
  }

  legs.sort((a, b) => (b.edge ?? -99) - (a.edge ?? -99));
  const parlays = buildParlays(legs).map((p) => ({
    ...p,
    legs: p.legs.map((l) => ({ ...l, description: describeLeg(l) })),
  }));

  return {
    source: 'demo',
    generatedAt: new Date().toISOString(),
    date: '2026-09-04',
    status: 'ok',
    oddsStatus: 'demo',
    game: { gamePk: 999001, opponent: 'St. Louis Cardinals', isHome: true, startTime: '2026-09-04T23:40:00Z', venue: 'American Family Field' },
    starter: { id: 8001, name: 'Sonny Gray', hand: 'R', opponentAvg: 0.229 },
    conditions,
    factors: { starterContact, bullpenContact: bullpenContactFactor, power },
    legs,
    parlays,
    history: [],
  };
}
