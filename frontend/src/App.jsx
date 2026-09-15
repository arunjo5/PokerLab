import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import * as PokerEngine from './pokerEngine.js';
import { PlayingCard, EmptyCardSlot, SuitGlyph, SUIT_GLYPH, SUIT_RED, BoardStrip, ThemeIcon } from './Cards.jsx';
import { CardPicker, RangePicker, SUIT_ORDER, VALUE_ORDER } from './Pickers.jsx';
import { PlayerSeat } from './Seat.jsx';
import { useAuth } from './AuthContext.jsx';
import { useFlash } from './hooks.js';
import { HistoryDrawer } from './HistoryDrawer.jsx';
import { ShareModal } from './ShareModal.jsx';
import { UploadModal } from './UploadModal.jsx';
import { ReplayerView, readReplayFromUrl } from './Replayer.jsx';
import { decodeReplay } from './replayShare.js';
import { readShareCodeFromUrl, shortLinkUrl, createShareLink, fetchShareLink, listShareLinks, deleteShareLink, renameShareLink } from './shareLinks.js';
import { analyzeHand, sessionLabel } from './sessionStats.js';
import { SolverView } from './SolverView.jsx';
import { PlansView } from './PlansView.jsx';
import { UpgradePrompt } from './UpgradePrompt.jsx';
import { StatsView } from './StatsView.jsx';
import {
  encodeScenario,
  decodeScenario,
  readScenarioFromUrl,
  buildShareUrl,
} from './scenario.js';

const NAMES_KEY = 'holdem_player_names_v1';
const THEME_KEY = 'holdem_theme_v1';

const safeJson = async (r) => { try { return await r.json(); } catch { return null; } };
const safeFetchJson = async (url) => { try { const r = await fetch(url, { credentials: 'include' }); return r.ok ? await safeJson(r) : null; } catch { return null; } };
const HISTORY_PAGE = 60;

// 9 seats arranged around the felt with EQUAL ARC LENGTH between neighbours
// (not equal angle) — keeps them evenly spaced even on an elongated felt.
// Player 1 sits at the top.
function computeSeatPositions(rx_pct, ry_pct, STAGE_W, STAGE_H) {
  const N = 9;
  const cx_pct = 50, cy_pct = 50;
  const rxPx = (rx_pct / 100) * STAGE_W;
  const ryPx = (ry_pct / 100) * STAGE_H;

  const SAMPLES = 4000;
  const dtheta = (2 * Math.PI) / SAMPLES;
  const startAngle = -Math.PI / 2;
  const cumLen = [0];
  let total = 0;
  for (let i = 1; i <= SAMPLES; i++) {
    const theta = startAngle + i * dtheta;
    const dx = -rxPx * Math.sin(theta);
    const dy = ryPx * Math.cos(theta);
    total += Math.sqrt(dx * dx + dy * dy) * dtheta;
    cumLen.push(total);
  }
  function thetaAtArc(targetS) {
    let lo = 0, hi = SAMPLES;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumLen[mid] < targetS) lo = mid + 1;
      else hi = mid;
    }
    return startAngle + lo * dtheta;
  }
  const positions = [];
  for (let k = 0; k < N; k++) {
    const theta = thetaAtArc((k / N) * total);
    positions.push({
      x: cx_pct + rx_pct * Math.cos(theta),
      y: cy_pct + ry_pct * Math.sin(theta),
    });
  }
  return positions;
}

// desktop landscape stage vs near-portrait stage for phones
const CALC_STAGE = { w: 1080, h: 600 };
const CALC_STAGE_COMPACT = { w: 500, h: 916 };
// board dead-center on the felt; compact plates are slimmed (see styles) so
// the full 9-seat ring fits
const COMPACT_BOARD_Y = 50;
const SEAT_POSITIONS = computeSeatPositions(44, 35, CALC_STAGE.w, CALC_STAGE.h);
const SEAT_POSITIONS_COMPACT = (() => {
  const pos = computeSeatPositions(36.5, 41.5, CALC_STAGE_COMPACT.w, CALC_STAGE_COMPACT.h);
  // the arc parks the mid-side seats just above center, on the centered board's
  // row — lift them (and the lower sides a touch) clear of it
  [2, 7].forEach((i) => { pos[i] = { ...pos[i], y: pos[i].y - 5.5 }; });
  [3, 6].forEach((i) => { pos[i] = { ...pos[i], y: pos[i].y - 2.0 }; });
  return pos;
})();

