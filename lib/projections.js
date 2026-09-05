/**
 * A per-plate-appearance outcome model for hits, total bases and home runs.
 *
 * The approach: blend three views of a hitter's rate (season, last 15 games,
 * platoon split against tonight's starter), adjust for the pitchers he'll
 * actually face and for park and weather, then convolve the per-PA outcome
 * distribution over an uncertain number of plate appearances.
 *
 * Convolving rather than using a normal approximation matters here: with 3-5
 * plate appearances the distribution is lumpy and discrete, and "2 or more
 * total bases" depends on exactly that lumpiness.
 *
 * Every weight below is a judgement call, exported so it can be tuned and
 * tested rather than buried.
 */

/**
 * How much each view of a hitter's rate counts.
 *
 * Season gets the most weight because it is the largest sample. Last-15 is
 * responsive but noisy — roughly 60 plate appearances, well short of where
 * batting-average-type rates stabilize — so it is deliberately capped below
 * the season view. The platoon split earns real weight because starter
 * handedness is known before the game and is genuinely predictive.
 */
export const RATE_WEIGHTS = { season: 0.45, last15: 0.3, platoon: 0.25 };

/**
 * Plate appearances by lineup slot. Leadoff hitters get a fourth and fifth
 * trip far more often than the bottom third, and the difference swings a
 * total-bases prop more than most matchup factors do.
 */
export const PA_DISTRIBUTION = {
  1: { 3: 0.05, 4: 0.5, 5: 0.45 },
  2: { 3: 0.07, 4: 0.55, 5: 0.38 },
  3: { 3: 0.1, 4: 0.58, 5: 0.32 },
  4: { 3: 0.13, 4: 0.61, 5: 0.26 },
  5: { 3: 0.18, 4: 0.62, 5: 0.2 },
  6: { 3: 0.24, 4: 0.62, 5: 0.14 },
  7: { 3: 0.32, 4: 0.58, 5: 0.1 },
  8: { 3: 0.4, 4: 0.53, 5: 0.07 },
  9: { 3: 0.48, 4: 0.47, 5: 0.05 },
};

/** Share of plate appearances against the starter vs. the bullpen. */
export const DEFAULT_STARTER_SHARE = 0.65;

const OUTCOMES = ['single', 'double', 'triple', 'homeRun'];

/** Blend rate sets by weight, then let `out` absorb whatever is left. */
export function blendRates(views, weights = RATE_WEIGHTS) {
  const total = Object.keys(weights).reduce(
    (sum, key) => (views[key] ? sum + weights[key] : sum),
    0
  );
  if (total <= 0) throw new Error('No rate views supplied');

  const blended = {};
  for (const outcome of OUTCOMES) {
    blended[outcome] = Object.keys(weights).reduce((sum, key) => {
      if (!views[key]) return sum;
      return sum + (views[key][outcome] ?? 0) * (weights[key] / total);
    }, 0);
  }
  return normalize(blended);
}

/** Force the outcome rates into a valid distribution with `out` as the remainder. */
export function normalize(rates) {
  const clipped = {};
  for (const outcome of OUTCOMES) clipped[outcome] = Math.max(0, rates[outcome] ?? 0);

  let onBase = OUTCOMES.reduce((sum, o) => sum + clipped[o], 0);
  // A hitter cannot reach base more often than every trip; scale back if the
  // multipliers ever push the rates past 1 in combination.
  if (onBase >= 0.95) {
    const scale = 0.95 / onBase;
    for (const outcome of OUTCOMES) clipped[outcome] *= scale;
    onBase = 0.95;
  }
  return { ...clipped, out: 1 - onBase };
}

/**
 * Apply matchup context to a rate set.
 *
 * `contact` scales everything (a tough pitcher suppresses all hits); `power`
 * scales only extra-base outcomes, which is where park and weather actually
 * show up. A cold night with the wind in kills home runs without doing much to
 * singles, and treating those the same would be wrong.
 */
export function applyContext(rates, { contact = 1, power = 1 } = {}) {
  return normalize({
    single: rates.single * contact,
    double: rates.double * contact * power,
    triple: rates.triple * contact * power,
    homeRun: rates.homeRun * contact * power,
  });
}

/**
 * Ballparks whose roof can be closed. Weather only matters where the sky is
 * actually open, and roof state is a property of the venue being played in —
 * not of the Brewers, who spend half the season on the road.
 */
export const ROOFED_VENUES = new Set([
  'American Family Field',
  'Chase Field',
  'Rogers Centre',
  'T-Mobile Park',
  'Globe Life Field',
  'loanDepot park',
  'Daikin Park',
  'Minute Maid Park',
]);

/**
 * Park power factors: how much a venue inflates or suppresses extra-base
 * outcomes relative to league average.
 *
 * These are approximate, drawn from well-established park reputations rather
 * than a computed multi-year sample, and deliberately conservative — a park
 * factor is a real effect but a smaller one than a matchup. Anything not listed
 * plays neutral at 1.0.
 */
export const PARK_POWER = {
  'Coors Field': 1.18,
  'Great American Ball Park': 1.14,
  'Yankee Stadium': 1.10,
  'Citizens Bank Park': 1.08,
  'Globe Life Field': 1.05,
  'American Family Field': 1.05,
  'Wrigley Field': 1.03,
  'Truist Park': 1.02,
  'Dodger Stadium': 1.02,
  'Busch Stadium': 0.95,
  'Kauffman Stadium': 0.94,
  'T-Mobile Park': 0.93,
  'Petco Park': 0.92,
  'loanDepot park': 0.91,
  'Oracle Park': 0.88,
};

