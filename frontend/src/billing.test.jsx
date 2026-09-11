import { useState } from 'react';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import App from './App.jsx';
import { DEFAULT_LIMITS, AuthProvider, useAuth } from './AuthContext.jsx';

class FakeWorker {
  constructor() { FakeWorker.instances.push(this); this.onmessage = null; this.posted = []; this.terminated = false; }
  postMessage(m) { this.posted.push(m); }
  terminate() { this.terminated = true; }
}
FakeWorker.instances = [];

const ok = (data) => ({ ok: true, status: 200, json: async () => data });
const fail = (status = 500) => ({ ok: false, status, json: async () => ({}) });

// url-substring router; first matching key wins, sane auth defaults
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

const bodyOf = (substr, method = 'POST', i = 0) => JSON.parse(callsTo(substr, method)[i][1].body);

const USER = { name: 'Arun', email: 'a@b.c' };
const INTENT_KEY = 'pokerlab_checkout_intent';
const CHECKOUT_URL = 'https://stripe.test/c/session';
const PORTAL_URL = 'https://stripe.test/p/session';

const status = (over = {}) => ok({ plan: 'free', saveCap: 25, saved: 0, billingEnabled: true, ...over });

// jsdom won't navigate; swap in a plain location so assign() is observable
let realLocation;
function stubLocation(over = {}) {
  const loc = { origin: 'http://localhost', pathname: '/', search: '', hash: '', assign: vi.fn(), ...over };
  Object.defineProperty(window, 'location', { configurable: true, value: loc });
  return loc;
}

const renderApp = () => render(<AuthProvider><App /></AuthProvider>);
const findChip = () => screen.findByRole('button', { name: /Arun/ });
const openChipMenu = async () => { fireEvent.click(await findChip()); return document.querySelector('.user-menu'); };
const menuPlan = () => document.querySelector('.user-menu-plan').textContent;
const proBtn = () => document.querySelector('.btn-pro');
const toast = () => document.querySelector('.shared-toast');
const onPlansPage = () => screen.queryByRole('heading', { name: 'Study for free. Keep everything with Pro.' });

// ── AuthContext probe ──
function Probe() {
  const { user, plan, signIn, refreshPlan, startCheckout, openPortal } = useAuth();
  const [last, setLast] = useState('');
  const run = (fn) => async () => setLast(JSON.stringify(await fn()));
  return (
    <div>
      <div data-testid="user">{user ? user.name : 'none'}</div>
      <div data-testid="plan">{JSON.stringify(plan)}</div>
      <div data-testid="last">{last}</div>
      <button onClick={() => signIn()}>sign-in</button>
      <button onClick={run(() => refreshPlan())}>refresh-plan</button>
      <button onClick={run(() => startCheckout())}>checkout-default</button>
      <button onClick={run(() => startCheckout('month'))}>checkout-month</button>
      <button onClick={run(() => openPortal())}>portal</button>
    </div>
  );
}
const renderAuth = () => render(<AuthProvider><Probe /></AuthProvider>);
const planOf = () => JSON.parse(screen.getByTestId('plan').textContent);
const lastOf = () => screen.getByTestId('last').textContent;
const who = () => screen.getByTestId('user').textContent;
const click = async (label) => { await act(async () => { fireEvent.click(screen.getByText(label)); }); };
const EMPTY_PLAN = { plan: 'free', interval: null, expiresAt: null, saveCap: 25, saved: 0, hasCustomer: false, billingEnabled: false, limits: DEFAULT_LIMITS };

