import { describe, it, expect } from 'vitest';
import { riverActions, aggregateOpponents, opponentModel, analyzeHand, STATS_VERSION } from './sessionStats.js';

// [hands, betOpp, bet, faced, fold, call, raise]
const table = (names) => ({ setup: { seats: names.map(name => ({ name })) } });
const rv = (names, actions, hero) => riverActions({ ...table(names), actions }, hero);
const river = (seat, type, amount) => ({ seat, type, street: 3, amount });

describe('riverActions', () => {
  it('counts a check as a bet opportunity passed up', () => {
    expect(rv(['bob'], [river(0, 'check')])).toEqual({ bob: [1, 1, 0, 0, 0, 0, 0] });
  });

  it('counts a first-to-act bet', () => {
    expect(rv(['bob'], [river(0, 'bet', 200)])).toEqual({ bob: [1, 1, 1, 0, 0, 0, 0] });
  });

  it('counts the bettor, the caller and the folder once each', () => {
    const out = rv(['bob', 'amy', 'cid'], [river(0, 'bet', 200), river(1, 'call'), river(2, 'fold')]);
    expect(out.bob).toEqual([1, 1, 1, 0, 0, 0, 0]);
    expect(out.amy).toEqual([1, 0, 0, 1, 0, 1, 0]);
    expect(out.cid).toEqual([1, 0, 0, 1, 1, 0, 0]);
  });

  it('gives a checker both a bet opportunity and the fold it later faces', () => {
    const out = rv(['bob', 'amy'], [river(0, 'check'), river(1, 'bet', 200), river(0, 'fold')]);
    expect(out.bob).toEqual([1, 1, 0, 1, 1, 0, 0]);
    expect(out.amy).toEqual([1, 1, 1, 0, 0, 0, 0]);
  });

  it('counts the raiser and leaves the bettor it raised unfaced', () => {
    const out = rv(['bob', 'amy'], [river(0, 'bet', 200), river(1, 'raise', 600), river(0, 'call')]);
    expect(out.bob).toEqual([1, 1, 1, 0, 0, 0, 0]);
    expect(out.amy).toEqual([1, 0, 0, 1, 0, 0, 1]);
  });

  it('does not count a caller twice when a raise comes back', () => {
    const out = rv(['bob', 'amy', 'cid'], [
      river(0, 'bet', 200), river(1, 'call'), river(2, 'raise', 900), river(0, 'call'), river(1, 'call'),
    ]);
    expect(out.bob).toEqual([1, 1, 1, 0, 0, 0, 0]);
    expect(out.amy).toEqual([1, 0, 0, 1, 0, 1, 0]);
    expect(out.cid).toEqual([1, 0, 0, 1, 0, 0, 1]);
  });

  it('keeps no row for the hero but still counts the bet it made as faced', () => {
    const out = rv(['bob', 'amy'], [river(0, 'bet', 200), river(1, 'fold')], 0);
    expect(out.bob).toBeUndefined();
    expect(out.amy).toEqual([1, 0, 0, 1, 1, 0, 0]);
  });

  it('gives the hero no bet opportunity row of its own', () => {
    const out = rv(['bob', 'amy'], [river(0, 'check'), river(1, 'check')], 0);
    expect(out).toEqual({ amy: [1, 1, 0, 0, 0, 0, 0] });
  });

  it('counts a hand for a seat that never acts on the river', () => {
    const out = rv(['bob', 'amy'], [river(0, 'bet', 200)]);
    expect(out.amy).toEqual([1, 0, 0, 0, 0, 0, 0]);
  });

  it('skips seats with a blank, missing or non-string name', () => {
    const out = riverActions({
      setup: { seats: [{ name: 'bob' }, { name: '   ' }, { name: '' }, { name: 7 }, {}, null] },
      actions: [river(1, 'bet', 200), river(4, 'call')],
    });
    expect(Object.keys(out)).toEqual(['bob']);
    expect(out.bob).toEqual([1, 0, 0, 0, 0, 0, 0]);
  });

  it('trims names and files the actions under the trimmed key', () => {
    expect(rv(['  bob  '], [river(0, 'bet', 200)])).toEqual({ bob: [1, 1, 1, 0, 0, 0, 0] });
  });

  it('ignores flop and turn action', () => {
    const out = rv(['bob', 'amy'], [
      { seat: 0, type: 'bet', street: 1, amount: 100 }, { seat: 1, type: 'call', street: 1 },
      { seat: 0, type: 'bet', street: 2, amount: 300 }, { seat: 1, type: 'fold', street: 2 },
    ]);
    expect(out.bob).toEqual([1, 0, 0, 0, 0, 0, 0]);
    expect(out.amy).toEqual([1, 0, 0, 0, 0, 0, 0]);
  });

  it('treats an action with no street as preflop', () => {
    expect(rv(['bob'], [{ seat: 0, type: 'bet', amount: 200 }])).toEqual({ bob: [1, 0, 0, 0, 0, 0, 0] });
  });

  it('returns a zeroed row per seat with no actions at all', () => {
    expect(rv(['bob', 'amy'], [])).toEqual({ bob: [1, 0, 0, 0, 0, 0, 0], amy: [1, 0, 0, 0, 0, 0, 0] });
  });

  it('tolerates a missing or non-array actions field', () => {
    expect(riverActions(table(['bob']))).toEqual({ bob: [1, 0, 0, 0, 0, 0, 0] });
    expect(riverActions({ ...table(['bob']), actions: 'nope' })).toEqual({ bob: [1, 0, 0, 0, 0, 0, 0] });
  });
});

