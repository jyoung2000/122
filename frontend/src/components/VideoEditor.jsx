import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { processKeyframes, interpolateSubjectX, isDynamic, safeSubjectX } from '../utils/subjectTracking';
import useResponsive from '../hooks/useResponsive';
import './VideoEditor.css';

// ── Constants ────────────────────────────────────────────────────────────────
const ASPECT_RATIO_VALUES = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1.0,
  '4:5': 4 / 5,
};

const SPEED_PRESETS = [
  { value: 0.25, label: '' },
  { value: 0.5, label: '' },
  { value: 0.75, label: '' },
  { value: 1.0, label: 'Normal' },
  { value: 1.25, label: '' },
  { value: 1.5, label: '' },
  { value: 2.0, label: '' },
  { value: 4.0, label: '' },
];

// ── SVG Icons (Apple SF Symbols aesthetic) ────────────────────────────────────
const Icon = {
  Play: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <path d="M6.5 4.1c-.9-.5-2 .1-2 1.2v13.4c0 1.1 1.1 1.7 2 1.2l11.6-6.7c.9-.5.9-1.8 0-2.4L6.5 4.1z" />
    </svg>
  ),
  Pause: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <rect x="5" y="3" width="5" height="18" rx="1.5" />
      <rect x="14" y="3" width="5" height="18" rx="1.5" />
    </svg>
  ),
  SkipBack: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 19 2 12 11 5 11 19" fill="currentColor" stroke="none" />
      <line x1="22" y1="5" x2="22" y2="19" />
      <text x="18" y="22" fontSize="8" fill="currentColor" stroke="none" fontFamily="var(--font-mono, monospace)">5</text>
    </svg>
  ),
  SkipForward: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 19 22 12 13 5 13 19" fill="currentColor" stroke="none" />
      <line x1="2" y1="5" x2="2" y2="19" />
      <text x="3" y="22" fontSize="8" fill="currentColor" stroke="none" fontFamily="var(--font-mono, monospace)">5</text>
    </svg>
  ),
  VolumeMuted: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor" opacity="0.5" stroke="none" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  ),
  VolumeLow: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor" opacity="0.5" stroke="none" />
      <path d="M15.54 8.46a5 5 0 010 7.07" />
    </svg>
  ),
  VolumeMed: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor" opacity="0.5" stroke="none" />
      <path d="M15.54 8.46a5 5 0 010 7.07" />
      <path d="M19.07 4.93a10 10 0 010 14.14" />
    </svg>
  ),
  VolumeHigh: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor" opacity="0.5" stroke="none" />
      <path d="M15.54 8.46a5 5 0 010 7.07" />
      <path d="M19.07 4.93a10 10 0 010 14.14" />
    </svg>
  ),
  Fullscreen: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3H5a2 2 0 00-2 2v3" />
      <path d="M21 8V5a2 2 0 00-2-2h-3" />
      <path d="M3 16v3a2 2 0 002 2h3" />
      <path d="M16 21h3a2 2 0 002-2v-3" />
    </svg>
  ),
  ExitFullscreen: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 14h4v4" />
      <path d="M20 10h-4V6" />
      <path d="M14 10l7-7" />
      <path d="M3 21l7-7" />
    </svg>
  ),
  Close: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function subjectXToCenterPct(sx, srcRatio, targetRatio) {
  const R = srcRatio / targetRatio;
  if (R <= 1.01) return Math.max(0, Math.min(100, sx));
  const pct = (R * sx - 50) / (R - 1);
  return Math.max(0, Math.min(100, pct));
}

