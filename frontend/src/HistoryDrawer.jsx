import React, { useRef, useEffect, useState } from 'react';
import { SuitGlyph, SUIT_RED } from './Cards.jsx';

function relTime(d) {
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
  return d.toLocaleDateString();
}

function stageLabel(boardLen) {
  if (boardLen === 0) return 'Pre-flop';
  if (boardLen === 3) return 'Flop';
  if (boardLen === 4) return 'Turn';
  if (boardLen === 5) return 'River';
  return `${boardLen} board`;
}

function HistCard({ card }) {
  const red = SUIT_RED[card.s];
  return (
    <span className={'hist-card ' + (red ? 'red' : 'ink')}>
      <span className="hist-card-rank">{card.v === 'T' ? '10' : card.v}</span>
      <SuitGlyph suit={card.s} size={10} color="currentColor" />
    </span>
  );
}

function HistoryRow({ item, onLoad, onToggleFavorite, onDelete }) {
  const heroCards = item.heroCards;
  const heroIsRange = !heroCards && item.heroLabel;
  const board = item.boardPreview || [];
  const isReplay = !!item.isReplay;
  return (
    <div className={'hist-row ' + (item.starred ? 'starred ' : '') + (isReplay ? 'is-replay' : '')}>
      <button className="hist-load" onClick={onLoad}>
        <div className="hist-row-top">
          <div className="hist-row-stage">
            {isReplay
              ? <span className="hist-replay-badge"><svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>REPLAY</span>
              : <span className="hist-stage-dot" />}
            {isReplay ? 'Full hand' : stageLabel(item.boardLen)}
            <span className="hist-row-sep">·</span>
            <span className="hist-row-players">{item.playerCount}-way</span>
            {isReplay && item.blindsLabel && (
              <><span className="hist-row-sep">·</span><span className="hist-row-players">{item.blindsLabel}</span></>
            )}
            {!isReplay && item.name && (
              <>
                <span className="hist-row-sep">·</span>
                <span className="hist-row-name">{item.name}</span>
              </>
            )}
          </div>
          <span className="hist-time">{relTime(new Date(item.ts))}</span>
        </div>
        <div className="hist-row-cards">
          {heroCards && heroCards.length > 0 && (
            <>
              <span className="hist-row-tag">HERO</span>
              {heroCards.map((c, i) => <HistCard key={i} card={c} />)}
            </>
          )}
          {heroIsRange && (
            <>
              <span className="hist-row-tag">HERO</span>
              <span className="hist-card range-tag">{item.heroLabel}</span>
            </>
          )}
          {board.length > 0 && (
            <>
              <span className="hist-row-tag" style={{ marginLeft: 8 }}>BOARD</span>
              {board.map((c, i) => <HistCard key={i} card={c} />)}
            </>
          )}
        </div>
        <div className="hist-row-meta">
          {item.heroEquity != null
            ? <><span className="hist-equity-pill">{item.heroEquity.toFixed(1)}%</span> hero equity</>
            : isReplay ? 'Stored hand' : '—'}
          {isReplay && item.actionCount != null && (
            <span className="hist-row-meta-sub"> · {item.actionCount} action{item.actionCount === 1 ? '' : 's'} · click to replay</span>
          )}
          {!isReplay && item.topName && item.topName !== item.heroName && item.topEquity != null && (
            <span className="hist-row-meta-sub"> · leader {item.topName} {item.topEquity.toFixed(1)}%</span>
          )}
        </div>
      </button>
      <div className="hist-actions">
        <button
          className={'hist-star ' + (item.starred ? 'on' : '')}
          onClick={onToggleFavorite}
          aria-label={item.starred ? 'Unfavorite' : 'Favorite'}
          title={item.starred ? 'Unfavorite' : 'Favorite'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24"
               fill={item.starred ? 'currentColor' : 'none'}
               stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
            <path d="M12 2.5l2.9 6.3 6.9.8-5.1 4.7 1.4 6.7L12 17.7l-6.1 3.3 1.4-6.7L2.2 9.6l6.9-.8z" />
          </svg>
        </button>
        <button className="hist-del" onClick={onDelete} aria-label="Delete" title="Delete">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 7h16" />
            <path d="M9 7V4h6v3" />
            <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/**
 * HistoryDrawer — slide-in panel of saved hands. Filter All / Starred,
 * load, favorite, delete, clear all.
 */
// one short link row
function LinkRow({ link, url, onOpen, onDelete, onRename }) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(link.name || '');
  const doneRef = useRef(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked; the url is visible in the row */ }
  }

  function startRename() {
    setDraft(link.name || '');
    doneRef.current = false;
    setEditing(true);
  }

  // enter/blur save, escape cancels; the ref guards the blur after enter
  function finishRename(save) {
    if (doneRef.current) return;
    doneRef.current = true;
    setEditing(false);
    const name = draft.trim();
    if (save && name !== (link.name || '')) onRename(name);
  }

  return (
    <div className="link-row">
      <button className="link-load" onClick={onOpen} title="Open">
        <div className="link-row-top">
          <span className="link-kind">{link.kind === 'replay' ? 'REPLAY' : 'SPOT'}</span>
          <span className="link-row-name">{link.name || 'Untitled'}</span>
          <span className="hist-time">{relTime(new Date(link.createdAt))}</span>
        </div>
        <div className="link-row-url">{url.replace(/^https?:\/\//, '')}</div>
        <div className="link-row-meta">{link.views} view{link.views === 1 ? '' : 's'}</div>
      </button>
      <div className="link-acts">
        {editing ? (
          <input
            className="link-rename"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); finishRename(true); }
              else if (e.key === 'Escape') finishRename(false);
            }}
            onBlur={() => finishRename(true)}
            autoFocus
            maxLength={100}
            placeholder="Name"
            aria-label="Link name"
          />
        ) : (
          <>
            <button className="link-act" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            <button className="link-act" onClick={startRename}>Rename</button>
          </>
        )}
        <button className="hist-del" onClick={onDelete} aria-label="Delete link" title="Delete link">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 7h16" />
            <path d="M9 7V4h6v3" />
            <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export function HistoryDrawer({
  open,
  onClose,
  history,
  loading,
  error,
  onLoad,
  onToggleFavorite,
  onDelete,
  onClear,
  user,
  cap,
  hasMore,
  loadingMore,
  onLoadMore,
  onNeedStarred,
  links,
  linksLoading,
  linkUrl,
  onOpenLink,
  onDeleteLink,
  onRenameLink,
}) {
  const [filter, setFilter] = useState('all');
  const showLinks = Array.isArray(links);
  // the tab can vanish mid-view (free user deleting their last link)
  useEffect(() => { if (!showLinks && filter === 'links') setFilter('all'); }, [showLinks, filter]);
  const [confirmingClear, setConfirmingClear] = useState(false);
  useEffect(() => { if (!open) { setFilter('all'); setConfirmingClear(false); } }, [open]);

  if (!open) return null;

  const starredCount = history.filter(h => h.starred).length;
  const list = filter === 'starred' ? history.filter(h => h.starred) : history;

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Hand history">
        <div className="drawer-head">
          <div>
            <div className="drawer-title">Hand history</div>
            <div className="drawer-sub">
              {user
                ? <>Signed in as <span style={{ color: 'var(--text)' }}>{user.name || user.email}</span> · {history.length} hand{history.length === 1 ? '' : 's'}</>
                : 'Sign in to sync across devices'}
            </div>
            {user && (
              <div className="drawer-sub" style={{ marginTop: 2, fontSize: 11, opacity: 0.7 }}>
                Keeps your latest {(cap || 500).toLocaleString('en-US')} hands, favorites first
              </div>
            )}
          </div>
          <button className="modal-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="drawer-tabs">
          <button className={'drawer-tab ' + (filter === 'all' ? 'active' : '')} onClick={() => setFilter('all')}>
            All<span className="drawer-tab-count">{history.length}</span>
          </button>
          <button className={'drawer-tab ' + (filter === 'starred' ? 'active' : '')} onClick={() => { setFilter('starred'); if (onNeedStarred) onNeedStarred(); }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: 4 }}>
              <path d="M12 2.5l2.9 6.3 6.9.8-5.1 4.7 1.4 6.7L12 17.7l-6.1 3.3 1.4-6.7L2.2 9.6l6.9-.8z" />
            </svg>
            Starred<span className="drawer-tab-count">{starredCount}</span>
          </button>
          {showLinks && (
            <button className={'drawer-tab ' + (filter === 'links' ? 'active' : '')} onClick={() => setFilter('links')}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
              </svg>
              Links<span className="drawer-tab-count">{links.length}</span>
            </button>
          )}
          {history.length > 0 && filter !== 'links' && (
            confirmingClear ? (
              <span className="drawer-clear-confirm">
                <span className="drawer-clear-q">Clear unfavorited?</span>
                <button
                  className="drawer-clear-yes"
                  onClick={() => { onClear(); setConfirmingClear(false); }}
                >Clear</button>
                <button
                  className="drawer-clear-no"
                  onClick={() => setConfirmingClear(false)}
                >Cancel</button>
              </span>
            ) : (
              <button className="drawer-tab-clear" onClick={() => setConfirmingClear(true)}>
                Clear all
              </button>
            )
          )}
        </div>

        <div className="drawer-body">
          {showLinks && filter === 'links' ? (
            linksLoading ? (
              <div className="drawer-empty">
                <div className="drawer-empty-sub">Loading links…</div>
              </div>
            ) : links.length === 0 ? (
              <div className="drawer-empty">
                <div className="drawer-empty-title">No short links yet</div>
                <div className="drawer-empty-sub">Open Share on a spot or replay and create a permanent link.</div>
              </div>
            ) : links.map(l => (
              <LinkRow
                key={l.code}
                link={l}
                url={linkUrl(l.code)}
                onOpen={() => onOpenLink(l.code)}
                onDelete={() => onDeleteLink(l.code)}
                onRename={(name) => onRenameLink(l.code, name)}
              />
            ))
          ) : loading ? (
            <div className="drawer-empty">
              <div className="drawer-empty-sub">Loading hand history…</div>
            </div>
          ) : error ? (
            <div className="drawer-empty">
              <div className="drawer-empty-title">Couldn't load history</div>
              <div className="drawer-empty-sub">{error}</div>
            </div>
          ) : list.length === 0 ? (
            <div className="drawer-empty">
              <div className="drawer-empty-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </div>
              <div className="drawer-empty-title">
                {filter === 'starred' ? 'No favorited hands yet' : 'No saved hands yet'}
              </div>
              <div className="drawer-empty-sub">
                {filter === 'starred'
                  ? 'Tap the star on any saved hand to keep it here.'
                  : 'Hit Favorite while analyzing to keep a hand for later.'}
              </div>
            </div>
          ) : (
            <>
              {list.map(h => (
                <HistoryRow
                  key={h.id}
                  item={h}
                  onLoad={() => onLoad(h)}
                  onToggleFavorite={() => onToggleFavorite(h.id, !h.starred)}
                  onDelete={() => onDelete(h.id)}
                />
              ))}
              {filter === 'all' && hasMore && (
                <button className="btn btn-ghost drawer-more" onClick={onLoadMore} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
