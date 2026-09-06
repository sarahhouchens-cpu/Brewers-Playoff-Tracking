import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, calibrate, rateFactor, describe, PRIOR_STRENGTH, FACTOR_BOUNDS } from '../lib/calibration.js';

/** n legs at probability p, of which `hits` actually landed. */
const legs = (n, p, hits, market = 'hits_1') =>
  Array.from({ length: n }, (_, i) => ({ market, modelProbability: p, hit: i < hits }));

test('a perfectly calibrated model gets no correction', () => {
  const s = summarize(legs(100, 0.5, 50));
  assert.equal(s.raw, 1);
  assert.equal(s.factor, 1);
});

test('one night of data barely moves the factor', () => {
  // The real September 5 shape: 40 legs, expected 16.1, actual 14.
  const sample = [
    ...legs(20, 0.5, 6),
    ...legs(20, 0.305, 8),
  ];
  const s = summarize(sample);
  assert.ok(s.raw < 0.9, 'the raw ratio does look pessimistic');
  assert.ok(s.factor > 0.94,
    `one game must not swing the model; got ${s.factor}`);
});

test('a large consistent bias does move the factor', () => {
  // ~500 expected, 15% short — a real signal, not noise.
  const s = summarize(legs(1000, 0.5, 425));
  assert.ok(s.factor < 0.92, `expected a real correction, got ${s.factor}`);
  assert.ok(s.weight > 0.9, 'evidence should dominate the prior at this size');
});

test('shrinkage moves monotonically with sample size', () => {
  const small = summarize(legs(40, 0.5, 14)).factor;
  const medium = summarize(legs(400, 0.5, 140)).factor;
  const large = summarize(legs(4000, 0.5, 1400)).factor;
  assert.ok(small > medium && medium > large,
    'the same bias should correct harder as evidence accumulates');
});

test('the factor is bounded even against absurd data', () => {
  assert.ok(summarize(legs(5000, 0.5, 0)).factor >= FACTOR_BOUNDS.min);
  assert.ok(summarize(legs(5000, 0.1, 5000)).factor <= FACTOR_BOUNDS.max);
});

test('no graded legs means no correction', () => {
  const s = summarize([]);
  assert.equal(s.n, 0);
  assert.equal(s.factor, 1);
  assert.equal(rateFactor(calibrate([])), 1);
});

test('ungraded legs are ignored rather than counted as misses', () => {
  const mixed = [...legs(10, 0.5, 5), { market: 'hits_1', modelProbability: 0.5, hit: undefined }];
  assert.equal(summarize(mixed).n, 10);
});

test('per-market factors only take over once they carry weight', () => {
  // Home runs: a tiny sample that looks wildly off.
  const cal = calibrate([...legs(200, 0.5, 90, 'hits_1'), ...legs(4, 0.1, 3, 'home_run_1')]);
  assert.ok(cal.byMarket.home_run_1.weight < 0.5, 'four legs is not enough weight');
  assert.equal(rateFactor(cal, 'home_run_1'), cal.overall.factor,
    'a thin market falls back to the overall factor');
  assert.equal(rateFactor(cal, 'hits_1'), cal.byMarket.hits_1.factor,
    'a well-sampled market uses its own');
});

test('describe says plainly how much to trust the number', () => {
  assert.match(describe(calibrate([])), /No graded results yet/);
  assert.match(describe(calibrate(legs(40, 0.4, 14))), /provisional/);
  assert.match(describe(calibrate(legs(2000, 0.5, 850))), /driven by the data/);
});

test('prior strength is documented in units of expected occurrences', () => {
  assert.equal(PRIOR_STRENGTH, 50);
  // At the prior's own scale, evidence and prior weigh equally.
  assert.equal(summarize(legs(100, 0.5, 50)).weight, 0.5);
});
