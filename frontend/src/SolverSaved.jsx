import React, { useState } from 'react';
import { PlayingCard } from './Cards.jsx';

// saved spots under the setup screen; clicking one reloads it and re-solves
export function SavedSolvesPanel({ lib, onLoad }) {
  const [busyId, setBusyId] = useState(null);
  return (
    <div className="sv-saved">
      <div className="sv-section-label">
        Saved solves <span className="sv-field-hint">{lib.solves.length} of {lib.limits ? lib.limits.solves : '—'}</span>
      </div>
      {lib.solves.length === 0 ? (
        <div className="sv-saved-empty">{lib.solvesLoaded ? 'Solve a spot and hit Save solve to keep it here.' : 'Loading…'}</div>
      ) : (
        <div className="sv-saved-list">
          {lib.solves.map((s) => (
            <div key={s.id} className="sv-saved-row">
              <button className="sv-saved-load" onClick={() => onLoad(s)} title="Load and re-solve">
                <div className="sv-saved-top">
                  <span className="sv-saved-name">{s.name}</span>
                  <span className="sv-saved-date">{new Date(s.createdAt).toLocaleDateString()}</span>
                </div>
                <div className="sv-saved-cards">
                  {(s.config.board || []).filter(Boolean).map((c, i) => <PlayingCard key={i} card={c} size="sm" />)}
                </div>
                <div className="sv-saved-meta">
                  {s.summary.oopCombos} vs {s.summary.ipCombos} combos · pot {s.config.spot.pot} bb · {s.summary.sizes}-size tree · {Number(s.summary.exploit).toFixed(2)}% pot
                  {s.summary.villain && <span className="sv-saved-exploit"> · exploit vs {s.summary.villain.name}</span>}
                </div>
              </button>
              <button
                className="hist-del"
                aria-label={`Delete ${s.name}`}
                title="Delete"
                disabled={busyId === s.id}
                onClick={async () => { setBusyId(s.id); await lib.deleteSolve(s.id); setBusyId(null); }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// "Save solve" button with an inline name box
export function SaveSolveControl({ onSave, openPlans }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function submit(e) {
    e.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    const res = await onSave(n);
    setBusy(false);
    if (res.ok) { setMsg({ kind: 'ok', text: 'Saved' }); setOpen(false); setName(''); }
    else setMsg({ kind: res.code === 'limit_reached' ? 'limit' : 'err', text: res.error || 'Could not save' });
  }

  return (
    <div className="sv-save-ctl">
      {open ? (
        <form className="sv-save-form" onSubmit={submit}>
          <input className="range-save-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Solve name" maxLength={60} autoFocus aria-label="Solve name" />
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn btn-ghost" onClick={() => { setOpen(false); setMsg(null); }}>Cancel</button>
        </form>
      ) : (
        <button className="btn btn-ghost" onClick={() => { setMsg(null); setOpen(true); }}>Save solve</button>
      )}
      {msg && (
        <span className={'range-save-msg ' + msg.kind} role={msg.kind === 'ok' ? 'status' : 'alert'}>
          {msg.text}
          {msg.kind === 'limit' && <button type="button" className="link-btn" onClick={openPlans}>Upgrade to Pro</button>}
        </span>
      )}
    </div>
  );
}
