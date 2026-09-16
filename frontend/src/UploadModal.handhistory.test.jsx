import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { UploadModal } from './UploadModal.jsx';

afterEach(() => vi.unstubAllGlobals());

const DIR = 'src/__fixtures__/handhistory/';
const spec = (name) => fs.readFileSync(DIR + name, 'utf8');
const card = (s) => ({ v: s[0], s: s[1] });

// heads-up fold-out; `collected` disagreeing with the $4 pot fails reconciliation
const starsHand = (id, at, collected) => `PokerStars Hand #${id}:  Hold'em No Limit ($1/$2 USD) - ${at} ET
Table 'Zeta' 6-max Seat #1 is the button
Seat 1: ann ($200 in chips)
Seat 2: bo ($200 in chips)
ann: posts small blind $1
bo: posts big blind $2
*** HOLE CARDS ***
Dealt to ann [As Kd]
ann: raises $4 to $6
bo: folds
Uncalled bet ($4) returned to ann
ann collected $${collected} from pot
*** SUMMARY ***
Total pot $${collected} | Rake $0
Seat 1: ann (button) collected ($${collected})
Seat 2: bo (big blind) folded before Flop
`;
const starsLog = (second) => starsHand('21', '2026/01/01 1:00:00', 4) + '\n' + starsHand('22', '2026/01/01 1:05:00', second);

const PN_CSV = 'entry,at,order\n'
  + '"-- starting hand #1 (id: a1)  No Limit Texas Hold\'em (dealer: ""bob @ b1"") --",2026-09-15T18:44:06.093Z,100\n'
  + '"Player stacks: #1 ""tim @ t1"" (500) | #2 ""bob @ b1"" (500)",2026-09-15T18:44:06.093Z,101\n'
  + '"-- ending hand #1 --",2026-09-15T18:44:07.093Z,102\n';

const PN_JSON = JSON.stringify({
  playerId: 'p_ann',
  hands: [{
    number: '7', gameType: 'th', dealerSeat: 0, smallBlind: 50, bigBlind: 100,
    players: [{ seat: 0, id: 'p_ann', name: 'ann', stack: 10000 }, { seat: 1, id: 'p_bo', name: 'bo', stack: 10000 }],
    events: [{ payload: { type: 10, seat: 0, value: 150 } }],
  }],
});

function renderModal() {
  const onClose = vi.fn();
  const onConfirm = vi.fn();
  const utils = render(<UploadModal open onClose={onClose} onConfirm={onConfirm} />);
  return { ...utils, onClose, onConfirm };
}

function dropFile(container, text, name = 'hand-history.txt', type = 'text/plain') {
  const file = new File([text], name, { type });
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });
}

async function openHands(container, text, pick, name, type) {
  dropFile(container, text, name, type);
  await screen.findByText(/players? in this log/);
  fireEvent.click(screen.getByText(pick).closest('button'));
  return screen.getByPlaceholderText(/Type a hand number/);
}

// '#n' text matches both a chip and a hand row; keep only the row
const handRow = (n) => screen.queryAllByText('#' + n)
  .map((el) => el.closest('button.upload-hand-row')).find(Boolean);
const playerRow = (name) => screen.getByText(name).closest('button');