export function parkPower(venueName) {
  return PARK_POWER[venueName] ?? 1;
}

export function isRoofed(venueName) {
  return ROOFED_VENUES.has(venueName);
}

/**
 * Weather into a power multiplier.
 *
 * A closed roof makes the weather irrelevant, so it short-circuits everything
 * below. Roof state comes from the venue actually being played in.
 */
export function weatherPower({ roofClosed = false, temperatureF = 72, windMph = 0, windDirection = 'none', venue = null } = {}) {
  if (roofClosed) return parkPower(venue);

  // Warm air is less dense and carries; the effect is real but small.
  let factor = 1 + (temperatureF - 72) * 0.0025;

  if (windDirection === 'out') factor += Math.min(windMph, 20) * 0.006;
  else if (windDirection === 'in') factor -= Math.min(windMph, 20) * 0.006;

  // The park itself is a bigger and far more reliable signal than the weather.
  return clamp(factor * parkPower(venue), 0.8, 1.35);
}

/** Convolve one more plate appearance onto a total-bases distribution. */
function addPlateAppearance(distribution, rates) {
  const next = new Array(distribution.length + 4).fill(0);
  for (let bases = 0; bases < distribution.length; bases++) {
    const p = distribution[bases];
    if (!p) continue;
    next[bases] += p * rates.out;
    next[bases + 1] += p * rates.single;
    next[bases + 2] += p * rates.double;
    next[bases + 3] += p * rates.triple;
    next[bases + 4] += p * rates.homeRun;
  }
  return next;
}

/**
 * Distribution of total bases across an uncertain number of plate appearances.
 * Returns an array where index n is the probability of exactly n total bases.
 */
export function totalBasesDistribution(rates, paDistribution) {
  const mixed = [];
  for (const [paText, weight] of Object.entries(paDistribution)) {
    const pa = Number(paText);
    let dist = [1];
    for (let i = 0; i < pa; i++) dist = addPlateAppearance(dist, rates);
    dist.forEach((p, bases) => {
      mixed[bases] = (mixed[bases] ?? 0) + p * weight;
    });
  }
  return mixed;
}

/** Probability of at least one occurrence across the PA distribution. */
function atLeastOnce(perPA, paDistribution) {
  let none = 0;
  for (const [paText, weight] of Object.entries(paDistribution)) {
    none += weight * (1 - perPA) ** Number(paText);
  }
  return 1 - none;
}

/**
 * Project one hitter for tonight.
 *
 * `context` carries the three rate views, the lineup slot, the starter and
 * bullpen suppression factors, and the park/weather power multiplier.
 */
export function projectBatter(context) {
  const {
    views,
    lineupSlot = 5,
    starterContact = 1,
    bullpenContact = 1,
    power = 1,
    starterShare = DEFAULT_STARTER_SHARE,
  } = context;

  const base = blendRates(views);

  // A hitter faces the starter for most of the night and the bullpen for the
  // rest, so the two suppression factors are blended by expected exposure
  // rather than picking one and ignoring the other.
  const blendedContact = starterContact * starterShare + bullpenContact * (1 - starterShare);
  const rates = applyContext(base, { contact: blendedContact, power });

  const paDistribution = PA_DISTRIBUTION[lineupSlot] ?? PA_DISTRIBUTION[5];
  const distribution = totalBasesDistribution(rates, paDistribution);

  const hitRate = OUTCOMES.reduce((sum, o) => sum + rates[o], 0);
  const expectedTotalBases = distribution.reduce((sum, p, bases) => sum + p * bases, 0);

  return {
    rates,
    expectedTotalBases,
    probability: {
      hit1: atLeastOnce(hitRate, paDistribution),
      hit2: 1 - distributionAtMostHits(rates, paDistribution, 1),
      totalBases2: 1 - (distribution[0] ?? 0) - (distribution[1] ?? 0),
      totalBases3: 1 - (distribution[0] ?? 0) - (distribution[1] ?? 0) - (distribution[2] ?? 0),
      homeRun1: atLeastOnce(rates.homeRun, paDistribution),
    },
  };
}

/** P(at most `max` hits) — hits, not bases, so a double counts once. */
function distributionAtMostHits(rates, paDistribution, max) {
  const hitRate = OUTCOMES.reduce((sum, o) => sum + rates[o], 0);
  let total = 0;
  for (const [paText, weight] of Object.entries(paDistribution)) {
    const pa = Number(paText);
    let cumulative = 0;
    for (let k = 0; k <= max; k++) cumulative += binomial(pa, k) * hitRate ** k * (1 - hitRate) ** (pa - k);
    total += weight * cumulative;
  }
  return total;
}

function binomial(n, k) {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - i + 1)) / i;
  return result;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Turn a pitcher's opponent stat line into a contact multiplier.
 * 1.0 is league average; below 1 suppresses hits.
 */
export function pitcherContactFactor(opponentAvg, leagueAvg = 0.243) {
  if (!Number.isFinite(opponentAvg) || opponentAvg <= 0) return 1;
  return clamp(opponentAvg / leagueAvg, 0.75, 1.3);
}
