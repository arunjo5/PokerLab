// hero stats from imported replays. per-hand records are stored on the replay
// (replay.stats) so the stats page only ever aggregates small objects.
import { ReplayEngine } from './replayerEngine.js';

export const STATS_VERSION = 2;

// pseudo-observations an opponent's rate is shrunk toward the GTO rate with
export const PRIOR_WEIGHT = 20;

// per opponent, per hand: [hands, bet opportunities, bets, bets faced, folds, calls, raises]
export const OPP = { hands: 0, betOpp: 1, bet: 2, faced: 3, fold: 4, call: 5, raise: 6 };

// the one seat holding cards; showdown reveals make it ambiguous, so null then
export function inferHeroSeat(replay) {
  const seats = (replay && replay.setup && replay.setup.seats) || [];
  const withCards = seats.map((s, i) => (s && s.cards && s.cards.length === 2 ? i : -1)).filter(i => i >= 0);
  return withCards.length === 1 ? withCards[0] : null;
}

// across many hands the log owner is the name that holds cards most often
export function inferHeroName(replays) {
  const counts = new Map();
  for (const r of replays) {
    const seats = (r && r.setup && r.setup.seats) || [];
    for (const s of seats) {
      if (s && s.cards && s.cards.length === 2 && s.name) counts.set(s.name, (counts.get(s.name) || 0) + 1);
    }
  }
  let best = null, n = 0;
  for (const [name, c] of counts) if (c > n) { best = name; n = c; }
  return best;
}

export function heroSeatByName(replay, name) {
  const seats = (replay && replay.setup && replay.setup.seats) || [];
  const i = seats.findIndex(s => s && s.name === name && s.cards && s.cards.length === 2);
  return i >= 0 ? i : null;
}

// what every other seat did with its first river decision: bet when it could,
// and fold / call / raise when it faced a bet. later raises are not counted.
export function riverActions(replay, hero) {
  const out = {};
  if (!replay) return out;
  const seats = (replay.setup && replay.setup.seats) || [];
  const rec = (i) => {
    if (i === hero) return null;
    const name = seats[i] && typeof seats[i].name === 'string' ? seats[i].name.trim().slice(0, 40) : '';
    if (!name) return null;
    return out[name] || (out[name] = [1, 0, 0, 0, 0, 0, 0]);
  };
  seats.forEach((_, i) => rec(i));
  let live = false;
  const aggressors = new Set(), faced = new Set();
  for (const a of (Array.isArray(replay.actions) ? replay.actions : [])) {
    if ((a.street || 0) !== 3) continue;
    const r = rec(a.seat);
    if (!live) {
      if (r) { r[OPP.betOpp]++; if (a.type === 'bet') r[OPP.bet]++; }
    } else if (r && !aggressors.has(a.seat) && !faced.has(a.seat)) {
      faced.add(a.seat);
      r[OPP.faced]++;
      if (a.type === 'fold') r[OPP.fold]++;
      else if (a.type === 'call') r[OPP.call]++;
      else if (a.type === 'raise') r[OPP.raise]++;
    }
    if (a.type === 'bet' || a.type === 'raise') { live = true; aggressors.add(a.seat); }
  }
  return out;
}

// items: [{ stats }]; one row per opponent name, most hands first
export function aggregateOpponents(items) {
  const by = new Map();
  for (const it of items) {
    const opp = it && it.stats && it.stats.opp;
    if (!opp || typeof opp !== 'object') continue;
    for (const name of Object.keys(opp)) {
      const row = opp[name];
      if (!Array.isArray(row)) continue;
      let acc = by.get(name);
      if (!acc) { acc = { name, hands: 0, betOpp: 0, bet: 0, faced: 0, fold: 0, call: 0, raise: 0 }; by.set(name, acc); }
      for (const k of Object.keys(OPP)) acc[k] += Number(row[OPP[k]]) || 0;
    }
  }
  return [...by.values()].sort((a, b) => b.hands - a.hands || a.name.localeCompare(b.name));
}

