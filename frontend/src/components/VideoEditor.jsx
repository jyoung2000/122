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

  // Soft clamp: if pct is outside [0, 100], ease toward the edge
  // instead of hard-clamping. This prevents the "slam to edge" visual.
  if (pct < 0) {
    return Math.max(0, 5 * (1 - Math.min(1, Math.abs(pct) / 50)));
  }
  if (pct > 100) {
    return Math.min(100, 100 - 5 * (1 - Math.min(1, (pct - 100) / 50)));
  }

  return pct;
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

/** Parse user-typed timecodes: "3:20", "3:20.5", "200" (raw seconds), "1:05:30" */
function parseTimecodeInput(str) {
  if (!str || !str.trim()) return null;
  const s = str.trim();
  // h:mm:ss or h:mm:ss.cc
  const hms = s.match(/^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/);
  if (hms) {
    return parseInt(hms[1]) * 3600 + parseInt(hms[2]) * 60 + parseInt(hms[3]) + (hms[4] ? parseFloat('0.' + hms[4]) : 0);
  }
  // m:ss or m:ss.cc
  const ms = s.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);
  if (ms) {
    return parseInt(ms[1]) * 60 + parseInt(ms[2]) + (ms[3] ? parseFloat('0.' + ms[3]) : 0);
  }
  // Raw number (seconds)
  const num = parseFloat(s);
  if (!isNaN(num) && num >= 0) return num;
  return null;
}

// ── Component ────────────────────────────────────────────────────────────────
const ASPECT_RATIO_OPTIONS = [
  { value: null, label: 'Original', icon: null },
  { value: '16:9', label: '16:9', icon: 'landscape' },
  { value: '9:16', label: '9:16', icon: 'portrait' },
  { value: '1:1', label: '1:1', icon: 'square' },
  { value: '4:5', label: '4:5', icon: 'portrait' },
];