function fillAndSubmit({ username = 'tim', password = 'test' } = {}) {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

// PokerNow import fixtures (mirrors App.test.jsx)
const pnPlayer = (seat, id, name) => ({ seat, id, name, stack: 10000 });
const pnLog = () => ({
  playerId: 'p_alice',
  hands: [{
    number: '1', gameType: 'th', dealerSeat: 0, smallBlind: 50, bigBlind: 100,
    players: [pnPlayer(0, 'p_alice', 'alice'), pnPlayer(1, 'p_bob', 'bob')], events: [],
  }],
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  realLocation = window.location;
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  mockFetch();
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

describe('refreshPlan', () => {
  it('merges the status response over the defaults and runs on mount', async () => {
    mockFetch({ '/api/billing/status': status({ plan: 'pro', interval: 'month', saved: 99, hasCustomer: true }) });
    renderAuth();
    await waitFor(() => expect(planOf().plan).toBe('pro'));
    expect(planOf()).toEqual({
      plan: 'pro', interval: 'month', expiresAt: null,
      saveCap: 25, saved: 99, hasCustomer: true, billingEnabled: true, limits: DEFAULT_LIMITS });
    expect(callsTo('/api/billing/status')).toHaveLength(1);
  });

  it('falls back to the default plan on a non-ok status', async () => {
    mockFetch({ '/api/billing/status': fail(503) });
    renderAuth();
    await waitFor(() => expect(callsTo('/api/billing/status')).toHaveLength(1));
    expect(planOf()).toEqual(EMPTY_PLAN);
  });

  it('falls back to the default plan when the request rejects', async () => {
    mockFetch({ '/api/billing/status': () => { throw new Error('net'); } });
    renderAuth();
    await click('refresh-plan');
    expect(planOf()).toEqual(EMPTY_PLAN);
    expect(lastOf()).toBe(JSON.stringify(EMPTY_PLAN));
  });

  it('re-runs when the signed-in user changes', async () => {
    let authed = false;
    mockFetch({
      '/api/auth/callback/credentials': () => { authed = true; return ok({}); },
      '/api/auth/session': () => ok({ user: authed ? USER : null }),
      '/api/billing/status': () => status({ plan: authed ? 'pro' : 'free' }),
    });
    renderAuth();
    await waitFor(() => expect(callsTo('/api/billing/status')).toHaveLength(1));
    await click('checkout-default'); // opens the sign-in modal
    fillAndSubmit();
    await waitFor(() => expect(who()).toBe('Arun'));
    await waitFor(() => expect(planOf().plan).toBe('pro'));
    expect(callsTo('/api/billing/status').length).toBeGreaterThanOrEqual(2);
  });
});

describe('startCheckout signed out', () => {
  it('opens the sign-in modal with the checkout copy and posts nothing', async () => {
    renderAuth();
    await waitFor(() => expect(who()).toBe('none'));
    await click('checkout-default');
    expect(screen.getByRole('dialog', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText('Sign in to continue')).toBeInTheDocument();
    expect(screen.getByText('Pro is tied to your account. Sign in and we’ll take you straight to checkout.')).toBeInTheDocument();
    expect(lastOf()).toBe(JSON.stringify({ ok: false, pending: true }));
    expect(callsTo('/api/billing/checkout', 'POST')).toHaveLength(0);
  });

  it('starts checkout with the pending interval once credentials sign-in succeeds', async () => {
    let authed = false;
    const loc = stubLocation();
    mockFetch({
      '/api/auth/callback/credentials': () => { authed = true; return ok({}); },
      '/api/auth/session': () => ok({ user: authed ? USER : null }),
      '/api/billing/checkout': ok({ url: CHECKOUT_URL }),
      '/api/billing/status': status(),
    });
    renderAuth();
    await waitFor(() => expect(who()).toBe('none'));
    await click('checkout-month');
    fillAndSubmit();
    await waitFor(() => expect(callsTo('/api/billing/checkout', 'POST')).toHaveLength(1));
    expect(bodyOf('/api/billing/checkout')).toEqual({ interval: 'month' });
    expect(loc.assign).toHaveBeenCalledWith(CHECKOUT_URL);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('abandoning the modal drops the intent, so a plain sign-in skips checkout', async () => {
    let authed = false;
    stubLocation();
    mockFetch({
      '/api/auth/callback/credentials': () => { authed = true; return ok({}); },
      '/api/auth/session': () => ok({ user: authed ? USER : null }),
      '/api/billing/checkout': ok({ url: CHECKOUT_URL }),
    });
    renderAuth();
    await waitFor(() => expect(who()).toBe('none'));
    await click('checkout-default');
    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByText('sign-in'));
    expect(screen.getByText('Welcome back.')).toBeInTheDocument(); // plain sign-in copy, no checkout hand-off
    fillAndSubmit();
    await waitFor(() => expect(who()).toBe('Arun'));
    expect(callsTo('/api/billing/checkout', 'POST')).toHaveLength(0);
  });

  it('a failed sign-in keeps the modal open and starts no checkout', async () => {
    mockFetch({ '/api/auth/callback/credentials': ok({}) }); // session stays null
    renderAuth();
    await waitFor(() => expect(who()).toBe('none'));
    await click('checkout-default');
    fillAndSubmit();
    expect(await screen.findByText('Invalid username or password')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Sign in' })).toBeInTheDocument();
    expect(callsTo('/api/billing/checkout', 'POST')).toHaveLength(0);
  });
});

describe('startCheckout signed in', () => {
  it('POSTs the interval and navigates to the returned url', async () => {
    const loc = stubLocation();
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/billing/checkout': ok({ url: CHECKOUT_URL }),
      '/api/billing/status': status(),
    });
    renderAuth();
    await waitFor(() => expect(who()).toBe('Arun'));
    await click('checkout-month');
    const [, opts] = callsTo('/api/billing/checkout', 'POST')[0];
    expect(opts.credentials).toBe('include');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ interval: 'month' });
    expect(loc.assign).toHaveBeenCalledWith(CHECKOUT_URL);
    expect(lastOf()).toBe(JSON.stringify({ ok: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('defaults to the annual interval', async () => {
    stubLocation();
    mockFetch({ '/api/auth/session': ok({ user: USER }), '/api/billing/checkout': ok({ url: CHECKOUT_URL }) });
    renderAuth();
    await waitFor(() => expect(who()).toBe('Arun'));
    await click('checkout-default');
    expect(bodyOf('/api/billing/checkout')).toEqual({ interval: 'year' });
  });

  it('reports an error result instead of navigating', async () => {
    const loc = stubLocation();
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/billing/checkout': { ok: false, status: 402, json: async () => ({ error: 'No such price' }) },
    });
    renderAuth();
    await waitFor(() => expect(who()).toBe('Arun'));
    await click('checkout-default');
    expect(lastOf()).toBe(JSON.stringify({ ok: false, error: 'No such price' }));
    expect(loc.assign).not.toHaveBeenCalled();
  });

  it('an ok response without a url is still an error', async () => {
    stubLocation();
    mockFetch({ '/api/auth/session': ok({ user: USER }), '/api/billing/checkout': ok({}) });
    renderAuth();
    await waitFor(() => expect(who()).toBe('Arun'));
    await click('checkout-default');
    expect(lastOf()).toBe(JSON.stringify({ ok: false, error: 'Checkout failed (200)' }));
  });
});

describe('openPortal', () => {
  it('POSTs and navigates to the portal url', async () => {
    const loc = stubLocation();
    mockFetch({ '/api/auth/session': ok({ user: USER }), '/api/billing/portal': ok({ url: PORTAL_URL }) });
    renderAuth();
    await waitFor(() => expect(who()).toBe('Arun'));
    await click('portal');
    expect(callsTo('/api/billing/portal', 'POST')).toHaveLength(1);
    expect(loc.assign).toHaveBeenCalledWith(PORTAL_URL);
    expect(lastOf()).toBe(JSON.stringify({ ok: true }));
  });

  it('surfaces a status-coded error when the portal call fails', async () => {
    const loc = stubLocation();
    mockFetch({ '/api/auth/session': ok({ user: USER }), '/api/billing/portal': fail(500) });
    renderAuth();
    await waitFor(() => expect(who()).toBe('Arun'));
    await click('portal');
    expect(lastOf()).toBe(JSON.stringify({ ok: false, error: 'Could not open billing (500)' }));
    expect(loc.assign).not.toHaveBeenCalled();
  });
});

describe('checkout intent across an oauth redirect', () => {
  it('resumes checkout from sessionStorage once a user is present, then clears the key', async () => {
    const loc = stubLocation();
    sessionStorage.setItem(INTENT_KEY, 'month');
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/billing/checkout': ok({ url: CHECKOUT_URL }),
      '/api/billing/status': status(),
    });
    renderAuth();
    await waitFor(() => expect(callsTo('/api/billing/checkout', 'POST')).toHaveLength(1));
    expect(bodyOf('/api/billing/checkout')).toEqual({ interval: 'month' });
    expect(loc.assign).toHaveBeenCalledWith(CHECKOUT_URL);
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
  });

  it('leaves the key alone while signed out', async () => {
    sessionStorage.setItem(INTENT_KEY, 'year');
    renderAuth();
    await waitFor(() => expect(who()).toBe('none'));
    expect(callsTo('/api/billing/checkout', 'POST')).toHaveLength(0);
    expect(sessionStorage.getItem(INTENT_KEY)).toBe('year');
  });

  it('ignores a junk intent value', async () => {
    mockFetch({ '/api/auth/session': ok({ user: USER }) });
    renderAuth();
    sessionStorage.setItem(INTENT_KEY, 'forever');
    await waitFor(() => expect(who()).toBe('Arun'));
    expect(callsTo('/api/billing/checkout', 'POST')).toHaveLength(0);
  });

  it('parks the intent in sessionStorage before handing off to google', async () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    mockFetch({ '/api/auth/providers': ok({ google: {}, credentials: {} }) });
    renderAuth();
    await waitFor(() => expect(who()).toBe('none'));
    await click('checkout-month');
    await act(async () => { fireEvent.click(screen.getByText('Continue with Google')); });
    expect(sessionStorage.getItem(INTENT_KEY)).toBe('month');
    expect(submit.mock.instances[0].action).toContain('/api/auth/signin/google');
    submit.mockRestore();
  });

  it('writes nothing for a plain google sign-in with no checkout waiting', async () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    mockFetch({ '/api/auth/providers': ok({ google: {}, credentials: {} }) });
    renderAuth();
    await waitFor(() => expect(who()).toBe('none'));
    fireEvent.click(screen.getByText('sign-in'));
    expect(screen.getByText('Welcome back.')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByText('Continue with Google')); });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
    submit.mockRestore();
  });
});

