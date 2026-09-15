import { describe, it, expect } from 'vitest';
import { parsePokerNowCsv, parseCsv, isPokerNowCsv, cardCode } from './pokernowCsv.js';
import { convertHandsFor, convertAllHands } from './pokernowImport.js';
import { sessionLabel, cleanSessionLabel } from './sessionStats.js';

const card = (s) => ({ v: s[0], s: s[1] });

// EV codes: CHECK 0, POST_BB 2, POST_SB 3, CALL 7, BET_RAISE 8, DEAL 9, WIN 10, FOLD 11, SHOW 12, END 15, UNCALLED 16
const END = { type: 15 };

const q = (s) => '"' + s.replace(/"/g, '""') + '"';
const AT = '2026-09-15T18:44:06.093Z';

// entries go in play order; the file is written the way PokerNow downloads it —
// newest first, with `order` ascending in play order
function csvLog(entries, { order = true, arrange } = {}) {
  const rows = entries.map((e, i) => (order ? [q(e), AT, String(100 + i)] : [q(e), AT]));
  const body = arrange ? arrange(rows) : [...rows].reverse();
  return [order ? 'entry,at,order' : 'entry,at', ...body.map((r) => r.join(','))].join('\n') + '\n';
}
const parseEntries = (entries, opts) => parsePokerNowCsv(csvLog(entries, opts));

const TIM_BTN = '-- starting hand #7 (id: h7)  No Limit Texas Hold\'em (dealer: "tim @ t1") --';
const STACKS = 'Player stacks: #1 "tim @ t1" (5000) | #2 "bob @ b2" (3000)';

const wrap = (mid, head = TIM_BTN, stacks = STACKS) =>
  [head, ...(stacks ? [stacks] : []), ...mid, `-- ending hand #${head.match(/#(\d+)/)[1]} --`];
const handOf = (mid, head, stacks) => parseEntries(wrap(mid, head, stacks)).rawHands[0];
const payloads = (mid, head, stacks) => handOf(mid, head, stacks).events.map((e) => e.payload);

describe('parseCsv', () => {
  it('reads quoted fields with doubled quotes and embedded commas', () => {
    expect(parseCsv('entry,at\n"say ""hi"", ok",1')).toEqual([['entry', 'at'], ['say "hi", ok', '1']]);
  });

  it('accepts CRLF endings and swallows the trailing newline', () => {
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('keeps a newline inside a quoted field', () => {
    expect(parseCsv('a,b\n"line1\nline2",d')).toEqual([['a', 'b'], ['line1\nline2', 'd']]);
  });
});

describe('isPokerNowCsv', () => {
  it('accepts the entry header past a BOM, leading whitespace, or odd case', () => {
    expect(isPokerNowCsv('entry,at,order\n')).toBe(true);
    expect(isPokerNowCsv('﻿entry,at,order')).toBe(true);
    expect(isPokerNowCsv('  \n entry,at')).toBe(true);
    expect(isPokerNowCsv('ENTRY,At,Order')).toBe(true);
  });

  it('rejects JSON and random text', () => {
    expect(isPokerNowCsv('{"hands":[]}')).toBe(false);
    expect(isPokerNowCsv('hello world')).toBe(false);
    expect(isPokerNowCsv('at,order,entries')).toBe(false);
  });

  it('finds the entry column wherever it sits, quoted or not', () => {
    expect(isPokerNowCsv('at,order,entry')).toBe(true);
    expect(isPokerNowCsv('"entry","at","order"\n"x",1,2')).toBe(true);
  });
});

describe('cardCode', () => {
  it('maps rank and suit, with 10 as T', () => {
    expect(['10♥', 'A♣', 'K♦', '10♠', '2♠'].map(cardCode)).toEqual(['Th', 'Ac', 'Kd', 'Ts', '2s']);
  });

  it('returns null for anything that is not a card', () => {
    expect(['1♥', 'X♥', '10x', 'Q', '', 'a♣'].map(cardCode)).toEqual([null, null, null, null, null, null]);
  });
});

// two hands back to back; the first carries blinds so the two differ in event count
const TWO_HANDS = [
  '-- starting hand #1 (id: h1)  No Limit Texas Hold\'em (dealer: "tim @ t1") --',
  STACKS,
  '"tim @ t1" posts a small blind of 10',
  '"bob @ b2" posts a big blind of 20',
  '-- ending hand #1 --',
  '-- starting hand #2 (id: h2)  No Limit Texas Hold\'em (dealer: "bob @ b2") --',
  STACKS,
  '-- ending hand #2 --',
];
const shape = (out) => out.rawHands.map((h) => [h.number, h.events.length]);

describe('row ordering', () => {
  it('sorts by the order column however the rows are laid out', () => {
    const shuffle = (r) => [r[3], r[0], r[7], r[5], r[2], r[6], r[1], r[4]];
    expect(shape(parseEntries(TWO_HANDS, { arrange: shuffle }))).toEqual([['1', 3], ['2', 1]]);
  });

  it('falls back to reversed file order without an order column', () => {
    expect(shape(parseEntries(TWO_HANDS, { order: false }))).toEqual([['1', 3], ['2', 1]]);
  });

  it('falls back to reversed file order when order is non-numeric', () => {
    const text = csvLog(TWO_HANDS).replace(/,10\d$/gm, ',later');
    expect(shape(parsePokerNowCsv(text))).toEqual([['1', 3], ['2', 1]]);
  });
});

describe('parsePokerNowCsv guards', () => {
  it('throws NOT_POKERNOW on an empty file', () => {
    expect(() => parsePokerNowCsv('')).toThrow('NOT_POKERNOW');
  });

  it('throws NOT_POKERNOW on a header with no entry column', () => {
    expect(() => parsePokerNowCsv('at,order\n"x",1\n')).toThrow('NOT_POKERNOW');
  });

  it('returns nothing for a log with no hands', () => {
    const out = parseEntries([
      'The player "tim @ t1" requested a seat.',
      'The admin approved the player "tim @ t1" participation with a stack of 5000.',
    ]);
    expect(out).toEqual({ exportHeroId: null, players: [], rawHands: [] });
  });

  it('leaves a hand with no stacks line seatless', () => {
    const out = parseEntries(wrap(['"tim @ t1" posts a small blind of 10'], TIM_BTN, null));
    expect(out.rawHands[0].players).toEqual([]);
    expect(out.rawHands[0].events.map((e) => e.payload)).toEqual([END]);
    expect(out.players).toEqual([]);
  });
});

describe('event lines', () => {
  it('turns a straddle into a bet/raise', () => {
    expect(payloads(['"tim @ t1" posts a straddle of 40'])).toEqual([{ type: 8, seat: 1, value: 40 }, END]);
  });

  it('records an ante on the hand without an event', () => {
    const h = handOf(['"tim @ t1" posts an ante of 5']);
    expect(h.ante).toBe(5);
    expect(h.events.map((e) => e.payload)).toEqual([END]);
  });

  it('parses the "and go all in" phrasings by their verb', () => {
    expect(payloads([
      '"tim @ t1" calls 1640 and go all in',
      '"bob @ b2" raises to 1640 and go all in',
      '"tim @ t1" bets 300 and go all in',
    ])).toEqual([
      { type: 7, seat: 1, value: 1640 },
      { type: 8, seat: 2, value: 1640 },
      { type: 8, seat: 1, value: 300 },
      END,
    ]);
  });

  it('drops a single-card show', () => {
    expect(payloads(['"bob @ b2" shows a Q♣.'])).toEqual([END]);
    expect(payloads(['"bob @ b2" shows a Q♣, 7♦.'])).toEqual([{ type: 12, seat: 2, cards: ['Qc', '7d'] }, END]);
  });

  it('tags the second runout with run 2', () => {
    expect(payloads([
      'Flop:  [2♣, 7♦, 9♥]',
      'Flop (second run):  [2♣, 7♦, 9♥]',
      'Turn: 2♣, 7♦, 9♥ [3♠]',
      'Turn (second run): 2♣, 7♦, 9♥ [4♦]',
      'River: 2♣, 7♦, 9♥, 3♠ [5♦]',
      'River (second run): 2♣, 7♦, 9♥, 4♦ [K♥]',
    ])).toEqual([
      { type: 9, cards: ['2c', '7d', '9h'], turn: 1, run: 1 },
      { type: 9, cards: ['2c', '7d', '9h'], turn: 1, run: 2 },
      { type: 9, cards: ['3s'], turn: 2, run: 1 },
      { type: 9, cards: ['4d'], turn: 2, run: 2 },
      { type: 9, cards: ['5d'], turn: 3, run: 1 },
      { type: 9, cards: ['Kh'], turn: 3, run: 2 },
      END,
    ]);
  });

  it('ignores actions from players who are not in the stacks line', () => {
    expect(payloads(['"zed @ z9" bets 500', '"zed @ z9" folds', 'Uncalled bet of 500 returned to "zed @ z9"'])).toEqual([END]);
  });

  it('ignores join, quit and admin chatter', () => {
    expect(payloads([
      'The player "tim @ t1" joined the game with a stack of 5000.',
      'The player "bob @ b2" quits the game with a stack of 0.',
      'The admin "tim @ t1" enqueued the game stop on next hand.',
      'The admin approved the player "bob @ b2" participation with a stack of 3000.',
    ])).toEqual([END]);
  });

  it('gives a dealer who never sat down seat -1', () => {
    const head = '-- starting hand #1 (id: h1)  No Limit Texas Hold\'em (dealer: "zed @ z9") --';
    expect(handOf([], head).dealerSeat).toBe(-1);
  });

  it('marks an Omaha hand plo and keeps it out of the roster and the converter', () => {
    const head = '-- starting hand #4 (id: h4)  Pot Limit Omaha Hi (dealer: "tim @ t1") --';
    const out = parseEntries(wrap([], head));
    expect(out.rawHands[0].gameType).toBe('plo');
    expect(out.players).toEqual([]);
    expect(convertAllHands(out.rawHands, 't1')).toHaveLength(0);
  });

  it('counts roster hands per id and keeps the most-used name', () => {
    const seats = (a, b) => `Player stacks: #1 "${a}" (5000) | #2 "${b}" (3000)`;
    const out = parseEntries([
      '-- starting hand #1 (id: h1)  No Limit Texas Hold\'em (dealer: "tim @ t1") --',
      seats('tim @ t1', 'bob @ b2'), '-- ending hand #1 --',
      '-- starting hand #2 (id: h2)  No Limit Texas Hold\'em (dealer: "tim @ t1") --',
      seats('timmy @ t1', 'bob @ b2'), '-- ending hand #2 --',
      '-- starting hand #3 (id: h3)  No Limit Texas Hold\'em (dealer: "tim @ t1") --',
      seats('tim @ t1', 'cat @ c3'), '-- ending hand #3 --',
    ]);
    expect(out.players).toEqual([
      { id: 't1', name: 'tim', count: 3 },
      { id: 'b2', name: 'bob', count: 2 },
      { id: 'c3', name: 'cat', count: 1 },
    ]);
  });
});

// three heads-up hands, tim vs bob; the download is newest first
const LOG3 = `entry,at,order
"The player ""tim @ 9gyYp6LpBZ"" quits the game with a stack of 0.",2026-09-15T18:45:59.442Z,178949795944200
"-- ending hand #3 --",2026-09-15T18:45:53.358Z,178949795335801
"""bob @ NiO4b7CURk"" collected 3280 from pot with Pair, Q's (combination: 10♥, J♦, A♣, Q♣, Q♥)",2026-09-15T18:45:53.358Z,178949795335800
"River: 6♦, J♦, 3♠, 10♥ [A♣]",2026-09-15T18:45:49.294Z,178949794929400
"Turn: 6♦, J♦, 3♠ [10♥]",2026-09-15T18:45:45.292Z,178949794529200
"Flop:  [6♦, J♦, 3♠]",2026-09-15T18:45:41.273Z,178949794127300
"""bob @ NiO4b7CURk"" shows a Q♣, Q♥.",2026-09-15T18:45:37.253Z,178949793725301
"""tim @ 9gyYp6LpBZ"" shows a 9♣, 4♥.",2026-09-15T18:45:37.253Z,178949793725300
"""bob @ NiO4b7CURk"" calls 1640",2026-09-15T18:45:36.408Z,178949793640800
"""tim @ 9gyYp6LpBZ"" raises to 1640 and go all in",2026-09-15T18:45:34.166Z,178949793416600
"""bob @ NiO4b7CURk"" raises to 60",2026-09-15T18:45:30.841Z,178949793084100
"""tim @ 9gyYp6LpBZ"" posts a big blind of 20",2026-09-15T18:45:23.550Z,178949792355005
"""bob @ NiO4b7CURk"" posts a small blind of 10",2026-09-15T18:45:23.550Z,178949792355004
"Your hand is 9♣, 4♥",2026-09-15T18:45:23.550Z,178949792355002
"Player stacks: #1 ""tim @ 9gyYp6LpBZ"" (1640) | #2 ""bob @ NiO4b7CURk"" (6360)",2026-09-15T18:45:23.550Z,178949792355001
"-- starting hand #3 (id: uyg5zrdy2bt7)  No Limit Texas Hold'em (dealer: ""bob @ NiO4b7CURk"") --",2026-09-15T18:45:23.550Z,178949792355000
"-- ending hand #2 --",2026-09-15T18:45:17.538Z,178949791753801
"""bob @ NiO4b7CURk"" collected 6360 from pot with Straight, A High (combination: 10♠, J♦, Q♦, K♣, A♦)",2026-09-15T18:45:17.538Z,178949791753800
"River: A♠, A♦, 2♦, 10♠ [J♦]",2026-09-15T18:45:13.529Z,178949791352900
"Turn: A♠, A♦, 2♦ [10♠]",2026-09-15T18:45:09.521Z,178949790952100
"Flop:  [A♠, A♦, 2♦]",2026-09-15T18:45:05.516Z,178949790551600
"""bob @ NiO4b7CURk"" shows a K♣, Q♦.",2026-09-15T18:45:01.502Z,178949790150201
"""tim @ 9gyYp6LpBZ"" shows a 3♠, J♠.",2026-09-15T18:45:01.502Z,178949790150200
"""tim @ 9gyYp6LpBZ"" calls 3180",2026-09-15T18:45:00.575Z,178949790057500
"""bob @ NiO4b7CURk"" raises to 3180 and go all in",2026-09-15T18:44:58.442Z,178949789844200
"""tim @ 9gyYp6LpBZ"" raises to 60",2026-09-15T18:44:55.668Z,178949789566800
"""bob @ NiO4b7CURk"" posts a big blind of 20",2026-09-15T18:44:52.324Z,178949789232405
"""tim @ 9gyYp6LpBZ"" posts a small blind of 10",2026-09-15T18:44:52.324Z,178949789232404
"Your hand is 3♠, J♠",2026-09-15T18:44:52.324Z,178949789232402
"Player stacks: #1 ""tim @ 9gyYp6LpBZ"" (4820) | #2 ""bob @ NiO4b7CURk"" (3180)",2026-09-15T18:44:52.324Z,178949789232401
"-- starting hand #2 (id: 97z2xhxihtja)  No Limit Texas Hold'em (dealer: ""tim @ 9gyYp6LpBZ"") --",2026-09-15T18:44:52.324Z,178949789232400
"-- ending hand #1 --",2026-09-15T18:44:49.399Z,178949788939902
"""bob @ NiO4b7CURk"" collected 360 from pot",2026-09-15T18:44:49.399Z,178949788939901
"Uncalled bet of 360 returned to ""bob @ NiO4b7CURk""",2026-09-15T18:44:49.399Z,178949788939900
"""tim @ 9gyYp6LpBZ"" folds",2026-09-15T18:44:48.559Z,178949788855900
"""bob @ NiO4b7CURk"" raises to 480",2026-09-15T18:44:45.462Z,178949788546200
"""tim @ 9gyYp6LpBZ"" bets 120",2026-09-15T18:44:40.017Z,178949788001700
"River: 10♦, J♦, J♣, 3♠ [2♦]",2026-09-15T18:44:32.247Z,178949787224700
"""bob @ NiO4b7CURk"" checks",2026-09-15T18:44:31.407Z,178949787140700
"""tim @ 9gyYp6LpBZ"" checks",2026-09-15T18:44:29.834Z,178949786983400
"Turn: 10♦, J♦, J♣ [3♠]",2026-09-15T18:44:24.972Z,178949786497200
"""bob @ NiO4b7CURk"" checks",2026-09-15T18:44:24.136Z,178949786413600
"""tim @ 9gyYp6LpBZ"" checks",2026-09-15T18:44:21.726Z,178949786172600
"Flop:  [10♦, J♦, J♣]",2026-09-15T18:44:17.236Z,178949785723600
"""tim @ 9gyYp6LpBZ"" calls 60",2026-09-15T18:44:16.426Z,178949785642600
"""bob @ NiO4b7CURk"" raises to 60",2026-09-15T18:44:14.305Z,178949785430500
"""tim @ 9gyYp6LpBZ"" posts a big blind of 20",2026-09-15T18:44:06.093Z,178949784609307
"""bob @ NiO4b7CURk"" posts a small blind of 10",2026-09-15T18:44:06.093Z,178949784609306
"Your hand is 7♥, 6♣",2026-09-15T18:44:06.093Z,178949784609304
"Player stacks: #1 ""tim @ 9gyYp6LpBZ"" (5000) | #2 ""bob @ NiO4b7CURk"" (3000)",2026-09-15T18:44:06.093Z,178949784609303
"The player ""bob @ NiO4b7CURk"" joined the game with a stack of 3000.",2026-09-15T18:44:06.093Z,178949784609302
"The player ""tim @ 9gyYp6LpBZ"" joined the game with a stack of 5000.",2026-09-15T18:44:06.093Z,178949784609301
"-- starting hand #1 (id: sx29sxn7kmfv)  No Limit Texas Hold'em (dealer: ""bob @ NiO4b7CURk"") --",2026-09-15T18:44:06.093Z,178949784609300
"The admin approved the player ""bob @ NiO4b7CURk"" participation with a stack of 3000.",2026-09-15T18:44:04.613Z,178949784461300
"The player ""bob @ NiO4b7CURk"" requested a seat.",2026-09-15T18:44:01.118Z,178949784111800
"The admin approved the player ""tim @ 9gyYp6LpBZ"" participation with a stack of 5000.",2026-09-15T18:43:51.711Z,178949783171101
"The player ""tim @ 9gyYp6LpBZ"" requested a seat.",2026-09-15T18:43:51.711Z,178949783171100
`;

// one hand, no showdown, seats 9 and 10
const LOG1 = `entry,at,order
"The admin ""tim @ 9gyYp6LpBZ"" enqueued the game stop on next hand.",2026-05-25T05:44:14.162Z,177968785416200
"-- ending hand #1 --",2026-05-25T05:44:12.965Z,177968785296502
"""bob @ uhK9pElohE"" collected 300 from pot",2026-05-25T05:44:12.965Z,177968785296501
"Uncalled bet of 300 returned to ""bob @ uhK9pElohE""",2026-05-25T05:44:12.965Z,177968785296500
"""tim @ 9gyYp6LpBZ"" folds",2026-05-25T05:44:12.135Z,177968785213500
"""bob @ uhK9pElohE"" bets 300",2026-05-25T05:44:08.428Z,177968784842800
"River: 9♥, 2♥, 5♠, 2♠ [K♦]",2026-05-25T05:44:04.157Z,177968784415700
"""tim @ 9gyYp6LpBZ"" calls 90",2026-05-25T05:44:03.305Z,177968784330500
"""bob @ uhK9pElohE"" bets 90",2026-05-25T05:44:00.164Z,177968784016400
"Turn: 9♥, 2♥, 5♠ [2♠]",2026-05-25T05:43:53.366Z,177968783336600
"""tim @ 9gyYp6LpBZ"" checks",2026-05-25T05:43:52.480Z,177968783248000
"""bob @ uhK9pElohE"" checks",2026-05-25T05:43:50.509Z,177968783050900
"Flop:  [9♥, 2♥, 5♠]",2026-05-25T05:43:36.740Z,177968781674000
"""bob @ uhK9pElohE"" calls 60",2026-05-25T05:43:35.927Z,177968781592700
"""tim @ 9gyYp6LpBZ"" raises to 60",2026-05-25T05:43:32.350Z,177968781235000
"""bob @ uhK9pElohE"" posts a big blind of 20",2026-05-25T05:43:25.537Z,177968780553707
"""tim @ 9gyYp6LpBZ"" posts a small blind of 10",2026-05-25T05:43:25.537Z,177968780553706
"Your hand is 8♥, 8♠",2026-05-25T05:43:25.537Z,177968780553704
"Player stacks: #9 ""tim @ 9gyYp6LpBZ"" (500) | #10 ""bob @ uhK9pElohE"" (500)",2026-05-25T05:43:25.537Z,177968780553703
"The player ""bob @ uhK9pElohE"" joined the game with a stack of 500.",2026-05-25T05:43:25.537Z,177968780553702
"The player ""tim @ 9gyYp6LpBZ"" joined the game with a stack of 500.",2026-05-25T05:43:25.537Z,177968780553701
"-- starting hand #1 (id: 9z8nlnggmgl0)  No Limit Texas Hold'em (dealer: ""tim @ 9gyYp6LpBZ"") --",2026-05-25T05:43:25.537Z,177968780553700
"The admin approved the player ""tim @ 9gyYp6LpBZ"" participation with a stack of 500.",2026-05-25T05:43:23.183Z,177968780318301
"The player ""tim @ 9gyYp6LpBZ"" requested a seat.",2026-05-25T05:43:23.183Z,177968780318300
"The admin approved the player ""bob @ uhK9pElohE"" participation with a stack of 500.",2026-05-25T05:43:19.609Z,177968779960900
"The player ""bob @ uhK9pElohE"" requested a seat.",2026-05-25T05:43:16.372Z,177968779637200
`;

describe('three-hand heads-up log', () => {
  const parsed = () => parsePokerNowCsv(LOG3);

  it('infers the hero from a showdown reveal and replays the order column', () => {
    const out = parsed();
    expect(out.exportHeroId).toBe('9gyYp6LpBZ');
    expect(out.rawHands.map((h) => h.number)).toEqual(['1', '2', '3']);
    expect(out.players).toEqual([
      { id: 'NiO4b7CURk', name: 'bob', count: 3 },
      { id: '9gyYp6LpBZ', name: 'tim', count: 3 },
    ]);
  });

  it('moves "Your hand is" onto the hero player entry', () => {
    const hands = parsed().rawHands;
    expect(hands.map((h) => h.players.find((p) => p.id === '9gyYp6LpBZ').hand))
      .toEqual([['7h', '6c'], ['3s', 'Js'], ['9c', '4h']]);
    expect(hands.every((h) => !('yourHand' in h))).toBe(true);
    expect(hands.every((h) => !h.players.find((p) => p.id === 'NiO4b7CURk').hand)).toBe(true);
  });

  it('rebuilds hand 1 seats, blinds and the whole event stream', () => {
    const h = parsed().rawHands[0];
    expect(h.id).toBe('sx29sxn7kmfv');
    expect(h.gameType).toBe('th');
    expect(h.dealerSeat).toBe(2);
    expect([h.smallBlind, h.bigBlind, h.ante]).toEqual([10, 20, 0]);
    expect(h.players.map((p) => [p.seat, p.name, p.id, p.stack])).toEqual([
      [1, 'tim', '9gyYp6LpBZ', 5000],
      [2, 'bob', 'NiO4b7CURk', 3000],
    ]);
    expect(h.events.map((e) => e.payload)).toEqual([
      { type: 3, seat: 2, value: 10 },
      { type: 2, seat: 1, value: 20 },
      { type: 8, seat: 2, value: 60 },
      { type: 7, seat: 1, value: 60 },
      { type: 9, cards: ['Td', 'Jd', 'Jc'], turn: 1, run: 1 },
      { type: 0, seat: 1 },
      { type: 0, seat: 2 },
      { type: 9, cards: ['3s'], turn: 2, run: 1 },
      { type: 0, seat: 1 },
      { type: 0, seat: 2 },
      { type: 9, cards: ['2d'], turn: 3, run: 1 },
      { type: 8, seat: 1, value: 120 },
      { type: 8, seat: 2, value: 480 },
      { type: 11, seat: 1 },
      { type: 16, seat: 2, value: 360 },
      { type: 10, seat: 2, value: 360 },
      END,
    ]);
  });

  it('turns showdown reveals into SHOW events and collections into WIN', () => {
    const [, h2, h3] = parsed().rawHands;
    expect(h2.dealerSeat).toBe(1);
    expect(h2.events.filter((e) => e.payload.type === 12).map((e) => e.payload)).toEqual([
      { type: 12, seat: 1, cards: ['3s', 'Js'] },
      { type: 12, seat: 2, cards: ['Kc', 'Qd'] },
    ]);
    expect(h2.events.filter((e) => e.payload.type === 10).map((e) => e.payload)).toEqual([{ type: 10, seat: 2, value: 6360 }]);
    expect(h3.events.filter((e) => e.payload.type === 10).map((e) => e.payload)).toEqual([{ type: 10, seat: 2, value: 3280 }]);
  });

  it('converts all three hands around the hero', () => {
    const out = convertHandsFor(parsed().rawHands, '9gyYp6LpBZ');
    expect(out.map((h) => h.number)).toEqual([1, 2, 3]);
    expect(out.every((h) => h.valid)).toBe(true);
    expect(out.map((h) => h.replay.hero)).toEqual([1, 0, 1]);
    expect(out.map((h) => h.replay.board.map((c) => c.v + c.s).join(' '))).toEqual([
      'Td Jd Jc 3s 2d',
      'As Ad 2d Ts Jd',
      '6d Jd 3s Th Ac',
    ]);
    expect(out.map((h) => h.replay.won)).toEqual([{ 0: 360 }, { 1: 6360 }, { 0: 3280 }]);
    expect(out.map((h) => h.summary.stakes)).toEqual(['$0.1/$0.2', '$0.1/$0.2', '$0.1/$0.2']);
  });

  it('gives the hero the cards the log only ever showed as "Your hand is"', () => {
    const h1 = convertHandsFor(parsePokerNowCsv(LOG3).rawHands, '9gyYp6LpBZ')[0];
    expect(h1.summary.heroCards).toEqual([card('7h'), card('6c')]);
    expect(h1.replay.setup.seats[0].cards).toBe(null); // bob never showed
  });
});

describe('one-hand log with no showdown', () => {
  const parsed = () => parsePokerNowCsv(LOG1);

  it('leaves the hero unknown and the hole cards on the hand', () => {
    const out = parsed();
    expect(out.exportHeroId).toBe(null);
    const h = out.rawHands[0];
    expect(h.yourHand).toEqual(['8h', '8s']);
    expect(h.players.map((p) => [p.seat, p.name, p.id])).toEqual([
      [9, 'tim', '9gyYp6LpBZ'],
      [10, 'bob', 'uhK9pElohE'],
    ]);
    expect(h.dealerSeat).toBe(9);
    expect(h.players.some((p) => p.hand)).toBe(false);
  });

  it('hands the cards to whichever player you say you are', () => {
    const cards = [card('8h'), card('8s')];
    const asTim = convertHandsFor(parsed().rawHands, '9gyYp6LpBZ')[0];
    expect(asTim.valid).toBe(true);
    expect(asTim.replay.hero).toBe(0);
    expect(asTim.replay.setup.seats.map((s) => s.cards)).toEqual([cards, null]);
    expect(asTim.replay.won).toEqual({ 1: 300 });

    const asBob = convertHandsFor(parsed().rawHands, 'uhK9pElohE')[0];
    expect(asBob.replay.hero).toBe(1);
    expect(asBob.replay.setup.seats.map((s) => s.cards)).toEqual([null, cards]);
  });

  it('leaves both seats cardless when nobody is picked', () => {
    const h = convertAllHands(parsed().rawHands, null)[0];
    expect(h.replay.hero).toBe(null);
    expect(h.replay.setup.seats.map((s) => s.cards)).toEqual([null, null]);
  });
});

describe('session labels', () => {
  it('strips .csv the same way as .json', () => {
    expect(sessionLabel('poker_now_log_abc.csv')).toBe('poker_now_log_abc');
    expect(sessionLabel('poker_now_log_abc.csv')).toBe(sessionLabel('poker_now_log_abc.json'));
  });

  it('drops a generated .csv export name', () => {
    expect(cleanSessionLabel('poker_now_log_pglXYZ.csv')).toBe(null);
    expect(cleanSessionLabel('friday game.csv')).toBe('friday game');
  });
});
