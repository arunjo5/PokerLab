import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SetupView } from './SolverSetup.jsx';

const VALS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const SUIT_ROWS = ['s', 'h', 'c', 'd'];
const c = (v, s) => ({ v, s });
const FULL_BOARD = [c('2', 's'), c('7', 'h'), c('9', 'c'), c('J', 'd'), c('K', 's')];
const EMPTY_BOARD = [null, null, null, null, null];
const mkSpot = (over = {}) => ({
  pot: 20, stack: 80,
  betSizes: [{ id: 'b33', pct: 33, on: true }, { id: 'b75', pct: 75, on: true }, { id: 'b125', pct: 125, on: true }],
  allIn: true, ...over,
});

function Harness({ spot = mkSpot(), board = EMPTY_BOARD, oopSide = { kind: 'unset' }, ipSide = { kind: 'unset' }, onSolve = () => {} }) {
  const [spotS, setSpot] = useState(spot);
  const [boardS, setBoard] = useState(board);
  const [oopS, setOop] = useState(oopSide);
  const [ipS, setIp] = useState(ipSide);
  return (
    <SetupView spot={spotS} setSpot={setSpot} board={boardS} setBoard={setBoard}
      oopSide={oopS} setOopSide={setOop} ipSide={ipS} setIpSide={setIp} onSolve={onSolve} />
  );
}

const pcard = (v, s) => document.querySelector('.picker-grid').querySelectorAll('.pcard')[SUIT_ROWS.indexOf(s) * 13 + VALS.indexOf(v)];
const solveBtn = () => screen.getByRole('button', { name: 'Solve' });
const warn = () => document.querySelector('.sv-solve-warn');
const treeSummary = () => document.querySelector('.sv-tree-summary').textContent;
const sideRow = (i) => document.querySelectorAll('.sv-range-row')[i];
const boardSlot = (i) => document.querySelectorAll('.sv-board-row .board-strip-btn')[i]; // 0=flop 1=turn 2=river
const sizeVals = () => Array.from(document.querySelectorAll('.sv-size-val')).map((b) => b.textContent);
const openChipEditor = (label) => {
  fireEvent.click(Array.from(document.querySelectorAll('.sv-size-val')).find((b) => b.textContent === label));
  return document.querySelector('.sv-size-input');
};

describe('Solve ready-gating', () => {
  it('is disabled with an incomplete board and warns about board cards', () => {
    render(<Harness />);
    expect(solveBtn()).toBeDisabled();
    expect(warn().textContent).toBe('Set all 5 board cards to solve.');
  });

  it('is disabled with a full board but unset sides, warning about players', () => {
    render(<Harness board={FULL_BOARD} />);
    expect(solveBtn()).toBeDisabled();
    expect(warn().textContent).toBe('Set a hand or range for both players.');
  });

  it('a one-card hand does not satisfy the gate', () => {
    render(<Harness board={FULL_BOARD} oopSide={{ kind: 'hand', cards: [c('A', 'h')] }} ipSide={{ kind: 'range', keys: ['AA'] }} />);
    expect(solveBtn()).toBeDisabled();
    expect(warn().textContent).toBe('Set a hand or range for both players.');
  });

  it('enables with full board and both sides set, calling onSolve once', () => {
    const onSolve = vi.fn();
    render(<Harness board={FULL_BOARD} oopSide={{ kind: 'range', keys: ['AA'] }} ipSide={{ kind: 'range', keys: ['AA'] }} onSolve={onSolve} />);
    expect(warn()).toBeNull();
    expect(solveBtn()).toBeEnabled();
    fireEvent.click(solveBtn());
    expect(onSolve).toHaveBeenCalledTimes(1);
  });

  it('board Clear all empties the strip and re-disables Solve', () => {
    render(<Harness board={FULL_BOARD} oopSide={{ kind: 'range', keys: ['AA'] }} ipSide={{ kind: 'range', keys: ['AA'] }} />);
    expect(solveBtn()).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(boardSlot(0).textContent).toBe('+');
    expect(solveBtn()).toBeDisabled();
    expect(warn().textContent).toBe('Set all 5 board cards to solve.');
  });

  it('tree summary shows size count and SPR, em-dash when pot is 0', () => {
    const { unmount } = render(<Harness />);
    expect(treeSummary()).toBe('Tree · 4 bet sizes · SPR 4.0');
    unmount();
    render(<Harness spot={mkSpot({ pot: 0, betSizes: [{ id: 'b75', pct: 75, on: true }], allIn: false })} />);
    expect(treeSummary()).toBe('Tree · 1 bet size · SPR —');
  });
});

