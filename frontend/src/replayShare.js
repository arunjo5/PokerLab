// replay-hand share codec (still reads old v1 links)
import { ReplayEngine } from './replayerEngine.js';
import { cardToId, idToCard } from './pokerEngine.js';
import { packV2, unpackV2 } from './shareCodec.js';

const ACT_TYPES = ['fold', 'check', 'call', 'bet', 'raise'];
const ACT_CODE = { fold: 0, check: 1, call: 2, bet: 3, raise: 4 };

export function encodeReplay(hand) {
  const s = hand.setup || {};
  const st = (s.seats || []).map((seat) => {
    const t = [seat.name || '', seat.stack || 0];
    if (seat.cards && seat.cards.length === 2) {
      t.push(cardToId(seat.cards[0]), cardToId(seat.cards[1]));
    }
    return t;
  });
  const ac = (hand.actions || []).map((a) => {
    const t = [a.seat, ACT_CODE[a.type] ?? 0, a.street || 0];
    if (a.amount != null) t.push(a.amount);
    return t;
  });
  const obj = { bb: s.bb || 0, sb: s.sb || 0, st, ac, bd: (hand.board || []).map(cardToId) };
  if (s.ante) obj.an = s.ante;
  if (Array.isArray(s.antes)) obj.as = s.antes;
  if (s.cents) obj.ce = 1;
  if (hand.board2) obj.b2 = hand.board2.map(cardToId);
  if (hand.won) obj.wn = hand.won;
  if (hand.runResults) obj.rr = hand.runResults;
  return packV2(obj);
}

function expandReplayV2(o) {
  const st = o.st || [];
  const positions = ReplayEngine.positionsForCount(st.length);
  const seats = st.map((arr, i) => ({
    name: arr[0] || '',
    stack: arr[1] || 0,
    pos: positions[i],
    cards: arr.length >= 4 ? [idToCard(arr[2]), idToCard(arr[3])] : null,
  }));
  const actions = (o.ac || []).map((a) => {
    const act = { seat: a[0], type: ACT_TYPES[a[1]] || 'fold', street: a[2] || 0 };
    if (a.length > 3) act.amount = a[3];
    return act;
  });
  return {
    setup: { sb: o.sb || 0, bb: o.bb || 0, ante: o.an || 0, cents: !!o.ce, seats, ...(Array.isArray(o.as) ? { antes: o.as } : {}) },
    actions,
    board: (o.bd || []).map(idToCard),
    board2: o.b2 ? o.b2.map(idToCard) : null,
    won: o.wn || null,
    runResults: o.rr || null,
  };
}

function decodeReplayV1(str) {
  try {
    let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const o = JSON.parse(decodeURIComponent(escape(atob(s))));
    if (!o.s || !o.a || !o.b) return null;
    return { setup: o.s, actions: o.a, board: o.b, board2: o.b2 || null, won: o.w || null, runResults: o.rr || null };
  } catch {
    return null;
  }
}

export function decodeReplay(str) {
  const v2 = unpackV2(str);
  if (v2 !== undefined) {
    if (v2 === null) return null;
    try {
      const r = expandReplayV2(v2);
      return r.setup.seats.length ? r : null;
    } catch {
      return null;
    }
  }
  return decodeReplayV1(str);
}
