// Replayer UI — build a hand, then step through it like a hand-history replayer.
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import * as PokerEngine from './pokerEngine.js';
import { ReplayEngine } from './replayerEngine.js';
import { PlayingCard, CardBack } from './Cards.jsx';
import { CardPicker } from './Pickers.jsx';
import { ShareModal } from './ShareModal.jsx';
import { useFlash } from './hooks.js';
import { encodeReplay, decodeReplay } from './replayShare.js';

// All 169 starting-hand keys, for unknown villains (treated as a random range).
const ALL_RANGE_KEYS = (() => {
  const R = ['A','K','Q','J','T','9','8','7','6','5','4','3','2'];
  const out = [];
  for (let i = 0; i < 13; i++) {
    for (let j = 0; j < 13; j++) {
      if (i === j) out.push(R[i] + R[j]);
      else if (i < j) out.push(R[i] + R[j] + 's');
      else out.push(R[j] + R[i] + 'o');
    }
  }
  return out;
})();

// Seats around the felt with EQUAL ARC LENGTH spacing (same approach as the
// main calculator table) so large plates never bunch up / overlap. Seat 0
// (BTN) sits at the bottom, near the viewer.
function replaySeatPositions(n, compact, cfg) {
  const cx = 50, cy = 50;
  const rx_pct = cfg ? cfg.rx : compact ? 36 : 44, ry_pct = cfg ? cfg.ry : compact ? 42 : 35;
  const STAGE_W = cfg ? cfg.w : compact ? 460 : 1080, STAGE_H = cfg ? cfg.h : compact ? 640 : 600;
  const rxPx = (rx_pct / 100) * STAGE_W;
  const ryPx = (ry_pct / 100) * STAGE_H;
  const SAMPLES = 4000;
  const dtheta = (2 * Math.PI) / SAMPLES;
  const startAngle = Math.PI / 2; // bottom
  const cumLen = [0];
  let total = 0;
  for (let i = 1; i <= SAMPLES; i++) {
    const theta = startAngle + i * dtheta;
    const dx = -rxPx * Math.sin(theta);
    const dy = ryPx * Math.cos(theta);
    total += Math.sqrt(dx * dx + dy * dy) * dtheta;
    cumLen.push(total);
  }
  function thetaAtArc(s) {
    let lo = 0, hi = SAMPLES;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cumLen[m] < s) lo = m + 1; else hi = m; }
    return startAngle + lo * dtheta;
  }
  const out = [];
  for (let k = 0; k < n; k++) {
    const theta = thetaAtArc((k / n) * total);
    out.push({ x: cx + rx_pct * Math.cos(theta), y: cy + ry_pct * Math.sin(theta) });
  }
  return out;
}

// keeps whole numbers clean. Up to 2 decimals.
function fmt(n) {
  if (n == null || isNaN(n)) return '0';
  const r = Math.round(Number(n) * 100) / 100;
  return String(r);
}

// PokerNow hands carry amounts in cents (real money — show 2 decimals);
// hand-built replays are in whole chips.
function fmtMoney(n, setup) {
  if (setup && setup.cents) return (Number(n) / 100).toFixed(2);
  return fmt(n);
}

// Equity among non-folded players. Every active player must have known cards
function computeFrameEquity(setup, board, frame) {
  const seats = setup.seats;
  const active = [];
  for (let i = 0; i < seats.length; i++) if (!frame.folded[i]) active.push(i);
  if (active.length <= 1) {
    const out = {};
    if (active.length === 1) out[active[0]] = { equity: 100, win: 100, tie: 0 };
    return out;
  }
  const visBoard = board.slice(0, frame.boardDealt);
  let ok = true;
  const playersArr = seats.map((s, i) => {
    if (frame.folded[i]) return null;
    if (s.cards && s.cards.length === 2) return { kind: 'hand', hand: s.cards };
    ok = false;
    return null;
  });
  if (!ok) return {};
  try {
    const res = PokerEngine.calculate(playersArr, visBoard, { sims: 12000 });
    return res.perPlayer;
  } catch (e) {
    return {};
  }
}

function useFrameEquity(setup, board, frame) {
  const cacheRef = useRef({});
  const [eq, setEq] = useState(null);
  const key = useMemo(() => {
    if (!frame) return '';
    const act = [];
    for (let i = 0; i < setup.seats.length; i++) if (!frame.folded[i]) act.push(i);
    const vis = board.slice(0, frame.boardDealt).map(c => c.v + c.s).join('');
    return act.join('-') + ':' + vis;
  }, [frame, board, setup]);

  useEffect(() => {
    if (!frame) { setEq(null); return; }
    if (cacheRef.current[key]) { setEq(cacheRef.current[key]); return; }
    setEq(null);
    let cancelled = false;
    const t = setTimeout(() => {
      const res = computeFrameEquity(setup, board, frame);
      if (cancelled) return;
      cacheRef.current[key] = res;
      setEq(res);
    }, 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [key]);

  return eq;
}

// Local stage scaler (keeps the table a fixed canvas, letterboxed).
// The felt is 1060x600, but seats (cards + plates) poke past its top/bottom
// edge. Scale to a taller canvas so those overhangs never get clipped.
// desktop landscape stage vs compact portrait stage for narrow (phone) containers
const DESKTOP_STAGE = { w: 1080, feltH: 600, padY: 36 };
const COMPACT_STAGE = { w: 460, feltH: 640, padY: 30 };

function ReplayStage({ children }) {
  const ref = useRef(null);
  const [scale, setScale] = useState(1);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    function update() {
      const el = ref.current;
      if (!el || !el.parentElement) return;
      const w = el.parentElement.clientWidth - 8;
      const h = el.parentElement.clientHeight - 8;
      const c = w > 0 && w < 600;
      const S = c ? COMPACT_STAGE : DESKTOP_STAGE;
      const H = S.feltH + S.padY * 2;
      const s = Math.min(w / S.w, h / H, 1.15);
      setCompact(c);
      setScale(s > 0 ? s : 1);
    }
    update();
    const ro = new ResizeObserver(update);
    if (ref.current && ref.current.parentElement) ro.observe(ref.current.parentElement);
    window.addEventListener('resize', update);
    return () => { ro.disconnect(); window.removeEventListener('resize', update); };
  }, []);
  const S = compact ? COMPACT_STAGE : DESKTOP_STAGE;
  const H = S.feltH + S.padY * 2;
  return (
    <div ref={ref} className="replay-stage-scaler" style={{ width: Math.floor(S.w * scale), height: Math.floor(H * scale) }}>
      <div className="replay-stage-inner" style={{ width: S.w, height: H, transform: `scale(${scale})` }}>
        {children(compact, S)}
      </div>
    </div>
  );
}

