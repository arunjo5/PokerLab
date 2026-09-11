import React, { useEffect, useRef, useState } from 'react';
import { splitShareUrl } from './shareLinks.js';
import { useFlash } from './hooks.js';

async function copyText(text, inputEl) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    inputEl?.select();
    document.execCommand('copy');
  }
}

/**
 * ShareModal — copy-to-clipboard link with hash-encoded scenario.
 * Friends opening the link will get the exact same setup loaded.
 * `short` (optional): { pro, signedIn, create(kind, payload), onUpgrade } adds the Pro section.
 */
export function ShareModal({ open, onClose, url, short = null }) {
  const [copied, flashCopied, setCopied] = useFlash(1800, false);
  const [shortUrl, setShortUrl] = useState('');
  const [shortBusy, setShortBusy] = useState(false);
  const [shortError, setShortError] = useState(null);
  const [copiedShort, flashCopiedShort, setCopiedShort] = useFlash(1800, false);
  const inputRef = useRef(null);
  const shortRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setShortUrl('');
    setShortBusy(false);
    setShortError(null);
    setCopiedShort(false);
    setTimeout(() => inputRef.current?.select(), 60);
  }, [open, url, setCopied, setCopiedShort]);

  if (!open) return null;

  async function copy() {
    try {
      await copyText(url, inputRef.current);
      flashCopied(true);
    } catch {
      // ignore — user can copy manually from the field
    }
  }

  async function copyShort() {
    try {
      await copyText(shortUrl, shortRef.current);
      flashCopiedShort(true);
    } catch { /* same */ }
  }

  async function createShort() {
    const parts = splitShareUrl(url);
    if (!parts) { setShortError('Nothing to shorten yet.'); return; }
    setShortBusy(true);
    setShortError(null);
    const res = await short.create(parts.kind, parts.payload);
    setShortBusy(false);
    if (res && res.ok && res.url) setShortUrl(res.url);
    else setShortError((res && res.error) || 'Could not create the link.');
  }

  return (
    <div className="picker-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="share-modal" role="dialog" aria-label="Share scenario">
        <div className="share-head">
          <div>
            <div className="auth-title">Share scenario</div>
            <div className="auth-sub">
              Friends opening this link will see the exact same setup —
              seats, ranges, board, pot odds and all.
            </div>
          </div>
          <button className="modal-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="share-body">
          <div className="share-link-label">Link</div>
          <div className="share-link-row">
            <input
              ref={inputRef}
              className="share-link"
              type="text"
              value={url}
              readOnly
              onClick={(e) => e.target.select()}
            />
            <button className="btn btn-primary share-copy-btn" onClick={copy}>
              {copied ? (
                <>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  Copied
                </>
              ) : (
                <>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="11" height="11" rx="2" />
                    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                  </svg>
                  Copy link
                </>
              )}
            </button>
          </div>

          {short && (short.pro ? (
            <div className="share-short">
              <div className="share-link-label">Permanent short link</div>
              {shortUrl ? (
                <>
                  <div className="share-link-row">
                    <input
                      ref={shortRef}
                      className="share-link share-link-short"
                      type="text"
                      value={shortUrl}
                      readOnly
                      onClick={(e) => e.target.select()}
                    />
                    <button className="btn btn-primary share-copy-btn" onClick={copyShort}>
                      {copiedShort ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <div className="share-hint">Stays live until you delete it from Hand History → Links.</div>
                </>
              ) : (
                <>
                  <div className="share-link-row">
                    <div className="share-short-blurb">A short link that never breaks, listed under your account.</div>
                    <button className="btn share-copy-btn" onClick={createShort} disabled={shortBusy}>
                      {shortBusy ? 'Creating…' : 'Create'}
                    </button>
                  </div>
                  {shortError && <div className="share-error" role="alert">{shortError}</div>}
                </>
              )}
            </div>
          ) : (
            <div className="share-pro-tease">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /></svg>
              <span>Pro members get a permanent short link that never breaks.</span>
              <button className="link-btn" onClick={short.onUpgrade}>{short.signedIn ? 'Upgrade' : 'See Pro'}</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
