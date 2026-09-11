// Solver — Setup screen. Compact heads-up felt + configuration panel: board,
// both ranges/hands, pot, stack, and the discretised bet-size set, then Solve.
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { PlayingCard, EmptyCardSlot, SuitGlyph, CardChip, SUIT_RED, BoardStrip } from './Cards.jsx';
import { RangePicker } from './Pickers.jsx';
import { RangeThumbnail } from './solverBits.jsx';
import { combosFromKeys, equityMatchup } from './solverEngine.js';

const SUIT_ORDER_S = ['s', 'h', 'c', 'd'];
const VALUE_ORDER_S = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

// Deal a whole street at once (flop = 3 cards, turn/river = 1) instead of
// opening a separate picker per board slot.
function BoardDealModal({ street, need, used, onConfirm, onCancel }) {
  const [cards, setCards] = useState([]);
  function toggle(c) {
    setCards((prev) => {
      const i = prev.findIndex((x) => x.v === c.v && x.s === c.s);
      if (i >= 0) { const n = [...prev]; n.splice(i, 1); return n; }
      if (prev.length < need) return [...prev, c];
      return prev;
    });
  }
  return (
    <div className="picker-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="picker" style={{ width: 760 }}>
        <div className="picker-head">
          <div>
            <div className="picker-title">Deal {street}</div>
            <div className="picker-sub">{cards.length} / {need} card{need === 1 ? '' : 's'} selected</div>
          </div>
          <div className="picker-selected">
            {Array.from({ length: need }).map((_, i) => (cards[i] ? <PlayingCard key={i} card={cards[i]} size="sm" /> : <EmptyCardSlot key={i} size="sm" label="" />))}
          </div>
        </div>
        <HandCardGrid used={used} selected={cards} onToggle={toggle} />
        <div className="picker-foot">
          <button className="btn btn-ghost" onClick={() => setCards([])}>Clear</button>
          <div className="picker-foot-right">
            <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
            <button className="btn btn-primary" disabled={cards.length !== need} onClick={() => onConfirm(cards)}>Deal {street}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function HandCardGrid({ used, selected, onToggle }) {
  const usedSet = new Set(used.map((c) => c.v + c.s));
  const selSet = new Set(selected.map((c) => c.v + c.s));
  return (
    <div className="picker-grid">
      {SUIT_ORDER_S.map((s) => (
        <div key={s} className="picker-row">
          {VALUE_ORDER_S.map((v) => {
            const id = v + s;
            const isUsed = usedSet.has(id) && !selSet.has(id);
            const isSel = selSet.has(id);
            return (
              <button key={id} disabled={isUsed}
                className={'pcard ' + (isUsed ? 'used ' : '') + (isSel ? 'selected ' : '') + (SUIT_RED[s] ? 'red ' : 'ink ')}
                onClick={() => onToggle({ v, s })}>
                <span className={'pcard-rank' + (v === 'T' ? ' is-ten' : '')}>{v === 'T' ? '10' : v}</span>
                <span className="pcard-suit"><SuitGlyph suit={s} size={19} color="currentColor" /></span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function SidePickerModal({ side, label, used, initialMode, onCancel, onSave }) {
  const [mode, setMode] = useState(initialMode || (side.kind === 'hand' ? 'hand' : 'range'));
  const [cards, setCards] = useState(side.kind === 'hand' ? (side.cards || []).filter(Boolean) : []);
  function toggleCard(c) {
    setCards((prev) => {
      const i = prev.findIndex((x) => x.v === c.v && x.s === c.s);
      if (i >= 0) { const n = [...prev]; n.splice(i, 1); return n; }
      if (prev.length < 2) return [...prev, c];
      return prev;
    });
  }
  return (
    <div className="picker-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="picker" style={{ width: mode === 'range' ? 820 : 760 }}>
        <div className="picker-head">
          <div>
            <div className="picker-title">{label}</div>
            <div className="picker-sub">{mode === 'hand' ? `${cards.length} / 2 cards selected` : 'Drag to paint cells · click to toggle'}</div>
          </div>
          <div className="picker-mode">
            <button className={'picker-tab ' + (mode === 'hand' ? 'active' : '')} onClick={() => setMode('hand')}>Hand</button>
            <button className={'picker-tab ' + (mode === 'range' ? 'active' : '')} onClick={() => setMode('range')}>Range</button>
          </div>
        </div>
        {mode === 'hand' ? (
          <>
            <div className="sv-hand-sel-row">
              {Array.from({ length: 2 }).map((_, i) => (cards[i] ? <PlayingCard key={i} card={cards[i]} size="sm" /> : <EmptyCardSlot key={i} size="sm" label="" />))}
            </div>
            <HandCardGrid used={used} selected={cards} onToggle={toggleCard} />
            <div className="picker-foot">
              <button className="btn btn-ghost" onClick={() => setCards([])}>Clear</button>
              <div className="picker-foot-right">
                <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
                <button className="btn btn-primary" disabled={cards.length !== 2} onClick={() => onSave({ kind: 'hand', cards })}>Confirm hand</button>
              </div>
            </div>
          </>
        ) : (
          <RangePicker initial={side.kind === 'range' ? side.keys : []} onCancel={onCancel} onSave={(keys) => onSave({ kind: 'range', keys })} />
        )}
      </div>
    </div>
  );
}

function SeatHolding({ side }) {
  if (side.kind === 'hand' && (side.cards || []).filter(Boolean).length === 2) {
    return (
      <>
        <div className="sv-seat-cards"><PlayingCard card={side.cards[0]} size="sm" /><PlayingCard card={side.cards[1]} size="sm" /></div>
        <div className="sv-seat-meta">specific hand</div>
      </>
    );
  }
  return (
    <>
      <div className="sv-seat-thumb"><RangeThumbnail keys={side.keys || []} cell={6} /></div>
      <div className="sv-seat-meta">{(side.keys || []).length ? combosFromKeys(side.keys) + ' combos' : 'not set'}</div>
    </>
  );
}

function SetupFelt({ board, oopSide, ipSide, pot, onDeal, onClearFrom }) {
  return (
    <div className="sv-felt-card">
      <div className="sv-felt">
        <div className="sv-felt-rim" />
        <div className="sv-felt-inner" />
        <div className="sv-seat sv-seat-oop">
          <div className="sv-seat-head"><span className="sv-pos-badge oop">OOP</span><span className="sv-seat-name">Out of position</span></div>
          <SeatHolding side={oopSide} />
        </div>
        <div className="sv-felt-center">
          <div className="sv-pot-pill"><span className="sv-pot-label">POT</span><span className="sv-pot-val">{pot} bb</span></div>
          <div className="sv-board">
            <BoardStrip board={board} onDeal={onDeal} onClearFrom={onClearFrom} size="md" />
          </div>
        </div>
        <div className="sv-seat sv-seat-ip">
          <div className="sv-seat-head"><span className="sv-pos-badge ip">IP</span><span className="sv-seat-name">In position</span></div>
          <SeatHolding side={ipSide} />
        </div>
      </div>
    </div>
  );
}

function BetSizeChip({ size, onChange, onRemove }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(size.pct));
  const ref = useRef(null);
  useEffect(() => { if (editing && ref.current) ref.current.select(); }, [editing]);
  function commit() { const n = Math.max(1, Math.min(900, Math.round(parseFloat(val) || size.pct))); onChange(n); setEditing(false); }
  return (
    <span className="sv-size-chip">
      {editing ? (
        <input ref={ref} className="sv-size-input" value={val} onChange={(e) => setVal(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }} />
      ) : (
        <button className="sv-size-val" onClick={() => { setVal(String(size.pct)); setEditing(true); }}>{size.pct}%</button>
      )}
      <button className="sv-size-x" onClick={onRemove} aria-label="Remove">×</button>
    </span>
  );
}

function BetSizeEditor({ spot, setSpot }) {
  const PRESETS = [33, 50, 75, 100, 125, 150];
  function setSizes(next) { setSpot((s) => ({ ...s, betSizes: next })); }
  function updateSize(id, pct) { setSizes(spot.betSizes.map((b) => b.id === id ? { ...b, pct } : b)); }
  function removeSize(id) { setSizes(spot.betSizes.filter((b) => b.id !== id)); }
  function addSize(pct) {
    if (spot.betSizes.some((b) => b.pct === pct)) return;
    setSizes([...spot.betSizes, { id: 'b' + pct + '_' + spot.betSizes.length, pct, on: true }].sort((a, b) => a.pct - b.pct));
  }
  const present = new Set(spot.betSizes.map((b) => b.pct));
  return (
    <div className="sv-field">
      <div className="sv-field-label">Bet sizes <span className="sv-field-hint">% of pot · the discretised action set</span></div>
      <div className="sv-size-chips">
        {spot.betSizes.slice().sort((a, b) => a.pct - b.pct).map((b) => (
          <BetSizeChip key={b.id} size={b} onChange={(p) => updateSize(b.id, p)} onRemove={() => removeSize(b.id)} />
        ))}
        <button className={'sv-allin-chip' + (spot.allIn ? ' on' : '')} onClick={() => setSpot((s) => ({ ...s, allIn: !s.allIn }))}>All-in</button>
      </div>
      <div className="sv-preset-row">
        <span className="sv-preset-lbl">Add</span>
        {PRESETS.map((p) => (<button key={p} className="sv-preset-chip" disabled={present.has(p)} onClick={() => addSize(p)}>{p}%</button>))}
      </div>
    </div>
  );
}

function NumField({ label, hint, value, onChange, suffix }) {
  return (
    <div className="sv-field sv-field-num">
      <div className="sv-field-label">{label}{hint && <span className="sv-field-hint">{hint}</span>}</div>
      <div className="sv-num-wrap">
        <input className="sv-num-input" type="number" min="0" value={value}
          onChange={(e) => onChange(e.target.value === '' ? '' : Math.max(0, parseFloat(e.target.value) || 0))} />
        {suffix && <span className="sv-num-suffix">{suffix}</span>}
      </div>
    </div>
  );
}

function SideRow({ side, label, onEdit }) {
  const isHand = side.kind === 'hand' && (side.cards || []).filter(Boolean).length === 2;
  const hasRange = (side.keys || []).length > 0;
  const combos = isHand ? null : combosFromKeys(side.keys || []);
  const pct = isHand ? null : (combos / 1326 * 100).toFixed(0);
  return (
    <div className="sv-range-row">
      <div className="sv-range-thumb">
        {isHand
          ? <div className="sv-row-cards"><PlayingCard card={side.cards[0]} size="sm" /><PlayingCard card={side.cards[1]} size="sm" /></div>
          : <RangeThumbnail keys={side.keys || []} cell={9} />}
      </div>
      <div className="sv-range-info">
        <div className="sv-range-title">
          <span className={'sv-pos-badge ' + (label === 'OOP' ? 'oop' : 'ip')}>{label}</span>
          {label === 'OOP' ? 'Out of position' : 'In position'}
        </div>
        <div className="sv-range-meta">{isHand ? 'Specific hand · 1 combo' : hasRange ? `Range · ${combos} combos · ${pct}% of hands` : 'Choose a hand or range'}</div>
        {isHand ? (
          <button className="btn btn-ghost sv-edit-range" onClick={() => onEdit('hand')}>Edit hand</button>
        ) : hasRange ? (
          <button className="btn btn-ghost sv-edit-range" onClick={() => onEdit('range')}>Edit range</button>
        ) : (
          <div className="sv-set-btns">
            <button className="btn btn-ghost sv-edit-range" onClick={() => onEdit('hand')}>Hand</button>
            <button className="btn btn-ghost sv-edit-range" onClick={() => onEdit('range')}>Range</button>
          </div>
        )}
      </div>
    </div>
  );
}

function EquityReadout({ oopSide, ipSide, board }) {
  const eq = useMemo(() => equityMatchup(oopSide, ipSide, board), [oopSide, ipSide, board]);
  const live = (board || []).filter(Boolean).length;
  if (!eq.hero) {
    return (
      <div className="sv-equity-card">
        <div className="sv-equity-head"><div className="sv-field-label">Equity</div></div>
        <div className="sv-equity-empty">Nothing to run. All combos are blocked by the board or the opposing hand.</div>
      </div>
    );
  }
  const rows = [
    { label: 'OOP', side: oopSide, r: eq.hero, count: eq.heroCount },
    { label: 'IP', side: ipSide, r: eq.villain, count: eq.villCount },
  ];
  return (
    <div className="sv-equity-card">
      <div className="sv-equity-head">
        <div className="sv-field-label">Equity</div>
        <div className="sv-equity-meta">
          <span className={'sv-method ' + eq.method}>{eq.method === 'exact' ? 'exact' : 'simulated'}</span>
          {eq.method === 'simulated' && <span className="sv-equity-samples">{(eq.samples / 1000).toFixed(0)}k runouts</span>}
        </div>
      </div>
      <table className="sv-equity-table">
        <thead><tr><th>Player</th><th>Holding</th><th className="num">Win</th><th className="num">Tie</th><th className="num">Equity</th><th className="sv-eqbar-col"></th></tr></thead>
        <tbody>
          {rows.map(({ label, side, r, count }) => {
            const isHand = side.kind === 'hand' && (side.cards || []).filter(Boolean).length === 2;
            return (
              <tr key={label}>
                <td><span className="sv-eq-player"><span className={'sv-pos-badge ' + (label === 'OOP' ? 'oop' : 'ip')}>{label}</span></span></td>
                <td className="sv-eq-holding">
                  {isHand
                    ? <span className="sv-eq-cards"><CardChip card={side.cards[0]} /><CardChip card={side.cards[1]} /></span>
                    : <span className="sv-eq-rangelabel">Range · {count} combo{count === 1 ? '' : 's'}</span>}
                </td>
                <td className="num">{r.win.toFixed(1)}%</td>
                <td className="num">{r.tie.toFixed(1)}%</td>
                <td className="num sv-eq-equity">{r.equity.toFixed(1)}%</td>
                <td className="sv-eqbar-col"><div className="eq-track"><div className="eq-track-fill" style={{ width: r.equity + '%' }} /></div></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="sv-equity-foot">
        {live === 5
          ? 'Exact showdown equity on the complete board, after removing combos blocked by the board and the opposing hand.'
          : `Estimated over ${(eq.samples / 1000).toFixed(0)}k random runouts — set all 5 board cards for an exact result.`}
      </div>
    </div>
  );
}

export function SetupView({ spot, setSpot, board, setBoard, oopSide, setOopSide, ipSide, setIpSide, onSolve }) {
  const [boardDeal, setBoardDeal] = useState(false);
  const [sideEdit, setSideEdit] = useState(null);
  const filled = board.filter(Boolean).length;
  const boardComplete = filled === 5;
  const nextTarget = filled < 3 ? 3 : filled < 4 ? 4 : 5;
  const dealNeed = nextTarget - filled;
  const streetLabel = nextTarget === 3 ? 'flop' : nextTarget === 4 ? 'turn' : 'river';
  function dealBoard(cards) {
    setBoard((prev) => { const n = [...prev]; let k = prev.filter(Boolean).length; for (const c of cards) { if (k < 5) n[k++] = c; } return n; });
    setBoardDeal(false);
  }
  const onDealBoard = () => setBoardDeal(true);
  const onClearBoardFrom = (i) => setBoard((prev) => prev.map((c, j) => (j >= i ? null : c)));
  const hasHolding = (side) => side.kind === 'hand' ? (side.cards || []).filter(Boolean).length === 2 : (side.keys || []).length > 0;
  const ready = boardComplete && hasHolding(oopSide) && hasHolding(ipSide);
  const sizeCount = spot.betSizes.length + (spot.allIn ? 1 : 0);
  function usedForSide(which) {
    const out = board.filter(Boolean);
    const other = which === 'OOP' ? ipSide : oopSide;
    if (other.kind === 'hand') out.push(...(other.cards || []).filter(Boolean));
    return out;
  }
  return (
    <div className="sv-setup">
      <div className="sv-setup-grid">
        <div className="sv-setup-left">
          <div className="sv-section-label">Spot preview</div>
          <SetupFelt board={board} oopSide={oopSide} ipSide={ipSide} pot={spot.pot} onDeal={onDealBoard} onClearFrom={onClearBoardFrom} />
          <EquityReadout oopSide={oopSide} ipSide={ipSide} board={board} />
          <div className="sv-scope-note">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" />
            </svg>
            <div><strong>Heads-up river spots only.</strong> This is not a general multi-street GTO solver.</div>
          </div>
        </div>
        <div className="sv-setup-right">
          <div className="sv-section-label">Spot configuration</div>
          <div className="sv-config-card">
            <div className="sv-field">
              <div className="sv-field-label sv-board-label">
                <span>Board <span className="sv-field-hint">complete 5-card river</span></span>
                <button className="sv-clear-board" onClick={() => setBoard([null, null, null, null, null])}>Clear all</button>
              </div>
              <div className="sv-board-row">
                <BoardStrip board={board} onDeal={onDealBoard} onClearFrom={onClearBoardFrom} size="sm" />
              </div>
            </div>
            <div className="sv-divider" />
            <div className="sv-field sv-players-field">
              <div className="sv-field-label">Players <span className="sv-field-hint">each side can be a specific hand or a range</span></div>
              <SideRow side={oopSide} label="OOP" onEdit={(mode) => setSideEdit({ which: 'OOP', mode })} />
              <SideRow side={ipSide} label="IP" onEdit={(mode) => setSideEdit({ which: 'IP', mode })} />
            </div>
            <div className="sv-divider" />
            <div className="sv-num-grid">
              <NumField label="Pot size" value={spot.pot} suffix="bb" onChange={(v) => setSpot((s) => ({ ...s, pot: v }))} />
              <NumField label="Effective stack" value={spot.stack} suffix="bb" onChange={(v) => setSpot((s) => ({ ...s, stack: v }))} />
            </div>
            <BetSizeEditor spot={spot} setSpot={setSpot} />
            <div className="sv-solve-row">
              <div className="sv-tree-summary">Tree · <strong>{sizeCount}</strong> bet size{sizeCount === 1 ? '' : 's'} · SPR {spot.pot ? (spot.stack / spot.pot).toFixed(1) : '—'}</div>
              <button className="btn btn-primary sv-solve-btn" disabled={!ready} onClick={onSolve}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3l14 9-14 9V3z" /></svg>
                Solve
              </button>
            </div>
            {!ready && <div className="sv-solve-warn">{!boardComplete ? 'Set all 5 board cards to solve.' : 'Set a hand or range for both players.'}</div>}
          </div>
        </div>
      </div>
      {boardDeal && (
        <BoardDealModal street={streetLabel} need={dealNeed} used={board.filter(Boolean)}
          onConfirm={dealBoard} onCancel={() => setBoardDeal(false)} />
      )}
      {sideEdit && (
        <SidePickerModal label={sideEdit.which === 'OOP' ? 'Out-of-position holding' : 'In-position holding'}
          side={sideEdit.which === 'OOP' ? oopSide : ipSide} initialMode={sideEdit.mode} used={usedForSide(sideEdit.which)}
          onCancel={() => setSideEdit(null)}
          onSave={(next) => { (sideEdit.which === 'OOP' ? setOopSide : setIpSide)(next); setSideEdit(null); }} />
      )}
    </div>
  );
}
