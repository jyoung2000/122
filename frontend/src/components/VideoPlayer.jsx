import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { processKeyframes, interpolateSubjectX, isDynamic } from '../utils/subjectTracking';
import useResponsive from '../hooks/useResponsive';
import AudioWaveform from './AudioWaveform';
import {
  PlayIcon, PauseIcon, SkipBackIcon, SkipForwardIcon,
  VolumeIcon, VolumeOffIcon, FullscreenIcon, ExitFullscreenIcon,
} from './icons';

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

export default function VideoPlayer({ src, clipStart, clipEnd, onTimeUpdate, aspectRatio, sourceWidth = 1920, sourceHeight = 1080, subjectX = 50, scenes, transcript }) {
  const { isMobile } = useResponsive();
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [seekHover, setSeekHover] = useState(null);

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

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play();
      setPlaying(true);
    } else {
      video.pause();
      setPlaying(false);
    }
  }, []);

  const seek = useCallback((e) => {
    const video = videoRef.current;
    if (!video) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    video.currentTime = pct * duration;
  }, [duration]);

  const seekTo = useCallback((time) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = time;
    setCurrentTime(time);
  }, []);

  // Expose seekTo via ref callback
  useEffect(() => {
    window.__clipai_seekTo = seekTo;
    return () => { delete window.__clipai_seekTo; };
  }, [seekTo]);

  // Auto-seek and auto-play when clip preview changes
  useEffect(() => {
    const video = videoRef.current;
    if (!video || clipStart === undefined || clipStart === null) return;
    video.currentTime = clipStart;
    setCurrentTime(clipStart);
    video.play().then(() => setPlaying(true)).catch(() => {});
  }, [clipStart, clipEnd]);

  const skipBack = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, video.currentTime - 10);
  }, []);

  const skipForward = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.min(duration, video.currentTime + 10);
  }, [duration]);

  const changeSpeed = useCallback(() => {
    const speeds = [0.5, 1, 1.5, 2];
    const idx = speeds.indexOf(speed);
    const next = speeds[(idx + 1) % speeds.length];
    setSpeed(next);
    if (videoRef.current) videoRef.current.playbackRate = next;
  }, [speed]);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      el.requestFullscreen?.();
    }
  }, []);

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

  // Dynamic subject tracking keyframes (full pipeline matching backend)
  const subjectKeyframes = useMemo(
    () => {
      if (!scenes?.length || clipStart == null || clipEnd == null) return null;
      const processed = processKeyframes(scenes, clipStart, clipEnd);
      if (processed && isDynamic(processed)) {
        console.log(`[SubjectTracking] VideoPlayer: ${processed.length} keyframes (pipeline: build→cuts→deadzone→smooth→holds) (${clipStart.toFixed(1)}s-${clipEnd.toFixed(1)}s), x range: ${Math.min(...processed.map(k=>k.x))}-${Math.max(...processed.map(k=>k.x))}`);
      }
      return processed;
    },
    [scenes, clipStart, clipEnd],
  );
  const hasDynamicSubject = useMemo(
    () => isCrop && subjectKeyframes && isDynamic(subjectKeyframes),
    [isCrop, subjectKeyframes],
  );

  // Update objectPosition dynamically via rAF for smooth ~60fps updates
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
      // Only update DOM if value actually changed (avoid layout thrashing)
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

  // Build clip regions for waveform
  const clipRegions = useMemo(() => {
    if (clipStart != null && clipEnd != null) {
      return [{ start: clipStart, end: clipEnd }];
    }
    return [];
  }, [clipStart, clipEnd]);

  // Build speaker segments for waveform
  const speakerSegments = useMemo(() => {
    if (!transcript?.length) return [];
    return transcript.map(seg => ({
      start: seg.start,
      end: seg.end,
      speaker: seg.speaker || 'Speaker',
    }));
  }, [transcript]);

  // Seek handler for waveform
  const handleWaveformSeek = useCallback((time) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      setCurrentTime(time);
    }
  }, []);

  const btnStyle = {
    background: 'none',
    border: 'none',
    color: 'var(--video-controls-text)',
    padding: isMobile ? 8 : 4,
    minHeight: isMobile ? 44 : 32,
    minWidth: isMobile ? 44 : 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    borderRadius: 'var(--radius-xs)',
    transition: 'background 0.15s',
  };

  return (
    <div
      ref={containerRef}
      style={isFullscreen ? {
        position: 'relative',
        background: '#000',
        display: 'flex',
        flexDirection: 'column',
        width: '100vw',
        height: '100vh',
      } : {
        position: 'relative',
        background: '#000',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        maxWidth: videoMaxWidth,
        margin: videoMaxWidth ? '0 auto' : undefined,
      }}
    >
      {/* Video frame */}
      <div style={{ position: 'relative', flex: isFullscreen ? 1 : undefined }}>
        <video
          ref={videoRef}
          src={src}
          style={{
            display: 'block',
            ...(isFullscreen ? {
              maxWidth: '100vw',
              maxHeight: 'calc(100vh - 100px)',
              width: 'auto',
              height: 'calc(100vh - 100px)',
              margin: '0 auto',
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
            top: 8,
            right: 8,
            fontSize: 10,
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            color: '#fff',
            background: 'rgba(0,0,0,0.5)',
            backdropFilter: 'blur(8px)',
            padding: '3px 8px',
            borderRadius: 'var(--radius-xl)',
            pointerEvents: 'none',
            zIndex: 2,
          }}>
            {aspectRatio}
          </div>
        )}

        {/* Play overlay when paused */}
        {!playing && (
          <div
            onClick={togglePlay}
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              zIndex: 3,
            }}
          >
            <div style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: 'rgba(0,0,0,0.45)',
              backdropFilter: 'blur(12px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              transition: 'transform 0.2s var(--ease-spring)',
            }}>
              <PlayIcon size={24} />
            </div>
          </div>
        )}
      </div>

      {/* ═══ Transport Bar (Persistent, Liquid Glass) ═══ */}
      <div
        style={{
          background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(20px) saturate(180%)',
          WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          padding: isMobile ? '8px 12px' : '6px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {/* Seek scrubber */}
        <div
          onClick={seek}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            setSeekHover({ pct, x: e.clientX - rect.left });
          }}
          onMouseLeave={() => setSeekHover(null)}
          style={{
            height: isMobile ? 8 : 6,
            background: 'rgba(255,255,255,0.15)',
            cursor: 'pointer',
            position: 'relative',
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
                background: 'var(--track-ai-region)',
                borderLeft: '2px solid var(--track-ai-border)',
                borderRight: '2px solid var(--track-ai-border)',
                borderRadius: 2,
              }}
            />
          )}
          <div
            style={{
              height: '100%',
              width: `${progress}%`,
              background: 'var(--accent-cyan)',
              borderRadius: 4,
              position: 'relative',
            }}
          >
            {/* Thumb */}
            <div
              style={{
                position: 'absolute',
                right: -7,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 14,
                height: 14,
                borderRadius: '50%',
                background: '#fff',
                boxShadow: '0 0 8px var(--accent-cyan-dim), 0 1px 3px rgba(0,0,0,0.3)',
                transition: 'transform 0.1s ease',
              }}
            />
          </div>
          {/* Hover tooltip */}
          {seekHover && duration > 0 && (
            <div style={{
              position: 'absolute',
              bottom: '100%',
              left: seekHover.x,
              transform: 'translateX(-50%)',
              marginBottom: 6,
              padding: '2px 6px',
              background: 'rgba(0,0,0,0.75)',
              backdropFilter: 'blur(8px)',
              borderRadius: 'var(--radius-xs)',
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              color: '#fff',
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
            }}>
              {formatTime(seekHover.pct * duration)}
            </div>
          )}
        </div>

        {/* Control buttons row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 6 : 4 }}>
          {/* Left: transport controls */}
          <button onClick={skipBack} style={btnStyle} title="Skip back 10s">
            <SkipBackIcon size={isMobile ? 20 : 16} />
          </button>
          <button onClick={togglePlay} style={{ ...btnStyle, padding: isMobile ? 10 : 6 }}>
            {playing ? <PauseIcon size={isMobile ? 22 : 18} /> : <PlayIcon size={isMobile ? 22 : 18} />}
          </button>
          <button onClick={skipForward} style={btnStyle} title="Skip forward 10s">
            <SkipForwardIcon size={isMobile ? 20 : 16} />
          </button>

          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: isMobile ? 12 : 11,
            color: 'rgba(255,255,255,0.7)',
            marginLeft: 4,
            whiteSpace: 'nowrap',
          }}>
            {formatTime(currentTime)}
          </span>

          <div style={{ flex: 1 }} />

          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: isMobile ? 12 : 11,
            color: 'rgba(255,255,255,0.5)',
            marginRight: 4,
            whiteSpace: 'nowrap',
          }}>
            {formatTime(duration)}
          </span>

          {/* Volume */}
          {!isMobile && (
            <>
              <button
                onClick={() => {
                  const newVol = volume > 0 ? 0 : 1;
                  setVolume(newVol);
                  if (videoRef.current) videoRef.current.volume = newVol;
                }}
                style={btnStyle}
              >
                {volume > 0 ? <VolumeIcon size={16} /> : <VolumeOffIcon size={16} />}
              </button>
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
                style={{ width: 56, accentColor: 'var(--accent-cyan)' }}
              />
            </>
          )}

          {/* Speed */}
          <button
            onClick={changeSpeed}
            style={{
              ...btnStyle,
              background: 'rgba(255,255,255,0.1)',
              borderRadius: 'var(--radius-xs)',
              padding: '2px 8px',
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              fontWeight: 600,
              color: 'rgba(255,255,255,0.8)',
              minWidth: 'auto',
            }}
          >
            {speed}x
          </button>

          {/* Fullscreen */}
          <button onClick={toggleFullscreen} style={btnStyle}>
            {isFullscreen ? <ExitFullscreenIcon size={isMobile ? 20 : 16} /> : <FullscreenIcon size={isMobile ? 20 : 16} />}
          </button>
        </div>
      </div>

      {/* ═══ Audio Waveform Timeline ═══ */}
      {!isFullscreen && (
        <AudioWaveform
          videoSrc={src}
          currentTime={currentTime}
          duration={duration}
          onSeek={handleWaveformSeek}
          clipRegions={clipRegions}
          speakerSegments={speakerSegments}
          height={isMobile ? 36 : 48}
        />
      )}
    </div>
  );
}
