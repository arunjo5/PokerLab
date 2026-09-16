import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { isHandHistoryText, parseHandHistory } from './handHistory.js';
import { convertAllHands, convertHandsFor } from './pokernowImport.js';

const DIR = 'src/__fixtures__/handhistory/';
const parseFile = (name) => parseHandHistory(fs.readFileSync(DIR + name, 'utf8'));

const card = (s) => ({ v: s[0], s: s[1] });
const cardsOf = (s) => s.split(' ').map(card);
const boardText = (b) => b.map((c) => c.v + c.s).join(' ');

// EV codes: CHECK 0, POST_BB 2, POST_SB 3, CALL 7, BET_RAISE 8, DEAL 9, WIN 10, FOLD 11, SHOW 12, END 15, UNCALLED 16
const END = { type: 15 };

const starsHead = (id, stamp = '2014/01/06 7:21:05') =>
  `PokerStars Hand #${id}:  Hold'em No Limit ($0.05/$0.10 USD) - ${stamp} ET`;
const TABLE = "Table 'Test' 6-max Seat #1 is the button";
const SEATS = ['Seat 1: alice ($10 in chips) ', 'Seat 2: bob ($10 in chips) '];

const hh = (body, { head = starsHead('100'), seats = SEATS } = {}) => [head, TABLE, ...seats, ...body].join('\n');
const handOf = (body, opts) => parseHandHistory(hh(body, opts)).rawHands[0];
const payloads = (body, opts) => handOf(body, opts).events.map((e) => e.payload);

describe('isHandHistoryText', () => {
  it('accepts the PokerStars header in its Hand, Game and Zoom spellings', () => {
    expect(isHandHistoryText("PokerStars Hand #1: Hold'em No Limit")).toBe(true);
    expect(isHandHistoryText("PokerStars Game #1: Hold'em No Limit")).toBe(true);
    expect(isHandHistoryText("PokerStars Zoom Hand #1: Hold'em No Limit")).toBe(true);
  });

  it('accepts a GG header past a BOM or leading blank lines', () => {
    expect(isHandHistoryText("Poker Hand #RC123: Hold'em No Limit")).toBe(true);
    expect(isHandHistoryText('﻿PokerStars Hand #1: x')).toBe(true);
    expect(isHandHistoryText('\n\n   \nPoker Hand #RC123: x')).toBe(true);
    expect(isHandHistoryText('GGPoker Hand #123: x')).toBe(true);
  });

  it('accepts a header that follows a banner line', () => {
    expect(isHandHistoryText('Exported by PokerCraft\n\nPoker Hand #RC123: x')).toBe(true);
  });

  it('rejects a PokerNow CSV, JSON, prose and an empty file', () => {
    expect(isHandHistoryText('entry,at,order\n"x",1,2')).toBe(false);
    expect(isHandHistoryText('{"hands":[]}')).toBe(false);
    expect(isHandHistoryText('a friendly game last night')).toBe(false);
    expect(isHandHistoryText('')).toBe(false);
  });

  it('accepts every specimen', () => {
    for (const f of ['stars-general.txt', 'stars-allin.txt', 'stars-showdown.txt', 'stars-multi.txt', 'gg-cash.txt', 'gg-tourney.txt']) {
      expect(isHandHistoryText(fs.readFileSync(DIR + f, 'utf8'))).toBe(true);
    }
  });
});

