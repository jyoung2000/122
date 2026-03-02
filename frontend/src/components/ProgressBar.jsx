import React from 'react';

export default function ProgressBar({ progress, message, variant = 'cyan' }) {
  const colorMap = { amber: 'var(--accent-amber)', green: 'var(--success)', cyan: 'var(--accent-cyan)' };
  const color = colorMap[variant] || colorMap.cyan;

  return (
    <div style={{ width: '100%' }}>
      <div
        style={{
          height: 6,
          background: 'var(--bg-elevated)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          className={progress < 100 ? 'shimmer' : ''}
          style={{
            height: '100%',
            width: `${Math.min(100, Math.max(0, progress))}%`,
            background: color,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      {message && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 4,
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{message}</span>
          <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color }}>{progress}%</span>
        </div>
      )}
    </div>
  );
}
