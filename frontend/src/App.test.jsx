import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import App from './App.jsx';
import { AuthProvider } from './AuthContext.jsx';
import { encodeScenario, buildShareUrl } from './scenario.js';
import { encodeReplay } from './replayShare.js';

class FakeWorker {
  constructor() { FakeWorker.instances.push(this); this.onmessage = null; this.posted = []; this.terminated = false; }
  postMessage(m) { this.posted.push(m); }
  terminate() { this.terminated = true; }
}
FakeWorker.instances = [];

const ok = (data) => ({ ok: true, status: 200, json: async () => data });
const fail = (status = 500) => ({ ok: false, status, json: async () => ({}) });

// url-substring router; first matching key wins, sane auth defaults
function mockFetch(routes = {}) {
  const fn = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    for (const key of Object.keys(routes)) {
      if (u.includes(key)) {
        const h = routes[key];
        return typeof h === 'function' ? h(u, opts) : h;
      }
    }
    if (u.includes('/api/auth/session')) return ok({ user: null });
    if (u.includes('/api/auth/providers')) return ok({});
    if (u.includes('/api/auth/csrf')) return ok({ csrfToken: 'tok' });
    return fail(404);
  });
  global.fetch = fn;
  return fn;
}

const callsTo = (substr, method) =>
  global.fetch.mock.calls.filter(([u, o]) =>
    String(u).includes(substr) && (!method || ((o && o.method) || 'GET') === method));

const c = (s) => ({ v: s[0], s: s[1] });
const USER = { name: 'Arun', email: 'a@b.c' };
const P_AA = { kind: 'hand', hand: [c('As'), c('Ah')] };
const P_KK = { kind: 'hand', hand: [c('Ks'), c('Kh')] };

const scenarioEnc = (pot = '', callAmt = '') => encodeScenario({
  players: [P_AA, P_KK], board: [], playerNames: ['Hero', 'Villain'], pot, callAmt,
});

const histRow = (id, over = {}) => ({
  id, players: [P_AA, P_KK], board: [], playerNames: ['Hero', 'Villain'],
  odds: {}, favorite: false, createdAt: '2026-01-01T00:00:00Z',
  scenario: scenarioEnc('100', '50'), ...over,
});

const REPLAY_HAND = {
  setup: {
    sb: 50, bb: 100, ante: 0, cents: false,
    seats: [
      { name: 'rex', stack: 10000, pos: 'BTN', cards: null },
      { name: 'pranad', stack: 8000, pos: 'SB', cards: [c('Ah'), c('Kh')] },
      { name: 'luc', stack: 12000, pos: 'BB', cards: [c('Qd'), c('Qs')] },
    ],
  },
  actions: [
    { seat: 0, type: 'fold', street: 0 },
    { seat: 1, type: 'call', street: 0 },
    { seat: 2, type: 'check', street: 0 },
  ],
  board: [c('2c'), c('7d'), c('Jh')],
  board2: null, won: null, runResults: null,
};

const renderApp = () => render(
  <AuthProvider>
    <App />
  </AuthProvider>
);

const potInputs = () => {
  const [pot, call] = screen.getAllByPlaceholderText('0');
  return { pot, call };
};
const setPotCall = (p, ca) => {
  const { pot, call } = potInputs();
  fireEvent.change(pot, { target: { value: p } });
  fireEvent.change(call, { target: { value: ca } });
};
const resultRow = (lbl) => screen.getByText(lbl, { selector: 'span.lbl' }).closest('.pot-result-row');
const rowVal = (lbl) => resultRow(lbl).querySelector('.val').textContent;

async function liveWorker() {
  await waitFor(() => {
    expect(FakeWorker.instances.some((w) => !w.terminated && w.posted.length > 0)).toBe(true);
  });
  const live = FakeWorker.instances.filter((w) => !w.terminated && w.posted.length > 0);
  return live[live.length - 1];
}

