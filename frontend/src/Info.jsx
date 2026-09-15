import React, { useId } from 'react';

// gold (i) that explains a figure on hover or keyboard focus
export function Info({ label, text }) {
  const id = useId();
  return (
    <span className="st-info">
      <button type="button" className="st-info-btn" aria-label={`How ${label} is calculated`} aria-describedby={id}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" />
        </svg>
      </button>
      <span role="tooltip" id={id} className="st-tip">{text}</span>
    </span>
  );
}
