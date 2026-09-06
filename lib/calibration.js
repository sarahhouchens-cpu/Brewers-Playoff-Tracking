/**
 * Measures whether the model's probabilities match what actually happened, and
 * turns that into a correction factor.
 *
 * The central problem is sample size. After one game there are ~40 graded legs,
 * and the gap between "expected 16.1, got 14" is well inside random noise —
 * roughly 0.7 standard deviations. Correcting the model from that would be
 * fitting the last game, not calibrating.
 *
 * So the ratio is shrunk toward 1.0 using pseudo-counts: a correction only
 * emerges as evidence accumulates, and a handful of nights barely moves it.
 * Nothing here needs a decision about "is the sample big enough yet" — the
 * shrinkage answers that continuously.
 */

/**
 * Prior strength, in units of expected occurrences.
 *
 * At 50, a night's worth of legs (expected ~16) moves the factor by only a few
 * percent, while a month (expected ~500) lets the data dominate. Raise it to be
 * more conservative, lower it to react faster.
 */
export const PRIOR_STRENGTH = 50;

/** Never let calibration swing a projection more than this far. */
export const FACTOR_BOUNDS = { min: 0.75, max: 1.25 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Compare expected occurrences against actual ones.
 *
 * `raw` is what the data alone says; `factor` is that shrunk toward 1.0 and is
 * the number worth acting on.
 */
export function summarize(legs, priorStrength = PRIOR_STRENGTH) {
  const graded = legs.filter((l) => typeof l.hit === 'boolean' && Number.isFinite(l.modelProbability));
  const expected = graded.reduce((sum, l) => sum + l.modelProbability, 0);
  const actual = graded.filter((l) => l.hit).length;

  const raw = expected > 0 ? actual / expected : 1;
  const factor = (actual + priorStrength) / (expected + priorStrength);

  return {
    n: graded.length,
    expected: Number(expected.toFixed(2)),
    actual,
    raw: Number(raw.toFixed(4)),
    factor: Number(clamp(factor, FACTOR_BOUNDS.min, FACTOR_BOUNDS.max).toFixed(4)),
    // How much of the correction is evidence rather than prior. Useful for
    // saying honestly on the page how much to trust it.
    weight: Number((expected / (expected + priorStrength)).toFixed(3)),
  };
}

/**
 * Overall calibration plus a per-market breakdown.
 *
 * Markets are reported separately because they can drift apart — a model can be
 * fine on 1+ hits and badly wrong on home runs — but each market's sample is a
 * fraction of the whole, so per-market factors shrink harder and stay near 1
 * for much longer. That is deliberate.
 */
export function calibrate(legs, priorStrength = PRIOR_STRENGTH) {
  const byMarket = {};
  for (const leg of legs) {
    if (typeof leg.hit !== 'boolean') continue;
    (byMarket[leg.market] ??= []).push(leg);
  }

  return {
    overall: summarize(legs, priorStrength),
    byMarket: Object.fromEntries(
      Object.entries(byMarket).map(([market, ls]) => [market, summarize(ls, priorStrength)])
    ),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * The multiplier to apply to a hitter's per-plate-appearance rates.
 *
 * Applied to the rates rather than to the finished probability: scaling an
 * output probability breaks down near 1 (a 0.95 chance times 1.2 is not a
 * probability), while scaling the underlying rate flows through the convolution
 * correctly and keeps every derived number consistent with the others.
 */
export function rateFactor(calibration, market = null) {
  if (!calibration) return 1;
  const marketEntry = market ? calibration.byMarket?.[market] : null;

  // Prefer the market-specific factor once it carries real weight, otherwise
  // fall back to the overall one, which accumulates evidence far faster.
  if (marketEntry && marketEntry.weight >= 0.5) return marketEntry.factor;
  return calibration.overall?.factor ?? 1;
}

/** Plain-language summary of how much the correction can be trusted. */
export function describe(calibration) {
  const o = calibration?.overall;
  if (!o || !o.n) return 'No graded results yet — the model runs uncorrected.';

  const pct = Math.round((o.factor - 1) * 100);
  const direction = pct === 0 ? 'no net correction' : pct < 0 ? `${Math.abs(pct)}% down` : `${pct}% up`;
  const confidence =
    o.weight < 0.25 ? 'mostly prior, treat as provisional'
    : o.weight < 0.6 ? 'evidence starting to outweigh the prior'
    : 'driven by the data';

  return `${o.n} graded legs: model expected ${o.expected.toFixed(1)}, actual ${o.actual}. ` +
    `Adjusting ${direction} (${confidence}).`;
}
