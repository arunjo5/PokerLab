import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import App from './App.jsx';
import { AuthProvider } from './AuthContext.jsx';
import { encodeScenario } from './scenario.js';
import { encodeReplay } from './replayShare.js';
import { splitShareUrl } from './shareLinks.js';

class FakeWorker {
  constructor() { FakeWorker.instances.push(this); this.onmessage = null; this.posted = []; this.terminated = false; }
  postMessage(m) { this.posted.push(m); }
  terminate() { this.terminated = true; }
}
FakeWorker.instances = [];

const ok = (data) => ({ ok: true, status: 200, json: async () => data });
const fail = (status = 500, data = {}) => ({ ok: false, status, json: async () => data });

// url-substring router; register /api/share/<code> before /api/share
function mockFetch(routes = {}) {
  const fn = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    for (const key of Object.keys(routes)) {
      if (u.includes(key)) {
        const h = routes[key];
        return typeof h === 'function' ? h(u, opts) : h;
      }
    }
    if (u.includes('/api/auth/session')) return ok({ user: null });
    if (u.includes('/api/auth/providers')) return ok({});
    if (u.includes('/api/auth/csrf')) return ok({ csrfToken: 'tok' });
    return fail(404);
  });
  global.fetch = fn;
  return fn;
}

const callsTo = (substr, method) =>
  global.fetch.mock.calls.filter(([u, o]) =>
    String(u).includes(substr) && (!method || ((o && o.method) || 'GET') === method));
// the collection endpoint only — /api/share/<code> is a substring match away
const listCalls = () =>
  global.fetch.mock.calls.filter(([u, o]) =>
    String(u) === '/api/share' && ((o && o.method) || 'GET') === 'GET');
const bodyOf = (substr, method) => JSON.parse(callsTo(substr, method)[0][1].body);

const c = (s) => ({ v: s[0], s: s[1] });
const USER = { name: 'Arun', email: 'a@b.c' };
const P_AA = { kind: 'hand', hand: [c('As'), c('Ah')] };
const P_KK = { kind: 'hand', hand: [c('Ks'), c('Kh')] };

const scenarioEnc = (pot = '', callAmt = '') => encodeScenario({
  players: [P_AA, P_KK], board: [], playerNames: ['Hero', 'Villain'], pot, callAmt,
});

const REPLAY_HAND = {
  setup: {
    sb: 50, bb: 100, ante: 0, cents: false,
    seats: [
      { name: 'rex', stack: 10000, pos: 'BTN', cards: null },
      { name: 'pranad', stack: 8000, pos: 'SB', cards: [c('Ah'), c('Kh')] },
      { name: 'luc', stack: 12000, pos: 'BB', cards: [c('Qd'), c('Qs')] },
    ],
  },
  actions: [
    { seat: 0, type: 'fold', street: 0 },
    { seat: 1, type: 'call', street: 0 },
    { seat: 2, type: 'check', street: 0 },
  ],
  board: [c('2c'), c('7d'), c('Jh')],
  board2: null, won: null, runResults: null,
};

const CODE = 'AbCdEf12';
const status = (over = {}) => ok({ plan: 'free', saveCap: 25, saved: 0, billingEnabled: true, ...over });
const linkRow = (over = {}) => ({
  code: CODE, kind: 'scenario', name: 'Turn probe', views: 3,
  createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(), ...over,
});

const renderApp = () => render(<AuthProvider><App /></AuthProvider>);
const at = (path) => window.history.replaceState(null, '', path);
const findChip = () => screen.findByRole('button', { name: /Arun/ });
const toastText = () => document.querySelector('.shared-toast')?.textContent;
const longUrl = () => document.querySelector('.share-link').value;
const createBtn = () => screen.getByRole('button', { name: 'Create' });

async function openDrawer() {
  fireEvent.click(await findChip());
  fireEvent.click(screen.getByText('Hand history'));
  return screen.findByRole('dialog', { name: 'Hand history' });
}
async function openShareModal() {
  fireEvent.click(await findChip());
  fireEvent.click(screen.getByText('Share'));
  return screen.findByRole('dialog', { name: 'Share scenario' });
}
const linksTab = () => screen.getByText('Links').closest('button');
const rowFor = (name) => screen.getByText(name).closest('.link-row');

