/**
 * Magic number math for the Brewers playoff tracker.
 *
 * Pure functions only — no fetching, no file I/O, no DOM. Everything here runs
 * identically in Node (for the update script and tests) and in the browser.
 */

export const TOTAL_GAMES = 162;

/** Milwaukee, for callers that want it without a lookup. Resolved by name at runtime. */
export const BREWERS_NAME = 'Milwaukee Brewers';

/**
 * Games a leader needs to clinch over a specific chaser.
 *
 *   M = (162 + 1) - leaderWins - chaserLosses
 *
 * The +1 is what turns "tied" into "clinched". MLB now breaks ties
 * mathematically rather than with a Game 163, so where the Brewers already own
 * the head-to-head tiebreaker the true number is one lower. We ship the
 * conservative standard formula; see README for the refinement.
 */
export function magicNumber(leaderWins, chaserLosses, totalGames = TOTAL_GAMES) {
  return Math.max(0, totalGames + 1 - leaderWins - chaserLosses);
}

/**
 * The mirror: how many leader losses + chaser wins would knock the leader out
 * of this race. This is simply the chaser's magic number over the leader.
 */
export function eliminationNumber(leaderLosses, chaserWins, totalGames = TOTAL_GAMES) {
  return Math.max(0, totalGames + 1 - chaserWins - leaderLosses);
}

export function winPct(team) {
  const played = team.wins + team.losses;
  return played === 0 ? 0 : team.wins / played;
}

/** Best record first. Ties broken by raw wins, then name, so sorting is stable. */
export function byRecord(a, b) {
  return winPct(b) - winPct(a) || b.wins - a.wins || a.name.localeCompare(b.name);
}

/**
 * The team currently first OUT of a league's playoff field — i.e. 7th in the
 * playoff standings. That's the chaser for the "clinch a berth" number.
 *
 * Field is 6: three division winners, then the three best records remaining.
 */
export function firstTeamOut(leagueTeams) {
  const divisions = new Map();
  for (const t of leagueTeams) {
    const bucket = divisions.get(t.divisionId);
    if (!bucket || byRecord(t, bucket) < 0) divisions.set(t.divisionId, t);
  }
  const leaders = new Set([...divisions.values()].map((t) => t.id));
  const wildCardPool = leagueTeams.filter((t) => !leaders.has(t.id)).sort(byRecord);

  // Three wild cards get in; the next team is first out.
  return wildCardPool[3] ?? null;
}

/** Best record among every team except `exceptId`, within an optional subset. */
function bestOther(teams, exceptId) {
  return teams.filter((t) => t.id !== exceptId).sort(byRecord)[0] ?? null;
}

/**
 * Build the four races for one team.
 *
 * `teams` must be every MLB team, normalized to:
 *   { id, name, abbrev, wins, losses, leagueId, divisionId }
 */
export function computeRaces(teams, teamId, totalGames = TOTAL_GAMES) {
  const me = teams.find((t) => t.id === teamId);
  if (!me) throw new Error(`Team ${teamId} not found in standings (${teams.length} teams parsed)`);

  const myLeague = teams.filter((t) => t.leagueId === me.leagueId);
  const myDivision = teams.filter((t) => t.divisionId === me.divisionId);

  const definitions = [
    {
      key: 'berth',
      label: 'Playoff berth',
      headline: 'to clinch a playoff berth',
      chaser: firstTeamOut(myLeague),
      chaserNote: 'first team out of the playoff field',
    },
    {
      key: 'division',
      label: 'NL Central',
      headline: 'to win the NL Central',
      chaser: bestOther(myDivision, me.id),
      chaserNote: 'closest pursuer in the division',
    },
    {
      key: 'leagueSeed',
      label: 'No. 1 seed, NL',
      headline: 'to lock up the No. 1 seed',
      chaser: bestOther(myLeague, me.id),
      chaserNote: 'best record among other NL teams',
    },
    {
      key: 'bestRecord',
      label: 'Best record, MLB',
      headline: 'to secure World Series home field',
      // Deliberately league-agnostic: the best remaining record can sit in
      // either league, so this is not "best AL team".
      chaser: bestOther(teams, me.id),
      chaserNote: 'best record anywhere in baseball',
    },
  ];

  const races = definitions.map((def) => {
    if (!def.chaser) {
      return { ...def, chaser: null, magic: null, elimination: null, clinched: false };
    }
    const magic = magicNumber(me.wins, def.chaser.losses, totalGames);
    return {
      key: def.key,
      label: def.label,
      headline: def.headline,
      chaserNote: def.chaserNote,
      chaser: {
        id: def.chaser.id,
        name: def.chaser.name,
        abbrev: def.chaser.abbrev,
        wins: def.chaser.wins,
        losses: def.chaser.losses,
      },
      magic,
      elimination: eliminationNumber(me.losses, def.chaser.wins, totalGames),
      clinched: magic === 0,
    };
  });

  const played = me.wins + me.losses;
  return {
    team: { id: me.id, name: me.name, abbrev: me.abbrev, wins: me.wins, losses: me.losses },
    gamesPlayed: played,
    gamesRemaining: Math.max(0, totalGames - played),
    races,
  };
}

/**
 * The race the hero graphic should lead with: the first unclinched race in
 * escalating order. Once the berth is clinched the page walks itself up the
 * ladder on its own. If everything is clinched, lead with the last one.
 */
export function headlineRace(races) {
  const order = ['berth', 'division', 'leagueSeed', 'bestRecord'];
  for (const key of order) {
    const race = races.find((r) => r.key === key);
    if (race && !race.clinched && race.magic !== null) return race;
  }
  return races.find((r) => r.key === 'bestRecord') ?? races[0];
}

/**
 * Compare today's races against a previous snapshot to produce per-race deltas
 * and flag chasers that swapped overnight.
 *
 * A chaser change can make a magic number RISE even after a Brewers win, which
 * looks like a bug unless the page says what happened — so we surface it.
 */
export function diffRaces(current, previous) {
  if (!previous) return current.map((r) => ({ key: r.key, delta: null, chaserChanged: false }));

  return current.map((race) => {
    const before = previous.find((r) => r.key === race.key);
    if (!before || before.magic === null || race.magic === null) {
      return { key: race.key, delta: null, chaserChanged: false };
    }
    const chaserChanged = Boolean(
      before.chaser && race.chaser && before.chaser.id !== race.chaser.id
    );
    return {
      key: race.key,
      delta: race.magic - before.magic,
      chaserChanged,
      previousChaser: chaserChanged ? before.chaser : null,
      previousMagic: before.magic,
    };
  });
}
