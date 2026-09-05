/**
 * Betting odds math. Pure functions — no fetching, no DOM.
 *
 * American odds are what sportsbooks display; decimal odds are what you
 * multiply together for a parlay. Everything here converts between the two and
 * nothing rounds until display time.
 */

/**
 * Is this a usable American price?
 *
 * Number(null) is 0 and Number('') is 0, both of which pass Number.isFinite —
 * so a plain isFinite check silently accepts a missing price and hands null to
 * the converter. Zero is not a real American price either.
 */
export function isValidAmerican(value) {
  if (value === null || value === undefined || value === '') return false;
  const n = Number(value);
  return Number.isFinite(n) && n !== 0;
}

/** American (+150, -120) to decimal (2.50, 1.833). */
export function americanToDecimal(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || a === 0) throw new Error(`Bad American odds: ${american}`);
  return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
}

/** Decimal back to American, rounded the way a book displays it. */
export function decimalToAmerican(decimal) {
  const d = Number(decimal);
  if (!Number.isFinite(d) || d <= 1) throw new Error(`Bad decimal odds: ${decimal}`);
  return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1));
}

/** Format American odds with the sign a book would show. */
export function formatAmerican(american) {
  const a = Math.round(Number(american));
  return a > 0 ? `+${a}` : String(a);
}

/**
 * The probability the book's price implies — including its margin, so these
 * sum to more than 1 across a market. Use devig() to strip that out.
 */
export function impliedProbability(decimal) {
  return 1 / decimal;
}

/**
 * Remove the book's margin from a set of mutually exclusive prices.
 *
 * A two-way market priced at -120/-110 implies 54.5% + 52.4% = 106.9%. That
 * extra 6.9 points is the vig. Normalizing to 1 gives the book's actual opinion,
 * which is the only fair thing to compare a model against.
 */
export function devig(decimalOdds) {
  const raw = decimalOdds.map(impliedProbability);
  const overround = raw.reduce((a, b) => a + b, 0);
  if (overround <= 0) throw new Error('Cannot devig an empty market');
  return raw.map((p) => p / overround);
}

/** Combined decimal odds of every leg hitting. */
export function parlayDecimal(legs) {
  if (!legs.length) throw new Error('A parlay needs at least one leg');
  return legs.reduce((acc, leg) => acc * americanToDecimal(leg.americanOdds), 1);
}

/** Total returned on a winning bet — stake included, the way a bet slip shows it. */
export function payout(stake, decimal) {
  return stake * decimal;
}

/** Profit only, which is what "pays $150" usually means in conversation. */
export function profit(stake, decimal) {
  return stake * decimal - stake;
}

/**
 * Model's probability that every leg hits.
 *
 * This multiplies the legs, which assumes they are independent. They are not:
 * legs from the same game share a pitcher, a ballpark and a game state, so a
 * blowout lifts several at once. Same-game parlays are therefore optimistic
 * here. `correlationPenalty` shades the estimate down per shared game rather
 * than pretending to model the dependence properly.
 */
export function parlayProbability(legs, correlationPenalty = 0.04) {
  const raw = legs.reduce((acc, leg) => acc * leg.modelProbability, 1);

  const perGame = new Map();
  for (const leg of legs) perGame.set(leg.gamePk, (perGame.get(leg.gamePk) ?? 0) + 1);
  const sharedExtra = [...perGame.values()].reduce((n, count) => n + Math.max(0, count - 1), 0);

  return raw * (1 - correlationPenalty) ** sharedExtra;
}

/**
 * Expected value of a stake, in dollars.
 * Positive means the model thinks the price is too generous.
 */
export function expectedValue(stake, decimal, probability) {
  return probability * payout(stake, decimal) - stake;
}

/** Model edge over the book's devigged opinion, in percentage points. */
export function edge(modelProbability, fairProbability) {
  return (modelProbability - fairProbability) * 100;
}