describe('Pro entry points', () => {
  it('the topbar Pro button shows signed out and for free accounts', async () => {
    mockFetch({ '/api/billing/status': status() });
    const { unmount } = renderApp();
    await screen.findByRole('button', { name: /sign in/i });
    expect(proBtn()).toBeInTheDocument();
    unmount();
    mockFetch({ '/api/auth/session': ok({ user: USER }), '/api/billing/status': status() });
    renderApp();
    await findChip();
    expect(proBtn()).toBeInTheDocument();
  });

  it('the topbar Pro button disappears once the plan is pro', async () => {
    mockFetch({ '/api/auth/session': ok({ user: USER }), '/api/billing/status': status({ plan: 'pro', interval: 'year' }) });
    renderApp();
    await findChip();
    await waitFor(() => expect(proBtn()).toBeNull());
  });

  it('Pro opens the plans page and Calculator comes back', async () => {
    renderApp();
    await screen.findByRole('button', { name: /sign in/i });
    fireEvent.click(proBtn());
    expect(onPlansPage()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Get Pro' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Calculator' }));
    expect(onPlansPage()).toBeNull();
    expect(screen.getByText('Equity Breakdown')).toBeInTheDocument();
  });

  it('the plans brand mark also returns to the calculator', async () => {
    renderApp();
    await screen.findByRole('button', { name: /sign in/i });
    fireEvent.click(proBtn());
    fireEvent.click(screen.getByRole('button', { name: 'PokerLab' }));
    expect(onPlansPage()).toBeNull();
    expect(proBtn()).toBeInTheDocument();
  });

  it('navigates from plans straight into the replayer and the solver', async () => {
    renderApp();
    await screen.findByRole('button', { name: /sign in/i });
    fireEvent.click(proBtn());
    fireEvent.click(screen.getByRole('button', { name: 'Replayer' }));
    expect(screen.getByText('Hand Replayer')).toBeInTheDocument();
    fireEvent.click(document.querySelector('.replayer-back'));
    fireEvent.click(proBtn());
    fireEvent.click(screen.getByRole('button', { name: 'Solver' }));
    expect(screen.getByText('Spot configuration')).toBeInTheDocument();
  });

  it('the plans page checkout error lands in the plans alert', async () => {
    stubLocation();
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/billing/status': status(),
      '/api/billing/checkout': { ok: false, status: 500, json: async () => ({ error: 'Stripe is down' }) },
    });
    renderApp();
    await findChip();
    fireEvent.click(proBtn());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Get Pro' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('Stripe is down');
    expect(bodyOf('/api/billing/checkout')).toEqual({ interval: 'year' });
  });

  it('signed out, Get Pro opens the sign-in modal instead of checking out', async () => {
    renderApp();
    await screen.findByRole('button', { name: /sign in/i });
    fireEvent.click(proBtn());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Get Pro' })); });
    expect(screen.getByText('Sign in to continue')).toBeInTheDocument();
    expect(callsTo('/api/billing/checkout', 'POST')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull(); // a pending result is not an error
  });

  it('the free card create-account CTA opens the signup modal', async () => {
    renderApp();
    await screen.findByRole('button', { name: /sign in/i });
    fireEvent.click(proBtn());
    fireEvent.click(screen.getByRole('button', { name: 'Create a free account' }));
    expect(screen.getByRole('dialog', { name: 'Create account' })).toBeInTheDocument();
  });
});

