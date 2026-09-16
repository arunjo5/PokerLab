import { describe, it, expect } from 'vitest';
import { ReplayEngine as E } from './replayerEngine.js';
import { encodeReplay, decodeReplay } from './replayShare.js';

const C = (str) => { const o = []; for (let i = 0; i < str.length; i += 2) o.push({ v: str[i], s: str[i + 1] }); return o; };
function mkSetup(n, opts = {}) {
  const labels = E.positionsForCount(n);
  const seats = [];
  for (let i = 0; i < n; i++) {
    seats.push({ name: '', stack: (opts.stacks ? opts.stacks[i] : opts.stack) || 200, pos: labels[i], cards: null });
  }
  const setup = { sb: opts.sb || 1, bb: opts.bb || 2, ante: opts.ante || 0, seats };
  if (opts.antes) setup.antes = opts.antes;
  return setup;
}
const chipTotal = (st) => st.stacks.reduce((a, b) => a + b, 0) + st.pot;

describe('uncalled chips when a short stack calls all-in', () => {
  it('preflop shove refunds whatever the short caller could not cover', () => {
    const setup = mkSetup(2, { stacks: [200, 50] });
    const st = E.initState(setup);
    E.applyAction(st, { seat: 0, type: 'raise', amount: 200 });
    E.applyAction(st, { seat: 1, type: 'call' });
    expect(st.stacks).toEqual([150, 0]);
    expect(st.committed).toEqual([50, 50]);
    expect(st.streetContrib).toEqual([50, 50]);
    expect(st.pot).toBe(100); // only the 50 apiece that was ever contested
    expect(st.allin).toEqual([false, true]);
    expect(st.nextSeat).toBe(null);
    expect(st.handOver).toBe(false);
  });

  it('the refund leaves the table chip count untouched', () => {
    const setup = mkSetup(2, { stacks: [200, 50] });
    const st = E.initState(setup);
    E.applyAction(st, { seat: 0, type: 'raise', amount: 200 });
    E.applyAction(st, { seat: 1, type: 'call' });
    expect(chipTotal(st)).toBe(250);
  });

  it('buildReplay carries the contested pot to the last frame', () => {
    const setup = mkSetup(2, { stacks: [200, 50] });
    const actions = [
      { seat: 0, type: 'raise', amount: 200, street: 0 },
      { seat: 1, type: 'call', street: 0 },
    ];
    const last = E.buildReplay(setup, actions, C('2c7h9dThJs')).at(-1);
    expect(last.pot).toBe(100);
    expect(last.stacks).toEqual([150, 0]);
    expect(last.committed).toEqual([50, 50]);
    expect(last.allin).toEqual([false, true]);
    expect(last.boardDealt).toBe(5);
  });

  it('a caller who covers the shove gets nothing back', () => {
    const setup = mkSetup(2, { stacks: [50, 200] });
    const st = E.initState(setup);
    E.applyAction(st, { seat: 0, type: 'raise', amount: 50 });
    E.applyAction(st, { seat: 1, type: 'call' });
    expect(st.stacks).toEqual([0, 150]);
    expect(st.pot).toBe(100);
    expect(st.allin).toEqual([true, false]);
  });

  it('flop shove refunds the excess over the short call', () => {
    const setup = mkSetup(2, { stacks: [200, 60] });
    const st = E.initState(setup);
    E.applyAction(st, { seat: 0, type: 'call' });
    E.applyAction(st, { seat: 1, type: 'check' });
    E.advanceStreet(st, C('Ah7c2d'));
    E.applyAction(st, { seat: 1, type: 'check' });
    E.applyAction(st, { seat: 0, type: 'bet', amount: 198 });
    E.applyAction(st, { seat: 1, type: 'call' });
    expect(st.streetContrib).toEqual([58, 58]);
    expect(st.stacks).toEqual([140, 0]);
    expect(st.committed).toEqual([60, 60]);
    expect(st.pot).toBe(120);
    expect(st.allin).toEqual([false, true]);
  });

  it('turn shove refunds the excess over the short call', () => {
    const setup = mkSetup(2, { stacks: [200, 60] });
    const st = E.initState(setup);
    E.applyAction(st, { seat: 0, type: 'call' });
    E.applyAction(st, { seat: 1, type: 'check' });
    E.advanceStreet(st, C('Ah7c2d'));
    E.applyAction(st, { seat: 1, type: 'check' });
    E.applyAction(st, { seat: 0, type: 'check' });
    E.advanceStreet(st, C('Ah7c2dKh'));
    E.applyAction(st, { seat: 1, type: 'check' });
    E.applyAction(st, { seat: 0, type: 'bet', amount: 198 });
    E.applyAction(st, { seat: 1, type: 'call' });
    expect(st.streetContrib).toEqual([58, 58]);
    expect(st.stacks).toEqual([140, 0]);
    expect(st.pot).toBe(120);
    expect(st.allin).toEqual([false, true]);
  });

  it('river shove refunds on the round close, with no street left to advance to', () => {
    const setup = mkSetup(2, { stacks: [200, 60] });
    const actions = [
      { seat: 0, type: 'call', street: 0 }, { seat: 1, type: 'check', street: 0 },
      { seat: 1, type: 'check', street: 1 }, { seat: 0, type: 'check', street: 1 },
      { seat: 1, type: 'check', street: 2 }, { seat: 0, type: 'check', street: 2 },
      { seat: 1, type: 'check', street: 3 }, { seat: 0, type: 'bet', amount: 198, street: 3 },
      { seat: 1, type: 'call', street: 3 },
    ];
    const f = E.buildReplay(setup, actions, C('2c7h9dThJs'));
    const last = f.at(-1);
    expect(last.pot).toBe(120);
    expect(last.stacks).toEqual([140, 0]);
    expect(last.streetContrib).toEqual([58, 58]);
    expect(last.allin).toEqual([false, true]);
    expect(f.filter((x) => x.kind === 'deal').length).toBe(3);
    expect(last.kind).toBe('action');
  });

  it('three-handed: the bigger shove keeps only what the second stack matched', () => {
    const setup = mkSetup(3, { stacks: [500, 100, 500] });
    const st = E.initState(setup);
    E.applyAction(st, { seat: 0, type: 'raise', amount: 50 });
    E.applyAction(st, { seat: 1, type: 'raise', amount: 100 });
    E.applyAction(st, { seat: 2, type: 'raise', amount: 500 });
    E.applyAction(st, { seat: 0, type: 'fold' });
    expect(st.stacks).toEqual([450, 0, 400]); // 400 back to the uncalled shove
    expect(st.committed).toEqual([50, 100, 100]);
    expect(st.pot).toBe(250);
    expect(st.allin).toEqual([false, true, false]);
    expect(st.handOver).toBe(false);
  });

  it('a tie at the top refunds nothing', () => {
    const setup = mkSetup(2, { stacks: [50, 50] });
    const st = E.initState(setup);
    E.applyAction(st, { seat: 0, type: 'raise', amount: 50 });
    E.applyAction(st, { seat: 1, type: 'call' });
    expect(st.stacks).toEqual([0, 0]);
    expect(st.committed).toEqual([50, 50]);
    expect(st.pot).toBe(100);
    expect(st.allin).toEqual([true, true]);
  });
});

