// Replayer engine — pure poker betting logic + playback frame derivation.
// No React, no DOM.

// Seat order ALWAYS starts at the button (index 0), going clockwise:
// BTN, SB, BB, then early→late. Labels chosen per table size.
const POS_BY_COUNT = {
  2: ['BTN', 'BB'],                 // heads-up: BTN posts the small blind
  3: ['BTN', 'SB', 'BB'],
  4: ['BTN', 'SB', 'BB', 'UTG'],
  5: ['BTN', 'SB', 'BB', 'UTG', 'CO'],
  6: ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'],
  7: ['BTN', 'SB', 'BB', 'UTG', 'MP', 'HJ', 'CO'],
  8: ['BTN', 'SB', 'BB', 'UTG', 'UTG1', 'MP', 'HJ', 'CO'],
  9: ['BTN', 'SB', 'BB', 'UTG', 'UTG1', 'MP', 'LJ', 'HJ', 'CO'],
};

const STREET_NAMES = ['Preflop', 'Flop', 'Turn', 'River'];
const STREET_BOARD = [0, 3, 4, 5]; // cards visible entering each street index

function positionsForCount(n) {
  return (POS_BY_COUNT[n] || POS_BY_COUNT[9].slice(0, n)).slice();
}
function blindSeats(n) {
  return n === 2 ? { sb: 0, bb: 1 } : { sb: 1, bb: 2 };
}

function postBlind(st, seat, amt) {
  const pay = Math.min(amt, st.stacks[seat]);
  st.stacks[seat] -= pay;
  st.streetContrib[seat] += pay;
  st.committed[seat] += pay;
  st.pot += pay;
  if (st.stacks[seat] === 0) st.allin[seat] = true;
}

function initState(setup) {
  const N = setup.seats.length;
  const st = {
    N,
    stacks: setup.seats.map(s => Number(s.stack) || 0),
    committed: Array(N).fill(0),
    streetContrib: Array(N).fill(0),
    folded: Array(N).fill(false),
    allin: Array(N).fill(false),
    acted: Array(N).fill(false),
    street: 0,
    boardDealt: 0,
    toCall: 0,
    lastRaiseSize: Number(setup.bb) || 1,
    pot: 0,
    aggressor: null,
    handOver: false,
  };
  // setup.antes (per seat) covers a big-blind ante; setup.ante is the whole table
  const antes = Array.isArray(setup.antes) && setup.antes.length ? setup.antes : null;
  const ante = Number(setup.ante) || 0;
  if (antes || ante > 0) {
    for (let i = 0; i < N; i++) {
      const want = antes ? Number(antes[i]) || 0 : ante;
      if (want <= 0) continue;
      const a = Math.min(want, st.stacks[i]);
      st.stacks[i] -= a; st.committed[i] += a; st.pot += a;
      if (st.stacks[i] === 0) st.allin[i] = true;
    }
  }
  const { sb, bb } = blindSeats(N);
  postBlind(st, sb, Number(setup.sb) || 0);
  postBlind(st, bb, Number(setup.bb) || 0);
  st.toCall = Number(setup.bb) || 0;
  st.lastRaiseSize = Number(setup.bb) || 1;
  st.aggressor = bb;
  st.nextSeat = findNext(st, st.street === 0 ? bb : 0);
  return st;
}

// Does this seat still owe an action this street?
function needsAction(st, seat) {
  if (st.folded[seat] || st.allin[seat]) return false;
  if (st.streetContrib[seat] < st.toCall) return true; // owes chips, so must answer
  if (st.acted[seat]) return false;
  return liveActorCount(st) > 1; // last player with chips has nobody to act against
}

function findNext(st, fromSeat) {
  for (let i = 1; i <= st.N; i++) {
    const cand = (fromSeat + i) % st.N;
    if (needsAction(st, cand)) return cand;
  }
  return null;
}

