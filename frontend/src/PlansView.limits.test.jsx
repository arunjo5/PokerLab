import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import App from './App.jsx';
import { AuthProvider, DEFAULT_LIMITS } from './AuthContext.jsx';
import { PlansView, PRO_FEATURES, freeFeatures, proFeatures } from './PlansView.jsx';
import { UpgradePrompt } from './UpgradePrompt.jsx';

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

const status = (over = {}) => ok({ plan: 'free', saveCap: 25, saved: 0, billingEnabled: true, ...over });
const FREE_PLAN = { plan: 'free', interval: null, saveCap: 25, saved: 0, hasCustomer: false, billingEnabled: true };

// deliberately unround so a hardcoded number would stand out
const LIMITS = {
  free: { saveCap: 1000, shareLinks: 2, ranges: 9, solves: 7 },
  pro: { saveCap: 12345, shareLinks: 900, ranges: 42, solves: 43 },
};

function renderPlans(over = {}) {
  const props = {
    onExit: vi.fn(),
    onNavigate: vi.fn(),
    themeToggle: <button>theme</button>,
    userMenu: <button>menu</button>,
    user: null,
    plan: FREE_PLAN,
    onGetPro: vi.fn(async () => ({ ok: true })),
    onCreateAccount: vi.fn(),
    onManage: vi.fn(async () => ({ ok: true })),
    ...over,
  };
  return { ...render(<PlansView {...props} />), props };
}

const cardRows = (name) =>
  [...screen.getByRole('region', { name }).querySelectorAll('.plan-feats li')].map((li) => li.textContent);
const proBtn = () => document.querySelector('.btn-pro');
const onPlansPage = () => screen.queryByRole('heading', { name: 'Study for free. Keep everything with Pro.' });

beforeEach(() => {
  localStorage.clear();
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('freeFeatures / proFeatures', () => {
  it('defaults to the built-in plan caps', () => {
    expect(freeFeatures()).toContain('Save up to 25 hands');
    expect(freeFeatures()).toContain('3 saved ranges and 3 saved solves');
    expect(proFeatures()).toContain('Save up to 5,000 hands');
    expect(proFeatures()).toContain('200 saved ranges and 200 saved solves');
    expect(proFeatures()).toContain('500 permanent short share links');
    expect(freeFeatures()).toEqual(freeFeatures(DEFAULT_LIMITS));
  });

  it('reads every number off the caps it is handed', () => {
    expect(freeFeatures(LIMITS)).toEqual([
      'Equity calculator, ranges, pot odds & MDF',
      'Heads-up river solver',
      'Hand replayer with PokerNow import',
      'Save up to 1,000 hands',
      '9 saved ranges and 7 saved solves',
      'Share links',
    ]);
    expect(proFeatures(LIMITS)).toEqual([
      'Everything in Free',
      'Save up to 12,345 hands',
      '42 saved ranges and 43 saved solves',
      '900 permanent short share links',
      'Session stats from your PokerNow imports',
      'Exploit solver against real opponent tendencies',
      'Support PokerLab’s development',
    ]);
  });

  it('groups thousands in the hand cap only', () => {
    const limits = { free: DEFAULT_LIMITS.free, pro: { saveCap: 20000, shareLinks: 1500, ranges: 2000, solves: 3000 } };
    expect(proFeatures(limits)).toContain('Save up to 20,000 hands');
    expect(proFeatures(limits)).toContain('1500 permanent short share links');
    expect(proFeatures(limits)).toContain('2000 saved ranges and 3000 saved solves');
  });

  it('PRO_FEATURES is the default-cap pro list', () => {
    expect(PRO_FEATURES).toEqual(proFeatures());
    expect(PRO_FEATURES).toEqual(proFeatures(DEFAULT_LIMITS));
  });
});

describe('PlansView feature rows', () => {
  it('builds both cards from the caps on the plan', () => {
    renderPlans({ plan: { ...FREE_PLAN, limits: LIMITS } });
    expect(cardRows('Free plan')).toEqual(freeFeatures(LIMITS));
    expect(cardRows('Pro plan')).toEqual(proFeatures(LIMITS));
    expect(screen.getByText('9 saved ranges and 7 saved solves')).toBeInTheDocument();
    expect(screen.getByText('42 saved ranges and 43 saved solves')).toBeInTheDocument();
  });

  it('falls back to the built-in caps when the plan carries none', () => {
    renderPlans({ plan: FREE_PLAN });
    expect(cardRows('Free plan')).toEqual(freeFeatures(DEFAULT_LIMITS));
    expect(cardRows('Pro plan')).toEqual(PRO_FEATURES);
  });

  it('a pro subscriber sees the same cap-driven rows', () => {
    renderPlans({ plan: { ...FREE_PLAN, plan: 'pro', limits: LIMITS }, user: { name: 'Arun' } });
    expect(cardRows('Pro plan')).toEqual(proFeatures(LIMITS));
    expect(within(screen.getByRole('region', { name: 'Pro plan' })).getByRole('button', { name: 'Current plan' })).toBeDisabled();
  });
});

describe('UpgradePrompt feature rows', () => {
  it('lists the handed-in pro caps minus the everything-in-free line', () => {
    render(<UpgradePrompt open cap={1000} limits={LIMITS} onClose={vi.fn()} onCompare={vi.fn()} onUpgrade={vi.fn()} />);
    const items = [...document.querySelectorAll('.plan-feats li')].map((li) => li.textContent);
    expect(items).toEqual(proFeatures(LIMITS).slice(1));
    expect(screen.getByText('Save up to 12,345 hands')).toBeInTheDocument();
  });

  it('falls back to the built-in caps with no limits prop', () => {
    render(<UpgradePrompt open cap={25} onClose={vi.fn()} onCompare={vi.fn()} onUpgrade={vi.fn()} />);
    const items = [...document.querySelectorAll('.plan-feats li')].map((li) => li.textContent);
    expect(items).toEqual(PRO_FEATURES.slice(1));
  });
});

describe('plans page caps come from /api/billing/status', () => {
  it('renders the caps the server reports rather than the defaults', async () => {
    mockFetch({ '/api/billing/status': status({ limits: LIMITS }) });
    render(<AuthProvider><App /></AuthProvider>);
    await waitFor(() => expect(proBtn()).not.toBeNull());
    fireEvent.click(proBtn());
    expect(onPlansPage()).toBeInTheDocument();
    expect(cardRows('Free plan')).toContain('9 saved ranges and 7 saved solves');
    expect(cardRows('Free plan')).toContain('Save up to 1,000 hands');
    expect(cardRows('Pro plan')).toContain('42 saved ranges and 43 saved solves');
    expect(cardRows('Pro plan')).toContain('900 permanent short share links');
  });

  it('keeps the built-in caps when the status carries none', async () => {
    mockFetch({ '/api/billing/status': status() });
    render(<AuthProvider><App /></AuthProvider>);
    await waitFor(() => expect(proBtn()).not.toBeNull());
    fireEvent.click(proBtn());
    expect(cardRows('Free plan')).toEqual(freeFeatures(DEFAULT_LIMITS));
    expect(cardRows('Pro plan')).toEqual(PRO_FEATURES);
  });
});
