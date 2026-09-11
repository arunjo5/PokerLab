import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StatsView } from './StatsView.jsx';
import { parsePokerNowLog, convertHandsFor } from './pokernowImport.js';

const ok = (data) => ({ ok: true, status: 200, json: async () => data });
const fail = (status = 500) => ({ ok: false, status, json: async () => ({}) });
const errored = (error, status = 500) => ({ ok: false, status, json: async () => ({ error }) });

// url-substring router; first matching key wins
function mockFetch(routes = {}) {
  const fn = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    for (const key of Object.keys(routes)) {
      if (u.includes(key)) {
        const h = routes[key];
        return typeof h === 'function' ? h(u, opts) : h;
      }
    }
    return fail(404);
  });
  global.fetch = fn;
  return fn;
}

const callsTo = (substr, method) =>
  global.fetch.mock.calls.filter(([u, o]) =>
    String(u).includes(substr) && (!method || ((o && o.method) || 'GET') === method));

const bodyOf = (substr, i = 0) => JSON.parse(callsTo(substr, 'POST')[i][1].body);

// the view caches per user id, so every render needs a fresh one unless a test
// is deliberately exercising that cache
let seq = 0;
const nextUser = () => ({ name: 'Arun', email: `u${++seq}@b.c` });

function renderStats(over = {}) {
  const props = {
    onExit: vi.fn(), onNavigate: vi.fn(), themeToggle: null, userMenu: null,
    user: nextUser(), plan: { plan: 'pro' }, onUpgrade: vi.fn(), onOpenHand: vi.fn(),
    ...over,
  };
  return { ...render(<StatsView {...props} />), props };
}

// ── fixtures ──
const stat = (over) => ({
  v: 1, hero: 0, pos: 'BTN', players: 6, bb: 100, cents: true,
  vpip: false, pfr: false, tbOpp: false, tb: false, flop: false, sd: false, wsd: false,
  agg: 0, calls: 0, net: 0, pot: 0, ...over,
});
const S1 = { id: 's1', label: 'friday', at: '2026-09-01T10:00:00Z' };
const S2 = { id: 's2', label: 'saturday', at: '2026-09-02T10:00:00Z' };

// 4 hands chosen so every tile lands on a round number
const ROWS = [
  { id: 'h1', name: 'PokerNow #1', createdAt: '2026-09-01T10:00:00Z', session: S1, stats: stat({ pos: 'BTN', vpip: true, pfr: true, tbOpp: true, tb: true, flop: true, sd: true, wsd: true, agg: 3, calls: 1, net: 1000, pot: 2000 }) },
  { id: 'h2', name: 'PokerNow #2', createdAt: '2026-09-01T10:05:00Z', session: S1, stats: stat({ pos: 'BB', vpip: true, flop: true, calls: 1, net: -500, pot: 900 }) },
  { id: 'h3', name: 'PokerNow #3', createdAt: '2026-09-02T10:00:00Z', session: S2, stats: stat({ pos: 'BTN', net: -100, pot: 300 }) },
  { id: 'h4', name: 'PokerNow #4', createdAt: '2026-09-02T10:05:00Z', session: S2, stats: stat({ pos: 'SB', vpip: true, pfr: true, tbOpp: true, flop: true, sd: true, agg: 1, net: 200, pot: 600 }) },
];

// a real convertible hand, so the backfill path scores something genuine
const PN_LOG = {
  playerId: 'p_alice',
  hands: [{
    number: '1', gameType: 'th', dealerSeat: 0, smallBlind: 50, bigBlind: 100,
    players: [
      { seat: 0, id: 'p_alice', name: 'alice', stack: 10000, hand: ['As', 'Kd'] },
      { seat: 1, id: 'p_bob', name: 'bob', stack: 10000 },
    ],
    events: [],
  }],
};
const REPLAY = convertHandsFor(parsePokerNowLog(JSON.stringify(PN_LOG)).rawHands, 'p_alice')[0].replay;
const anonReplay = () => ({ ...REPLAY, hero: null });
const cardlessReplay = () => ({
  ...REPLAY, hero: null,
  setup: { ...REPLAY.setup, seats: REPLAY.setup.seats.map(s => ({ ...s, cards: null })) },
});

// ── dom readers ──
// the label's own text, without the (i) tooltip copy that sits inside it
const tile = (label) => [...document.querySelectorAll('.st-tile')]
  .find(t => (t.querySelector('.st-tile-label').firstChild?.textContent || '').trim() === label);
const tileValue = (label) => tile(label).querySelector('.st-tile-value').textContent;
const tileSub = (label) => tile(label).querySelector('.st-tile-sub').textContent;

// card title without its muted hint
const titleOf = (c) => {
  const t = c.querySelector('.st-card-title').cloneNode(true);
  t.querySelectorAll('.st-card-hint').forEach(h => h.remove());
  return t.textContent.trim();
};
const card = (title) => [...document.querySelectorAll('.st-card')].find(c => titleOf(c) === title);