beforeEach(() => {
  localStorage.clear();
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

describe('/s/<code> auto-load', () => {
  it('resolves a scenario link, strips the path but keeps the query, and toasts', async () => {
    at(`/s/${CODE}?ref=twitter`);
    mockFetch({ [`/api/share/${CODE}`]: ok({ kind: 'scenario', payload: scenarioEnc('100', '50') }) });
    renderApp();
    expect(await screen.findByText('Loaded shared scenario')).toBeInTheDocument();
    expect(callsTo(`/api/share/${CODE}`, 'GET')).toHaveLength(1);
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('?ref=twitter');
    expect(screen.getAllByText('Hero').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Villain').length).toBeGreaterThan(0);
    const [pot, call] = screen.getAllByPlaceholderText('0');
    expect(pot).toHaveValue(100);
    expect(call).toHaveValue(50);
  });

  it('resolves a replay link straight into the replayer', async () => {
    at(`/s/${CODE}`);
    mockFetch({ [`/api/share/${CODE}`]: ok({ kind: 'replay', payload: encodeReplay(REPLAY_HAND) }) });
    renderApp();
    expect(await screen.findByText('Hand Replayer')).toBeInTheDocument();
    expect(screen.getByText('rex')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
  });

  it('toasts that a 404 link is gone and stays on the calculator', async () => {
    at(`/s/${CODE}`);
    mockFetch({ [`/api/share/${CODE}`]: fail(404, { error: 'Not found' }) });
    renderApp();
    expect(await screen.findByText('This link no longer exists')).toBeInTheDocument();
    expect(screen.getByText('Pot odds')).toBeInTheDocument();
  });

  it('toasts the server error for any other failure', async () => {
    at(`/s/${CODE}`);
    mockFetch({ [`/api/share/${CODE}`]: fail(500, { error: 'Server exploded' }) });
    renderApp();
    expect(await screen.findByText('Server exploded')).toBeInTheDocument();
  });

  it('toasts a network error when the request never lands', async () => {
    at(`/s/${CODE}`);
    mockFetch({ [`/api/share/${CODE}`]: () => { throw new TypeError('Failed to fetch'); } });
    renderApp();
    expect(await screen.findByText('Network error')).toBeInTheDocument();
  });

  it('toasts that an undecodable scenario payload is broken', async () => {
    at(`/s/${CODE}`);
    mockFetch({ [`/api/share/${CODE}`]: ok({ kind: 'scenario', payload: 'not-a-payload' }) });
    renderApp();
    expect(await screen.findByText('This link is broken')).toBeInTheDocument();
    expect(screen.getByText('Pot odds')).toBeInTheDocument();
  });

  it('toasts that an undecodable replay payload is broken', async () => {
    at(`/s/${CODE}`);
    mockFetch({ [`/api/share/${CODE}`]: ok({ kind: 'replay', payload: 'not-a-payload' }) });
    renderApp();
    expect(await screen.findByText('This link is broken')).toBeInTheDocument();
    expect(screen.queryByText('Hand Replayer')).toBeNull();
  });

  it('resolves nothing on a plain url', async () => {
    renderApp();
    await screen.findByText('Pot odds');
    expect(callsTo('/api/share')).toHaveLength(0);
  });

  it('leaves a malformed code in the path and resolves nothing', async () => {
    at('/s/abc'); // too short to be a code
    renderApp();
    await screen.findByText('Pot odds');
    expect(callsTo('/api/share')).toHaveLength(0);
    expect(window.location.pathname).toBe('/s/abc');
  });
});

describe('share modal short links', () => {
  it('a pro user creates a scenario short link from the calculator', async () => {
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/billing/status': status({ plan: 'pro' }),
      '/api/share': ok({ link: { code: CODE } }),
    });
    renderApp();
    await openShareModal();
    const expected = splitShareUrl(longUrl());
    expect(expected.kind).toBe('scenario');
    fireEvent.click(createBtn());
    expect(await screen.findByDisplayValue(`${window.location.origin}/s/${CODE}`)).toBeInTheDocument();
    expect(callsTo('/api/share', 'POST')).toHaveLength(1);
    expect(bodyOf('/api/share', 'POST')).toEqual({ kind: 'scenario', payload: expected.payload });
    expect(screen.getByText('Stays live until you delete it from Hand History → Links.')).toBeInTheDocument();
  });

  it('a pro user creates a replay short link from the replayer', async () => {
    window.location.hash = '#r=' + encodeReplay(REPLAY_HAND);
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/billing/status': status({ plan: 'pro' }),
      '/api/share': ok({ link: { code: 'RePl4y00' } }),
    });
    renderApp();
    await screen.findByText('Hand Replayer');
    fireEvent.click(document.querySelector('.btn-share'));
    await screen.findByRole('dialog', { name: 'Share scenario' });
    const expected = splitShareUrl(longUrl());
    expect(expected.kind).toBe('replay');
    fireEvent.click(createBtn());
    expect(await screen.findByDisplayValue(`${window.location.origin}/s/RePl4y00`)).toBeInTheDocument();
    expect(bodyOf('/api/share', 'POST')).toEqual({ kind: 'replay', payload: expected.payload });
  });

  it('a pro_required failure shows the error and re-checks the plan', async () => {
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/billing/status': status({ plan: 'pro' }),
      '/api/share': fail(402, { error: 'Pro is required for short links', code: 'pro_required' }),
    });
    renderApp();
    await openShareModal();
    const before = callsTo('/api/billing/status').length;
    fireEvent.click(createBtn());
    expect(await screen.findByRole('alert')).toHaveTextContent('Pro is required for short links');
    await waitFor(() => expect(callsTo('/api/billing/status').length).toBe(before + 1));
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('a plain failure shows the error without re-checking the plan', async () => {
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/billing/status': status({ plan: 'pro' }),
      '/api/share': fail(429, { error: 'Too many links' }),
    });
    renderApp();
    await openShareModal();
    const before = callsTo('/api/billing/status').length;
    fireEvent.click(createBtn());
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many links');
    expect(callsTo('/api/billing/status')).toHaveLength(before);
  });

  it('creating refreshes an already-loaded link list', async () => {
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/billing/status': status({ plan: 'pro' }),
      '/api/searches': ok({ searches: [] }),
      '/api/share': (u, o) => (((o && o.method) || 'GET') === 'POST'
        ? ok({ link: { code: CODE } })
        : ok({ links: [] })),
    });
    renderApp();
    const drawer = await openDrawer();
    await waitFor(() => expect(listCalls()).toHaveLength(1));
    expect(within(drawer).getByText('Links')).toBeInTheDocument(); // pro sees the tab at zero links
    fireEvent.click(within(drawer).getByLabelText('Close'));
    await openShareModal();
    fireEvent.click(createBtn());
    await screen.findByDisplayValue(`${window.location.origin}/s/${CODE}`);
    await waitFor(() => expect(listCalls()).toHaveLength(2));
  });

  it('a free signed-in user gets the Upgrade tease, which lands on the Plans page', async () => {
    mockFetch({ '/api/auth/session': ok({ user: USER }), '/api/billing/status': status() });
    renderApp();
    await openShareModal();
    expect(screen.getByText('Pro members get a permanent short link that never breaks.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    expect(screen.queryByRole('dialog', { name: 'Share scenario' })).toBeNull();
    expect(await screen.findByText('500 permanent short share links')).toBeInTheDocument();
  });

  it('a signed-out user gets the See Pro tease in the replayer', async () => {
    window.location.hash = '#r=' + encodeReplay(REPLAY_HAND);
    mockFetch({ '/api/billing/status': status() });
    renderApp();
    await screen.findByText('Hand Replayer');
    fireEvent.click(document.querySelector('.btn-share'));
    await screen.findByRole('dialog', { name: 'Share scenario' });
    expect(screen.getByRole('button', { name: 'See Pro' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upgrade' })).toBeNull();
  });
});

describe('Hand history Links tab', () => {
  // codeRoute must be registered first — the router matches on substrings
  const proRoutes = ({ codeRoute, ...over } = {}) => ({
    ...(codeRoute ? { [`/api/share/${CODE}`]: codeRoute } : {}),
    '/api/auth/session': ok({ user: USER }),
    '/api/billing/status': status({ plan: 'pro' }),
    '/api/searches': ok({ searches: [] }),
    '/api/share': ok({ links: [linkRow()] }),
    ...over,
  });

  it('opening the drawer loads the links and shows the tab', async () => {
    mockFetch(proRoutes());
    renderApp();
    await openDrawer();
    await waitFor(() => expect(listCalls()).toHaveLength(1));
    expect(within(await screen.findByText('Links')).getByText('1')).toBeInTheDocument();
    fireEvent.click(linksTab());
    expect(screen.getByText('Turn probe')).toBeInTheDocument();
    expect(screen.getByText(`${window.location.host}/s/${CODE}`)).toBeInTheDocument();
  });

  it('hides the tab from a free user with no links', async () => {
    mockFetch(proRoutes({ '/api/billing/status': status(), '/api/share': ok({ links: [] }) }));
    renderApp();
    await openDrawer();
    await waitFor(() => expect(listCalls()).toHaveLength(1));
    expect(screen.queryByText('Links')).toBeNull();
  });

  it('still shows the tab to a free user who already has links', async () => {
    mockFetch(proRoutes({ '/api/billing/status': status() }));
    renderApp();
    await openDrawer();
    expect(await screen.findByText('Links')).toBeInTheDocument();
    fireEvent.click(linksTab());
    expect(screen.getByText('Turn probe')).toBeInTheDocument();
  });

  it('deletes optimistically and keeps the row gone when the request succeeds', async () => {
    mockFetch(proRoutes({ codeRoute: ok({}) }));
    renderApp();
    await openDrawer();
    fireEvent.click(await screen.findByText('Links'));
    fireEvent.click(within(rowFor('Turn probe')).getByLabelText('Delete link'));
    expect(screen.queryByText('Turn probe')).toBeNull();
    await waitFor(() => expect(callsTo(`/api/share/${CODE}`, 'DELETE')).toHaveLength(1));
    expect(listCalls()).toHaveLength(1); // no rollback refetch
    expect(toastText()).toBeUndefined();
  });

  it('rolls the delete back with a toast when the request fails', async () => {
    mockFetch(proRoutes({ codeRoute: fail(500, { error: 'Could not delete' }) }));
    renderApp();
    await openDrawer();
    fireEvent.click(await screen.findByText('Links'));
    fireEvent.click(within(rowFor('Turn probe')).getByLabelText('Delete link'));
    expect(screen.queryByText('Turn probe')).toBeNull(); // optimistic
    expect(await screen.findByText('Could not delete')).toBeInTheDocument();
    expect(await screen.findByText('Turn probe')).toBeInTheDocument(); // restored by the refetch
    expect(listCalls()).toHaveLength(2);
  });

  // last link deleted: the tab vanishes and the drawer falls back to All
  it('lets a free user delete their last link from the Links tab', async () => {
    mockFetch(proRoutes({ codeRoute: ok({}), '/api/billing/status': status() }));
    renderApp();
    await openDrawer();
    fireEvent.click(await screen.findByText('Links'));
    fireEvent.click(within(rowFor('Turn probe')).getByLabelText('Delete link'));
    expect(screen.queryByText('Turn probe')).toBeNull();
    expect(screen.queryByText('Links')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Hand history' })).toBeInTheDocument();
    await waitFor(() => expect(callsTo(`/api/share/${CODE}`, 'DELETE')).toHaveLength(1));
  });

  it('renames optimistically and PATCHes the trimmed name', async () => {
    mockFetch(proRoutes({ codeRoute: ok({}) }));
    renderApp();
    await openDrawer();
    fireEvent.click(await screen.findByText('Links'));
    fireEvent.click(screen.getByText('Rename'));
    const input = screen.getByLabelText('Link name');
    fireEvent.change(input, { target: { value: '  River bluff ' } });
    fireEvent.blur(input);
    expect(screen.getByText('River bluff')).toBeInTheDocument(); // before the PATCH resolves
    await waitFor(() => expect(callsTo(`/api/share/${CODE}`, 'PATCH')).toHaveLength(1));
    expect(bodyOf(`/api/share/${CODE}`, 'PATCH')).toEqual({ name: 'River bluff' });
    expect(listCalls()).toHaveLength(1);
  });

  it('rolls the rename back with a toast when the request fails', async () => {
    mockFetch(proRoutes({ codeRoute: fail(500, { error: 'Rename failed' }) }));
    renderApp();
    await openDrawer();
    fireEvent.click(await screen.findByText('Links'));
    fireEvent.click(screen.getByText('Rename'));
    const input = screen.getByLabelText('Link name');
    fireEvent.change(input, { target: { value: 'River bluff' } });
    fireEvent.blur(input);
    expect(screen.getByText('River bluff')).toBeInTheDocument();
    expect(await screen.findByText('Rename failed')).toBeInTheDocument();
    expect(await screen.findByText('Turn probe')).toBeInTheDocument();
    expect(screen.queryByText('River bluff')).toBeNull();
  });

  it('opening a link from the drawer closes it and loads the scenario', async () => {
    mockFetch(proRoutes({ codeRoute: ok({ kind: 'scenario', payload: scenarioEnc('80', '20') }) }));
    renderApp();
    await openDrawer();
    fireEvent.click(await screen.findByText('Links'));
    fireEvent.click(rowFor('Turn probe').querySelector('.link-load'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Hand history' })).toBeNull());
    expect(await screen.findByText('Loaded shared scenario')).toBeInTheDocument();
    const [pot, call] = screen.getAllByPlaceholderText('0');
    expect(pot).toHaveValue(80);
    expect(call).toHaveValue(20);
  });
});
