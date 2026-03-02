import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { showToast } from '../components/Toast';
import { buildSubjectKeyframes, smoothKeyframes, interpolateSubjectX, isDynamic, computeClipSubjectX } from '../utils/subjectTracking';
import ClipSettingsPanel from '../components/ClipSettingsPanel';
import TranscriptViewer from '../components/TranscriptViewer';
import useResponsive from '../hooks/useResponsive';
import useEncodingManager from '../hooks/useEncodingManager';

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function parseDuration(str) {
  const trimmed = (str || '').trim();
  if (!trimmed) return null;
  const parts = trimmed.split(':');
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    const s = parseInt(parts[1], 10);
    if (!isNaN(m) && !isNaN(s) && m >= 0 && s >= 0 && s < 60) return m * 60 + s;
    return null;
  }
  const num = parseFloat(trimmed);
  if (!isNaN(num) && num >= 0) return num;
  return null;
}

const DEFAULT_PALETTE = ['#00D9FF', '#F59E0B', '#10B981', '#A78BFA', '#EF4444', '#EC4899'];

// Backend-matching constants (ass_generator.py)
const FONT_SIZE_MAP = { small: 22, medium: 30, large: 40 };
const REF_W = 1920;
const REF_H = 1080;
const ASPECT_RATIO_DIMS = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
};
const ASPECT_RATIO_VALUES = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1.0,
  '4:5': 4 / 5,
};


function splitSegmentsByMaxWords(segments, maxWords) {
  if (!maxWords || maxWords <= 0) return segments;
  const result = [];
  for (const seg of segments) {
    const words = (seg.text || '').split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) { result.push(seg); continue; }
    const totalWords = words.length;
    const duration = seg.end - seg.start;
    let currentTime = seg.start;
    for (let i = 0; i < totalWords; i += maxWords) {
      const chunkWords = words.slice(i, i + maxWords);
      const chunkDuration = duration * (chunkWords.length / totalWords);
      let chunkEnd = currentTime + chunkDuration;
      if (i + maxWords >= totalWords) chunkEnd = seg.end;
      if (chunkEnd - currentTime >= 0.1) {
        result.push({ ...seg, start: currentTime, end: chunkEnd, text: chunkWords.join(' ') });
      }
      currentTime = chunkEnd;
    }
  }
  return result;
}

function getCurrentSubtitle(transcript, currentTime, clipStart, clipEnd) {
  if (!transcript || !transcript.length) return [];
  return transcript.filter((seg) =>
    seg.start <= currentTime && seg.end > currentTime &&
    seg.start < clipEnd && seg.end > clipStart
  );
}

const _WORD_OVERHEAD_S = 0.06;
const _ANTICIPATION_S = 0.0;      // perceptual lead (0 = neutral)
const _AUDIO_BUFFER_S = 0.12;     // compensate for browser audio output lag
function getCurrentWordIndex(segment, relativeTime) {
  if (!segment || !segment.text) return -1;
  const words = segment.text.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return words.length === 1 ? 0 : -1;
  const totalChars = words.reduce((sum, w) => sum + w.length, 0);
  if (totalChars === 0) return -1;
  const segDuration = segment.end - segment.start;
  const elapsed = (relativeTime - segment.start) + _ANTICIPATION_S - _AUDIO_BUFFER_S;
  if (elapsed < 0) return -1;
  const totalOverhead = _WORD_OVERHEAD_S * words.length;
  const charTime = Math.max(segDuration - totalOverhead, segDuration * 0.5);
  const overheadPer = (segDuration - charTime) / words.length;
  let t = 0;
  for (let i = 0; i < words.length; i++) {
    const wordDur = charTime * (words[i].length / totalChars) + overheadPer;
    if (elapsed < t + wordDur) return i;
    t += wordDur;
  }
  return words.length - 1;
}