// the solver's villain model: observed counts per river stat, null where there is no data
export function opponentModel(o) {
  if (!o) return null;
  return {
    bet: o.betOpp > 0 ? { hits: o.bet, opps: o.betOpp } : null,
    fold: o.faced > 0 ? { hits: o.fold, opps: o.faced } : null,
    raise: o.faced > 0 ? { hits: o.raise, opps: o.faced } : null,
  };
}

// one hand from the hero's seat; null when there's no hero or the hand can't be replayed
export function analyzeHand(replay, heroSeat) {
  if (!replay || !replay.setup || !Array.isArray(replay.setup.seats)) return null;
  const setup = replay.setup;
  const hero = heroSeat != null ? heroSeat : (replay.hero != null ? replay.hero : inferHeroSeat(replay));
  if (hero == null || hero < 0 || hero >= setup.seats.length) return null;
  const actions = Array.isArray(replay.actions) ? replay.actions : [];
  const board = Array.isArray(replay.board) ? replay.board : [];
  let frames;
  try { frames = ReplayEngine.buildReplay(setup, actions, board); } catch { return null; }
  if (!frames || !frames.length) return null;
  const last = frames[frames.length - 1];

  let vpip = false, pfr = false, tbOpp = false, tb = false, agg = 0, calls = 0;
  let raisesBefore = 0;
  let foldStreet = null;
  for (const a of actions) {
    const street = a.street || 0;
    if (a.seat === hero) {
      if (a.type === 'fold') foldStreet = street;
      if (street === 0) {
        if (a.type === 'call' || a.type === 'bet' || a.type === 'raise') vpip = true;
        if (a.type === 'raise' || a.type === 'bet') pfr = true;
        if (raisesBefore === 1 && !tbOpp) { tbOpp = true; if (a.type === 'raise') tb = true; }
      }
      if (a.type === 'bet' || a.type === 'raise') agg++;
      else if (a.type === 'call') calls++;
    }
    if (street === 0 && (a.type === 'raise' || a.type === 'bet')) raisesBefore++;
  }

  const live = last.folded.filter(f => !f).length;
  const flop = board.length >= 3 && (foldStreet == null || foldStreet >= 1);
  const sd = board.length >= 5 && live >= 2 && !last.folded[hero];
  const won = (replay.won && Number(replay.won[hero])) || 0;
  const net = won - (last.committed[hero] || 0);

  return {
    v: STATS_VERSION,
    hero,
    pos: setup.seats[hero].pos || null,
    players: setup.seats.length,
    bb: Number(setup.bb) || 0,
    cents: !!setup.cents,
    vpip, pfr, tbOpp, tb, flop, sd,
    wsd: sd && won > 0,
    agg, calls,
    net,
    pot: last.pot || 0,
    opp: riverActions(replay, hero),
  };
}

const pct = (n, d) => (d > 0 ? (100 * n) / d : null);
const bb100 = (netBb, hands) => (hands > 0 ? (netBb / hands) * 100 : null);

function bucket() {
  return { hands: 0, bbHands: 0, net: 0, netBb: 0, vpip: 0, pfr: 0, tbOpp: 0, tb: 0, flop: 0, sd: 0, wsd: 0, agg: 0, calls: 0 };
}
function add(b, s) {
  b.hands++;
  b.net += s.net;
  if (s.bb > 0) { b.netBb += s.net / s.bb; b.bbHands++; }
  if (s.vpip) b.vpip++;
  if (s.pfr) b.pfr++;
  if (s.tbOpp) b.tbOpp++;
  if (s.tb) b.tb++;
  if (s.flop) b.flop++;
  if (s.sd) b.sd++;
  if (s.wsd) b.wsd++;
  b.agg += s.agg;
  b.calls += s.calls;
}
function finish(b) {
  return {
    hands: b.hands,
    net: b.net,
    bb100: bb100(b.netBb, b.bbHands),
    vpip: pct(b.vpip, b.hands),
    pfr: pct(b.pfr, b.hands),
    threeBet: pct(b.tb, b.tbOpp),
    wtsd: pct(b.sd, b.flop),
    wsd: pct(b.wsd, b.sd),
    af: b.calls > 0 ? b.agg / b.calls : (b.agg > 0 ? Infinity : null),
    // raw counts so the page can say "3 of 12 opportunities"
    counts: { vpip: b.vpip, pfr: b.pfr, tb: b.tb, tbOpp: b.tbOpp, flop: b.flop, sd: b.sd, wsd: b.wsd, agg: b.agg, calls: b.calls, bbHands: b.bbHands },
  };
}