describe('uncalled chips when everyone folds', () => {
  it('a preflop raise folded out comes back down to the blinds', () => {
    const setup = mkSetup(6);
    const st = E.initState(setup);
    E.applyAction(st, { seat: 3, type: 'raise', amount: 6 });
    [4, 5, 0, 1, 2].forEach((seat) => E.applyAction(st, { seat, type: 'fold' }));
    expect(st.stacks[3]).toBe(198);
    expect(st.committed[3]).toBe(2);
    expect(st.streetContrib[3]).toBe(2);
    expect(st.pot).toBe(5);
    expect(st.handOver).toBe(true);
  });

  it('an uncalled flop bet comes back in full', () => {
    const setup = mkSetup(2);
    const st = E.initState(setup);
    E.applyAction(st, { seat: 0, type: 'call' });
    E.applyAction(st, { seat: 1, type: 'check' });
    E.advanceStreet(st, C('Ah7c2d'));
    E.applyAction(st, { seat: 1, type: 'bet', amount: 50 });
    E.applyAction(st, { seat: 0, type: 'fold' });
    expect(st.stacks[1]).toBe(198);
    expect(st.committed[1]).toBe(2);
    expect(st.streetContrib[1]).toBe(0);
    expect(st.pot).toBe(4);
  });
});

