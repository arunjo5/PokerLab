import { describe, it, expect } from 'vitest';
import { parsePokerNowLog, convertHandsFor } from './pokernowImport.js';
import { analyzeHand, aggregate, inferHeroSeat, inferHeroName, heroSeatByName, sessionLabel } from './sessionStats.js';

// alice opens, bob calls; bob bets the flop, alice folds
const LOG = {
  playerId: 'p_alice',
  hands: [{
    number: '1', gameType: 'th', dealerSeat: 0, smallBlind: 50, bigBlind: 100,
    players: [
      { seat: 0, id: 'p_alice', name: 'alice', stack: 10000, hand: ['As', 'Kd'] },
      { seat: 1, id: 'p_bob', name: 'bob', stack: 10000 },
    ],
    events: [
      { payload: { type: 3, seat: 0, value: 50 } },
      { payload: { type: 2, seat: 1, value: 100 } },
      { payload: { type: 8, seat: 0, value: 300 } },
      { payload: { type: 7, seat: 1, value: 300 } },
      { payload: { type: 9, cards: ['Jh', 'Td', '2s'], turn: 1 } },
      { payload: { type: 8, seat: 1, value: 400 } },
      { payload: { type: 11, seat: 0 } },
      { payload: { type: 16, seat: 1, value: 400 } },
      { payload: { type: 10, seat: 1, value: 600 } },
    ],
  }],
};

const heroHand = (log, id) => convertHandsFor(parsePokerNowLog(JSON.stringify(log)).rawHands, id)[0];

describe('analyzeHand', () => {
  it('scores the hero: raised preflop, saw the flop, folded, lost the raise', () => {
    const h = heroHand(LOG, 'p_alice');
    expect(h.replay.hero).toBe(0);
    const s = analyzeHand(h.replay);
    expect(s).toMatchObject({ hero: 0, pos: 'BTN', vpip: true, pfr: true, tbOpp: false, tb: false, flop: true, sd: false, wsd: false, agg: 1, calls: 0, bb: 100, cents: true, players: 2 });
    expect(s.net).toBe(-300);
    expect(s.pot).toBe(600);
  });

  it('scores the caller who won without showdown', () => {
    const h = heroHand(LOG, 'p_bob');
    const s = analyzeHand(h.replay);
    expect(s).toMatchObject({ hero: 1, pos: 'BB', vpip: true, pfr: false, agg: 1, calls: 1, sd: false });
    expect(s.net).toBe(300);
  });

  it('counts a 3-bet chance only when facing exactly one raise', () => {
    const log = JSON.parse(JSON.stringify(LOG));
    log.hands[0].events = [
      { payload: { type: 3, seat: 0, value: 50 } },
      { payload: { type: 2, seat: 1, value: 100 } },
      { payload: { type: 8, seat: 0, value: 300 } },
      { payload: { type: 8, seat: 1, value: 900 } },
      { payload: { type: 11, seat: 0 } },
      { payload: { type: 16, seat: 1, value: 600 } },
      { payload: { type: 10, seat: 1, value: 600 } },
    ];
    const bob = analyzeHand(heroHand(log, 'p_bob').replay);
    expect(bob.tbOpp).toBe(true);
    expect(bob.tb).toBe(true);
    expect(bob.pfr).toBe(true);
    const alice = analyzeHand(heroHand(log, 'p_alice').replay);
    expect(alice.tbOpp).toBe(false); // she opened; facing the 3-bet is a 4-bet spot
    expect(alice.net).toBe(-300);
  });

  it('returns null without a hero and infers a lone card holder', () => {
    const h = heroHand(LOG, 'p_alice');
    const anon = { ...h.replay, hero: null };
    expect(inferHeroSeat(anon)).toBe(0);
    expect(analyzeHand(anon).hero).toBe(0);
    const noCards = { ...anon, setup: { ...anon.setup, seats: anon.setup.seats.map(s => ({ ...s, cards: null })) } };
    expect(analyzeHand(noCards)).toBeNull();
  });

  it('infers the hero name across hands and finds that seat', () => {
    const a = heroHand(LOG, 'p_alice').replay;
    expect(inferHeroName([a, a])).toBe('alice');
    expect(heroSeatByName(a, 'alice')).toBe(0);
    expect(heroSeatByName(a, 'bob')).toBeNull();
  });
});

describe('aggregate', () => {
  const stat = (over) => ({ v: 1, hero: 0, pos: 'BTN', players: 2, bb: 100, cents: true, vpip: true, pfr: false, tbOpp: false, tb: false, flop: true, sd: false, wsd: false, agg: 0, calls: 1, net: 0, pot: 200, ...over });

  it('rolls up totals, positions, sessions, and biggest pots', () => {
    const items = [
      { id: 'a', name: '#1', createdAt: '2026-09-01T10:00:00Z', session: { id: 's1', label: 'friday', at: '2026-09-01T10:00:00Z' }, stats: stat({ net: 500, pfr: true, sd: true, wsd: true }) },
      { id: 'b', name: '#2', createdAt: '2026-09-01T10:05:00Z', session: { id: 's1', label: 'friday', at: '2026-09-01T10:00:00Z' }, stats: stat({ net: -200, pos: 'BB', vpip: false, flop: false }) },
      { id: 'c', name: '#3', createdAt: '2026-09-02T10:00:00Z', session: null, stats: stat({ net: 100, tbOpp: true, tb: true }) },
      { id: 'd', name: 'no stats', createdAt: '2026-09-02T11:00:00Z', session: null, stats: null },
    ];
    const s = aggregate(items);
    expect(s.hands).toBe(3);
    expect(s.net).toBe(400);
    expect(s.bb100).toBeCloseTo((4 / 3) * 100);
    expect(s.vpip).toBeCloseTo((2 / 3) * 100);
    expect(s.pfr).toBeCloseTo((1 / 3) * 100);
    expect(s.threeBet).toBe(100);
    expect(s.wtsd).toBe(50);
    expect(s.wsd).toBe(100);
    expect(s.af).toBe(0);
    expect(s.positions.map(p => p.pos)).toEqual(['BTN', 'BB']);
    expect(s.sessions.map(x => [x.key, x.hands, x.net])).toEqual([['day:2026-09-02', 1, 100], ['s1', 2, 300]]);
    expect(s.biggest.won.map(h => h.id)).toEqual(['a', 'c']);
    expect(s.biggest.lost.map(h => h.id)).toEqual(['b']);
  });

  it('handles an empty list and infinite aggression', () => {
    expect(aggregate([]).hands).toBe(0);
    expect(aggregate([{ id: 'x', stats: stat({ agg: 2, calls: 0 }) }]).af).toBe(Infinity);
  });

  it('labels a session from the file name', () => {
    expect(sessionLabel('friday-game.json')).toBe('friday-game');
    expect(sessionLabel('')).toBeNull();
  });
});