const card = (s) => ({ v: s[0], s: s[1] });

// 3-handed limped pot: villain bets the river, fish folds, hero calls
const riverReplay = () => ({
  hero: 0,
  setup: {
    sb: 50, bb: 100, ante: 0, cents: false,
    seats: [
      { name: 'hero', stack: 10000, pos: 'BTN', cards: [card('As'), card('Kd')] },
      { name: 'villain', stack: 10000, pos: 'SB', cards: null },
      { name: 'fish', stack: 10000, pos: 'BB', cards: null },
    ],
  },
  actions: [
    { seat: 0, type: 'call', street: 0 }, { seat: 1, type: 'call', street: 0 }, { seat: 2, type: 'check', street: 0 },
    { seat: 0, type: 'check', street: 1 }, { seat: 1, type: 'check', street: 1 }, { seat: 2, type: 'check', street: 1 },
    { seat: 0, type: 'check', street: 2 }, { seat: 1, type: 'check', street: 2 }, { seat: 2, type: 'check', street: 2 },
    river(1, 'bet', 200), river(2, 'fold'), river(0, 'call'),
  ],
  board: ['2c', '7d', '9h', '3s', 'Kh'].map(card),
  board2: null, won: null, runResults: null,
});

describe('analyzeHand opponents', () => {
  it('stamps version 2 and attaches opponent rows without the hero', () => {
    const s = analyzeHand(riverReplay());
    expect(STATS_VERSION).toBe(2);
    expect(s.v).toBe(2);
    expect(Object.keys(s.opp).sort()).toEqual(['fish', 'villain']);
    expect(s.opp.villain).toEqual([1, 1, 1, 0, 0, 0, 0]);
    expect(s.opp.fish).toEqual([1, 0, 0, 1, 1, 0, 0]);
  });

  it('excludes whichever seat is the hero', () => {
    const s = analyzeHand(riverReplay(), 1);
    expect(Object.keys(s.opp).sort()).toEqual(['fish', 'hero']);
    expect(s.opp.hero).toEqual([1, 0, 0, 1, 0, 1, 0]);
  });
});