describe('board deal flow', () => {
  const dealConfirm = () => document.querySelector('.picker-foot .btn-primary');

  it('the flop button deals 3 cards at once; confirm gates until 3 are picked', () => {
    render(<Harness />);
    fireEvent.click(boardSlot(0)); // flop button
    fireEvent.click(pcard('A', 's'));
    fireEvent.click(pcard('K', 'd'));
    expect(pcard('A', 's').className).toContain('selected');
    expect(dealConfirm()).toBeDisabled();
    fireEvent.click(pcard('Q', 'h'));
    expect(dealConfirm()).toBeEnabled();
    fireEvent.click(dealConfirm());
    expect(document.querySelector('.picker-overlay')).toBeNull();
    expect(boardSlot(0).textContent).toBe('AKQ'); // flop button shows the 3 cards
  });

  it('turn and river slots are disabled until the prior street is dealt', () => {
    render(<Harness />);
    expect(boardSlot(1)).toBeDisabled(); // turn locked with no flop
    expect(boardSlot(2)).toBeDisabled(); // river locked
  });

  it('the turn deal blocks cards already on the board', () => {
    render(<Harness board={[c('A', 's'), c('K', 'd'), c('Q', 'h'), null, null]} />);
    fireEvent.click(boardSlot(1)); // turn button
    expect(pcard('A', 's')).toBeDisabled();
    expect(pcard('A', 's').className).toContain('used');
    fireEvent.click(pcard('2', 'c'));
    fireEvent.click(dealConfirm());
    expect(boardSlot(1).textContent).toBe('2');
  });

  it('clicking the flop clears the whole board', () => {
    render(<Harness board={FULL_BOARD} />);
    expect(boardSlot(0).textContent).toBe('279'); // FULL_BOARD flop = 2,7,9
    fireEvent.click(boardSlot(0));
    expect(boardSlot(0).textContent).toBe('+');
    expect(boardSlot(1).textContent).toBe('+');
    expect(boardSlot(2).textContent).toBe('+');
  });
});

describe('SidePickerModal', () => {
  it('hand mode caps at two cards, toggles selection, and saves the hand', () => {
    render(<Harness />);
    fireEvent.click(within(sideRow(0)).getByRole('button', { name: 'Hand' }));
    const sub = () => document.querySelector('.picker-sub').textContent;
    expect(sub()).toBe('0 / 2 cards selected');
    const confirm = () => screen.getByRole('button', { name: 'Confirm hand' });
    expect(confirm()).toBeDisabled();
    fireEvent.click(pcard('A', 'h'));
    expect(sub()).toBe('1 / 2 cards selected');
    expect(confirm()).toBeDisabled();
    fireEvent.click(pcard('K', 'h'));
    expect(sub()).toBe('2 / 2 cards selected');
    fireEvent.click(pcard('Q', 'h')); // third click ignored
    expect(sub()).toBe('2 / 2 cards selected');
    expect(pcard('Q', 'h').className).not.toContain('selected');
    fireEvent.click(pcard('A', 'h')); // deselect
    expect(sub()).toBe('1 / 2 cards selected');
    expect(confirm()).toBeDisabled();
    fireEvent.click(pcard('A', 'h'));
    expect(confirm()).toBeEnabled();
    fireEvent.click(confirm());
    expect(document.querySelector('.picker-overlay')).toBeNull();
    expect(sideRow(0).textContent).toContain('Specific hand · 1 combo');
    expect(within(sideRow(0)).getByRole('button', { name: 'Edit hand' })).toBeInTheDocument();
  });

  it('blocks board cards and the opposing hand cards in the grid', () => {
    render(<Harness board={FULL_BOARD} ipSide={{ kind: 'hand', cards: [c('Q', 'c'), c('Q', 'd')] }} />);
    fireEvent.click(within(sideRow(0)).getByRole('button', { name: 'Hand' }));
    expect(document.querySelectorAll('.pcard:disabled')).toHaveLength(7);
    expect(pcard('Q', 'c')).toBeDisabled();
    expect(pcard('2', 's')).toBeDisabled();
  });

  it('a range-typed opposing side blocks only the board cards', () => {
    render(<Harness board={FULL_BOARD} ipSide={{ kind: 'range', keys: ['AA'] }} />);
    fireEvent.click(within(sideRow(0)).getByRole('button', { name: 'Hand' }));
    expect(document.querySelectorAll('.pcard:disabled')).toHaveLength(5);
  });

  it('range tab saves keys and the row shows combo count and percentage', () => {
    render(<Harness />);
    fireEvent.click(within(sideRow(0)).getByRole('button', { name: 'Range' }));
    expect(screen.getByText('Select hand range')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText('AA'));
    fireEvent.click(screen.getByRole('button', { name: 'Save range' }));
    expect(document.querySelector('.picker-overlay')).toBeNull();
    expect(sideRow(0).textContent).toContain('Range · 6 combos · 0% of hands');
    expect(within(sideRow(0)).getByRole('button', { name: 'Edit range' })).toBeInTheDocument();
  });

  it('switching Hand/Range tabs keeps the modal open and swaps the body', () => {
    render(<Harness />);
    fireEvent.click(within(sideRow(0)).getByRole('button', { name: 'Hand' }));
    const tabs = document.querySelectorAll('.picker-mode .picker-tab');
    fireEvent.click(tabs[1]);
    expect(document.querySelector('.picker-overlay')).not.toBeNull();
    expect(screen.getByText('Select hand range')).toBeInTheDocument();
    fireEvent.click(tabs[0]);
    expect(document.querySelector('.picker-overlay')).not.toBeNull();
    expect(document.querySelector('.picker-sub').textContent).toBe('0 / 2 cards selected');
  });

  it('unset SideRow offers separate Hand and Range buttons opening the right mode', () => {
    render(<Harness />);
    expect(sideRow(0).textContent).toContain('Choose a hand or range');
    fireEvent.click(within(sideRow(0)).getByRole('button', { name: 'Hand' }));
    expect(document.querySelector('.picker-sub').textContent).toBe('0 / 2 cards selected');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.querySelector('.picker-overlay')).toBeNull();
    fireEvent.click(within(sideRow(0)).getByRole('button', { name: 'Range' }));
    expect(screen.getByText('Select hand range')).toBeInTheDocument();
  });
});