// equities: P0 (800+25)/1000 = 82.5%, P1 (150+25)/1000 = 17.5%
function pushBatch(w) {
  act(() => {
    w.onmessage({
      data: {
        jobId: w.posted[0].jobId, type: 'batch', deltaValid: 1000,
        deltaWins: { 0: 800, 1: 150 },
        deltaTies: { 0: 50, 1: 50 },
        deltaTieShares: { 0: 25, 1: 25 },
      },
    });
  });
}

const findChip = () => screen.findByRole('button', { name: /Arun/ });

function dealFlop() {
  fireEvent.click(document.querySelectorAll('.board .board-strip-btn')[0]);
  ['A of s', 'K of d', 'Q of h'].forEach((l) => fireEvent.click(screen.getByLabelText(l)));
  fireEvent.click(document.querySelector('.picker-foot .btn-primary'));
}

async function openDrawer() {
  fireEvent.click(await findChip());
  fireEvent.click(screen.getByText('Hand history'));
  return screen.findByRole('dialog', { name: 'Hand history' });
}

const readBlob = (blob) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(fr.result);
  fr.onerror = rej;
  fr.readAsText(blob);
});

// minimal convertible PokerNow log (empty events still yield a valid replay)
const pnPlayer = (seat, id, name) => ({ seat, id, name, stack: 10000 });
const pnHand = (n, players) => ({
  number: String(n), gameType: 'th', dealerSeat: players[0].seat,
  smallBlind: 50, bigBlind: 100, players, events: [],
});
const PN_AB = () => [pnPlayer(0, 'p_alice', 'alice'), pnPlayer(1, 'p_bob', 'bob')];
const pnAbLog = (nums) => ({ playerId: 'p_alice', hands: nums.map((n) => pnHand(n, PN_AB())) });
function dropPnLog(scope, log) {
  const file = new File([JSON.stringify(log)], 'log.json', { type: 'application/json' });
  fireEvent.change(scope.querySelector('input[type="file"]'), { target: { files: [file] } });
}
const enterHand = (input, v) => {
  fireEvent.change(input, { target: { value: v } });
  fireEvent.keyDown(input, { key: 'Enter' });
};

beforeEach(() => {
  localStorage.clear();
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete navigator.sendBeacon;
  delete document.visibilityState;
  window.history.replaceState(null, '', '/');
});

describe('App (calculator)', () => {
  it('renders the toolbar and the pot-odds panel', () => {
    renderApp();
    expect(screen.queryByRole('button', { name: /clear all/i })).toBeNull(); // hidden until there's an entry
    expect(screen.getByRole('button', { name: /replayer/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /solver/i })).toBeInTheDocument();
    expect(screen.getByText('Pot odds')).toBeInTheDocument();
    expect(screen.getAllByPlaceholderText('0').length).toBeGreaterThanOrEqual(2);
  });

  it('computes pot odds from the pot and call inputs', () => {
    renderApp();
    const inputs = screen.getAllByPlaceholderText('0');
    fireEvent.change(inputs[0], { target: { value: '100' } });
    fireEvent.change(inputs[1], { target: { value: '50' } });
    expect(screen.getByText('25.0%')).toBeInTheDocument();
  });

  it('deals the board flop as one button, with turn and river locked until prior streets', () => {
    renderApp();
    const strip = () => document.querySelectorAll('.board .board-strip-btn');
    expect(strip()).toHaveLength(3);
    expect(strip()[0].title).toBe('Deal flop');
    expect(strip()[1]).toBeDisabled();
    expect(strip()[2]).toBeDisabled();
    dealFlop();
    expect(document.querySelector('.picker-overlay')).toBeNull();
    expect(strip()[0].querySelectorAll('.board-flop-cards > *')).toHaveLength(3);
    expect(strip()[1]).not.toBeDisabled();
  });

  it('Clear all is hidden until there is an entry, and disappears again after clearing', () => {
    renderApp();
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
    dealFlop();
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
  });
});

