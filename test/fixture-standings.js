/**
 * A full 30-team synthetic league, anchored on the real September 4, 2026
 * Brewers record (87-54) and built so the four magic numbers come out to the
 * published figures: berth 9, NL Central 14, NL No. 1 seed 19.
 *
 * Division IDs match MLB's real ones so the shape is identical to live data:
 *   200 AL West · 201 AL East · 202 AL Central
 *   203 NL West · 204 NL East · 205 NL Central
 */

const t = (id, name, abbrev, wins, losses, leagueId, divisionId) => ({
  id, name, abbrev, wins, losses, leagueId, divisionId,
});

export const BREWERS_ID = 158;

export const fixtureTeams = [
  // ---- NL Central (205) ----
  t(158, 'Milwaukee Brewers', 'MIL', 87, 54, 104, 205),
  t(112, 'Chicago Cubs', 'CHC', 79, 62, 104, 205),
  t(113, 'Cincinnati Reds', 'CIN', 70, 71, 104, 205),
  t(138, 'St. Louis Cardinals', 'STL', 66, 75, 104, 205),
  t(134, 'Pittsburgh Pirates', 'PIT', 60, 81, 104, 205),

  // ---- NL East (204) ----
  t(143, 'Philadelphia Phillies', 'PHI', 84, 57, 104, 204),
  t(121, 'New York Mets', 'NYM', 78, 63, 104, 204),
  t(144, 'Atlanta Braves', 'ATL', 70, 71, 104, 204),
  t(146, 'Miami Marlins', 'MIA', 63, 78, 104, 204),
  t(120, 'Washington Nationals', 'WSH', 55, 86, 104, 204),

  // ---- NL West (203) ----
  t(119, 'Los Angeles Dodgers', 'LAD', 83, 58, 104, 203),
  t(137, 'San Francisco Giants', 'SF', 76, 65, 104, 203),
  t(135, 'San Diego Padres', 'SD', 74, 67, 104, 203),
  t(109, 'Arizona Diamondbacks', 'ARI', 70, 71, 104, 203),
  t(115, 'Colorado Rockies', 'COL', 52, 89, 104, 203),

  // ---- AL East (201) ----
  t(147, 'New York Yankees', 'NYY', 85, 56, 103, 201),
  t(111, 'Boston Red Sox', 'BOS', 77, 64, 103, 201),
  t(141, 'Toronto Blue Jays', 'TOR', 74, 67, 103, 201),
  t(139, 'Tampa Bay Rays', 'TB', 69, 72, 103, 201),
  t(110, 'Baltimore Orioles', 'BAL', 62, 79, 103, 201),

  // ---- AL Central (202) ----
  t(114, 'Cleveland Guardians', 'CLE', 80, 61, 103, 202),
  t(116, 'Detroit Tigers', 'DET', 78, 63, 103, 202),
  t(118, 'Kansas City Royals', 'KC', 71, 70, 103, 202),
  t(142, 'Minnesota Twins', 'MIN', 66, 75, 103, 202),
  t(145, 'Chicago White Sox', 'CWS', 51, 90, 103, 202),

  // ---- AL West (200) ----
  t(117, 'Houston Astros', 'HOU', 82, 59, 103, 200),
  t(136, 'Seattle Mariners', 'SEA', 79, 62, 103, 200),
  t(140, 'Texas Rangers', 'TEX', 73, 68, 103, 200),
  t(108, 'Los Angeles Angels', 'LAA', 64, 77, 103, 200),
  t(133, 'Athletics', 'ATH', 60, 81, 103, 200),
];