export default function App() {
  const [players, setPlayers] = useState(() => Array(9).fill(null));
  const [board, setBoard] = useState([]);
  const [playerNames, setPlayerNames] = useState(() => {
    try { return JSON.parse(localStorage.getItem(NAMES_KEY) || 'null') || Array(9).fill(null); }
    catch { return Array(9).fill(null); }
  });
  const [picker, setPicker] = useState(null);
  const [boardDeal, setBoardDeal] = useState(null);
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(THEME_KEY) || 'light'; } catch { return 'light'; }
  });
  const [pot, setPot] = useState('');
  const [callAmt, setCallAmt] = useState('');
  const [oddsMode, setOddsMode] = useState('potOdds');
  const [results, setResults] = useState({ perPlayer: {}, sims: 0 });
  const [calculating, setCalculating] = useState(false);
  const calcVersion = useRef(0);
  const inFlightWorkersRef = useRef([]);
  const { user, loading: authLoading, signIn, signOut, plan, refreshPlan, startCheckout, openPortal, plansNonce } = useAuth();
  const [saving, setSaving] = useState(false);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const lastSavedScenarioRef = useRef(null);
  // Latest committable hand state, kept fresh without saving. Auto-save
  // commits this ONCE at a hand boundary (clear, new deal, load, page exit)
  // — not on every intermediate edit — so building one 5-way spot is 1 row.
  const currentSnapshotRef = useRef(null);

  // ── History / share / shared-link state ──
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [historyCursor, setHistoryCursor] = useState(null);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const historyLoadedRef = useRef(false);
  const historyInflightRef = useRef(null);
  const starredLoadedRef = useRef(false);

  // ── Replayer: calculator vs. hand replayer view ──
  const [view, setView] = useState('calc'); // 'calc' | 'replayer'
  const [replayHand, setReplayHand] = useState(null);
  const [showShare, setShowShare] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [sharedToast, flashShared] = useFlash(3600, false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [importToast, flashImport, setImportToast] = useFlash(3200);

  // ── Billing: plan gate, upgrade prompt, return from checkout ──
  // pro entry points stay hidden in production until stripe is configured
  const billingOn = plan.billingEnabled || import.meta.env.DEV;
  const isPro = plan.plan === 'pro';
  const [limitPrompt, setLimitPrompt] = useState(false);
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const limitShownRef = useRef(false);
  const [noticeToast, flashNotice, setNoticeToast] = useFlash(3600);
  const [activating, setActivating] = useState(() => {
    try { return new URLSearchParams(window.location.search).get('billing') === 'success'; } catch { return false; }
  });

  // the save response says when a free account is full; prompt once per session
  function noteLimit(data) {
    const lim = data && data.limit;
    if (!lim || lim.plan !== 'free' || !lim.atCap || limitShownRef.current) return;
    limitShownRef.current = true;
    setLimitPrompt(true);
  }

  async function upgradeNow() {
    setUpgradeBusy(true);
    const res = await startCheckout('year');
    setUpgradeBusy(false);
    if (res && res.error) flashNotice(res.error);
    else setLimitPrompt(false);
  }

  // something deep in the tree (range picker, solver) asked for the plans page
  useEffect(() => {
    if (!plansNonce) return;
    setPicker(null);
    setView('plans');
  }, [plansNonce]);

  // back from stripe: drop the marker from the url
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('billing')) return;
    params.delete('billing');
    const q = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (q ? '?' + q : '') + window.location.hash);
  }, []);

  // the webhook flips the plan; poll until it shows up
  useEffect(() => {
    if (!activating) return;
    if (!authLoading && !user) { setActivating(false); return; }
    if (!user) return;
    let cancelled = false;
    let timer;
    let tries = 0;
    setNoticeToast('Activating Pro…');
    const tick = async () => {
      const p = await refreshPlan();
      if (cancelled) return;
      if (p.plan === 'pro') { setActivating(false); flashNotice('You’re on Pro'); return; }
      if (++tries >= 12) { setActivating(false); flashNotice('Payment received. Pro switches on in a moment.'); return; }
      timer = setTimeout(tick, 1500);
    };
    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [activating, authLoading, user, refreshPlan, flashNotice, setNoticeToast]);

  // load a shared scenario; mark it saved so only edits persist
  function applySharedScenario(sc) {
    setPlayers(sc.players);
    setBoard(sc.board);
    setPlayerNames(sc.playerNames);
    setPot(sc.pot);
    setCallAmt(sc.callAmt);
    lastSavedScenarioRef.current = encodeScenario({
      players: sc.players, board: sc.board, playerNames: sc.playerNames,
      pot: sc.pot, callAmt: sc.callAmt,
    });
    setView('calc');
    setShowHistory(false);
    flashShared(true);
  }

  // resolve a /s/<code> link and load it
  async function loadShareCode(code) {
    const res = await fetchShareLink(code);
    if (!res.ok) {
      flashNotice(res.status === 404 ? 'This link no longer exists' : res.error);
      return false;
    }
    if (res.kind === 'replay') {
      const rep = decodeReplay(res.payload);
      if (!rep) { flashNotice('This link is broken'); return false; }
      setReplayHand(rep);
      setShowHistory(false);
      setView('replayer');
      return true;
    }
    const sc = decodeScenario(res.payload);
    if (!sc) { flashNotice('This link is broken'); return false; }
    applySharedScenario(sc);
    return true;
  }

  // ── Auto-load from the URL on first mount (/s/<code>, #r=, #s=) ──
  useEffect(() => {
    const code = readShareCodeFromUrl();
    if (code) {
      // strip the path so a refresh doesn't re-load
      window.history.replaceState(null, '', '/' + window.location.search);
      loadShareCode(code);
      return;
    }
    const rep = readReplayFromUrl();
    if (rep) {
      setReplayHand(rep);
      setView('replayer');
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      return;
    }
    const sc = readScenarioFromUrl();
    if (!sc) return;
    // strip hash so refreshes don't re-load
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    applySharedScenario(sc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Persist custom player names locally ──
  useEffect(() => {
    try { localStorage.setItem(NAMES_KEY, JSON.stringify(playerNames)); } catch {}
  }, [playerNames]);

  // ── History API ──
  const fetchHistoryPage = useCallback(async (params) => {
    const q = new URLSearchParams({ limit: String(HISTORY_PAGE), ...params });
    const r = await fetch(`/api/searches?${q}`, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    return { items: (data.searches || []).map(toHistoryItem), nextCursor: data.nextCursor || null };
  }, []);

  // first page. the spinner only shows when nothing is loaded yet; otherwise the
  // list stays up while it refreshes underneath
  const refreshHistory = useCallback(async () => {
    if (!user) { setHistory([]); setHistoryCursor(null); historyLoadedRef.current = false; return; }
    if (historyInflightRef.current) return historyInflightRef.current;
    if (!historyLoadedRef.current) setHistoryLoading(true);
    setHistoryError(null);
    const run = (async () => {
      try {
        const { items, nextCursor } = await fetchHistoryPage({});
        setHistory(items);
        setHistoryCursor(nextCursor);
        historyLoadedRef.current = true;
        starredLoadedRef.current = false;
      } catch (e) {
        setHistoryError(e.message || 'Network error');
      } finally {
        setHistoryLoading(false);
        historyInflightRef.current = null;
      }
    })();
    historyInflightRef.current = run;
    return run;
  }, [user, fetchHistoryPage]);

  // warm the list (and the database) right after sign-in so the drawer opens instantly
  useEffect(() => {
    if (user && !historyLoadedRef.current) refreshHistory();
  }, [user, refreshHistory]);

  const mergeHistory = (items) => setHistory(prev => {
    const seen = new Set(prev.map(h => h.id));
    return [...prev, ...items.filter(i => !seen.has(i.id))].sort((a, b) => b.ts - a.ts);
  });

  async function loadMoreHistory() {
    if (!historyCursor || historyLoadingMore) return;
    setHistoryLoadingMore(true);
    try {
      const { items, nextCursor } = await fetchHistoryPage({ cursor: historyCursor });
      mergeHistory(items);
      setHistoryCursor(nextCursor);
    } catch (e) {
      flashNotice(e.message || 'Could not load more');
    } finally {
      setHistoryLoadingMore(false);
    }
  }

  // favorites beyond the loaded pages, fetched once the Starred tab opens
  async function loadStarredHistory() {
    if (starredLoadedRef.current || !historyCursor) return;
    starredLoadedRef.current = true;
    try {
      const { items } = await fetchHistoryPage({ starred: '1', limit: '200' });
      mergeHistory(items);
    } catch {
      starredLoadedRef.current = false;
    }
  }

  // ── Pro short links ──
  const [links, setLinks] = useState(null); // null = not loaded yet
  const [linksLoading, setLinksLoading] = useState(false);
  const refreshLinks = useCallback(async () => {
    if (!user) { setLinks(null); return; }
    setLinksLoading(true);
    const res = await listShareLinks();
    setLinks(res.ok ? res.links || [] : []);
    setLinksLoading(false);
  }, [user]);
  useEffect(() => { if (!user) setLinks(null); }, [user]);

  async function deleteLink(code) {
    setLinks(prev => (prev || []).filter(l => l.code !== code));
    const res = await deleteShareLink(code);
    if (!res.ok) { flashNotice(res.error); refreshLinks(); }
  }
  async function renameLink(code, name) {
    setLinks(prev => (prev || []).map(l => (l.code === code ? { ...l, name: name || null } : l)));
    const res = await renameShareLink(code, name);
    if (!res.ok) { flashNotice(res.error); refreshLinks(); }
  }
  function openLink(code) {
    setShowHistory(false);
    loadShareCode(code);
  }

  // a replay by row id (the stats page's biggest-pot lists)
  async function openSavedHand(id) {
    const res = await safeFetchJson(`/api/searches/${id}`);
    const replay = res && res.search && res.search.replay;
    if (!replay) { flashNotice('Could not load that hand'); return; }
    commitToHistory();
    setReplayHand({ ...replay, savedId: id, favorited: !!res.search.favorite });
    setView('replayer');
  }

  // for both share modals; kind/payload come from the long url
  const shareShort = billingOn ? {
    pro: isPro,
    signedIn: !!user,
    onUpgrade: () => { setShowShare(false); setView('plans'); },
    create: async (kind, payload) => {
      const res = await createShareLink({ kind, payload });
      if (!res.ok) {
        if (res.code === 'pro_required') refreshPlan();
        return { ok: false, error: res.error };
      }
      if (links !== null) refreshLinks();
      return { ok: true, url: shortLinkUrl(res.link.code) };
    },
  } : null;

  function openHistory() {
    setShowHistory(true);
    refreshHistory();
    if (billingOn) refreshLinks();
  }

  async function toggleFavorite(id, favorite) {
    setHistory(prev => prev.map(h => h.id === id ? { ...h, starred: favorite } : h));
    try {
      const r = await fetch(`/api/searches/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite }),
      });
      if (!r.ok) throw new Error('save failed');
    } catch {
      setHistory(prev => prev.map(h => h.id === id ? { ...h, starred: !favorite } : h));
    }
  }

  async function deleteHistoryItem(id) {
    const prev = history;
    setHistory(h => h.filter(x => x.id !== id));
    try {
      const r = await fetch(`/api/searches/${id}`, { method: 'DELETE', credentials: 'include' });
      if (!r.ok) throw new Error('delete failed');
    } catch {
      setHistory(prev);
    }
  }

  async function clearAllUnfavorited() {
    setHistory(h => h.filter(x => x.starred));
    setHistoryCursor(null);
    try {
      const r = await fetch('/api/searches', { method: 'DELETE', credentials: 'include' });
      if (!r.ok) throw new Error();
      refreshPlan();
    } catch {
      flashNotice('Could not clear history');
      refreshHistory();
    }
  }

  function touchHistoryItem(id) {
    // LRU: mark this hand as recently used so it survives the cap
    if (!user || !id) return;
    fetch(`/api/searches/${id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touch: true }),
    }).catch(() => {});
  }

  async function loadHistoryItem(item) {
    touchHistoryItem(item.id);
    // Replays reopen in the replayer instead of loading into the calculator.
    if (item.isReplay && item.replay) {
      let replay = item.replay;
      if (replay.slim) {
        // the list only carries a preview; pull the full hand now
        const res = await safeFetchJson(`/api/searches/${item.id}`);
        if (!res || !res.search || !res.search.replay) { flashNotice('Could not load that hand'); return; }
        replay = res.search.replay;
      }
      commitToHistory();
      setReplayHand({ ...replay, savedId: item.id, favorited: !!item.starred });
      setView('replayer');
      setShowHistory(false);
      return;
    }
    const sc = decodeScenario(item.scenario);
    if (!sc) return;
    commitToHistory(); // save whatever hand was in progress before replacing it
    setView('calc'); // a calculator scenario opens in the calculator, even from the replayer
    setPlayers(sc.players);
    setBoard(sc.board);
    setPlayerNames(sc.playerNames);
    setPot(sc.pot);
    setCallAmt(sc.callAmt);
    // Don't re-save the item we just loaded unless the user changes it.
    lastSavedScenarioRef.current = encodeScenario({
      players: sc.players, board: sc.board, playerNames: sc.playerNames,
      pot: sc.pot, callAmt: sc.callAmt,
    });
    setShowHistory(false);
  }

  function openShare() {
    setShareUrl(buildShareUrl({ players, board, playerNames, pot, callAmt }));
    setShowShare(true);
  }

  function openReplayer() {
    commitToHistory();
    setReplayHand(null);
    setView('replayer');
    setShowHistory(false);
  }

  // Persist a replay to history (DB-backed, like a normal saved hand but with
  // isReplay + the full replay payload). hand = { setup, actions, board }.
  async function saveReplayToHistory(hand, summary) {
    if (!user) { signIn(); return null; }
    const seats = (hand.setup && hand.setup.seats) || [];
    const playersForRow = seats.map(s =>
      s.cards && s.cards.length === 2 ? { kind: 'hand', hand: s.cards } : null
    );
    try {
      const r = await fetch('/api/searches', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: summary && summary.blindsLabel ? `Replay · ${summary.blindsLabel}` : 'Replay',
          players: playersForRow,
          board: hand.board || [],
          odds: {},
          isReplay: true,
          replay: hand,
          favorite: true,
        }),
      });
      if (r.ok) {
        const data = await safeJson(r);
        noteLimit(data);
        refreshPlan();
        if (showHistory) refreshHistory();
        return data && data.search ? data.search.id : null;
      }
    } catch {
      /* swallow — replayer shows its own optimistic toast */
    }
    return null;
  }

  function openUpload() {
    if (!user) { signIn(); return; }
    setUploadOpen(true);
  }

  // save each imported hand as a favorited replay, then open history
  async function onImportConfirm(chosen, meta) {
    setUploadOpen(false);
    setImportToast(`Importing ${chosen.length} hand${chosen.length === 1 ? '' : 's'}…`);
    let saved = 0;
    let lastSave = null;
    // one import = one session; each hand carries its own stats so the stats page stays cheap
    const session = { id: 's' + Date.now().toString(36), label: sessionLabel(meta && meta.fileName), at: new Date().toISOString() };
    for (const h of chosen) {
      const seats = (h.replay && h.replay.setup && h.replay.setup.seats) || [];
      const playersForRow = seats.map(s =>
        s.cards && s.cards.length === 2 ? { kind: 'hand', hand: s.cards } : null
      );
      const replay = { ...h.replay, session, stats: analyzeHand(h.replay) };
      try {
        const r = await fetch('/api/searches', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: `Hand #${h.number}`,
            players: playersForRow,
            board: (h.replay && h.replay.board) || [],
            odds: {},
            isReplay: true,
            replay,
            favorite: false,
          }),
        });
        if (r.ok) {
          saved++;
          lastSave = await safeJson(r);
        }
      } catch { /* skip a failed hand, keep importing the rest */ }
    }
    await refreshHistory();
    refreshPlan();
    noteLimit(lastSave);
    setShowHistory(true);
    flashImport(`${saved} hand${saved === 1 ? '' : 's'} added to history`);
  }

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
  }, [theme]);

  const usedCards = useMemo(() => {
    const out = [];
    players.forEach(p => { if (p && p.kind === 'hand') out.push(...p.hand); });
    out.push(...board);
    return out;
  }, [players, board]);

  // Only preflop (0), flop (3), turn (4), river (5) are valid streets.
  const validBoard = board.length === 0 || board.length === 3 || board.length === 4 || board.length === 5;
  // Clear all only matters once something is on the table.
  const hasEntry = players.some(Boolean) || board.length > 0 || playerNames.some(Boolean);

  useEffect(() => {
    const myVer = ++calcVersion.current;
    const active = players.some(p => p && ((p.kind === 'hand' && p.hand.length === 2) || (p.kind === 'range' && p.range.length > 0)));
    if (!active || !validBoard) { setResults({ perPlayer: {}, sims: 0 }); setCalculating(false); return; }
    setCalculating(true);

    inFlightWorkersRef.current.forEach(w => w.terminate());
    inFlightWorkersRef.current = [];

    const t = setTimeout(() => {
      if (myVer !== calcVersion.current) return;

      const N = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8));
      const MAX_SIMS_TOTAL = 1_000_000;
      const BATCH_SIZE = 5000;
      const SE_THRESHOLD = 0.0005;
      const MIN_SIMS_FOR_CHECK = 10_000;
      const maxPerWorker = Math.ceil(MAX_SIMS_TOTAL / N);

      const workers = [];
      const aggWins = {}, aggTies = {}, aggTieShares = {};
      let aggValid = 0;
      let stopped = false;
      let doneCount = 0;

      function buildPerPlayer() {
        const perPlayer = {};
        for (const idx of Object.keys(aggWins)) {
          perPlayer[idx] = {
            win: aggValid ? (aggWins[idx] / aggValid) * 100 : 0,
            tie: aggValid ? (aggTies[idx] / aggValid) * 100 : 0,
            equity: aggValid ? ((aggWins[idx] + aggTieShares[idx]) / aggValid) * 100 : 0,
          };
        }
        return perPlayer;
      }

      function finalize() {
        if (myVer !== calcVersion.current) return;
        workers.forEach(w => w.terminate());
        setResults({ perPlayer: buildPerPlayer(), sims: aggValid });
        setCalculating(false);
      }

      function checkConvergence() {
        if (stopped || aggValid < MIN_SIMS_FOR_CHECK) return;
        let maxSE = 0;
        for (const idx of Object.keys(aggWins)) {
          const p = (aggWins[idx] + aggTieShares[idx]) / aggValid;
          const se = Math.sqrt(p * (1 - p) / aggValid);
          if (se > maxSE) maxSE = se;
        }
        if (maxSE < SE_THRESHOLD) {
          stopped = true;
          finalize();
        }
      }

      for (let i = 0; i < N; i++) {
        const worker = new Worker(new URL('./equityWorker.js', import.meta.url), { type: 'module' });
        workers.push(worker);
        worker.onmessage = (e) => {
          if (e.data.jobId !== myVer || stopped) return;
          if (e.data.type === 'batch') {
            aggValid += e.data.deltaValid;
            for (const idx of Object.keys(e.data.deltaWins)) {
              aggWins[idx] = (aggWins[idx] || 0) + e.data.deltaWins[idx];
              aggTies[idx] = (aggTies[idx] || 0) + e.data.deltaTies[idx];
              aggTieShares[idx] = (aggTieShares[idx] || 0) + e.data.deltaTieShares[idx];
            }
            setResults({ perPlayer: buildPerPlayer(), sims: aggValid });
            checkConvergence();
          } else if (e.data.type === 'done') {
            doneCount++;
            if (doneCount === N) finalize();
          }
        };
        worker.postMessage({
          jobId: myVer,
          players,
          board,
          maxSims: maxPerWorker,
          batchSize: BATCH_SIZE,
        });
      }
      inFlightWorkersRef.current = workers;
    }, 30);

    return () => {
      clearTimeout(t);
      inFlightWorkersRef.current.forEach(w => w.terminate());
      inFlightWorkersRef.current = [];
    };
  }, [players, board, validBoard]);

  function openPicker(seatIdx) {
    const existing = players[seatIdx];
    setPicker({
      seat: seatIdx,
      mode: existing && existing.kind === 'range' ? 'range' : 'hand',
      selectedCards: existing && existing.kind === 'hand' ? existing.hand : [],
      initialRange: existing && existing.kind === 'range' ? existing.range : [],
    });
  }
  function closePicker() { setPicker(null); }
  function commitHand(seatIdx, cards) {
    setPlayers(prev => {
      const n = [...prev];
      n[seatIdx] = { kind: 'hand', hand: cards };
      return n;
    });
    setPicker(null);
  }
  function commitRange(seatIdx, keys) {
    setPlayers(prev => {
      const n = [...prev];
      n[seatIdx] = { kind: 'range', range: keys };
      return n;
    });
    setPicker(null);
  }
  function removePlayer(seatIdx) {
    setPlayers(prev => { const n = [...prev]; n[seatIdx] = null; return n; });
  }

  function renamePlayer(seatIdx, newName) {
    setPlayerNames(prev => {
      const n = [...prev];
      n[seatIdx] = newName;
      return n;
    });
  }

  // Board entry by street: flop deals 3 at once, turn/river 1 each.
  function onDealBoard(street) {
    const at = street === 'flop' ? 0 : street === 'turn' ? 3 : 4;
    setBoardDeal({ street, at, need: street === 'flop' ? 3 : 1, selectedCards: [] });
  }
  function onClearBoardFrom(idx) {
    setBoard(prev => prev.slice(0, idx));
  }
  function pickBoardDealCard(c) {
    setBoardDeal(d => {
      const sel = [...d.selectedCards];
      const ix = sel.findIndex(x => x.v === c.v && x.s === c.s);
      if (ix >= 0) sel.splice(ix, 1);
      else if (sel.length < d.need) sel.push(c);
      return { ...d, selectedCards: sel };
    });
  }
  function confirmBoardDeal() {
    if (!boardDeal || boardDeal.selectedCards.length !== boardDeal.need) return;
    setBoard(prev => [...prev.filter(Boolean).slice(0, boardDeal.at), ...boardDeal.selectedCards]);
    setBoardDeal(null);
  }

  const potNum = parseFloat(pot) || 0;
  const callNum = parseFloat(callAmt) || 0;
  const potOddsEntered = potNum > 0 && callNum > 0;
  // pot = pot BEFORE opponent's bet, callAmt = opponent's bet (= what we'd call).
  const potOddsPct = potOddsEntered ? (callNum / (potNum + 2 * callNum)) * 100 : null;
  const mdfPct = potOddsEntered ? (potNum / (potNum + callNum)) * 100 : null;

  function clearAll() {
    commitToHistory();
    setPlayers(Array(9).fill(null));
    setBoard([]);
    setPlayerNames(Array(9).fill(null));
  }

  function saveHand() {
    if (!user) { signIn(); return; }
    setSaveError(null);
    setSaveModalOpen(true);
  }

  async function doSave(name) {
    setSaving(true);
    setSaveError(null);
    const scenario = encodeScenario({ players, board, playerNames, pot, callAmt });
    try {
      const r = await fetch('/api/searches', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name || null,
          players,
          board,
          playerNames,
          scenario,
          odds: results.perPlayer || {},
          favorite: true,
        }),
      });
      if (!r.ok) throw new Error('save failed');
      noteLimit(await safeJson(r));
      refreshPlan();
      // Mark as already-committed so the boundary auto-save won't duplicate it.
      lastSavedScenarioRef.current = scenario;
      setSaveModalOpen(false);
    } catch {
      setSaveError('Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

  // ── Keep the current committable hand snapshot fresh (no network) ──
  useEffect(() => {
    const hasActive = players.some(p => p && (
      (p.kind === 'hand' && p.hand.length === 2) ||
      (p.kind === 'range' && p.range.length > 0)
    ));
    if (!hasActive || !validBoard || !results.sims) {
      currentSnapshotRef.current = null;
      return;
    }
    currentSnapshotRef.current = {
      players,
      board,
      playerNames,
      pot,
      callAmt,
      odds: results.perPlayer || {},
      scenario: encodeScenario({ players, board, playerNames, pot, callAmt }),
    };
  }, [results, players, board, playerNames, pot, callAmt, validBoard]);

  // ── Commit the current hand to history (once per distinct hand) ──
  // Called at hand boundaries; deduped so the same spot isn't saved twice.
  const commitToHistory = useCallback((useBeacon = false) => {
    if (!user) return;
    const snap = currentSnapshotRef.current;
    if (!snap || snap.scenario === lastSavedScenarioRef.current) return;
    lastSavedScenarioRef.current = snap.scenario;
    const body = JSON.stringify({
      name: null,
      players: snap.players,
      board: snap.board,
      playerNames: snap.playerNames,
      scenario: snap.scenario,
      odds: snap.odds,
    });
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon('/api/searches', new Blob([body], { type: 'application/json' }));
    } else {
      fetch('/api/searches', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => { lastSavedScenarioRef.current = null; });
    }
  }, [user]);

  // ── Commit on page exit (tab close / navigate away / backgrounded) ──
  useEffect(() => {
    if (!user) return;
    const onHide = () => commitToHistory(true);
    const onVis = () => { if (document.visibilityState === 'hidden') commitToHistory(true); };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [user, commitToHistory]);

  function dealRandom() {
    commitToHistory();
    const deck = PokerEngine.makeDeck();
    for (let i = deck.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const numPlayers = 2 + ((Math.random() * 8) | 0);
    const seats = Array.from({ length: 9 }, (_, i) => i);
    for (let i = seats.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [seats[i], seats[j]] = [seats[j], seats[i]];
    }
    const chosen = seats.slice(0, numPlayers);
    const newP = Array(9).fill(null);
    for (const s of chosen) newP[s] = { kind: 'hand', hand: [deck.pop(), deck.pop()] };
    // Random street: preflop / flop / turn / river — uniform.
    const STREETS = [0, 3, 4, 5];
    const boardSize = STREETS[(Math.random() * STREETS.length) | 0];
    const newBoard = [];
    for (let i = 0; i < boardSize; i++) newBoard.push(deck.pop());
    setPlayers(newP);
    setBoard(newBoard);
  }

  // profile menu + history drawer, shared across views; menu items are page-aware
  const signInEl = (
    <button className="btn btn-signin" onClick={signIn}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><path d="M10 17l5-5-5-5" /><path d="M15 12H3" />
      </svg>
      Sign in
    </button>
  );
  const accountMenuFor = (ctx) => user ? (
    <UserChip
      user={user}
      plan={billingOn ? plan : null}
      onSignOut={signOut}
      onOpenHistory={ctx !== 'solver' ? openHistory : undefined}
      onOpenShare={ctx === 'calc' ? openShare : undefined}
      onOpenUpload={ctx !== 'solver' ? openUpload : undefined}
      onUpgrade={billingOn && ctx !== 'solver' ? () => setView('plans') : undefined}
      onOpenStats={ctx !== 'solver' ? () => { setShowHistory(false); setView('stats'); } : undefined}
      onManage={billingOn && ctx !== 'solver' ? async () => { const res = await openPortal(); if (res && res.error) flashNotice(res.error); } : undefined}
    />
  ) : signInEl;
  const themeToggleEl = (
    <button className="icon-btn" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} aria-label="Toggle theme" title="Toggle theme">
      <ThemeIcon theme={theme} />
    </button>
  );
  const historyDrawerEl = (
    <HistoryDrawer
      open={showHistory}
      onClose={() => setShowHistory(false)}
      history={history}
      loading={historyLoading}
      error={historyError}
      onLoad={loadHistoryItem}
      onToggleFavorite={toggleFavorite}
      onDelete={deleteHistoryItem}
      onClear={clearAllUnfavorited}
      user={user}
      cap={plan.saveCap}
      hasMore={!!historyCursor}
      loadingMore={historyLoadingMore}
      onLoadMore={loadMoreHistory}
      onNeedStarred={loadStarredHistory}
      links={billingOn && (isPro || (links && links.length > 0)) ? links || [] : undefined}
      linksLoading={linksLoading}
      linkUrl={shortLinkUrl}
      onOpenLink={openLink}
      onDeleteLink={deleteLink}
      onRenameLink={renameLink}
    />
  );

  // overlays render in every view
  const sharedOverlays = (
    <>
      <ShareModal open={showShare} onClose={() => setShowShare(false)} url={shareUrl} short={shareShort} />
      <UploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} onConfirm={onImportConfirm} />
      <UpgradePrompt
        open={limitPrompt}
        cap={plan.saveCap}
        limits={plan.limits}
        busy={upgradeBusy}
        onClose={() => setLimitPrompt(false)}
        onCompare={() => { setLimitPrompt(false); setView('plans'); }}
        onUpgrade={upgradeNow}
      />
      {(sharedToast || importToast || noticeToast) && (
        <div className="shared-toast">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5" />
          </svg>
          {noticeToast || importToast || 'Loaded shared scenario'}
        </div>
      )}
    </>
  );

  // The replayer takes over the whole screen when active.
  if (view === 'replayer') {
    return (
      <>
        <ReplayerView
          initialHand={replayHand}
          onExit={() => setView('calc')}
          onSaveToHistory={saveReplayToHistory}
          onSetFavorite={toggleFavorite}
          userMenu={accountMenuFor('replayer')}
          themeToggle={themeToggleEl}
          historyDrawer={historyDrawerEl}
          shareShort={shareShort}
        />
        {sharedOverlays}
      </>
    );
  }

  if (view === 'stats') {
    return (
      <>
        <StatsView
          onExit={() => setView('calc')}
          onNavigate={(v) => { if (v === 'replayer') openReplayer(); else setView(v); }}
          themeToggle={themeToggleEl}
          userMenu={accountMenuFor('stats')}
          user={user}
          plan={plan}
          onUpgrade={() => setView('plans')}
          onOpenHand={openSavedHand}
        />
        {sharedOverlays}
      </>
    );
  }

  if (view === 'plans') {
    return (
      <>
        <PlansView
          onExit={() => setView('calc')}
          onNavigate={(v) => { if (v === 'replayer') openReplayer(); else setView(v); }}
          themeToggle={themeToggleEl}
          userMenu={accountMenuFor('plans')}
          user={user}
          plan={plan}
          onGetPro={startCheckout}
          onCreateAccount={() => signIn({ mode: 'signup' })}
          onManage={openPortal}
        />
        {sharedOverlays}
      </>
    );
  }

  // The solver is its own full-screen mode.
  if (view === 'solver') {
    return (
      <>
        <SolverView
          onExit={() => setView('calc')}
          theme={theme}
          onToggleTheme={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
          userMenu={accountMenuFor('solver')}
        />
        {sharedOverlays}
      </>
    );
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <div className="brand-mark"><span className="accent">Poker</span>Lab</div>
        </div>
        <div className="toolbar">
          {calculating && (
            <div className="status-bar">
              <span className="dot-pulse" /> calculating · {results.sims.toLocaleString()} sims
            </div>
          )}
          {hasEntry && <button className="btn btn-ghost" onClick={clearAll}>Clear all</button>}
          <button className="btn btn-ghost btn-replayer" onClick={openReplayer} title="Open the hand replayer">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            Replayer
          </button>
          <button className="btn btn-ghost btn-solver" onClick={() => setView('solver')} title="Heads-up river GTO solver">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3v18h18" /><path d="M7 14l3-4 3 2 4-6" />
            </svg>
            Solver
          </button>
          {billingOn && !isPro && (
            <button className="btn btn-ghost btn-pro" onClick={() => setView('plans')} title="PokerLab Pro">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /></svg>
              Pro
            </button>
          )}
          {user && (
            <button className="btn btn-ghost" onClick={saveHand} disabled={saving}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
              {saving ? 'Saving…' : 'Favorite'}
            </button>
          )}
        </div>
        <div className="topbar-account">
          {themeToggleEl}
          {accountMenuFor('calc')}
        </div>
      </div>

      <div className="stage-wrap">
        <StageScaler>
          {(compact) => (
          <div className={'stage' + (compact ? ' compact' : '')} style={compact ? { width: CALC_STAGE_COMPACT.w, height: CALC_STAGE_COMPACT.h } : null}>
            <div className="felt-rim" />
            <div className="felt" />

            {/* Board */}
            <div
              className={"board-label" + (!validBoard ? ' board-label-warn' : '')}
              style={compact ? { top: `calc(${COMPACT_BOARD_Y}% + 48px)` } : null}
            >
              {board.length === 0 ? 'Pre-flop' :
               board.length === 1 ? 'Incomplete flop · need 2 more cards' :
               board.length === 2 ? 'Incomplete flop · need 1 more card' :
               board.length === 3 ? 'Flop' :
               board.length === 4 ? 'Turn' :
               'River'}
            </div>
            <div className="board" style={compact ? { top: COMPACT_BOARD_Y + '%' } : null}>
              <BoardStrip board={board} onDeal={onDealBoard} onClearFrom={onClearBoardFrom} size={compact ? 'md' : 'lg'} />
            </div>
            {/* Seats */}
            {(compact ? SEAT_POSITIONS_COMPACT : SEAT_POSITIONS).map((pos, i) => (
              <div key={i} className="seat-wrap" style={{ left: pos.x + '%', top: pos.y + '%' }}>
                <PlayerSeat
                  index={i}
                  player={players[i]}
                  active={picker && picker.seat === i}
                  onOpen={() => openPicker(i)}
                  onRemove={() => removePlayer(i)}
                  equity={results.perPlayer[i] || null}
                  name={playerNames[i]}
                  onRename={(nm) => renamePlayer(i, nm)}
                  compact={compact}
                />
              </div>
            ))}
          </div>
          )}
        </StageScaler>
      </div>

      <ResultsPanel
        players={players}
        playerNames={playerNames}
        results={results}
        boardLen={board.length}
        validBoard={validBoard}
        pot={pot} setPot={setPot}
        callAmt={callAmt} setCallAmt={setCallAmt}
        potOddsPct={potOddsPct}
        mdfPct={mdfPct}
        oddsMode={oddsMode} setOddsMode={setOddsMode}
      />

      {picker && (
        <SeatPickerModal
          picker={picker}
          setPicker={setPicker}
          usedCards={usedCards}
          existingPlayer={players[picker.seat]}
          onCancel={closePicker}
          onCommitHand={(cards) => commitHand(picker.seat, cards)}
          onCommitRange={(keys) => commitRange(picker.seat, keys)}
        />
      )}
      {boardDeal && (
        <div className="picker-overlay" onClick={(e) => { if (e.target === e.currentTarget) setBoardDeal(null); }}>
          <CardPicker
            title={'Deal ' + boardDeal.street}
            usedCards={usedCards}
            selected={boardDeal.selectedCards}
            maxCards={boardDeal.need}
            onPick={pickBoardDealCard}
            onConfirm={confirmBoardDeal}
            onClear={() => setBoardDeal(d => ({ ...d, selectedCards: [] }))}
            onClose={() => setBoardDeal(null)}
          />
        </div>
      )}

      {historyDrawerEl}
      <SaveModal
        open={saveModalOpen}
        busy={saving}
        error={saveError}
        onClose={() => setSaveModalOpen(false)}
        onSave={doSave}
      />
      {sharedOverlays}
    </div>
  );
}

// ─── SaveModal — name-and-save a hand (replaces window.prompt) ───
function SaveModal({ open, busy, error, onClose, onSave }) {
  const [name, setName] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setName('');
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="picker-overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="share-modal" role="dialog" aria-label="Save hand">
        <div className="share-head">
          <div>
            <div className="auth-title">Favorite hand</div>
            <div className="auth-sub">Star this spot to keep it in history. Name it, or leave blank.</div>
          </div>
          <button className="modal-x" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </div>
        <form
          className="share-body"
          onSubmit={(e) => { e.preventDefault(); onSave(name.trim()); }}
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <input
            ref={inputRef}
            className="share-link"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (optional)"
            maxLength={80}
          />
          {error && <div style={{ color: 'var(--red)', fontSize: 12 }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Favorite'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── UserChip — avatar dropdown in the topbar ───
// omitted handlers hide their menu items
function UserChip({ user, plan, onSignOut, onOpenHistory, onOpenShare, onOpenUpload, onOpenStats, onUpgrade, onManage }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const initial = (user.name || user.email || '?')[0].toUpperCase();
  const isPro = !!plan && plan.plan === 'pro';
  const avatar = user.image
    ? <img src={user.image} alt="" className="user-avatar user-avatar-img" />
    : <span className="user-avatar">{initial}</span>;
  return (
    <div className="user-chip-wrap" ref={ref}>
      <button className="user-chip" onClick={() => setOpen(o => !o)}>
        {avatar}
        <span className="user-chip-name">{user.name || user.email}</span>
        <span className="user-chip-caret">▾</span>
      </button>
      {open && (
        <div className="user-menu">
          <div className="user-menu-head">
            <div className="user-menu-name">
              <span>{user.name || 'Account'}</span>
              {isPro && <span className="pro-badge">PRO</span>}
            </div>
            <div className="user-menu-email">{user.email}</div>
            {plan && (
              <div className="user-menu-plan">
                {isPro
                  ? `Pro plan · ${plan.interval === 'year' ? 'annual' : 'monthly'}`
                  : `Free plan · ${Math.min(plan.saved, plan.saveCap)} of ${plan.saveCap} hands saved`}
              </div>
            )}
          </div>
          {onOpenUpload && (
            <button className="user-menu-item" onClick={() => { setOpen(false); onOpenUpload(); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M5 16v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
              </svg>
              Import PokerNow log
            </button>
          )}
          {onOpenHistory && (
            <button className="user-menu-item" onClick={() => { setOpen(false); onOpenHistory(); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" />
              </svg>
              Hand history
            </button>
          )}
          {onOpenStats && (
            <button className="user-menu-item" onClick={() => { setOpen(false); onOpenStats(); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3v18h18" /><rect x="7" y="12" width="3" height="6" /><rect x="12" y="8" width="3" height="10" /><rect x="17" y="5" width="3" height="13" />
              </svg>
              Session stats
            </button>
          )}
          {onOpenShare && (
            <button className="user-menu-item" onClick={() => { setOpen(false); onOpenShare(); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
              </svg>
              Share
            </button>
          )}
          {onUpgrade && !isPro && (
            <button className="user-menu-item pro" onClick={() => { setOpen(false); onUpgrade(); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
              </svg>
              Upgrade to Pro
            </button>
          )}
          {onManage && isPro && (
            <button className="user-menu-item" onClick={() => { setOpen(false); onManage(); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" />
              </svg>
              Manage subscription
            </button>
          )}
          <button className="user-menu-item danger" onClick={() => { setOpen(false); onSignOut(); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" />
            </svg>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Map a Search row from /api/searches to a HistoryRow item ───
function toHistoryItem(s) {
  // Replay rows map straight from the stored replay payload (no equity recompute).
  if (s.isReplay && s.replay) {
    const rep = s.replay;
    const seats = (rep.setup && rep.setup.seats) || [];
    const repBoard = Array.isArray(rep.board) ? rep.board : [];
    // imports say who the hero is; older rows fall back to the first seat holding cards
    const heroSeat = rep.hero != null && seats[rep.hero] && seats[rep.hero].cards ? rep.hero : seats.findIndex(x => x && x.cards && x.cards.length === 2);
    const nameOf = (i) => (seats[i] && (seats[i].name || seats[i].pos)) || `Player ${i + 1}`;
    return {
      id: s.id,
      ts: s.createdAt ? new Date(s.createdAt).getTime() : Date.now(),
      name: s.name || null,
      isReplay: true,
      replay: rep,
      scenario: null,
      playerCount: seats.length,
      boardLen: repBoard.length,
      boardPreview: repBoard.slice(0, 5),
      heroCards: heroSeat >= 0 ? seats[heroSeat].cards : null,
      heroLabel: null,
      heroName: heroSeat >= 0 ? nameOf(heroSeat) : null,
      heroEquity: null,
      topName: null,
      topEquity: null,
      blindsLabel: rep.setup ? `${rep.setup.sb}/${rep.setup.bb}` : null,
      actionCount: rep.actionCount ?? (Array.isArray(rep.actions) ? rep.actions.length : 0),
      starred: !!s.favorite,
    };
  }

  const players = Array.isArray(s.players) ? s.players : [];
  const board = Array.isArray(s.board) ? s.board : [];
  const odds = s.odds || {};
  const playerNames = Array.isArray(s.playerNames) ? s.playerNames : [];

  const activeIdx = players.map((p, i) => p ? i : -1).filter(i => i >= 0);
  const heroIdx = activeIdx.find(i => players[i] && players[i].kind === 'hand') ?? activeIdx[0] ?? 0;
  const hero = players[heroIdx];
  const heroEq = odds[heroIdx];

  let topIdx = activeIdx[0] ?? 0;
  let topEq = -1;
  activeIdx.forEach(i => {
    const e = odds[i];
    if (e && e.equity > topEq) { topEq = e.equity; topIdx = i; }
  });

  const nameOf = (i) => playerNames[i] || `Player ${i + 1}`;
  const scenario = s.scenario || encodeScenario({
    players, board, playerNames,
    pot: s.pot || '', callAmt: s.callAmt || '',
  });

  return {
    id: s.id,
    ts: s.createdAt ? new Date(s.createdAt).getTime() : Date.now(),
    name: s.name || null,
    scenario,
    playerCount: activeIdx.length,
    boardLen: board.length,
    boardPreview: board.slice(0, 5),
    heroCards: hero && hero.kind === 'hand' ? hero.hand : null,
    heroLabel: hero && hero.kind === 'range' ? `${hero.rangeCount ?? hero.range?.length ?? 0} combos` : null,
    heroName: nameOf(heroIdx),
    heroEquity: heroEq ? heroEq.equity : null,
    topName: nameOf(topIdx),
    topEquity: topEq >= 0 ? topEq : null,
    starred: !!s.favorite,
  };
}

function StageScaler({ children }) {
  const ref = useRef(null);
  const [scale, setScale] = useState(1);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    function update() {
      const el = ref.current;
      if (!el) return;
      const wrapW = el.parentElement.clientWidth - 8;
      const c = wrapW > 0 && wrapW < 600;
      const S = c ? CALC_STAGE_COMPACT : CALC_STAGE;
      const s = Math.min(wrapW / S.w, 1);
      setCompact(c);
      setScale(s > 0 ? s : 1);
    }
    update();
    const ro = new ResizeObserver(update);
    if (ref.current && ref.current.parentElement) ro.observe(ref.current.parentElement);
    window.addEventListener('resize', update);
    return () => { ro.disconnect(); window.removeEventListener('resize', update); };
  }, []);
  const S = compact ? CALC_STAGE_COMPACT : CALC_STAGE;
  return (
    <div ref={ref} className="stage-scaler" style={{
      width: Math.floor(S.w * scale),
      height: Math.floor(S.h * scale),
    }}>
      <div className="stage-inner" style={{
        width: S.w,
        height: S.h,
        transform: `scale(${scale})`,
      }}>
        {children(compact)}
      </div>
    </div>
  );
}

function SeatPickerModal({ picker, setPicker, usedCards, existingPlayer, onCancel, onCommitHand, onCommitRange }) {
  function setMode(m) { setPicker(p => ({ ...p, mode: m })); }
  function pickHandCard(c) {
    setPicker(p => {
      const sel = [...p.selectedCards];
      const ix = sel.findIndex(x => x.v === c.v && x.s === c.s);
      if (ix >= 0) sel.splice(ix, 1);
      else if (sel.length < 2) sel.push(c);
      return { ...p, selectedCards: sel };
    });
  }
  function clearHand() { setPicker(p => ({ ...p, selectedCards: [] })); }
  function confirmHand() {
    if (picker.selectedCards.length === 2) onCommitHand(picker.selectedCards);
  }

  const ownPrev = existingPlayer && existingPlayer.kind === 'hand' ? existingPlayer.hand : [];
  const ownSet = new Set(ownPrev.map(c => c.v + c.s));
  const usedForPicker = usedCards.filter(c => !ownSet.has(c.v + c.s));

  return (
    <div className="picker-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="picker" style={{ width: 760 }}>
        <div className="picker-head">
          <div>
            <div className="picker-title">Player {picker.seat + 1}</div>
            <div className="picker-sub">
              {picker.mode === 'hand'
                ? `${picker.selectedCards.length} / 2 cards selected`
                : 'Drag to paint cells · click to toggle'}
            </div>
          </div>
          <div className="picker-mode">
            <button className={'picker-tab ' + (picker.mode === 'hand' ? 'active' : '')} onClick={() => setMode('hand')}>Hand</button>
            <button className={'picker-tab ' + (picker.mode === 'range' ? 'active' : '')} onClick={() => setMode('range')}>Range</button>
          </div>
        </div>

        {picker.mode === 'hand' ? (
          <>
            <div style={{ padding: '14px 20px 0', display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {Array.from({ length: 2 }).map((_, i) => (
                  picker.selectedCards[i]
                    ? <PlayingCard key={i} card={picker.selectedCards[i]} size="sm" />
                    : <EmptyCardSlot key={i} size="sm" label="" />
                ))}
              </div>
            </div>
            <CardGridOnly
              usedCards={usedForPicker}
              selected={picker.selectedCards}
              onPick={pickHandCard}
            />
            <div className="picker-foot">
              <button className="btn btn-ghost" onClick={clearHand}>Clear</button>
              <div className="picker-foot-right">
                <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
                <button className="btn btn-primary" disabled={picker.selectedCards.length !== 2} onClick={confirmHand}>Confirm hand</button>
              </div>
            </div>
          </>
        ) : (
          <RangePicker
            initial={picker.initialRange}
            onCancel={onCancel}
            onSave={onCommitRange}
          />
        )}
      </div>
    </div>
  );
}

function CardGridOnly({ usedCards, selected, onPick }) {
  const usedSet = new Set(usedCards.map(c => c.v + c.s));
  const selSet = new Set(selected.map(c => c.v + c.s));
  return (
    <div className="picker-grid">
      {SUIT_ORDER.map(s => (
        <div key={s} className="picker-row">
          {VALUE_ORDER.map(v => {
            const id = v + s;
            const isUsed = usedSet.has(id) && !selSet.has(id);
            const isSelected = selSet.has(id);
            return (
              <button
                key={id}
                className={'pcard ' + (isUsed ? 'used ' : '') + (isSelected ? 'selected ' : '') + (SUIT_RED[s] ? 'red ' : 'ink ')}
                disabled={isUsed}
                onClick={() => onPick({ v, s })}
              >
                <span className={"pcard-rank" + (v === 'T' ? ' is-ten' : '')}>{v === 'T' ? '10' : v}</span>
                <span className="pcard-suit"><SuitGlyph suit={s} size={19} color="currentColor" /></span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function ResultsPanel({ players, playerNames, results, boardLen, validBoard, pot, setPot, callAmt, setCallAmt, potOddsPct, mdfPct, oddsMode, setOddsMode }) {
  const active = players.map((p, i) => ({ p, i })).filter(x => x.p);
  const nameOf = (i) => (playerNames && playerNames[i]) || `Player ${i + 1}`;
  const haveResults = Object.keys(results.perPlayer).length > 0;

  function describe(p) {
    if (!p) return null;
    if (p.kind === 'hand') return p.hand.map(c => (c.v === 'T' ? '10' : c.v) + SUIT_GLYPH[c.s]).join(' ');
    if (p.kind === 'range') return `Range · ${p.range.length} hands`;
  }

  return (
    <div className="results">
      <div>
        <div className="results-head">
          <div className="results-title">Equity Breakdown</div>
          <div className="results-meta">
            {!validBoard
              ? `board needs 0, 3, 4, or 5 cards · currently ${boardLen}`
              : haveResults && oddsMode === 'potOdds' && potOddsPct != null
                ? `pot odds threshold: ${potOddsPct.toFixed(1)}%`
                : haveResults && oddsMode === 'mdf' && mdfPct != null
                  ? `min defense frequency: ${mdfPct.toFixed(1)}%`
                  : ''}
          </div>
        </div>
        {active.length === 0 ? (
          <div className="results-empty" style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-faint)', fontSize: 12 }}>
            Click any seat to deal cards or assign a range.
          </div>
        ) : (
          <table className="results-table">
            <thead>
              <tr>
                <th style={{ width: 130 }}>Player</th>
                <th style={{ width: 160 }}>Holding</th>
                <th className="num">Win</th>
                <th className="num">Tie</th>
                <th className="num">Equity</th>
                <th className="equity-cell">Vs. pot odds</th>
              </tr>
            </thead>
            <tbody>
              {active.map(({ p, i }) => {
                const eq = results.perPlayer[i];
                const equity = eq ? eq.equity : 0;
                const beatsPotOdds = potOddsPct != null && equity >= potOddsPct;
                const useColor = oddsMode === 'potOdds' && potOddsPct != null;
                const rowClass = !useColor ? 'eq-row-neutral' : (beatsPotOdds ? 'eq-row-pos' : 'eq-row-neg');
                return (
                  <tr key={i} className={rowClass}>
                    <td>
                      <div className="player-cell">
                        <span className="player-dot" style={{ background: !useColor ? 'var(--text-faint)' : (beatsPotOdds ? 'var(--green)' : 'var(--gold)') }} />
                        {nameOf(i)}
                      </div>
                    </td>
                    <td style={{ color: 'var(--text-dim)' }}>{describe(p)}</td>
                    <td className="num">{eq ? eq.win.toFixed(1) + '%' : '-'}</td>
                    <td className="num">{eq ? eq.tie.toFixed(1) + '%' : '-'}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{eq ? eq.equity.toFixed(1) + '%' : '-'}</td>
                    <td className="equity-cell">
                      <div className="eq-track"><div className="eq-track-fill" style={{ width: equity + '%' }} /></div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className={"pot-odds" + ((oddsMode === 'mdf' ? mdfPct : potOddsPct) == null ? ' pot-odds-empty' : '')}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <h4>{oddsMode === 'mdf' ? 'MDF' : 'Pot Odds'}</h4>
          <div className="odds-toggle" role="tablist">
            <button type="button" className={'odds-toggle-btn ' + (oddsMode === 'potOdds' ? 'active' : '')} onClick={() => setOddsMode('potOdds')}>Pot Odds</button>
            <button type="button" className={'odds-toggle-btn ' + (oddsMode === 'mdf' ? 'active' : '')} onClick={() => setOddsMode('mdf')}>MDF</button>
          </div>
        </div>
        <div className="pot-input-row">
          <div className="pot-input-wrap">
            <label>{oddsMode === 'mdf' ? 'Pot (before bet)' : 'Pot'}</label>
            <input className="pot-input" type="number" min="0" placeholder="0" value={pot} onChange={e => setPot(e.target.value)} />
          </div>
          <div className="pot-input-wrap">
            <label>{oddsMode === 'mdf' ? 'Bet' : 'To call'}</label>
            <input className="pot-input" type="number" min="0" placeholder="0" value={callAmt} onChange={e => setCallAmt(e.target.value)} />
          </div>
        </div>
        {oddsMode === 'mdf' ? (
          <>
            <div className="pot-result">
              <div className="pot-result-row">
                <span className="lbl">MDF</span>
                <span className="val">{mdfPct == null ? 'N/A' : mdfPct.toFixed(1) + '%'}</span>
              </div>
              <div className="pot-result-row">
                <span className="lbl">Bet : pot</span>
                <span className="val" style={{ fontSize: 13 }}>
                  {mdfPct == null
                    ? 'N/A'
                    : <>{callAmt}<span style={{ color: 'var(--text-dim)', margin: '0 4px' }}>into</span>{pot}</>}
                </span>
              </div>
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5, letterSpacing: 0.01, marginTop: 4 }}>
              {mdfPct == null
                ? ''
                : 'Defend at least this share of your continuing range to remain unexploitable to bluffs.'}
            </div>
          </>
        ) : (
          <>
            <div className="pot-result">
              <div className="pot-result-row">
                <span className="lbl">Pot odds</span>
                <span className="val">{potOddsPct == null ? 'N/A' : potOddsPct.toFixed(1) + '%'}</span>
              </div>
              <div className="pot-result-row">
                <span className="lbl">Risk : reward</span>
                <span className="val" style={{ fontSize: 13 }}>
                  {potOddsPct == null
                    ? 'N/A'
                    : <>{callAmt}<span style={{ color: 'var(--text-dim)', margin: '0 4px' }}>to win</span>{(parseFloat(pot) || 0) + (parseFloat(callAmt) || 0)}</>}
                </span>
              </div>
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5, letterSpacing: 0.01, marginTop: 4 }}>
              {potOddsPct == null
                ? ''
                : "A call is profitable when a player's equity exceeds the pot odds threshold."}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
