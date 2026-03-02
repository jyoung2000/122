import React, { useRef, useState, useEffect, useMemo } from 'react';
import { buildSubjectKeyframes, smoothKeyframes, interpolateSubjectX, isDynamic } from '../utils/subjectTracking';
import useResponsive from '../hooks/useResponsive';

const ASPECT_RATIO_VALUES = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1.0,
  '4:5': 4 / 5,
};

/**
 * Convert subject_x (0-100) to a CSS objectPosition percentage that
 * centers the subject in the cropped frame.  Matches ClipPreview logic.
 *
 * R = srcRatio / targetRatio = rendered_width / container_width (for cover)
 * centerPct = (R * sx - 50) / (R - 1)
 */
function subjectXToCenterPct(sx, srcRatio, targetRatio) {
  const R = srcRatio / targetRatio;
  if (R <= 1.01) return Math.max(0, Math.min(100, sx));
  const pct = (R * sx - 50) / (R - 1);
  return Math.max(0, Math.min(100, pct));
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function VideoPlayer({ src, clipStart, clipEnd, onTimeUpdate, aspectRatio, sourceWidth = 1920, sourceHeight = 1080, subjectX = 50, scenes }) {
  const { isMobile } = useResponsive();
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [hovered, setHovered] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      setCurrentTime(video.currentTime);
      onTimeUpdate?.(video.currentTime);
      // Auto-stop at clip end in preview mode
      if (clipEnd && video.currentTime >= clipEnd) {
        video.pause();
        setPlaying(false);
      }
    };
    const onDur = () => setDuration(video.duration);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('loadedmetadata', onDur);
    return () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('loadedmetadata', onDur);
    };
  }, [clipEnd, onTimeUpdate]);

  // Track fullscreen changes
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play();
      setPlaying(true);
    } else {
      video.pause();
      setPlaying(false);
    }
  };

  const seek = (e) => {
    const video = videoRef.current;
    if (!video) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    video.currentTime = pct * duration;
  };

  const seekTo = (time) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = time;
    setCurrentTime(time);
  };

  // Expose seekTo via ref callback
  useEffect(() => {
    window.__clipai_seekTo = seekTo;
    return () => { delete window.__clipai_seekTo; };
  }, []);

  // Auto-seek and auto-play when clip preview changes
  useEffect(() => {
    const video = videoRef.current;
    if (!video || clipStart === undefined || clipStart === null) return;
    video.currentTime = clipStart;
    setCurrentTime(clipStart);
    video.play().then(() => setPlaying(true)).catch(() => {});
  }, [clipStart, clipEnd]);

  const changeSpeed = () => {
    const speeds = [0.5, 1, 1.5, 2];
    const idx = speeds.indexOf(speed);
    const next = speeds[(idx + 1) % speeds.length];
    setSpeed(next);
    if (videoRef.current) videoRef.current.playbackRate = next;
  };

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      el.requestFullscreen?.();
    }
  };

  const progress = duration ? (currentTime / duration) * 100 : 0;

  // Aspect ratio awareness — match ClipPreview / ClipSEO behavior
  const srcRatio = sourceWidth / sourceHeight;
  const targetRatio = useMemo(() => {
    if (aspectRatio && ASPECT_RATIO_VALUES[aspectRatio]) {
      return ASPECT_RATIO_VALUES[aspectRatio];
    }
    return srcRatio;
  }, [aspectRatio, srcRatio]);
  const isCrop = useMemo(() => {
    if (!aspectRatio || !ASPECT_RATIO_VALUES[aspectRatio]) return false;
    return Math.abs(srcRatio - ASPECT_RATIO_VALUES[aspectRatio]) > 0.01;
  }, [aspectRatio, srcRatio]);

  // Dynamic subject tracking keyframes (with smoothing matching backend)
  const subjectKeyframes = useMemo(
    () => {
      if (!scenes?.length || clipStart == null || clipEnd == null) return null;
      const raw = buildSubjectKeyframes(scenes, clipStart, clipEnd);
      const smoothed = raw && raw.length > 1 ? smoothKeyframes(raw) : raw;
      if (smoothed && isDynamic(smoothed)) {
        console.log(`[SubjectTracking] VideoPlayer: ${smoothed.length} keyframes built (${clipStart.toFixed(1)}s-${clipEnd.toFixed(1)}s), x range: ${Math.min(...smoothed.map(k=>k.x))}-${Math.max(...smoothed.map(k=>k.x))}`);
      }
      return smoothed;
    },
    [scenes, clipStart, clipEnd],
  );
  const hasDynamicSubject = useMemo(
    () => isCrop && subjectKeyframes && isDynamic(subjectKeyframes),
    [isCrop, subjectKeyframes],
  );

  // Update objectPosition dynamically during playback
  useEffect(() => {
    if (!hasDynamicSubject) return;
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      const relTime = video.currentTime - (clipStart || 0);
      const sx = interpolateSubjectX(subjectKeyframes, relTime);
      const centerPct = subjectXToCenterPct(sx, srcRatio, targetRatio);
      video.style.objectPosition = `${centerPct}% 50%`;
    };
    video.addEventListener('timeupdate', onTime);
    onTime();
    return () => {
      video.removeEventListener('timeupdate', onTime);
      // Clear direct DOM style so React's declarative objectPosition takes over
      video.style.objectPosition = '';
    };
  }, [hasDynamicSubject, subjectKeyframes, clipStart, srcRatio, targetRatio]);

  // Constrain portrait containers so they don't take full width
  const videoMaxWidth = useMemo(() => {
    if (targetRatio < 1) {
      const maxHpx = (typeof window !== 'undefined' ? window.innerHeight : 900) * 0.4;
      return Math.min(Math.round(maxHpx * targetRatio), 400);
    }
    return undefined;
  }, [targetRatio]);

  return (
    <div
      ref={containerRef}
      style={isFullscreen ? {
        position: 'relative',
        background: 'var(--video-bg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100vw',
        height: '100vh',
      } : {
        position: 'relative',
        background: 'var(--video-bg)',
        borderBottom: '1px solid var(--border)',
        maxWidth: videoMaxWidth,
        margin: videoMaxWidth ? '0 auto' : undefined,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <video
        ref={videoRef}
        src={src}
        style={{
          display: 'block',
          ...(isFullscreen ? {
            maxWidth: '100vw',
            maxHeight: '100vh',
            width: 'auto',
            height: '100vh',
          } : {
            width: '100%',
            maxHeight: '40vh',
          }),
          ...(aspectRatio ? { aspectRatio: `${targetRatio}` } : {}),
          objectFit: isCrop ? 'cover' : 'contain',
          objectPosition: isCrop ? `${subjectXToCenterPct(hasDynamicSubject ? subjectKeyframes[0].x : subjectX, srcRatio, targetRatio)}% 50%` : undefined,
        }}
        onClick={togglePlay}
      />

      {/* Aspect ratio badge */}
      {aspectRatio && (
        <div style={{
          position: 'absolute',
          top: 6,
          right: 6,
          fontSize: 10,
          fontFamily: 'var(--font-mono)',
          color: 'var(--accent-amber)',
          background: 'var(--badge-overlay-bg)',
          padding: '2px 6px',
          borderRadius: 3,
          pointerEvents: 'none',
          zIndex: 2,
        }}>
          {aspectRatio}
        </div>
      )}

      {/* Controls overlay */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          background: 'var(--video-gradient)',
          padding: '24px 16px 12px',
          opacity: hovered ? 1 : 0,
          transition: 'opacity 0.2s ease',
        }}
      >
        {/* Seek bar */}
        <div
          onClick={seek}
          style={{
            height: isMobile ? 8 : 4,
            background: 'var(--bg-elevated)',
            cursor: 'pointer',
            position: 'relative',
            marginBottom: 8,
            borderRadius: 4,
          }}
        >
          {/* Clip markers */}
          {clipStart !== undefined && clipEnd !== undefined && duration > 0 && (
            <div
              style={{
                position: 'absolute',
                left: `${(clipStart / duration) * 100}%`,
                width: `${((clipEnd - clipStart) / duration) * 100}%`,
                height: '100%',
                background: 'var(--amber-dim)',
                borderLeft: '2px solid var(--accent-amber)',
                borderRight: '2px solid var(--accent-amber)',
              }}
            />
          )}
          <div
            style={{
              height: '100%',
              width: `${progress}%`,
              background: 'var(--accent-cyan)',
              position: 'relative',
            }}
          >
            <div
              style={{
                position: 'absolute',
                right: -4,
                top: -4,
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: 'var(--accent-cyan)',
              }}
            />
          </div>
        </div>

        {/* Control buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={togglePlay}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--video-controls-text)',
              fontSize: isMobile ? 22 : 18,
              padding: isMobile ? 8 : 4,
              minHeight: isMobile ? 44 : undefined,
            }}
          >
            {playing ? '\u23F8' : '\u25B6'}
          </button>

          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          <div style={{ flex: 1 }} />

          {/* Volume */}
          <input
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={volume}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setVolume(v);
              if (videoRef.current) videoRef.current.volume = v;
            }}
            style={{ width: 60, accentColor: 'var(--accent-cyan)' }}
          />

          {/* Speed */}
          <button
            onClick={changeSpeed}
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
              padding: isMobile ? '6px 12px' : '2px 8px',
              borderRadius: 'var(--radius-sm)',
              fontSize: isMobile ? 13 : 11,
              fontFamily: 'var(--font-mono)',
            }}
          >
            {speed}x
          </button>

          {/* Fullscreen */}
          <button
            onClick={toggleFullscreen}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              fontSize: isMobile ? 20 : 16,
              padding: isMobile ? 8 : 4,
              minHeight: isMobile ? 44 : undefined,
            }}
          >
            {isFullscreen ? '\u2715' : '\u26F6'}
          </button>
        </div>
      </div>
    </div>
  );
}
