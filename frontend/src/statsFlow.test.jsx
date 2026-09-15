import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import App from './App.jsx';
import { AuthProvider } from './AuthContext.jsx';
import { UploadModal } from './UploadModal.jsx';
import { parsePokerNowLog, convertHandsFor, convertAllHands } from './pokernowImport.js';

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

const proStatus = ok({ plan: 'pro', interval: 'year', saveCap: 25, saved: 0, billingEnabled: true });
// a fresh identity per test: StatsView caches its hands per user for the module's lifetime
let seq = 0;
const nextUser = () => ({ name: 'Arun', email: `a${++seq}@b.c` });

const renderApp = () => render(<AuthProvider><App /></AuthProvider>);
const findChip = () => screen.findByRole('button', { name: /Arun/ });
const toastText = () => document.querySelector('.shared-toast')?.textContent;

// ── PokerNow fixtures ──
const pnPlayer = (seat, id, name) => ({ seat, id, name, stack: 10000 });
const pnHand = (n, players) => ({
  number: String(n), gameType: 'th', dealerSeat: players[0].seat,
  smallBlind: 50, bigBlind: 100, players, events: [],
});
const PN_AB = () => [pnPlayer(0, 'p_alice', 'alice'), pnPlayer(1, 'p_bob', 'bob')];
const pnAbLog = (nums) => ({ playerId: 'p_alice', hands: nums.map((n) => pnHand(n, PN_AB())) });
const rawOf = (log) => parsePokerNowLog(JSON.stringify(log)).rawHands;
const REPLAY = convertHandsFor(rawOf(pnAbLog([1])), 'p_alice')[0].replay;

function dropPnLog(scope, log, name = 'friday-cash.json') {
  const file = new File([JSON.stringify(log)], name, { type: 'application/json' });
  fireEvent.change(scope.querySelector('input[type="file"]'), { target: { files: [file] } });
}
const enterHand = (input, v) => {
  fireEvent.change(input, { target: { value: v } });
  fireEvent.keyDown(input, { key: 'Enter' });
};

// menu -> upload modal -> pick alice -> queue the given hand numbers -> Import
async function importHands(nums, fileName) {
  fireEvent.click(await findChip());
  fireEvent.click(screen.getByRole('button', { name: 'Import PokerNow log' }));
  const dialog = screen.getByRole('dialog', { name: 'Upload PokerNow log' });
  dropPnLog(dialog, pnAbLog(nums), fileName);
  fireEvent.click((await screen.findByText('alice')).closest('button'));
  enterHand(screen.getByPlaceholderText(/Type a hand number/), nums.join(' '));
  fireEvent.click(screen.getByRole('button', { name: `Import ${nums.length} hand${nums.length === 1 ? '' : 's'}` }));
}

beforeEach(() => {
  localStorage.clear();
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

describe('import pipeline carries the hero seat and the file name', () => {
  // seats 0/2/5 with the button on 2: order becomes [2, 5, 0]
  const spreadHand = () => ({
    number: '1', gameType: 'th', dealerSeat: 2, smallBlind: 50, bigBlind: 100,
    players: [pnPlayer(0, 'p_alice', 'alice'), pnPlayer(2, 'p_bob', 'bob'), pnPlayer(5, 'p_carol', 'carol')],
    events: [],
  });

  it('records the chosen player at their seat index after the button reorder', () => {
    const raw = [spreadHand()];
    const bob = convertHandsFor(raw, 'p_bob')[0];
    expect(bob.replay.hero).toBe(0); // physical seat 2 is the button
    expect(bob.replay.setup.seats[0].pos).toBe('BTN');

    const carol = convertHandsFor(raw, 'p_carol')[0];
    expect(carol.replay.hero).toBe(1);
    expect(carol.replay.setup.seats[1].name).toBe('carol');

    const alice = convertHandsFor(raw, 'p_alice')[0];
    expect(alice.replay.hero).toBe(2);
    expect(alice.replay.setup.seats[2].pos).toBe('BB');
  });

  it('leaves hero null when the pivot player was not in the hand', () => {
    const [h] = convertAllHands([spreadHand()], 'p_dave');
    expect(h.replay.hero).toBeNull();
    expect(convertAllHands([spreadHand()], 'p_bob')[0].replay.hero).toBe(0);
  });

  it('UploadModal hands the file name back with the chosen hands', async () => {
    const onConfirm = vi.fn();
    const { container } = render(<UploadModal open onClose={vi.fn()} onConfirm={onConfirm} />);
    dropPnLog(container, pnAbLog([7]), 'friday-cash.json');
    fireEvent.click((await screen.findByText('alice')).closest('button'));
    enterHand(screen.getByPlaceholderText(/Type a hand number/), '7');
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 hand' }));
    expect(onConfirm.mock.calls[0][1]).toEqual({ fileName: 'friday-cash.json' });
  });
});

describe('an import tags every hand with one session and its own stats', () => {
  it('stamps a shared session and per-hand stats onto each saved replay', async () => {
    const posts = [];
    mockFetch({
      '/api/auth/session': ok({ user: nextUser() }),
      '/api/searches': (u, o) => {
        if (((o && o.method) || 'GET') === 'POST') { posts.push(JSON.parse(o.body)); return ok({ search: { id: 'n' + posts.length } }); }
        return ok({ searches: [] });
      },
    });
    const before = new Date().toISOString();
    renderApp();
    await findChip();
    await importHands([1, 2], 'friday-cash.json');
    await waitFor(() => expect(posts).toHaveLength(2));

    const sessions = posts.map(p => p.replay.session);
    expect(sessions[0].id).toMatch(/^s[0-9a-z]+$/);
    expect(sessions[1]).toEqual(sessions[0]); // one import, one session
    expect(sessions[0].label).toBe('friday-cash');
    expect(sessions[0].at >= before).toBe(true);
    expect(new Date(sessions[0].at).toISOString()).toBe(sessions[0].at);

    for (const p of posts) {
      expect(p.replay.stats).toMatchObject({ v: 2, hero: 0, pos: 'BTN', players: 2, bb: 100, cents: true, net: -50 });
      expect(p.replay.setup).toBeTruthy(); // the replay itself still rides along
    }
  });

  it('labels the session null when the log arrived without a usable name', async () => {
    const posts = [];
    mockFetch({
      '/api/auth/session': ok({ user: nextUser() }),
      '/api/searches': (u, o) => {
        if (((o && o.method) || 'GET') === 'POST') { posts.push(JSON.parse(o.body)); return ok({ search: { id: 'n1' } }); }
        return ok({ searches: [] });
      },
    });
    renderApp();
    await findChip();
    await importHands([1], '.json');
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].replay.session.label).toBeNull();
  });
});

