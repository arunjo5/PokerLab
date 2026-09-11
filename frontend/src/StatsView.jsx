import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { apiCall, jsonBody } from './api.js';
import { aggregate, analyzeHand, inferHeroName, heroSeatByName, sessionKey, sessionName, handLabel, cumulativeNet } from './sessionStats.js';

// cached per signed-in user so reopening the page is instant
const cache = { key: null, items: null };

const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
function money(n, cents) {
  const v = cents ? n / 100 : n;
  const abs = Math.abs(v);
  const s = cents ? abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : abs.toLocaleString('en-US');
  return (v < 0 ? '−' : v > 0 ? '+' : '') + (cents ? '$' : '') + s;
}
const fmtPct = (p) => (p == null ? '—' : `${p.toFixed(0)}%`);
const fmtBb = (b) => (b == null ? '—' : `${b > 0 ? '+' : b < 0 ? '−' : ''}${Math.abs(b).toFixed(1)}`);
const fmtAf = (a) => (a == null ? '—' : a === Infinity ? '∞' : a.toFixed(1));
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
const tone = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');

// pull every imported hand; analyse any that predate stored stats and write those back
async function loadHands(setProgress) {
  const items = [];
  let cursor = null;
  do {
    const res = await apiCall(`/api/stats/hands?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!res.ok) throw Object.assign(new Error(res.error || 'Could not load hands'), { code: res.code });
    for (const h of res.hands || []) items.push(h);
    cursor = res.nextCursor || null;
    setProgress(`Loading hands… ${items.length.toLocaleString('en-US')}`);
  } while (cursor);

  const legacy = items.filter(it => !it.stats && it.replay);
  if (legacy.length) {
    setProgress(`Analyzing ${plural(legacy.length, 'older hand', 'older hands')}…`);
    const heroName = inferHeroName(legacy.map(it => it.replay));
    const computed = [];
    for (const it of legacy) {
      const seat = it.replay.hero != null ? it.replay.hero : heroSeatByName(it.replay, heroName);
      const stats = analyzeHand(it.replay, seat);
      if (stats) { it.stats = stats; computed.push({ id: it.id, stats }); }
      delete it.replay;
    }
    for (let i = 0; i < computed.length; i += 100) {
      await apiCall('/api/stats/backfill', { method: 'POST', ...jsonBody({ items: computed.slice(i, i + 100) }) });
    }
  }
  return items;
}

// gold (i) that explains a stat on hover or keyboard focus
function Info({ label, text }) {
  const id = useId();
  return (
    <span className="st-info">
      <button type="button" className="st-info-btn" aria-label={`How ${label} is calculated`} aria-describedby={id}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" />
        </svg>
      </button>
      <span role="tooltip" id={id} className="st-tip">{text}</span>
    </span>
  );
}

const EXPLAIN = {
  hands: 'Hands you were dealt in your imported sessions.',
  net: 'Your total profit or loss. bb/100 shows your average result in big blinds per 100 hands.',
  vpip: 'How often you voluntarily put chips in preflop, excluding blinds. PFR shows how often you raised preflop.',
  threeBet: 'How often you reraised preflop when facing a single raise.',
  wtsd: 'How often you reached showdown after seeing the flop. Winning any part of the pot counts as a showdown win.',
  af: 'Your bets plus raises divided by your calls, across all streets including preflop.',
};

function Tile({ label, value, sub, valueTone, na, explain }) {
  return (
    <div className="st-tile">
      <div className="st-tile-label">{label}{explain && <Info label={label} text={explain} />}</div>
      <div className={'st-tile-value' + (na ? ' na' : '') + (valueTone ? ' ' + valueTone : '')}>{value}</div>
      {sub && <div className="st-tile-sub">{sub}</div>}
    </div>
  );
}

// running total in hand order; single series, so the line carries the brand accent
function NetChart({ points, cents }) {
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);
  const boxRef = useRef(null);
  // draw at the container's real width so labels stay readable on narrow screens
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const measure = () => setW(Math.max(300, Math.round(el.clientWidth || 640)));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 180, PAD = { l: 56, r: 18, t: 14, b: 24 };
  const n = points.length;
  if (n < 2) return <div className="st-none" ref={boxRef}>The chart appears once two hands are recorded.</div>;
  const ys = points.map(p => p.cum);
  const minY = Math.min(0, ...ys), maxY = Math.max(0, ...ys);
  const x = (i) => PAD.l + (i / (n - 1)) * (W - PAD.l - PAD.r);
  const y = (v) => PAD.t + (1 - (v - minY) / (maxY - minY || 1)) * (H - PAD.t - PAD.b);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.cum).toFixed(1)}`).join(' ');
  const last = points[n - 1];
  const ticks = [...new Set([minY, 0, maxY])];

  function onMove(e) {
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  }
  const hp = hover != null ? points[hover] : null;

  return (
    <div className="st-chart" ref={boxRef}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img"
        aria-label={`Cumulative net result over ${plural(n, 'hand', 'hands')}, ending at ${money(last.cum, cents)}`}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--border-2)" strokeWidth="1" strokeDasharray={t === 0 ? '' : '2 4'} />
            <text x={PAD.l - 8} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill="var(--text-soft)">{money(t, cents)}</text>
          </g>
        ))}
        <text x={PAD.l} y={H - 7} fontSize="10" fill="var(--text-soft)">Hand 1</text>
        <text x={W - PAD.r} y={H - 7} textAnchor="end" fontSize="10" fill="var(--text-soft)">Hand {n.toLocaleString('en-US')}</text>
        <path d={d} fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(n - 1)} cy={y(last.cum)} r="3.5" fill="var(--gold)" />
        {hp && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="var(--text-faint)" strokeWidth="1" />
            <circle cx={x(hover)} cy={y(hp.cum)} r="4.5" fill="var(--bg-elev)" stroke="var(--gold)" strokeWidth="2" />
          </g>
        )}
      </svg>
      {hp && (
        <div className="st-chart-tip" style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(hp.cum) / H) * 100}%` }}>
          <div>{handLabel(hp.name)} <span className="dim">· {money(hp.net, cents)} this hand</span></div>
          <div><strong>{money(hp.cum, cents)}</strong> <span className="dim">after {plural(hp.i, 'hand', 'hands')}</span></div>
        </div>
      )}
    </div>
  );
}

// session picker in the app's menu style; closes on outside click or escape
function SessionMenu({ value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const current = options.find(o => o.value === value) || options[0];
  return (
    <div className="st-menu-wrap" ref={ref}>
      <button type="button" className="btn st-menu-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="st-menu-current">{current.label}</span>
        <span className="st-menu-caret">▾</span>
      </button>
      {open && (
        <div className="st-menu" role="listbox" aria-label="Session">
          {options.map(o => (
            <button type="button" key={o.value} role="option" aria-selected={o.value === value}
              className={'st-menu-item' + (o.value === value ? ' active' : '')}
              onClick={() => { onChange(o.value); setOpen(false); }}>
              <span className="st-menu-check">
                {o.value === value && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                )}
              </span>
              <span className="st-menu-label">{o.label}</span>
              <span className="st-menu-count">{o.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function HandList({ hands, cents, empty, onOpenHand }) {
  if (hands.length === 0) return <div className="st-none">{empty}</div>;
  return (
    <ul className="st-list">
      {hands.map(h => (
        <li key={h.id}>
          <button className="st-hand" onClick={() => onOpenHand(h.id)} title="Open in the replayer">
            <span className="st-hand-main">
              <span className="st-hand-name">{handLabel(h.name)}</span>
              <span className="st-hand-ctx">{[h.pos, h.session ? sessionName(h.session, h.createdAt) : fmtDate(h.createdAt)].filter(Boolean).join(' · ')}</span>
            </span>
            <span className={'st-hand-net ' + tone(h.net)}>{money(h.net, cents)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function StatsView({ onExit, onNavigate, themeToggle, userMenu, user, plan, onUpgrade, onOpenHand }) {
  const isPro = plan.plan === 'pro';
  const key = user ? (user.id || user.email) : null;
  const [items, setItems] = useState(() => (cache.key === key ? cache.items : null));
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [sessionFilter, setSessionFilter] = useState('all');
  const running = useRef(false);

  async function load() {
    if (running.current) return;
    running.current = true;
    setError(null);
    setProgress('Loading hands…');
    try {
      const loaded = await loadHands(setProgress);
      cache.key = key; cache.items = loaded;
      setItems(loaded);
    } catch (e) {
      setError(e.message || 'Could not load hands');
    } finally {
      setProgress(null);
      running.current = false;
    }
  }

  useEffect(() => {
    if (user && isPro && items == null) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, isPro]);

  const all = useMemo(() => (items ? aggregate(items) : null), [items]);
  const filtered = useMemo(() => {
    if (!items) return null;
    return sessionFilter === 'all' ? items : items.filter(it => sessionKey(it) === sessionFilter);
  }, [items, sessionFilter]);
  const summary = useMemo(() => (filtered ? aggregate(filtered) : null), [filtered]);
  const series = useMemo(() => (filtered ? cumulativeNet(filtered) : []), [filtered]);
  const filtering = sessionFilter !== 'all';
  const scope = filtering ? 'in this selection' : 'recorded';

  return (
    <div className="app stats-page">
      <div className="topbar">
        <div className="brand">
          <button className="brand-mark brand-link" onClick={onExit}><span className="accent">Poker</span>Lab</button>
        </div>
        <div className="toolbar">
          <button className="btn btn-ghost" onClick={() => onNavigate('calc')}>Calculator</button>
          <button className="btn btn-ghost btn-replayer" onClick={() => onNavigate('replayer')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3" /></svg>
            Replayer
          </button>
          <button className="btn btn-ghost btn-solver" onClick={() => onNavigate('solver')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M7 14l3-4 3 2 4-6" /></svg>
            Solver
          </button>
        </div>
        <div className="topbar-account">
          {themeToggle}
          {userMenu}
        </div>
      </div>

      <div className="stats">
        <div className="stats-head">
          <div>
            <h1 className="stats-title">Session stats</h1>
            <div className="stats-sub">Results from your imported PokerNow hands.</div>
          </div>
          {isPro && all && all.hands > 0 && (
            <div className="stats-controls">
              <SessionMenu
                value={sessionFilter}
                onChange={setSessionFilter}
                options={[
                  { value: 'all', label: 'All sessions', count: plural(all.hands, 'hand', 'hands') },
                  ...all.sessions.map(sx => ({ value: sx.key, label: sessionName({ label: sx.label, at: sx.at }), count: plural(sx.hands, 'hand', 'hands') })),
                ]}
              />
              <button className="btn btn-ghost" onClick={load} disabled={!!progress}>{progress ? 'Refreshing…' : 'Refresh'}</button>
            </div>
          )}
        </div>

        {!user ? (
          <div className="stats-empty">
            <div className="stats-empty-title">Sign in to see your stats</div>
            <div className="stats-empty-sub">Import a PokerNow log from your account menu and your numbers appear here.</div>
          </div>
        ) : !isPro ? (
          <div className="stats-empty">
            <div className="stats-empty-title">Session stats is a Pro feature</div>
            <div className="stats-empty-sub">Pro keeps every imported hand and turns them into VPIP, PFR, 3-bet %, win rates by position, and results by session.</div>
            <button className="btn btn-primary" onClick={onUpgrade}>See Pro</button>
          </div>
        ) : error ? (
          <div className="stats-empty">
            <div className="stats-empty-title">Couldn’t load your hands</div>
            <div className="stats-empty-sub">{error}</div>
            <button className="btn" onClick={load}>Try again</button>
          </div>
        ) : !summary ? (
          <div className="stats-empty"><div className="stats-empty-sub">{progress || 'Loading…'}</div></div>
        ) : all.hands === 0 ? (
          <div className="stats-empty">
            <div className="stats-empty-title">No imported hands yet</div>
            <div className="stats-empty-sub">Import a PokerNow log from your account menu. Hands you were dealt into count toward your stats.</div>
          </div>
        ) : (
          <>
            <div className="st-tiles">
              <Tile label="Hands" value={summary.hands.toLocaleString('en-US')} sub={`Across ${plural(summary.sessions.length, 'session', 'sessions')}`} explain={EXPLAIN.hands} />
              <Tile label="Net result" value={money(summary.net, summary.cents)} valueTone={tone(summary.net)}
                sub={summary.bb100 == null ? 'bb/100 unavailable' : `${fmtBb(summary.bb100)} bb/100`} explain={EXPLAIN.net} />
              <Tile label="VPIP" value={fmtPct(summary.vpip)} sub={`PFR ${fmtPct(summary.pfr)}`} explain={EXPLAIN.vpip} />
              <Tile label="3-bet" value={summary.counts.tbOpp ? fmtPct(summary.threeBet) : '—'} na={!summary.counts.tbOpp}
                sub={summary.counts.tbOpp ? `${summary.counts.tb} of ${plural(summary.counts.tbOpp, 'opportunity', 'opportunities')}` : 'No opportunities yet'} explain={EXPLAIN.threeBet} />
              <Tile label="WTSD" value={summary.counts.flop ? fmtPct(summary.wtsd) : '—'} na={!summary.counts.flop}
                sub={summary.counts.sd ? `Won at showdown ${fmtPct(summary.wsd)}` : summary.counts.flop ? 'No showdowns yet' : 'No flops seen yet'} explain={EXPLAIN.wtsd} />
              <Tile label="Aggression factor" value={fmtAf(summary.af)} na={summary.af == null}
                sub={summary.af == null ? 'No bets, raises, or calls yet' : '(Bets + raises) / calls'} explain={EXPLAIN.af} />
            </div>
            {summary.hands < 200 && (
              <div className="st-note">This is a small sample of {plural(summary.hands, 'hand', 'hands')}. Percentages settle after a few hundred.</div>
            )}

            <div className="st-grid">
              <section className="st-card wide">
                <div className="st-card-title">Cumulative net result</div>
                <NetChart points={series} cents={summary.cents} />
              </section>

              <section className="st-card">
                <div className="st-card-title">By position</div>
                <table className="st-table">
                  <thead><tr><th>Position</th><th>Hands</th><th>VPIP</th><th>PFR</th><th>Net result</th><th>bb/100</th></tr></thead>
                  <tbody>
                    {summary.positions.map(p => (
                      <tr key={p.pos}>
                        <td className="st-pos">{p.pos}</td>
                        <td>{p.hands}</td>
                        <td>{fmtPct(p.vpip)}</td>
                        <td>{fmtPct(p.pfr)}</td>
                        <td className={tone(p.net)}>{money(p.net, summary.cents)}</td>
                        <td className={tone(p.net)}>{fmtBb(p.bb100)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section className="st-card">
                <div className="st-card-title">By session</div>
                <table className="st-table">
                  <thead><tr><th>Session</th><th>Hands</th><th>VPIP</th><th>Net result</th><th>bb/100</th></tr></thead>
                  <tbody>
                    {summary.sessions.map(sx => {
                      const named = !!sessionName({ label: sx.label }, null) && sx.label;
                      return (
                        <tr key={sx.key}>
                          <td className="st-session">{sessionName({ label: sx.label, at: sx.at })}{named && sx.at && <span className="st-date">{fmtDate(sx.at)}</span>}</td>
                          <td>{sx.hands}</td>
                          <td>{fmtPct(sx.vpip)}</td>
                          <td className={tone(sx.net)}>{money(sx.net, summary.cents)}</td>
                          <td className={tone(sx.net)}>{fmtBb(sx.bb100)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>

              <section className="st-card">
                <div className="st-card-title">Biggest wins<span className="st-card-hint">by your net result</span></div>
                <HandList hands={summary.biggest.won} cents={summary.cents} empty={`No winning hands ${scope}`} onOpenHand={onOpenHand} />
              </section>

              <section className="st-card">
                <div className="st-card-title">Biggest losses<span className="st-card-hint">by your net result</span></div>
                <HandList hands={summary.biggest.lost} cents={summary.cents} empty={`No losing hands ${scope}`} onOpenHand={onOpenHand} />
              </section>
            </div>

          </>
        )}
      </div>
    </div>
  );
}