describe('parseHandHistory shape', () => {
  it('throws NOT_HAND_HISTORY without a header line', () => {
    expect(() => parseHandHistory('Seat 1: alice ($10 in chips)\nalice: folds')).toThrow('NOT_HAND_HISTORY');
    expect(() => parseHandHistory('')).toThrow('NOT_HAND_HISTORY');
  });

  it("keeps the site's hand id", () => {
    expect(parseFile('stars-general.txt').rawHands[0].id).toBe('109681313810');
    expect(parseFile('gg-cash.txt').rawHands[0].id).toBe('RC57841036');
    expect(parseFile('gg-tourney.txt').rawHands[0].id).toBe('TM1848372910');
  });

  it('numbers ten hands 1..10 in timestamp order', () => {
    const hands = parseFile('stars-multi.txt').rawHands;
    expect(hands.map((h) => h.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(hands.map((h) => h.id)).toEqual([
      '109673533027', '109673554313', '109673561342', '109673572373', '109673589735',
      '109673602306', '109673610680', '109673992001', '109674128046', '109674148786',
    ]);
    expect(hands[0].id).toBe(parseFile('stars-showdown.txt').rawHands[0].id);
  });

  it('sorts a newest-first file so the older hand is #1', () => {
    const text = [
      hh(['alice: folds'], { head: starsHead('200', '2014/01/06 9:00:00') }),
      hh(['bob: folds'], { head: starsHead('199', '2014/01/06 8:00:00') }),
    ].join('\n');
    expect(parseHandHistory(text).rawHands.map((h) => [h.number, h.id])).toEqual([[1, '199'], [2, '200']]);
  });

  it('builds the roster by hand count, then name', () => {
    expect(parseFile('stars-multi.txt').players).toEqual([
      { id: 'lena', name: 'lena', count: 10 },
      { id: 'milo', name: 'milo', count: 10 },
      { id: 'nina', name: 'nina', count: 10 },
      { id: 'omar', name: 'omar', count: 10 },
      { id: 'pia', name: 'pia', count: 7 },
      { id: 'quinn', name: 'quinn', count: 7 },
      { id: 'rosa', name: 'rosa', count: 7 },
      { id: 'sam', name: 'sam', count: 6 },
      { id: 'tess', name: 'tess', count: 4 },
      { id: 'uri', name: 'uri', count: 3 },
      { id: 'vera', name: 'vera', count: 3 },
      { id: 'wes', name: 'wes', count: 3 },
    ]);
  });

  it('leaves the hero null when no hand deals anyone in', () => {
    expect(parseFile('stars-general.txt').exportHeroId).toBe(null);
    expect(parseFile('stars-multi.txt').exportHeroId).toBe(null);
  });

  it('names the hero from the Dealt to line', () => {
    expect(parseFile('gg-cash.txt').exportHeroId).toBe('Hero');
    expect(parseFile('gg-tourney.txt').exportHeroId).toBe('Hero');
  });

  it('keeps the most frequent Dealt to name across hands', () => {
    const text = [
      hh(['Dealt to alice [Ad Kh]'], { head: starsHead('1', '2014/01/06 1:00:00') }),
      hh(['Dealt to bob [2c 3c]'], { head: starsHead('2', '2014/01/06 2:00:00') }),
      hh(['Dealt to alice [Qs Qd]'], { head: starsHead('3', '2014/01/06 3:00:00') }),
    ].join('\n');
    const out = parseHandHistory(text);
    expect(out.exportHeroId).toBe('alice');
    expect(out.rawHands.map((h) => h.players[0].hand)).toEqual([['Ad', 'Kh'], undefined, ['Qs', 'Qd']]);
  });

  it('drops the per-hand hero marker from the raw hands', () => {
    expect(parseFile('gg-cash.txt').rawHands.every((h) => !('hero' in h))).toBe(true);
  });
});

describe('per-hand fields', () => {
  it('reads seats, stacks in cents, the button and the blinds', () => {
    const h = parseFile('stars-general.txt').rawHands[0];
    expect([h.gameType, h.cents, h.dealerSeat]).toEqual(['th', true, 4]);
    expect([h.smallBlind, h.bigBlind]).toEqual([5, 10]);
    expect(h.players).toEqual([
      { seat: 1, id: 'ana', name: 'ana', stack: 4763 },
      { seat: 2, id: 'ben', name: 'ben', stack: 2500 },
      { seat: 3, id: 'cleo', name: 'cleo', stack: 2662 },
      { seat: 4, id: 'dev', name: 'dev', stack: 2000 },
      { seat: 5, id: 'eli', name: 'eli', stack: 2617 },
      { seat: 6, id: 'fay', name: 'fay', stack: 929 },
    ]);
  });

  it('sets a flat ante when every seated player posts the same one', () => {
    const general = parseFile('stars-general.txt').rawHands[0];
    expect(general.ante).toBe(2);
    expect('antes' in general).toBe(false);
    expect(parseFile('stars-allin.txt').rawHands[0].ante).toBe(2);
    expect(parseFile('stars-showdown.txt').rawHands[0].ante).toBe(0);
  });

  it('keys a big-blind ante by physical seat', () => {
    const h = parseFile('gg-tourney.txt').rawHands[0];
    expect(h.ante).toBe(0);
    expect(h.antes).toEqual({ 1: 0, 2: 600, 3: 0, 4: 0 });
  });

  it('marks tournament chips as not cents and keeps comma thousands', () => {
    const h = parseFile('gg-tourney.txt').rawHands[0];
    expect(h.cents).toBe(false);
    expect([h.smallBlind, h.bigBlind]).toEqual([300, 600]);
    expect(h.players.map((p) => p.stack)).toEqual([12480, 9150, 23905, 6300]);
  });

  it('keeps tournament chips when a bounty or re-buy line prices dollars', () => {
    const head = "PokerStars Hand #7: Tournament #99, $5.00+$0.50 USD Hold'em No Limit - Level V (300/600) - 2026/03/14 21:05:11 ET";
    const seats = ['Seat 1: alice (12480 in chips) ', 'Seat 2: bob (9150 in chips) '];
    const h = handOf([
      'alice: posts small blind 300',
      'bob: posts big blind 600',
      'alice wins the $2.50 bounty for eliminating bob',
      'alice re-buys and receives 1500 chips for $5.00',
    ], { head, seats });
    expect(h.cents).toBe(false);
    expect([h.smallBlind, h.bigBlind]).toEqual([300, 600]);
    expect(h.players.map((p) => p.stack)).toEqual([12480, 9150]);
  });

  it('reads a cash drop that sits above the seat block', () => {
    const body = ['alice: posts small blind $0.05', 'bob: posts big blind $0.10'];
    const above = [starsHead('101'), TABLE, 'Cash Drop to Pot : total $5 ', ...SEATS, ...body].join('\n');
    expect(parseHandHistory(above).rawHands[0].dead).toBe(500);
    expect(handOf(['Cash Drop to Pot : total $5 ', ...body]).dead).toBe(500);
  });

  it('sums rake from every deduction tag', () => {
    expect(parseFile('stars-general.txt').rawHands[0].rake).toBe(6);
    expect(parseFile('stars-allin.txt').rawHands[0].rake).toBe(111);
    expect(parseFile('gg-tourney.txt').rawHands[0].rake).toBe(0);
    const h = handOf([
      '*** SUMMARY ***',
      'Total pot $10 | Rake $0.50 | Jackpot $0.25 | Bingo $0.10 | Fortune $0.05 | Tax $0.02',
      'Seat 1: alice', 'Seat 2: bob',
    ]);
    expect(h.rake).toBe(92);
  });

  it('reads a Cash Drop into dead money', () => {
    expect(parseFile('gg-cash.txt').rawHands[0].dead).toBe(500);
    expect(parseFile('stars-general.txt').rawHands[0].dead).toBe(0);
  });

  it('falls back to the header blinds when nobody posts', () => {
    const h = handOf([]);
    expect([h.smallBlind, h.bigBlind, h.cents]).toEqual([5, 10, true]);
  });

  it('marks Omaha plo and keeps it out of the roster and the converter', () => {
    const head = "PokerStars Hand #300:  Omaha Pot Limit ($0.05/$0.10 USD) - 2014/01/06 7:21:05 ET";
    const out = parseHandHistory(hh(['alice: folds'], { head }));
    expect(out.rawHands[0].gameType).toBe('plo');
    expect(out.players).toEqual([]);
    expect(convertAllHands(out.rawHands, null)).toHaveLength(0);
  });
});

describe('events', () => {
  it('leaves the blinds to the engine', () => {
    const h = handOf(['alice: posts small blind $0.05', 'bob: posts big blind $0.10']);
    expect([h.smallBlind, h.bigBlind]).toEqual([5, 10]);
    expect(h.events.map((e) => e.payload)).toEqual([END]);
  });

  it('counts a call as the street total, not the added chips', () => {
    const gg = parseFile('gg-cash.txt').rawHands[0];
    const calls = gg.events.filter((e) => e.payload.type === 7).map((e) => e.payload);
    expect(calls).toEqual([{ type: 7, seat: 1, value: 5308, street: 0 }]); // $15.75 in, calls $37.33
    const general = parseFile('stars-general.txt').rawHands[0];
    expect(general.events.filter((e) => e.payload.type === 7).map((e) => e.payload.value)).toEqual([10, 50]);
  });

  it('takes the new total from raises X to Y', () => {
    expect(payloads(['alice: raises $0.40 to $0.50'])).toEqual([{ type: 8, seat: 1, value: 50, street: 0 }, END]);
  });

  it('adds a bet to what the seat already committed', () => {
    expect(payloads([
      'alice: posts small blind $0.05',
      'bob: posts big blind $0.10',
      'alice: bets $0.15',
    ])).toEqual([{ type: 8, seat: 1, value: 20, street: 0 }, END]);
  });

  it('strips "and is all-in"', () => {
    const allin = parseFile('stars-allin.txt').rawHands[0];
    expect(allin.events.filter((e) => e.payload.seat === 3 && e.payload.type === 8).map((e) => e.payload.value)).toEqual([30, 1094]);
    expect(payloads(['alice: bets $5 and is all-in', 'bob: calls $5 and is all-in'])).toEqual([
      { type: 8, seat: 1, value: 500, street: 0 },
      { type: 7, seat: 2, value: 500, street: 0 },
      END,
    ]);
  });

  it('turns a straddle into a bet/raise', () => {
    expect(payloads([
      'alice: posts small blind $0.05',
      'bob: posts big blind $0.10',
      'alice: posts a straddle of $0.20',
    ])).toEqual([{ type: 8, seat: 1, value: 20, street: 0 }, END]);
  });

  it('posts no event for a combined small & big blind', () => {
    expect(payloads(['alice: posts small & big blinds $0.15', 'bob: checks'])).toEqual([{ type: 0, seat: 2 }, END]);
  });

  it('lands folds, checks, shows, wins and the uncalled bet on the right seats', () => {
    expect(parseFile('stars-general.txt').rawHands[0].events.map((e) => e.payload)).toEqual([
      { type: 7, seat: 1, value: 10, street: 0 },
      { type: 11, seat: 2 },
      { type: 8, seat: 3, value: 50, street: 0 },
      { type: 11, seat: 4 },
      { type: 11, seat: 5 },
      { type: 11, seat: 6 },
      { type: 7, seat: 1, value: 50, street: 0 },
      { type: 9, cards: ['Qh', 'Jc', '3h'], turn: 1, run: 1 },
      { type: 0, seat: 1 },
      { type: 8, seat: 3, value: 95, street: 1 },
      { type: 11, seat: 1 },
      { type: 16, seat: 3, value: 95 },
      { type: 10, seat: 3, value: 121 },
      END,
    ]);
  });

  it('emits one WIN per collected line and none from the summary', () => {
    const wins = parseFile('stars-general.txt').rawHands[0].events.filter((e) => e.payload.type === 10);
    expect(wins.map((e) => e.payload)).toEqual([{ type: 10, seat: 3, value: 121 }]);
    expect(payloads(['alice collected $3 from main pot', 'alice collected $2 from side pot'])).toEqual([
      { type: 10, seat: 1, value: 300 },
      { type: 10, seat: 1, value: 200 },
      END,
    ]);
  });

  it('deals the board with a street turn and run 1', () => {
    expect(payloads([
      '*** FLOP *** [2c 7d 9h]',
      '*** TURN *** [2c 7d 9h] [3s]',
      '*** RIVER *** [2c 7d 9h 3s] [Kd]',
    ])).toEqual([
      { type: 9, cards: ['2c', '7d', '9h'], turn: 1, run: 1 },
      { type: 9, cards: ['3s'], turn: 2, run: 1 },
      { type: 9, cards: ['Kd'], turn: 3, run: 1 },
      END,
    ]);
  });

  it('tags a second runout run 2 and drops a third', () => {
    expect(payloads([
      '*** FIRST FLOP *** [2c 7d 9h]',
      '*** SECOND FLOP *** [4c 5d 6h]',
      '*** THIRD FLOP *** [8c 8d 8h]',
      '*** FIRST TURN *** [2c 7d 9h] [3s]',
      '*** SECOND TURN *** [4c 5d 6h] [Ts]',
      '*** THIRD TURN *** [8c 8d 8h] [Js]',
    ])).toEqual([
      { type: 9, cards: ['2c', '7d', '9h'], turn: 1, run: 1 },
      { type: 9, cards: ['4c', '5d', '6h'], turn: 1, run: 2 },
      { type: 9, cards: ['3s'], turn: 2, run: 1 },
      { type: 9, cards: ['Ts'], turn: 2, run: 2 },
      END,
    ]);
  });

  it('takes only the last bracket on a turn or river marker', () => {
    const deals = parseFile('stars-allin.txt').rawHands[0].events.filter((e) => e.payload.type === 9);
    expect(deals.map((e) => e.payload.cards)).toEqual([['5c', '4c', '4h'], ['Qs'], ['Kc']]);
  });

  it('drops a show that is not two cards', () => {
    expect(payloads([
      'alice: shows [Ad Kh Qs Js] (a pair of Kings)',
      'bob: shows [7h 6h] (a full house)',
    ])).toEqual([{ type: 12, seat: 2, cards: ['7h', '6h'] }, END]);
  });

  it('resets the street total on each new street', () => {
    expect(payloads([
      'alice: posts small blind $0.05',
      'bob: posts big blind $0.10',
      'alice: calls $0.05',
      '*** FLOP *** [2c 7d 9h]',
      'alice: bets $0.10',
    ]).filter((p) => p.type !== 9)).toEqual([
      { type: 7, seat: 1, value: 10, street: 0 },
      { type: 8, seat: 1, value: 10, street: 1 },
      END,
    ]);
  });
});

describe('noise', () => {
  it('ignores chat, even when the chat text reads like an action', () => {
    expect(payloads([
      'alice said, "nice hand"',
      'bob said, "alice: folds"',
      'alice: checks',
    ])).toEqual([{ type: 0, seat: 1 }, END]);
  });

  it('ignores table notices', () => {
    expect(payloads([
      'alice joins the table at seat #5',
      'bob leaves the table',
      'alice: sits out',
      'bob is disconnected',
      'bob is connected',
      'alice has timed out',
      "bob: doesn't show hand",
      'alice: mucks hand',
      'YurNas will be allowed to play after the button',
    ])).toEqual([END]);
  });

  it('drops a seat that is sitting out', () => {
    const seats = [...SEATS, 'Seat 3: ghost ($10 in chips) is sitting out '];
    const h = handOf(['ghost: folds'], { seats });
    expect(h.players.map((p) => p.name)).toEqual(['alice', 'bob']);
    expect(h.events.map((e) => e.payload)).toEqual([END]);
  });

  it('ignores a player with no seat line', () => {
    expect(payloads([
      'zed: bets $5',
      'zed: folds',
      'Uncalled bet ($5) returned to zed',
      'zed collected $5 from pot',
    ])).toEqual([END]);
  });

  it('keeps only the seats the summary lists', () => {
    const h = handOf(['*** SUMMARY ***', 'Total pot $10 | Rake $0', 'Seat 1: alice collected ($10)']);
    expect(h.players.map((p) => p.name)).toEqual(['alice']);
  });
});

describe('through the converter', () => {
  it('converts every specimen into a valid replay', () => {
    for (const f of ['stars-general.txt', 'stars-allin.txt', 'stars-showdown.txt', 'gg-cash.txt', 'gg-tourney.txt']) {
      const out = parseFile(f);
      const conv = convertAllHands(out.rawHands, out.exportHeroId);
      expect(conv).toHaveLength(1);
      expect(conv[0].valid).toBe(true);
    }
  });

  it('converts all ten hands of the multi file', () => {
    const out = parseFile('stars-multi.txt');
    const conv = convertAllHands(out.rawHands, out.exportHeroId);
    expect(conv.map((h) => h.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(conv.every((h) => h.valid)).toBe(true);
  });

  it('rebuilds the all-in hand from the button around', () => {
    const h = convertAllHands(parseFile('stars-allin.txt').rawHands, null)[0];
    expect(h.replay.setup.seats).toEqual([
      { name: 'hana', stack: 1226, pos: 'BTN', cards: cardsOf('8h 8c') },
      { name: 'ivo', stack: 3874, pos: 'SB', cards: cardsOf('Ah Ks') },
      { name: 'jo', stack: 2106, pos: 'BB', cards: null },
      { name: 'kit', stack: 1021, pos: 'UTG', cards: null },
      { name: 'gus', stack: 1500, pos: 'CO', cards: null },
    ]);
    expect([h.replay.setup.sb, h.replay.setup.bb, h.replay.setup.ante, h.replay.setup.cents]).toEqual([5, 10, 2, true]);
    expect(h.replay.won).toEqual({ 1: 2357 });
    expect(boardText(h.replay.board)).toBe('5c 4c 4h Qs Kc');
    expect(h.summary.stakes).toBe('$0.05/$0.1');
  });

  it('carries the hero, both boards and the split for a run-twice GG hand', () => {
    const out = parseFile('gg-cash.txt');
    const h = convertAllHands(out.rawHands, out.exportHeroId)[0];
    expect(h.replay.hero).toBe(0);
    expect(h.summary.heroCards).toEqual(cardsOf('Ad Kh'));
    expect(h.replay.setup.seats[0].pos).toBe('BTN');
    expect(boardText(h.replay.board)).toBe('3s 3d Th 7s Kd');
    expect(boardText(h.replay.board2)).toBe('8d 2d 4s 8h 3c');
    expect(h.summary.runTwice).toBe(true);
    expect(h.replay.won).toEqual({ 0: 5595, 5: 5595 });
    expect(h.replay.runResults).toEqual([{ run: 1, won: { 0: 5595 } }, { run: 2, won: { 5: 5595 } }]);
    expect(h.summary.stakes).toBe('$0.25/$0.5');
  });

  it('orders a big-blind ante button-first and leaves chip stakes bare', () => {
    const out = parseFile('gg-tourney.txt');
    const h = convertAllHands(out.rawHands, out.exportHeroId)[0];
    expect(h.replay.setup.seats.map((s) => [s.name, s.pos])).toEqual([
      ['0cc8e142', 'BTN'], ['4f2b9c01', 'SB'], ['Hero', 'BB'], ['a71de55f', 'UTG'],
    ]);
    expect(h.replay.setup.antes).toEqual([0, 0, 600, 0]);
    expect(h.replay.setup.cents).toBe(false);
    expect(h.summary.stakes).toBe('300/600');
    expect(h.replay.hero).toBe(2);
    expect(h.replay.won).toEqual({ 2: 13500 });
  });

  it('pivots a cash hand around whoever was dealt in', () => {
    const rawHands = parseFile('gg-cash.txt').rawHands;
    expect(convertHandsFor(rawHands, 'Hero')).toHaveLength(1);
    expect(convertHandsFor(rawHands, '9e467dd0')[0].replay.hero).toBe(5);
    expect(convertHandsFor(rawHands, 'nobody')).toHaveLength(0);
  });
});
