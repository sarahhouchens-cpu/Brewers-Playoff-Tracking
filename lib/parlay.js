/**
 * Builds candidate parlays under a fixed set of rules.
 *
 * The rules come from how the bettor actually wants to play: 3-5 legs, a
 * payout window, weighted toward hits and total bases, and at most one home
 * run leg. They are enforced here rather than left to the UI so nothing that
 * violates them can reach the page.
 */

import { americanToDecimal, parlayDecimal, parlayProbability, payout, expectedValue, devig, impliedProbability, isValidAmerican } from './odds.js';

export const STAKE = 5;

/** Total returned on a winning ticket, stake included — what a bet slip shows. */
export const PAYOUT_WINDOW = { min: 100, max: 200 };

export const LEG_COUNT = { min: 3, max: 5 };

/** Markets that count as "hits and bases" — the ones to index toward. */
export const CONTACT_MARKETS = new Set(['hits_1', 'hits_2', 'total_bases_2', 'total_bases_3']);

/** At most one of these may appear on a ticket. */
export const HOME_RUN_MARKETS = new Set(['home_run_1']);

/**
 * Never allowed, at any count: a single player going deep twice is a long shot
 * that distorts the whole ticket's price, and stacking several players to homer
 * is the same bet wearing a disguise.
 */
export const BANNED_MARKETS = new Set(['home_run_2', 'home_run_multi', 'grand_slam']);

export const MARKET_LABELS = {
  hits_1: '1+ hits',
  hits_2: '2+ hits',
  total_bases_2: '2+ total bases',
  total_bases_3: '3+ total bases',
  home_run_1: 'to hit a home run',
};

/** How many top candidates to combine. Keeps the search small and the legs sane. */
const CANDIDATE_POOL = 14;

/** Reject a candidate leg that could never belong on a ticket. */
export function isEligibleLeg(leg) {
  if (BANNED_MARKETS.has(leg.market)) return false;
  if (!CONTACT_MARKETS.has(leg.market) && !HOME_RUN_MARKETS.has(leg.market)) return false;
  if (!Number.isFinite(leg.modelProbability) || leg.modelProbability <= 0) return false;
  if (!isValidAmerican(leg.americanOdds)) return false;
  return true;
}

/** Check a fully-assembled ticket against every rule. */
export function validateParlay(legs) {
  if (legs.length < LEG_COUNT.min || legs.length > LEG_COUNT.max) return false;

  // One player, one leg. Same-player legs are heavily correlated and most books
  // will not take them together anyway.
  const players = new Set(legs.map((l) => l.playerId));
  if (players.size !== legs.length) return false;

  const homeRunLegs = legs.filter((l) => HOME_RUN_MARKETS.has(l.market)).length;
  if (homeRunLegs > 1) return false;

  // Index toward contact: the ticket must be mostly hits and total bases.
  const contactLegs = legs.filter((l) => CONTACT_MARKETS.has(l.market)).length;
  if (contactLegs < legs.length - 1) return false;

  return true;
}

function* combinations(items, size, start = 0, current = []) {
  if (current.length === size) {
    yield current;
    return;
  }
  for (let i = start; i < items.length; i++) {
    yield* combinations(items, size, i + 1, [...current, items[i]]);
  }
}

/**
 * Score and rank every legal ticket the candidate pool can produce.
 *
 * Ranked by expected value rather than raw probability: the safest ticket in
 * the payout window is not necessarily the best-priced one, and the whole point
 * of comparing a model against a book is to find where the price is soft.
 */
export function buildParlays(candidates, options = {}) {
  const {
    stake = STAKE,
    window = PAYOUT_WINDOW,
    limit = 6,
    correlationPenalty = 0.04,
    maxLegRepeat = 2,
  } = options;

  const pool = candidates
    .filter(isEligibleLeg)
    .sort((a, b) => (b.edge ?? 0) - (a.edge ?? 0) || b.modelProbability - a.modelProbability)
    .slice(0, CANDIDATE_POOL);

  const tickets = [];
  for (let size = LEG_COUNT.min; size <= LEG_COUNT.max; size++) {
    for (const legs of combinations(pool, size)) {
      if (!validateParlay(legs)) continue;

      const decimal = parlayDecimal(legs);
      const totalReturn = payout(stake, decimal);
      if (totalReturn < window.min || totalReturn > window.max) continue;

      const probability = parlayProbability(legs, correlationPenalty);
      tickets.push({
        legs,
        decimal,
        payout: totalReturn,
        profit: totalReturn - stake,
        probability,
        expectedValue: expectedValue(stake, decimal, probability),
        stake,
      });
    }
  }

  tickets.sort((a, b) => b.expectedValue - a.expectedValue || b.probability - a.probability);

  // Ranking purely by expected value returns near-duplicates: the two or three
  // best-priced legs turn up on every ticket and the board reads as one bet
  // wearing different hats. Cap how often any single leg may reappear so the
  // set offers genuinely different ways to play the night.
  const used = new Map();
  const chosen = [];
  for (const ticket of tickets) {
    if (chosen.length >= limit) break;
    const keys = ticket.legs.map((l) => `${l.playerId}|${l.market}`);
    if (keys.some((k) => (used.get(k) ?? 0) >= maxLegRepeat)) continue;
    for (const k of keys) used.set(k, (used.get(k) ?? 0) + 1);
    chosen.push(ticket);
  }

  // If the cap leaves fewer than `limit` genuinely distinct tickets, return the
  // shorter list. Padding it with the near-duplicates just rejected would undo
  // the point, and would also break the expected-value ordering by appending
  // higher-EV tickets behind lower ones.
  return chosen;
}

/**
 * Attach the book's fair (devigged) probability and the model's edge to a leg.
 *
 * `overOdds` and `underOdds` are the two sides of the same market. Without the
 * other side there is no way to strip the vig, so the fair probability is left
 * null rather than guessed at — an edge computed against a vigged price is
 * flattering and wrong.
 */
export function withEdge(leg) {
  const over = americanToDecimal(leg.americanOdds);

  if (!isValidAmerican(leg.oppositeAmericanOdds)) {
    return {
      ...leg,
      impliedProbability: impliedProbability(over),
      fairProbability: null,
      edge: null,
    };
  }

  const [fair] = devig([over, americanToDecimal(leg.oppositeAmericanOdds)]);
  return {
    ...leg,
    impliedProbability: impliedProbability(over),
    fairProbability: fair,
    edge: (leg.modelProbability - fair) * 100,
  };
}

/** One-line description of a leg, the way it would read on a slip. */
export function describeLeg(leg) {
  return `${leg.playerName} ${MARKET_LABELS[leg.market] ?? leg.market}`;
}