function formatTimecode(seconds) {
  if (!seconds || isNaN(seconds) || seconds < 0) return '0:00.00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

function formatTimeShort(seconds) {
  if (!seconds || isNaN(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Component ────────────────────────────────────────────────────────────────
export default function VideoEditor({
  src,
  clipStart = 0,
  clipEnd = 0,
  onTimeUpdate,
  onTrimChange,
  onVolumeChange,
  onSpeedChange,
  aspectRatio,
  sourceWidth = 1920,
  sourceHeight = 1080,
  subjectX = 50,
  scenes,
  initialTime,
  initialVolume,
  initialSpeed,
  title,
  onClose,
  subtitleOverlay,
  compact = false,
}) {
  const { isMobile } = useResponsive();
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const timelineRef = useRef(null);
  const waveformCanvasRef = useRef(null);
  const waveformDataRef = useRef(null);
  const audioCtxRef = useRef(null);
  const gainNodeRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const animFrameRef = useRef(null);
  const thumbnailCanvasRef = useRef(null);
  const thumbnailsRef = useRef([]);

  // ── State ──────────────────────────────────────────
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(clipStart);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showTimecodeRemaining, setShowTimecodeRemaining] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [videoError, setVideoError] = useState(false);

  // Volume: 0-200 (percentage)
  const [volume, setVolume] = useState(100);
  const [prevVolume, setPrevVolume] = useState(100);
  const [isMuted, setIsMuted] = useState(false);

  // Speed
  const [speed, setSpeed] = useState(1.0);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);

  // Trim: offsets from clipStart/clipEnd
  const [trimStartOffset, setTrimStartOffset] = useState(0);
  const [trimEndOffset, setTrimEndOffset] = useState(0);
  const [draggingHandle, setDraggingHandle] = useState(null); // 'left' | 'right' | null
  const [draggingPlayhead, setDraggingPlayhead] = useState(false);
  const [trimApplied, setTrimApplied] = useState(false);
  const [videoDuration, setVideoDuration] = useState(0);

  // Derived — use video's natural duration as fallback when clipEnd is 0
  const effectiveClipEnd = clipEnd > clipStart ? clipEnd : (videoDuration || clipEnd);
  const clipDur = effectiveClipEnd - clipStart;
  const trimmedStart = clipStart + trimStartOffset;
  const trimmedEnd = effectiveClipEnd - trimEndOffset;
  const trimmedDur = trimmedEnd - trimmedStart;
  const elapsed = Math.max(0, Math.min(trimmedDur, currentTime - trimmedStart));

  // ── Aspect ratio & subject tracking ─────────────────
  const srcRatio = sourceWidth / sourceHeight;
  const targetRatio = useMemo(() => {
    if (aspectRatio && ASPECT_RATIO_VALUES[aspectRatio]) return ASPECT_RATIO_VALUES[aspectRatio];
    return srcRatio;
  }, [aspectRatio, srcRatio]);

  const isCrop = useMemo(() => {
    if (!aspectRatio || !ASPECT_RATIO_VALUES[aspectRatio]) return false;
    return Math.abs(srcRatio - ASPECT_RATIO_VALUES[aspectRatio]) > 0.01;
  }, [aspectRatio, srcRatio]);

  const subjectKeyframes = useMemo(() => {
    if (!scenes?.length || clipStart == null || clipEnd == null) return null;
    return processKeyframes(scenes, clipStart, clipEnd);
  }, [scenes, clipStart, clipEnd]);

  const hasDynamicSubject = useMemo(
    () => isCrop && subjectKeyframes && isDynamic(subjectKeyframes),
    [isCrop, subjectKeyframes],
  );

  // ── Reset on new clip ──────────────────────────────
  useEffect(() => {
    const vol = (initialVolume != null && initialVolume >= 0) ? initialVolume : 100;
    const spd = (initialSpeed != null && initialSpeed > 0) ? initialSpeed : 1.0;
    setTrimStartOffset(0);
    setTrimEndOffset(0);
    setVolume(vol);
    setPrevVolume(vol);
    setIsMuted(false);
    setSpeed(spd);
    setShowSpeedMenu(false);
    setVideoError(false);
    if (videoRef.current) {
      videoRef.current.playbackRate = spd;
    }
    onTrimChange?.({ trimStart: 0, trimEnd: 0 });
    onVolumeChange?.(vol / 100);
    onSpeedChange?.(spd);
  }, [clipStart, clipEnd, src]);

  // ── Sync volume/speed from settings panel ──────────
  useEffect(() => {
    if (initialVolume == null || initialVolume < 0) return;
    setVolume(initialVolume);
    setPrevVolume(initialVolume);
    if (initialVolume === 0) setIsMuted(true);
    else setIsMuted(false);
  }, [initialVolume]);

  useEffect(() => {
    if (initialSpeed == null || initialSpeed <= 0) return;
    setSpeed(initialSpeed);
    if (videoRef.current) {
      videoRef.current.playbackRate = initialSpeed;
    }
  }, [initialSpeed]);

  // ── Video metadata & error ─────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onReady = () => {
      setVideoReady(true);
      if (video.duration && isFinite(video.duration)) {
        setVideoDuration(video.duration);
      }
    };
    const onError = () => setVideoError(true);
    const onDuration = () => {
      if (video.duration && isFinite(video.duration)) {
        setVideoDuration(video.duration);
      }
    };
    video.addEventListener('loadedmetadata', onReady);
    video.addEventListener('durationchange', onDuration);
    video.addEventListener('error', onError);
    if (video.readyState >= 1) {
      setVideoReady(true);
      if (video.duration && isFinite(video.duration)) {
        setVideoDuration(video.duration);
      }
    }
    return () => {
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('durationchange', onDuration);
      video.removeEventListener('error', onError);
    };
  }, [src]);

  // ── Auto-seek and auto-play on clip change ─────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || clipStart === undefined || clipStart === null) return;
    video.currentTime = clipStart;
    setCurrentTime(clipStart);
    video.play().then(() => setPlaying(true)).catch(() => {});
  }, [clipStart, clipEnd]);

  // ── Fullscreen tracking ────────────────────────────
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // ── Waveform generation ────────────────────────────
  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    const generateWaveform = async () => {
      try {
        const response = await fetch(src);
        if (cancelled) return;
        const arrayBuffer = await response.arrayBuffer();
        if (cancelled) return;
        const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
        const audioBuffer = await offlineCtx.decodeAudioData(arrayBuffer);
        if (cancelled) return;
        const rawData = audioBuffer.getChannelData(0);
        // Downsample to ~200 bars
        const barCount = 200;
        const samplesPerBar = Math.floor(rawData.length / barCount);
        const bars = [];
        for (let i = 0; i < barCount; i++) {
          let sum = 0;
          const start = i * samplesPerBar;
          for (let j = start; j < start + samplesPerBar && j < rawData.length; j++) {
            sum += Math.abs(rawData[j]);
          }
          bars.push(sum / samplesPerBar);
        }
        // Normalize
        const max = Math.max(...bars, 0.01);
        waveformDataRef.current = bars.map(v => v / max);
        drawWaveform();
      } catch {
        // Waveform is optional - silently fail
      }
    };
    generateWaveform();
    return () => { cancelled = true; };
  }, [src]);

  // Draw waveform on canvas
  const drawWaveform = useCallback(() => {
    const canvas = waveformCanvasRef.current;
    const data = waveformDataRef.current;
    if (!canvas || !data) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    // Semi-transparent backdrop to dim thumbnails and make bars visible
    const isDark = document.documentElement.dataset.theme === 'dark';
    ctx.fillStyle = isDark ? 'rgba(0, 0, 0, 0.50)' : 'rgba(0, 0, 0, 0.30)';
    ctx.fillRect(0, 0, rect.width, rect.height);

    const barWidth = rect.width / data.length;
    const midY = rect.height / 2;

    for (let i = 0; i < data.length; i++) {
      const x = i * barWidth;
      const barH = Math.max(1, data[i] * midY * 0.9);
      // Color based on trim region
      const pct = i / data.length;
      const leftPct = trimStartOffset / (clipDur || 1);
      const rightPct = 1 - trimEndOffset / (clipDur || 1);
      const playPct = clipDur > 0 ? (currentTime - clipStart) / clipDur : 0;

      if (pct < leftPct || pct > rightPct) {
        ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.12)';
      } else if (pct <= playPct) {
        ctx.fillStyle = 'rgba(10, 132, 255, 0.85)';
      } else {
        ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.55)' : 'rgba(60, 60, 60, 0.55)';
      }
      ctx.fillRect(x, midY - barH, barWidth - 0.5, barH * 2);
    }
  }, [trimStartOffset, trimEndOffset, clipDur, currentTime, clipStart]);

  // Redraw waveform when state changes
  useEffect(() => {
    drawWaveform();
  }, [drawWaveform]);

  // Redraw waveform on resize
  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => drawWaveform());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [drawWaveform]);

  // ── Keyframe thumbnail generation ─────────────────
  const drawThumbnails = useCallback(() => {
    const canvas = thumbnailCanvasRef.current;
    const thumbs = thumbnailsRef.current;
    if (!canvas || !thumbs.length) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const sw = rect.width / thumbs.length;
    thumbs.forEach((thumb, i) => {
      if (thumb) {
        try { ctx.drawImage(thumb, i * sw, 0, sw, rect.height); } catch {}
      }
    });
  }, []);

  useEffect(() => {
    if (!src || !videoReady || clipDur <= 0) return;
    let cancelled = false;
    const generate = async () => {
      try {
        const tv = document.createElement('video');
        tv.muted = true;
        tv.preload = 'auto';
        tv.src = src;
        await new Promise((resolve, reject) => {
          tv.onloadeddata = resolve;
          tv.onerror = () => reject();
          setTimeout(() => reject(), 15000);
        });
        if (cancelled) { tv.src = ''; return; }
        const NUM = 15;
        const vw = tv.videoWidth || 320;
        const vh = tv.videoHeight || 180;
        const tH = 60;
        const tW = Math.round(tH * (vw / vh));
        const canvases = [];
        for (let i = 0; i < NUM; i++) {
          if (cancelled) break;
          const time = clipStart + ((i + 0.5) / NUM) * clipDur;
          tv.currentTime = Math.min(time, (tv.duration || time) - 0.05);
          await new Promise(r => { tv.onseeked = r; setTimeout(r, 3000); });
          if (cancelled) break;
          try {
            const c = document.createElement('canvas');
            c.width = tW; c.height = tH;
            c.getContext('2d').drawImage(tv, 0, 0, tW, tH);
            canvases.push(c);
          } catch { canvases.push(null); }
        }
        tv.src = ''; tv.load();
        if (!cancelled && canvases.some(Boolean)) {
          thumbnailsRef.current = canvases;
          drawThumbnails();
        }
      } catch { /* thumbnails are optional */ }
    };
    generate();
    return () => { cancelled = true; thumbnailsRef.current = []; };
  }, [src, videoReady, clipStart, clipDur, drawThumbnails]);

  // Redraw thumbnails on resize
  useEffect(() => {
    const canvas = thumbnailCanvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => drawThumbnails());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [drawThumbnails]);

  // ── Playback time tracking via rAF ─────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let rafId;
    const tick = () => {
      const t = video.currentTime;
      setCurrentTime(t);
      onTimeUpdate?.(t);
      // Auto-stop at trimmed end
      if (trimmedEnd && t >= trimmedEnd) {
        video.pause();
        setPlaying(false);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [trimmedEnd, onTimeUpdate]);

  // ── Dynamic subject tracking via rAF ───────────────
  useEffect(() => {
    if (!hasDynamicSubject) return;
    const video = videoRef.current;
    if (!video) return;
    let animId;
    let lastPct = null;
    const tick = () => {
      const relTime = video.currentTime - (clipStart || 0);
      const sx = interpolateSubjectX(subjectKeyframes, relTime);
      const centerPct = subjectXToCenterPct(sx, srcRatio, targetRatio);
      const rounded = Math.round(centerPct * 100) / 100;
      if (rounded !== lastPct) {
        video.style.objectPosition = `${centerPct}% 50%`;
        lastPct = rounded;
      }
      animId = requestAnimationFrame(tick);
    };
    animId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(animId);
      video.style.objectPosition = '';
    };
  }, [hasDynamicSubject, subjectKeyframes, clipStart, srcRatio, targetRatio]);

  // Static subject tracking fallback
  useEffect(() => {
    if (hasDynamicSubject || !isCrop) return;
    const video = videoRef.current;
    if (!video) return;
    const sx = safeSubjectX ? safeSubjectX(subjectX) : subjectX;
    const centerPct = subjectXToCenterPct(Math.max(0, Math.min(100, sx)), srcRatio, targetRatio);
    video.style.objectPosition = `${centerPct}% 50%`;
  }, [hasDynamicSubject, isCrop, subjectX, srcRatio, targetRatio]);

  // ── Web Audio API for volume > 100% ────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Only set up Web Audio if not already done
    if (!audioCtxRef.current) {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const source = ctx.createMediaElementSource(video);
        const gain = ctx.createGain();
        source.connect(gain);
        gain.connect(ctx.destination);
        audioCtxRef.current = ctx;
        sourceNodeRef.current = source;
        gainNodeRef.current = gain;
      } catch (e) {
        // Fallback: no Web Audio, cap at 100%
        console.warn('[VideoEditor] Web Audio API not available:', e);
      }
    }

    return () => {
      // Don't disconnect on every render; only on true unmount handled below
    };
  }, [src]);

  // Cleanup Web Audio on unmount
  useEffect(() => {
    return () => {
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
        sourceNodeRef.current = null;
        gainNodeRef.current = null;
      }
    };
  }, []);

  // ── Apply volume changes ───────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const effectiveVol = isMuted ? 0 : volume;
    if (gainNodeRef.current) {
      // Web Audio path: set GainNode, video.volume = 1
      video.volume = 1;
      gainNodeRef.current.gain.value = effectiveVol / 100;
      // Resume AudioContext if suspended (autoplay policy)
      if (audioCtxRef.current?.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
      }
    } else {
      // Fallback path: native volume 0-1
      video.volume = Math.min(1, effectiveVol / 100);
    }
    onVolumeChange?.(effectiveVol / 100);
  }, [volume, isMuted, onVolumeChange]);

  // ── Apply speed changes ────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = speed;
    onSpeedChange?.(speed);
  }, [speed, onSpeedChange]);

  // ── Trim change callback ───────────────────────────
  useEffect(() => {
    onTrimChange?.({ trimStart: trimStartOffset, trimEnd: trimEndOffset });
  }, [trimStartOffset, trimEndOffset, onTrimChange]);

  // ── Keyboard shortcuts ─────────────────────────────
  useEffect(() => {
    const onKeyDown = (e) => {
      // Don't capture keys when typing in inputs
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          skipTime(e.shiftKey ? -1 : -1 / 30);
          break;
        case 'ArrowRight':
          e.preventDefault();
          skipTime(e.shiftKey ? 1 : 1 / 30);
          break;
        case 'KeyJ':
          e.preventDefault();
          skipTime(-5);
          break;
        case 'KeyL':
          e.preventDefault();
          skipTime(5);
          break;
        case 'Home':
          e.preventDefault();
          seekTo(trimmedStart);
          break;
        case 'End':
          e.preventDefault();
          seekTo(trimmedEnd);
          break;
        case 'KeyM':
          e.preventDefault();
          toggleMute();
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [trimmedStart, trimmedEnd, playing, isMuted, volume]);

  // ── Player controls ────────────────────────────────
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    // Resume AudioContext if needed
    if (audioCtxRef.current?.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {});
    }
    if (video.paused) {
      if (video.currentTime >= trimmedEnd) video.currentTime = trimmedStart;
      video.play().then(() => setPlaying(true)).catch(() => {});
    } else {
      video.pause();
      setPlaying(false);
    }
  }, [trimmedStart, trimmedEnd]);

  const seekTo = useCallback((time) => {
    const video = videoRef.current;
    if (!video) return;
    const clamped = Math.max(trimmedStart, Math.min(trimmedEnd, time));
    video.currentTime = clamped;
    setCurrentTime(clamped);
  }, [trimmedStart, trimmedEnd]);

  const skipTime = useCallback((delta) => {
    const video = videoRef.current;
    if (!video) return;
    seekTo(video.currentTime + delta);
  }, [seekTo]);

  const toggleMute = useCallback(() => {
    if (isMuted) {
      setIsMuted(false);
      setVolume(prevVolume || 100);
    } else {
      setPrevVolume(volume);
      setIsMuted(true);
    }
  }, [isMuted, volume, prevVolume]);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen().catch(() => {});
    }
  }, []);

  // ── Apply trim ────────────────────────────────────
  const handleApplyTrim = useCallback(() => {
    setTrimApplied(true);
    onTrimChange?.({ trimStart: trimStartOffset, trimEnd: trimEndOffset });
  }, [trimStartOffset, trimEndOffset, onTrimChange]);

  // Reset applied state when trim handles change
  useEffect(() => {
    setTrimApplied(false);
  }, [trimStartOffset, trimEndOffset]);

  // ── Timeline pointer handling ──────────────────────
  const getTimeFromPointer = useCallback((clientX) => {
    const track = timelineRef.current;
    if (!track || clipDur <= 0) return clipStart;
    const rect = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return clipStart + pct * clipDur;
  }, [clipStart, clipDur]);

  const onTimelinePointerDown = useCallback((e) => {
    e.preventDefault();
    const track = timelineRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const time = clipStart + pct * clipDur;

    // Check if clicking near trim handles
    const leftHandlePct = trimStartOffset / clipDur;
    const rightHandlePct = 1 - trimEndOffset / clipDur;
    const handleThresholdPct = 24 / rect.width; // 24px hit area

    if (Math.abs(pct - leftHandlePct) < handleThresholdPct) {
      setDraggingHandle('left');
      startDragTracking(e, 'left');
      return;
    }
    if (Math.abs(pct - rightHandlePct) < handleThresholdPct) {
      setDraggingHandle('right');
      startDragTracking(e, 'right');
      return;
    }

    // Click-to-seek within trim region
    if (time >= trimmedStart && time <= trimmedEnd) {
      seekTo(time);
      setDraggingPlayhead(true);
      const onMove = (ev) => {
        const t = getTimeFromPointer(ev.clientX);
        if (t >= trimmedStart && t <= trimmedEnd) seekTo(t);
      };
      const onUp = () => {
        setDraggingPlayhead(false);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    }
  }, [clipStart, clipDur, trimStartOffset, trimEndOffset, trimmedStart, trimmedEnd, seekTo, getTimeFromPointer]);

  const startDragTracking = useCallback((e, handle) => {
    const onMove = (ev) => {
      const time = getTimeFromPointer(ev.clientX);
      const offset = time - clipStart;

      if (handle === 'left') {
        const maxOffset = clipDur - trimEndOffset - 1; // minimum 1s gap
        const newOffset = Math.max(0, Math.min(maxOffset, offset));
        setTrimStartOffset(newOffset);
        // Show frame at handle position
        const video = videoRef.current;
        if (video) video.currentTime = clipStart + newOffset;
      } else {
        const maxOffset = clipDur - trimStartOffset - 1;
        const fromEnd = effectiveClipEnd - time;
        const newOffset = Math.max(0, Math.min(maxOffset, fromEnd));
        setTrimEndOffset(newOffset);
        const video = videoRef.current;
        if (video) video.currentTime = effectiveClipEnd - newOffset;
      }
    };
    const onUp = () => {
      setDraggingHandle(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [clipStart, effectiveClipEnd, clipDur, trimStartOffset, trimEndOffset, getTimeFromPointer]);

  // Trim handle direct pointer down
  const onTrimHandlePointerDown = useCallback((e, handle) => {
    e.preventDefault();
    e.stopPropagation();
    setDraggingHandle(handle);
    startDragTracking(e, handle);
  }, [startDragTracking]);

  // ── Speed menu ─────────────────────────────────────
  const selectSpeed = useCallback((val) => {
    setSpeed(val);
    setShowSpeedMenu(false);
  }, []);

  // Close speed menu on outside click
  useEffect(() => {
    if (!showSpeedMenu) return;
    const onClick = () => setShowSpeedMenu(false);
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [showSpeedMenu]);

  // ── Volume icon selector ───────────────────────────
  const VolumeIcon = useMemo(() => {
    if (isMuted || volume === 0) return Icon.VolumeMuted;
    if (volume < 50) return Icon.VolumeLow;
    if (volume <= 100) return Icon.VolumeMed;
    return Icon.VolumeHigh;
  }, [isMuted, volume]);

  // ── Timeline position calculations ─────────────────
  const leftTrimPct = clipDur > 0 ? (trimStartOffset / clipDur) * 100 : 0;
  const rightTrimPct = clipDur > 0 ? (trimEndOffset / clipDur) * 100 : 0;
  const progressPct = clipDur > 0 ? ((currentTime - clipStart) / clipDur) * 100 : 0;
  const playheadPct = Math.max(0, Math.min(100, progressPct));

  // ── Ruler marks ────────────────────────────────────
  const rulerMarks = useMemo(() => {
    if (clipDur <= 0) return [];
    const count = compact ? 3 : 5;
    const marks = [];
    for (let i = 0; i < count; i++) {
      const t = (i / (count - 1)) * clipDur;
      marks.push(formatTimeShort(t));
    }
    return marks;
  }, [clipDur, compact]);

  // Trim active check
  const hasTrim = trimStartOffset > 0.01 || trimEndOffset > 0.01;

  // ── Error state ────────────────────────────────────
  if (videoError) {
    return (
      <div className="ve-error">
        <span>Failed to load video</span>
        <button className="ve-error__retry" onClick={() => { setVideoError(false); videoRef.current?.load(); }}>
          Retry
        </button>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────
  const containerClass = [
    've-container',
    compact && 've-container--compact',
    isFullscreen && 've-container--fullscreen',
  ].filter(Boolean).join(' ');

  const initialObjectPosition = isCrop
    ? `${subjectXToCenterPct(
        hasDynamicSubject ? subjectKeyframes[0].x : (safeSubjectX ? safeSubjectX(subjectX) : subjectX),
        srcRatio,
        targetRatio,
      )}% 50%`
    : undefined;

  return (
    <div
      ref={containerRef}
      className={containerClass}
    >
      {/* ── Header ── */}
      {(title || onClose) && !isFullscreen && (
        <div className="ve-header">
          <span className="ve-header__title">{title || 'Clip Preview'}</span>
          {onClose && (
            <button className="ve-header__close" onClick={onClose} title="Close">
              <Icon.Close />
            </button>
          )}
        </div>
      )}

      {/* ── Viewport ── */}
      <div
        className={`ve-viewport${isFullscreen ? ' ve-viewport--fullscreen' : ''}`}
        style={isFullscreen ? {} : {
          aspectRatio: `${targetRatio}`,
          maxHeight: compact ? '55vh' : '50vh',
          maxWidth: compact ? undefined : `calc(50vh * ${targetRatio})`,
          width: '100%',
          margin: '0 auto',
        }}
        onClick={togglePlay}
      >
        <video
          ref={videoRef}
          src={src}
          playsInline
          style={{
            objectFit: isCrop ? 'cover' : 'contain',
            objectPosition: initialObjectPosition,
          }}
        />

        {subtitleOverlay}

        {aspectRatio && (
          <div className="ve-aspect-badge">{aspectRatio}</div>
        )}

        {!playing && (
          <div className="ve-viewport__play-overlay">
            <div className="ve-viewport__play-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="white" stroke="none">
                <path d="M6.5 4.1c-.9-.5-2 .1-2 1.2v13.4c0 1.1 1.1 1.7 2 1.2l11.6-6.7c.9-.5.9-1.8 0-2.4L6.5 4.1z" />
              </svg>
            </div>
          </div>
        )}
      </div>

      {/* ── Timeline ── */}
      <div className="ve-timeline">
        <div className="ve-timeline__ruler">
          {rulerMarks.map((mark, i) => (
            <span key={i}>{mark}</span>
          ))}
        </div>

        <div
          ref={timelineRef}
          className="ve-timeline__track"
          onPointerDown={onTimelinePointerDown}
        >
          {/* Keyframe thumbnails */}
          <canvas ref={thumbnailCanvasRef} className="ve-timeline__thumbnails" />

          {/* Waveform */}
          <canvas ref={waveformCanvasRef} className="ve-timeline__waveform" />

          {/* Dimmed regions */}
          {leftTrimPct > 0 && (
            <div className="ve-timeline__dimmed-left" style={{ width: `${leftTrimPct}%` }} />
          )}
          {rightTrimPct > 0 && (
            <div className="ve-timeline__dimmed-right" style={{ width: `${rightTrimPct}%` }} />
          )}

          {/* Active trim region */}
          <div
            className="ve-timeline__trim-region"
            style={{
              left: `${leftTrimPct}%`,
              width: `${100 - leftTrimPct - rightTrimPct}%`,
            }}
          />

          {/* Progress fill */}
          <div
            className="ve-timeline__progress"
            style={{
              left: `${leftTrimPct}%`,
              width: `${Math.max(0, playheadPct - leftTrimPct)}%`,
            }}
          />

          {/* Playhead */}
          <div className="ve-timeline__playhead" style={{ left: `${playheadPct}%` }} />

          {/* Left trim handle */}
          <div
            className={`ve-trim-handle ve-trim-handle--left${draggingHandle === 'left' ? ' ve-trim-handle--active' : ''}`}
            style={{ left: `${leftTrimPct}%` }}
            onPointerDown={(e) => onTrimHandlePointerDown(e, 'left')}
          >
            <div className="ve-trim-handle__grip">
              <span /><span /><span />
            </div>
            {draggingHandle === 'left' && (
              <div className="ve-trim-tooltip">
                {formatTimecode(trimStartOffset)}
              </div>
            )}
          </div>

          {/* Right trim handle */}
          <div
            className={`ve-trim-handle ve-trim-handle--right${draggingHandle === 'right' ? ' ve-trim-handle--active' : ''}`}
            style={{ left: `calc(${100 - rightTrimPct}% - 10px)` }}
            onPointerDown={(e) => onTrimHandlePointerDown(e, 'right')}
          >
            <div className="ve-trim-handle__grip">
              <span /><span /><span />
            </div>
            {draggingHandle === 'right' && (
              <div className="ve-trim-tooltip">
                {formatTimecode(trimEndOffset)}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Controls bar ── */}
      <div className={`ve-controls${compact ? ' ve-controls--compact' : ''}`}>
        {/* Left: transport */}
        <div className="ve-controls__left">
          <button className="ve-btn" onClick={(e) => { e.stopPropagation(); skipTime(-5); }} title="Back 5s (J)">
            <Icon.SkipBack />
          </button>

          <button className="ve-btn ve-btn--play" onClick={(e) => { e.stopPropagation(); togglePlay(); }} title="Play/Pause (Space)">
            {playing ? <Icon.Pause /> : <Icon.Play />}
          </button>

          <button className="ve-btn" onClick={(e) => { e.stopPropagation(); skipTime(5); }} title="Forward 5s (L)">
            <Icon.SkipForward />
          </button>

          <span
            className="ve-timecode"
            onClick={(e) => { e.stopPropagation(); setShowTimecodeRemaining((v) => !v); }}
            title="Click to toggle elapsed/remaining"
          >
            {showTimecodeRemaining
              ? `-${formatTimecode(Math.max(0, trimmedDur - elapsed))}`
              : formatTimecode(elapsed)}
            {' / '}
            {formatTimecode(trimmedDur)}
          </span>
        </div>

        {/* Center: trim apply */}
        <div className="ve-controls__center">
          {hasTrim && (
            trimApplied ? (
              <span className="ve-trim-applied" title="Trim applied to preview and export">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Trim Applied · {formatTimeShort(trimmedDur)}
              </span>
            ) : (
              <button className="ve-apply-trim" onClick={(e) => { e.stopPropagation(); handleApplyTrim(); }} title="Apply trim to preview and export">
                Apply Trim · {formatTimeShort(trimmedDur)}
              </button>
            )
          )}
        </div>

        {/* Right: volume + speed + fullscreen */}
        <div className="ve-controls__right">
          {/* Volume */}
          <div className={`ve-volume${isMobile ? '' : ''}`} onClick={(e) => e.stopPropagation()}>
            <button className="ve-btn" onClick={toggleMute} title={isMuted ? 'Unmute (M)' : 'Mute (M)'}>
              <VolumeIcon />
            </button>
            <div className="ve-volume__slider-wrap">
              <input
                type="range"
                className="ve-volume__slider"
                min="0"
                max="200"
                step="1"
                value={isMuted ? 0 : volume}
                onChange={(e) => {
                  const v = parseInt(e.target.value);
                  setVolume(v);
                  if (isMuted && v > 0) setIsMuted(false);
                }}
                style={{
                  background: `linear-gradient(to right, ${
                    volume > 100 ? 'var(--accent-amber, #FF9F0A)' : 'var(--accent-cyan, #0A84FF)'
                  } ${(isMuted ? 0 : volume) / 2}%, var(--ve-slider-track, rgba(0,0,0,0.12)) ${(isMuted ? 0 : volume) / 2}%)`,
                }}
              />
              <span className={`ve-volume__label${volume > 150 ? ' ve-volume__label--warn' : ''}`}>
                {isMuted ? '0' : volume}%
              </span>
            </div>
          </div>

          {/* Speed */}
          <div className="ve-speed" onClick={(e) => e.stopPropagation()}>
            <button
              className={`ve-speed__btn${speed !== 1.0 ? ' ve-speed__btn--active' : ''}`}
              onClick={() => setShowSpeedMenu((v) => !v)}
              title="Playback speed"
            >
              {speed}x
            </button>
            {showSpeedMenu && (
              <div className="ve-speed__dropdown" onClick={(e) => e.stopPropagation()}>
                {SPEED_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    className={`ve-speed__option${speed === p.value ? ' ve-speed__option--current' : ''}`}
                    onClick={() => selectSpeed(p.value)}
                  >
                    {p.value}x
                    {p.label && <span className="ve-speed__option-label">{p.label}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Fullscreen */}
          <button className="ve-btn" onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }} title="Fullscreen">
            {isFullscreen ? <Icon.ExitFullscreen /> : <Icon.Fullscreen />}
          </button>
        </div>
      </div>

      {/* ── Keyboard shortcuts hint ── */}
      {!compact && (
        <div className="ve-shortcuts">
          <span><kbd>Space</kbd> Play/Pause</span>
          <span><kbd>J</kbd>/<kbd>L</kbd> -/+5s</span>
          <span><kbd>{'\u2190'}</kbd>/<kbd>{'\u2192'}</kbd> Frame</span>
          <span><kbd>M</kbd> Mute</span>
          <span>Drag trim handles to trim</span>
        </div>
      )}
    </div>
  );
}
