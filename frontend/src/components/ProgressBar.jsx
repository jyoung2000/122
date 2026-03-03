import React, { useRef } from 'react';

export default function ProgressBar({ progress, message, variant = 'cyan' }) {
  const colorMap = { amber: 'var(--accent-amber)', green: 'var(--success)', cyan: 'var(--accent-cyan)' };
  const color = colorMap[variant] || colorMap.cyan;

  // Track peak progress to ensure monotonically increasing display.
  // This prevents the bar from jumping backward on transient state updates.
  const peakRef = useRef(0);
  const safeProgress = Math.min(100, Math.max(0, progress));
  if (safeProgress >= peakRef.current) {
    peakRef.current = safeProgress;
  }
  // Reset peak when progress drops to 0 (new task started)
  if (safeProgress === 0) {
    peakRef.current = 0;
  }
  const displayProgress = peakRef.current;

  return (
    <div style={{ width: '100%' }}>
      <div
        style={{
          height: 3,
          background: 'var(--bg-surface-2)',
          position: 'relative',
          overflow: 'hidden',
          borderRadius: 2,
        }}
      >
        <div
          className={displayProgress < 100 ? 'ai-shimmer' : ''}
          style={{
            height: '100%',
            width: `${displayProgress}%`,
            background: displayProgress < 100 ? color : 'var(--success)',
            transition: 'width 0.3s var(--ease-spring)',
            borderRadius: 2,
          }}
        />
      </div>
      {message && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 6,
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', letterSpacing: '-0.01em' }}>{message}</span>
          <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600, color }}>{displayProgress}%</span>
        </div>
      )}
    </div>
  );
}
