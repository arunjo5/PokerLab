// PokerNow's text log (the .csv download): one table event per line, newest
// first. Rebuilt into the raw hands the JSON export gives, so the converter,
// roster, and hand picker are shared with the JSON path.
import { rosterFromHands } from './pokernowImport.js';

const EV = { CHECK: 0, POST_BB: 2, POST_SB: 3, CALL: 7, BET_RAISE: 8, DEAL: 9, WIN: 10, FOLD: 11, SHOW: 12, END: 15, UNCALLED: 16 };
const SUIT = { '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c' };

// "10♥" -> "Th", "A♣" -> "Ac"; null for anything else
export function cardCode(str) {
  const s = String(str).trim();
  const suit = SUIT[s.slice(-1)];
  const rank = s.slice(0, -1) === '10' ? 'T' : s.slice(0, -1);
  return suit && /^[2-9TJQKA]$/.test(rank) ? rank + suit : null;
}
function cardList(list) {
  const out = String(list).split(',').map(cardCode);
  return out.length && out.every(Boolean) ? out : null;
}

// minimal RFC 4180 reader: quoted fields, doubled quotes, LF or CRLF
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// the header row names an entry column, quoted or not
export function isPokerNowCsv(text) {
  const first = String(text).replace(/^\uFEFF/, '').trimStart().split(/\r?\n/, 1)[0] || '';
  const cells = parseCsv(first)[0] || [];
  return cells.some((c) => c.trim().toLowerCase() === 'entry');
}

const START = /^-- starting hand #(\d+) \(id: ([^)]+)\)\s*(.*?)\s*(?:\(dealer: "(.*) @ ([^"\s]+)"\))?\s*--$/;
const END = /^-- ending hand #(\d+) --$/;
const STACK = /#(\d+) "(.*?) @ ([^"\s]+)" \(([\d.]+)\)/g;
const ACTOR = /^"(.*) @ ([^"\s]+)" (.+)$/;
const BOARD = /^(Flop|Turn|River)(?: \((second) run\))?:\s*(?:.*?\s)?\[([^\]]+)\]$/;
const UNCALLED = /^Uncalled bet of ([\d.]+) returned to "(.*) @ ([^"\s]+)"$/;
const STREET = { Flop: 1, Turn: 2, River: 3 };