describe('ResultsPanel pot odds / MDF', () => {
  it('MDF toggle swaps the heading and input labels both ways', () => {
    renderApp();
    expect(screen.getByRole('heading', { name: 'Pot Odds' })).toBeInTheDocument();
    expect(screen.getByText('Pot')).toBeInTheDocument();
    expect(screen.getByText('To call')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'MDF' }));
    expect(screen.getByRole('heading', { name: 'MDF' })).toBeInTheDocument();
    expect(screen.getByText('Pot (before bet)')).toBeInTheDocument();
    expect(screen.getByText('Bet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pot Odds' }));
    expect(screen.getByRole('heading', { name: 'Pot Odds' })).toBeInTheDocument();
    expect(screen.getByText('To call')).toBeInTheDocument();
  });

  it('computes MDF = pot/(pot+bet) and renders the bet-into-pot line', () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'MDF' }));
    setPotCall('100', '50');
    expect(rowVal('MDF')).toBe('66.7%');
    expect(resultRow('Bet : pot').textContent).toMatch(/50into100/);
  });

  it('shows N/A for empty, zero, negative, and non-numeric inputs in both modes', () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'MDF' }));
    expect(rowVal('MDF')).toBe('N/A');
    expect(rowVal('Bet : pot')).toBe('N/A');
    setPotCall('100', '0');
    expect(rowVal('MDF')).toBe('N/A');
    fireEvent.click(screen.getByRole('button', { name: 'Pot Odds' }));
    setPotCall('-50', '50');
    expect(rowVal('Pot odds')).toBe('N/A');
    expect(rowVal('Risk : reward')).toBe('N/A');
    setPotCall('abc', '50');
    expect(rowVal('Pot odds')).toBe('N/A');
  });

  it('risk : reward shows the call amount to win pot+call', () => {
    renderApp();
    setPotCall('100', '50');
    expect(resultRow('Risk : reward').textContent).toMatch(/50to win150/);
  });

  it('toggling MDF and back preserves the entered amounts', () => {
    renderApp();
    setPotCall('100', '50');
    expect(rowVal('Pot odds')).toBe('25.0%');
    fireEvent.click(screen.getByRole('button', { name: 'MDF' }));
    expect(rowVal('MDF')).toBe('66.7%');
    fireEvent.click(screen.getByRole('button', { name: 'Pot Odds' }));
    expect(rowVal('Pot odds')).toBe('25.0%');
    expect(potInputs().pot).toHaveValue(100);
    expect(potInputs().call).toHaveValue(50);
  });

  it('colors rows vs pot odds, neutralizes them in MDF, and gates the meta header on results', async () => {
    window.location.hash = '#s=' + scenarioEnc();
    renderApp();
    const w = await liveWorker();
    setPotCall('100', '50');
    expect(document.querySelector('.results-meta').textContent).toBe('');
    pushBatch(w);
    expect(screen.getAllByText('82.5%').length).toBeGreaterThan(0);
    expect(document.querySelector('.results-meta').textContent).toBe('pot odds threshold: 25.0%');
    const rows = () => document.querySelectorAll('.results-table tbody tr');
    expect(rows()[0].className).toBe('eq-row-pos');
    expect(rows()[1].className).toBe('eq-row-neg');
    fireEvent.click(screen.getByRole('button', { name: 'MDF' }));
    expect(rows()[0].className).toBe('eq-row-neutral');
    expect(rows()[1].className).toBe('eq-row-neutral');
    expect(document.querySelector('.results-meta').textContent).toBe('min defense frequency: 66.7%');
  });
});