describe('aggregateOpponents', () => {
  const item = (opp) => ({ stats: { opp } });

  it('sums rows across hands, most hands first', () => {
    const rows = aggregateOpponents([
      item({ bob: [1, 1, 1, 0, 0, 0, 0] }),
      item({ bob: [1, 0, 0, 1, 1, 0, 0], amy: [1, 1, 0, 0, 0, 0, 0] }),
    ]);
    expect(rows).toEqual([
      { name: 'bob', hands: 2, betOpp: 1, bet: 1, faced: 1, fold: 1, call: 0, raise: 0 },
      { name: 'amy', hands: 1, betOpp: 1, bet: 0, faced: 0, fold: 0, call: 0, raise: 0 },
    ]);
  });

  it('breaks a tie on hands by name', () => {
    const rows = aggregateOpponents([item({ zed: [1], amy: [1], bob: [1] })]);
    expect(rows.map(r => r.name)).toEqual(['amy', 'bob', 'zed']);
  });

  it('skips items with no stats and no usable opp object', () => {
    expect(aggregateOpponents([])).toEqual([]);
    expect(aggregateOpponents([null, {}, { stats: null }, { stats: {} }, { stats: { opp: null } }, { stats: { opp: 'x' } }])).toEqual([]);
  });

  it('skips rows that are not arrays', () => {
    const rows = aggregateOpponents([item({ bob: { hands: 4 }, amy: 'nope', cid: [1, 1, 1, 0, 0, 0, 0] })]);
    expect(rows.map(r => r.name)).toEqual(['cid']);
  });

  it('counts missing and unparseable entries as zero', () => {
    expect(aggregateOpponents([item({ bob: [2] })])[0]).toEqual({ name: 'bob', hands: 2, betOpp: 0, bet: 0, faced: 0, fold: 0, call: 0, raise: 0 });
    expect(aggregateOpponents([item({ bob: [1, null, undefined, NaN, 'x'] })])[0].betOpp).toBe(0);
  });

  it('adds up two hands of the same opponent from riverActions', () => {
    const a = rv(['bob'], [river(0, 'bet', 200)]);
    const b = rv(['bob', 'amy'], [river(1, 'bet', 200), river(0, 'fold')]);
    const rows = aggregateOpponents([item(a), item(b)]);
    expect(rows.find(r => r.name === 'bob')).toEqual({ name: 'bob', hands: 2, betOpp: 1, bet: 1, faced: 1, fold: 1, call: 0, raise: 0 });
  });
});

describe('opponentModel', () => {
  it('returns null without an opponent', () => {
    expect(opponentModel(null)).toBeNull();
    expect(opponentModel(undefined)).toBeNull();
  });

  it('nulls each stat with no opportunities behind it', () => {
    expect(opponentModel({ hands: 3, betOpp: 0, bet: 0, faced: 0, fold: 0, call: 0, raise: 0 }))
      .toEqual({ bet: null, fold: null, raise: null });
  });

  it('maps hits and opportunities per stat', () => {
    expect(opponentModel({ hands: 12, betOpp: 10, bet: 3, faced: 4, fold: 1, call: 1, raise: 2 })).toEqual({
      bet: { hits: 3, opps: 10 },
      fold: { hits: 1, opps: 4 },
      raise: { hits: 2, opps: 4 },
    });
  });

  it('keeps bet data when no bet was ever faced', () => {
    expect(opponentModel({ hands: 2, betOpp: 2, bet: 1, faced: 0, fold: 0, call: 0, raise: 0 }))
      .toEqual({ bet: { hits: 1, opps: 2 }, fold: null, raise: null });
  });

  it('models an aggregated row end to end', () => {
    const rows = aggregateOpponents([{ stats: { opp: rv(['bob', 'amy'], [river(0, 'bet', 200), river(1, 'fold')]) } }]);
    expect(opponentModel(rows.find(r => r.name === 'amy'))).toEqual({
      bet: null, fold: { hits: 1, opps: 1 }, raise: { hits: 0, opps: 1 },
    });
  });
});