describe('the stats page inside the app', () => {
  const statsRow = (id, over = {}) => ({
    id, name: 'PokerNow #' + id, createdAt: '2026-09-01T10:00:00Z',
    session: { id: 's1', label: 'friday', at: '2026-09-01T10:00:00Z' },
    stats: {
      v: 1, hero: 0, pos: 'BTN', players: 2, bb: 100, cents: true,
      vpip: true, pfr: true, tbOpp: false, tb: false, flop: true, sd: false, wsd: false,
      agg: 1, calls: 0, net: 1000, pot: 2000, ...over,
    },
  });

  const signedInPro = (routes = {}) => mockFetch({
    '/api/auth/session': ok({ user: nextUser() }),
    '/api/billing/status': proStatus,
    ...routes,
  });

  it('opens from the account menu on the calculator', async () => {
    signedInPro({ '/api/stats/hands': ok({ hands: [] }) });
    renderApp();
    fireEvent.click(await findChip());
    fireEvent.click(screen.getByText('Session stats'));
    expect(await screen.findByRole('heading', { name: 'Session stats' })).toBeInTheDocument();
    expect(document.querySelector('.user-menu')).toBeNull();
    expect(await screen.findByText('No imported hands yet')).toBeInTheDocument();
  });

  it('opens from the replayer account menu too, and the brand mark goes back to the calculator', async () => {
    signedInPro({ '/api/stats/hands': ok({ hands: [] }), '/api/searches': ok({ searches: [] }) });
    renderApp();
    await findChip();
    fireEvent.click(screen.getByRole('button', { name: 'Replayer' }));
    fireEvent.click(await findChip());
    fireEvent.click(screen.getByText('Session stats'));
    expect(await screen.findByRole('heading', { name: 'Session stats' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'PokerLab' }));
    expect(screen.getByText('Pot odds')).toBeInTheDocument();
  });

  it('a biggest-pot row pulls the full hand and hands it to the replayer', async () => {
    signedInPro({
      '/api/stats/hands': ok({ hands: [statsRow('h1')] }),
      '/api/searches/h1': ok({ search: { id: 'h1', replay: REPLAY, favorite: true } }),
      '/api/searches': ok({ searches: [] }),
    });
    renderApp();
    fireEvent.click(await findChip());
    fireEvent.click(screen.getByText('Session stats'));
    const row = await screen.findByRole('button', { name: /PokerNow #h1/ });
    fireEvent.click(row);

    expect(await screen.findByText('Hand Replayer')).toBeInTheDocument();
    expect(screen.getByText('Blinds posted')).toBeInTheDocument();
    expect(callsTo('/api/searches/h1', 'GET')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '✓ Favorited' })).toBeInTheDocument(); // the row's saved star came along
  });

  it('flashes a notice and stays put when that hand cannot be fetched', async () => {
    signedInPro({
      '/api/stats/hands': ok({ hands: [statsRow('h1')] }),
      '/api/searches/h1': fail(404),
      '/api/searches': ok({ searches: [] }),
    });
    renderApp();
    fireEvent.click(await findChip());
    fireEvent.click(screen.getByText('Session stats'));
    fireEvent.click(await screen.findByRole('button', { name: /PokerNow #h1/ }));

    await waitFor(() => expect(toastText()).toBe('Could not load that hand'));
    expect(screen.getByRole('heading', { name: 'Session stats' })).toBeInTheDocument();
    expect(screen.queryByText('Hand Replayer')).toBeNull();
  });

  it('a free account is shown the Pro pitch and can jump to the plans page', async () => {
    mockFetch({
      '/api/auth/session': ok({ user: nextUser() }),
      '/api/billing/status': ok({ plan: 'free', saveCap: 25, saved: 0, billingEnabled: true }),
    });
    renderApp();
    fireEvent.click(await findChip());
    fireEvent.click(screen.getByText('Session stats'));
    expect(await screen.findByText('Session stats is a Pro feature')).toBeInTheDocument();
    expect(callsTo('/api/stats/hands')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'See Pro' }));
    expect(await screen.findByRole('heading', { name: 'Study for free. Keep everything with Pro.' })).toBeInTheDocument();
  });

  it('the Pro plan list advertises session stats', async () => {
    mockFetch({ '/api/auth/session': ok({ user: nextUser() }), '/api/billing/status': ok({ plan: 'free', saveCap: 25, saved: 0, billingEnabled: true }) });
    renderApp();
    await findChip();
    fireEvent.click(screen.getByRole('button', { name: /Pro/ }));
    expect(await screen.findByText('Session stats from your PokerNow imports')).toBeInTheDocument();
  });
});