// Chip stack glyph for bets in front of players.
function BetChip({ amount, money }) {
  if (!amount) return null;
  return (
    <div className="replay-bet">
      <span className="replay-bet-dot" />
      {(money || fmt)(amount)}
    </div>
  );
}

function ReplaySeat({ pos, seat, setup, frame, equity, isActing, isWinner, resultWon, twice, cardSize = 'mdr' }) {
  const s = setup.seats[seat];
  const folded = frame.folded[seat];
  const allin = frame.allin[seat];
  const known = s.cards && s.cards.length === 2;
  const eqPct = equity && equity[seat] ? equity[seat].equity : null;
  const money = (n) => fmtMoney(n, setup);
  // When a result is on screen, swap the equity bar for the amount won; hide
  // equity entirely while the boards are being run out (it would be misleading).
  const wonAmt = resultWon && resultWon[seat] ? resultWon[seat] : 0;
  const showResult = !!resultWon;
  const showEq = !folded && eqPct != null && !showResult && !twice;
  return (
    <div
      className={'replay-seat' + (folded ? ' folded' : '') + (isActing ? ' acting' : '') + (isWinner ? ' winner' : '')}
      style={{ left: pos.x + '%', top: pos.y + '%' }}
    >
      <div className="replay-seat-cards">
        {known
          ? s.cards.map((c, i) => <PlayingCard key={i} card={c} size={cardSize} dim={folded} />)
          : <><CardBack size={cardSize} /><CardBack size={cardSize} /></>}
      </div>
      <div className="replay-seat-plate">
        <div className="replay-seat-top">
          <span className="replay-seat-pos">{s.pos}</span>
          <span className="replay-seat-name">{s.name || `Player ${seat + 1}`}</span>
        </div>
        <div className="replay-seat-stack">
          {allin && !folded ? <span className="replay-allin">ALL-IN</span> : null}
          <span className="replay-stack-num">{money(frame.stacks[seat])}</span>
        </div>
        {showResult && wonAmt > 0 && (
          <div className="replay-seat-win">{'+$' + money(wonAmt)}</div>
        )}
        {showEq && (
          <div className="replay-seat-eq">
            <div className="replay-eq-bar"><div className="replay-eq-fill" style={{ width: eqPct + '%' }} /></div>
            <span className="replay-eq-num">{eqPct.toFixed(0)}%</span>
          </div>
        )}
        {seat === 0 && <span className="replay-dealer-btn" title="Dealer">D</span>}
      </div>
      <BetChip amount={frame.streetContrib[seat]} money={money} />
    </div>
  );
}

const STREET_OF = { 3: 'Flop', 4: 'Turn', 5: 'River' };
// Run-it-twice playback: only after the action is done, reveal two boards and
// run them one after the other; tag each result frame with that board's payout.
function buildRunTwiceFrames(base, runResults) {
  const shared = base.boardDealt;
  const steps = [3, 4, 5].filter(c => c > shared);
  const mk = (extra) => Object.assign({}, base, { actingSeat: null, kind: 'deal', twice: true }, extra);
  const frames = [];
  frames.push(mk({ run1Dealt: shared, run2Dealt: shared, activeRun: 0, streetName: 'Run it twice', label: 'Running it twice' }));
  for (const c of steps) frames.push(mk({ run1Dealt: c, run2Dealt: shared, activeRun: 1, streetName: STREET_OF[c], label: `Run 1 · ${STREET_OF[c]}` }));
  frames.push(mk({ run1Dealt: 5, run2Dealt: shared, activeRun: 1, kind: 'result', runResult: runResults[0], streetName: 'Run 1', label: 'Run 1 result' }));
  for (const c of steps) frames.push(mk({ run1Dealt: 5, run2Dealt: c, activeRun: 2, streetName: STREET_OF[c], label: `Run 2 · ${STREET_OF[c]}` }));
  frames.push(mk({ run1Dealt: 5, run2Dealt: 5, activeRun: 2, kind: 'result', runResult: runResults[1], streetName: 'Run 2', label: 'Run 2 result' }));
  return frames;
}

