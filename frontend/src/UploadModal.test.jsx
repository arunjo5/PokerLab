import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { UploadModal } from './UploadModal.jsx';

afterEach(() => vi.unstubAllGlobals());

// minimal convertible hands: empty event lists parse fine for the modal's purposes
const player = (seat, id, name) => ({ seat, id, name, stack: 10000 });
const hand = (number, players, over = {}) => ({
  number: String(number), gameType: 'th', dealerSeat: players[0].seat,
  smallBlind: 50, bigBlind: 100, players, events: [], ...over,
});
const AB = () => [player(0, 'p_alice', 'alice'), player(1, 'p_bob', 'bob')];
const abLog = (numbers) => ({ playerId: 'p_alice', hands: numbers.map((n) => hand(n, AB())) });

// alice in all three, bob only in #1/#3, exporter = bob
const rosterLog = () => ({
  playerId: 'p_bob',
  hands: [
    hand(1, AB()),
    hand(2, [player(0, 'p_alice', 'alice'), player(2, 'p_carol', 'carol')]),
    hand(3, AB()),
  ],
});

const NUMS51 = Array.from({ length: 51 }, (_, i) => i + 1);

function renderModal() {
  const onClose = vi.fn();
  const onConfirm = vi.fn();
  const utils = render(<UploadModal open onClose={onClose} onConfirm={onConfirm} />);
  return { ...utils, onClose, onConfirm };
}

function dropFile(container, contents, name = 'log.json', type = 'application/json') {
  const data = typeof contents === 'string' ? contents : JSON.stringify(contents);
  const file = new File([data], name, { type });
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });
}

async function openHands(container, logData, pick = 'bob') {
  dropFile(container, logData);
  await screen.findByText(/players? in this log/);
  fireEvent.click(screen.getByText(pick).closest('button'));
  return screen.getByPlaceholderText(/Type a hand number/);
}

const chips = () => screen.queryAllByLabelText(/^Remove hand /)
  .map((b) => Number(b.getAttribute('aria-label').replace('Remove hand ', '')));

// '#n' text matches both a chip and a hand row; keep only the row
const handRow = (n) => screen.queryAllByText('#' + n)
  .map((el) => el.closest('button.upload-hand-row')).find(Boolean);

const enter = (input, value) => {
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
};