describe('BetSizeEditor', () => {
  it('disables preset chips already present and ignores duplicate adds', () => {
    render(<Harness />);
    const preset = (label) => Array.from(document.querySelectorAll('.sv-preset-chip')).find((b) => b.textContent === label);
    expect(preset('33%')).toBeDisabled();
    expect(preset('75%')).toBeDisabled();
    expect(preset('125%')).toBeDisabled();
    expect(preset('50%')).toBeEnabled();
    fireEvent.click(preset('33%'));
    expect(sizeVals()).toEqual(['33%', '75%', '125%']);
  });

  it('adds a preset in ascending sorted order', () => {
    render(<Harness />);
    fireEvent.click(Array.from(document.querySelectorAll('.sv-preset-chip')).find((b) => b.textContent === '50%'));
    expect(sizeVals()).toEqual(['33%', '50%', '75%', '125%']);
  });

  it('clamps an edited size to 900 and re-sorts', () => {
    render(<Harness />);
    const input = openChipEditor('75%');
    fireEvent.change(input, { target: { value: '5000' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sizeVals()).toEqual(['33%', '125%', '900%']);
  });

  it('clamps a sub-1 numeric value up to 1', () => {
    render(<Harness />);
    const input = openChipEditor('33%');
    fireEvent.change(input, { target: { value: '0.4' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sizeVals()).toEqual(['1%', '75%', '125%']);
  });

  it('falls back to the previous size for non-numeric input and for "0" (falsy parse)', () => {
    render(<Harness />);
    let input = openChipEditor('75%');
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sizeVals()).toEqual(['33%', '75%', '125%']);
    input = openChipEditor('75%');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sizeVals()).toEqual(['33%', '75%', '125%']);
  });

  it('Escape cancels the edit without committing, blur commits', () => {
    render(<Harness />);
    let input = openChipEditor('75%');
    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(document.querySelector('.sv-size-input')).toBeNull();
    expect(sizeVals()).toEqual(['33%', '75%', '125%']);
    input = openChipEditor('75%');
    fireEvent.change(input, { target: { value: '60' } });
    fireEvent.blur(input);
    expect(sizeVals()).toEqual(['33%', '60%', '125%']);
  });

  it('removing a chip and toggling All-in update the tree summary count', () => {
    render(<Harness />);
    expect(treeSummary()).toBe('Tree · 4 bet sizes · SPR 4.0');
    const chip = Array.from(document.querySelectorAll('.sv-size-chip')).find((ch) => ch.textContent.includes('75%'));
    fireEvent.click(within(chip).getByRole('button', { name: 'Remove' }));
    expect(sizeVals()).toEqual(['33%', '125%']);
    expect(treeSummary()).toBe('Tree · 3 bet sizes · SPR 4.0');
    const allIn = screen.getByRole('button', { name: 'All-in' });
    expect(allIn.className).toContain('on');
    fireEvent.click(allIn);
    expect(allIn.className).not.toContain('on');
    expect(treeSummary()).toBe('Tree · 2 bet sizes · SPR 4.0');
  });
});

describe('EquityReadout', () => {
  it('renders an exact equity table for two hands on a complete board', () => {
    render(<Harness board={FULL_BOARD}
      oopSide={{ kind: 'hand', cards: [c('A', 'h'), c('A', 'd')] }}
      ipSide={{ kind: 'hand', cards: [c('K', 'h'), c('K', 'd')] }} />);
    const eqCard = document.querySelector('.sv-equity-card');
    expect(eqCard).not.toBeNull();
    expect(within(eqCard).getByText('exact')).toBeInTheDocument();
    const rows = eqCard.querySelectorAll('.sv-equity-table tbody tr');
    expect(rows).toHaveLength(2);
    const equities = [...eqCard.querySelectorAll('.sv-eq-equity')].map((td) => parseFloat(td.textContent));
    expect(equities[0] + equities[1]).toBeCloseTo(100, 5);
  });

  it('shows the blocked-combo empty message when a hand is dead on the board', () => {
    render(<Harness board={FULL_BOARD}
      oopSide={{ kind: 'hand', cards: [c('2', 's'), c('7', 'h')] }}
      ipSide={{ kind: 'hand', cards: [c('K', 'h'), c('K', 'd')] }} />);
    expect(document.querySelector('.sv-equity-empty')).not.toBeNull();
    expect(document.querySelector('.sv-equity-table')).toBeNull();
  });
});