// One community-card row. `dim` marks a run that hasn't been dealt out yet.
function BoardRow({ cards, vis, size, label, dim }) {
  const small = size !== 'lgr';
  const cls = 'replay-board' + (small ? ' small' : '') + (size === 'md' || size === 'bd' ? ' sz-' + size : '') + (dim ? ' pending' : '');
  return (
    <div className={cls}>
      {label && <span className="replay-run-tag">{label}</span>}
      {Array.from({ length: 5 }).map((_, i) => (
        i < vis && cards[i]
          ? <PlayingCard key={i} card={cards[i]} size={size} />
          : <div key={i} className="replay-board-empty" />
      ))}
    </div>
  );
}

function ReplayTable(props) {
  return (
    <ReplayStage>
      {(compact, S) => <ReplayTableBody {...props} compact={compact} S={S} />}
    </ReplayStage>
  );
}

function ReplayTableBody({ setup, board, board2, frame, equity, winners, resultWon, compact, S }) {
  const positions = useMemo(() => replaySeatPositions(setup.seats.length, compact), [setup.seats.length, compact]);
  const crowded = compact && setup.seats.length >= 7;
  return (
    <div
      className={'replay-table' + (compact ? ' compact' : '') + (crowded ? ' crowded' : '')}
      style={{ top: S.padY, width: S.w, height: S.feltH }}
    >
        <div className="felt-rim" />
        <div className="felt" />
        <div className="replay-center">
          <div className="replay-pot">
            <span className="replay-pot-label">POT</span>
            <span className="replay-pot-val">{fmtMoney(frame.pot, setup)}</span>
          </div>
          {frame.twice ? (
            <div className="replay-boards-twice">
              <BoardRow cards={board} vis={frame.run1Dealt} size={compact ? (crowded ? 'bd' : 'md') : 'mdr'} label="RUN 1" />
              <BoardRow cards={board2} vis={frame.run2Dealt} size={compact ? (crowded ? 'bd' : 'md') : 'mdr'} label="RUN 2" dim={frame.activeRun < 2} />
            </div>
          ) : (
            <BoardRow cards={board} vis={frame.boardDealt} size={compact ? (crowded ? 'bd' : 'md') : 'lgr'} />
          )}
          <div className="replay-street-tag">{frame.streetName}</div>
        </div>
        {positions.map((pos, k) => (
          <ReplaySeat
            key={k}
            pos={pos}
            seat={k}
            setup={setup}
            frame={frame}
            equity={equity}
            isActing={frame.actingSeat === k}
            isWinner={winners && winners.includes(k)}
            resultWon={resultWon}
            twice={!!frame.twice}
            cardSize={compact ? (crowded ? 'sm' : 'md') : 'mdr'}
          />
        ))}
    </div>
  );
}

// Transport controls + action log.
function TransportBar({ idx, total, frame, onFirst, onPrev, onNext, onLast }) {
  return (
    <div className="replay-transport">
      <div className="replay-action-readout">
        <span className={'replay-action-chip ' + (frame.kind === 'deal' ? 'deal' : frame.kind === 'init' ? 'init' : 'act')}>
          {frame.streetName}
        </span>
        <span className="replay-action-label">{frame.label}</span>
      </div>
      <div className="replay-controls">
        <button className="replay-ctrl" onClick={onFirst} disabled={idx === 0} aria-label="First" title="First (Home)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5H5v14h2z" /><path d="M18 5v14l-9-7z" /></svg>
        </button>
        <button className="replay-ctrl" onClick={onPrev} disabled={idx === 0} aria-label="Back" title="Back (←)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15 5v14l-9-7z" /></svg>
        </button>
        <div className="replay-step-count">{idx + 1} <span>/ {total}</span></div>
        <button className="replay-ctrl" onClick={onNext} disabled={idx >= total - 1} aria-label="Forward" title="Forward (→)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M9 5v14l9-7z" /></svg>
        </button>
        <button className="replay-ctrl" onClick={onLast} disabled={idx >= total - 1} aria-label="Last" title="Last (End)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17 5h2v14h-2z" /><path d="M6 5v14l9-7z" /></svg>
        </button>
      </div>
    </div>
  );
}

// Card-select overlay (wraps CardPicker for hole cards / board deal).
function CardSelectOverlay({ title, maxCards, usedCards, onConfirm, onClose, onClear }) {
  const [selected, setSelected] = useState([]);
  function pick(c) {
    setSelected(prev => {
      const ix = prev.findIndex(x => x.v === c.v && x.s === c.s);
      if (ix >= 0) { const n = prev.slice(); n.splice(ix, 1); return n; }
      if (prev.length < maxCards) return [...prev, c];
      return prev;
    });
  }
  return (
    <div className="picker-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <CardPicker
        title={title}
        usedCards={usedCards}
        selected={selected}
        maxCards={maxCards}
        onPick={pick}
        onConfirm={() => selected.length === maxCards && onConfirm(selected)}
        onClear={() => { setSelected([]); if (onClear) onClear(); }}
        onClose={onClose}
      />
    </div>
  );
}

// Live felt preview for the hand builder.
const BT_STAGE = { w: 660, h: 400, rx: 40, ry: 36 };
const BT_STAGE_COMPACT = { w: 400, h: 470, rx: 36, ry: 40 };

