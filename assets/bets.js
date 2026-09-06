/**
 * Bet board tab. Renders data/props-latest.json — formats only, never computes
 * a price or a probability of its own.
 */

const $ = (id) => document.getElementById(id);
const pct = (p) => `${(p * 100).toFixed(1)}%`;
const money = (n) => `$${n.toFixed(2)}`;
const sign = (n) => (n > 0 ? `+${Math.round(n)}` : String(Math.round(n)));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/* --------------------------------------------------------------- tabs --- */

function initTabs() {
  const tabs = [...document.querySelectorAll('.tab')];
  const select = (active) => {
    for (const tab of tabs) {
      const on = tab === active;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      $(tab.getAttribute('aria-controls')).hidden = !on;
    }
    active.focus();
  };

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      select(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]);
    });
  });
}

/* -------------------------------------------------------------- render --- */

function renderNotice(board) {
  const host = $('bets-notice');
  host.replaceChildren();

  if (board.source !== 'live') {
    const box = el('div', 'notice');
    box.append(el('strong', null, 'Example data. '),
      document.createTextNode('These players, prices and parlays are invented so the page has something to show. Do not bet them.'));
    host.append(box);
    return;
  }
  if (board.oddsStatus !== 'ok') {
    const box = el('div', 'notice');
    box.append(el('strong', null, 'Model-only mode. '),
      document.createTextNode(`No live odds available (${board.oddsStatus}), so no parlay payouts are shown — only the model's own fair prices. Nothing here is priced against a real book.`));
    host.append(box);
  }
}

function renderGame(board) {
  const host = $('bets-game');
  host.replaceChildren();

  if (board.status === 'no-game') {
    host.append(el('div', 'empty', 'No Brewers game scheduled today.'));
    return;
  }

  if (board.status === 'game-started') {
    const box = el('div', 'empty');
    box.append(
      el('strong', null, `First pitch has passed — ${board.gameState ?? 'in progress'}.`),
      document.createElement('br'),
      document.createTextNode(
        'No board is shown once a game starts. Books switch to live in-play pricing, ' +
        'which reflects at-bats already taken, while this model projects a full game — ' +
        'comparing the two produces edges that look enormous and are not real.'
      )
    );
    host.append(box);
    return;
  }

  const card = el('div', 'matchup');
  const head = el('div', 'matchup-head');
  head.append(
    el('h3', null, `${board.game.isHome ? 'vs.' : 'at'} ${board.game.opponent}`),
    el('span', 'matchup-when', new Date(board.game.startTime).toLocaleString('en-US', {
      timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: '2-digit',
    }) + ' CT')
  );
  card.append(head);

  const facts = el('div', 'facts');
  const fact = (label, value, detail) => {
    const f = el('div', 'fact');
    f.append(el('span', 'fl', label), el('div', 'fv', value));
    if (detail) f.append(el('span', 'fd', detail));
    return f;
  };

  if (board.starter) {
    facts.append(fact('Opposing starter', board.starter.name,
      `${board.starter.hand === 'L' ? 'Left' : 'Right'}-handed${board.starter.opponentAvg ? ` · .${String(Math.round(board.starter.opponentAvg * 1000)).padStart(3, '0')} against` : ''}`));
  }
  facts.append(fact('Conditions', board.conditions.roofClosed ? 'Roof closed' : `${Math.round(board.conditions.temperatureF)}°F`,
    [board.conditions.venue, board.conditions.description].filter(Boolean).join(' · ')));

  const f = board.factors ?? {};
  facts.append(fact('Starter factor', f.starterContact?.toFixed(2) ?? '—',
    f.starterContact > 1 ? 'Hitter-friendly' : 'Suppresses contact'));
  const parkNote = f.park && f.park !== 1
    ? `${f.park > 1 ? 'Hitter' : 'Pitcher'}'s park (${f.park.toFixed(2)})`
    : 'Neutral park';
  facts.append(fact('Power factor', f.power?.toFixed(2) ?? '—',
    board.conditions.roofClosed ? `Roof closed — ${parkNote.toLowerCase()}`
      : `${parkNote}${f.power > 1 ? ', air helps' : ''}`));

  card.append(facts);
  host.append(card);
}

