import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronRightIcon } from './icons';

export default function DisclosureGroup({
  title,
  defaultOpen = false,
  children,
  badge,
  rightElement,
  style = {},
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentRef = useRef(null);
  const [contentHeight, setContentHeight] = useState(defaultOpen ? 'auto' : 0);

  const measureHeight = useCallback(() => {
    if (contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight);
    }
  }, []);

  useEffect(() => {
    measureHeight();
  }, [children, measureHeight]);

  useEffect(() => {
    if (open && contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight);
    }
  }, [open]);

  return (
    <div
      style={{
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border)',
        background: 'var(--bg-panel)',
        overflow: 'hidden',
        ...style,
      }}
    >
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '12px 16px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--text-primary)',
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: '-0.01em',
          textAlign: 'left',
        }}
      >
        <ChevronRightIcon
          size={14}
          style={{
            transition: 'transform 0.3s var(--ease-settle)',
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            flexShrink: 0,
            color: 'var(--text-muted)',
          }}
        />
        <span style={{ flex: 1 }}>{title}</span>
        {badge && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: 'var(--radius-xs)',
              background: 'var(--accent-cyan-dim)',
              color: 'var(--accent-cyan)',
            }}
          >
            {badge}
          </span>
        )}
        {rightElement}
      </button>
      <div
        style={{
          maxHeight: open ? contentHeight : 0,
          overflow: 'hidden',
          transition: 'max-height 0.3s var(--ease-settle)',
        }}
      >
        <div ref={contentRef} style={{ padding: '0 16px 16px' }}>
          {children}
        </div>
      </div>
    </div>
  );
}
