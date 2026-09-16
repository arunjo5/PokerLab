// PokerStars and GGPoker text hand histories. The two share one grammar, so one
// reader covers both and returns the raw hands the PokerNow converter already
// takes, keeping a single conversion path into the replayer.
import { rosterFromHands } from './pokernowImport.js';

const EV = { CHECK: 0, POST_BB: 2, POST_SB: 3, CALL: 7, BET_RAISE: 8, DEAL: 9, WIN: 10, FOLD: 11, SHOW: 12, END: 15, UNCALLED: 16 };

const HEADER = /^(?:PokerStars|Poker Hand|GGPoker)\b[^#]*#([A-Za-z0-9-]+):\s*(.*)$/;
const TABLE = /Seat #(\d+) is the button/;
const SEAT = /^Seat (\d+): (.+?) \(([^()]*?) in chips\)(.*)$/;
const SUMMARY_SEAT = /^Seat (\d+):/;
const BOARD_MARK = /^\*\*\* (FIRST |SECOND |THIRD |FOURTH )?(FLOP|TURN|RIVER)\b[^*]*\*\*\*(.*)$/;
const DEALT = /^Dealt to (.+?) \[([^\]]+)\]\s*$/;
const COLLECT = /^(.+?) collected (\S+) from /;
const UNCALLED = /^Uncalled bet \(([^)]+)\) returned to (.+?)\s*$/;
const DROP = /^Cash Drop to Pot\s*:\s*total\s+(\S+)/i;
const DEDUCT = /\|\s*(?:Rake|Jackpot|Bingo|Fortune|Tax|Cap)\s+(\S+)/g;
const STAMP = /(\d{4})\/(\d{2})\/(\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})/;
const ALL_IN = /\s+and is all[- ]?in\s*$/i;
const RUN = { 'FIRST ': 1, 'SECOND ': 2, 'THIRD ': 3, 'FOURTH ': 4 };
const STREET = { FLOP: 1, TURN: 2, RIVER: 3 };
const CARD = /^[2-9TJQKA][shdc]$/;
const CURRENCY = /[$€£¥]/;

// a header in the opening lines, so a file that starts with a banner still counts
export function isHandHistoryText(text) {
  let seen = 0;
  for (const line of String(text).replace(/^\uFEFF/, '').split(/\r?\n/, 40)) {
    const s = line.trim();
    if (!s) continue;
    if (HEADER.test(s)) return true;
    if (++seen >= 5) break;
  }
  return false;
}