describe('UploadModal hand-history intake', () => {
  it('reads a PokerStars .txt log and reaches the player phase', async () => {
    const { container } = renderModal();
    dropFile(container, spec('stars-multi.txt'), 'stars-multi.txt', 'text/plain');
    await screen.findByText(/players in this log/);
    expect(container.querySelector('.upload-found')).toHaveTextContent('12 players in this log');
    expect(within(playerRow('lena')).getByText('10 hands')).toBeInTheDocument();
    expect(within(playerRow('wes')).getByText('3 hands')).toBeInTheDocument();
    expect(within(playerRow('All hands')).getByText('10 hands')).toBeInTheDocument();
  });

  it('accepts a PokerStars .txt with no MIME type', async () => {
    const { container } = renderModal();
    dropFile(container, spec('stars-general.txt'), 'stars-general.txt', '');
    await screen.findByText(/players in this log/);
    expect(screen.getByText('cleo')).toBeInTheDocument();
    expect(screen.getByText('eli')).toBeInTheDocument();
  });

  it('still reads a PokerNow csv carried in a .txt file', async () => {
    const { container } = renderModal();
    dropFile(container, PN_CSV, 'pokernow.txt', 'text/plain');
    await screen.findByText(/players in this log/);
    expect(screen.getByText('tim')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
  });

  it('still reads a PokerNow json export', async () => {
    const { container } = renderModal();
    await openHands(container, PN_JSON, 'ann', 'export.json', 'application/json');
    expect(screen.getByText(/· 1 hand/)).toBeInTheDocument();
    expect(handRow(7)).toBeTruthy();
  });

  it('rejects an unsupported extension without reading the file', () => {
    const created = vi.fn();
    vi.stubGlobal('FileReader', class { constructor() { created(); } readAsText() {} });
    const { container } = renderModal();
    dropFile(container, spec('stars-general.txt'), 'hand-history.pdf', 'application/pdf');
    expect(screen.getByText(/That's a \.PDF file — hand histories are \.json, \.csv or \.txt\./)).toBeInTheDocument();
    expect(created).not.toHaveBeenCalled();
    expect(screen.getByText(/Drag a log here/)).toBeInTheDocument();
  });

  it('shows the hand-history failure copy for junk text', async () => {
    const { container } = renderModal();
    dropFile(container, 'just some notes I typed\nnothing to see', 'notes.txt', 'text/plain');
    await screen.findByText(/This doesn't look like a hand history\. Export the hand log from PokerNow, PokerStars or GGPoker and try again\./);
    expect(screen.getByText(/Drag a log here/)).toBeInTheDocument();
  });

  it('offers all three extensions on the dropzone', () => {
    const { container } = renderModal();
    expect([...container.querySelectorAll('.upload-drop-sub .mono')].map((el) => el.textContent))
      .toEqual(['.json', '.csv', '.txt']);
    expect(container.querySelector('input[type="file"]').getAttribute('accept'))
      .toBe('.json,.csv,.txt,application/json,text/csv,text/plain');
  });

  it('titles the dialog Import hand history', () => {
    renderModal();
    expect(screen.getByRole('dialog', { name: 'Import hand history' })).toBeInTheDocument();
    expect(screen.getByText('Import hand history')).toBeInTheDocument();
  });
});

describe('UploadModal hand-history hands', () => {
  it('lists a picked player\'s hands numbered 1..N', async () => {
    const { container } = renderModal();
    await openHands(container, spec('stars-multi.txt'), 'lena', 'stars-multi.txt', 'text/plain');
    expect(screen.getByText(/· 10 hands/)).toBeInTheDocument();
    expect(screen.getByText('#1–#10')).toBeInTheDocument();
    const nums = [...container.querySelectorAll('.upload-hand-row .upload-hand-num')].map((el) => el.textContent);
    expect(nums).toEqual(['#1', '#2', '#3', '#4', '#5', '#6', '#7', '#8', '#9', '#10']);
  });

  it('lists only the hands a late-arriving player was dealt into', async () => {
    const { container } = renderModal();
    await openHands(container, spec('stars-multi.txt'), 'wes', 'stars-multi.txt', 'text/plain');
    expect(screen.getByText(/· 3 hands/)).toBeInTheDocument();
    expect(screen.getByText('#8–#10')).toBeInTheDocument();
    expect(handRow(1)).toBeFalsy();
    expect([8, 9, 10].map(handRow).every(Boolean)).toBe(true);
  });

  it('shows dollar stakes and the board on a cash hand row', async () => {
    const { container } = renderModal();
    await openHands(container, spec('gg-cash.txt'), 'Hero', 'gg-cash.txt', 'text/plain');
    const row = handRow(1);
    expect(within(row).getByText('$0.25/$0.5')).toBeInTheDocument();
    expect(within(row).getByText(/6 players · Hero/)).toBeInTheDocument();
    // the row shows the board; the hero's Ad Kh ride on the hand itself
    expect([...row.querySelectorAll('.card-chip-rank')].map((el) => el.textContent))
      .toEqual(['3', '3', '10', '7', 'K']);
  });

  it('shows chip stakes, not dollars, on a tournament hand row', async () => {
    const { container } = renderModal();
    await openHands(container, spec('gg-tourney.txt'), 'Hero', 'gg-tourney.txt', 'text/plain');
    const stakes = within(handRow(1)).getByText('300/600');
    expect(stakes).toBeInTheDocument();
    expect(stakes.textContent).not.toContain('$');
  });

  it('imports the hero cards from a GGPoker log', async () => {
    const { container, onConfirm } = renderModal();
    await openHands(container, spec('gg-cash.txt'), 'Hero', 'gg-cash.txt', 'text/plain');
    fireEvent.click(handRow(1));
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 hand' }));
    const [hand] = onConfirm.mock.calls[0][0];
    expect(hand.summary.heroCards).toEqual([card('Ad'), card('Kh')]);
    const { replay } = hand;
    expect(replay.setup.seats[replay.hero].name).toBe('Hero');
    expect(replay.setup.seats[replay.hero].cards).toEqual([card('Ad'), card('Kh')]);
  });

  it('imports a tournament hand with its per-seat ante', async () => {
    const { container, onConfirm } = renderModal();
    await openHands(container, spec('gg-tourney.txt'), 'Hero', 'gg-tourney.txt', 'text/plain');
    fireEvent.click(handRow(1));
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 hand' }));
    const { replay } = onConfirm.mock.calls[0][0][0];
    expect(replay.setup.antes).toEqual([0, 0, 600, 0]); // big-blind ante, Hero in the bb
    expect(replay.setup.cents).toBe(false);
    expect(replay.setup.seats[2].name).toBe('Hero');
  });
});

describe('UploadModal unreadable hands', () => {
  it('notes the hands it had to drop', async () => {
    const { container } = renderModal();
    await openHands(container, starsLog(9), 'ann', 'stars.txt', 'text/plain');
    const note = container.querySelector('.upload-skipped');
    expect(note).toHaveTextContent('1 hand couldn’t be read');
    expect(screen.getByText(/· 1 hand/)).toBeInTheDocument();
    expect(handRow(1)).toBeTruthy();
    expect(handRow(2)).toBeFalsy();
  });

  it('leaves the note out when every hand reads cleanly', async () => {
    const { container } = renderModal();
    await openHands(container, starsLog(4), 'ann', 'stars.txt', 'text/plain');
    expect(container.querySelector('.upload-skipped')).toBeNull();
    expect(screen.getByText(/· 2 hands/)).toBeInTheDocument();
    expect([1, 2].map(handRow).every(Boolean)).toBe(true);
  });
});
