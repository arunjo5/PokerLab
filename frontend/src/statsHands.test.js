import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadStatsHands, cachedStatsHands } from './statsHands.js';
import { parsePokerNowLog, convertHandsFor } from './pokernowImport.js';

const ok = (data) => ({ ok: true, status: 200, json: async () => data });
const fail = (status = 500) => ({ ok: false, status, json: async () => ({}) });
const errored = (body, status = 500) => ({ ok: false, status, json: async () => body });

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

// the module caches per key, so every load needs a fresh one unless a test is
// deliberately exercising that cache
let seq = 0;
const nextKey = () => `k${++seq}`;

// a real convertible hand, so the analysis scores something genuine
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

const scored = (id) => ({ id, name: 'hand ' + id, createdAt: '2026-09-01T10:00:00Z', stats: { v: 2, hero: 0, net: 1, opp: {} } });
const stale = (id, replay = REPLAY) => ({ id, name: 'old ' + id, createdAt: '2026-08-01T00:00:00Z', replay });

beforeEach(() => { mockFetch(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('loadStatsHands paging', () => {
  it('follows nextCursor and returns every page in order', async () => {
    mockFetch({
      '/api/stats/hands': (u) => (u.includes('cursor=h2')
        ? ok({ hands: [scored('h3')] })
        : ok({ hands: [scored('h1'), scored('h2')], nextCursor: 'h2' })),
    });
    const items = await loadStatsHands(nextKey());
    expect(items.map(i => i.id)).toEqual(['h1', 'h2', 'h3']);
    expect(callsTo('/api/stats/hands').map(([u]) => String(u))).toEqual([
      '/api/stats/hands?limit=100',
      '/api/stats/hands?limit=100&cursor=h2',
    ]);
  });

  it('reports the running count, then the analysis pass', async () => {
    mockFetch({
      '/api/stats/hands': (u) => (u.includes('cursor=') ? ok({ hands: [stale('L1')] }) : ok({ hands: [scored('h1'), scored('h2')], nextCursor: 'c' })),
      '/api/stats/backfill': ok({}),
    });
    const seen = [];
    await loadStatsHands(nextKey(), (m) => seen.push(m));
    expect(seen).toEqual(['Loading hands… 2', 'Loading hands… 3', 'Analyzing 1 older hand…']);
  });

  it('pluralises the analysis message and stays quiet with nothing stale', async () => {
    mockFetch({ '/api/stats/hands': ok({ hands: [stale('L1'), stale('L2', anonReplay())] }), '/api/stats/backfill': ok({}) });
    const seen = [];
    await loadStatsHands(nextKey(), (m) => seen.push(m));
    expect(seen.at(-1)).toBe('Analyzing 2 older hands…');

    mockFetch({ '/api/stats/hands': ok({ hands: [scored('h1')] }) });
    const quiet = [];
    await loadStatsHands(nextKey(), (m) => quiet.push(m));
    expect(quiet).toEqual(['Loading hands… 1']);
    expect(callsTo('/api/stats/backfill')).toHaveLength(0);
  });

  it('throws the server message and code from a failed page', async () => {
    mockFetch({ '/api/stats/hands': errored({ error: 'Stats are down', code: 'rate_limited' }, 503) });
    await expect(loadStatsHands(nextKey())).rejects.toMatchObject({ message: 'Stats are down', code: 'rate_limited' });
  });
});

describe('loadStatsHands analysis', () => {
  it('scores stale rows, drops the replay and posts the result back', async () => {
    mockFetch({ '/api/stats/hands': ok({ hands: [scored('h1'), stale('L1')] }), '/api/stats/backfill': ok({}) });
    const items = await loadStatsHands(nextKey());

    expect('replay' in items[1]).toBe(false);
    expect(items[1].stats).toMatchObject({ v: 2, hero: 0, pos: 'BTN', bb: 100, cents: true });
    expect(items[1].stats.opp).toEqual({ bob: [1, 0, 0, 0, 0, 0, 0] });

    const body = bodyOf('/api/stats/backfill');
    expect(body.items.map(i => i.id)).toEqual(['L1']);
    expect(body.items[0].stats).toEqual(items[1].stats);
  });

  it('re-scores a row that arrived with both stats and a replay', async () => {
    const row = { ...stale('L1'), stats: { v: 1, stale: true } };
    mockFetch({ '/api/stats/hands': ok({ hands: [row] }), '/api/stats/backfill': ok({}) });
    const items = await loadStatsHands(nextKey());
    expect(items[0].stats.v).toBe(2);
    expect(items[0].stats.stale).toBeUndefined();
    expect(bodyOf('/api/stats/backfill').items.map(i => i.id)).toEqual(['L1']);
  });

  it('finds the hero by name when the replay has no seat', async () => {
    mockFetch({ '/api/stats/hands': ok({ hands: [stale('L1'), stale('L2', anonReplay())] }), '/api/stats/backfill': ok({}) });
    const items = await loadStatsHands(nextKey());
    expect(items[1].stats).toEqual(items[0].stats);
  });

  it('leaves an unscoreable row without stats but still strips its replay', async () => {
    mockFetch({ '/api/stats/hands': ok({ hands: [stale('L1', cardlessReplay()), stale('L2')] }), '/api/stats/backfill': ok({}) });
    const items = await loadStatsHands(nextKey());
    expect(items[0].stats).toBeUndefined();
    expect('replay' in items[0]).toBe(false);
    expect(bodyOf('/api/stats/backfill').items.map(i => i.id)).toEqual(['L2']);
  });

  it('sends the backfill in chunks of a hundred', async () => {
    const hands = Array.from({ length: 101 }, (_, i) => stale('L' + i));
    mockFetch({ '/api/stats/hands': ok({ hands }), '/api/stats/backfill': ok({}) });
    await loadStatsHands(nextKey());
    expect(callsTo('/api/stats/backfill', 'POST')).toHaveLength(2);
    expect(bodyOf('/api/stats/backfill', 0).items).toHaveLength(100);
    expect(bodyOf('/api/stats/backfill', 1).items.map(i => i.id)).toEqual(['L100']);
  });

  it('keeps the hands even when the backfill post fails', async () => {
    mockFetch({ '/api/stats/hands': ok({ hands: [stale('L1')] }), '/api/stats/backfill': fail(500) });
    const items = await loadStatsHands(nextKey());
    expect(items[0].stats.v).toBe(2);
  });
});

describe('cachedStatsHands', () => {
  it('holds the last load under its own key only', async () => {
    mockFetch({ '/api/stats/hands': ok({ hands: [scored('h1')] }) });
    const key = nextKey();
    const items = await loadStatsHands(key);
    expect(cachedStatsHands(key)).toBe(items);
    expect(cachedStatsHands(nextKey())).toBeNull();
    expect(cachedStatsHands('')).toBeNull();
  });

  it('is replaced by the next user and never short-circuits a load', async () => {
    mockFetch({ '/api/stats/hands': ok({ hands: [scored('h1')] }) });
    const first = nextKey();
    await loadStatsHands(first);
    const second = nextKey();
    await loadStatsHands(second);
    expect(cachedStatsHands(first)).toBeNull();
    expect(cachedStatsHands(second).map(i => i.id)).toEqual(['h1']);

    await loadStatsHands(second);
    expect(callsTo('/api/stats/hands')).toHaveLength(3);
  });
});