describe('optimistic history CRUD', () => {
  it('star fills before the PATCH resolves, sends {favorite:true}, and reverts on a failed response', async () => {
    let resolvePatch;
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/searches/h1': () => new Promise((res) => { resolvePatch = res; }),
      '/api/searches': ok({ searches: [histRow('h1', { name: 'one' })] }),
    });
    renderApp();
    await openDrawer();
    const row = (await screen.findByText('one')).closest('.hist-row');
    fireEvent.click(within(row).getByLabelText('Favorite'));
    expect(within(row).getByLabelText('Unfavorite')).toBeInTheDocument();
    const [, opts] = callsTo('/api/searches/h1', 'PATCH')[0];
    expect(opts.credentials).toBe('include');
    expect(JSON.parse(opts.body)).toEqual({ favorite: true });
    await act(async () => { resolvePatch(fail(500)); });
    expect(within(row).getByLabelText('Favorite')).toBeInTheDocument();
  });

  it('star also reverts when the PATCH rejects', async () => {
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/searches/h1': () => { throw new Error('net'); },
      '/api/searches': ok({ searches: [histRow('h1', { name: 'one' })] }),
    });
    renderApp();
    await openDrawer();
    const row = (await screen.findByText('one')).closest('.hist-row');
    fireEvent.click(within(row).getByLabelText('Favorite'));
    expect(within(row).getByLabelText('Unfavorite')).toBeInTheDocument();
    await waitFor(() => expect(within(row).getByLabelText('Favorite')).toBeInTheDocument());
  });

  it('delete removes the row immediately, issues the DELETE, and restores on failure', async () => {
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/searches/h1': () => { throw new Error('net'); },
      '/api/searches': ok({ searches: [histRow('h1', { name: 'one' })] }),
    });
    renderApp();
    await openDrawer();
    await screen.findByText('one');
    fireEvent.click(screen.getByLabelText('Delete'));
    expect(screen.queryByText('one')).toBeNull();
    const dels = callsTo('/api/searches/h1', 'DELETE');
    expect(dels).toHaveLength(1);
    expect(dels[0][1].credentials).toBe('include');
    expect(await screen.findByText('one')).toBeInTheDocument();
  });

  it('clear-all sends one bulk delete, keeps starred rows, and does not roll back on failure', async () => {
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/searches/': () => { throw new Error('net'); },
      '/api/searches': ok({
        searches: [
          histRow('h1', { name: 'one' }),
          histRow('h2', { name: 'two', favorite: true }),
          histRow('h3', { name: 'three' }),
        ],
      }),
    });
    renderApp();
    const drawer = await openDrawer();
    await screen.findByText('one');
    fireEvent.click(within(drawer).getByText('Clear all'));
    fireEvent.click(within(drawer).getByText('Clear'));
    expect(screen.queryByText('one')).toBeNull();
    expect(screen.queryByText('three')).toBeNull();
    expect(screen.getByText('two')).toBeInTheDocument();
    const delUrls = callsTo('/api/searches', 'DELETE').map(([u]) => String(u));
    expect(delUrls).toEqual(['/api/searches']);
    await act(async () => {});
    expect(screen.queryByText('one')).toBeNull();
    expect(screen.getByText('two')).toBeInTheDocument();
  });

  it('loading a scenario row touches it and fills the calculator', async () => {
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/searches/h1': ok({}),
      '/api/searches': ok({ searches: [histRow('h1', { name: 'one' })] }),
    });
    renderApp();
    await openDrawer();
    fireEvent.click(await screen.findByText('one'));
    const patches = callsTo('/api/searches/h1', 'PATCH');
    expect(patches).toHaveLength(1);
    expect(JSON.parse(patches[0][1].body)).toEqual({ touch: true });
    expect(screen.queryByRole('dialog', { name: 'Hand history' })).toBeNull();
    expect(potInputs().pot).toHaveValue(100);
    expect(potInputs().call).toHaveValue(50);
    expect(screen.getAllByText('Hero').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Villain').length).toBeGreaterThan(0);
  });

  it('loading a replay row touches it and opens the replayer instead of the calculator', async () => {
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/searches/r1': ok({}),
      '/api/searches': ok({
        searches: [{ id: 'r1', isReplay: true, replay: REPLAY_HAND, favorite: false, createdAt: '2026-01-01T00:00:00Z' }],
      }),
    });
    renderApp();
    await openDrawer();
    fireEvent.click(await screen.findByText('Full hand'));
    expect(JSON.parse(callsTo('/api/searches/r1', 'PATCH')[0][1].body)).toEqual({ touch: true });
    expect(await screen.findByText('Hand Replayer')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Hand history' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upload log' })).toBeNull();
  });
});

