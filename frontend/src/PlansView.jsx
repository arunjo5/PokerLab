import React, { useState } from 'react';

import { DEFAULT_LIMITS } from './AuthContext.jsx';

const PRICES = {
  year: { amount: 3, note: 'Billed $36 a year.' },
  month: { amount: 4, note: 'Billed month to month.' },
};

const fmt = (n) => n.toLocaleString('en-US');

// feature rows come from the plan caps so the page always shows the real numbers
export function freeFeatures(limits = DEFAULT_LIMITS) {
  const l = limits.free;
  return [
    'Equity calculator, ranges, pot odds & MDF',
    'Heads-up river solver',
    'Hand replayer with PokerNow import',
    `Save up to ${fmt(l.saveCap)} hands`,
    `${l.ranges} saved ranges and ${l.solves} saved solves`,
    'Share links',
  ];
}
export function proFeatures(limits = DEFAULT_LIMITS) {
  const l = limits.pro;
  return [
    'Everything in Free',
    `Save up to ${fmt(l.saveCap)} hands`,
    `${l.ranges} saved ranges and ${l.solves} saved solves`,
    `${l.shareLinks} permanent short share links`,
    'Session stats from your PokerNow imports',
    'Exploit solver against real opponent tendencies',
    'Support PokerLab’s development',
  ];
}
export const PRO_FEATURES = proFeatures();

export function FeatureList({ items }) {
  return (
    <ul className="plan-feats">
      {items.map((t) => (
        <li key={t}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
          {t}
        </li>
      ))}
    </ul>
  );
}

export function PlansView({ onExit, onNavigate, themeToggle, userMenu, user, plan, onGetPro, onCreateAccount, onManage }) {
  const [interval, setInterval] = useState('year');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const isPro = plan.plan === 'pro';
  const price = PRICES[interval];
  const limits = plan.limits || DEFAULT_LIMITS;

  async function run(fn) {
    setBusy(true);
    setError(null);
    const res = await fn();
    if (res && res.error) setError(res.error);
    setBusy(false);
  }

  return (
    <div className="app plans-page">
      <div className="topbar">
        <div className="brand">
          <button className="brand-mark brand-link" onClick={onExit}><span className="accent">Poker</span>Lab</button>
        </div>
        <div className="toolbar">
          <button className="btn btn-ghost" onClick={() => onNavigate('calc')}>Calculator</button>
          <button className="btn btn-ghost btn-replayer" onClick={() => onNavigate('replayer')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3" /></svg>
            Replayer
          </button>
          <button className="btn btn-ghost btn-solver" onClick={() => onNavigate('solver')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M7 14l3-4 3 2 4-6" /></svg>
            Solver
          </button>
        </div>
        <div className="topbar-account">
          {themeToggle}
          {userMenu}
        </div>
      </div>

      <div className="plans">
        <h1 className="plans-title">Study for free. Keep everything with Pro.</h1>

        <div className="plans-toggle" role="tablist" aria-label="Billing period">
          <button role="tab" aria-selected={interval === 'month'} className={interval === 'month' ? 'active' : ''} onClick={() => setInterval('month')}>Monthly</button>
          <button role="tab" aria-selected={interval === 'year'} className={interval === 'year' ? 'active' : ''} onClick={() => setInterval('year')}>
            Annual <span className="plans-save">3 months free</span>
          </button>
        </div>

        <div className="plans-grid">
          <section className="plan-card" aria-label="Free plan">
            <div className="plan-head">
              <div className="plan-tier">Free</div>
              <div className="plan-price"><span className="plan-amount">$0</span></div>
              <div className="plan-note">Everything you need to study a spot.</div>
            </div>
            <div className="plan-rule" />
            <FeatureList items={freeFeatures(limits)} />
            <div className="plan-cta">
              {!user ? (
                <button className="btn" onClick={onCreateAccount}>Create a free account</button>
              ) : (
                <button className="btn" disabled>{isPro ? 'Included in Pro' : 'Current plan'}</button>
              )}
            </div>
          </section>

          <section className="plan-card pro" aria-label="Pro plan">
            <div className="plan-head">
              <div className="plan-tier">Pro</div>
              <div className="plan-price"><span className="plan-amount">${price.amount}</span><span className="plan-unit">/ month</span></div>
              <div className="plan-note">{price.note}</div>
            </div>
            <div className="plan-rule" />
            <FeatureList items={proFeatures(limits)} />
            <div className="plan-cta">
              {isPro ? (
                <>
                  <button className="btn" disabled>Current plan</button>
                  <button className="btn btn-ghost" onClick={() => run(onManage)} disabled={busy}>Manage subscription</button>
                </>
              ) : (
                <>
                  <button className="btn btn-primary" onClick={() => run(() => onGetPro(interval))} disabled={busy}>
                    {busy ? 'Opening checkout…' : 'Get Pro'}
                  </button>
                  {!user && <div className="plan-hint">You’ll sign in first, then go straight to checkout.</div>}
                </>
              )}
            </div>
          </section>
        </div>

        {error && <div className="plans-error" role="alert">{error}</div>}
        <div className="plans-foot">Cancel anytime.</div>
      </div>
    </div>
  );
}