describe('account menu plan states', () => {
  it('a free account shows the saved-hand count, capped at the plan cap', async () => {
    mockFetch({ '/api/auth/session': ok({ user: USER }), '/api/billing/status': status({ saved: 3 }) });
    const { unmount } = renderApp();
    await openChipMenu();
    await waitFor(() => expect(menuPlan()).toBe('Free plan · 3 of 25 hands saved'));
    expect(document.querySelector('.pro-badge')).toBeNull();
    unmount();
    mockFetch({ '/api/auth/session': ok({ user: USER }), '/api/billing/status': status({ saved: 40 }) });
    renderApp();
    await openChipMenu();
    await waitFor(() => expect(menuPlan()).toBe('Free plan · 25 of 25 hands saved'));
  });

  it('a pro account shows the badge, the interval, and Manage instead of Upgrade', async () => {
    mockFetch({ '/api/auth/session': ok({ user: USER }), '/api/billing/status': status({ plan: 'pro', interval: 'year' }) });
    renderApp();
    const menu = await openChipMenu();
    await waitFor(() => expect(menuPlan()).toBe('Pro plan · annual'));
    expect(within(menu).getByText('PRO')).toHaveClass('pro-badge');
    expect(within(menu).getByText('Manage subscription')).toBeInTheDocument();
    expect(within(menu).queryByText('Upgrade to Pro')).toBeNull();
    expect(menu.querySelectorAll('.user-menu-item')).toHaveLength(6);
  });

  it('a monthly pro account reads monthly', async () => {
    mockFetch({ '/api/auth/session': ok({ user: USER }), '/api/billing/status': status({ plan: 'pro', interval: 'month' }) });
    renderApp();
    await openChipMenu();
    await waitFor(() => expect(menuPlan()).toBe('Pro plan · monthly'));
  });

  it('Upgrade to Pro closes the menu and opens the plans page', async () => {
    mockFetch({ '/api/auth/session': ok({ user: USER }), '/api/billing/status': status() });
    renderApp();
    const menu = await openChipMenu();
    expect(menu.querySelector('.user-menu-item.pro').textContent).toContain('Upgrade to Pro');
    fireEvent.click(within(menu).getByText('Upgrade to Pro'));
    expect(document.querySelector('.user-menu')).toBeNull();
    expect(onPlansPage()).toBeInTheDocument();
  });

  it('Manage subscription opens the billing portal', async () => {
    const loc = stubLocation();
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/billing/status': status({ plan: 'pro', interval: 'year' }),
      '/api/billing/portal': ok({ url: PORTAL_URL }),
    });
    renderApp();
    await findChip();
    await waitFor(async () => expect(within(await openChipMenu()).queryByText('Manage subscription')).not.toBeNull());
    await act(async () => { fireEvent.click(screen.getByText('Manage subscription')); });
    expect(callsTo('/api/billing/portal', 'POST')).toHaveLength(1);
    expect(loc.assign).toHaveBeenCalledWith(PORTAL_URL);
  });

  it('a failing portal call toasts the error', async () => {
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/billing/status': status({ plan: 'pro', interval: 'year' }),
      '/api/billing/portal': fail(500),
    });
    renderApp();
    await findChip();
    await waitFor(async () => expect(within(await openChipMenu()).queryByText('Manage subscription')).not.toBeNull());
    await act(async () => { fireEvent.click(screen.getByText('Manage subscription')); });
    expect(toast()).toHaveTextContent('Could not open billing (500)');
  });

  it('the solver menu offers no billing actions in either plan', async () => {
    const routes = { '/api/auth/session': ok({ user: USER }) };
    mockFetch({ ...routes, '/api/billing/status': status() });
    const { unmount } = renderApp();
    await findChip();
    fireEvent.click(screen.getByRole('button', { name: 'Solver' }));
    let menu = await openChipMenu();
    expect(menu.querySelectorAll('.user-menu-item')).toHaveLength(1);
    expect(within(menu).queryByText('Upgrade to Pro')).toBeNull();
    unmount();
    mockFetch({ ...routes, '/api/billing/status': status({ plan: 'pro', interval: 'year' }) });
    renderApp();
    await findChip();
    fireEvent.click(screen.getByRole('button', { name: 'Solver' }));
    menu = await openChipMenu();
    await waitFor(() => expect(within(menu).getByText('PRO')).toBeInTheDocument());
    expect(within(menu).queryByText('Manage subscription')).toBeNull();
  });
});

