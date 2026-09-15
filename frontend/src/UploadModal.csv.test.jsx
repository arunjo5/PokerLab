import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { UploadModal } from './UploadModal.jsx';

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

function renderModal() {
  const onClose = vi.fn();
  const onConfirm = vi.fn();
  const utils = render(<UploadModal open onClose={onClose} onConfirm={onConfirm} />);
  return { ...utils, onClose, onConfirm };
}

function dropFile(container, text, name = 'log.csv', type = 'text/csv') {
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

describe('UploadModal csv intake', () => {
  it('reads a dropped .csv log and reaches the player phase', async () => {
    const { container } = renderModal();
    dropFile(container, LOG3);
    await screen.findByText(/players in this log/);
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText('tim')).toBeInTheDocument();
  });

  it('accepts a .csv name with no MIME type', async () => {
    const { container } = renderModal();
    dropFile(container, LOG3, 'log.csv', '');
    await screen.findByText(/players in this log/);
    expect(screen.getByText('tim')).toBeInTheDocument();
  });

  it('sniffs csv content out of a .json-named file', async () => {
    const { container } = renderModal();
    dropFile(container, LOG3, 'log.json', 'application/json');
    await screen.findByText(/players in this log/);
    expect(screen.getByText('tim')).toBeInTheDocument();
  });

  it('still rejects a .txt file before reading it', () => {
    const { container } = renderModal();
    dropFile(container, LOG3, 'log.txt', 'text/plain');
    expect(screen.getByText(/\.TXT file — PokerNow logs are \.json or \.csv/)).toBeInTheDocument();
    expect(screen.getByText(/Drag a log here/)).toBeInTheDocument();
  });

  it('rejects csv text with no entry header', async () => {
    const { container } = renderModal();
    dropFile(container, 'at,order\n"2026-09-15T18:44:06.093Z",100\n', 'log.csv', 'text/csv');
    await screen.findByText(/doesn't look like a PokerNow log/);
    expect(screen.getByText(/Drag a log here/)).toBeInTheDocument();
  });

  it('reads a quoted header as a PokerNow log', async () => {
    const { container } = renderModal();
    dropFile(container, '"entry","at","order"\n"-- starting hand #1 (id: a1)  No Limit Texas Hold\'em (dealer: ""bob @ b1"") --",2026-09-15T18:44:06.093Z,100\n"Player stacks: #1 ""tim @ t1"" (500) | #2 ""bob @ b1"" (500)",2026-09-15T18:44:06.093Z,101\n"-- ending hand #1 --",2026-09-15T18:44:07.093Z,102\n', 'log.csv', 'text/csv');
    await screen.findByText(/players? in this log/);
  });

  it('shows the empty state for a csv log with no hands', async () => {
    const { container } = renderModal();
    dropFile(container, 'entry,at,order\n"The player ""tim @ t1"" requested a seat.",x,100\n', 'empty.csv');
    await screen.findByText('No hands found in this file');
    expect(screen.getByText('empty.csv')).toBeInTheDocument();
  });

  it('offers both extensions on the dropzone', () => {
    const { container } = renderModal();
    expect([...container.querySelectorAll('.upload-drop-sub .mono')].map((el) => el.textContent))
      .toEqual(['.json', '.csv']);
    expect(container.querySelector('input[type="file"]').getAttribute('accept'))
      .toBe('.json,.csv,application/json,text/csv');
  });
});

describe('UploadModal csv hands', () => {
  it('lists the same three hands for either player', async () => {
    const { container } = renderModal();
    await openHands(container, LOG3, 'tim');
    expect(screen.getByText(/· 3 hands/)).toBeInTheDocument();
    expect(screen.getByText('#1–#3')).toBeInTheDocument();
    expect([1, 2, 3].map(handRow).every(Boolean)).toBe(true);

    fireEvent.click(screen.getByText('Change'));
    fireEvent.click(screen.getByText('bob').closest('button'));
    expect(screen.getByText(/· 3 hands/)).toBeInTheDocument();
    expect([1, 2, 3].map(handRow).every(Boolean)).toBe(true);
  });

  it('imports the "Your hand is" cards onto the player you picked', async () => {
    const { container, onConfirm } = renderModal();
    await openHands(container, LOG1, 'tim');
    fireEvent.click(handRow(1));
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 hand' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [hand] = onConfirm.mock.calls[0][0];
    expect(hand.number).toBe(1);
    const { replay } = hand;
    expect(replay.setup.seats[replay.hero].name).toBe('tim');
    expect(replay.setup.seats[replay.hero].cards).toEqual([{ v: '8', s: 'h' }, { v: '8', s: 's' }]);
  });
});