describe('auto-save commitToHistory + page-exit', () => {
  async function signedInSnapshot(extraRoutes = {}) {
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/searches': ok({ search: { id: 'x' } }),
      ...extraRoutes,
    });
    window.location.hash = '#s=' + scenarioEnc();
    renderApp();
    await findChip();
    pushBatch(await liveWorker());
    fireEvent.change(potInputs().pot, { target: { value: '100' } });
  }

  it('clearAll with no snapshot issues no POST', async () => {
    mockFetch({ '/api/auth/session': ok({ user: USER }) });
    renderApp();
    await findChip();
    dealFlop(); // a board-only entry surfaces Clear all but makes no savable snapshot (no players)
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(callsTo('/api/searches', 'POST')).toHaveLength(0);
  });

  it('clearAll commits the snapshot once with the full body and keepalive', async () => {
    await signedInSnapshot();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    const posts = callsTo('/api/searches', 'POST');
    expect(posts).toHaveLength(1);
    const [, opts] = posts[0];
    expect(opts.keepalive).toBe(true);
    expect(opts.credentials).toBe('include');
    const body = JSON.parse(opts.body);
    expect(body.name).toBeNull();
    expect(body.players[0]).toEqual(P_AA);
    expect(body.players[1]).toEqual(P_KK);
    expect(body.board).toEqual([]);
    expect(body.playerNames.slice(0, 2)).toEqual(['Hero', 'Villain']);
    expect(body.scenario).toBe(scenarioEnc('100', ''));
    expect(body.odds[0].equity).toBeCloseTo(82.5, 5);
  });

  it('pagehide commits via fetch once and dedupes the second boundary', async () => {
    await signedInSnapshot();
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(callsTo('/api/searches', 'POST')).toHaveLength(1);
    expect(callsTo('/api/searches', 'POST')[0][1].keepalive).toBe(true);
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(callsTo('/api/searches', 'POST')).toHaveLength(1);
  });

  it('uses sendBeacon when hidden via visibilitychange, and ignores visible', async () => {
    await signedInSnapshot();
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(beacon).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, blob] = beacon.mock.calls[0];
    expect(url).toBe('/api/searches');
    expect(blob.type).toBe('application/json');
    const body = JSON.parse(await readBlob(blob));
    expect(body.name).toBeNull();
    expect(body.scenario).toBe(scenarioEnc('100', ''));
    expect(callsTo('/api/searches', 'POST')).toHaveLength(0);
  });

  it('a rejected commit POST resets the dedupe ref so the next boundary retries', async () => {
    await signedInSnapshot({
      '/api/searches': (u, o) => {
        if (((o && o.method) || 'GET') === 'POST') throw new Error('net');
        return ok({ searches: [] });
      },
    });
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(callsTo('/api/searches', 'POST')).toHaveLength(1);
    await act(async () => {});
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(callsTo('/api/searches', 'POST')).toHaveLength(2);
  });

  it('signed out, a boundary never commits even with a populated snapshot', async () => {
    window.location.hash = '#s=' + scenarioEnc();
    renderApp();
    pushBatch(await liveWorker());
    fireEvent.change(potInputs().pot, { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(callsTo('/api/searches', 'POST')).toHaveLength(0);
  });

  it('loading a history item pre-marks it saved, so an exit boundary does not re-save it', async () => {
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/searches/h1': ok({}),
      '/api/searches': ok({ searches: [histRow('h1', { name: 'one' })] }),
    });
    renderApp();
    await openDrawer();
    fireEvent.click(await screen.findByText('one'));
    pushBatch(await liveWorker());
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(callsTo('/api/searches', 'POST')).toHaveLength(0);
  });
});