describe('streets that close square', () => {
  it('a limped preflop refunds nothing', () => {
    const setup = mkSetup(3);
    const st = E.initState(setup);
    E.applyAction(st, { seat: 0, type: 'call' });
    E.applyAction(st, { seat: 1, type: 'call' });
    E.applyAction(st, { seat: 2, type: 'check' });
    expect(st.streetContrib).toEqual([2, 2, 2]);
    expect(st.stacks).toEqual([198, 198, 198]);
    expect(st.pot).toBe(6);
  });

  it('a bet called on the flop refunds nothing', () => {
    const setup = mkSetup(2);
    const st = E.initState(setup);
    E.applyAction(st, { seat: 0, type: 'call' });
    E.applyAction(st, { seat: 1, type: 'check' });
    E.advanceStreet(st, C('Ah7c2d'));
    E.applyAction(st, { seat: 1, type: 'bet', amount: 20 });
    E.applyAction(st, { seat: 0, type: 'call' });
    expect(st.streetContrib).toEqual([20, 20]);
    expect(st.pot).toBe(44);
    expect(st.stacks).toEqual([178, 178]);
  });

  it('a checked-through street refunds nothing', () => {
    const setup = mkSetup(2);
    const st = E.initState(setup);
    E.applyAction(st, { seat: 0, type: 'call' });
    E.applyAction(st, { seat: 1, type: 'check' });
    E.advanceStreet(st, C('Ah7c2d'));
    E.applyAction(st, { seat: 1, type: 'check' });
    E.applyAction(st, { seat: 0, type: 'check' });
    expect(st.streetContrib).toEqual([0, 0]);
    expect(st.pot).toBe(4);
    expect(st.stacks).toEqual([198, 198]);
  });
});

describe('a refunded player is live again', () => {
  it('drops the all-in flag but is not asked to act with nobody left to answer', () => {
    const setup = mkSetup(2, { stacks: [200, 60] });
    const st = E.initState(setup);
    E.applyAction(st, { seat: 0, type: 'call' });
    E.applyAction(st, { seat: 1, type: 'check' });
    E.advanceStreet(st, C('Ah7c2d'));
    E.applyAction(st, { seat: 1, type: 'check' });
    E.applyAction(st, { seat: 0, type: 'bet', amount: 198 });
    E.applyAction(st, { seat: 1, type: 'call' });
    expect(st.allin[0]).toBe(false);
    expect(E.liveActorCount(st)).toBe(1);
    E.advanceStreet(st, C('Ah7c2dKh'));
    expect(st.nextSeat).toBeNull();
    expect(E.needsAction(st, 0)).toBe(false);
    expect(E.needsAction(st, 1)).toBe(false);
  });

  it('stays all-in when the refund leaves nothing behind', () => {
    const setup = mkSetup(2, { stacks: [50, 50] });
    const st = E.initState(setup);
    E.applyAction(st, { seat: 0, type: 'raise', amount: 50 });
    E.applyAction(st, { seat: 1, type: 'call' });
    E.advanceStreet(st, C('Ah7c2d'));
    expect(st.nextSeat).toBe(null);
    expect(E.liveActorCount(st)).toBe(0);
  });
});

