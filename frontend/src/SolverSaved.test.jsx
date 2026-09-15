import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SavedSolvesPanel, SaveSolveControl } from './SolverSaved.jsx';

const c = (s) => ({ v: s[0], s: s[1] });
const BOARD = ['2s', '7h', '9c', 'Jd', 'Ks'].map(c);
const CREATED = '2026-02-14T10:00:00.000Z';

const savedSolve = (over = {}) => ({
  id: 's1',
  name: 'River jam',
  createdAt: CREATED,
  config: { board: BOARD, spot: { pot: 20 } },
  summary: { oopCombos: 4, ipCombos: 6, sizes: 4, exploit: 0.4242 },
  ...over,
});

const fakeLib = (over = {}) => ({
  solves: [],
  solvesLoaded: true,
  limits: { saveCap: 25, shareLinks: 0, ranges: 3, solves: 3 },
  deleteSolve: vi.fn(async () => ({ ok: true })),
  ...over,
});

// a promise the test settles, so the pending state is inspectable
function deferred() {
  let settle;
  const fn = vi.fn(() => new Promise((res) => { settle = res; }));
  return { fn, resolve: async (v) => { await act(async () => { settle(v); }); } };
}

const rows = () => [...document.querySelectorAll('.sv-saved-row')];
const hint = () => document.querySelector('.sv-field-hint').textContent;
const emptyText = () => document.querySelector('.sv-saved-empty').textContent;
const msgEl = () => document.querySelector('.range-save-msg');
const nameInput = () => screen.queryByLabelText('Solve name');
const typeName = (v) => fireEvent.change(nameInput(), { target: { value: v } });
const saveBtn = () => screen.getByRole('button', { name: 'Save' });
const submit = async () => { await act(async () => { fireEvent.click(saveBtn()); }); };

function renderPanel(over = {}) {
  const lib = fakeLib(over);
  const onLoad = vi.fn();
  const utils = render(<SavedSolvesPanel lib={lib} onLoad={onLoad} />);
  return { ...utils, lib, onLoad };
}

function renderControl(over = {}) {
  const props = { onSave: vi.fn(async () => ({ ok: true })), openPlans: vi.fn(), ...over };
  const utils = render(<SaveSolveControl {...props} />);
  return { ...utils, props };
}

describe('SavedSolvesPanel header', () => {
  it('counts the saved solves against the plan cap', () => {
    renderPanel({ solves: [savedSolve(), savedSolve({ id: 's2' })] });
    expect(screen.getByText(/Saved solves/)).toBeInTheDocument();
    expect(hint()).toBe('2 of 3');
  });

  it('shows a dash while the caps are unknown', () => {
    renderPanel({ limits: null });
    expect(hint()).toBe('0 of —');
  });
});

describe('SavedSolvesPanel empty states', () => {
  it('reads Loading… until the list has been fetched', () => {
    renderPanel({ solvesLoaded: false });
    expect(emptyText()).toBe('Loading…');
    expect(rows()).toHaveLength(0);
  });

  it('invites a first save once the list comes back empty', () => {
    renderPanel({ solvesLoaded: true });
    expect(emptyText()).toBe('Solve a spot and hit Save solve to keep it here.');
  });
});

