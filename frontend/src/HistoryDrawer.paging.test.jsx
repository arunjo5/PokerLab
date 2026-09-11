import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { HistoryDrawer } from './HistoryDrawer.jsx';

const c = (s) => ({ v: s[0], s: s[1] });

const item = (over = {}) => ({
  id: 'h1', ts: Date.now() - 30_000, name: 'a hand', isReplay: false, replay: null,
  scenario: 'enc', playerCount: 2, boardLen: 3,
  boardPreview: [c('As'), c('Kh'), c('Td')],
  heroCards: [c('As'), c('Kh')], heroLabel: null, heroName: 'Ann',
  heroEquity: 55.46, topName: 'Ann', topEquity: 55.46, starred: false, ...over,
});

// a populated Links tab, so the third tab is around to click
const withLinks = () => ({
  links: [{
    code: 'AbCdEf12', kind: 'scenario', name: 'Turn probe',
    createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(), views: 3,
  }],
  linksLoading: false,
  linkUrl: (code) => `https://pokerlab.test/s/${code}`,
  onOpenLink: vi.fn(), onDeleteLink: vi.fn(), onRenameLink: vi.fn(),
});

const baseProps = () => ({
  open: true, onClose: vi.fn(), history: [], loading: false, error: null,
  onLoad: vi.fn(), onToggleFavorite: vi.fn(), onDelete: vi.fn(), onClear: vi.fn(),
  user: { name: 'Arun', email: 'a@b.c' },
  hasMore: false, loadingMore: false, onLoadMore: vi.fn(), onNeedStarred: vi.fn(),
});

function renderDrawer(over = {}) {
  const props = { ...baseProps(), ...over };
  const utils = render(<HistoryDrawer {...props} />);
  return { ...utils, props };
}

const tabFor = (label) => screen.getByText(label).closest('button');
const capNote = () => screen.queryByText(/Keeps your latest/);
const more = () => document.querySelector('.drawer-more');

describe('HistoryDrawer cap note', () => {
  it('names the plan cap, and falls back to 500 without one', () => {
    const { rerender, props } = renderDrawer({ cap: 25 });
    expect(capNote()).toHaveTextContent('Keeps your latest 25 hands, favorites first');
    rerender(<HistoryDrawer {...props} cap={5000} />);
    expect(capNote()).toHaveTextContent('Keeps your latest 5,000 hands, favorites first');
    rerender(<HistoryDrawer {...props} cap={undefined} />);
    expect(capNote()).toHaveTextContent('Keeps your latest 500 hands, favorites first');
  });

  it('hides the note when signed out, whatever the cap says', () => {
    renderDrawer({ cap: 25, user: null });
    expect(capNote()).toBeNull();
  });
});

describe('HistoryDrawer Load more', () => {
  it('stays hidden without hasMore and appears after the rows with it', () => {
    const { rerender, props } = renderDrawer({ history: [item()] });
    expect(more()).toBeNull();
    rerender(<HistoryDrawer {...props} history={[item()]} hasMore />);
    expect(more()).toHaveTextContent('Load more');
    const kids = [...document.querySelector('.drawer-body').children];
    expect(kids.at(-1)).toBe(more());
    expect(kids.at(-2)).toHaveClass('hist-row');
  });

  it('calls onLoadMore on click', () => {
    const { props } = renderDrawer({ history: [item()], hasMore: true });
    fireEvent.click(more());
    expect(props.onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('swaps to a disabled Loading… while a page is in flight', () => {
    const { props } = renderDrawer({ history: [item()], hasMore: true, loadingMore: true });
    expect(more()).toHaveTextContent('Loading…');
    expect(more()).toBeDisabled();
    fireEvent.click(more());
    expect(props.onLoadMore).not.toHaveBeenCalled();
  });

  it('is an All-tab affordance only', () => {
    const { rerender, props } = renderDrawer({
      history: [item({ id: 'a', name: 'one', starred: true })],
      hasMore: true,
      ...withLinks(),
    });
    expect(more()).not.toBeNull();
    fireEvent.click(tabFor('Starred'));
    expect(more()).toBeNull();
    fireEvent.click(tabFor('Links'));
    expect(more()).toBeNull();
    fireEvent.click(tabFor('All'));
    expect(more()).not.toBeNull();
    // and the loading / empty / error branches never reach the rows
    rerender(<HistoryDrawer {...props} history={[]} hasMore />);
    expect(more()).toBeNull();
    rerender(<HistoryDrawer {...props} history={[item()]} hasMore loading />);
    expect(more()).toBeNull();
    rerender(<HistoryDrawer {...props} history={[item()]} hasMore error="HTTP 500" />);
    expect(more()).toBeNull();
  });
});

describe('HistoryDrawer onNeedStarred', () => {
  it('fires on every Starred click and on no other tab', () => {
    const { props } = renderDrawer({ history: [item()], ...withLinks() });
    fireEvent.click(tabFor('All'));
    fireEvent.click(tabFor('Links'));
    expect(props.onNeedStarred).not.toHaveBeenCalled();
    fireEvent.click(tabFor('Starred'));
    expect(props.onNeedStarred).toHaveBeenCalledTimes(1);
    fireEvent.click(tabFor('All'));
    fireEvent.click(tabFor('Starred'));
    expect(props.onNeedStarred).toHaveBeenCalledTimes(2);
  });

  it('still switches tabs when the handler is not wired', () => {
    renderDrawer({
      history: [item({ id: 'a', name: 'one' }), item({ id: 'b', name: 'two', starred: true })],
      onNeedStarred: undefined,
    });
    fireEvent.click(tabFor('Starred'));
    expect(screen.getByText('two')).toBeInTheDocument();
    expect(screen.queryByText('one')).toBeNull();
  });

  it('keeps the starred count in the tab as merged favorites arrive', () => {
    const { rerender, props } = renderDrawer({ history: [item({ id: 'a', name: 'one' })], hasMore: true });
    expect(within(tabFor('Starred')).getByText('0')).toBeInTheDocument();
    rerender(<HistoryDrawer {...props} hasMore history={[
      item({ id: 'a', name: 'one' }),
      item({ id: 'z', name: 'old fave', starred: true }),
    ]} />);
    expect(within(tabFor('Starred')).getByText('1')).toBeInTheDocument();
    expect(within(tabFor('All')).getByText('2')).toBeInTheDocument();
  });
});
