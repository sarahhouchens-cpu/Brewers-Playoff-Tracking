/**
 * Renders data/latest.json. All computation happens in the GitHub Action —
 * this file only formats what it finds, so the page has no API dependency.
 */

const $ = (id) => document.getElementById(id);

const fmtDate = (iso, opts) =>
  new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', ...opts });

function text(el, value) {
  el.textContent = value;
}

/** Escape-free element building — nothing here interpolates HTML strings. */
function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent != null) node.textContent = textContent;
  return node;
}

function renderNotice(data) {
  const host = $('notice');
  host.replaceChildren();
  if (data.source === 'live') return;

  const box = el('div', 'notice');
  box.append(
    el('strong', null, 'Example data. '),
    document.createTextNode(
      'These are placeholder standings so the page has something to show. The first scheduled update replaces them with live numbers.'
    )
  );
  host.append(box);
}

function renderHero(data) {
  const headline = data.races.find((r) => r.key === data.headline) ?? data.races[0];
  const { team } = data;

  text($('record'), `${team.wins}–${team.losses} · ${data.gamesRemaining} games left`);
  text($('slate'), `Milwaukee Brewers · ${fmtDate(data.slateDate + 'T12:00:00Z', {
    month: 'short',
    day: 'numeric',
  })}`);
  text($('updated'), `Updated ${fmtDate(data.generatedAt, {
    hour: 'numeric',
    minute: '2-digit',
  })} CT`);

  const numeral = $('numeral');
  numeral.classList.toggle('is-clinched', headline.clinched);
  text(numeral, headline.clinched ? 'CLINCHED' : String(headline.magic));
  text($('headline'), headline.clinched ? `The ${headline.label} is locked up` : headline.headline);

  text(
    $('explainer'),
    headline.clinched
      ? 'Every race on the board is decided.'
      : `Any combination of ${headline.magic} Brewers ${
          headline.magic === 1 ? 'win' : 'wins'
        } and ${headline.chaser.name} ${headline.magic === 1 ? 'loss' : 'losses'} gets it done.`
  );

  // The bar tracks the season, not the magic number — it is the honest measure
  // of how far along the run is.
  const pct = Math.round((data.gamesPlayed / (data.gamesPlayed + data.gamesRemaining)) * 100);
  $('track-fill').style.width = `${pct}%`;
  text($('track-left'), `${team.wins}–${team.losses} · ${data.gamesPlayed} played`);
  text($('track-right'), `${pct}% of the season`);
}

function renderRaces(data) {
  const host = $('races');
  host.replaceChildren();
  const deltas = new Map((data.deltas ?? []).map((d) => [d.key, d]));

  for (const race of data.races) {
    const cell = el('div', 'race' + (race.key === data.headline ? ' is-headline' : ''));
    cell.append(el('span', 'rt', race.label));

    const line = el('div', 'rn');
    line.append(document.createTextNode(race.clinched ? '✓' : String(race.magic ?? '—')));

    const diff = deltas.get(race.key);
    if (diff && diff.delta != null && diff.delta !== 0) {
      line.append(
        el(
          'span',
          'delta' + (diff.delta > 0 ? ' up' : ''),
          diff.delta > 0 ? `+${diff.delta}` : String(diff.delta)
        )
      );
    }
    cell.append(line);

    if (race.clinched) {
      cell.append(el('span', 'chip', 'Clinched'));
    } else if (race.chaser) {
      const sub = el('span', 'rs');
      sub.append(
        document.createTextNode(
          `vs. ${race.chaser.abbrev} ${race.chaser.wins}–${race.chaser.losses}`
        )
      );
      if (race.elimination != null) {
        sub.append(el('span', 'elim', ` · E# ${race.elimination}`));
      }
      cell.append(sub);
    }

    if (diff?.chaserChanged && diff.previousChaser) {
      cell.append(el('span', 'rs', `Chaser changed from ${diff.previousChaser.abbrev}`));
    }

    host.append(cell);
  }
}

function renderFeed(data) {
  const host = $('feed');
  host.replaceChildren();

  if (!data.feed?.length) {
    host.append(
      el(
        'div',
        'empty',
        'No completed games yet that affect a Brewers magic number. Check back after tonight’s slate.'
      )
    );
    return;
  }

  for (const card of data.feed) {
    const node = el('article', `card ${card.kind}`);

    const main = el('div');
    main.append(el('span', 'tag', card.tag), el('div', 'score', card.score), el('p', 'why', card.why));
    node.append(main);

    const impact = el('div', 'impact');
    if (card.impacts.length) {
      for (const i of card.impacts) {
        const row = el('div');
        row.append(el('span', 'd', '−1'), document.createTextNode(` ${i.label}`));
        impact.append(row);
      }
    } else {
      const row = el('div');
      row.append(el('span', 'z', '—'), document.createTextNode(' no change'));
      impact.append(row);
    }
    node.append(impact);

    host.append(node);
  }
}

function renderError(message) {
  $('headline').textContent = 'Could not load the standings';
  $('explainer').textContent = message;
  $('numeral').textContent = '—';
  $('updated').textContent = 'Error';
}

async function main() {
  try {
    const res = await fetch(`data/latest.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();

    renderNotice(data);
    renderHero(data);
    renderRaces(data);
    renderFeed(data);

    $('footer-stamp').textContent = `Snapshot generated ${fmtDate(data.generatedAt, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })} CT.`;
  } catch (err) {
    renderError(`${err.message}. The scheduled update may not have run yet.`);
  }
}

main();