// grouping key for a hand's session: the import batch, else the day it was saved
export function sessionKey(item) {
  return item.session && item.session.id ? item.session.id : 'day:' + String(item.createdAt || '').slice(0, 10);
}

// drop PokerNow's generated export names; keep anything a person would have typed
export function cleanSessionLabel(label) {
  if (!label) return null;
  const s = String(label)
    .replace(/\.json$/i, '')
    .replace(/^poker[_ -]?now[_ -]?(log|hand[_ -]?history)?[_ -]*/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!s || /^pgl/i.test(s) || /^[A-Za-z0-9]{12,}$/.test(s)) return null;
  return s;
}

const DATE_TIME = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
export function sessionName(session, fallbackAt) {
  const label = cleanSessionLabel(session && session.label);
  if (label) return label;
  const d = new Date((session && session.at) || fallbackAt || NaN);
  return Number.isNaN(d.getTime()) ? 'Session' : d.toLocaleString('en-US', DATE_TIME);
}

// "PokerNow #12" was the import default; anything else is the user's own name
export function handLabel(name) {
  const m = /^PokerNow #(\d+)$/i.exec(name || '');
  if (m) return `Hand #${m[1]}`;
  return name || 'Hand';
}

// running total in hand order, for the chart
export function cumulativeNet(items) {
  const rows = items
    .filter(it => it.stats)
    .slice()
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
  let run = 0;
  return rows.map((it, i) => {
    run += it.stats.net;
    return { i: i + 1, id: it.id, name: it.name, net: it.stats.net, cum: run, createdAt: it.createdAt || null, session: it.session || null };
  });
}

const POS_ORDER = ['UTG', 'UTG1', 'UTG2', 'MP', 'MP1', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];

// items: [{ id, name, createdAt, session, stats }]; rows without stats are skipped
export function aggregate(items) {
  const all = bucket();
  const byPos = new Map();
  const bySession = new Map();
  const scored = [];
  let cents = false;
  for (const it of items) {
    const s = it.stats;
    if (!s) continue;
    cents = cents || !!s.cents;
    add(all, s);
    const pos = s.pos || '?';
    if (!byPos.has(pos)) byPos.set(pos, bucket());
    add(byPos.get(pos), s);
    const key = sessionKey(it);
    if (!bySession.has(key)) {
      bySession.set(key, { key, label: (it.session && it.session.label) || null, at: (it.session && it.session.at) || it.createdAt || null, b: bucket() });
    }
    add(bySession.get(key).b, s);
    scored.push({ id: it.id, name: it.name || null, net: s.net, pot: s.pot, pos, bb: s.bb, createdAt: it.createdAt || null, session: it.session || null });
  }
  const won = scored.filter(h => h.net > 0).sort((a, b) => b.net - a.net).slice(0, 5);
  const lost = scored.filter(h => h.net < 0).sort((a, b) => a.net - b.net).slice(0, 5);
  const positions = [...byPos.entries()]
    .map(([pos, b]) => ({ pos, ...finish(b) }))
    .sort((a, b) => (POS_ORDER.indexOf(a.pos) === -1 ? 99 : POS_ORDER.indexOf(a.pos)) - (POS_ORDER.indexOf(b.pos) === -1 ? 99 : POS_ORDER.indexOf(b.pos)));
  const sessions = [...bySession.values()]
    .map(sx => ({ key: sx.key, label: sx.label, at: sx.at, ...finish(sx.b) }))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return { cents, ...finish(all), positions, sessions, biggest: { won, lost } };
}

// "Sat Sep 6 · cash.json" style label for an import batch
export function sessionLabel(fileName) {
  const base = String(fileName || '').replace(/\.json$/i, '').trim();
  return base || null;
}