describe('view switching and toolbar gating', () => {
  it('Solver replaces the calculator and Back returns', () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Solver' }));
    expect(screen.getByText('Spot configuration')).toBeInTheDocument();
    expect(document.querySelector('.sv-mode-badge').textContent).toContain('Solver');
    expect(screen.queryByRole('button', { name: 'Replayer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Solver' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'Replayer' })).toBeInTheDocument();
  });

  it('Replayer commits the pending hand before taking over, and exits back to calc', async () => {
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/searches': ok({ search: { id: 'x' } }),
    });
    window.location.hash = '#s=' + scenarioEnc();
    renderApp();
    await findChip();
    pushBatch(await liveWorker());
    fireEvent.change(potInputs().pot, { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replayer' }));
    expect(callsTo('/api/searches', 'POST')).toHaveLength(1);
    expect(screen.getByText('Hand Replayer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
    fireEvent.click(document.querySelector('.replayer-back'));
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument();
  });

  it('signed out: no Favorite button, and no upload entry (it lives in the account menu)', async () => {
    renderApp();
    await screen.findByRole('button', { name: /sign in/i });
    expect(screen.queryByRole('button', { name: 'Favorite' })).toBeNull();
    expect(screen.queryByRole('button', { name: /upload log|import pokernow/i })).toBeNull();
  });

  it('signed in: Favorite renders and the account menu Import opens the upload modal', async () => {
    mockFetch({ '/api/auth/session': ok({ user: USER }) });
    renderApp();
    const chip = await findChip();
    expect(screen.getByRole('button', { name: 'Favorite' })).toBeInTheDocument();
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole('button', { name: 'Import PokerNow log' }));
    expect(screen.getByRole('dialog', { name: 'Upload PokerNow log' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Sign in' })).toBeNull();
  });

  it('the solver theme toggle flips the documentElement light class like the calc one', () => {
    renderApp();
    expect(document.documentElement.classList.contains('light')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Solver' }));
    fireEvent.click(screen.getByLabelText('Toggle theme'));
    expect(document.documentElement.classList.contains('light')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByLabelText('Toggle theme'));
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('the calc theme toggle is an svg icon in both states, never a text glyph', () => {
    renderApp();
    const btn = screen.getByLabelText('Toggle theme');
    expect(btn.querySelector('svg')).toBeInTheDocument();
    expect(btn.textContent).toBe('');
    fireEvent.click(btn); // light -> dark
    expect(btn.querySelector('svg')).toBeInTheDocument();
    expect(btn.textContent).toBe('');
  });
});

describe('context-aware account menu', () => {
  const openChipMenu = async () => { fireEvent.click(await findChip()); return document.querySelector('.user-menu'); };

  it('the replayer menu keeps Import and Hand history but drops Share', async () => {
    mockFetch({ '/api/auth/session': ok({ user: USER }), '/api/searches': ok({ searches: [] }) });
    renderApp();
    await findChip();
    fireEvent.click(screen.getByRole('button', { name: 'Replayer' }));
    expect(screen.getByText('Hand Replayer')).toBeInTheDocument();
    const menu = await openChipMenu();
    expect(menu.querySelectorAll('.user-menu-item')).toHaveLength(5);
    expect(within(menu).getByText('Import PokerNow log')).toBeInTheDocument();
    expect(within(menu).getByText('Hand history')).toBeInTheDocument();
    expect(within(menu).getByText('Session stats')).toBeInTheDocument();
    expect(within(menu).getByText('Upgrade to Pro')).toBeInTheDocument();
    expect(within(menu).getByText('Sign out')).toBeInTheDocument();
    expect(within(menu).queryByText('Share')).toBeNull();
  });

  it('the solver menu shows Sign out only', async () => {
    mockFetch({ '/api/auth/session': ok({ user: USER }) });
    renderApp();
    await findChip();
    fireEvent.click(screen.getByRole('button', { name: 'Solver' }));
    expect(screen.getByText('Spot configuration')).toBeInTheDocument();
    const menu = await openChipMenu();
    expect(menu.querySelectorAll('.user-menu-item')).toHaveLength(1);
    expect(within(menu).getByText('Sign out')).toBeInTheDocument();
    expect(within(menu).queryByText('Import PokerNow log')).toBeNull();
    expect(within(menu).queryByText('Hand history')).toBeNull();
    expect(within(menu).queryByText('Share')).toBeNull();
  });
});

describe('modal hoisting across views', () => {
  it('opens the upload dialog from the replayer account menu (was a silent no-op)', async () => {
    mockFetch({ '/api/auth/session': ok({ user: USER }), '/api/searches': ok({ searches: [] }) });
    renderApp();
    await findChip();
    fireEvent.click(screen.getByRole('button', { name: 'Replayer' }));
    fireEvent.click(await findChip());
    fireEvent.click(screen.getByRole('button', { name: 'Import PokerNow log' }));
    expect(screen.getByRole('dialog', { name: 'Upload PokerNow log' })).toBeInTheDocument();
  });

  it('completing a replayer import saves each hand as a replay and opens the history drawer', async () => {
    const posts = [];
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/searches': (u, o) => {
        if (((o && o.method) || 'GET') === 'POST') { posts.push(JSON.parse(o.body)); return ok({ search: { id: 'n' + posts.length } }); }
        return ok({ searches: [] });
      },
    });
    renderApp();
    await findChip();
    fireEvent.click(screen.getByRole('button', { name: 'Replayer' }));
    fireEvent.click(await findChip());
    fireEvent.click(screen.getByRole('button', { name: 'Import PokerNow log' }));
    const dialog = screen.getByRole('dialog', { name: 'Upload PokerNow log' });
    dropPnLog(dialog, pnAbLog([1]));
    fireEvent.click((await screen.findByText('alice')).closest('button'));
    enterHand(screen.getByPlaceholderText(/Type a hand number/), '1');
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 hand' }));
    expect(await screen.findByRole('dialog', { name: 'Hand history' })).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    expect(posts[0].isReplay).toBe(true);
    expect(posts[0].name).toBe('Hand #1');
    expect(screen.queryByRole('dialog', { name: 'Upload PokerNow log' })).toBeNull();
  });
});

describe('UserChip', () => {
  it('shows the name with an initial avatar, or an image avatar when set', async () => {
    mockFetch({ '/api/auth/session': ok({ user: USER }) });
    const { unmount } = renderApp();
    const chip = await findChip();
    expect(chip.querySelector('.user-avatar').textContent).toBe('A');
    expect(document.querySelector('img.user-avatar-img')).toBeNull();
    unmount();
    mockFetch({ '/api/auth/session': ok({ user: { ...USER, image: 'http://x/a.png' } }) });
    renderApp();
    await findChip();
    const img = document.querySelector('img.user-avatar-img');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'http://x/a.png');
  });

  it('opens a menu with the account header and the six items', async () => {
    mockFetch({ '/api/auth/session': ok({ user: USER }) });
    renderApp();
    fireEvent.click(await findChip());
    const menu = document.querySelector('.user-menu');
    expect(within(menu).getByText('Arun')).toBeInTheDocument();
    expect(within(menu).getByText('a@b.c')).toBeInTheDocument();
    expect(menu.querySelectorAll('.user-menu-item')).toHaveLength(6);
    expect(within(menu).getByText('Import PokerNow log')).toBeInTheDocument();
    expect(within(menu).getByText('Hand history')).toBeInTheDocument();
    expect(within(menu).getByText('Session stats')).toBeInTheDocument();
    expect(within(menu).getByText('Share')).toBeInTheDocument();
    expect(within(menu).getByText('Upgrade to Pro')).toBeInTheDocument();
    expect(within(menu).getByText('Sign out')).toBeInTheDocument();
  });

  it('Hand history closes the menu and opens the drawer; the list is prefetched at sign-in and refreshed on open', async () => {
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/searches': ok({ searches: [] }),
    });
    renderApp();
    fireEvent.click(await findChip());
    fireEvent.click(screen.getByText('Hand history'));
    expect(document.querySelector('.user-menu')).toBeNull();
    expect(await screen.findByRole('dialog', { name: 'Hand history' })).toBeInTheDocument();
    expect(await screen.findByText('No saved hands yet')).toBeInTheDocument();
    expect(callsTo('/api/searches', 'GET')).toHaveLength(2);
  });

  it('Share closes the menu and opens the share modal with the scenario url', async () => {
    mockFetch({ '/api/auth/session': ok({ user: USER }) });
    renderApp();
    fireEvent.click(await findChip());
    fireEvent.click(screen.getByText('Share'));
    expect(document.querySelector('.user-menu')).toBeNull();
    const expected = buildShareUrl({
      players: Array(9).fill(null), board: [],
      playerNames: Array(9).fill(null), pot: '', callAmt: '',
    });
    expect(expected).toContain('#s=');
    expect(screen.getByDisplayValue(expected)).toBeInTheDocument();
  });

  it('mousedown outside closes the menu; inside keeps it open', async () => {
    mockFetch({ '/api/auth/session': ok({ user: USER }) });
    renderApp();
    fireEvent.click(await findChip());
    fireEvent.mouseDown(screen.getByText('Hand history'));
    expect(document.querySelector('.user-menu')).not.toBeNull();
    fireEvent.mouseDown(document.body);
    expect(document.querySelector('.user-menu')).toBeNull();
  });

  it('Sign out POSTs /api/auth/signout and swaps the chip for the Sign in button', async () => {
    let signedIn = true;
    mockFetch({
      '/api/auth/signout': () => { signedIn = false; return ok({}); },
      '/api/auth/session': () => ok({ user: signedIn ? USER : null }),
    });
    renderApp();
    fireEvent.click(await findChip());
    fireEvent.click(screen.getByText('Sign out'));
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(callsTo('/api/auth/signout', 'POST')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Arun/ })).toBeNull();
  });
});