// cell text without the trailing date span
const cells = (el) => [...el.querySelectorAll('td')].map(td => {
  const copy = td.cloneNode(true);
  copy.querySelectorAll('.st-date').forEach(d => d.remove());
  return copy.textContent;
});
const tableRows = (title) => [...card(title).querySelectorAll('tbody tr')].map(cells);

const bigList = (title) => [...card(title).querySelectorAll('button.st-hand')].map(btn => [
  btn.querySelector('.st-hand-name').textContent,
  btn.querySelector('.st-hand-ctx').textContent,
  btn.querySelector('.st-hand-net').textContent,
]);

beforeEach(() => {
  mockFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StatsView gating', () => {
  it('asks a signed-out visitor to sign in and never hits the server', async () => {
    renderStats({ user: null });
    expect(screen.getByText('Sign in to see your stats')).toBeInTheDocument();
    await waitFor(() => expect(callsTo('/api/stats/hands')).toHaveLength(0));
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
  });

  it('sells Pro to a free account instead of loading hands', async () => {
    const { props } = renderStats({ plan: { plan: 'free' } });
    expect(screen.getByText('Session stats is a Pro feature')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'See Pro' }));
    expect(props.onUpgrade).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(callsTo('/api/stats/hands')).toHaveLength(0));
  });

  it('tells a pro account with nothing imported where hands come from', async () => {
    mockFetch({ '/api/stats/hands': ok({ hands: [] }) });
    renderStats();
    expect(await screen.findByText('No imported hands yet')).toBeInTheDocument();
    expect(document.querySelector('.st-tiles')).toBeNull();
  });
});

describe('StatsView summary', () => {
  beforeEach(() => {
    mockFetch({ '/api/stats/hands': ok({ hands: ROWS }) });
  });

  it('fills the six tiles from the stored per-hand stats', async () => {
    renderStats();
    await waitFor(() => expect(tileValue('Hands')).toBe('4'));
    expect(tileSub('Hands')).toBe('Across 2 sessions');
    expect(tileValue('Net result')).toBe('+$6.00');
    expect(tileSub('Net result')).toBe('+150.0 bb/100');
    expect(tileValue('VPIP')).toBe('75%');
    expect(tileSub('VPIP')).toBe('PFR 50%');
    expect(tileValue('3-bet')).toBe('50%');
    expect(tileValue('WTSD')).toBe('67%'); // 2 showdowns over 3 flops
    expect(tileSub('WTSD')).toBe('Won at showdown 50%');
    expect(tileValue('Aggression factor')).toBe('2.0');
    expect(tileSub('Aggression factor')).toBe('(Bets + raises) / calls');
  });

  it('breaks the hands down by position, in table order', async () => {
    renderStats();
    await waitFor(() => expect(card('By position')).toBeTruthy());
    expect(tableRows('By position')).toEqual([
      ['BTN', '2', '50%', '50%', '+$9.00', '+450.0'],
      ['SB', '1', '100%', '100%', '+$2.00', '+200.0'],
      ['BB', '1', '100%', '0%', '−$5.00', '−500.0'],
    ]);
  });

  it('breaks the hands down by session, newest first', async () => {
    renderStats();
    await waitFor(() => expect(card('By session')).toBeTruthy());
    expect(tableRows('By session')).toEqual([
      ['saturday', '2', '50%', '+$1.00', '+50.0'],
      ['friday', '2', '100%', '+$5.00', '+250.0'],
    ]);
  });

  it('lists the biggest wins and losses by net result, worst loss first', async () => {
    renderStats();
    await waitFor(() => expect(card('Biggest wins')).toBeTruthy());
    expect(bigList('Biggest wins').map(r => [r[0], r[2]])).toEqual([
      ['Hand #1', '+$10.00'],
      ['Hand #4', '+$2.00'],
    ]);
    expect(bigList('Biggest losses').map(r => [r[0], r[2]])).toEqual([
      ['Hand #2', '−$5.00'],
      ['Hand #3', '−$1.00'],
    ]);
    expect(bigList('Biggest wins')[0][1]).toMatch(/^BTN · /);
  });

  it('opens a hand from either biggest list', async () => {
    const { props } = renderStats();
    await waitFor(() => expect(card('Biggest wins')).toBeTruthy());
    fireEvent.click(card('Biggest wins').querySelectorAll('button.st-hand')[1]);
    fireEvent.click(card('Biggest losses').querySelectorAll('button.st-hand')[0]);
    expect(props.onOpenHand.mock.calls).toEqual([['h4'], ['h2']]);
  });
});