export default function ClipSEO() {
  const { jobId, clipId } = useParams();
  const [job, setJob] = useState(null);
  const [clip, setClip] = useState(null);
  const [seo, setSeo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [genStatus, setGenStatus] = useState('');
  const [genElapsed, setGenElapsed] = useState(0);
  const [copied, setCopied] = useState(null);
  const [shortsDesc, setShortsDesc] = useState('');
  const [longFormDesc, setLongFormDesc] = useState('');
  const [generatingShorts, setGeneratingShorts] = useState(false);
  const [generatingLongForm, setGeneratingLongForm] = useState(false);

  const videoRef = useRef(null);
  const videoContainerRef = useRef(null);
  const wsRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoContainerSize, setVideoContainerSize] = useState({ w: 0, h: 0 });

  // Clip trim state
  const [startTime, setStartTime] = useState(null);
  const [endTime, setEndTime] = useState(null);
  const [startText, setStartText] = useState('');
  const [endText, setEndText] = useState('');

  // Clip settings — managed by ClipSettingsPanel, received via onSettingsChange
  const [clipSettings, setClipSettings] = useState({});
  const [currentWordIdx, setCurrentWordIdx] = useState(-1);
  const [settingsAppliedFlash, setSettingsAppliedFlash] = useState(false);
  const settingsFlashTimerRef = useRef(null);
  useEffect(() => () => { if (settingsFlashTimerRef.current) clearTimeout(settingsFlashTimerRef.current); }, []);

  // Fullscreen state
  const fullscreenRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Speaker name editing
  const [editingSpeaker, setEditingSpeaker] = useState(null);
  const [editSpeakerValue, setEditSpeakerValue] = useState('');

  // Persistent encoding manager (survives page navigation)
  const encoding = useEncodingManager();
  const exportId = `${jobId}_${clipId}`;
  const exportTask = encoding.tasks[exportId];
  const exporting = exportTask?.status === 'encoding';
  const exportProgress = exporting ? (exportTask?.message || 'Exporting...') : '';
  const downloadUrl = exportTask?.status === 'complete' ? exportTask.downloadUrl : null;

  // Responsive
  const { isMobile } = useResponsive();

  // Derive speakers from job transcript
  const speakers = [];
  (job?.transcript || []).forEach((seg) => {
    if (seg.speaker && !speakers.includes(seg.speaker)) speakers.push(seg.speaker);
  });

  // Destructure clipSettings so existing references work seamlessly
  const {
    aspectRatio = null,
    exportQuality = '1080p',
    subtitlesEnabled = false,
    subtitleFont = 'DM Sans',
    subtitleSize = 30,
    subtitleFontWeight = 'bold',
    subtitleFontColor = '#FFFFFF',
    subtitlePosition = 'bottom',
    useSpeakerColors = true,
    speakerColors = {},
    subtitleBgEnabled = false,
    subtitleBgColor = '#000000',
    subtitleBgOpacity = 75,
    subtitleBgRadius = 0,
    subtitleOutlineColor = '#000000',
    subtitleOutlineOpacity = 100,
    subtitleOutlineWidth = 2,
    showSpeakerLabels = false,
    subtitleMaxWidth = 90,
    subtitleOffsetV = 4,
    subtitleMaxWords = 0,
    activeWordEnabled = false,
    activeWordColor = '#FFD700',
    activeWordOutlineColor = '#000000',
    activeWordBgColor = '#000000',
    activeWordBgOpacity = 0,
  } = clipSettings;

  // Load job data
  useEffect(() => {
    fetch(`/api/jobs/${jobId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data) {
          setJob(data);
          const found = (data.clips || []).find((c) => c.id === parseInt(clipId));
          setClip(found || null);
          if (found) {
            setStartTime(found.start_time);
            setEndTime(found.end_time);
            setStartText(formatDuration(found.start_time));
            setEndText(formatDuration(found.end_time));
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [jobId, clipId]);

  const fetchJob = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      if (res.ok) {
        const data = await res.json();
        setJob(data);
        const found = (data.clips || []).find((c) => c.id === parseInt(clipId));
        if (found) setClip(found);
      }
    } catch {}
  }, [jobId, clipId]);

  // Track fullscreen changes
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // Track video container size for subtitle font scaling
  useEffect(() => {
    const el = videoContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setVideoContainerSize({ w: entry.contentRect.width, h: entry.contentRect.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Parse source dimensions from job resolution
  const sourceDims = useMemo(() => {
    if (job?.resolution) {
      const parts = job.resolution.split('x').map(Number);
      if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
        return { w: parts[0], h: parts[1] };
      }
    }
    return { w: 1920, h: 1080 };
  }, [job?.resolution]);

  // Output dimensions based on aspect ratio (matches clip_exporter.py)
  const outputDims = useMemo(() => {
    if (aspectRatio && ASPECT_RATIO_DIMS[aspectRatio]) {
      return { w: ASPECT_RATIO_DIMS[aspectRatio][0], h: ASPECT_RATIO_DIMS[aspectRatio][1] };
    }
    return sourceDims;
  }, [aspectRatio, sourceDims]);

  // Two-step font scaling matching backend (ass_generator.py:146-158)
  const backendFontScale = useMemo(
    () => Math.min(outputDims.w, outputDims.h) / Math.min(REF_W, REF_H),
    [outputDims],
  );
  const containerScale = useMemo(() => {
    if (videoContainerSize.w === 0) return 0;
    const scaleW = videoContainerSize.w / outputDims.w;
    const scaleH = videoContainerSize.h / outputDims.h;
    return Math.min(scaleW, scaleH);
  }, [videoContainerSize, outputDims]);

  // Compute subject_x with boundary interpolation (matches backend logic)
  const clipSubjectX = useMemo(() => {
    if (!job?.scenes?.length || startTime === null || endTime === null) return 50;
    return computeClipSubjectX(job.scenes, startTime, endTime);
  }, [job?.scenes, startTime, endTime]);

  // Dynamic subject tracking keyframes (with smoothing matching backend)
  const subjectKeyframes = useMemo(
    () => {
      if (!job?.scenes?.length || startTime === null || endTime === null) return null;
      const raw = buildSubjectKeyframes(job.scenes, startTime, endTime);
      return raw && raw.length > 1 ? smoothKeyframes(raw) : raw;
    },
    [job?.scenes, startTime, endTime],
  );

  const clipTimeRange = useMemo(() => {
    if (startTime === null || endTime === null) return null;
    return { start: startTime, end: endTime };
  }, [startTime, endTime]);

  // Determine if cropping is needed for the selected aspect ratio
  const isCrop = useMemo(() => {
    if (!aspectRatio || !ASPECT_RATIO_VALUES[aspectRatio]) return false;
    const srcRatio = sourceDims.w / sourceDims.h;
    return Math.abs(srcRatio - ASPECT_RATIO_VALUES[aspectRatio]) > 0.01;
  }, [aspectRatio, sourceDims]);

  const targetRatio = aspectRatio && ASPECT_RATIO_VALUES[aspectRatio]
    ? ASPECT_RATIO_VALUES[aspectRatio]
    : sourceDims.w / sourceDims.h;

  // Center portrait video by constraining width
  const videoMaxWidth = useMemo(() => {
    if (targetRatio < 1) {
      const maxHpx = (typeof window !== 'undefined' ? window.innerHeight : 900) * 0.45;
      return Math.min(Math.round(maxHpx * targetRatio), 400);
    }
    return undefined;
  }, [targetRatio]);

  // Pre-split transcript segments by max words for subtitle preview
  const splitTranscript = useMemo(() => {
    if (!subtitleMaxWords || !job?.transcript?.length) return job?.transcript || [];
    return splitSegmentsByMaxWords(job.transcript, subtitleMaxWords);
  }, [job?.transcript, subtitleMaxWords]);

  // WebSocket for SEO generation progress only;
  // export progress is handled by the global useEncodingManager hook.
  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/jobs/${jobId}`);
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'status' && msg.status === 'generating_seo') {
          setGenStatus(msg.message || 'Generating...');
        }
      } catch {}
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [jobId]);

  // Video controls for clip preview
  useEffect(() => {
    const video = videoRef.current;
    if (!video || startTime === null) return;

    const onLoaded = () => { video.currentTime = startTime; };
    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      if (endTime && video.currentTime >= endTime) {
        video.pause();
        setPlaying(false);
      }
    };

    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('timeupdate', onTimeUpdate);
    if (video.readyState >= 1) onLoaded();

    return () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('timeupdate', onTimeUpdate);
    };
  }, [startTime, endTime]);

  // Dynamic subject tracking: update objectPosition during playback
  const hasDynamicSubject = useMemo(
    () => isCrop && subjectKeyframes && isDynamic(subjectKeyframes),
    [isCrop, subjectKeyframes],
  );
  useEffect(() => {
    if (!hasDynamicSubject) return;
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      const relTime = video.currentTime - (startTime || 0);
      const sx = interpolateSubjectX(subjectKeyframes, relTime);
      video.style.objectPosition = `${Math.max(0, Math.min(100, Math.round(sx)))}% 50%`;
    };
    video.addEventListener('timeupdate', onTime);
    onTime();
    return () => video.removeEventListener('timeupdate', onTime);
  }, [hasDynamicSubject, subjectKeyframes, startTime]);

  // rAF loop for smooth active word tracking
  useEffect(() => {
    if (!activeWordEnabled || !subtitlesEnabled) { setCurrentWordIdx(-1); return; }
    const video = videoRef.current;
    if (!video) return;
    let animId;
    let prevIdx = -1;
    const tick = () => {
      const active = getCurrentSubtitle(splitTranscript, video.currentTime, startTime || 0, endTime || Infinity);
      if (active.length > 0) {
        const idx = getCurrentWordIndex(active[0], video.currentTime);
        if (idx !== prevIdx) { prevIdx = idx; setCurrentWordIdx(idx); }
      } else if (prevIdx !== -1) {
        prevIdx = -1;
        setCurrentWordIdx(-1);
      }
      animId = requestAnimationFrame(tick);
    };
    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [activeWordEnabled, subtitlesEnabled, splitTranscript, startTime, endTime]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video || startTime === null) return;
    if (video.paused) {
      if (endTime && video.currentTime >= endTime) video.currentTime = startTime;
      video.play().then(() => setPlaying(true)).catch(() => {});
    } else {
      video.pause();
      setPlaying(false);
    }
  };

  const toggleFullscreen = () => {
    const el = fullscreenRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen().catch(() => {});
    }
  };

  const handleRenameSpeaker = async (oldName, newName) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) {
      setEditingSpeaker(null);
      return;
    }
    try {
      const res = await fetch(`/api/jobs/${jobId}/speakers`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speaker_names: { [oldName]: trimmed } }),
      });
      if (res.ok) {
        await fetchJob();
        showToast(`Renamed "${oldName}" to "${trimmed}"`, 'success');
      }
    } catch {
      showToast('Speaker rename failed', 'error');
    }
    setEditingSpeaker(null);
  };

  const generateSEO = useCallback(async () => {
    setGenerating(true);
    setGenElapsed(0);
    setGenStatus('Connecting to AI provider...');

    const startMs = Date.now();
    const timerInterval = setInterval(() => {
      setGenElapsed(Math.floor((Date.now() - startMs) / 1000));
    }, 1000);

    const statusInterval = setInterval(() => {
      setGenStatus((prev) => {
        const msgs = [
          'Connecting to AI provider...',
          'Analyzing clip transcript...',
          'Generating SEO metadata...',
          'Crafting title and caption...',
          'Picking tags...',
          'Almost done...',
        ];
        const idx = msgs.indexOf(prev);
        return msgs[Math.min(idx + 1, msgs.length - 1)];
      });
    }, 4000);

    try {
      const res = await fetch(`/api/jobs/${jobId}/seo/${clipId}`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'SEO generation failed');
      }
      const data = await res.json();
      setSeo(data.seo);
      showToast(`SEO generated via ${data.provider}`, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      clearInterval(statusInterval);
      clearInterval(timerInterval);
      setGenerating(false);
      setGenStatus('');
      setGenElapsed(0);
    }
  }, [jobId, clipId]);

  const generateDescription = useCallback(async (descType) => {
    const isShorts = descType === 'shorts';
    const setter = isShorts ? setShortsDesc : setLongFormDesc;
    const setLoading = isShorts ? setGeneratingShorts : setGeneratingLongForm;
    setLoading(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/generate-description/${clipId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description_type: descType }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Description generation failed');
      }
      const data = await res.json();
      setter(data.description || '');
      showToast(`${isShorts ? 'Shorts' : 'YouTube'} description generated via ${data.provider}`, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [jobId, clipId]);

  const handleExport = useCallback(() => {
    if (startTime === null || endTime === null) return;
    const body = {
      start: startTime,
      end: endTime,
      clip_id: parseInt(clipId),
      clip_title: clip?.title || `Clip ${clipId}`,
      aspect_ratio: aspectRatio,
      export_quality: exportQuality || '1080p',
      subtitles_enabled: subtitlesEnabled,
    };
    if (subtitlesEnabled) {
      body.subtitle_settings = {
        font: subtitleFont,
        size: subtitleSize,
        font_weight: subtitleFontWeight,
        font_color: subtitleFontColor,
        position: subtitlePosition,
        speaker_colors: speakerColors,
        use_speaker_colors: useSpeakerColors,
        background_enabled: subtitleBgEnabled,
        background_color: subtitleBgColor,
        background_opacity: subtitleBgOpacity,
        background_radius: subtitleBgRadius,
        outline_color: subtitleOutlineColor,
        outline_opacity: subtitleOutlineOpacity,
        outline_width: subtitleOutlineWidth,
        show_speaker_labels: showSpeakerLabels,
        max_width: subtitleMaxWidth,
        offset_v: subtitleOffsetV,
        max_words: subtitleMaxWords,
        active_word_enabled: activeWordEnabled,
        active_word_color: activeWordColor,
        active_word_outline_color: activeWordOutlineColor,
        active_word_bg_color: activeWordBgColor,
        active_word_bg_opacity: activeWordBgOpacity,
      };
    }
    encoding.startExport(jobId, parseInt(clipId), clip?.title || `Clip ${clipId}`, body);
    showToast(`Exporting "${clip?.title || `Clip ${clipId}`}"...`, 'info');
  }, [jobId, clipId, clip, startTime, endTime, clipSettings, encoding]);

  const handleApplySettings = useCallback((applied) => {
    setClipSettings(applied);
    setSettingsAppliedFlash(true);
    if (settingsFlashTimerRef.current) clearTimeout(settingsFlashTimerRef.current);
    settingsFlashTimerRef.current = setTimeout(() => setSettingsAppliedFlash(false), 1800);
    showToast('Settings applied to preview & export', 'success');
  }, []);

  const copyToClipboard = (text, label) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-secondary)' }}>
        <div style={{
          width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent-cyan)',
          borderRadius: '50%', animation: 'spin 0.8s linear infinite',
          margin: '0 auto 12px',
        }} />
        Loading clip editor...
      </div>
    );
  }

  if (!job || !clip) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <div style={{ color: 'var(--danger)', marginBottom: 16 }}>Clip not found</div>
        <Link to="/clips" style={{ color: 'var(--accent-cyan)' }}>Back to Viral Clips</Link>
      </div>
    );
  }

  const videoExt = job.file_path?.split('.').pop() || 'mp4';
  const videoSrc = `/api/files/${jobId}/video.${videoExt}`;
  const clipDur = (endTime || clip.end_time) - (startTime || clip.start_time);
  const elapsed = Math.max(0, Math.min(clipDur, currentTime - (startTime || clip.start_time)));
  const progress = clipDur > 0 ? (elapsed / clipDur) * 100 : 0;
  const scoreColor = clip.viral_score >= 80 ? 'var(--accent-amber)' : clip.viral_score >= 50 ? 'var(--accent-cyan)' : 'var(--text-secondary)';

  const sectionStyle = {
    background: 'var(--bg-panel)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    padding: 16,
    marginBottom: 16,
  };

  const copyBtnStyle = (label) => ({
    padding: '4px 10px',
    fontSize: 10,
    background: copied === label ? 'var(--accent-cyan)' : 'var(--bg-elevated)',
    color: copied === label ? 'var(--bg-base)' : 'var(--text-muted)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    fontFamily: 'var(--font-mono)',
  });

  const timeInput = {
    width: '100%',
    padding: '5px 8px',
    fontSize: 13,
    fontFamily: 'var(--font-mono)',
    background: 'var(--bg-elevated)',
    color: 'var(--accent-cyan)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    outline: 'none',
  };

  return (
    <div>
      {/* Shared keyframes */}
      <style>{`
        @keyframes seo-spin { to { transform: rotate(360deg); } }
        @keyframes seo-pulse { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } }
      `}</style>

      {/* Breadcrumb */}
      <div style={{ marginBottom: 16, fontSize: 12, color: 'var(--text-muted)' }}>
        <Link to="/clips" style={{ color: 'var(--accent-cyan)', textDecoration: 'none' }}>Viral Clips</Link>
        {' / '}
        <Link to={`/analysis/${jobId}`} style={{ color: 'var(--accent-cyan)', textDecoration: 'none' }}>{job.filename}</Link>
        {' / '}
        <span style={{ color: 'var(--text-primary)' }}>SEO — Clip {clipId}</span>
      </div>

      <div className="clip-panel-layout" style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: isMobile ? 'wrap' : 'nowrap', flexDirection: isMobile ? 'column' : 'row' }}>
        {/* Left column: Video preview + clip info + export settings */}
        <div className="clip-settings-sidebar" style={{ width: isMobile ? '100%' : 320, position: isMobile ? 'static' : 'sticky', top: 20, alignSelf: 'flex-start' }}>
          {/* Video Preview */}
          <div ref={fullscreenRef} style={isFullscreen ? { display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--video-bg)', width: '100vw', height: '100vh' } : { ...sectionStyle, padding: 0, overflow: 'hidden', maxWidth: videoMaxWidth, margin: videoMaxWidth ? '0 auto' : undefined }}>
            <div ref={videoContainerRef} style={{ position: 'relative', background: 'var(--video-bg)', cursor: 'pointer', overflow: 'hidden', aspectRatio: `${targetRatio}`, ...(isFullscreen ? { height: '100vh', maxWidth: '100vw', width: 'auto' } : { maxHeight: '45vh' }) }} onClick={togglePlay}>
              <video
                ref={videoRef}
                src={videoSrc}
                style={{
                  width: '100%',
                  height: '100%',
                  display: 'block',
                  objectFit: isCrop ? 'cover' : 'contain',
                  objectPosition: isCrop ? `${Math.max(0, Math.min(100, hasDynamicSubject && subjectKeyframes?.length ? subjectKeyframes[0].x : clipSubjectX))}% 50%` : undefined,
                }}
              />
              {!playing && (
                <div style={{
                  position: 'absolute', inset: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'var(--overlay-light)',
                }}>
                  <div style={{
                    width: 48, height: 48, borderRadius: '50%',
                    background: 'var(--overlay-heavy)', border: '2px solid var(--video-controls-text)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 20, color: 'var(--video-controls-text)', paddingLeft: 3,
                  }}>&#9654;</div>
                </div>
              )}

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

              {/* Subtitle preview overlay — two-step scaling matching ClipPreview.jsx & backend */}
              {subtitlesEnabled && (() => {
                const activeSegs = getCurrentSubtitle(splitTranscript, currentTime, startTime || 0, endTime || Infinity);

                // Two-step font size: basePx * backendFontScale → backendPx, then * containerScale → displayPx
                const basePx = typeof subtitleSize === 'number' ? subtitleSize : (FONT_SIZE_MAP[subtitleSize] || 30);
                const backendPx = Math.max(16, Math.round(basePx * backendFontScale));
                const fontPx = containerScale > 0 ? Math.max(8, Math.round(backendPx * containerScale)) : 14;

                // Margin calculations matching backend (ass_generator.py:196-235)
                const clampedMaxWidth = Math.max(50, Math.min(100, subtitleMaxWidth));
                const clampedOffsetV = Math.max(0, Math.min(100, subtitleOffsetV));
                const seoMarginH_px = Math.max(20, Math.floor(outputDims.w * (100 - clampedMaxWidth) / 100 / 2));
                const seoMaxMarginH = Math.floor(outputDims.w * 0.25);
                const marginHPct = Math.min(seoMarginH_px, seoMaxMarginH) / outputDims.w * 100;
                // Vertical: direct percentage from user setting — matches backend (ass_generator.py:227-230)
                const effectiveOffsetV = subtitlePosition === 'center' ? 0 : clampedOffsetV;

                const posStyle = subtitlePosition === 'top'
                  ? { top: `${effectiveOffsetV}%` }
                  : subtitlePosition === 'center'
                    ? { top: '50%', transform: 'translateY(-50%)' }
                    : { bottom: `${effectiveOffsetV}%` };

                // Two-step outline width scaling (ass_generator.py:161) — clamp values to match backend
                const olHex = (subtitleOutlineColor || '#000000').replace('#', '');
                const olR = parseInt(olHex.substring(0, 2), 16) || 0;
                const olG = parseInt(olHex.substring(2, 4), 16) || 0;
                const olB = parseInt(olHex.substring(4, 6), 16) || 0;
                const olOpacity = Math.max(0, Math.min(100, subtitleOutlineOpacity ?? 100)) / 100;
                const olWidth = Math.max(0, Math.min(10, subtitleOutlineWidth ?? 2));
                const backendOlWidth = Math.max(0, Math.round(olWidth * backendFontScale));
                const scaledOlWidth = containerScale > 0 ? Math.max(0, Math.round(backendOlWidth * containerScale)) : 0;
                let outlineStyle;
                if (subtitleBgEnabled) {
                  // Background box mode — no visible outline (blends into box in ASS)
                  outlineStyle = {};
                } else if (scaledOlWidth > 0) {
                  // Outline mode — shadow depth matches ASS: proportional to outline width, capped 1-4
                  const shadowDepth = Math.max(1, Math.min(4, Math.round(backendOlWidth * 0.75)));
                  const scaledShadow = Math.max(1, Math.round(shadowDepth * containerScale));
                  outlineStyle = {
                    WebkitTextStroke: `${scaledOlWidth}px rgba(${olR},${olG},${olB},${olOpacity})`,
                    paintOrder: 'stroke fill',
                    textShadow: `${scaledShadow}px ${scaledShadow}px 0px rgba(0,0,0,0.5)`,
                  };
                } else {
                  // No outline, no background — minimal shadow for readability
                  outlineStyle = {
                    textShadow: '1px 1px 2px rgba(0,0,0,0.8)',
                  };
                }

                // Show active transcript segments, or sample text when paused/no active segment
                const hasActive = activeSegs.length > 0;
                const displaySegs = hasActive
                  ? activeSegs.slice(0, 2)
                  : (speakers.length > 0
                    ? [{ speaker: speakers[0], text: 'Subtitle preview text...' }]
                    : [{ speaker: 'Speaker', text: 'Subtitle preview text...' }]);

                return (
                  <div style={{
                    position: 'absolute',
                    left: `${marginHPct}%`,
                    right: `${marginHPct}%`,
                    ...posStyle,
                    textAlign: 'center',
                    pointerEvents: 'none',
                    zIndex: 3,
                    opacity: hasActive ? 1 : 0.5,
                  }}>
                    <div style={{
                      display: 'inline-block',
                      ...(subtitleBgEnabled ? {
                        background: `${subtitleBgColor}${Math.round(subtitleBgOpacity / 100 * 255).toString(16).padStart(2, '0')}`,
                        // ASS BorderStyle=3 creates a rectangular box (no border-radius
                        // support).  Omit border-radius to match the exported video.
                        padding: `${Math.max(2, Math.round(4 * backendFontScale * containerScale))}px ${Math.max(4, Math.round(8 * backendFontScale * containerScale))}px`,
                      } : {}),
                    }}>
                      {displaySegs.map((seg, i) => {
                        const speakerColor = speakerColors[seg.speaker] || DEFAULT_PALETTE[speakers.indexOf(seg.speaker) % DEFAULT_PALETTE.length] || '#FFFFFF';
                        const color = useSpeakerColors ? speakerColor : subtitleFontColor;
                        return (
                          <div key={i} style={{
                            fontFamily: subtitleFont,
                            fontSize: fontPx,
                            fontWeight: subtitleFontWeight === 'bold' ? 700 : 400,
                            color,
                            lineHeight: 1.4,
                            ...outlineStyle,
                            wordWrap: 'break-word',
                            overflowWrap: 'break-word',
                            whiteSpace: 'pre-wrap',
                            marginTop: i > 0 ? 2 : 0,
                          }}>
                            {showSpeakerLabels ? `${seg.speaker}: ` : ''}{(() => {
                              if (activeWordEnabled && hasActive && currentWordIdx >= 0 && i === 0) {
                                const words = seg.text.split(/\s+/).filter(Boolean);
                                const awOlHex = activeWordOutlineColor.replace('#', '');
                                const awOlR = parseInt(awOlHex.substring(0, 2), 16) || 0;
                                const awOlG = parseInt(awOlHex.substring(2, 4), 16) || 0;
                                const awOlB = parseInt(awOlHex.substring(4, 6), 16) || 0;
                                const scaledOl = scaledOlWidth;
                                return words.map((w, wi) => {
                                  const isActive = wi === currentWordIdx;
                                  const wStyle = isActive ? {
                                    color: activeWordColor,
                                    ...(scaledOl > 0 ? {
                                      WebkitTextStroke: `${scaledOl}px rgba(${awOlR},${awOlG},${awOlB},${(subtitleOutlineOpacity ?? 100) / 100})`,
                                      paintOrder: 'stroke fill',
                                    } : {}),
                                    ...(activeWordBgOpacity > 0 ? {
                                      backgroundColor: `${activeWordBgColor}${Math.round(activeWordBgOpacity / 100 * 255).toString(16).padStart(2, '0')}`,
                                      borderRadius: 2,
                                      padding: '0 2px',
                                    } : {}),
                                  } : {};
                                  return <span key={wi} style={wStyle}>{w}{wi < words.length - 1 ? ' ' : ''}</span>;
                                });
                              }
                              return seg.text;
                            })()}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </div>
            <div style={{ padding: '6px 12px', background: 'var(--bg-elevated)' }}>
              <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, marginBottom: 6 }}>
                <div style={{ height: '100%', width: `${progress}%`, background: 'var(--accent-cyan)', borderRadius: 2 }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                <span>{formatDuration(elapsed)} / {formatDuration(clipDur)}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>{formatDuration(startTime)} &rarr; {formatDuration(endTime)}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }}
                    style={{
                      background: 'none', border: 'none', color: 'var(--text-muted)',
                      fontSize: 14, cursor: 'pointer', padding: '0 2px', lineHeight: 1,
                    }}
                    title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                  >
                    {isFullscreen ? '\u2715' : '\u26F6'}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Clip info */}
          <div style={sectionStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ fontSize: 16, margin: 0 }}>{clip.title}</h3>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 700, color: scoreColor }}>
                {clip.viral_score}<span style={{ fontSize: 10, color: 'var(--text-muted)' }}>/100</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              <span className={`badge ${clip.platform === 'tiktok' ? 'badge-cyan' : clip.platform === 'youtube_shorts' ? 'badge-red' : 'badge-gray'}`}>
                {clip.platform.replace('_', ' ')}
              </span>
              <span className="badge badge-gray">{clip.clip_type}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
                {formatDuration(clipDur)}
              </span>
            </div>
            {clip.hook_text && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
                <strong style={{ color: 'var(--text-primary)' }}>Hook:</strong> {clip.hook_text}
              </div>
            )}
            {clip.why_this_works && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                <strong style={{ color: 'var(--text-primary)' }}>Why it works:</strong> {clip.why_this_works}
              </div>
            )}
          </div>

          {/* Trim Controls */}
          <div style={sectionStyle}>
            <div style={{ fontSize: 13, fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Trim
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>Start</div>
                <input
                  type="text"
                  value={startText}
                  onChange={(e) => setStartText(e.target.value)}
                  onBlur={() => {
                    const val = parseDuration(startText);
                    if (val !== null && val >= 0 && val < (endTime || clip.end_time)) {
                      setStartTime(val);
                      setStartText(formatDuration(val));
                      if (videoRef.current) videoRef.current.currentTime = val;
                    } else {
                      setStartText(formatDuration(startTime));
                    }
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                  style={timeInput}
                />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>End</div>
                <input
                  type="text"
                  value={endText}
                  onChange={(e) => setEndText(e.target.value)}
                  onBlur={() => {
                    const val = parseDuration(endText);
                    if (val !== null && val > (startTime || 0)) {
                      setEndTime(val);
                      setEndText(formatDuration(val));
                    } else {
                      setEndText(formatDuration(endTime));
                    }
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                  style={timeInput}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <button
                  onClick={() => {
                    setStartTime(clip.start_time);
                    setEndTime(clip.end_time);
                    setStartText(formatDuration(clip.start_time));
                    setEndText(formatDuration(clip.end_time));
                    if (videoRef.current) videoRef.current.currentTime = clip.start_time;
                  }}
                  title="Reset to original clip times"
                  style={{
                    padding: '5px 8px', fontSize: 10,
                    background: 'var(--bg-elevated)', color: 'var(--text-muted)',
                    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer', whiteSpace: 'nowrap',
                  }}
                >
                  Reset
                </button>
              </div>
            </div>
          </div>

          {/* Subject Tracking Controls */}
          {job.scenes?.length > 0 && (
            <div style={sectionStyle}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <button
                  onClick={async () => {
                    try {
                      const res = await fetch(`/api/jobs/${jobId}/recenter-subject`, { method: 'POST' });
                      if (res.ok) {
                        const r2 = await fetch(`/api/jobs/${jobId}`);
                        if (r2.ok) setJob(await r2.json());
                      }
                    } catch {}
                  }}
                  style={{
                    flex: 1,
                    padding: '8px 14px',
                    fontSize: 11,
                    fontWeight: 600,
                    background: 'var(--bg-elevated)',
                    color: 'var(--accent-cyan)',
                    border: '1px solid var(--accent-cyan)',
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.03em',
                  }}
                >
                  Reset Subject to Center
                </button>
                <button
                  onClick={async () => {
                    try {
                      const res = await fetch(`/api/jobs/${jobId}/reanalyze-subject`, { method: 'POST' });
                      if (res.ok) {
                        // Poll for completion — the WebSocket on the analysis page handles updates,
                        // but ClipSEO doesn't have a WS. Fetch after a delay.
                        setTimeout(async () => {
                          const r2 = await fetch(`/api/jobs/${jobId}`);
                          if (r2.ok) setJob(await r2.json());
                        }, 15000);
                      }
                    } catch {}
                  }}
                  style={{
                    flex: 1,
                    padding: '8px 14px',
                    fontSize: 11,
                    fontWeight: 600,
                    background: 'var(--accent-cyan)',
                    color: 'var(--bg-base)',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.03em',
                  }}
                >
                  Re-analyze AI
                </button>
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {aspectRatio ? 'Controls where the crop follows the subject in preview & export' : 'Select an aspect ratio to see subject tracking effect'}
              </div>
              {/* Show detected subject for this clip */}
              {clip && (() => {
                const st = startTime ?? clip.start_time;
                const et = endTime ?? clip.end_time;
                const inRange = (job.scenes || []).filter(
                  (s) => s.timestamp >= st && s.timestamp <= et
                );
                if (!inRange.length) return null;
                const best = inRange.reduce((a, b) => (b.importance_score > a.importance_score ? b : a), inRange[0]);
                return (
                  <div style={{
                    marginTop: 6, padding: '6px 8px', fontSize: 11, color: 'var(--text-muted)',
                    background: 'var(--bg-base)', borderRadius: 'var(--radius-sm)',
                    borderLeft: '2px solid var(--accent-cyan)', lineHeight: 1.4,
                  }}>
                    <span style={{ fontWeight: 600, color: 'var(--text-secondary)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                      Detected subject:
                    </span>{' '}
                    {best.description.length > 120 ? best.description.slice(0, 120) + '...' : best.description}
                    <span style={{ marginLeft: 6, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--accent-cyan)' }}>
                      x={best.subject_x ?? 50}%
                    </span>
                  </div>
                );
              })()}
            </div>
          )}

          {/* Clip Settings Panel */}
          <div style={{ marginBottom: 16 }}>
            <ClipSettingsPanel
              speakers={speakers}
              speakerNames={job.speaker_names}
              videoResolution={job.resolution}
              onSettingsChange={setClipSettings}
              onApplySettings={handleApplySettings}
            />
          </div>

          {/* Speaker Renaming */}
          {speakers.length > 0 && (
            <div style={sectionStyle}>
              <div style={{ fontSize: 13, fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Rename Speakers
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {speakers.map((sp) => {
                  const isEditing = editingSpeaker === sp;
                  return (
                    <div key={sp} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {isEditing ? (
                        <input
                          type="text"
                          value={editSpeakerValue}
                          onChange={(e) => setEditSpeakerValue(e.target.value)}
                          onBlur={() => handleRenameSpeaker(sp, editSpeakerValue)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRenameSpeaker(sp, editSpeakerValue);
                            if (e.key === 'Escape') setEditingSpeaker(null);
                          }}
                          autoFocus
                          style={{
                            flex: 1, fontSize: 13, color: 'var(--text-primary)',
                            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-sm)', padding: '4px 8px', outline: 'none',
                            fontFamily: 'var(--font-mono)',
                          }}
                        />
                      ) : (
                        <span
                          onClick={() => { setEditingSpeaker(sp); setEditSpeakerValue(sp); }}
                          style={{ fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'var(--font-mono)' }}
                          title="Click to rename"
                        >
                          {sp}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Export Button */}
          <div style={sectionStyle}>
            {exporting ? (
              <div style={{ textAlign: 'center', padding: '8px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                  <div style={{
                    width: 20, height: 20,
                    border: '2px solid var(--border)',
                    borderTop: '2px solid var(--accent-cyan)',
                    borderRadius: '50%',
                    animation: 'seo-spin 1s linear infinite',
                  }} />
                  <span style={{ fontSize: 12, color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>
                    {exportProgress || 'Exporting...'}
                  </span>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  onClick={handleExport}
                  style={{
                    flex: 1, padding: '10px 16px',
                    background: 'var(--accent-cyan)', color: 'var(--bg-base)',
                    border: 'none', borderRadius: 'var(--radius-sm)',
                    fontSize: 13, fontWeight: 700, cursor: 'pointer',
                  }}
                >
                  Export MP4
                </button>
                {downloadUrl && (
                  <a
                    href={downloadUrl}
                    download
                    style={{
                      padding: '10px 16px',
                      background: 'var(--bg-elevated)', color: 'var(--accent-cyan)',
                      border: '1px solid var(--accent-cyan)', borderRadius: 'var(--radius-sm)',
                      fontSize: 12, fontWeight: 600, textDecoration: 'none',
                      display: 'flex', alignItems: 'center',
                    }}
                  >
                    Download Again
                  </a>
                )}
              </div>
            )}

            <div style={{ marginTop: 8, fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <span>{formatDuration(startTime)} - {formatDuration(endTime)}</span>
              <span>{aspectRatio || 'original'}</span>
              {subtitlesEnabled && <span style={{ color: 'var(--accent-cyan)' }}>subs: {subtitleFont} / {subtitleSize} / {subtitleFontWeight} / {subtitlePosition} / {subtitleMaxWidth}%w{subtitleMaxWords > 0 ? ` / ${subtitleMaxWords}w` : ''}</span>}
              {settingsAppliedFlash && (
                <span style={{
                  color: '#10B981',
                  fontWeight: 600,
                  animation: 'seo-pulse 1.5s ease-in-out',
                }}>
                  Settings applied
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Right column: SEO content */}
        <div style={{ flex: '1 1 auto', minWidth: 0, overflowY: 'auto', maxHeight: isMobile ? 'none' : 'calc(100vh - 100px)' }}>
          {!seo ? (
            <div style={{ ...sectionStyle, textAlign: 'center', padding: '48px 24px' }}>
              {generating ? (
                <>
                  <div style={{
                    width: 48, height: 48, margin: '0 auto 16px',
                    border: '3px solid var(--border)',
                    borderTop: '3px solid var(--accent-cyan)',
                    borderRadius: '50%',
                    animation: 'seo-spin 1s linear infinite',
                  }} />
                  <h3 style={{ fontSize: 16, marginBottom: 8, color: 'var(--text-primary)' }}>
                    Generating SEO...
                  </h3>
                  <p style={{
                    fontSize: 12, color: 'var(--accent-cyan)',
                    animation: 'seo-pulse 2s ease-in-out infinite',
                    fontFamily: 'var(--font-mono)',
                  }}>
                    {genStatus}
                  </p>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12, fontFamily: 'var(--font-mono)' }}>
                    {genElapsed}s elapsed
                  </p>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 36, marginBottom: 16, opacity: 0.3 }}>&#128269;</div>
                  <h3 style={{ fontSize: 16, marginBottom: 8, color: 'var(--text-secondary)' }}>
                    Generate SEO Metadata
                  </h3>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20, maxWidth: 360, margin: '0 auto 20px' }}>
                    Use AI to generate a title, caption, and tags for this clip — written like a real person would post it
                  </p>
                  <button
                    onClick={generateSEO}
                    style={{
                      padding: '10px 24px',
                      background: 'var(--accent-cyan)', color: 'var(--bg-base)',
                      border: 'none', borderRadius: 'var(--radius-sm)',
                      fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    Generate SEO
                  </button>
                </>
              )}
            </div>
          ) : (
            <>
              {/* Copy All — ready to paste */}
              <div style={{ ...sectionStyle, background: 'var(--accent-cyan-dim)', borderColor: 'var(--accent-cyan)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent-cyan)' }}>
                    Ready to post
                  </div>
                  <button
                    onClick={() => copyToClipboard(
                      `${seo.title}\n\n${seo.description}\n\n${(seo.tags || []).join(' ')}`,
                      'all'
                    )}
                    style={{
                      padding: '6px 14px', fontSize: 11, fontWeight: 600,
                      background: copied === 'all' ? 'var(--accent-cyan)' : 'var(--bg-panel)',
                      color: copied === 'all' ? 'var(--bg-base)' : 'var(--accent-cyan)',
                      border: '1px solid var(--accent-cyan)', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                    }}
                  >
                    {copied === 'all' ? 'Copied!' : 'Copy All'}
                  </button>
                </div>
              </div>

              {/* Title */}
              <div style={sectionStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                    Title
                  </div>
                  <button onClick={() => copyToClipboard(seo.title, 'title')} style={copyBtnStyle('title')}>
                    {copied === 'title' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.4 }}>
                  {seo.title}
                </div>
              </div>

              {/* Caption */}
              <div style={sectionStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                    Caption
                  </div>
                  <button onClick={() => copyToClipboard(seo.description, 'desc')} style={copyBtnStyle('desc')}>
                    {copied === 'desc' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  {seo.description}
                </div>
              </div>

              {/* Tags */}
              <div style={sectionStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                    Tags
                  </div>
                  <button onClick={() => copyToClipboard((seo.tags || []).join(' '), 'tags')} style={copyBtnStyle('tags')}>
                    {copied === 'tags' ? 'Copied' : 'Copy All'}
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(seo.tags || []).map((tag, i) => (
                    <span
                      key={i}
                      onClick={() => copyToClipboard(tag, `tag-${i}`)}
                      style={{
                        padding: '4px 10px',
                        background: 'var(--bg-elevated)',
                        border: '1px solid var(--border)',
                        borderRadius: 12, fontSize: 12,
                        color: 'var(--accent-cyan)', cursor: 'pointer',
                      }}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>

              {/* Platform Tips */}
              {seo.platform_tips && (
                <div style={{ ...sectionStyle, background: 'var(--bg-elevated)', borderStyle: 'dashed' }}>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, fontStyle: 'italic' }}>
                    {seo.platform_tips}
                  </div>
                </div>
              )}

              {/* Regenerate with inline status */}
              {generating ? (
                <div style={{
                  ...sectionStyle,
                  borderColor: 'var(--accent-cyan)',
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '12px 16px',
                }}>
                  <div style={{
                    width: 18, height: 18, flexShrink: 0,
                    border: '2px solid var(--border)',
                    borderTop: '2px solid var(--accent-cyan)',
                    borderRadius: '50%',
                    animation: 'seo-spin 1s linear infinite',
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12, color: 'var(--accent-cyan)',
                      fontFamily: 'var(--font-mono)',
                      animation: 'seo-pulse 2s ease-in-out infinite',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {genStatus}
                    </div>
                  </div>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
                    {genElapsed}s
                  </span>
                </div>
              ) : (
                <button
                  onClick={generateSEO}
                  style={{
                    padding: '8px 16px',
                    background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
                    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                    fontSize: 12, cursor: 'pointer',
                  }}
                >
                  Regenerate
                </button>
              )}
            </>
          )}

          {/* ── YouTube Description Generators ─────────────────────── */}
          <div style={{ marginTop: 24 }} id="youtube-descriptions">
            <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>
              YouTube Description Generators
            </div>

            {/* YouTube Shorts Description */}
            <div style={sectionStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                  YouTube Shorts Description
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {shortsDesc && (
                    <button
                      onClick={() => copyToClipboard(shortsDesc, 'shorts')}
                      style={{
                        padding: '4px 10px', fontSize: 11, fontWeight: 600,
                        background: copied === 'shorts' ? 'var(--accent-cyan)' : 'var(--bg-panel)',
                        color: copied === 'shorts' ? 'var(--bg-base)' : 'var(--accent-cyan)',
                        border: '1px solid var(--accent-cyan)', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                      }}
                    >
                      {copied === 'shorts' ? 'Copied!' : 'Copy'}
                    </button>
                  )}
                  <button
                    onClick={() => generateDescription('shorts')}
                    disabled={generatingShorts}
                    style={{
                      padding: '4px 10px', fontSize: 11, fontWeight: 600,
                      background: generatingShorts ? 'var(--bg-elevated)' : 'var(--accent-cyan)',
                      color: generatingShorts ? 'var(--text-muted)' : 'var(--bg-base)',
                      border: 'none', borderRadius: 'var(--radius-sm)',
                      cursor: generatingShorts ? 'default' : 'pointer',
                    }}
                  >
                    {generatingShorts ? 'Generating...' : (shortsDesc ? 'Regenerate' : 'Generate')}
                  </button>
                </div>
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                Optimized for YouTube Shorts SEO — hook line, keywords, hashtags, CTA. Under 500 characters.
              </p>
              {shortsDesc ? (
                <textarea
                  value={shortsDesc}
                  onChange={(e) => setShortsDesc(e.target.value)}
                  style={{
                    width: '100%', minHeight: 120, padding: 10,
                    background: 'var(--bg-elevated)', color: 'var(--text-primary)',
                    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                    fontSize: 13, lineHeight: 1.5, resize: 'vertical',
                    fontFamily: 'var(--font-sans)',
                  }}
                />
              ) : !generatingShorts ? (
                <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                  Click "Generate" to create a Shorts-optimized description
                </div>
              ) : (
                <div style={{ padding: '20px 0', textAlign: 'center' }}>
                  <div style={{
                    width: 20, height: 20, margin: '0 auto 8px',
                    border: '2px solid var(--border)',
                    borderTop: '2px solid var(--accent-cyan)',
                    borderRadius: '50%',
                    animation: 'seo-spin 1s linear infinite',
                  }} />
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Generating Shorts description...</span>
                </div>
              )}
            </div>

            {/* YouTube Long-Form Description */}
            <div style={sectionStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                  YouTube Description
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {longFormDesc && (
                    <button
                      onClick={() => copyToClipboard(longFormDesc, 'longform')}
                      style={{
                        padding: '4px 10px', fontSize: 11, fontWeight: 600,
                        background: copied === 'longform' ? 'var(--accent-cyan)' : 'var(--bg-panel)',
                        color: copied === 'longform' ? 'var(--bg-base)' : 'var(--accent-cyan)',
                        border: '1px solid var(--accent-cyan)', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                      }}
                    >
                      {copied === 'longform' ? 'Copied!' : 'Copy'}
                    </button>
                  )}
                  <button
                    onClick={() => generateDescription('long_form')}
                    disabled={generatingLongForm}
                    style={{
                      padding: '4px 10px', fontSize: 11, fontWeight: 600,
                      background: generatingLongForm ? 'var(--bg-elevated)' : 'var(--accent-cyan)',
                      color: generatingLongForm ? 'var(--text-muted)' : 'var(--bg-base)',
                      border: 'none', borderRadius: 'var(--radius-sm)',
                      cursor: generatingLongForm ? 'default' : 'pointer',
                    }}
                  >
                    {generatingLongForm ? 'Generating...' : (longFormDesc ? 'Regenerate' : 'Generate')}
                  </button>
                </div>
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                Full YouTube description with keywords, timestamps, hashtags, and social links. 500-2000 characters.
              </p>
              {longFormDesc ? (
                <textarea
                  value={longFormDesc}
                  onChange={(e) => setLongFormDesc(e.target.value)}
                  style={{
                    width: '100%', minHeight: 200, padding: 10,
                    background: 'var(--bg-elevated)', color: 'var(--text-primary)',
                    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                    fontSize: 13, lineHeight: 1.5, resize: 'vertical',
                    fontFamily: 'var(--font-sans)',
                  }}
                />
              ) : !generatingLongForm ? (
                <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                  Click "Generate" to create a full YouTube description
                </div>
              ) : (
                <div style={{ padding: '20px 0', textAlign: 'center' }}>
                  <div style={{
                    width: 20, height: 20, margin: '0 auto 8px',
                    border: '2px solid var(--border)',
                    borderTop: '2px solid var(--accent-cyan)',
                    borderRadius: '50%',
                    animation: 'seo-spin 1s linear infinite',
                  }} />
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Generating YouTube description...</span>
                </div>
              )}
            </div>
          </div>

          {/* ── Clip Transcript ─────────────────────────────────────── */}
          {job?.transcript?.length > 0 && clipTimeRange && (
            <div style={{ marginTop: 24 }}>
              <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>
                Clip Transcript
              </div>
              <div style={sectionStyle}>
                <TranscriptViewer
                  transcript={job.transcript}
                  timeRange={clipTimeRange}
                  onSeek={(time) => {
                    const video = videoRef.current;
                    if (video) {
                      video.currentTime = time;
                      setCurrentTime(time);
                    }
                  }}
                  jobId={jobId}
                  onSpeakerRenamed={fetchJob}
                  onTranscriptUpdated={fetchJob}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