// whatever the top street contribution had over the next one was never called:
// everyone else folded or was all-in for less, so it goes back
function settleUncalled(st) {
  let top = -1, high = 0, second = 0;
  for (let i = 0; i < st.N; i++) {
    const c = st.streetContrib[i];
    if (c > high) { second = high; high = c; top = i; }
    else if (c > second) second = c;
  }
  const refund = high - second;
  if (top < 0 || refund <= 0 || st.folded[top]) return;
  st.stacks[top] += refund;
  st.streetContrib[top] -= refund;
  st.committed[top] -= refund;
  st.pot -= refund;
  if (st.stacks[top] > 0) st.allin[top] = false;
}

function activeCount(st) {
  let c = 0;
  for (let i = 0; i < st.N; i++) if (!st.folded[i]) c++;
  return c;
}

// Players who can still act voluntarily (not folded / not all-in)
function liveActorCount(st) {
  let c = 0;
  for (let i = 0; i < st.N; i++) if (!st.folded[i] && !st.allin[i]) c++;
  return c;
}

function legalOptions(st, setup) {
  const seat = st.nextSeat;
  if (seat == null) return null;
  const stack = st.stacks[seat];
  const owe = st.toCall - st.streetContrib[seat];
  const callAmt = Math.min(Math.max(owe, 0), stack);
  const canCheck = owe <= 0;
  const canCall = owe > 0 && stack > 0;
  const facingBet = st.toCall > 0;
  const minRaiseTo = st.toCall + st.lastRaiseSize;
  const maxTo = st.streetContrib[seat] + stack; // all-in total
  return {
    seat,
    stack,
    canFold: facingBet,                 // folding when you can check is allowed but discouraged; hide it
    canCheck,
    canCall,
    callAmt,
    canBet: !facingBet && stack > 0,
    canRaise: facingBet && stack > owe,
    minBet: Math.min(Number(setup.bb) || 1, stack),
    minRaiseTo: Math.min(minRaiseTo, maxTo),
    maxTo,
    toCall: st.toCall,
    streetContrib: st.streetContrib[seat],
    pot: st.pot,
  };
}

// Apply one action mutating st. action = { seat, type, amount }
// type ∈ fold | check | call | bet | raise (amount = raise/bet TARGET total this street)
function applyAction(st, action) {
  const seat = action.seat;
  const type = action.type;
  if (type === 'fold') {
    st.folded[seat] = true;
    st.acted[seat] = true;
  } else if (type === 'check') {
    st.acted[seat] = true;
  } else if (type === 'call') {
    const owe = st.toCall - st.streetContrib[seat];
    const pay = Math.min(Math.max(owe, 0), st.stacks[seat]);
    st.stacks[seat] -= pay;
    st.streetContrib[seat] += pay;
    st.committed[seat] += pay;
    st.pot += pay;
    st.acted[seat] = true;
    if (st.stacks[seat] === 0) st.allin[seat] = true;
  } else if (type === 'bet' || type === 'raise') {
    const target = Math.min(action.amount, st.streetContrib[seat] + st.stacks[seat]);
    const pay = target - st.streetContrib[seat];
    const raiseIncrement = target - st.toCall;
    st.stacks[seat] -= pay;
    st.streetContrib[seat] = target;
    st.committed[seat] += pay;
    st.pot += pay;
    if (raiseIncrement > 0) st.lastRaiseSize = raiseIncrement;
    st.toCall = Math.max(st.toCall, target);
    st.aggressor = seat;
    // Everyone else owes a response again.
    for (let i = 0; i < st.N; i++) {
      if (i !== seat && !st.folded[i] && !st.allin[i]) st.acted[i] = false;
    }
    st.acted[seat] = true;
    if (st.stacks[seat] === 0) st.allin[seat] = true;
  }

  if (activeCount(st) <= 1) {
    settleUncalled(st);
    st.handOver = true;
    st.nextSeat = null;
    return;
  }
  st.nextSeat = findNext(st, seat);
  // round closed: a shove nobody could match gets its excess back
  if (st.nextSeat == null) settleUncalled(st);
}

function streetComplete(st) {
  if (st.handOver) return true;
  return st.nextSeat == null;
}

function advanceStreet(st, board) {
  st.street += 1;
  st.boardDealt = STREET_BOARD[st.street] != null ? STREET_BOARD[st.street] : st.boardDealt;
  for (let i = 0; i < st.N; i++) { st.streetContrib[i] = 0; st.acted[i] = false; }
  st.toCall = 0;
  st.lastRaiseSize = 1;
  st.aggressor = null;
  st.nextSeat = findNext(st, 0); // postflop: first live seat clockwise from button
}

