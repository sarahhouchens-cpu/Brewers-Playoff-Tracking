import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMarket, normalizeName, parseEventOdds, playersInFeed } from '../lib/odds-feed.js';

/* Lines taken verbatim from a real Odds API response for MIL @ CIN. */

test('over 0.5 hits is a 1+ hits bet', () => {
  assert.equal(normalizeMarket('batter_hits', 0.5), 'hits_1');
});

test('over 1.5 hits is a 2+ hits bet', () => {
  assert.equal(normalizeMarket('batter_hits', 1.5), 'hits_2');
});

test('over 2.5 hits is 3+ hits and is NOT treated as 2+', () => {
  // The bug this guards: reading 2.5 as "2+" prices a much harder bet as an
  // easier one. We do not model 3+ hits, so it is dropped.
  assert.equal(normalizeMarket('batter_hits', 2.5), null);
});

test('total bases lines map to their real thresholds', () => {
  assert.equal(normalizeMarket('batter_total_bases', 1.5), 'total_bases_2');
  assert.equal(normalizeMarket('batter_total_bases', 2.5), 'total_bases_3');
  assert.equal(normalizeMarket('batter_total_bases', 4.5), null, '5+ bases is not modelled');
});

test('over 0.5 home runs is allowed, over 1.5 is the banned multi-homer market', () => {
  assert.equal(normalizeMarket('batter_home_runs', 0.5), 'home_run_1');
  assert.equal(normalizeMarket('batter_home_runs', 1.5), null,
    '2+ home runs by one player must never become a leg');
});

test('unknown markets and malformed lines are dropped', () => {
  assert.equal(normalizeMarket('batter_rbis', 0.5), null);
  assert.equal(normalizeMarket('batter_hits', 0), null);
  assert.equal(normalizeMarket('batter_hits', 1), null, 'whole-number lines are ambiguous');
  assert.equal(normalizeMarket('batter_hits', undefined), null);
});

test('name normalization survives accents, suffixes and punctuation', () => {
  assert.equal(normalizeName('Jackson Chourío'), 'jackson chourio');
  assert.equal(normalizeName('Ronald Acuña Jr.'), 'ronald acuna');
  assert.equal(normalizeName("Andrew McCutchen"), 'andrew mccutchen');
  assert.equal(normalizeName('  Brice   Turang '), 'brice turang');
  assert.equal(normalizeName(null), '');
});

const event = {
  bookmakers: [
    {
      title: 'BetMGM',
      markets: [{
        key: 'batter_total_bases',
        outcomes: [
          { name: 'Over', description: 'Brice Turang', point: 1.5, price: -105 },
          { name: 'Under', description: 'Brice Turang', point: 1.5, price: -125 },
        ],
      }],
    },
    {
      title: 'DraftKings',
      markets: [{
        key: 'batter_total_bases',
        outcomes: [
          { name: 'Over', description: 'Brice Turang', point: 1.5, price: 115 },
          { name: 'Under', description: 'Brice Turang', point: 1.5, price: -140 },
        ],
      }],
    },
    {
      title: 'BetRivers',
      markets: [{
        key: 'batter_home_runs',
        outcomes: [
          { name: 'Over', description: 'Eugenio Suarez', point: 1.5, price: 700 },
          { name: 'Over', description: 'Eugenio Suarez', point: 0.5, price: 320 },
          { name: 'Under', description: 'Eugenio Suarez', point: 0.5, price: -420 },
        ],
      }],
    },
  ],
};

test('the best available over price wins across books', () => {
  const quotes = parseEventOdds(event);
  const turang = quotes.get('brice turang|total_bases_2');
  assert.equal(turang.americanOdds, 115, 'DraftKings +115 beats BetMGM -105');
  assert.equal(turang.book, 'DraftKings');
});

test('over and under are paired from the same book', () => {
  const turang = parseEventOdds(event).get('brice turang|total_bases_2');
  // -140 is DraftKings' under, not BetMGM's -125.
  assert.equal(turang.oppositeAmericanOdds, -140);
});

test('the 2+ home run line is dropped while the 1+ line survives', () => {
  const quotes = parseEventOdds(event);
  assert.ok(quotes.has('eugenio suarez|home_run_1'));
  assert.equal(quotes.get('eugenio suarez|home_run_1').americanOdds, 320);
  for (const key of quotes.keys()) assert.ok(!key.includes('home_run_2'));
});

test('a market with only an under side is skipped', () => {
  const orphan = { bookmakers: [{ title: 'X', markets: [{ key: 'batter_hits',
    outcomes: [{ name: 'Under', description: 'Nobody', point: 0.5, price: -200 }] }] }] };
  assert.equal(parseEventOdds(orphan).size, 0);
});

test('players in the feed are listed once each', () => {
  const players = playersInFeed(parseEventOdds(event));
  assert.equal(players.get('brice turang'), 'Brice Turang');
  assert.equal(players.size, 2);
});