describe('save-limit prompt', () => {
  const AT_CAP = { search: { id: 'x' }, limit: { plan: 'free', atCap: true } };

  async function saveFavorite() {
    fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));
    const dlg = await screen.findByRole('dialog', { name: 'Save hand' });
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: 'Favorite' })); });
  }
  const prompt = () => screen.queryByRole('dialog', { name: 'Your hand history is full' });

  async function signedIn(searchResponse, planOver = {}) {
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/billing/status': status(planOver),
      '/api/searches': searchResponse,
      '/api/billing/checkout': ok({ url: CHECKOUT_URL }),
    });
    const utils = renderApp();
    await findChip();
    return utils;
  }

  it('opens once when a free save comes back at the cap', async () => {
    await signedIn(ok(AT_CAP));
    await saveFavorite();
    expect(prompt()).toBeInTheDocument();
    expect(within(prompt()).getByText(/keep the 25 most recent hands/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(prompt()).toBeNull();
    await saveFavorite();
    expect(prompt()).toBeNull(); // once per session
  });

  it('stays away for a pro account and for a free account under the cap', async () => {
    const { unmount } = await signedIn(ok({ search: { id: 'x' }, limit: { plan: 'pro', atCap: true } }), { plan: 'pro', interval: 'year' });
    await saveFavorite();
    expect(prompt()).toBeNull();
    unmount();
    await signedIn(ok({ search: { id: 'x' }, limit: { plan: 'free', atCap: false } }));
    await saveFavorite();
    expect(prompt()).toBeNull();
  });

  it('Compare plans swaps the prompt for the plans page', async () => {
    await signedIn(ok(AT_CAP));
    await saveFavorite();
    fireEvent.click(screen.getByRole('button', { name: 'Compare plans' }));
    expect(prompt()).toBeNull();
    expect(onPlansPage()).toBeInTheDocument();
  });

  it('Upgrade to Pro checks out on the annual plan and closes the prompt', async () => {
    const loc = stubLocation();
    await signedIn(ok(AT_CAP));
    await saveFavorite();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro' })); });
    expect(bodyOf('/api/billing/checkout')).toEqual({ interval: 'year' });
    expect(loc.assign).toHaveBeenCalledWith(CHECKOUT_URL);
    expect(prompt()).toBeNull();
  });

  it('a failed upgrade keeps the prompt up and toasts the error', async () => {
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/billing/status': status(),
      '/api/searches': ok(AT_CAP),
      '/api/billing/checkout': { ok: false, status: 500, json: async () => ({ error: 'Stripe is down' }) },
    });
    renderApp();
    await findChip();
    await saveFavorite();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro' })); });
    expect(prompt()).toBeInTheDocument();
    expect(toast()).toHaveTextContent('Stripe is down');
  });

  it('an at-cap PokerNow import prompts as well', async () => {
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/billing/status': status(),
      '/api/searches': (u, o) => (((o && o.method) || 'GET') === 'POST' ? ok(AT_CAP) : ok({ searches: [] })),
    });
    renderApp();
    fireEvent.click(await findChip());
    fireEvent.click(screen.getByRole('button', { name: 'Import PokerNow log' }));
    const dialog = screen.getByRole('dialog', { name: 'Upload PokerNow log' });
    const file = new File([JSON.stringify(pnLog())], 'log.json', { type: 'application/json' });
    fireEvent.change(dialog.querySelector('input[type="file"]'), { target: { files: [file] } });
    fireEvent.click((await screen.findByText('alice')).closest('button'));
    const numbers = screen.getByPlaceholderText(/Type a hand number/);
    fireEvent.change(numbers, { target: { value: '1' } });
    fireEvent.keyDown(numbers, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 hand' }));
    expect(await screen.findByRole('dialog', { name: 'Your hand history is full' })).toBeInTheDocument();
  });

  it('a save refreshes the plan so the menu counter keeps up', async () => {
    let saved = 24;
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/billing/status': () => status({ saved }),
      '/api/searches': (u, o) => {
        if (((o && o.method) || 'GET') !== 'POST') return ok({ searches: [] }); // the prefetch
        saved++;
        return ok({ search: { id: 'x' } });
      },
    });
    renderApp();
    await findChip();
    await openChipMenu();
    await waitFor(() => expect(menuPlan()).toBe('Free plan · 24 of 25 hands saved'));
    fireEvent.mouseDown(document.body); // close the menu before saving
    await saveFavorite();
    await openChipMenu();
    await waitFor(() => expect(menuPlan()).toBe('Free plan · 25 of 25 hands saved'));
  });
});