describe('StatsView loading', () => {
  it('follows nextCursor and counts the hands as they arrive', async () => {
    let release;
    const gate = new Promise((res) => { release = res; });
    mockFetch({
      '/api/stats/hands': async (u) => {
        if (u.includes('cursor=h2')) { await gate; return ok({ hands: [ROWS[2], ROWS[3]] }); }
        return ok({ hands: [ROWS[0], ROWS[1]], nextCursor: 'h2' });
      },
    });
    renderStats();
    expect(await screen.findByText('Loading hands… 2')).toBeInTheDocument();
    await act(async () => { release(); });
    await waitFor(() => expect(tileValue('Hands')).toBe('4'));

    const urls = callsTo('/api/stats/hands').map(([u]) => String(u));
    expect(urls).toEqual(['/api/stats/hands?limit=100', '/api/stats/hands?limit=100&cursor=h2']);
  });

  it('scores rows that arrived without stats and posts only those back', async () => {
    const rows = [
      { ...ROWS[0] },                                                    // already scored
      { id: 'L1', name: 'old 1', createdAt: '2026-08-01T00:00:00Z', session: null, replay: REPLAY },
      { id: 'L2', name: 'old 2', createdAt: '2026-08-01T00:01:00Z', session: null, replay: anonReplay() },
      { id: 'L3', name: 'no cards', createdAt: '2026-08-01T00:02:00Z', session: null, replay: cardlessReplay() },
      { id: 'L4', name: 'nothing to score', createdAt: '2026-08-01T00:03:00Z', session: null },
    ];
    mockFetch({
      '/api/stats/hands': ok({ hands: rows }),
      '/api/stats/backfill': ok({}),
    });
    renderStats();
    await waitFor(() => expect(callsTo('/api/stats/backfill', 'POST')).toHaveLength(1));

    const body = bodyOf('/api/stats/backfill');
    expect(body.items.map(i => i.id)).toEqual(['L1', 'L2']); // L3 unscoreable, L4 has no replay, h1 already done
    expect(body.items[0].stats).toMatchObject({ hero: 0, pos: 'BTN', bb: 100, cents: true, net: -50 });
    expect(body.items[1].stats).toEqual(body.items[0].stats); // hero found by name when the seat is missing

    await waitFor(() => expect(tileValue('Hands')).toBe('3')); // h1 + the two it just scored
  });

  it('sends the backfill in chunks of a hundred', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      id: 'L' + i, name: 'old', createdAt: '2026-08-01T00:00:00Z', session: null, replay: REPLAY,
    }));
    mockFetch({ '/api/stats/hands': ok({ hands: rows }), '/api/stats/backfill': ok({}) });
    renderStats();
    await waitFor(() => expect(callsTo('/api/stats/backfill', 'POST')).toHaveLength(2));
    expect(bodyOf('/api/stats/backfill', 0).items).toHaveLength(100);
    expect(bodyOf('/api/stats/backfill', 1).items).toHaveLength(1);
    expect(bodyOf('/api/stats/backfill', 1).items[0].id).toBe('L100');
  });

  it('never backfills when every row already carries stats', async () => {
    mockFetch({ '/api/stats/hands': ok({ hands: ROWS }) });
    renderStats();
    await waitFor(() => expect(tileValue('Hands')).toBe('4'));
    expect(callsTo('/api/stats/backfill')).toHaveLength(0);
  });

  it('reuses the cached hands when the page is reopened', async () => {
    mockFetch({ '/api/stats/hands': ok({ hands: ROWS }) });
    const user = nextUser();
    const { unmount } = renderStats({ user });
    await waitFor(() => expect(tileValue('Hands')).toBe('4'));
    unmount();

    renderStats({ user });
    expect(tileValue('Hands')).toBe('4'); // straight from cache, no loading state
    expect(callsTo('/api/stats/hands')).toHaveLength(1);
  });
});

describe('StatsView failure and refresh', () => {
  it('shows the server message and recovers on Try again', async () => {
    let broken = true;
    mockFetch({ '/api/stats/hands': () => (broken ? errored('Stats are down') : ok({ hands: ROWS })) });
    renderStats();
    expect(await screen.findByText('Stats are down')).toBeInTheDocument();
    expect(screen.getByText(/Couldn.t load your hands/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();

    broken = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(tileValue('Hands')).toBe('4'));
    expect(screen.queryByText('Stats are down')).toBeNull();
  });

  it('Refresh refetches, keeping the numbers on screen while it runs', async () => {
    let gate = null;
    mockFetch({
      '/api/stats/hands': async () => {
        if (gate) await gate.p;
        return ok({ hands: ROWS });
      },
    });
    renderStats();
    await waitFor(() => expect(tileValue('Hands')).toBe('4'));

    let release;
    gate = { p: new Promise((res) => { release = res; }) };
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    const btn = await screen.findByRole('button', { name: 'Refreshing…' });
    expect(btn).toBeDisabled();
    expect(tileValue('Hands')).toBe('4');

    await act(async () => { release(); });
    await screen.findByRole('button', { name: 'Refresh' });
    expect(callsTo('/api/stats/hands')).toHaveLength(2);
  });
});

describe('StatsView chrome', () => {
  it('routes the brand mark and the toolbar buttons', async () => {
    mockFetch({ '/api/stats/hands': ok({ hands: [] }) });
    const { props } = renderStats();
    await screen.findByText('No imported hands yet');
    fireEvent.click(screen.getByRole('button', { name: 'PokerLab' }));
    expect(props.onExit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Calculator' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replayer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Solver' }));
    expect(props.onNavigate.mock.calls).toEqual([['calc'], ['replayer'], ['solver']]);
  });
});