function legRow(leg, { showResult = false } = {}) {
  const row = el('div', 'leg' + (showResult && typeof leg.hit === 'boolean' ? (leg.hit ? ' won' : ' lost') : ''));

  const main = el('div');
  main.append(el('span', 'leg-name', leg.playerName), el('span', 'leg-market', ` ${leg.marketLabel ?? leg.market}`));
  if (leg.lineupSlot) main.append(el('span', 'leg-slot', ` · bats ${leg.lineupSlot}`));
  row.append(main);

  const right = el('div', 'leg-nums');
  right.append(el('span', 'leg-prob', pct(leg.modelProbability)));
  right.append(el('span', 'leg-odds', leg.americanOdds != null ? sign(leg.americanOdds) : `model ${sign(leg.modelFairOdds)}`));
  if (leg.edge != null) {
    right.append(el('span', 'leg-edge' + (leg.edge > 0 ? ' pos' : ' neg'), `${leg.edge > 0 ? '+' : ''}${leg.edge.toFixed(1)} pts`));
  }
  if (showResult && typeof leg.hit === 'boolean') {
    right.append(el('span', 'leg-result', leg.hit ? 'Hit' : 'Miss'));
  }
  row.append(right);
  return row;
}

function renderParlays(board) {
  const host = $('bets-parlays');
  host.replaceChildren();

  if (!board.parlays?.length) {
    host.append(el('div', 'empty',
      board.oddsStatus === 'ok'
        ? 'No parlay clearing $100 on $5 met the rules tonight.'
        : 'Parlays need live odds. Once an odds key is configured they appear here.'));
    return;
  }

  for (const [i, parlay] of board.parlays.entries()) {
    const card = el('article', 'parlay');

    const head = el('div', 'parlay-head');
    head.append(el('span', 'parlay-rank', `#${i + 1}`));
    const pay = el('div', 'parlay-pay');
    pay.append(
      el('span', 'pay-amt', money(parlay.payout)),
      el('span', 'pay-sub', `on ${money(parlay.stake)} · ${parlay.legs.length} legs`)
    );
    head.append(pay);
    card.append(head);

    const legs = el('div', 'parlay-legs');
    for (const leg of parlay.legs) legs.append(legRow(leg));
    card.append(legs);

    const foot = el('div', 'parlay-foot');
    const stat = (label, value, cls) => {
      const s = el('div', 'pstat');
      s.append(el('span', 'psl', label), el('span', 'psv' + (cls ? ` ${cls}` : ''), value));
      return s;
    };
    foot.append(stat('Model chance', pct(parlay.probability)));
    foot.append(stat('Expected value', money(parlay.expectedValue), parlay.expectedValue > 0 ? 'pos' : 'neg'));
    if (typeof parlay.hit === 'boolean') foot.append(stat('Result', parlay.hit ? 'Cashed' : 'Lost', parlay.hit ? 'pos' : 'neg'));
    card.append(foot);

    host.append(card);
  }
}

function renderLegs(board) {
  const host = $('bets-legs');
  host.replaceChildren();
  if (!board.legs?.length) {
    host.append(el('div', 'empty', 'No legs projected — the lineup may not be posted yet.'));
    return;
  }
  const list = el('div', 'leg-list');
  for (const leg of board.legs.slice(0, 12)) list.append(legRow(leg));
  host.append(list);
}

