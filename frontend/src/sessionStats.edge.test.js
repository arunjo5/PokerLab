import { describe, it, expect } from 'vitest';
import { parsePokerNowLog, convertHandsFor } from './pokernowImport.js';
import { analyzeHand, aggregate, inferHeroName, sessionLabel } from './sessionStats.js';

const card = (s) => ({ v: s[0], s: s[1] });
const heroHand = (log, id) => convertHandsFor(parsePokerNowLog(JSON.stringify(log)).rawHands, id)[0];

// heads-up all-in preflop; `deals` is [cards, turn, run?][] so run-it-twice reuses it
const allInLog = (deals, wins) => ({
  playerId: 'p_alice',
  hands: [{
    number: '1', gameType: 'th', dealerSeat: 0, smallBlind: 50, bigBlind: 100,
    players: [
      { seat: 0, id: 'p_alice', name: 'alice', stack: 10000, hand: ['As', 'Ah'] },
      { seat: 1, id: 'p_bob', name: 'bob', stack: 10000, hand: ['Kd', 'Kc'] },
    ],
    events: [
      { payload: { type: 3, seat: 0, value: 50 } },
      { payload: { type: 2, seat: 1, value: 100 } },
      { payload: { type: 8, seat: 0, value: 10000 } },
      { payload: { type: 7, seat: 1, value: 10000 } },
      ...deals.map(([cards, turn, run]) => ({ payload: { type: 9, cards, turn, ...(run ? { run } : {}) } })),
      ...wins.map(([seat, value]) => ({ payload: { type: 10, seat, value } })),
    ],
  }],
});

const RUNOUT = [[['2c', '7d', '9h'], 1], [['3s'], 2], [['5d'], 3]];

// hand-built replay: no positions, no board, no payouts
const plainReplay = () => ({
  hero: 0,
  setup: {
    sb: 50, bb: 100, ante: 0, cents: false,
    seats: [
      { name: 'hero', stack: 10000, cards: [card('As'), card('Kd')] },
      { name: 'villain', stack: 10000, cards: null },
    ],
  },
  actions: [{ seat: 0, type: 'call', street: 0 }, { seat: 1, type: 'check', street: 0 }],
  board: [], board2: null, won: null, runResults: null,
});

describe('analyzeHand edge cases', () => {
  it('returns null when the hand cannot be replayed', () => {
    const r = plainReplay();
    r.setup.seats[1] = null; // corrupt row: the engine blows up building state
    expect(analyzeHand(r)).toBeNull();
  });

  it('returns null for a hero seat outside the table', () => {
    expect(analyzeHand({ ...plainReplay(), hero: 5 })).toBeNull();
    expect(analyzeHand({ ...plainReplay(), hero: -1 })).toBeNull();
  });

  it('lets an explicit seat argument override the recorded hero', () => {
    expect(analyzeHand(plainReplay(), 1).hero).toBe(1);
  });

  it('reports a missing position as null and no flop when the board is empty', () => {
    const s = analyzeHand(plainReplay());
    expect(s.pos).toBeNull();
    expect(s).toMatchObject({ flop: false, sd: false, wsd: false, cents: false });
    expect(s.net).toBe(-100); // sb 50 + the call to 100
  });

  it('counts an all-in preflop as a showdown once the board runs out', () => {
    const h = heroHand(allInLog(RUNOUT, [[0, 20000]]), 'p_alice');
    const alice = analyzeHand(h.replay);
    expect(alice).toMatchObject({ flop: true, sd: true, wsd: true, pfr: true, agg: 1, calls: 0 });
    expect(alice.net).toBe(10000);
    expect(alice.pot).toBe(20000);

    const bob = analyzeHand(heroHand(allInLog(RUNOUT, [[0, 20000]]), 'p_bob').replay);
    expect(bob).toMatchObject({ sd: true, wsd: false, tbOpp: true, tb: false, calls: 1 });
    expect(bob.net).toBe(-10000);
  });

  it('scores a run-it-twice hand off the first board and calls a chop a showdown win', () => {
    const deals = [...RUNOUT, [['Kh'], 3, 2]];
    const h = heroHand(allInLog(deals, [[0, 10000], [1, 10000]]), 'p_alice');
    expect(h.replay.board2).toEqual(['2c', '7d', '9h', '3s', 'Kh'].map(card));
    const s = analyzeHand(h.replay);
    expect(s).toMatchObject({ sd: true, wsd: true });
    expect(s.net).toBe(0); // each board paid half the pot back
  });
});