function BuilderTable({ setup, board, live, actingSeat, street, onSeatClick }) {
  const ref = useRef(null);
  const [scale, setScale] = useState(1);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    function update() {
      const el = ref.current;
      if (!el || !el.parentElement) return;
      const w = el.parentElement.clientWidth;
      const c = w > 0 && w < 520;
      const S = c ? BT_STAGE_COMPACT : BT_STAGE;
      const s = Math.min(w / S.w, 1);
      setCompact(c);
      setScale(s > 0 ? s : 1);
    }
    update();
    const ro = new ResizeObserver(update);
    if (ref.current && ref.current.parentElement) ro.observe(ref.current.parentElement);
    window.addEventListener('resize', update);
    return () => { ro.disconnect(); window.removeEventListener('resize', update); };
  }, []);
  const S = compact ? BT_STAGE_COMPACT : BT_STAGE;
  const n = setup.seats.length;
  const positions = useMemo(
    () => replaySeatPositions(n, compact, { rx: S.rx, ry: S.ry, w: S.w, h: S.h }),
    [n, compact, S.rx, S.ry, S.w, S.h]
  );
  return (
    <div ref={ref} className="bt-scaler" style={{ width: Math.floor(S.w * scale), height: Math.floor(S.h * scale) }}>
      <div className="bt-inner" style={{ width: S.w, height: S.h, transform: `scale(${scale})` }}>
        <div className={'bt-table' + (compact ? ' compact' : '')} style={{ width: S.w, height: S.h }}>
          <div className="bt-rim" />
          <div className="bt-felt" />
          <div className="bt-center">
            <div className="bt-pot"><span>POT</span><b>{live ? fmt(live.pot) : 0}</b></div>
            {board.length > 0 && (
              <div className="bt-board">{board.map((c, i) => <PlayingCard key={i} card={c} size="xs" />)}</div>
            )}
            <div className="bt-street">{ReplayEngine.STREET_NAMES[street]}</div>
          </div>
          {positions.map((pos, i) => {
            const seat = setup.seats[i];
            const folded = live ? live.folded[i] : false;
            const allin = live ? live.allin[i] : false;
            const stack = live ? live.stacks[i] : seat.stack;
            const bet = live ? live.streetContrib[i] : 0;
            const known = seat.cards && seat.cards.length === 2;
            return (
              <div key={i}
                className={'bt-seat' + (folded ? ' folded' : '') + (actingSeat === i ? ' acting' : '')}
                style={{ left: pos.x + '%', top: pos.y + '%' }}>
                <button type="button" className="bt-plate" disabled={!onSeatClick}
                  onClick={onSeatClick ? () => onSeatClick(i) : undefined}
                  title={onSeatClick ? 'Set hole cards' : undefined}>
                  <span className="bt-cards">
                    {known
                      ? seat.cards.map((c, k) => <PlayingCard key={k} card={c} size="xs" dim={folded} />)
                      : <><CardBack size="xs" /><CardBack size="xs" /></>}
                  </span>
                  <span className="bt-info">
                    <span className="bt-top"><span className="bt-pos">{seat.pos}</span><span className="bt-name">{seat.name || `P${i + 1}`}</span></span>
                    <span className="bt-stack">{allin && !folded ? 'ALL-IN' : fmt(stack)}</span>
                  </span>
                </button>
                {bet > 0 && !folded && <span className="bt-bet">{fmt(bet)}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Builder live-state: process actions street by street up to currentStreet.
function builderState(setup, actions, board, currentStreet) {
  const st = ReplayEngine.initState(setup);
  let ai = 0;
  for (let s = 0; s <= currentStreet; s++) {
    while (ai < actions.length && (actions[ai].street || 0) === s) {
      ReplayEngine.applyAction(st, actions[ai]);
      ai++;
      if (st.handOver) return st;
    }
    if (s < currentStreet && !st.handOver) ReplayEngine.advanceStreet(st, board);
  }
  return st;
}

const DEFAULT_BB = 2, DEFAULT_SB = 1;

function HandBuilder({ onComplete, onCancel }) {
  const [phase, setPhase] = useState('setup'); // 'setup' | 'actions'
  const [sb, setSb] = useState(String(DEFAULT_SB));
  const [bb, setBb] = useState(String(DEFAULT_BB));
  const [ante, setAnte] = useState('0');
  const [count, setCount] = useState(6);
  const [seats, setSeats] = useState(() => makeSeats(6, DEFAULT_BB));
  const [cardTarget, setCardTarget] = useState(null); // seat index for hole-card pick
  const [actions, setActions] = useState([]);
  const [board, setBoard] = useState([]);
  const [currentStreet, setCurrentStreet] = useState(0);
  const [dealing, setDealing] = useState(false);
  const [betAmt, setBetAmt] = useState('');

  function makeSeatsLabeled(n) {
    return makeSeats(n, parseFloat(bb) || DEFAULT_BB);
  }
  function changeCount(n) {
    setCount(n);
    setSeats(prev => {
      const labels = ReplayEngine.positionsForCount(n);
      const next = makeSeats(n, parseFloat(bb) || DEFAULT_BB);
      // preserve existing names/stacks/cards where possible
      for (let i = 0; i < n; i++) {
        if (prev[i]) {
          next[i].name = prev[i].name;
          next[i].stack = prev[i].stack;
          next[i].cards = prev[i].cards;
        }
        next[i].pos = labels[i];
      }
      return next;
    });
  }

  const usedCards = useMemo(() => {
    const out = [];
    seats.forEach(s => { if (s.cards) out.push(...s.cards); });
    out.push(...board);
    return out;
  }, [seats, board]);

  const missingCount = seats.filter(s => !(s.cards && s.cards.length === 2)).length;

  function setupSetup() {
    // re-label positions in case bb changed default stacks
    const labels = ReplayEngine.positionsForCount(count);
    setSeats(prev => prev.map((s, i) => ({ ...s, pos: labels[i] })));
  }

  function startActions() {
    setupSetup();
    setActions([]);
    setBoard(board.slice(0, 0)); // reset board; keep hole cards
    setCurrentStreet(0);
    setPhase('actions');
  }

  // live betting state for action phase
  const setup = useMemo(() => ({
    sb: parseFloat(sb) || 0,
    bb: parseFloat(bb) || 0,
    ante: parseFloat(ante) || 0,
    seats: seats.map(s => ({ ...s, stack: parseFloat(s.stack) || 0 })),
  }), [sb, bb, ante, seats]);

  const live = useMemo(() => {
    if (phase !== 'actions') return null;
    try { return builderState(setup, actions, board, currentStreet); }
    catch (e) { return null; }
  }, [phase, setup, actions, board, currentStreet]);

  const liveSetup = useMemo(() => {
    if (phase !== 'setup') return null;
    try { return ReplayEngine.initState(setup); }
    catch { return null; }
  }, [phase, setup]);

  const opts = live && !live.handOver ? ReplayEngine.legalOptions(live, setup) : null;
  const streetDone = live && (live.handOver || live.nextSeat == null);
  const handDone = live && (live.handOver || (currentStreet === 3 && live.nextSeat == null));
  const needsDeal = live && !live.handOver && live.nextSeat == null && currentStreet < 3 && ReplayEngine.activeCount(live) > 1;

  function pushAction(type, amount) {
    if (!opts) return;
    setActions(prev => [...prev, { seat: opts.seat, type, amount: amount || 0, street: currentStreet }]);
    setBetAmt('');
  }
  function undo() {
    if (actions.length === 0) return;
    const n = actions.slice(0, -1);
    // if removing an action drops us to a prior street, step back the street + board
    const newStreet = n.length ? n[n.length - 1].street : 0;
    if (newStreet < currentStreet) {
      setCurrentStreet(newStreet);
      setBoard(prev => prev.slice(0, newStreet ? newStreet + 2 : 0));
    }
    setActions(n);
  }
  function dealNext() {
    const need = currentStreet === 0 ? 3 : 1;
    setDealing({ need });
  }
  function confirmDeal(cards) {
    setBoard(prev => [...prev, ...cards]);
    setCurrentStreet(s => s + 1);
    setDealing(false);
  }

  function finish() {
    onComplete(setup, actions, board);
  }

  // Quick bet sizes
  function quickSizes() {
    if (!opts) return [];
    const out = [];
    const potNow = opts.pot;
    if (opts.canBet) {
      [['½ pot', Math.round(potNow * 0.5)], ['¾ pot', Math.round(potNow * 0.75)], ['Pot', potNow]].forEach(([lbl, amt]) => {
        const t = Math.max(opts.minBet, Math.min(amt, opts.maxTo));
        out.push([lbl, t]);
      });
    } else if (opts.canRaise) {
      const callTotal = opts.toCall;
      const potAfterCall = potNow + opts.callAmt;
      [['½ pot', Math.round(callTotal + potAfterCall * 0.5)], ['¾ pot', Math.round(callTotal + potAfterCall * 0.75)], ['Pot', Math.round(callTotal + potAfterCall)]].forEach(([lbl, amt]) => {
        const t = Math.max(opts.minRaiseTo, Math.min(amt, opts.maxTo));
        out.push([lbl, t]);
      });
    }
    out.push(['All-in', opts.maxTo]);
    return out;
  }

  // render
  if (phase === 'setup') {
    return (
      <div className="builder-layout">
      <div className="builder-table-col">
        <BuilderTable setup={setup} board={[]} live={liveSetup} actingSeat={null} street={0}
          onSeatClick={(i) => setCardTarget(i)} />
      </div>
      <div className="builder">
        <div className="builder-head">
          <div>
            <div className="builder-title">New hand</div>
            <div className="builder-sub">Set the stakes, seats, and known cards. You'll enter the action next.</div>
          </div>
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        </div>

        <div className="builder-section">
          <div className="builder-section-title">Stakes</div>
          <div className="builder-stakes">
            <label className="builder-field"><span>Small blind</span>
              <input type="number" min="0" value={sb} onChange={e => setSb(e.target.value)} /></label>
            <label className="builder-field"><span>Big blind</span>
              <input type="number" min="0" value={bb} onChange={e => setBb(e.target.value)} /></label>
            <label className="builder-field"><span>Ante <em>(opt)</em></span>
              <input type="number" min="0" value={ante} onChange={e => setAnte(e.target.value)} /></label>
          </div>
        </div>

        <div className="builder-section">
          <div className="builder-section-title">Players</div>
          <div className="builder-count">
            {[2,3,4,5,6,7,8,9].map(n => (
              <button key={n} className={'builder-count-btn ' + (count === n ? 'active' : '')} onClick={() => changeCount(n)}>{n}</button>
            ))}
          </div>
          <div className="builder-seats">
            {seats.map((s, i) => (
              <div className="builder-seat-row" key={i}>
                <span className="builder-seat-pos">{ReplayEngine.positionsForCount(count)[i]}</span>
                <input
                  className="builder-seat-name"
                  placeholder={`Player ${i + 1}`}
                  value={s.name}
                  maxLength={16}
                  onChange={e => setSeats(prev => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                />
                <label className="builder-seat-stack">
                  <span>Stack</span>
                  <input
                    type="number" min="0" value={s.stack}
                    onChange={e => setSeats(prev => prev.map((x, j) => j === i ? { ...x, stack: e.target.value } : x))}
                  />
                </label>
                <span className="builder-cards-slot">
                  <button
                    className={'builder-cards-btn' + (s.cards ? ' has' : ' missing')}
                    onClick={() => setCardTarget(i)}
                  >
                    {s.cards
                      ? s.cards.map((c, k) => <PlayingCard key={k} card={c} size="xs" />)
                      : <span className="builder-cards-empty">+ cards</span>}
                  </button>
                  {s.cards && (
                    <button className="builder-cards-clear" onClick={() => setSeats(prev => prev.map((x, j) => j === i ? { ...x, cards: null } : x))} aria-label="Clear cards">×</button>
                  )}
                </span>
              </div>
            ))}
          </div>
          <div className="builder-hint">Hole cards are optional - seats without cards show card backs and sit out of the equity readout.</div>
        </div>

        <div className="builder-foot">
          {missingCount > 0 && (
            <span className="builder-foot-note">{missingCount} player{missingCount === 1 ? '' : 's'} without cards</span>
          )}
          <button className="btn btn-primary" onClick={startActions}>Enter action →</button>
        </div>

        {cardTarget != null && (
          <CardSelectOverlay
            title={`${seats[cardTarget].pos} hole cards`}
            maxCards={2}
            usedCards={usedCards.filter(c => !(seats[cardTarget].cards || []).some(x => x.v === c.v && x.s === c.s))}
            onConfirm={(cards) => { setSeats(prev => prev.map((x, j) => j === cardTarget ? { ...x, cards } : x)); setCardTarget(null); }}
            onClose={() => setCardTarget(null)}
          />
        )}
      </div>
      </div>
    );
  }

  // phase === 'actions'
  return (
    <div className="builder-layout">
    <div className="builder-table-col">
      <BuilderTable setup={setup} board={board} live={live} actingSeat={opts ? opts.seat : null} street={currentStreet} />
    </div>
    <div className="builder builder-actions">
      <div className="builder-head">
        <div>
          <div className="builder-title">Enter action · {ReplayEngine.STREET_NAMES[currentStreet]}</div>
          <div className="builder-sub">{actions.length} action{actions.length === 1 ? '' : 's'} recorded · pot {live ? fmt(live.pot) : 0}</div>
        </div>
        <div className="builder-head-btns">
          <button className="btn btn-ghost" onClick={() => setPhase('setup')}>← Setup</button>
          <button className="btn btn-ghost" onClick={undo} disabled={actions.length === 0}>Undo</button>
        </div>
      </div>

      <div className="builder-board-strip">
        <span className="builder-board-label">Board</span>
        {board.length === 0 && <span className="builder-board-empty">- preflop -</span>}
        {board.map((c, i) => <PlayingCard key={i} card={c} size="sm" />)}
      </div>

      {handDone ? (
        <div className="builder-finish">
          <div className="builder-finish-title">Hand complete</div>
          <div className="builder-finish-sub">
            {ReplayEngine.activeCount(live) === 1
              ? 'Everyone folded to the last player standing.'
              : 'Action reached showdown.'}
          </div>
          <div className="builder-finish-actions">
            <button className="btn btn-ghost" onClick={() => setPhase('setup')}>Edit setup</button>
            <button className="btn btn-primary" onClick={finish}>Watch replay →</button>
          </div>
        </div>
      ) : needsDeal ? (
        <div className="builder-deal">
          <div className="builder-deal-msg">Betting complete for the {ReplayEngine.STREET_NAMES[currentStreet].toLowerCase()}.</div>
          <button className="btn btn-primary" onClick={dealNext}>
            Deal {ReplayEngine.STREET_NAMES[currentStreet + 1]} {currentStreet === 0 ? '(3 cards)' : '(1 card)'}
          </button>
        </div>
      ) : opts ? (
        <div className="builder-action-panel">
          <div className="builder-acting">
            Action on <strong>{ReplayEngine.nameOrPos(setup, opts.seat)}</strong>
            {setup.seats[opts.seat].name ? <span className="builder-acting-pos">{setup.seats[opts.seat].pos}</span> : null}
            {opts.toCall > opts.streetContrib && <span className="builder-tocall">to call {fmt(opts.callAmt)}</span>}
          </div>
          <div className="builder-action-btns">
            <button className="act-btn act-fold" onClick={() => pushAction('fold')}>Fold</button>
            {opts.canCheck
              ? <button className="act-btn act-check" onClick={() => pushAction('check')}>Check</button>
              : <button className="act-btn act-call" onClick={() => pushAction('call')}>Call {fmt(opts.callAmt)}</button>}
            {(opts.canBet || opts.canRaise) && (
              <div className="builder-bet-group">
                <div className="builder-quick">
                  {quickSizes().map(([lbl, amt]) => (
                    <button key={lbl} className="quick-btn" onClick={() => setBetAmt(String(amt))}>{lbl}<em>{fmt(amt)}</em></button>
                  ))}
                </div>
                <div className="builder-bet-commit">
                  <input
                    type="number"
                    className="builder-bet-input"
                    placeholder={opts.canBet ? `bet ≥ ${opts.minBet}` : `raise to ≥ ${opts.minRaiseTo}`}
                    value={betAmt}
                    min={opts.canBet ? opts.minBet : opts.minRaiseTo}
                    max={opts.maxTo}
                    onChange={e => setBetAmt(e.target.value)}
                  />
                  <button
                    className="act-btn act-raise"
                    disabled={!betAmt || parseFloat(betAmt) < (opts.canBet ? opts.minBet : opts.minRaiseTo)}
                    onClick={() => {
                      const amt = Math.min(parseFloat(betAmt), opts.maxTo);
                      pushAction(opts.canBet ? 'bet' : 'raise', amt);
                    }}
                  >
                    {opts.canBet ? 'Bet' : 'Raise to'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="builder-deal"><div className="builder-deal-msg">…</div></div>
      )}

      <ActionLog setup={setup} actions={actions} />

      <div className="builder-foot">
        <button className="btn btn-ghost" onClick={onCancel}>Discard</button>
        <button className="btn btn-primary" onClick={finish} disabled={actions.length === 0}>Finish & replay →</button>
      </div>

      {dealing && (
        <CardSelectOverlay
          title={`Deal the ${ReplayEngine.STREET_NAMES[currentStreet + 1].toLowerCase()}`}
          maxCards={dealing.need}
          usedCards={usedCards}
          onConfirm={confirmDeal}
          onClose={() => setDealing(false)}
        />
      )}
    </div>
    </div>
  );
}

function ActionLog({ setup, actions }) {
  if (actions.length === 0) return null;
  const byStreet = {};
  actions.forEach(a => { (byStreet[a.street] = byStreet[a.street] || []).push(a); });
  return (
    <div className="builder-log">
      {Object.keys(byStreet).map(st => (
        <div key={st} className="builder-log-street">
          <span className="builder-log-name">{ReplayEngine.STREET_NAMES[st]}</span>
          <div className="builder-log-items">
            {byStreet[st].map((a, i) => (
              <span key={i} className="builder-log-item">
                {ReplayEngine.nameOrPos(setup, a.seat)} {a.type}{(a.type === 'bet' || a.type === 'raise') ? ' ' + a.amount : ''}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function makeSeats(n, bb) {
  const labels = ReplayEngine.positionsForCount(n);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ name: '', stack: String(100 * (bb || 2)), cards: null, pos: labels[i] });
  }
  return out;
}

// Top-level: builder → playback.
export function ReplayerView({ initialHand, onExit, onSaveToHistory, onSetFavorite, userMenu, themeToggle, historyDrawer, shareShort }) {
  const [hand, setHand] = useState(initialHand || null); // { setup, actions, board }
  const [idx, setIdx] = useState(0);
  const [savedId, setSavedId] = useState((initialHand && initialHand.savedId) || null);
  const [favorited, setFavorited] = useState(!!(initialHand && initialHand.favorited));
  const savingFav = useRef(false);
  const [toast, flashToast] = useFlash(2600);
  const [showShare, setShowShare] = useState(false);
  const [shareUrl, setShareUrl] = useState('');

  const frames = useMemo(() => {
    if (!hand) return [];
    const twice = !!(hand.board2 && hand.runResults);
    try {
      const base = ReplayEngine.buildReplay(hand.setup, hand.actions, hand.board, twice);
      if (twice) return base.concat(buildRunTwiceFrames(base[base.length - 1], hand.runResults));
      return base;
    } catch (e) { return []; }
  }, [hand]);

  const frame = frames[idx] || null;
  const equity = useFrameEquity(hand ? hand.setup : { seats: [] }, hand ? hand.board : [], frame);

  // Amount won shown on this frame: per-board on a run-twice result frame,
  // otherwise the total on a single-board hand's final frame.
  const resultWon = useMemo(() => {
    if (!frame) return null;
    if (frame.runResult) return frame.runResult.won;
    if (!hand.board2 && hand.won && idx === frames.length - 1) return hand.won;
    return null;
  }, [frame, idx, frames.length, hand]);

  // Winner highlight: from the recorded payout when we have one, else best equity at showdown.
  const winners = useMemo(() => {
    if (!frame) return null;
    if (resultWon) return Object.keys(resultWon).filter(k => resultWon[k] > 0).map(Number);
    if (idx !== frames.length - 1 || hand.won) return null;
    const active = [];
    for (let i = 0; i < hand.setup.seats.length; i++) if (!frame.folded[i]) active.push(i);
    if (active.length === 1) return active;
    if (frame.boardDealt === 5 && equity) {
      let best = -1, bestIdx = [];
      active.forEach(i => {
        const e = equity[i] ? equity[i].equity : 0;
        if (e > best + 0.001) { best = e; bestIdx = [i]; }
        else if (Math.abs(e - best) < 0.001) bestIdx.push(i);
      });
      return bestIdx;
    }
    return null;
  }, [frame, idx, frames.length, equity, hand, resultWon]);

  const go = useCallback((n) => {
    setIdx(prev => Math.max(0, Math.min(frames.length - 1, n)));
  }, [frames.length]);

  // Keyboard navigation
  useEffect(() => {
    if (!hand) return;
    function onKey(e) {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(idx - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(idx + 1); }
      else if (e.key === 'Home') { e.preventDefault(); go(0); }
      else if (e.key === 'End') { e.preventDefault(); go(frames.length - 1); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hand, idx, frames.length, go]);

  // Reset index when a new hand loads
  useEffect(() => { setIdx(0); }, [hand]);

  // Load a different hand chosen from history while the replayer is already open.
  useEffect(() => {
    if (initialHand) { setHand(initialHand); setSavedId(initialHand.savedId || null); setFavorited(!!initialHand.favorited); }
  }, [initialHand]);

  function handleComplete(setup, actions, board) {
    setHand({ setup, actions, board });
    setSavedId(null);
    setFavorited(false);
  }

  async function toggleFavorite() {
    if (!hand || savingFav.current) return;
    if (favorited) {
      if (savedId && onSetFavorite) onSetFavorite(savedId, false);
      setFavorited(false);
      flashToast('Removed from favorites');
    } else {
      if (savedId && onSetFavorite) {
        onSetFavorite(savedId, true);
      } else {
        savingFav.current = true;
        try {
          const summary = buildReplaySummary(hand, frames, equity);
          const id = await onSaveToHistory({ ...hand }, summary);
          if (id) setSavedId(id);
        } finally {
          savingFav.current = false;
        }
      }
      setFavorited(true);
      flashToast('Added to favorites');
    }
  }

  function openShare() {
    if (!hand) return;
    setShareUrl(buildReplayShareUrl(hand));
    setShowShare(true);
  }

  const accountEl = (
    <>
      {themeToggle}
      {userMenu}
    </>
  );

  if (!hand) {
    return (
      <div className="replayer">
        <ReplayerHeader onExit={onExit} title="Hand Replayer" account={accountEl} />
        <div className="replayer-builder-wrap">
          <HandBuilder onComplete={handleComplete} onCancel={onExit} />
        </div>
        {historyDrawer}
      </div>
    );
  }

  return (
    <div className="replayer">
      <ReplayerHeader
        onExit={onExit}
        title="Hand Replayer"
        account={accountEl}
        actions={
          <>
            <button className="btn btn-ghost btn-share" onClick={openShare} title="Share this hand via link">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
              </svg>
              Share
            </button>
            <button className="btn btn-ghost" onClick={() => { setHand(null); }}>New hand</button>
            <button
              className={'btn ' + (favorited ? 'btn-primary' : 'btn-ghost')}
              onClick={toggleFavorite}
              title={favorited ? 'Remove from favorites' : 'Add to favorites'}
            >
              {favorited ? '✓ Favorited' : 'Favorite'}
            </button>
          </>
        }
      />
      <div className="replayer-body">
        <div className="replayer-table-wrap">
          {frame && <ReplayTable setup={hand.setup} board={hand.board} board2={hand.board2} frame={frame} equity={equity} winners={winners} resultWon={resultWon} />}
        </div>
        {frame && (
          <TransportBar
            idx={idx}
            total={frames.length}
            frame={frame}
            onFirst={() => go(0)}
            onPrev={() => go(idx - 1)}
            onNext={() => go(idx + 1)}
            onLast={() => go(frames.length - 1)}
          />
        )}
      </div>
      {toast && (
        <div className="shared-toast">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
          {toast}
        </div>
      )}
      <ShareModal open={showShare} onClose={() => setShowShare(false)} url={shareUrl} short={shareShort} />
      {historyDrawer}
    </div>
  );
}

// actions and account render in separate containers so phones can wrap the
// actions row while the account menu stays pinned on-screen
function ReplayerHeader({ onExit, title, actions, account }) {
  return (
    <div className="replayer-header">
      <button className="btn btn-ghost replayer-back" onClick={onExit}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
        Back
      </button>
      <span className="sv-header-sep" />
      <div className="brand-mark"><span className="accent">Poker</span>Lab</div>
      <span className="sv-mode-badge">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4" /></svg>
        {title}
      </span>
      {actions && <div className="replayer-header-actions">{actions}</div>}
      <div className="replayer-header-account">{account}</div>
    </div>
  );
}

// Build the history-row summary for a saved replay.
export function buildReplaySummary(hand, frames, equity) {
  const setup = hand.setup;
  const board = hand.board;
  const last = frames[frames.length - 1] || null;
  // Hero = lowest-index seat with known cards.
  let heroSeat = -1;
  for (let i = 0; i < setup.seats.length; i++) {
    if (setup.seats[i].cards && setup.seats[i].cards.length === 2) { heroSeat = i; break; }
  }
  const nameOf = (i) => setup.seats[i].name || setup.seats[i].pos || `Player ${i + 1}`;
  const heroCards = heroSeat >= 0 ? setup.seats[heroSeat].cards : null;
  const heroEquity = (equity && heroSeat >= 0 && equity[heroSeat]) ? equity[heroSeat].equity : null;
  let topName = null, topEquity = -1;
  if (equity) {
    Object.keys(equity).forEach(i => {
      if (equity[i].equity > topEquity) { topEquity = equity[i].equity; topName = nameOf(Number(i)); }
    });
  }
  return {
    isReplay: true,
    playerCount: setup.seats.length,
    boardLen: board.length,
    boardPreview: board.slice(0, 5),
    heroCards,
    heroName: heroSeat >= 0 ? nameOf(heroSeat) : null,
    heroEquity,
    topName,
    topEquity: topEquity >= 0 ? topEquity : null,
    blindsLabel: `${setup.sb}/${setup.bb}`,
    actionCount: hand.actions.length,
  };
}

// re-exported from replayShare.js for back-compat
export { encodeReplay, decodeReplay };
export function readReplayFromUrl() {
  const h = window.location.hash || '';
  if (h.startsWith('#r=')) return decodeReplay(h.slice(3));
  return null;
}
export function buildReplayShareUrl(hand) {
  return window.location.origin + window.location.pathname + '#r=' + encodeReplay(hand);
}
