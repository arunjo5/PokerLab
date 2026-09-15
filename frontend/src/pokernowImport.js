// Parse a PokerNow JSON export into hands the replayer can play:
//   { heroId, hands: [{ number, summary, replay:{ setup, actions, board } }] }
// Replay amounts stay in cents; the summary formats them as dollars.
// pokernowCsv.js feeds the same raw hands from the text log.

import { ReplayEngine } from './replayerEngine.js';
import { cardToId, evaluate7 } from './pokerEngine.js';

// Winners of one board among the showdown contenders, splitting `amount` (cents).
function boardResult(board, contenders, seats, amount) {
  const b = board.map(cardToId);
  let best = -1, winners = [];
  for (const seat of contenders) {
    const [h0, h1] = seats[seat].cards;
    const s = evaluate7(cardToId(h0), cardToId(h1), b[0], b[1], b[2], b[3], b[4]);
    if (s > best) { best = s; winners = [seat]; }
    else if (s === best) winners.push(seat);
  }
  const share = Math.round(amount / winners.length);
  const out = {};
  for (const seat of winners) out[seat] = share;
  return out;
}

const EV = {
  CHECK: 0, POST_BB: 2, POST_SB: 3, CALL: 7, BET_RAISE: 8,
  DEAL: 9, WIN: 10, FOLD: 11, SHOW: 12, END: 15, UNCALLED: 16,
};

function toCard(str) {
  return { v: str[0], s: str[1] }; // 'Qc' -> {v:'Q',s:'c'}
}

function money(cents) {
  return '$' + (cents / 100);
}

// Occupied seats in clockwise order starting at the button.
function seatOrder(players, dealerSeat) {
  const phys = players.map((p) => p.seat).sort((a, b) => a - b);
  let i = phys.indexOf(dealerSeat);
  if (i < 0) {
    // dead button on an empty seat — use the occupied seat just before it
    i = -1;
    for (let k = 0; k < phys.length; k++) if (phys[k] < dealerSeat) i = k;
    if (i < 0) i = phys.length - 1;
  }
  return phys.slice(i).concat(phys.slice(0, i));
}

function convertHand(h, heroId) {
  if (h.gameType && h.gameType !== 'th') return null; // Hold'em only
  const players = h.players || [];
  if (players.length < 2) return null;

  const order = seatOrder(players, h.dealerSeat);
  const physToIdx = new Map(order.map((s, i) => [s, i]));
  const bySeat = new Map(players.map((p) => [p.seat, p]));
  const labels = ReplayEngine.positionsForCount(order.length);

  // hole cards from players[].hand, plus any showdown reveals
  const cardsBySeat = new Map();
  for (const p of players) {
    if (Array.isArray(p.hand) && p.hand[0] && p.hand[1]) {
      cardsBySeat.set(p.seat, [toCard(p.hand[0]), toCard(p.hand[1])]);
    }
  }
  for (const e of h.events) {
    const p = e.payload;
    if (p.type === EV.SHOW && Array.isArray(p.cards) && p.cards[0] && p.cards[1] && !cardsBySeat.has(p.seat)) {
      cardsBySeat.set(p.seat, [toCard(p.cards[0]), toCard(p.cards[1])]);
    }
  }
  // the text log's "Your hand is" names no one; it belongs to whoever the user says they are
  const heroP = players.find((p) => p.id === heroId);
  if (heroP && !cardsBySeat.has(heroP.seat) && Array.isArray(h.yourHand) && h.yourHand.length === 2) {
    cardsBySeat.set(heroP.seat, [toCard(h.yourHand[0]), toCard(h.yourHand[1])]);
  }

  const seats = order.map((physSeat, i) => {
    const p = bySeat.get(physSeat);
    return {
      name: p.name || '',
      stack: p.stack || 0,
      pos: labels[i],
      cards: cardsBySeat.get(physSeat) || null,
    };
  });

  const setup = {
    sb: h.smallBlind || 0,
    bb: h.bigBlind || 0,
    ante: h.ante || 0,
    cents: true, // PokerNow amounts are in cents; the replayer divides by 100 to show dollars
    seats,
  };

  // type 7/8 aren't reliably call vs bet, so classify by the committed value
  // vs the current street bet: over it is a bet/raise, otherwise a call.
  const actions = [];
  const board = [];
  const run1ByStreet = {}; // street (1=flop,2=turn,3=river) -> cards, for run-twice reconstruction
  const run2ByStreet = {};
  const wonBySeat = {};     // seat index -> total chips collected this hand (cents)
  let street = 0;
  let streetBet = setup.bb; // preflop the BB is the standing bet
  let winTotal = 0;

  for (const e of h.events) {
    const p = e.payload;
    const idx = physToIdx.get(p.seat);
    switch (p.type) {
      case EV.POST_SB:
      case EV.POST_BB:
        break; // engine posts blinds
      case EV.CHECK:
        actions.push({ seat: idx, type: 'check', street });
        break;
      case EV.CALL:
      case EV.BET_RAISE:
        if (p.value > streetBet) {
          actions.push({ seat: idx, type: streetBet > 0 ? 'raise' : 'bet', amount: p.value, street });
          streetBet = p.value;
        } else {
          actions.push({ seat: idx, type: 'call', amount: p.value, street });
        }
        break;
      case EV.FOLD:
        actions.push({ seat: idx, type: 'fold', street });
        break;
      case EV.DEAL:
        if (Array.isArray(p.cards)) {
          const cards = p.cards.map(toCard);
          if (p.run === 2) {
            run2ByStreet[p.turn] = cards; // second runout (hand was run twice)
          } else {
            run1ByStreet[p.turn] = cards;
            street = p.turn; // 1=flop, 2=turn, 3=river — run 1 drives the action streets
            for (const c of cards) board.push(c);
            streetBet = 0;
          }
        }
        break;
      case EV.WIN:
        winTotal += p.value || 0;
        if (idx != null) wonBySeat[idx] = (wonBySeat[idx] || 0) + (p.value || 0);
        break;
      case EV.UNCALLED:
        break; // both sides return uncalled bets; nothing to track
      default:
        break;
    }
  }

  // Run it twice: a second board that shares the streets dealt before the
  // all-in (run 2 only re-deals from the divergence point onward).
  let board2 = null;
  if (run2ByStreet[1] || run2ByStreet[2] || run2ByStreet[3]) {
    board2 = [];
    for (const st of [1, 2, 3]) {
      const cards = run2ByStreet[st] || run1ByStreet[st] || [];
      for (const c of cards) board2.push(c);
    }
  }

  // rebuild and compare to PokerNow's pot (both return uncalled bets, so the
  // final pot should equal the payout); mismatch = mis-parse
  let valid = false;
  let runResults = null;
  try {
    const frames = ReplayEngine.buildReplay(setup, actions, board);
    const last = frames[frames.length - 1];
    valid = Math.abs(last.pot - winTotal) <= 1;

    // Run it twice: award half the pot per board to that board's winner(s).
    // Only keep it if the per-board split reconciles with PokerNow's payouts.
    if (board2 && board.length === 5 && board2.length === 5) {
      const contenders = [];
      for (let i = 0; i < seats.length; i++) {
        if (!last.folded[i] && seats[i].cards && seats[i].cards.length === 2) contenders.push(i);
      }
      if (contenders.length >= 2) {
        const r1 = boardResult(board, contenders, seats, winTotal / 2);
        const r2 = boardResult(board2, contenders, seats, winTotal / 2);
        const sum = {};
        for (const m of [r1, r2]) for (const k in m) sum[k] = (sum[k] || 0) + m[k];
        const keys = new Set([...Object.keys(sum), ...Object.keys(wonBySeat)]);
        let ok = true;
        for (const k of keys) if (Math.abs((sum[k] || 0) - (wonBySeat[k] || 0)) > 2) ok = false;
        if (ok) runResults = [{ run: 1, won: r1 }, { run: 2, won: r2 }];
      }
    }
  } catch {
    valid = false;
  }

  // summary for the picker list (dollars); the hero's seat index rides on the replay for stats
  const heroSeat = players.find((p) => p.id === heroId);
  const heroIdx = heroSeat ? physToIdx.get(heroSeat.seat) : null;
  const heroCards = heroSeat ? cardsBySeat.get(heroSeat.seat) || null : null;
  const names = [];
  if (heroSeat) names.push(heroSeat.name);
  for (const s of order) {
    const nm = bySeat.get(s).name;
    if (!heroSeat || s !== heroSeat.seat) names.push(nm);
  }

  return {
    number: parseInt(h.number, 10),
    valid,
    summary: {
      stakes: `${money(setup.sb)}/${money(setup.bb)}`,
      players: names,
      heroCards: heroCards || null,
      board: board.slice(),
      potLabel: winTotal ? `${money(winTotal)} pot` : null,
      runTwice: !!board2,
    },
    replay: { setup, actions, board, board2, won: wonBySeat, runResults, hero: heroIdx == null ? null : heroIdx },
  };
}