describe('inferHeroName edge cases', () => {
  it('returns null when nobody was dealt cards', () => {
    const r = plainReplay();
    r.setup.seats[0].cards = null;
    expect(inferHeroName([r])).toBeNull();
    expect(inferHeroName([])).toBeNull();
  });
});

describe('aggregate edge cases', () => {
  const stat = (over) => ({ v: 1, hero: 0, pos: 'BTN', players: 2, bb: 100, cents: true, vpip: true, pfr: false, tbOpp: false, tb: false, flop: true, sd: false, wsd: false, agg: 0, calls: 1, net: 0, pot: 200, ...over });
  const row = (id, over) => ({ id, stats: stat(over) });

  it('buckets a missing position under ? and sorts it last', () => {
    const s = aggregate([row('a', { pos: null }), row('b', { pos: 'BTN' }), row('c', { pos: 'SB' })]);
    expect(s.positions.map(p => p.pos)).toEqual(['BTN', 'SB', '?']);
    expect(s.positions.find(p => p.pos === '?').hands).toBe(1);
  });

  it('leaves a zero big blind out of bb/100, denominator included', () => {
    expect(aggregate([row('a', { bb: 0, net: 500 })]).bb100).toBeNull();
    // only the bb:100 hand counts: 1bb over 1 blind-sized hand
    expect(aggregate([row('a', { bb: 0, net: 500 }), row('b', { net: 100 })]).bb100).toBe(100);
  });

  it('has no aggression figure without a single bet or call', () => {
    expect(aggregate([row('a', { agg: 0, calls: 0 })]).af).toBeNull();
  });

  it('flags cents when any hand was played in cents', () => {
    expect(aggregate([row('a', { cents: false })]).cents).toBe(false);
    expect(aggregate([row('a', { cents: false }), row('b', { cents: true })]).cents).toBe(true);
  });

  it('caps each biggest list at five, dropping the smallest', () => {
    const wins = [600, 500, 400, 300, 200, 100].map((net, i) => row('w' + i, { net }));
    const losses = [-100, -200, -300, -400, -500, -600].map((net, i) => row('l' + i, { net }));
    const s = aggregate([...wins, ...losses]);
    expect(s.biggest.won.map(h => h.net)).toEqual([600, 500, 400, 300, 200]);
    expect(s.biggest.lost.map(h => h.net)).toEqual([-600, -500, -400, -300, -200]);
  });

  it('keeps input order for ties in both lists', () => {
    const s = aggregate([row('w1', { net: 300 }), row('w2', { net: 300 }), row('l1', { net: -300 }), row('l2', { net: -300 })]);
    expect(s.biggest.won.map(h => h.id)).toEqual(['w1', 'w2']);
    expect(s.biggest.lost.map(h => h.id)).toEqual(['l1', 'l2']);
  });

  it('leaves a break-even hand out of both lists', () => {
    const s = aggregate([row('a', { net: 0 })]);
    expect(s.biggest.won).toEqual([]);
    expect(s.biggest.lost).toEqual([]);
    expect(s.hands).toBe(1);
  });
});

describe('sessionLabel edge cases', () => {
  it('handles a missing name and a shouty extension', () => {
    expect(sessionLabel(null)).toBeNull();
    expect(sessionLabel(undefined)).toBeNull();
    expect(sessionLabel('  ')).toBeNull();
    expect(sessionLabel('Friday.JSON')).toBe('Friday');
  });
});
