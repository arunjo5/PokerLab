// "Upload PokerNow Log" modal. Flow: drop file -> pick which player you are ->
// choose from the hands you were dealt into. onConfirm(selectedHands) fires on Import.
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { CardChip } from './Cards.jsx';
import { parsePokerNowLog, convertHandsFor, convertAllHands } from './pokernowImport.js';
import { parsePokerNowCsv, isPokerNowCsv } from './pokernowCsv.js';

const MAX_HANDS = 50;
const MAX_BYTES = 10 * 1024 * 1024; // generous — real logs are well under 1 MB
const ALL_PLAYERS = '__all__'; // heroId sentinel: import without filtering to one player

function UploadModal({ open, onClose, onConfirm }) {
  const [isDragging, setIsDragging] = useState(false);
  const [fileName, setFileName] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [parsed, setParsed] = useState(null);        // { exportHeroId, players, rawHands }
  const [heroId, setHeroId] = useState(null);        // the player the user picked
  const [selected, setSelected] = useState([]);      // hand numbers, in order
  const [entryError, setEntryError] = useState(null);
  const [inputValue, setInputValue] = useState('');
  const fileInputRef = useRef(null);
  const numInputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setIsDragging(false);
    setFileName(null);
    setFileError(null);
    setParsed(null);
    setHeroId(null);
    setSelected([]);
    setEntryError(null);
    setInputValue('');
  }, [open]);

  const players = parsed?.players || [];
  const hands = useMemo(() => {
    if (!parsed || heroId == null) return [];
    return heroId === ALL_PLAYERS
      ? convertAllHands(parsed.rawHands, parsed.exportHeroId)
      : convertHandsFor(parsed.rawHands, heroId);
  }, [parsed, heroId]);
  const totalHands = useMemo(
    () => (parsed
      ? parsed.rawHands.filter((h) => (!h.gameType || h.gameType === 'th') && Array.isArray(h.players) && h.players.length >= 2).length
      : 0),
    [parsed]
  );
  const isAll = heroId === ALL_PLAYERS;
  const heroPlayer = players.find((p) => p.id === heroId) || null;
  const heroLabel = isAll ? 'All players' : heroPlayer?.name;
  const phase = !parsed
    ? 'drop'
    : players.length === 0
      ? 'empty'
      : heroId == null
        ? 'player'
        : 'parsed';
  const minNum = hands.length ? Math.min(...hands.map((h) => h.number)) : 0;
  const maxNum = hands.length ? Math.max(...hands.map((h) => h.number)) : 0;
  const atCap = selected.length >= MAX_HANDS;

  const handleFile = useCallback((file) => {
    if (!file) return;
    setHeroId(null);
    setSelected([]);
    setEntryError(null);
    const name = file.name || 'log';
    const lower = name.toLowerCase();
    const known = lower.endsWith('.json') || lower.endsWith('.csv') || file.type === 'application/json' || file.type === 'text/csv';
    if (!known) {
      const ext = name.includes('.') ? name.split('.').pop().toUpperCase() : 'unknown';
      setParsed(null);
      setFileName(name);
      setFileError(`That's a .${ext} file — PokerNow logs are .json or .csv. Drop one of those instead.`);
      return;
    }
    if (file.size > MAX_BYTES) {
      setParsed(null);
      setFileName(name);
      setFileError("That file is unexpectedly large for a PokerNow log. Make sure it's a hand-log export.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      let result;
      const text = String(reader.result);
      try {
        // the .csv download and the .json export carry the same hands; a .csv
        // that fails the sniff still gets the csv reader's error, not json's
        const csv = isPokerNowCsv(text) || lower.endsWith('.csv') || file.type === 'text/csv';
        result = csv ? parsePokerNowCsv(text) : parsePokerNowLog(text);
      } catch (e) {
        setParsed(null);
        setFileName(name);
        setFileError(
          e && e.message === 'NOT_JSON'
            ? "We couldn't read that file — make sure it's an unedited PokerNow export."
            : "This doesn't look like a PokerNow log. Export the hand log from PokerNow and try again."
        );
        return;
      }
      if (!result || !Array.isArray(result.rawHands)) {
        setParsed(null);
        setFileName(name);
        setFileError("This doesn't look like a PokerNow log. Export the hand log from PokerNow and try again.");
        return;
      }
      setFileError(null);
      setFileName(name);
      setParsed(result);
    };
    reader.onerror = () => {
      setParsed(null);
      setFileName(name);
      setFileError('Could not read that file. Try again.');
    };
    reader.readAsText(file);
  }, []);

  function onDrop(e) {
    e.preventDefault();
    setIsDragging(false);
    handleFile(e.dataTransfer?.files?.[0]);
  }

  function pickPlayer(id) {
    setHeroId(id);
    setSelected([]);
    setEntryError(null);
    setInputValue('');
  }

  function backToPlayers() {
    setHeroId(null);
    setSelected([]);
    setEntryError(null);
    setInputValue('');
  }

  function processInput(raw) {
    const tokens = String(raw).split(/[^0-9]+/).filter(Boolean).map(Number);
    if (tokens.length === 0) {
      if (raw.trim()) setEntryError('Enter a hand number, e.g. ' + (hands[0]?.number ?? 1) + '.');
      return;
    }
    const working = [...selected];
    const notFound = [];
    let capHit = false;
    for (const n of tokens) {
      if (working.includes(n)) continue;
      if (working.length >= MAX_HANDS) { capHit = true; break; }
      if (!hands.some((h) => h.number === n)) { notFound.push(n); continue; }
      working.push(n);
    }
    setSelected(working);
    setInputValue('');
    if (notFound.length) {
      setEntryError(`Hand${notFound.length > 1 ? 's' : ''} ${notFound.map((x) => '#' + x).join(', ')} not in ${isAll ? 'this log' : `${heroPlayer?.name || 'this player'}'s hands`}.`);
    } else if (capHit) {
      setEntryError(`You can add up to ${MAX_HANDS} hands.`);
    } else {
      setEntryError(null);
    }
  }

  function onInputKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      processInput(inputValue);
    } else if (e.key === 'Backspace' && inputValue === '' && selected.length) {
      setSelected((s) => s.slice(0, -1));
      setEntryError(null);
    }
  }

  function removeChip(n) {
    setSelected((s) => s.filter((x) => x !== n));
    setEntryError(null);
  }

  function toggleHand(n) {
    setEntryError(null);
    setSelected((s) => {
      if (s.includes(n)) return s.filter((x) => x !== n);
      if (s.length >= MAX_HANDS) {
        setEntryError(`You can add up to ${MAX_HANDS} hands.`);
        return s;
      }
      return [...s, n];
    });
  }

  function selectAll() {
    setEntryError(null);
    // most recent first, capped, then shown low-to-high
    const nums = hands.map((h) => h.number).sort((a, b) => b - a).slice(0, MAX_HANDS).sort((a, b) => a - b);
    setSelected(nums);
    if (hands.length > MAX_HANDS) {
      setEntryError(`Added the ${MAX_HANDS} most recent of ${hands.length} hands (max ${MAX_HANDS}).`);
    }
  }

  function clearSelected() {
    setSelected([]);
    setEntryError(null);
  }

  function confirm() {
    if (!selected.length) return;
    const byNum = new Map(hands.map((h) => [h.number, h]));
    onConfirm(selected.map((n) => byNum.get(n)).filter(Boolean), { fileName });
  }

  function reset() {
    setParsed(null);
    setHeroId(null);
    setFileName(null);
    setFileError(null);
    setSelected([]);
    setEntryError(null);
    setInputValue('');
  }

  if (!open) return null;

  return (
    <div className="picker-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="share-modal upload-modal" role="dialog" aria-label="Upload PokerNow log">
        <div className="share-head">
          <div>
            <div className="auth-title">Upload PokerNow Log</div>
            <div className="auth-sub">
              Drop a PokerNow export, choose which player you are, then pick the
              hands to add to your history.
            </div>
          </div>
          <button className="modal-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="share-body">
          {phase === 'drop' && (
            <DropZone
              isDragging={isDragging}
              hasError={!!fileError}
              fileInputRef={fileInputRef}
              onPick={handleFile}
              setIsDragging={setIsDragging}
              onDrop={onDrop}
            />
          )}

          {fileError && (
            <div className="upload-error">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" /><path d="M12 8v5" /><path d="M12 16.5v.01" />
              </svg>
              <span>{fileError}</span>
            </div>
          )}

          {phase === 'empty' && (
            <>
              <div className="upload-empty">
                <div className="upload-empty-icon">
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 4h16v4H4z" /><path d="M4 10h16v10H4z" /><path d="M9 14h6" />
                  </svg>
                </div>
                <div className="upload-empty-title">No hands found in this file</div>
                <div className="upload-empty-sub">
                  We read the file fine, but it didn't contain any complete hands.
                  Make sure you exported the full hand log from PokerNow.
                </div>
              </div>
              <div className="upload-foot">
                <span className="upload-foot-info">{fileName}</span>
                <div className="upload-foot-actions">
                  <button className="btn btn-ghost" onClick={reset}>Choose another file</button>
                </div>
              </div>
            </>
          )}

          {phase === 'player' && (
            <>
              <div className="upload-found">
                <span className="check">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </span>
                <span><b>{players.length}</b> player{players.length === 1 ? '' : 's'} in this log</span>
                <button className="reset-link" onClick={reset} style={{ marginLeft: 'auto' }}>Different file</button>
              </div>

              <div className="upload-hands" style={{ marginBottom: 2 }}>
                <div className="upload-hands-scroll">
                  <button className="upload-player-row upload-player-all" onClick={() => pickPlayer(ALL_PLAYERS)}>
                    <span className="upload-player-name">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                        <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
                      </svg>
                      All hands
                    </span>
                    <span className="upload-player-count">{totalHands} hand{totalHands === 1 ? '' : 's'}</span>
                    <span className="upload-player-go" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                    </span>
                  </button>
                </div>
              </div>

              <div className="upload-label">
                <span>Or pick a player</span>
                <span className="count">just their hands</span>
              </div>
              <div className="upload-hands">
                <div className="upload-hands-scroll">
                  {players.map((p) => (
                    <PlayerRow
                      key={p.id}
                      player={p}
                      isYou={p.id === parsed.exportHeroId}
                      onPick={() => pickPlayer(p.id)}
                    />
                  ))}
                </div>
              </div>

              <div className="upload-foot">
                <span className="upload-foot-info">Pick yourself for just your hands, or add from the whole log</span>
                <div className="upload-foot-actions">
                  <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
                </div>
              </div>
            </>
          )}

          {phase === 'parsed' && (
            <>
              <div className="upload-found">
                <span className="check">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </span>
                <span><b>{heroLabel}</b> · {hands.length} hand{hands.length === 1 ? '' : 's'}</span>
                {hands.length > 0 && <span className="range">#{minNum}–#{maxNum}</span>}
                <button className="reset-link" onClick={backToPlayers}>Change</button>
              </div>

              <div className="upload-label">
                <span>Hands to import</span>
                <span className={'count' + (atCap ? ' at-cap' : '')}>{selected.length} / {MAX_HANDS}</span>
              </div>

              <div className={'upload-entry' + (atCap ? ' is-full' : '')} onClick={() => numInputRef.current?.focus()}>
                {selected.map((n) => (
                  <span className="upload-chip" key={n}>
                    #{n}
                    <button className="chip-x" onClick={(e) => { e.stopPropagation(); removeChip(n); }} aria-label={`Remove hand ${n}`}>×</button>
                  </span>
                ))}
                <input
                  ref={numInputRef}
                  className="upload-chip-input"
                  type="text"
                  inputMode="numeric"
                  value={inputValue}
                  disabled={atCap}
                  placeholder={
                    selected.length === 0
                      ? 'Type a hand number, e.g. 183, 80'
                      : atCap ? `Maximum ${MAX_HANDS} reached` : 'Add another…'
                  }
                  onChange={(e) => setInputValue(e.target.value.replace(/[^0-9, ]/g, ''))}
                  onKeyDown={onInputKeyDown}
                  onBlur={() => inputValue.trim() && processInput(inputValue)}
                />
              </div>

              {entryError ? (
                <div className="upload-error">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" /><path d="M12 8v5" /><path d="M12 16.5v.01" />
                  </svg>
                  <span>{entryError}</span>
                </div>
              ) : (
                <div className="upload-hint">
                  Press Enter or comma to add. Don't remember the number? Find it in the list below.
                </div>
              )}

              <div className="upload-label" style={{ marginTop: 2 }}>
                <span>{isAll ? 'All hands in this log' : `All of ${heroPlayer?.name}'s hands`}</span>
                <span className="upload-bulk">
                  <button className="reset-link" onClick={selectAll}>Select all</button>
                  {selected.length > 0 && <button className="reset-link" onClick={clearSelected}>Clear</button>}
                </span>
              </div>
              <div className="upload-hands">
                <div className="upload-hands-scroll">
                  {hands.map((h) => (
                    <HandRow
                      key={h.number}
                      hand={h}
                      selected={selected.includes(h.number)}
                      disabled={atCap && !selected.includes(h.number)}
                      onToggle={() => toggleHand(h.number)}
                    />
                  ))}
                </div>
              </div>

              <div className="upload-foot">
                <span className="upload-foot-info"><b>{selected.length}</b> selected</span>
                <div className="upload-foot-actions">
                  <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
                  <button className="btn btn-primary" disabled={!selected.length} onClick={confirm}>
                    {selected.length
                      ? `Import ${selected.length} hand${selected.length === 1 ? '' : 's'}`
                      : 'Import hands'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DropZone({ isDragging, hasError, fileInputRef, onPick, setIsDragging, onDrop }) {
  return (
    <div
      className={'upload-dropzone' + (isDragging ? ' is-dragging' : '') + (hasError ? ' has-error' : '')}
      onClick={() => fileInputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
      onDrop={onDrop}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
    >
      <div className="upload-drop-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 16V4" /><path d="M7 9l5-5 5 5" />
          <path d="M5 16v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
        </svg>
      </div>
      <div className="upload-drop-title">
        {isDragging ? 'Drop to upload' : <>Drag a log here or <span className="accent">browse</span></>}
      </div>
      <div className="upload-drop-sub">
        <span className="mono">.json</span> or <span className="mono">.csv</span>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.csv,application/json,text/csv"
        style={{ display: 'none' }}
        onChange={(e) => { onPick(e.target.files?.[0]); e.target.value = ''; }}
      />
    </div>
  );
}

function PlayerRow({ player, isYou, onPick }) {
  return (
    <button className="upload-player-row" onClick={onPick}>
      <span className="upload-player-name">
        {player.name}
        {isYou && <span className="upload-player-you">you</span>}
      </span>
      <span className="upload-player-count">{player.count} hand{player.count === 1 ? '' : 's'}</span>
      <span className="upload-player-go" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </span>
    </button>
  );
}

function HandRow({ hand, selected, disabled, onToggle }) {
  const { summary } = hand;
  const players = summary.players || [];
  const shown = players.slice(0, 3).join(', ');
  const extra = players.length > 3 ? ` +${players.length - 3}` : '';
  return (
    <button
      className={'upload-hand-row' + (selected ? ' selected' : '')}
      onClick={onToggle}
      style={disabled ? { opacity: 0.45 } : null}
    >
      <span className="upload-hand-num">#{hand.number}</span>
      <span className="upload-hand-meta">
        <span className="upload-hand-players">
          <span className="stakes">{summary.stakes}</span> · {players.length} players · {shown}{extra}
        </span>
        <span className="upload-hand-board">
          {summary.board && summary.board.length
            ? summary.board.map((c, i) => <CardChip key={i} card={c} />)
            : <span className="preflop">Pre-flop</span>}
        </span>
      </span>
      <span className="upload-hand-check">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </span>
    </button>
  );
}

export { UploadModal };