describe('SavedSolvesPanel rows', () => {
  it('shows the name, date, board and spot summary', () => {
    renderPanel({ solves: [savedSolve()] });
    const row = rows()[0];
    expect(row.querySelector('.sv-saved-name').textContent).toBe('River jam');
    expect(row.querySelector('.sv-saved-date').textContent).toBe(new Date(CREATED).toLocaleDateString());
    expect(row.querySelectorAll('.sv-saved-cards > div')).toHaveLength(5);
    expect(row.querySelector('.sv-saved-meta').textContent).toBe('4 vs 6 combos · pot 20 bb · 4-size tree · 0.42% pot');
  });

  it('skips the empty board slots of a shorter street', () => {
    renderPanel({ solves: [savedSolve({ config: { board: [...BOARD.slice(0, 3), null, null], spot: { pot: 12 } } })] });
    expect(rows()[0].querySelectorAll('.sv-saved-cards > div')).toHaveLength(3);
    expect(rows()[0].querySelector('.sv-saved-meta').textContent).toContain('pot 12 bb');
  });

  it('tolerates a config with no board at all', () => {
    renderPanel({ solves: [savedSolve({ config: { spot: { pot: 20 } } })] });
    expect(rows()[0].querySelectorAll('.sv-saved-cards > div')).toHaveLength(0);
  });

  it('tags an exploit solve with its villain', () => {
    renderPanel({ solves: [savedSolve({ summary: { oopCombos: 4, ipCombos: 6, sizes: 4, exploit: 0.4242, villain: { seat: 'IP', name: 'rex', gain: 14.2 } } })] });
    expect(rows()[0].querySelector('.sv-saved-meta').textContent).toBe('4 vs 6 combos · pot 20 bb · 4-size tree · 0.42% pot · exploit vs rex');
    expect(rows()[0].querySelector('.sv-saved-exploit').textContent).toBe(' · exploit vs rex');
  });

  it('clicking the row hands the whole saved solve back', () => {
    const { onLoad } = renderPanel({ solves: [savedSolve(), savedSolve({ id: 's2', name: 'Turn probe' })] });
    fireEvent.click(rows()[1].querySelector('.sv-saved-load'));
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(onLoad.mock.calls[0][0]).toMatchObject({ id: 's2', name: 'Turn probe' });
  });

  it('the delete button is labelled per row and deletes by id', async () => {
    const { lib, onLoad } = renderPanel({ solves: [savedSolve(), savedSolve({ id: 's2', name: 'Turn probe' })] });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete Turn probe' })); });
    expect(lib.deleteSolve).toHaveBeenCalledWith('s2');
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('disables only the pending row while its delete is in flight', async () => {
    const d = deferred();
    renderPanel({ solves: [savedSolve(), savedSolve({ id: 's2', name: 'Turn probe' })], deleteSolve: d.fn });
    fireEvent.click(screen.getByRole('button', { name: 'Delete River jam' }));
    expect(screen.getByRole('button', { name: 'Delete River jam' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete Turn probe' })).toBeEnabled();
    await d.resolve({ ok: true });
    expect(screen.getByRole('button', { name: 'Delete River jam' })).toBeEnabled();
  });
});

describe('SaveSolveControl form', () => {
  it('starts as a single button and opens the inline form', () => {
    renderControl();
    expect(nameInput()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save solve' }));
    expect(nameInput()).toHaveAttribute('maxLength', '60');
    expect(screen.queryByRole('button', { name: 'Save solve' })).toBeNull();
  });

  it('gates Save on a non-blank name', () => {
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: 'Save solve' }));
    expect(saveBtn()).toBeDisabled();
    typeName('  ');
    expect(saveBtn()).toBeDisabled();
    typeName('River jam');
    expect(saveBtn()).toBeEnabled();
  });

  it('Cancel closes the form without saving', () => {
    const { props } = renderControl();
    fireEvent.click(screen.getByRole('button', { name: 'Save solve' }));
    typeName('River jam');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(nameInput()).toBeNull();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it('saves the trimmed name, confirms and closes', async () => {
    const { props } = renderControl();
    fireEvent.click(screen.getByRole('button', { name: 'Save solve' }));
    typeName('  River jam  ');
    await submit();
    expect(props.onSave).toHaveBeenCalledWith('River jam');
    expect(msgEl()).toHaveClass('ok');
    expect(msgEl()).toHaveAttribute('role', 'status');
    expect(msgEl().textContent).toBe('Saved');
    expect(nameInput()).toBeNull();
  });

  it('reads Saving… and blocks a double submit while in flight', async () => {
    const d = deferred();
    renderControl({ onSave: d.fn });
    fireEvent.click(screen.getByRole('button', { name: 'Save solve' }));
    typeName('River jam');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const pending = screen.getByRole('button', { name: 'Saving…' });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(d.fn).toHaveBeenCalledTimes(1);
    await d.resolve({ ok: true });
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('a limit refusal alerts with an Upgrade to Pro link and keeps the form open', async () => {
    const { props } = renderControl({
      onSave: vi.fn(async () => ({ ok: false, code: 'limit_reached', error: 'Free accounts keep 3 saved solves.' })),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save solve' }));
    typeName('Fourth');
    await submit();
    expect(msgEl()).toHaveClass('limit');
    expect(msgEl()).toHaveAttribute('role', 'alert');
    expect(msgEl().textContent).toContain('Free accounts keep 3 saved solves.');
    expect(nameInput()).not.toBeNull();
    fireEvent.click(within(msgEl()).getByRole('button', { name: 'Upgrade to Pro' }));
    expect(props.openPlans).toHaveBeenCalledTimes(1);
  });

  it('any other failure shows a plain error with no upgrade link', async () => {
    renderControl({ onSave: vi.fn(async () => ({ ok: false, status: 500, error: 'Request failed (500)' })) });
    fireEvent.click(screen.getByRole('button', { name: 'Save solve' }));
    typeName('River jam');
    await submit();
    expect(msgEl()).toHaveClass('err');
    expect(msgEl().textContent).toBe('Request failed (500)');
    expect(within(msgEl()).queryByRole('button')).toBeNull();
  });

  it('falls back to a generic message when the failure carries none', async () => {
    renderControl({ onSave: vi.fn(async () => ({ ok: false })) });
    fireEvent.click(screen.getByRole('button', { name: 'Save solve' }));
    typeName('River jam');
    await submit();
    expect(msgEl().textContent).toBe('Could not save');
  });

  it('cancelling after a failure clears the message', async () => {
    renderControl({ onSave: vi.fn(async () => ({ ok: false, error: 'nope' })) });
    fireEvent.click(screen.getByRole('button', { name: 'Save solve' }));
    typeName('River jam');
    await submit();
    expect(msgEl()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(msgEl()).toBeNull();
  });

  it('reopening after a success clears the confirmation', async () => {
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: 'Save solve' }));
    typeName('River jam');
    await submit();
    expect(msgEl()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save solve' }));
    expect(msgEl()).toBeNull();
    expect(nameInput()).toHaveValue(''); // the name box starts fresh
  });
});