describe('per-seat antes', () => {
  it('posts each seat its own ante', () => {
    const setup = mkSetup(6, { sb: 10, bb: 20, stack: 1000, antes: [0, 0, 20, 0, 0, 0] });
    const st = E.initState(setup);
    expect(st.pot).toBe(50); // one 20 ante + 30 in blinds
    expect(st.stacks[2]).toBe(960);
    expect(st.committed[2]).toBe(40);
    expect(st.streetContrib[2]).toBe(20); // the ante is not part of the street bet
    expect(st.committed[0]).toBe(0);
    expect(st.stacks[0]).toBe(1000);
    expect(st.toCall).toBe(20);
  });

  it('a seat short of its ante posts what it has and is all-in', () => {
    const setup = mkSetup(6, { sb: 10, bb: 20, stack: 1000, antes: [0, 0, 600, 0, 0, 0] });
    setup.seats[2].stack = 400;
    const st = E.initState(setup);
    expect(st.stacks[2]).toBe(0);
    expect(st.allin[2]).toBe(true);
    expect(st.committed[2]).toBe(400);
    expect(st.streetContrib[2]).toBe(0); // nothing left for the blind
    expect(st.pot).toBe(410);
    expect(E.needsAction(st, 2)).toBe(false);
    expect(st.toCall).toBe(20);
  });

  it('setup.antes wins over a table-wide setup.ante', () => {
    const setup = mkSetup(3, { stack: 100, ante: 5, antes: [1, 2, 3] });
    const st = E.initState(setup);
    expect(st.pot).toBe(9); // 6 in antes, 3 in blinds
    expect(st.committed).toEqual([1, 3, 5]);
    expect(st.stacks).toEqual([99, 97, 95]);
  });

  it('no antes array falls back to the table ante for every seat', () => {
    const setup = mkSetup(3, { stack: 100, ante: 5 });
    const st = E.initState(setup);
    expect(st.pot).toBe(18);
    expect(st.committed).toEqual([5, 6, 7]);
    expect(st.stacks).toEqual([95, 94, 93]);
  });

  it('an empty antes array falls back to the table ante', () => {
    const setup = mkSetup(3, { stack: 100, ante: 5, antes: [] });
    const st = E.initState(setup);
    expect(st.pot).toBe(18);
    expect(st.committed).toEqual([5, 6, 7]);
  });

  it('zero and missing antes entries post nothing', () => {
    const setup = mkSetup(3, { stack: 100, antes: [0, 25] });
    const st = E.initState(setup);
    expect(st.pot).toBe(28);
    expect(st.committed).toEqual([0, 26, 2]);
    expect(st.stacks).toEqual([100, 74, 98]);
  });
});

describe('antes through the share codec', () => {
  const hand = (over = {}) => ({
    setup: {
      sb: 300, bb: 600, ante: 0, cents: false,
      seats: [
        { name: 'ann', stack: 12000, pos: 'BTN', cards: null },
        { name: 'bo', stack: 9000, pos: 'SB', cards: null },
        { name: 'cy', stack: 15000, pos: 'BB', cards: null },
      ],
      ...over,
    },
    actions: [{ seat: 0, type: 'fold', street: 0 }],
    board: [],
  });

  it('round-trips a per-seat antes array', () => {
    const h = hand({ antes: [0, 0, 600] });
    const out = decodeReplay(encodeReplay(h));
    expect(out.setup.antes).toEqual([0, 0, 600]);
    expect(E.initState(out.setup).pot).toBe(E.initState(h.setup).pot);
  });

  it('keeps antes alongside a table ante', () => {
    const out = decodeReplay(encodeReplay(hand({ ante: 100, antes: [0, 0, 600] })));
    expect(out.setup.ante).toBe(100);
    expect(out.setup.antes).toEqual([0, 0, 600]);
  });

  it('a link encoded without antes decodes without the key', () => {
    const out = decodeReplay(encodeReplay(hand()));
    expect('antes' in out.setup).toBe(false);
    expect(out.setup.ante).toBe(0);
    expect(E.initState(out.setup).pot).toBe(900);
  });
});