// chips as integers: money becomes cents, tournament chips stay whole
function amount(str, mult) {
  const n = parseFloat(String(str).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * mult) : null;
}
function cardsIn(str) {
  const out = String(str).trim().split(/\s+/);
  return out.length && out.every((c) => CARD.test(c)) ? out : null;
}
// the last bracket group holds the cards a street just added
function lastGroup(str) {
  const groups = String(str).match(/\[[^\]]*\]/g);
  return groups ? cardsIn(groups[groups.length - 1].slice(1, -1)) : null;
}
function stampKey(desc) {
  const m = STAMP.exec(String(desc));
  if (!m) return null;
  return ((((Number(m[1]) * 100 + Number(m[2])) * 100 + Number(m[3])) * 100 + Number(m[4])) * 100 + Number(m[5])) * 100 + Number(m[6]);
}
function gameTypeOf(desc) {
  if (/hold\s?'?em/i.test(desc)) return 'th';
  if (/omaha/i.test(desc)) return 'plo';
  return 'other';
}
// the blind pair sits in the last parenthesised group carrying a slash
function blindSpec(desc) {
  const groups = String(desc).match(/\(([^()]*)\)/g) || [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const inner = groups[i].slice(1, -1);
    if (inner.includes('/')) return inner;
  }
  return null;
}

// the seat stacks alone decide the unit: a bounty or re-buy line is priced in
// dollars even at a table that plays in tournament chips
function moneyGame(lines, desc) {
  for (const raw of lines) {
    const m = SEAT.exec(raw.trim());
    if (m) return CURRENCY.test(m[3]);
  }
  const spec = blindSpec(desc);
  return spec ? CURRENCY.test(spec) : false;
}

function parseHand(id, desc, lines) {
  const money = moneyGame(lines, desc);
  const mult = money ? 100 : 1;
  const hand = {
    id, number: 0, gameType: gameTypeOf(desc), at: stampKey(desc),
    players: [], events: [], smallBlind: 0, bigBlind: 0, ante: 0,
    cents: money, rake: 0, dead: 0, dealerSeat: -1,
  };
  const bySeat = new Map();
  const byName = new Map();
  const antes = new Map();
  const summarySeats = new Set();
  let heroName = null;
  let inSummary = false;
  let street = 0;
  let paid = new Map(); // seat -> chips committed on this street

  const seatOf = (name) => (byName.has(name) ? byName.get(name) : null);
  // action lines start with an exact seat name; chat and table notices never do
  function actorOf(line) {
    const i = line.indexOf(': ');
    for (let at = i; at > 0; at = line.indexOf(': ', at + 1)) {
      const seat = seatOf(line.slice(0, at));
      if (seat != null) return { seat, rest: line.slice(at + 2).trim() };
    }
    return null;
  }
  const paidBy = (seat) => paid.get(seat) || 0;
  const commit = (seat, total) => paid.set(seat, total);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    let m = BOARD_MARK.exec(line);
    if (m) {
      const run = RUN[m[1]] || 1;
      const cards = lastGroup(m[3]);
      if (cards && run <= 2) hand.events.push({ payload: { type: EV.DEAL, cards, turn: STREET[m[2]], run } });
      if (run === 1) { street = STREET[m[2]]; paid = new Map(); }
      continue;
    }
    if (/^\*\*\* SUMMARY \*\*\*/.test(line)) { inSummary = true; continue; }
    if (/^\*\*\* /.test(line)) continue;

    if (inSummary) {
      if (/^Total pot/.test(line)) {
        DEDUCT.lastIndex = 0;
        let d;
        while ((d = DEDUCT.exec(line))) hand.rake += amount(d[1], mult) || 0;
      } else if ((m = SUMMARY_SEAT.exec(line))) summarySeats.add(Number(m[1]));
      continue;
    }

    if ((m = SEAT.exec(line))) {
      if (/sitting out|out of hand/i.test(m[4])) continue;
      const seat = Number(m[1]);
      const p = { seat, id: m[2], name: m[2], stack: amount(m[3], mult) || 0 };
      bySeat.set(seat, p);
      byName.set(p.name, seat);
      hand.players.push(p);
      continue;
    }
    if ((m = DROP.exec(line))) { hand.dead += amount(m[1], mult) || 0; continue; }
    if (!hand.players.length) {
      if ((m = TABLE.exec(line))) hand.dealerSeat = Number(m[1]);
      continue;
    }
    if ((m = DEALT.exec(line))) {
      const cards = cardsIn(m[2]);
      const seat = seatOf(m[1]);
      if (cards && seat != null) { bySeat.get(seat).hand = cards; heroName = m[1]; }
      continue;
    }
    if ((m = UNCALLED.exec(line))) {
      const seat = seatOf(m[2]);
      if (seat != null) hand.events.push({ payload: { type: EV.UNCALLED, seat, value: amount(m[1], mult) || 0 } });
      continue;
    }
    if ((m = COLLECT.exec(line))) {
      const seat = seatOf(m[1]);
      if (seat != null) { hand.events.push({ payload: { type: EV.WIN, seat, value: amount(m[2], mult) || 0 } }); continue; }
    }

    const actor = actorOf(line);
    if (!actor) continue;
    const { seat } = actor;
    const rest = actor.rest.replace(ALL_IN, '');
    let a;
    if ((a = /^posts the ante\b\s*(\S+)/.exec(rest)) || (a = /^posts ante\b\s*(\S+)/.exec(rest))) {
      antes.set(seat, amount(a[1], mult) || 0);
    } else if ((a = /^posts small (?:&|and) big blinds?\s*(\S+)/i.exec(rest))) {
      commit(seat, amount(a[1], mult) || 0);
    } else if ((a = /^posts small blind\s*(\S+)/.exec(rest))) {
      const v = amount(a[1], mult) || 0;
      if (!hand.smallBlind) hand.smallBlind = v;
      commit(seat, v);
    } else if ((a = /^posts big blind\s*(\S+)/.exec(rest))) {
      const v = amount(a[1], mult) || 0;
      if (!hand.bigBlind) hand.bigBlind = v;
      commit(seat, v);
    } else if ((a = /^(?:posts a straddle of|straddles?)\s*(\S+)/i.exec(rest))) {
      const v = amount(a[1], mult) || 0;
      commit(seat, v);
      hand.events.push({ payload: { type: EV.BET_RAISE, seat, value: v, street } });
    } else if (/^folds\b/.test(rest)) {
      hand.events.push({ payload: { type: EV.FOLD, seat } });
    } else if (/^checks\b/.test(rest)) {
      hand.events.push({ payload: { type: EV.CHECK, seat } });
    } else if ((a = /^calls\s*(\S+)/.exec(rest))) {
      // calls and bets name the added chips; raises name the new street total
      const total = paidBy(seat) + (amount(a[1], mult) || 0);
      commit(seat, total);
      hand.events.push({ payload: { type: EV.CALL, seat, value: total, street } });
    } else if ((a = /^bets\s*(\S+)/.exec(rest))) {
      const total = paidBy(seat) + (amount(a[1], mult) || 0);
      commit(seat, total);
      hand.events.push({ payload: { type: EV.BET_RAISE, seat, value: total, street } });
    } else if ((a = /^raises\s*\S+\s+to\s+(\S+)/.exec(rest))) {
      const total = amount(a[1], mult) || 0;
      commit(seat, total);
      hand.events.push({ payload: { type: EV.BET_RAISE, seat, value: total, street } });
    } else if ((a = /^shows \[([^\]]+)\]/.exec(rest))) {
      const cards = cardsIn(a[1]);
      if (cards && cards.length === 2) hand.events.push({ payload: { type: EV.SHOW, seat, cards } });
    }
  }

  hand.events.push({ payload: { type: EV.END } });
  if (summarySeats.size) {
    hand.players = hand.players.filter((p) => summarySeats.has(p.seat));
  }
  const live = new Set(hand.players.map((p) => p.seat));
  hand.events = hand.events.filter((e) => e.payload.seat == null || live.has(e.payload.seat));
  // everyone posting the same ante is the plain case; a big-blind ante is per seat
  const posted = [...antes.entries()].filter(([seat, v]) => v > 0 && live.has(seat));
  if (posted.length) {
    const first = posted[0][1];
    if (posted.length === live.size && posted.every(([, v]) => v === first)) hand.ante = first;
    else { hand.antes = {}; for (const p of hand.players) hand.antes[p.seat] = antes.get(p.seat) || 0; }
  }
  if (!hand.bigBlind) {
    const spec = blindSpec(desc);
    const parts = spec ? spec.split('/') : [];
    if (parts.length >= 2) {
      hand.smallBlind = hand.smallBlind || amount(parts[0], mult) || 0;
      hand.bigBlind = amount(parts[1], mult) || 0;
    }
  }
  hand.hero = heroName;
  return hand;
}

// text -> { exportHeroId, players, rawHands }, the shape the PokerNow parsers return
export function parseHandHistory(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  const hands = [];
  let head = null;
  let body = [];
  for (const line of lines) {
    const m = HEADER.exec(line.trim());
    if (m) {
      if (head) hands.push(parseHand(head[1], head[2], body));
      head = m;
      body = [];
    } else if (head) body.push(line);
  }
  if (head) hands.push(parseHand(head[1], head[2], body));
  if (!hands.length) throw new Error('NOT_HAND_HISTORY');

  // files arrive newest-first or oldest-first; timestamps settle the order
  if (hands.every((h) => h.at != null)) hands.sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)));
  hands.forEach((h, i) => { h.number = i + 1; });

  const heroes = new Map();
  for (const h of hands) if (h.hero) heroes.set(h.hero, (heroes.get(h.hero) || 0) + 1);
  let exportHeroId = null, best = 0;
  for (const [name, n] of heroes) if (n > best) { best = n; exportHeroId = name; }
  for (const h of hands) delete h.hero;

  return { exportHeroId, players: rosterFromHands(hands), rawHands: hands };
}