export default function VideoEditor({
  src,
  clipStart = 0,
  clipEnd = 0,
  onTimeUpdate,
  onTrimChange,
  onApplyTrim,
  onVolumeChange,
  onSpeedChange,
  onSegmentsChange,
  onAspectRatioChange,
  aspectRatio,
  sourceWidth = 1920,
  sourceHeight = 1080,
  subjectX = 50,
  scenes,
  initialTime,
  initialVolume,
  initialSpeed,
  initialSegments,
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
  const [editingTimecode, setEditingTimecode] = useState(false);
  const [timecodeInput, setTimecodeInput] = useState('');
  const timecodeInputRef = useRef(null);
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

  // Segments: per-region settings overrides
  // Each segment: { id, start, end, volume, muted, subtitlesEnabled, speed }
  // start/end are absolute times (same coordinate system as clipStart/clipEnd)
  const [segments, setSegments] = useState(initialSegments || []);
  const segmentIdRef = useRef(1);
  const [selectedSegmentId, setSelectedSegmentId] = useState(null);

  // Derived: the currently selected segment object (or null)
  const selectedSegment = useMemo(
    () => segments.find(s => s.id === selectedSegmentId) || null,
    [segments, selectedSegmentId],
  );

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
    return processKeyframes(scenes, clipStart, clipEnd, isCrop ? srcRatio : null, isCrop ? targetRatio : null);
  }, [scenes, clipStart, clipEnd, isCrop, srcRatio, targetRatio]);

  const hasDynamicSubject = useMemo(
    () => isCrop && subjectKeyframes && isDynamic(subjectKeyframes),
    [isCrop, subjectKeyframes],
  );

  // ── Segment helpers ────────────────────────────────
  const getActiveSegment = useCallback((t) => {
    return segments.find(s => t >= s.start && t < s.end) || null;
  }, [segments]);

  const addSegment = useCallback(() => {
    if (trimStartOffset < 0.1 && trimEndOffset < 0.1) return; // no selection
    const segStart = clipStart + trimStartOffset;
    const segEnd = effectiveClipEnd - trimEndOffset;
    if (segEnd - segStart < 0.5) return; // too short
    const newSeg = {
      id: `seg_${segmentIdRef.current++}`,
      start: segStart,
      end: segEnd,
      volume: isMuted ? 0 : volume,
      muted: isMuted,
      subtitlesEnabled: true,
      speed,
    };
    const next = [...segments, newSeg].sort((a, b) => a.start - b.start);
    setSegments(next);
    onSegmentsChange?.(next);
  }, [trimStartOffset, trimEndOffset, clipStart, effectiveClipEnd, volume, isMuted, speed, segments, onSegmentsChange]);

  const removeSegment = useCallback((segId) => {
    const next = segments.filter(s => s.id !== segId);
    setSegments(next);
    onSegmentsChange?.(next);
  }, [segments, onSegmentsChange]);

  const toggleSegmentMute = useCallback((segId) => {
    const next = segments.map(s => s.id === segId ? { ...s, muted: !s.muted, volume: s.muted ? 100 : 0 } : s);
    setSegments(next);
    onSegmentsChange?.(next);
  }, [segments, onSegmentsChange]);

  const toggleSegmentSubs = useCallback((segId) => {
    const next = segments.map(s => s.id === segId ? { ...s, subtitlesEnabled: !s.subtitlesEnabled } : s);
    setSegments(next);
    onSegmentsChange?.(next);
  }, [segments, onSegmentsChange]);

  const updateSegment = useCallback((segId, updates) => {
    const next = segments.map(s => s.id === segId ? { ...s, ...updates } : s);
    setSegments(next);
    onSegmentsChange?.(next);
  }, [segments, onSegmentsChange]);

  const deselectSegment = useCallback(() => {
    setSelectedSegmentId(null);
  }, []);

  // ── Reset on new clip ──────────────────────────────
  useEffect(() => {
    const vol = (initialVolume != null && initialVolume >= 0) ? initialVolume : 100;
    const spd = (initialSpeed != null && initialSpeed > 0) ? initialSpeed : 1.0;
    setTrimStartOffset(0);
    setTrimEndOffset(0);
    setSegments(initialSegments || []);
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

    const isDark = document.documentElement.dataset.theme === 'dark';
    const barWidth = rect.width / data.length;
    const midY = rect.height / 2;

    for (let i = 0; i < data.length; i++) {
      const x = i * barWidth;
      const barH = Math.max(1, data[i] * midY * 0.9);
      const pct = i / data.length;
      const leftPct = trimStartOffset / (clipDur || 1);
      const rightPct = 1 - trimEndOffset / (clipDur || 1);
      const playPct = clipDur > 0 ? (currentTime - clipStart) / clipDur : 0;

      if (pct < leftPct || pct > rightPct) {
        ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.10)';
      } else if (pct <= playPct) {
        ctx.fillStyle = 'rgba(10, 132, 255, 0.9)';
      } else {
        ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.4)';
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

  // ── Playback time tracking via rAF + native events ──
  // rAF provides smooth visual updates; native events ensure we never
  // miss a seek or time change on any device (mobile can throttle rAF).
  const syncTime = useCallback((t) => {
    setCurrentTime(t);
    onTimeUpdate?.(t);
  }, [onTimeUpdate]);

  // Track which segment is active for volume override — store id + a hash
  // of the segment's settings so we re-apply when properties change.
  const activeSegRef = useRef({ id: null, hash: null });

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let rafId;

    // Simple hash of segment settings to detect property changes
    const segHash = (seg) => seg ? `${seg.id}_${seg.muted}_${seg.volume}_${seg.speed}` : null;

    const tick = () => {
      const t = video.currentTime;
      syncTime(t);
      // Auto-stop at trimmed end
      if (trimmedEnd && t >= trimmedEnd) {
        video.pause();
        setPlaying(false);
      }
      // Apply per-segment volume + speed overrides during playback.
      // Re-apply whenever the active segment changes OR its properties change
      // (e.g. user adjusts volume slider while playhead is inside the segment).
      const seg = segments.length > 0 ? segments.find(s => t >= s.start && t < s.end) : null;
      const curId = seg ? seg.id : null;
      const curHash = segHash(seg);
      const prev = activeSegRef.current;

      if (curId !== prev.id || curHash !== prev.hash) {
        activeSegRef.current = { id: curId, hash: curHash };
        if (seg) {
          // Apply segment volume
          const segVol = seg.muted ? 0 : seg.volume;
          if (gainNodeRef.current) {
            gainNodeRef.current.gain.value = segVol / 100;
          } else {
            video.volume = Math.min(1, segVol / 100);
          }
          // Apply segment speed
          const segSpeed = seg.speed || speed;
          if (Math.abs(video.playbackRate - segSpeed) > 0.001) {
            video.playbackRate = segSpeed;
          }
        } else {
          // Restore global volume
          const effectiveVol = isMuted ? 0 : volume;
          if (gainNodeRef.current) {
            gainNodeRef.current.gain.value = effectiveVol / 100;
          } else {
            video.volume = Math.min(1, effectiveVol / 100);
          }
          // Restore global speed
          if (Math.abs(video.playbackRate - speed) > 0.001) {
            video.playbackRate = speed;
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    // Fallback: native timeupdate + seeked ensure accuracy on mobile
    // where rAF may be throttled or skipped.
    const onNativeTime = () => syncTime(video.currentTime);
    video.addEventListener('timeupdate', onNativeTime);
    video.addEventListener('seeked', onNativeTime);

    return () => {
      cancelAnimationFrame(rafId);
      activeSegRef.current = { id: null, hash: null };
      video.removeEventListener('timeupdate', onNativeTime);
      video.removeEventListener('seeked', onNativeTime);
    };
  }, [trimmedEnd, syncTime, segments, volume, isMuted, speed]);

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
  // Skip direct video manipulation when playhead is inside a segment —
  // the rAF loop handles per-segment volume to avoid conflicts.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // Check if playhead is inside a segment — if so, rAF handles it
    const t = video.currentTime;
    const inSegment = segments.length > 0 && segments.some(s => t >= s.start && t < s.end);
    if (!inSegment) {
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
    }
    onVolumeChange?.(isMuted ? 0 : volume / 100);
  }, [volume, isMuted, onVolumeChange, segments]);

  // ── Apply speed changes ────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // Skip when playhead is inside a segment — rAF handles per-segment speed
    const t = video.currentTime;
    const inSegment = segments.length > 0 && segments.some(s => t >= s.start && t < s.end);
    if (!inSegment) {
      video.playbackRate = speed;
    }
    onSpeedChange?.(speed);
  }, [speed, onSpeedChange, segments]);

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
    if (selectedSegment) {
      updateSegment(selectedSegment.id, {
        muted: !selectedSegment.muted,
        volume: selectedSegment.muted ? 100 : 0,
      });
      return;
    }
    if (isMuted) {
      setIsMuted(false);
      setVolume(prevVolume || 100);
    } else {
      setPrevVolume(volume);
      setIsMuted(true);
    }
  }, [isMuted, volume, prevVolume, selectedSegment, updateSegment]);

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
    // Notify parent to update clip boundaries so the trimmed range becomes the full video
    if (onApplyTrim) {
      onApplyTrim({ start: trimmedStart, end: trimmedEnd });
      // Reset trim offsets since the clip boundaries are now narrower
      setTrimStartOffset(0);
      setTrimEndOffset(0);
    }
  }, [trimStartOffset, trimEndOffset, trimmedStart, trimmedEnd, onTrimChange, onApplyTrim]);

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
    if (selectedSegment) {
      updateSegment(selectedSegment.id, { speed: val });
      setShowSpeedMenu(false);
      return;
    }
    setSpeed(val);
    setShowSpeedMenu(false);
  }, [selectedSegment, updateSegment]);

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

      {/* ── Aspect Ratio Picker ── */}
      {onAspectRatioChange && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
          padding: '5px 8px', margin: '0 auto',
          maxWidth: compact ? undefined : `calc(50vh * ${targetRatio})`,
          width: '100%',
        }}>
          <span style={{
            fontSize: 10, fontWeight: 600, color: 'var(--text-muted, #888)',
            marginRight: 4, whiteSpace: 'nowrap', textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}>
            Ratio
          </span>
          {ASPECT_RATIO_OPTIONS.map((opt) => {
            const isActive = aspectRatio === opt.value;
            return (
              <button
                key={opt.label}
                onClick={(e) => { e.stopPropagation(); onAspectRatioChange(opt.value); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 3,
                  padding: '3px 8px', fontSize: 10, fontWeight: isActive ? 700 : 500,
                  background: isActive ? 'var(--accent-cyan, #0A84FF)' : 'var(--bg-elevated, rgba(0,0,0,0.04))',
                  color: isActive ? '#fff' : 'var(--text-secondary, #666)',
                  border: isActive ? '1px solid var(--accent-cyan, #0A84FF)' : '1px solid var(--border-dim, rgba(0,0,0,0.08))',
                  borderRadius: 'var(--radius-xs, 4px)', cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  whiteSpace: 'nowrap',
                }}
                title={opt.value ? `${opt.value} crop` : 'Original aspect ratio'}
              >
                {opt.value && (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ opacity: 0.7 }}>
                    {opt.value === '16:9' && <rect x="1" y="3.5" width="14" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />}
                    {opt.value === '9:16' && <rect x="3.5" y="1" width="9" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.3" />}
                    {opt.value === '1:1' && <rect x="2" y="2" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.3" />}
                    {opt.value === '4:5' && <rect x="2.5" y="1.5" width="11" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.3" />}
                  </svg>
                )}
                {opt.label}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Active Settings Indicator ── */}
      {(segments.length > 0 || (aspectRatio && aspectRatio !== null) || Math.abs(speed - 1.0) > 0.001 || Math.abs(volume - 100) > 0.5 || isMuted) && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
          padding: '3px 8px', flexWrap: 'wrap',
        }}>
          {aspectRatio && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              padding: '2px 6px', fontSize: 9, fontWeight: 600,
              background: 'rgba(10, 132, 255, 0.08)', color: 'var(--accent-cyan, #0A84FF)',
              border: '1px solid rgba(10, 132, 255, 0.2)', borderRadius: 3,
            }}>
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="1" y="3" width="14" height="10" rx="1.5" />
              </svg>
              {aspectRatio}
            </span>
          )}
          {isMuted && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              padding: '2px 6px', fontSize: 9, fontWeight: 600,
              background: 'rgba(255, 59, 48, 0.08)', color: '#FF3B30',
              border: '1px solid rgba(255, 59, 48, 0.2)', borderRadius: 3,
            }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M11 5L6 9H2v6h4l5 4V5z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" />
              </svg>
              Muted
            </span>
          )}
          {!isMuted && Math.abs(volume - 100) > 0.5 && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              padding: '2px 6px', fontSize: 9, fontWeight: 600,
              background: volume > 100 ? 'rgba(255, 159, 10, 0.08)' : 'rgba(10, 132, 255, 0.08)',
              color: volume > 100 ? 'var(--accent-amber, #FF9F0A)' : 'var(--accent-cyan, #0A84FF)',
              border: `1px solid ${volume > 100 ? 'rgba(255, 159, 10, 0.2)' : 'rgba(10, 132, 255, 0.2)'}`,
              borderRadius: 3,
            }}>
              Vol {volume}%
            </span>
          )}
          {Math.abs(speed - 1.0) > 0.001 && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              padding: '2px 6px', fontSize: 9, fontWeight: 600,
              background: 'rgba(175, 82, 222, 0.08)', color: '#AF52DE',
              border: '1px solid rgba(175, 82, 222, 0.2)', borderRadius: 3,
            }}>
              {speed}x Speed
            </span>
          )}
          {segments.length > 0 && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              padding: '2px 6px', fontSize: 9, fontWeight: 600,
              background: 'rgba(48, 209, 88, 0.08)', color: '#30D158',
              border: '1px solid rgba(48, 209, 88, 0.2)', borderRadius: 3,
            }}>
              {segments.length} Segment{segments.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
      )}

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

          {/* ── Segment overlays on timeline ── */}
          {segments.map(seg => {
          const segLeftPct = clipDur > 0 ? ((seg.start - clipStart) / clipDur) * 100 : 0;
          const segWidthPct = clipDur > 0 ? ((seg.end - seg.start) / clipDur) * 100 : 0;
          const isSegSelected = selectedSegmentId === seg.id;
          const segColor = seg.muted ? 'rgba(255, 59, 48' : !seg.subtitlesEnabled ? 'rgba(255, 149, 0' : 'rgba(10, 132, 255';
          return (
            <div
              key={seg.id}
              className="ve-timeline__segment-overlay"
              onClick={(e) => { e.stopPropagation(); setSelectedSegmentId(isSegSelected ? null : seg.id); }}
              style={{
                position: 'absolute',
                left: `${segLeftPct}%`,
                width: `${segWidthPct}%`,
                top: 0, bottom: 0,
                background: isSegSelected ? `${segColor}, 0.3)` : `${segColor}, 0.15)`,
                borderLeft: `2px solid ${segColor}, ${isSegSelected ? '1' : '0.6'})`,
                borderRight: `2px solid ${segColor}, ${isSegSelected ? '1' : '0.6'})`,
                pointerEvents: 'auto',
                zIndex: 4,
                cursor: 'pointer',
              }}
            >
              {/* Top label with icon */}
              <span style={{
                position: 'absolute', top: 1, left: 3,
                display: 'flex', alignItems: 'center', gap: 2,
                fontSize: 7, fontWeight: 700, letterSpacing: '0.04em',
                color: `${segColor}, 0.95)`,
                textTransform: 'uppercase', lineHeight: 1, pointerEvents: 'none',
                whiteSpace: 'nowrap',
              }}>
                {seg.muted ? (
                  <>
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                      <path d="M11 5L6 9H2v6h4l5 4V5z" /><line x1="23" y1="9" x2="17" y2="15" />
                    </svg>
                    MUTED
                  </>
                ) : !seg.subtitlesEnabled ? (
                  <>
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                      <rect x="2" y="6" width="20" height="12" rx="2" /><line x1="2" y1="2" x2="22" y2="22" />
                    </svg>
                    NO SUBS
                  </>
                ) : (
                  <>
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                      <path d="M11 5L6 9H2v6h4l5 4V5z" />
                    </svg>
                    {seg.volume}%{seg.speed && Math.abs(seg.speed - 1.0) > 0.001 ? ` ${seg.speed}x` : ''}
                  </>
                )}
              </span>
              {/* Bottom border indicator bar */}
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0, height: 2,
                background: `${segColor}, 0.7)`,
              }} />
            </div>
          );
        })}
        </div>

        {/* ── Waveform audio track (separate row) ── */}
        <div className="ve-timeline__waveform-track" onPointerDown={onTimelinePointerDown}>
          <canvas ref={waveformCanvasRef} className="ve-timeline__waveform" />
          <div className="ve-timeline__playhead" style={{ left: `${playheadPct}%` }} />
        </div>

        {/* ── Segment controls ── */}
        {(segments.length > 0 || hasTrim) && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0',
            flexWrap: 'wrap', fontSize: 10,
          }}>
            {hasTrim && (
              <button
                onClick={(e) => { e.stopPropagation(); addSegment(); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 3,
                  padding: '3px 8px', fontSize: 10, fontWeight: 600,
                  background: 'var(--accent-cyan-dim, rgba(10,132,255,0.1))',
                  color: 'var(--accent-cyan, #0A84FF)',
                  border: '1px solid var(--accent-cyan, #0A84FF)',
                  borderRadius: 'var(--radius-xs, 4px)', cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
                title="Save current selection as a segment with current volume/mute settings"
              >
                + Add Segment
              </button>
            )}
            {segments.map(seg => {
              const isSelected = selectedSegmentId === seg.id;
              return (
              <div
                key={seg.id}
                onClick={(e) => { e.stopPropagation(); setSelectedSegmentId(isSelected ? null : seg.id); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 3,
                  padding: '2px 6px', cursor: 'pointer',
                  background: isSelected ? 'rgba(10,132,255,0.12)' : seg.muted ? 'rgba(255,59,48,0.08)' : 'var(--bg-elevated, #f5f5f5)',
                  border: `1.5px solid ${isSelected ? 'var(--accent-cyan, #0A84FF)' : seg.muted ? 'rgba(255,59,48,0.3)' : 'var(--border, #ddd)'}`,
                  borderRadius: 'var(--radius-xs, 4px)',
                  fontSize: 9, color: 'var(--text-secondary, #666)',
                  outline: isSelected ? '1px solid rgba(10,132,255,0.3)' : 'none',
                  transition: 'all 0.15s ease',
                }}
                title={isSelected ? 'Click to deselect — controls apply to this segment' : 'Click to select — controls will apply to this segment'}
              >
                {isSelected && <span style={{ fontSize: 8, fontWeight: 700, color: 'var(--accent-cyan, #0A84FF)', marginRight: 1 }}>EDITING</span>}
                <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>
                  {formatTimeShort(seg.start - clipStart)}–{formatTimeShort(seg.end - clipStart)}
                </span>
                <span style={{ fontSize: 8, color: 'var(--text-muted, #999)' }}>
                  {seg.muted ? 'muted' : `${seg.volume}%`}
                  {seg.speed && Math.abs(seg.speed - 1.0) > 0.001 ? ` · ${seg.speed}x` : ''}
                  {!seg.subtitlesEnabled ? ' · no subs' : ''}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); removeSegment(seg.id); if (isSelected) setSelectedSegmentId(null); }}
                  style={{
                    padding: '0 3px', fontSize: 11, fontWeight: 700, lineHeight: 1,
                    background: 'transparent', color: 'var(--text-muted, #999)',
                    border: 'none', borderRadius: 2, cursor: 'pointer',
                  }}
                  title="Remove segment"
                >
                  ×
                </button>
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Segment editing indicator ── */}
      {selectedSegment && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          padding: '4px 10px',
          background: 'rgba(10, 132, 255, 0.06)',
          borderTop: '1px solid rgba(10, 132, 255, 0.15)',
          borderBottom: '1px solid rgba(10, 132, 255, 0.15)',
        }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--accent-cyan, #0A84FF)' }}>
            Editing Segment {formatTimeShort(selectedSegment.start - clipStart)}–{formatTimeShort(selectedSegment.end - clipStart)}
          </span>
          <span style={{ fontSize: 9, color: 'var(--text-muted, #888)' }}>
            Volume/speed/mute controls apply to this segment
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); toggleSegmentSubs(selectedSegment.id); }}
            style={{
              padding: '2px 6px', fontSize: 9, fontWeight: 600,
              background: !selectedSegment.subtitlesEnabled ? 'rgba(255,149,0,0.12)' : 'rgba(48,209,88,0.08)',
              color: !selectedSegment.subtitlesEnabled ? '#FF9500' : '#30D158',
              border: `1px solid ${!selectedSegment.subtitlesEnabled ? 'rgba(255,149,0,0.3)' : 'rgba(48,209,88,0.2)'}`,
              borderRadius: 3, cursor: 'pointer',
            }}
          >
            {selectedSegment.subtitlesEnabled ? 'Subs On' : 'Subs Off'}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); deselectSegment(); }}
            style={{
              padding: '2px 8px', fontSize: 9, fontWeight: 600,
              background: 'var(--bg-elevated, #f5f5f5)',
              color: 'var(--text-secondary, #666)',
              border: '1px solid var(--border, #ddd)',
              borderRadius: 3, cursor: 'pointer',
            }}
          >
            Done
          </button>
        </div>
      )}

      {/* ── Controls bar ── */}
      <div className={`ve-controls${compact ? ' ve-controls--compact' : ''}`}>
        {/* Transport row: centered on all devices */}
        <div className="ve-controls__transport">
          <button className="ve-btn" onClick={(e) => { e.stopPropagation(); skipTime(-5); }} title="Back 5s (J)">
            <Icon.SkipBack />
          </button>

          <button className="ve-btn ve-btn--play" onClick={(e) => { e.stopPropagation(); togglePlay(); }} title="Play/Pause (Space)">
            {playing ? <Icon.Pause /> : <Icon.Play />}
          </button>

          <button className="ve-btn" onClick={(e) => { e.stopPropagation(); skipTime(5); }} title="Forward 5s (L)">
            <Icon.SkipForward />
          </button>

          {editingTimecode ? (
            <input
              ref={timecodeInputRef}
              className="ve-timecode ve-timecode--input"
              type="text"
              inputMode="numeric"
              value={timecodeInput}
              onChange={(e) => setTimecodeInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const parsed = parseTimecodeInput(timecodeInput);
                  if (parsed != null) seekTo(trimmedStart + parsed);
                  setEditingTimecode(false);
                } else if (e.key === 'Escape') {
                  setEditingTimecode(false);
                }
                e.stopPropagation();
              }}
              onBlur={() => {
                const parsed = parseTimecodeInput(timecodeInput);
                if (parsed != null) seekTo(trimmedStart + parsed);
                setEditingTimecode(false);
              }}
              onClick={(e) => e.stopPropagation()}
              placeholder="0:00"
              autoFocus
            />
          ) : (
            <span
              className="ve-timecode"
              onClick={(e) => {
                e.stopPropagation();
                setTimecodeInput(formatTimecode(elapsed).replace(/\..*$/, ''));
                setEditingTimecode(true);
                setTimeout(() => timecodeInputRef.current?.select(), 0);
              }}
              title="Click to type a time"
            >
              {showTimecodeRemaining
                ? `-${formatTimecode(Math.max(0, (trimmedDur - elapsed) / speed))}`
                : formatTimecode(elapsed / speed)}
              {' / '}
              {formatTimecode(trimmedDur / speed)}
            </span>
          )}
        </div>

        {/* Center: trim apply */}
        <div className="ve-controls__center">
          {hasTrim && (
            trimApplied ? (
              <span className="ve-trim-applied" title="Trim applied to preview and export">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Trim Applied · {formatTimeShort(trimmedDur / speed)}
              </span>
            ) : (
              <button className="ve-apply-trim" onClick={(e) => { e.stopPropagation(); handleApplyTrim(); }} title="Apply trim to preview and export">
                Apply Trim · {formatTimeShort(trimmedDur / speed)}
              </button>
            )
          )}
        </div>

        {/* Right: volume + speed + fullscreen */}
        <div className="ve-controls__right">
          {/* Volume — segment-aware */}
          <div className={`ve-volume${isMobile ? '' : ''}`} onClick={(e) => e.stopPropagation()}>
            <button className="ve-btn" onClick={toggleMute} title={selectedSegment ? `${selectedSegment.muted ? 'Unmute' : 'Mute'} segment` : isMuted ? 'Unmute (M)' : 'Mute (M)'}>
              <VolumeIcon />
            </button>
            <div className="ve-volume__slider-wrap">
              {(() => {
                const dispVol = selectedSegment ? (selectedSegment.muted ? 0 : selectedSegment.volume) : (isMuted ? 0 : volume);
                const dispMax = selectedSegment ? selectedSegment.volume : volume;
                return (
                  <>
                    <input
                      type="range"
                      className="ve-volume__slider"
                      min="0"
                      max="200"
                      step="1"
                      value={dispVol}
                      onChange={(e) => {
                        const v = parseInt(e.target.value);
                        if (selectedSegment) {
                          updateSegment(selectedSegment.id, { volume: v, muted: v === 0 });
                        } else {
                          setVolume(v);
                          if (isMuted && v > 0) setIsMuted(false);
                        }
                      }}
                      style={{
                        background: `linear-gradient(to right, ${
                          dispMax > 100 ? 'var(--accent-amber, #FF9F0A)' : 'var(--accent-cyan, #0A84FF)'
                        } ${dispVol / 2}%, var(--ve-slider-track, rgba(0,0,0,0.12)) ${dispVol / 2}%)`,
                      }}
                    />
                    <span className={`ve-volume__label${dispMax > 150 ? ' ve-volume__label--warn' : ''}`}>
                      {dispVol}%
                    </span>
                  </>
                );
              })()}
            </div>
          </div>

          {/* Speed — segment-aware */}
          <div className="ve-speed" onClick={(e) => e.stopPropagation()}>
            {(() => {
              const dispSpeed = selectedSegment ? (selectedSegment.speed || 1.0) : speed;
              return (
                <button
                  className={`ve-speed__btn${dispSpeed !== 1.0 ? ' ve-speed__btn--active' : ''}`}
                  onClick={() => setShowSpeedMenu((v) => !v)}
                  title={selectedSegment ? 'Segment playback speed' : 'Playback speed'}
                >
                  {dispSpeed}x
                </button>
              );
            })()}
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