function snapshot(st, meta) {
  return Object.assign({
    stacks: st.stacks.slice(),
    committed: st.committed.slice(),
    streetContrib: st.streetContrib.slice(),
    folded: st.folded.slice(),
    allin: st.allin.slice(),
    pot: st.pot,
    street: st.street,
    boardDealt: st.boardDealt,
    toCall: st.toCall,
    nextSeat: st.nextSeat,
    handOver: st.handOver,
  }, meta);
}

function posLabel(setup, seat) {
  return (setup.seats[seat] && setup.seats[seat].pos) || `P${seat + 1}`;
}
function nameOrPos(setup, seat) {
  const s = setup.seats[seat];
  return (s && s.name) ? s.name : posLabel(setup, seat);
}

// Build human-readable action description (computed AFTER apply, using pre-state values passed in).
function describeAction(setup, action, pre) {
  const who = nameOrPos(setup, action.seat);
  // PokerNow hands hold amounts in cents (real money — 2 decimals); chips otherwise.
  const m = (x) => setup.cents ? (x / 100).toFixed(2) : Math.round(x * 100) / 100;
  switch (action.type) {
    case 'fold': return `${who} folds`;
    case 'check': return `${who} checks`;
    case 'call': {
      const owe = pre.toCall - pre.streetContrib;
      const amt = Math.min(Math.max(owe, 0), pre.stack);
      return `${who} calls ${m(amt)}`;
    }
    case 'bet': return `${who} bets ${m(action.amount)}`;
    case 'raise': return `${who} raises to ${m(action.amount)}`;
    default: return who;
  }
}

// Full replay → ordered frames for playback. When runTwice is set the board is
// NOT auto-dealt at the all-in — the replayer runs each board out itself.
function buildReplay(setup, actions, board, runTwice) {
  const st = initState(setup);
  const frames = [];
  frames.push(snapshot(st, {
    kind: 'init',
    label: 'Blinds posted',
    actingSeat: null,
    streetName: 'Preflop',
  }));

  for (const act of actions) {
    // Deal streets up to this action's street.
    while (st.street < (act.street || 0) && !st.handOver) {
      advanceStreet(st, board);
      frames.push(snapshot(st, {
        kind: 'deal',
        label: `${STREET_NAMES[st.street]} dealt`,
        actingSeat: null,
        streetName: STREET_NAMES[st.street],
      }));
    }
    const pre = {
      toCall: st.toCall,
      streetContrib: st.streetContrib[act.seat],
      stack: st.stacks[act.seat],
    };
    const label = describeAction(setup, act, pre);
    applyAction(st, act);
    frames.push(snapshot(st, {
      kind: 'action',
      label,
      actingSeat: act.seat,
      actionType: act.type,
      streetName: STREET_NAMES[st.street],
    }));
  }

  // Run out remaining board if multiple players are all-in (no more actions).
  if (!runTwice && !st.handOver && liveActorCount(st) <= 1 && activeCount(st) >= 2) {
    while (st.boardDealt < 5 && board.length >= STREET_BOARD[st.street + 1]) {
      advanceStreet(st, board);
      frames.push(snapshot(st, {
        kind: 'deal',
        label: `${STREET_NAMES[st.street]} dealt`,
        actingSeat: null,
        streetName: STREET_NAMES[st.street],
      }));
    }
  }

  return frames;
}

// Live state for the builder (whose turn, legal options, completion).
function liveState(setup, actions, board) {
  const st = initState(setup);
  for (const act of actions) {
    while (st.street < (act.street || 0) && !st.handOver) advanceStreet(st, board);
    applyAction(st, act);
    if (st.handOver) break;
  }
  return st;
}

export const ReplayEngine = {
  POS_BY_COUNT, STREET_NAMES, STREET_BOARD,
  positionsForCount, blindSeats,
  initState, applyAction, advanceStreet, streetComplete,
  legalOptions, liveState, buildReplay,
  activeCount, liveActorCount, needsAction, findNext,
  posLabel, nameOrPos,
};