describe('UploadModal file intake (drop phase)', () => {
  it('rejects a non-.json extension and stays on the dropzone', () => {
    const { container } = renderModal();
    dropFile(container, 'whatever', 'log.txt', 'text/plain');
    expect(screen.getByText(/\.TXT file — PokerNow logs are \.json or \.csv/)).toBeInTheDocument();
    expect(screen.getByText(/Drag a log here/)).toBeInTheDocument();
  });

  it('rejects an oversize file without ever reading it', () => {
    const created = vi.fn();
    vi.stubGlobal('FileReader', class { constructor() { created(); } readAsText() {} });
    const { container } = renderModal();
    const file = new File(['{}'], 'big.json', { type: 'application/json' });
    Object.defineProperty(file, 'size', { value: 10 * 1024 * 1024 + 1 });
    fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });
    expect(screen.getByText(/unexpectedly large/)).toBeInTheDocument();
    expect(created).not.toHaveBeenCalled();
  });

  it('distinguishes unreadable JSON from JSON that is not a PokerNow log', async () => {
    const { container } = renderModal();
    dropFile(container, 'not json');
    await screen.findByText(/couldn't read that file/);
    dropFile(container, '{"foo":1}');
    await screen.findByText(/doesn't look like a PokerNow log/);
    expect(screen.queryByText(/couldn't read that file/)).toBeNull();
  });

  it('accepts a file with no .json name when the MIME type is JSON', async () => {
    const { container } = renderModal();
    dropFile(container, abLog([1]), 'export', 'application/json');
    await screen.findByText(/players in this log/);
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('shows the empty state for a log with no convertible hands and resets from it', async () => {
    const { container } = renderModal();
    const log = {
      playerId: 'p_alice',
      hands: [hand(1, AB(), { gameType: 'plo' }), hand(2, [player(0, 'p_alice', 'alice')])],
    };
    dropFile(container, log, 'empty.json');
    await screen.findByText('No hands found in this file');
    expect(screen.getByText('empty.json')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Choose another file'));
    expect(screen.getByText(/Drag a log here/)).toBeInTheDocument();
    expect(screen.queryByText('No hands found in this file')).toBeNull();
  });

  it('lists the roster sorted by count with a you badge and an all-hands total', async () => {
    const { container } = renderModal();
    const log = rosterLog();
    log.hands.push(hand(4, AB(), { gameType: 'plo' }), hand(5, [player(0, 'p_alice', 'alice')]));
    dropFile(container, log);
    await screen.findByText(/players in this log/);
    const row = (text) => screen.getByText(text).closest('button');
    expect(within(row('alice')).getByText('3 hands')).toBeInTheDocument();
    expect(within(row('bob')).getByText('2 hands')).toBeInTheDocument();
    expect(within(row('carol')).getByText('1 hand')).toBeInTheDocument();
    expect(within(row('bob')).getByText('you')).toBeInTheDocument();
    expect(within(row('alice')).queryByText('you')).toBeNull();
    // plo and short-handed hands stay out of the all-hands total
    expect(within(row('All hands')).getByText('3 hands')).toBeInTheDocument();
    const names = [...container.querySelectorAll('.upload-player-row:not(.upload-player-all) .upload-player-name')]
      .map((el) => el.childNodes[0].textContent);
    expect(names).toEqual(['alice', 'bob', 'carol']);
  });
});

describe('UploadModal player select', () => {
  it('resets to the dropzone from Different file and closes on Cancel', async () => {
    const { container, onClose } = renderModal();
    dropFile(container, abLog([1]));
    await screen.findByText(/players in this log/);
    fireEvent.click(screen.getByText('Different file'));
    expect(screen.getByText(/Drag a log here/)).toBeInTheDocument();
    dropFile(container, abLog([1]));
    await screen.findByText(/players in this log/);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('picking a player filters to their hands with name and range in the header', async () => {
    const { container } = renderModal();
    await openHands(container, rosterLog(), 'bob');
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText(/· 2 hands/)).toBeInTheDocument();
    expect(screen.getByText('#1–#3')).toBeInTheDocument();
    expect(handRow(1)).toBeTruthy();
    expect(handRow(3)).toBeTruthy();
    expect(handRow(2)).toBeFalsy();
  });

  it('All hands lists every convertible hand and errors name the log, not a player', async () => {
    const { container } = renderModal();
    const input = await openHands(container, rosterLog(), 'All hands');
    expect(screen.getByText('All players')).toBeInTheDocument();
    expect(screen.getByText(/· 3 hands/)).toBeInTheDocument();
    expect(handRow(2)).toBeTruthy(); // exporter bob was not dealt into #2
    enter(input, '999');
    expect(screen.getByText('Hand #999 not in this log.')).toBeInTheDocument();
  });

  it('Change returns to the player list and clears the selection state', async () => {
    const { container } = renderModal();
    const input = await openHands(container, rosterLog(), 'bob');
    enter(input, '1');
    enter(input, '999');
    fireEvent.change(input, { target: { value: '9' } });
    expect(chips()).toEqual([1]);
    fireEvent.click(screen.getByText('Change'));
    expect(screen.getByText(/players in this log/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('bob').closest('button'));
    expect(chips()).toEqual([]);
    expect(screen.getByPlaceholderText(/Type a hand number/)).toHaveValue('');
    expect(screen.queryByText(/not in/)).toBeNull();
    expect(screen.getByText('0 / 50')).toBeInTheDocument();
  });
});

describe('UploadModal hand selection', () => {
  it('adds chips in entry order and silently skips duplicates', async () => {
    const { container } = renderModal();
    const input = await openHands(container, abLog([80, 100, 183]));
    enter(input, '183, 80');
    expect(chips()).toEqual([183, 80]);
    enter(input, '183');
    expect(chips()).toEqual([183, 80]);
    expect(screen.queryByText(/not in/)).toBeNull();
    expect(screen.getByText('2 / 50')).toBeInTheDocument();
  });

  it('reports unknown numbers by player name and still adds the valid ones', async () => {
    const { container } = renderModal();
    const input = await openHands(container, abLog([80, 100, 183]));
    enter(input, '99');
    expect(screen.getByText("Hand #99 not in bob's hands.")).toBeInTheDocument();
    expect(chips()).toEqual([]);
    enter(input, '99 100');
    expect(chips()).toEqual([100]);
    expect(screen.getByText("Hand #99 not in bob's hands.")).toBeInTheDocument();
  });

  it('strips non-numeric characters and commits on blur and on comma', async () => {
    const { container } = renderModal();
    const input = await openHands(container, abLog([80, 100, 183]));
    fireEvent.change(input, { target: { value: 'abc12;3' } });
    expect(input).toHaveValue('123');
    expect(chips()).toEqual([]);
    fireEvent.change(input, { target: { value: '80' } });
    fireEvent.blur(input);
    expect(chips()).toEqual([80]);
    fireEvent.change(input, { target: { value: '183' } });
    fireEvent.keyDown(input, { key: ',' });
    expect(chips()).toEqual([80, 183]);
    expect(input).toHaveValue('');
  });

  it('Backspace pops the last chip only when the input is empty; × removes its chip', async () => {
    const { container } = renderModal();
    const input = await openHands(container, abLog([80, 100, 183]));
    enter(input, '80 183');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(chips()).toEqual([80, 183]);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(chips()).toEqual([80]);
    fireEvent.click(screen.getByLabelText('Remove hand 80'));
    expect(chips()).toEqual([]);
  });

  it('clicking a hand row toggles its selection', async () => {
    const { container } = renderModal();
    await openHands(container, abLog([80, 100, 183]));
    fireEvent.click(handRow(100));
    expect(chips()).toEqual([100]);
    expect(handRow(100).className).toContain('selected');
    fireEvent.click(handRow(100));
    expect(chips()).toEqual([]);
    expect(handRow(100).className).not.toContain('selected');
  });

  it('Select all under the cap takes everything without an error; Clear empties', async () => {
    const { container } = renderModal();
    await openHands(container, abLog([80, 100, 183]));
    fireEvent.click(screen.getByText('Select all'));
    expect(chips()).toEqual([80, 100, 183]);
    expect(screen.queryByText(/most recent/)).toBeNull();
    expect(screen.getByText(/Press Enter or comma to add/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Clear'));
    expect(chips()).toEqual([]);
    expect(screen.getByText('0 / 50')).toBeInTheDocument();
  });

  it('Select all on 51 hands keeps the 50 most recent, shown ascending', async () => {
    const { container } = renderModal();
    await openHands(container, abLog(NUMS51));
    fireEvent.click(screen.getByText('Select all'));
    expect(chips()).toEqual(NUMS51.slice(1)); // 2..51
    expect(screen.getByText('Added the 50 most recent of 51 hands (max 50).')).toBeInTheDocument();
  });

  it('enforces the cap on rows and the chip input but still allows deselection', async () => {
    const { container } = renderModal();
    await openHands(container, abLog(NUMS51));
    fireEvent.click(screen.getByText('Select all'));
    const input = screen.getByPlaceholderText('Maximum 50 reached');
    expect(input).toBeDisabled();
    expect(handRow(1)).toHaveStyle('opacity: 0.45');
    fireEvent.click(handRow(1));
    expect(screen.getByText('You can add up to 50 hands.')).toBeInTheDocument();
    expect(chips()).toHaveLength(50);
    fireEvent.click(handRow(51));
    expect(chips()).toEqual(NUMS51.slice(1, 50)); // 2..50
    expect(screen.getByPlaceholderText(/Add another/)).toBeEnabled();
  });

  it('stops a batch at the cap without validating the remaining tokens', async () => {
    const { container } = renderModal();
    await openHands(container, abLog(NUMS51));
    fireEvent.click(screen.getByText('Select all'));
    fireEvent.click(screen.getByLabelText('Remove hand 2'));
    const input = screen.getByPlaceholderText(/Add another/);
    enter(input, '1 999');
    expect(chips()).toHaveLength(50);
    expect(chips()).toContain(1);
    expect(chips()).not.toContain(999);
    expect(screen.getByText('You can add up to 50 hands.')).toBeInTheDocument();
    expect(screen.queryByText(/not in/)).toBeNull(); // 999 was never validated
  });

  it('disables Import at zero and passes the chosen hand objects in chip order', async () => {
    const { container, onConfirm } = renderModal();
    const input = await openHands(container, abLog([80, 100, 183]));
    expect(screen.getByRole('button', { name: 'Import hands' })).toBeDisabled();
    enter(input, '183 80');
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 hands' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const arg = onConfirm.mock.calls[0][0];
    expect(arg.map((h) => h.number)).toEqual([183, 80]);
    expect(arg[0].replay).toBeTruthy();
    expect(arg[0].summary.players).toEqual(['bob', 'alice']); // pivoted on the picked player
  });

  it('reopening the modal resets to a clean drop phase', async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    const { container, rerender } = render(<UploadModal open onClose={onClose} onConfirm={onConfirm} />);
    const input = await openHands(container, abLog([80]));
    enter(input, '80');
    expect(chips()).toEqual([80]);
    rerender(<UploadModal open={false} onClose={onClose} onConfirm={onConfirm} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<UploadModal open onClose={onClose} onConfirm={onConfirm} />);
    expect(screen.getByText(/Drag a log here/)).toBeInTheDocument();
    expect(chips()).toEqual([]);
  });

  it('closes on backdrop click but not on clicks inside the dialog', () => {
    const { container, onClose } = renderModal();
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.picker-overlay'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