describe('URL hash auto-load', () => {
  it('loads a #s= scenario, strips the hash, and shows a toast that expires at 3.6s', async () => {
    vi.useFakeTimers();
    window.location.hash = '#s=' + scenarioEnc('100', '50');
    renderApp();
    await act(async () => {});
    expect(screen.getByText('Loaded shared scenario')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(screen.getAllByText('Hero').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Villain').length).toBeGreaterThan(0);
    expect(potInputs().pot).toHaveValue(100);
    expect(potInputs().call).toHaveValue(50);
    act(() => { vi.advanceTimersByTime(3599); });
    expect(screen.getByText('Loaded shared scenario')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText('Loaded shared scenario')).toBeNull();
  });

  it('a #r= replay hash mounts straight into the replayer and strips the hash', async () => {
    window.location.hash = '#r=' + encodeReplay(REPLAY_HAND);
    renderApp();
    expect(await screen.findByText('Hand Replayer')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(screen.getByText('rex')).toBeInTheDocument();
    expect(screen.getByText('Blinds posted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload log' })).toBeNull();
  });

  it('a hash-loaded scenario is pre-marked saved, so the first boundary does not auto-save', async () => {
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/searches': ok({ search: { id: 'x' } }),
    });
    window.location.hash = '#s=' + scenarioEnc();
    renderApp();
    await findChip();
    pushBatch(await liveWorker());
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(callsTo('/api/searches', 'POST')).toHaveLength(0);
  });
});
