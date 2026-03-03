import React, { useState, useEffect, useRef } from 'react';

export default function ScoreRing({ score = 0, size = 40, strokeWidth = 3.5 }) {
  const [animatedScore, setAnimatedScore] = useState(0);
  const [mounted, setMounted] = useState(false);
  const rafRef = useRef(null);

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.min(Math.max(animatedScore, 0), 100) / 100;
  const offset = circumference * (1 - progress);

  // Color based on score range
  const color = score >= 91 ? 'var(--viral-high)'
    : score >= 71 ? 'var(--viral-high)'
    : score >= 41 ? 'var(--viral-mid)'
    : 'var(--viral-low)';

  // Animate on mount
  useEffect(() => {
    setMounted(true);
    const start = performance.now();
    const duration = 800;
    const animate = (now) => {
      const elapsed = now - start;
      const t = Math.min(elapsed / duration, 1);
      // Ease-in-out cubic
      const eased = t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
      setAnimatedScore(Math.round(eased * score));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [score]);

  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg
        width={size}
        height={size}
        style={{
          transform: 'rotate(-90deg)',
          ...(score >= 91 && mounted ? {
            animation: 'scoreGlow 2s ease-in-out infinite',
          } : {}),
        }}
      >
        {/* Background track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--bg-surface-3)"
          strokeWidth={strokeWidth}
        />
        {/* Progress arc */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{
            transition: 'stroke-dashoffset 0.1s linear',
          }}
        />
      </svg>
      {/* Score number in center */}
      <span
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: size * 0.28,
          fontWeight: 700,
          fontFamily: 'var(--font-mono)',
          color: color,
          letterSpacing: '-0.02em',
        }}
      >
        {animatedScore}
      </span>
    </div>
  );
}