function renderHistory(board) {
  const host = $('bets-history');
  host.replaceChildren();

  const days = (board.history ?? []).filter((d) => d.parlays?.some((p) => p.graded));
  if (!days.length) {
    host.append(el('div', 'empty',
      'No graded nights yet. The record fills in as the board runs each day.'));
    return;
  }

  // Ticket record and leg record are different questions: a 5-leg ticket can go
  // 4-for-5 and still lose, so leg accuracy is the honest read on the model
  // while ticket record is what the bankroll actually did.
  let won = 0, played = 0, legHits = 0, legTotal = 0, expected = 0;
  for (const day of days) {
    for (const p of day.parlays) {
      if (!p.graded) continue;
      played++;
      if (p.hit) won++;
    }
    for (const leg of day.legs ?? []) {
      if (typeof leg.hit !== 'boolean') continue;
      legTotal++;
      if (leg.hit) legHits++;
      expected += leg.modelProbability;
    }
  }

  const summary = el('div', 'record');
  const block = (value, label) => {
    const b = el('div', 'rec-block');
    b.append(el('span', 'rec-n', value), el('span', 'rec-l', label));
    return b;
  };
  summary.append(block(`${won}\u2013${played - won}`, `tickets over ${days.length} ${days.length === 1 ? 'night' : 'nights'}`));
  summary.append(block(`${legHits}/${legTotal}`, 'legs hit'));
  if (legTotal) {
    summary.append(block(expected.toFixed(1), 'legs the model expected'));
  }
  host.append(summary);

  if (board.calibration?.overall?.n) {
    const c = board.calibration.overall;
    const note = el('div', 'calib');
    const pct = Math.round((c.factor - 1) * 100);
    note.append(
      el('strong', null, pct === 0 ? 'No net correction. ' : `Model adjusted ${Math.abs(pct)}% ${pct < 0 ? 'down' : 'up'}. `),
      document.createTextNode(
        `Across ${c.n} graded legs the model expected ${c.expected.toFixed(1)} and got ${c.actual}. ` +
        (c.weight < 0.25
          ? 'That gap is still small enough to be chance, so the correction is deliberately held near zero until more nights accumulate.'
          : c.weight < 0.6
            ? 'Evidence is starting to outweigh the prior.'
            : 'The correction is now driven by the data.')
      )
    );
    host.append(note);
  }

  for (const day of days) {
    const heading = el('div', 'day-head');
    const dayWon = day.parlays.filter((p) => p.graded && p.hit).length;
    const dayPlayed = day.parlays.filter((p) => p.graded).length;
    heading.append(
      el('h3', null, new Date(day.date + 'T12:00:00Z').toLocaleDateString('en-US', {
        timeZone: 'America/Chicago', weekday: 'long', month: 'short', day: 'numeric',
      })),
      el('span', 'day-rec', `${dayWon} of ${dayPlayed} cashed`)
    );
    host.append(heading);

    for (const parlay of day.parlays.filter((p) => p.graded)) {
      const card = el('article', `parlay ${parlay.hit ? 'won' : 'lost'}`);

      const head = el('div', 'parlay-head');
      const hits = parlay.legs.filter((l) => legResult(day, l) === true).length;
      head.append(el('span', 'parlay-rank', `${hits}/${parlay.legs.length} legs`));
      const pay = el('div', 'parlay-pay');
      pay.append(
        el('span', 'pay-amt' + (parlay.hit ? '' : ' missed'), money(parlay.payout)),
        el('span', 'pay-sub', parlay.hit ? 'would have cashed' : 'lost')
      );
      head.append(pay);
      card.append(head);

      const legs = el('div', 'parlay-legs');
      for (const leg of parlay.legs) {
        legs.append(legRow({ ...leg, hit: legResult(day, leg) }, { showResult: true }));
      }
      card.append(legs);
      host.append(card);
    }
  }
}

/** Find a leg's graded outcome on its day. Parlay legs are copies, not refs. */
function legResult(day, leg) {
  const match = (day.legs ?? []).find((l) => l.playerId === leg.playerId && l.market === leg.market);
  return typeof match?.hit === 'boolean' ? match.hit : undefined;
}

async function main() {
  initTabs();
  try {
    const res = await fetch(`data/props-latest.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const board = await res.json();
    renderNotice(board);
    renderGame(board);
    renderParlays(board);
    renderLegs(board);
    renderHistory(board);
  } catch (err) {
    $('bets-notice').replaceChildren(
      el('div', 'notice', `Could not load the bet board: ${err.message}. The scheduled update may not have run yet.`)
    );
  }
}

main();
