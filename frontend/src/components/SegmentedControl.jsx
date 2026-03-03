import React, { useRef, useState, useEffect, useCallback } from 'react';

export default function SegmentedControl({ options, value, onChange, style = {} }) {
  const containerRef = useRef(null);
  const [highlight, setHighlight] = useState({ left: 0, width: 0 });

  const updateHighlight = useCallback(() => {
    if (!containerRef.current) return;
    const idx = options.findIndex(o => o.value === value);
    if (idx < 0) return;
    const buttons = containerRef.current.querySelectorAll('[data-seg-btn]');
    const btn = buttons[idx];
    if (!btn) return;
    const containerRect = containerRef.current.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    setHighlight({
      left: btnRect.left - containerRect.left,
      width: btnRect.width,
    });
  }, [options, value]);

  useEffect(() => {
    updateHighlight();
    window.addEventListener('resize', updateHighlight);
    return () => window.removeEventListener('resize', updateHighlight);
  }, [updateHighlight]);

  return (
    <div
      ref={containerRef}
      style={{
        display: 'inline-flex',
        position: 'relative',
        background: 'var(--bg-surface-2)',
        borderRadius: 'var(--radius-sm)',
        padding: 2,
        gap: 0,
        ...style,
      }}
    >
      {/* Sliding highlight */}
      <div
        style={{
          position: 'absolute',
          top: 2,
          bottom: 2,
          left: highlight.left,
          width: highlight.width,
          background: 'var(--bg-elevated)',
          borderRadius: 'calc(var(--radius-sm) - 1px)',
          boxShadow: 'var(--shadow-sm)',
          transition: 'left 0.25s var(--ease-spring), width 0.25s var(--ease-spring)',
          zIndex: 0,
        }}
      />
      {options.map((opt) => (
        <button
          key={opt.value}
          data-seg-btn=""
          onClick={() => onChange(opt.value)}
          style={{
            position: 'relative',
            zIndex: 1,
            padding: '6px 14px',
            fontSize: 12,
            fontWeight: opt.value === value ? 600 : 400,
            color: opt.value === value ? 'var(--text-primary)' : 'var(--text-secondary)',
            background: 'none',
            border: 'none',
            borderRadius: 'calc(var(--radius-sm) - 1px)',
            cursor: 'pointer',
            transition: 'color 0.2s ease',
            whiteSpace: 'nowrap',
            letterSpacing: '-0.01em',
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