// Distinct players + how many hands each was dealt into; names can change, so keep the most-used.
export function rosterFromHands(rawHands) {
  const byId = new Map();
  for (const h of rawHands) {
    if (h.gameType && h.gameType !== 'th') continue;
    const ps = Array.isArray(h.players) ? h.players : [];
    if (ps.length < 2) continue;
    const seen = new Set();
    for (const p of ps) {
      if (!p || p.id == null || seen.has(p.id)) continue;
      seen.add(p.id);
      let rec = byId.get(p.id);
      if (!rec) { rec = { id: p.id, count: 0, names: new Map() }; byId.set(p.id, rec); }
      rec.count++;
      const nm = (p.name || '').trim();
      if (nm) rec.names.set(nm, (rec.names.get(nm) || 0) + 1);
    }
  }
  const roster = [];
  for (const rec of byId.values()) {
    let name = '', best = -1;
    for (const [nm, c] of rec.names) if (c > best) { best = c; name = nm; }
    roster.push({ id: rec.id, name: name || 'Unknown', count: rec.count });
  }
  roster.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return roster;
}

// Hands the given player was dealt into, pivoted around them.
export function convertHandsFor(rawHands, heroId) {
  const out = [];
  for (const h of rawHands || []) {
    if (!Array.isArray(h.players) || !h.players.some((p) => p && p.id === heroId)) continue;
    try {
      const conv = convertHand(h, heroId);
      if (conv) out.push(conv);
    } catch {
      // skip an unparseable hand, keep the rest
    }
  }
  return out;
}

// Every convertible hand, pivoted around the exporter — for importing without a player filter.
export function convertAllHands(rawHands, pivotId) {
  const out = [];
  for (const h of rawHands || []) {
    try {
      const conv = convertHand(h, pivotId);
      if (conv) out.push(conv);
    } catch {
      // skip an unparseable hand, keep the rest
    }
  }
  return out;
}

// Parse + validate the export and pull the player roster.
export function parsePokerNowLog(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error('NOT_JSON');
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.hands)) {
    throw new Error('NOT_POKERNOW');
  }
  return {
    exportHeroId: data.playerId || null,
    players: rosterFromHands(data.hands),
    rawHands: data.hands,
  };
}
