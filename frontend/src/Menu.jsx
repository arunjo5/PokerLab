import React, { useEffect, useRef, useState } from 'react';

// picker in the app's menu style; closes on outside click or escape.
// options: [{ value, label, count? }]
export function Menu({ value, options, onChange, label }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const current = options.find(o => o.value === value) || options[0];
  return (
    <div className="st-menu-wrap" ref={ref}>
      <button type="button" className="btn st-menu-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="st-menu-current">{current ? current.label : ''}</span>
        <span className="st-menu-caret">▾</span>
      </button>
      {open && (
        <div className="st-menu" role="listbox" aria-label={label}>
          {options.map(o => (
            <button type="button" key={o.value} role="option" aria-selected={o.value === value}
              className={'st-menu-item' + (o.value === value ? ' active' : '')}
              onClick={() => { onChange(o.value); setOpen(false); }}>
              <span className="st-menu-check">
                {o.value === value && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                )}
              </span>
              <span className="st-menu-label">{o.label}</span>
              {o.count != null && <span className="st-menu-count">{o.count}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