describe('return from stripe checkout', () => {
  it('strips ?billing=success, toasts while activating, then confirms Pro', async () => {
    vi.useFakeTimers();
    let pro = false;
    mockFetch({
      '/api/auth/session': ok({ user: USER }),
      '/api/billing/status': () => status(pro ? { plan: 'pro', interval: 'year' } : {}),
    });
    window.history.replaceState(null, '', '/?billing=success');
    renderApp();
    await act(async () => {});
    expect(window.location.search).toBe('');
    expect(toast()).toHaveTextContent('Activating Pro…');
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(toast()).toHaveTextContent('Activating Pro…'); // still free
    pro = true;
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(toast()).toHaveTextContent('You’re on Pro');
    await act(async () => { vi.advanceTimersByTime(3600); });
    expect(toast()).toBeNull();
  });

  it('gives up after 12 polls with a reassuring toast', async () => {
    vi.useFakeTimers();
    mockFetch({ '/api/auth/session': ok({ user: USER }), '/api/billing/status': () => status() });
    window.history.replaceState(null, '', '/?billing=success');
    renderApp();
    await act(async () => {});
    for (let i = 0; i < 12; i++) await act(async () => { vi.advanceTimersByTime(1500); });
    expect(toast()).toHaveTextContent('Payment received. Pro switches on in a moment.');
    expect(callsTo('/api/billing/status').length).toBeGreaterThanOrEqual(12);
  });

  it('keeps other query params while dropping the billing marker', async () => {
    mockFetch({ '/api/auth/session': ok({ user: USER }), '/api/billing/status': status() });
    window.history.replaceState(null, '', '/?ref=twitter&billing=cancel');
    renderApp();
    await findChip();
    expect(window.location.search).toBe('?ref=twitter');
    expect(toast()).toBeNull();
  });

  it('?billing=cancel leaves no toast behind', async () => {
    mockFetch({ '/api/auth/session': ok({ user: USER }), '/api/billing/status': status() });
    window.history.replaceState(null, '', '/?billing=cancel');
    renderApp();
    await findChip();
    expect(window.location.search).toBe('');
    expect(toast()).toBeNull();
  });

  it('signed out, a success return never starts polling', async () => {
    mockFetch({ '/api/billing/status': status() });
    window.history.replaceState(null, '', '/?billing=success');
    renderApp();
    await screen.findByRole('button', { name: /sign in/i });
    expect(window.location.search).toBe('');
    expect(toast()).toBeNull();
  });
});