function gameTypeOf(label) {
  if (/hold'?em/i.test(label)) return 'th';
  if (/omaha/i.test(label)) return 'plo';
  return label ? 'other' : 'th';
}

// one event line inside a hand; anything unrecognised is table chatter
function applyLine(hand, line) {
  let m;
  if ((m = line.match(/^Player stacks: (.*)$/))) {
    hand.players = [];
    for (const s of m[1].matchAll(STACK)) hand.players.push({ seat: Number(s[1]), name: s[2], id: s[3], stack: Number(s[4]) });
    return;
  }
  if ((m = line.match(/^Your hand is (.+)$/))) { hand.yourHand = cardList(m[1]); return; }
  if ((m = line.match(BOARD))) {
    const cards = cardList(m[3]);
    if (cards) hand.events.push({ payload: { type: EV.DEAL, cards, turn: STREET[m[1]], run: m[2] ? 2 : 1 } });
    return;
  }
  if ((m = line.match(UNCALLED))) {
    const seat = seatOf(hand, m[3]);
    if (seat != null) hand.events.push({ payload: { type: EV.UNCALLED, seat, value: Number(m[1]) } });
    return;
  }
  if (!(m = line.match(ACTOR))) return;
  const seat = seatOf(hand, m[2]);
  if (seat == null) return;
  const rest = m[3];
  let a;
  if ((a = rest.match(/^posts a small blind of ([\d.]+)/))) { hand.smallBlind = hand.smallBlind || Number(a[1]); hand.events.push({ payload: { type: EV.POST_SB, seat, value: Number(a[1]) } }); }
  else if ((a = rest.match(/^posts a big blind of ([\d.]+)/))) { hand.bigBlind = hand.bigBlind || Number(a[1]); hand.events.push({ payload: { type: EV.POST_BB, seat, value: Number(a[1]) } }); }
  else if ((a = rest.match(/^posts a straddle of ([\d.]+)/))) hand.events.push({ payload: { type: EV.BET_RAISE, seat, value: Number(a[1]) } });
  else if ((a = rest.match(/^posts an ante of ([\d.]+)/))) hand.ante = Number(a[1]);
  else if (/^folds/.test(rest)) hand.events.push({ payload: { type: EV.FOLD, seat } });
  else if (/^checks/.test(rest)) hand.events.push({ payload: { type: EV.CHECK, seat } });
  else if ((a = rest.match(/^calls ([\d.]+)/))) hand.events.push({ payload: { type: EV.CALL, seat, value: Number(a[1]) } });
  else if ((a = rest.match(/^(?:bets|raises to) ([\d.]+)/))) hand.events.push({ payload: { type: EV.BET_RAISE, seat, value: Number(a[1]) } });
  else if ((a = rest.match(/^shows an? (.+?)\.?$/))) { const cards = cardList(a[1]); if (cards && cards.length === 2) hand.events.push({ payload: { type: EV.SHOW, seat, cards } }); }
  else if ((a = rest.match(/^collected ([\d.]+) from pot/))) hand.events.push({ payload: { type: EV.WIN, seat, value: Number(a[1]) } });
}

function seatOf(hand, id) {
  const p = hand.players.find((x) => x.id === id);
  return p ? p.seat : null;
}

const sameCards = (a, b) => a && b && a.length === b.length && [...a].sort().join() === [...b].sort().join();

// the log never names its owner: match "Your hand is" against a showdown reveal
function inferHero(hands) {
  for (const h of hands) {
    if (!h.yourHand) continue;
    for (const e of h.events) {
      if (e.payload.type === EV.SHOW && sameCards(e.payload.cards, h.yourHand)) {
        const p = h.players.find((x) => x.seat === e.payload.seat);
        if (p) return p.id;
      }
    }
  }
  return null;
}

// text -> { exportHeroId, players, rawHands }, the same shape as the JSON parser
export function parsePokerNowCsv(text) {
  const rows = parseCsv(String(text).replace(/^\uFEFF/, ''));
  if (!rows.length) throw new Error('NOT_POKERNOW');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const iEntry = header.indexOf('entry'), iOrder = header.indexOf('order');
  if (iEntry < 0) throw new Error('NOT_POKERNOW');
  const lines = rows.slice(1)
    .filter((r) => r.length > iEntry && r[iEntry] !== '')
    .map((r, i) => ({ entry: r[iEntry].trim(), order: iOrder >= 0 ? Number(r[iOrder]) : NaN, i }));
  // the download is newest first; the order column is the true sequence
  const ordered = lines.every((l) => Number.isFinite(l.order)) ? lines.sort((a, b) => a.order - b.order) : lines.reverse();

  const hands = [];
  let hand = null;
  for (const { entry } of ordered) {
    let m;
    if ((m = entry.match(START))) {
      hand = { number: m[1], id: m[2], gameType: gameTypeOf(m[3]), dealerId: m[5] || null, players: [], events: [], smallBlind: 0, bigBlind: 0, ante: 0, yourHand: null };
      continue;
    }
    if (!hand) continue;
    if ((m = entry.match(END))) {
      hand.events.push({ payload: { type: EV.END } });
      const dealer = hand.players.find((p) => p.id === hand.dealerId);
      hand.dealerSeat = dealer ? dealer.seat : -1;
      delete hand.dealerId;
      hands.push(hand);
      hand = null;
      continue;
    }
    applyLine(hand, entry);
  }

  const heroId = inferHero(hands);
  for (const h of hands) {
    if (!h.yourHand) continue;
    const hero = heroId ? h.players.find((p) => p.id === heroId) : null;
    if (hero) { hero.hand = h.yourHand; delete h.yourHand; }
  }
  return { exportHeroId: heroId, players: rosterFromHands(hands), rawHands: hands };
}
