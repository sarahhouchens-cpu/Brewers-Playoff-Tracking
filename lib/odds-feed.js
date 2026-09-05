/**
 * Parsing for The Odds API's player-prop payloads.
 *
 * Kept separate from the fetching so the mapping rules — which decide what a
 * bet actually is — can be tested exhaustively. Getting these wrong does not
 * throw; it silently prices the wrong bet, which is the worst failure this
 * repo can have.
 */

/** Markets we model, and the exact threshold each represents. */
export const MARKET_THRESHOLDS = {
  batter_hits: { 1: 'hits_1', 2: 'hits_2' },
  batter_total_bases: { 2: 'total_bases_2', 3: 'total_bases_3' },
  batter_home_runs: { 1: 'home_run_1' },
};

/**
 * Turn a book's market key and line into ours.
 *
 * Books post these as "Over N.5", so the threshold a bet actually needs is
 * ceil(point): Over 0.5 hits means 1+, Over 2.5 hits means 3+. Reading a 2.5
 * line as "2+" would price a materially harder bet as an easier one.
 *
 * Anything outside the table returns null and is dropped — including
 * batter_home_runs at 1.5, which is the banned "player hits 2+ home runs"
 * market arriving under a name that looks ordinary.
 */
export function normalizeMarket(marketKey, point) {
  const table = MARKET_THRESHOLDS[marketKey];
  if (!table) return null;

  const line = Number(point);
  if (!Number.isFinite(line) || line <= 0) return null;

  // Books quote half-lines; a whole number would make "over" ambiguous.
  if (!Number.isInteger(line * 2) || Number.isInteger(line)) return null;

  return table[Math.ceil(line)] ?? null;
}

/**
 * Normalize a player name for matching across feeds.
 *
 * Books and MLB disagree about accents, suffixes and punctuation — "Jackson
 * Chourío", "Jackson Chourio Jr.", "J. Chourio" — and a failed match silently
 * drops a leg rather than erroring.
 */
export function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** American odds are integers; anything else is a malformed quote. */
const validPrice = (price) => Number.isFinite(Number(price)) && Number(price) !== 0;

/**
 * Flatten an event's odds into one quote per player and market.
 *
 * Two things happen here that matter to the bettor:
 *
 * 1. Best price wins. The same prop is priced differently at each book, and
 *    taking the best available over is line shopping — the one edge available
 *    to a retail bettor that requires no opinion at all.
 * 2. Over and under are paired from the *same* book. Devigging mixes two sides
 *    of one market, so pairing an over at DraftKings with an under at BetMGM
 *    would produce a fair probability neither book ever offered.
 */
export function parseEventOdds(event) {
  const quotes = new Map();

  for (const book of event?.bookmakers ?? []) {
    for (const market of book?.markets ?? []) {
      // Group this book's outcomes by player and line so the two sides pair up.
      const sides = new Map();
      for (const outcome of market?.outcomes ?? []) {
        const player = outcome?.description;
        const key = normalizeMarket(market.key, outcome?.point);
        if (!player || !key || !validPrice(outcome?.price)) continue;

        const id = `${normalizeName(player)}|${key}`;
        const entry = sides.get(id) ?? { player, market: key, over: null, under: null };
        if (/^over$/i.test(outcome.name)) entry.over = Number(outcome.price);
        else if (/^under$/i.test(outcome.name)) entry.under = Number(outcome.price);
        sides.set(id, entry);
      }

      for (const [id, entry] of sides) {
        if (entry.over == null) continue;

        const existing = quotes.get(id);
        // Higher American odds always pay more, on either side of zero.
        if (!existing || entry.over > existing.americanOdds) {
          quotes.set(id, {
            playerName: entry.player,
            market: entry.market,
            americanOdds: entry.over,
            oppositeAmericanOdds: entry.under,
            book: book.title,
          });
        }
      }
    }
  }
  return quotes;
}

/** Every distinct player carrying a prop, for driving the board off the feed. */
export function playersInFeed(quotes) {
  const names = new Map();
  for (const quote of quotes.values()) {
    names.set(normalizeName(quote.playerName), quote.playerName);
  }
  return names;
}
