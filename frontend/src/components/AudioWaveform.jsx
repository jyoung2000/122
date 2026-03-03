import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';

/**
 * Canvas-based audio waveform visualization.
 * Attempts real audio decoding via Web Audio API.
 * Falls back to a procedural waveform if decoding fails.
 */
export default function AudioWaveform({
  videoSrc,
  currentTime = 0,
  duration = 0,
  onSeek,
  clipRegions = [],
  speakerSegments = [],
  height = 48,
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [peaks, setPeaks] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [hoverX, setHoverX] = useState(null);
  const [canvasWidth, setCanvasWidth] = useState(0);

  // Generate procedural waveform (fallback)
  const generateProceduralPeaks = useCallback((numBars) => {
    const data = new Float32Array(numBars);
    // Use a mix of sine waves + noise for realistic look
    for (let i = 0; i < numBars; i++) {
      const t = i / numBars;
      const base = 0.3 + 0.2 * Math.sin(t * Math.PI * 2.7)
        + 0.15 * Math.sin(t * Math.PI * 7.3)
        + 0.1 * Math.sin(t * Math.PI * 13.1);
      const noise = (Math.random() - 0.5) * 0.3;
      data[i] = Math.min(1, Math.max(0.05, base + noise));
    }
    return data;
  }, []);

  // Try to decode real audio peaks
  useEffect(() => {
    if (!videoSrc || !duration) return;
    let cancelled = false;

    const decodeAudio = async () => {
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) throw new Error('No AudioContext');

        const ctx = new AudioContext();
        const response = await fetch(videoSrc);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

        if (cancelled) { ctx.close(); return; }

        const channelData = audioBuffer.getChannelData(0);
        const numBars = Math.min(800, Math.max(200, Math.floor(duration * 10)));
        const samplesPerBar = Math.floor(channelData.length / numBars);
        const data = new Float32Array(numBars);

        for (let i = 0; i < numBars; i++) {
          let sum = 0;
          const start = i * samplesPerBar;
          for (let j = start; j < start + samplesPerBar && j < channelData.length; j++) {
            sum += Math.abs(channelData[j]);
          }
          data[i] = sum / samplesPerBar;
        }

        // Normalize to 0-1
        const max = Math.max(...data) || 1;
        for (let i = 0; i < numBars; i++) {
          data[i] = data[i] / max;
        }

        if (!cancelled) setPeaks(data);
        ctx.close();
      } catch {
        // Fallback to procedural
        if (!cancelled) {
          const numBars = Math.min(400, Math.max(100, Math.floor(duration * 5)));
          setPeaks(generateProceduralPeaks(numBars));
        }
      }
    };

    decodeAudio();
    return () => { cancelled = true; };
  }, [videoSrc, duration, generateProceduralPeaks]);

  // Observe container width
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCanvasWidth(entry.contentRect.width);
      }
    });
    obs.observe(containerRef.current);
    setCanvasWidth(containerRef.current.offsetWidth);
    return () => obs.disconnect();
  }, []);

  // Speaker segment colors
  const SPEAKER_COLORS = useMemo(() => [
    '#0A84FF', '#FF9F0A', '#30D158', '#FF453A', '#BF5AF2',
    '#5AC8FA', '#FFD60A', '#FF6482', '#64D2FF', '#AC8E68',
  ], []);

  // Draw waveform
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks || !canvasWidth || !duration) return;

    const dpr = window.devicePixelRatio || 1;
    const speakerLaneH = speakerSegments.length > 0 ? 4 : 0;
    const waveH = height - speakerLaneH;

    canvas.width = canvasWidth * dpr;
    canvas.height = height * dpr;
    canvas.style.width = canvasWidth + 'px';
    canvas.style.height = height + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, canvasWidth, height);

    // Background
    ctx.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue('--waveform-bg').trim() || 'rgba(0,0,0,0.06)';
    ctx.fillRect(0, 0, canvasWidth, waveH);

    // AI clip region highlights
    for (const region of clipRegions) {
      const x1 = (region.start / duration) * canvasWidth;
      const x2 = (region.end / duration) * canvasWidth;
      ctx.fillStyle = getComputedStyle(document.documentElement)
        .getPropertyValue('--track-ai-region').trim() || 'rgba(191,90,242,0.15)';
      ctx.fillRect(x1, 0, x2 - x1, waveH);
      // Borders
      ctx.fillStyle = getComputedStyle(document.documentElement)
        .getPropertyValue('--track-ai-border').trim() || 'rgba(191,90,242,0.4)';
      ctx.fillRect(x1, 0, 1.5, waveH);
      ctx.fillRect(x2 - 1.5, 0, 1.5, waveH);
    }

    // Waveform bars
    const barWidth = canvasWidth / peaks.length;
    const audioColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--waveform-audio').trim() || '#30D158';

    for (let i = 0; i < peaks.length; i++) {
      const x = i * barWidth;
      const barH = peaks[i] * waveH * 0.85;
      const y = (waveH - barH) / 2;

      // Color: dimmer before playhead, brighter after
      const barTime = (i / peaks.length) * duration;
      if (barTime <= currentTime) {
        ctx.fillStyle = audioColor;
        ctx.globalAlpha = 0.8;
      } else {
        ctx.fillStyle = audioColor;
        ctx.globalAlpha = 0.35;
      }

      // Draw bar with slight gap
      const gap = barWidth > 3 ? 1 : 0.5;
      ctx.fillRect(x, y, Math.max(barWidth - gap, 0.5), barH);
    }
    ctx.globalAlpha = 1;

    // Playhead line
    if (duration > 0) {
      const px = (currentTime / duration) * canvasWidth;
      ctx.fillStyle = '#fff';
      ctx.fillRect(px - 0.75, 0, 1.5, waveH);
      // Small dot on top
      ctx.beginPath();
      ctx.arc(px, 0, 3, 0, Math.PI * 2);
      ctx.fillStyle = 'var(--accent-cyan)';
      ctx.fill();
    }

    // Hover timestamp indicator
    if (hoverX !== null) {
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.fillRect(hoverX - 0.5, 0, 1, waveH);
    }

    // Speaker color lane
    if (speakerSegments.length > 0) {
      const laneY = waveH;
      const speakerMap = {};
      let speakerIdx = 0;
      for (const seg of speakerSegments) {
        if (!(seg.speaker in speakerMap)) {
          speakerMap[seg.speaker] = SPEAKER_COLORS[speakerIdx % SPEAKER_COLORS.length];
          speakerIdx++;
        }
        const x1 = (seg.start / duration) * canvasWidth;
        const x2 = (seg.end / duration) * canvasWidth;
        ctx.fillStyle = speakerMap[seg.speaker];
        ctx.globalAlpha = 0.7;
        ctx.fillRect(x1, laneY, x2 - x1, speakerLaneH);
      }
      ctx.globalAlpha = 1;
    }
  }, [peaks, currentTime, duration, canvasWidth, height, clipRegions, speakerSegments, hoverX, SPEAKER_COLORS]);

  // Seek on click/drag
  const handlePointerDown = useCallback((e) => {
    if (!duration || !containerRef.current) return;
    setDragging(true);
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = (x / rect.width) * duration;
    onSeek?.(Math.max(0, Math.min(duration, time)));
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [duration, onSeek]);

  const handlePointerMove = useCallback((e) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setHoverX(Math.max(0, Math.min(rect.width, x)));
    if (dragging && duration) {
      const time = (x / rect.width) * duration;
      onSeek?.(Math.max(0, Math.min(duration, time)));
    }
  }, [dragging, duration, onSeek]);

  const handlePointerUp = useCallback(() => {
    setDragging(false);
  }, []);

  const handlePointerLeave = useCallback(() => {
    setHoverX(null);
    setDragging(false);
  }, []);

  // Hover tooltip time
  const hoverTime = useMemo(() => {
    if (hoverX === null || !canvasWidth || !duration) return null;
    const t = (hoverX / canvasWidth) * duration;
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }, [hoverX, canvasWidth, duration]);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        height,
        cursor: 'pointer',
        borderRadius: 'var(--radius-xs)',
        overflow: 'hidden',
        userSelect: 'none',
        touchAction: 'none',
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    >
      <canvas ref={canvasRef} style={{ display: 'block' }} />
      {/* Hover timestamp tooltip */}
      {hoverTime && hoverX !== null && (
        <div
          style={{
            position: 'absolute',
            top: -24,
            left: hoverX,
            transform: 'translateX(-50%)',
            padding: '2px 6px',
            background: 'var(--glass-bg)',
            backdropFilter: 'blur(8px)',
            border: '1px solid var(--glass-border)',
            borderRadius: 'var(--radius-xs)',
            fontSize: 10,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-secondary)',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {hoverTime}
        </div>
      )}
    </div>
  );
}
