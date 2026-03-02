import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import VideoPlayer from '../components/VideoPlayer';
import ClipPreview from '../components/ClipPreview';
import ProgressBar from '../components/ProgressBar';
import SceneCard from '../components/SceneCard';
import TranscriptViewer from '../components/TranscriptViewer';
import ClipCard from '../components/ClipCard';
import ClipSettingsPanel from '../components/ClipSettingsPanel';
import { showToast } from '../components/Toast';
import useResponsive from '../hooks/useResponsive';
import useEncodingManager from '../hooks/useEncodingManager';
import { computeClipSubjectX } from '../utils/subjectTracking';

function formatDuration(seconds) {
  if (!seconds) return '-';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDurationInput(seconds) {
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
    if (!isNaN(m) && !isNaN(s) && m >= 0 && s >= 0 && s < 60) {
      return m * 60 + s;
    }
    return null;
  }
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 0) return num;
  return null;
}

const GEN_STORAGE_KEY = 'clipai_generation_settings';
const DEFAULT_GEN = { clipCount: 12, minDuration: 15, maxDuration: 600, viralScoreMin: 0, viralScoreMax: 100 };

function loadGenSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(GEN_STORAGE_KEY));
    return { ...DEFAULT_GEN, ...saved };
  } catch { return { ...DEFAULT_GEN }; }
}

const TABS = ['Summary', 'Key Scenes', 'Transcript', 'Viral Clips'];

function AddSceneForm({ jobId, duration, onAdded }) {
  const [open, setOpen] = React.useState(false);
  const [timestamp, setTimestamp] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [score, setScore] = React.useState(7);
  const [saving, setSaving] = React.useState(false);

  const handleAdd = async () => {
    const ts = parseDuration(timestamp);
    if (ts === null || ts < 0) return;
    if (duration && ts > duration) return;
    if (!description.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/scenes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timestamp: ts,
          description: description.trim(),
          importance_score: score,
        }),
      });
      if (res.ok) {
        setTimestamp('');
        setDescription('');
        setScore(7);
        setOpen(false);
        if (onAdded) onAdded();
      }
    } catch {
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <div style={{ marginBottom: 16 }}>
        <button
          onClick={() => setOpen(true)}
          style={{
            padding: '8px 18px',
            fontSize: 12,
            fontWeight: 600,
            background: 'var(--accent-cyan-dim)',
            color: 'var(--accent-cyan)',
            border: '1px solid var(--accent-cyan)',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
          }}
        >
          + Add Key Scene
        </button>
      </div>
    );
  }

  return (
    <div style={{
      marginBottom: 16,
      padding: 16,
      background: 'var(--bg-panel)',
      border: '1px solid var(--accent-cyan)',
      borderRadius: 'var(--radius-md)',
    }}>
      <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--accent-cyan)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
        Add Key Scene
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ flex: '0 0 auto' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Timestamp (M:SS)</div>
          <input
            type="text"
            value={timestamp}
            onChange={(e) => setTimestamp(e.target.value)}
            placeholder="1:30"
            style={{
              width: 80,
              padding: '6px 8px',
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
              background: 'var(--bg-elevated)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              outline: 'none',
            }}
          />
        </div>
        <div style={{ flex: '0 0 auto' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
            Importance: <span style={{ color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>{score}/10</span>
          </div>
          <input
            type="range"
            min="1"
            max="10"
            value={score}
            onChange={(e) => setScore(parseInt(e.target.value))}
            style={{ width: 120, accentColor: 'var(--accent-cyan)' }}
          />
        </div>
      </div>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Description</div>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe what happens at this moment..."
          rows={2}
          style={{
            width: '100%',
            fontSize: 12,
            lineHeight: 1.4,
            color: 'var(--text-primary)',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '6px 8px',
            resize: 'vertical',
            outline: 'none',
            fontFamily: 'inherit',
          }}
        />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={handleAdd}
          disabled={saving || !description.trim() || parseDuration(timestamp) === null}
          style={{
            padding: '6px 16px',
            fontSize: 12,
            fontWeight: 600,
            background: 'var(--accent-cyan)',
            color: 'var(--bg-base)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: saving ? 'default' : 'pointer',
            opacity: saving || !description.trim() || parseDuration(timestamp) === null ? 0.5 : 1,
          }}
        >
          {saving ? 'Adding...' : 'Add Scene'}
        </button>
        <button
          onClick={() => setOpen(false)}
          style={{
            padding: '6px 16px',
            fontSize: 12,
            background: 'none',
            color: 'var(--text-muted)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function Analysis() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const [job, setJob] = useState(null);
  const [tab, setTab] = useState(0);
  const [loading, setLoading] = useState(true);
  const [clipPreview, setClipPreview] = useState(null);
  const [cancellingJob, setCancellingJob] = useState(false);
  const [selectedClips, setSelectedClips] = useState(new Set());
  const [filters, setFilters] = useState({ minScore: 0, platform: 'all', type: 'all', sort: 'viral_score' });
  const wsRef = useRef(null);
  const [activityLog, setActivityLog] = useState([]);
  const [logExpanded, setLogExpanded] = useState(true);
  const logEndRef = useRef(null);
  // Initialize with defaults so ClipPreview renders immediately when a clip
  // is selected, even before ClipSettingsPanel mounts and fires its callback.
  const [clipSettings, setClipSettings] = useState({
    aspectRatio: null,
    subtitlesEnabled: false,
    subtitleFont: 'DM Sans',
    subtitleSize: 30,
    subtitleFontWeight: 'bold',
    subtitleFontColor: '#FFFFFF',
    subtitlePosition: 'bottom',
    speakerColors: {},
    subtitleBgEnabled: false,
    subtitleBgColor: '#000000',
    subtitleBgOpacity: 75,
    subtitleBgRadius: 0,
    subtitleOutlineColor: '#000000',
    subtitleOutlineOpacity: 100,
    subtitleOutlineWidth: 2,
    showSpeakerLabels: false,
    subtitleMaxWidth: 90,
    subtitleOffsetV: 4,
    subtitleMaxWords: 0,
    activeWordEnabled: false,
    activeWordColor: '#FFD700',
    activeWordOutlineColor: '#000000',
    activeWordBgColor: '#000000',
    activeWordBgOpacity: 0,
    useSpeakerColors: true,
  });
  const [isGeneratingClips, setIsGeneratingClips] = useState(false);
  const [stuckSeconds, setStuckSeconds] = useState(0);
  const lastProgressRef = useRef({ message: '', time: Date.now() });
  const [genSettings, setGenSettings] = useState(loadGenSettings);
  const [clipFocusEnabled, setClipFocusEnabled] = useState(false);
  const [clipFocusText, setClipFocusText] = useState('');
  const [minText, setMinText] = useState(() => formatDurationInput(loadGenSettings().minDuration));
  const [maxText, setMaxText] = useState(() => formatDurationInput(loadGenSettings().maxDuration));
  const { isMobile } = useResponsive();
  const encoding = useEncodingManager();
  const [clipSearchQuery, setClipSearchQuery] = useState('');
  const [settingsAppliedFlash, setSettingsAppliedFlash] = useState(false);
  const settingsAppliedTimerRef = useRef(null);
  const prevClipSettingsRef = useRef(clipSettings);
  const [clipPresets, setClipPresets] = useState([]);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const fullVideoExporting = encoding.tasks[`${jobId}_0`]?.status === 'encoding';

  const fetchJob = useCallback(async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(`/api/jobs/${jobId}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        setJob(data);
        // Sync generating state from job status (handles page refresh mid-generation)
        if (data.status === 'detecting_clips') {
          setIsGeneratingClips(true);
        }
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  const pushLog = useCallback((type, message, extra) => {
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setActivityLog((prev) => [...prev, { ts, type, message, ...extra }]);
  }, []);

  // Auto-scroll log to bottom (within its own scroll container, not the page)
  useEffect(() => {
    const el = logEndRef.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activityLog.length]);

  // Persist generation settings
  useEffect(() => {
    try { localStorage.setItem(GEN_STORAGE_KEY, JSON.stringify(genSettings)); } catch {}
  }, [genSettings]);

  // Initial fetch + WebSocket with auto-reconnection
  useEffect(() => {
    fetchJob();
    let reconnectDelay = 1000;
    let unmounted = false;

    function connectWs() {
      if (unmounted) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/jobs/${jobId}`);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectDelay = 1000; // reset backoff on successful connect
        pushLog('info', 'Connected to live updates');
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'status' || msg.type === 'complete') {
            setJob((prev) => prev ? {
              ...prev,
              status: msg.status || prev.status,
              progress: msg.progress ?? prev.progress,
              progress_message: msg.message || prev.progress_message,
            } : prev);
            // Track clip generation state from status messages
            if (msg.status === 'detecting_clips') {
              setIsGeneratingClips(true);
            } else if (msg.type === 'complete') {
              setIsGeneratingClips(false);
            }
            pushLog(
              msg.type === 'complete' ? 'success' : 'status',
              msg.message || `Status: ${msg.status}`,
              { progress: msg.progress },
            );
            if (msg.type === 'complete') {
              fetchJob();
            }
          } else if (msg.type === 'fallback') {
            pushLog('warning', `Provider fallback: ${msg.from_provider} → ${msg.to_provider} (${msg.reason})`);
            showToast(`Fallback: ${msg.from_provider} -> ${msg.to_provider}: ${msg.reason}`, 'warning');
          } else if (msg.type === 'export_complete') {
            const label = msg.clip_id === 0 ? 'Full video' : `Clip ${msg.clip_id}`;
            pushLog('success', `${label} exported`);
            showToast(`${label} exported!`, 'success');
            fetchJob();
            // Download is handled by useEncodingManager (global) — do NOT
            // trigger a second download here to avoid duplicate file saves.
          } else if (msg.type === 'clips_generated') {
            pushLog('success', msg.message || `Generated ${msg.count} clips`);
            showToast(msg.message || `Found ${msg.count} clip candidates`, 'success');
            setIsGeneratingClips(false);
            fetchJob();
          } else if (msg.type === 'cancelled') {
            pushLog('warning', 'Job cancelled by user');
            showToast('Job cancelled', 'info');
            fetchJob();
          } else if (msg.type === 'subject_tracking') {
            pushLog(
              msg.enabled ? 'info' : 'warning',
              msg.message,
              { tracked_scenes: msg.tracked_scenes, total_scenes: msg.total_scenes },
            );
          } else if (msg.type === 'error') {
            pushLog('error', msg.message);
            showToast(msg.message, 'error');
            setIsGeneratingClips(false);
            fetchJob();
          }
        } catch {
        }
      };

      ws.onclose = () => {
        if (unmounted) return;
        pushLog('info', `Connection lost — reconnecting in ${reconnectDelay / 1000}s...`);
        fetchJob();
        setTimeout(() => {
          if (!unmounted) connectWs();
        }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 16000); // exponential backoff, cap at 16s
      };
    }

    connectWs();

    return () => {
      unmounted = true;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [jobId, fetchJob, pushLog]);

  // Periodic refresh for active jobs
  useEffect(() => {
    if (!job || ['complete', 'failed', 'cancelled'].includes(job.status)) return;
    const interval = setInterval(fetchJob, 5000);
    return () => clearInterval(interval);
  }, [job?.status, fetchJob]);

  // Stuck detection: track when progress_message last changed
  useEffect(() => {
    if (!job || ['complete', 'failed', 'cancelled'].includes(job.status)) {
      setStuckSeconds(0);
      return;
    }
    const currentMsg = job.progress_message || job.status;
    if (currentMsg !== lastProgressRef.current.message) {
      lastProgressRef.current = { message: currentMsg, time: Date.now() };
      setStuckSeconds(0);
    }
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - lastProgressRef.current.time) / 1000);
      setStuckSeconds(elapsed);
    }, 5000);
    return () => clearInterval(interval);
  }, [job?.progress_message, job?.status]);

  const handleSeek = (time) => {
    if (window.__clipai_seekTo) window.__clipai_seekTo(time);
  };

  const handleClipPreview = (clip) => {
    setClipPreview(clip);
    handleSeek(clip.start_time);
    setTab(3);
  };

  const handleExportClip = (clip, settingsOverrideOrQuality) => {
    // Accept either a settings override object or a quality string
    let cs, qualityOverride;
    if (typeof settingsOverrideOrQuality === 'string') {
      cs = clipSettings;
      qualityOverride = settingsOverrideOrQuality;
    } else {
      cs = settingsOverrideOrQuality || clipSettings;
      qualityOverride = null;
    }
    const quality = qualityOverride || (cs && cs.exportQuality) || '1080p';
    const exportBody = {
      start: clip.start_time,
      end: clip.end_time,
      clip_id: clip.id,
      clip_title: clip.title || `Clip ${clip.id}`,
      export_quality: quality,
    };
    if (cs) {
      if (cs.aspectRatio) {
        exportBody.aspect_ratio = cs.aspectRatio;
      }
      exportBody.subtitles_enabled = cs.subtitlesEnabled || false;
      if (cs.subtitlesEnabled) {
        exportBody.subtitle_settings = {
          font: cs.subtitleFont || 'DM Sans',
          size: cs.subtitleSize ?? 30,
          font_weight: cs.subtitleFontWeight || 'bold',
          font_color: cs.subtitleFontColor || '#FFFFFF',
          position: cs.subtitlePosition || 'bottom',
          speaker_colors: cs.speakerColors || {},
          use_speaker_colors: cs.useSpeakerColors ?? true,
          background_enabled: cs.subtitleBgEnabled ?? false,
          background_color: cs.subtitleBgColor || '#000000',
          background_opacity: cs.subtitleBgOpacity ?? 75,
          background_radius: cs.subtitleBgRadius ?? 0,
          outline_color: cs.subtitleOutlineColor || '#000000',
          outline_opacity: cs.subtitleOutlineOpacity ?? 100,
          outline_width: cs.subtitleOutlineWidth ?? 2,
          show_speaker_labels: cs.showSpeakerLabels ?? false,
          max_width: cs.subtitleMaxWidth ?? 90,
          offset_v: cs.subtitleOffsetV ?? 4,
          max_words: cs.subtitleMaxWords ?? 0,
          active_word_enabled: cs.activeWordEnabled ?? false,
          active_word_color: cs.activeWordColor || '#FFD700',
          active_word_outline_color: cs.activeWordOutlineColor || '#000000',
          active_word_bg_color: cs.activeWordBgColor || '#000000',
          active_word_bg_opacity: cs.activeWordBgOpacity ?? 0,
        };
      }
    }
    encoding.startExport(jobId, clip.id, clip.title || `Clip ${clip.id}`, exportBody);
    showToast(`Exporting "${clip.title || `Clip ${clip.id}`}" at ${quality}...`, 'info');
  };

  const handleExportFullVideo = () => {
    if (!job?.duration) return;
    const cs = clipSettings;
    const quality = cs?.exportQuality || '1080p';
    const body = { export_quality: quality };
    if (cs?.aspectRatio) body.aspect_ratio = cs.aspectRatio;
    body.subtitles_enabled = cs?.subtitlesEnabled || false;
    if (cs?.subtitlesEnabled) {
      body.subtitle_settings = {
        font: cs.subtitleFont || 'DM Sans',
        size: cs.subtitleSize ?? 30,
        font_weight: cs.subtitleFontWeight || 'bold',
        font_color: cs.subtitleFontColor || '#FFFFFF',
        position: cs.subtitlePosition || 'bottom',
        speaker_colors: cs.speakerColors || {},
        use_speaker_colors: cs.useSpeakerColors ?? true,
        background_enabled: cs.subtitleBgEnabled ?? false,
        background_color: cs.subtitleBgColor || '#000000',
        background_opacity: cs.subtitleBgOpacity ?? 75,
        background_radius: cs.subtitleBgRadius ?? 0,
        outline_color: cs.subtitleOutlineColor || '#000000',
        outline_opacity: cs.subtitleOutlineOpacity ?? 100,
        outline_width: cs.subtitleOutlineWidth ?? 2,
        show_speaker_labels: cs.showSpeakerLabels ?? false,
        max_width: cs.subtitleMaxWidth ?? 90,
        offset_v: cs.subtitleOffsetV ?? 4,
        max_words: cs.subtitleMaxWords ?? 0,
        active_word_enabled: cs.activeWordEnabled ?? false,
        active_word_color: cs.activeWordColor || '#FFD700',
        active_word_outline_color: cs.activeWordOutlineColor || '#000000',
        active_word_bg_color: cs.activeWordBgColor || '#000000',
        active_word_bg_opacity: cs.activeWordBgOpacity ?? 0,
      };
    }
    encoding.startExport(jobId, 0, job.filename || 'Full Video', body, {
      endpoint: `/api/jobs/${jobId}/export-full-video`,
    });
    showToast(`Exporting full video at ${quality}... This may take a while for long videos.`, 'info');
  };

  const handleSelectClip = (clipId, checked) => {
    setSelectedClips((prev) => {
      const next = new Set(prev);
      if (checked) next.add(clipId);
      else next.delete(clipId);
      return next;
    });
  };

  const handleDeleteClip = async (clip) => {
    try {
      const res = await fetch(`/api/jobs/${jobId}/clips/${clip.id}`, { method: 'DELETE' });
      if (res.ok) {
        setJob((prev) => ({
          ...prev,
          clips: prev.clips.filter((c) => c.id !== clip.id),
          exported_clips: (prev.exported_clips || []).filter((ec) => ec.clip_id !== clip.id),
        }));
        selectedClips.delete(clip.id);
        setSelectedClips(new Set(selectedClips));
        showToast(`Clip ${clip.id} deleted`, 'info');
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.detail || 'Failed to delete clip', 'error');
      }
    } catch {
      showToast('Failed to delete clip', 'error');
    }
  };

  const handleGenerateClips = async () => {
    setIsGeneratingClips(true);
    try {
      const body = {
        min_duration: genSettings.minDuration,
        max_duration: genSettings.maxDuration,
        clip_count: genSettings.clipCount || null,
      };
      if (clipFocusEnabled && clipFocusText.trim()) {
        body.clip_focus = clipFocusText.trim();
      }
      // Only pass viral score range when clip focus is off and range is non-default
      if (!clipFocusEnabled) {
        if (genSettings.viralScoreMin > 0) body.viral_score_min = genSettings.viralScoreMin;
        if (genSettings.viralScoreMax < 100) body.viral_score_max = genSettings.viralScoreMax;
      }
      const res = await fetch(`/api/jobs/${jobId}/generate-clips`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        if (clipFocusEnabled && clipFocusText.trim()) {
          showToast(`AI is searching for "${clipFocusText.trim()}" in your video...`, 'info');
        } else {
          showToast('AI is analyzing your video for viral moments...', 'info');
        }
      } else {
        const data = await res.json().catch(() => ({}));
        showToast(data.detail || 'Failed to generate clips', 'error');
        setIsGeneratingClips(false);
      }
    } catch (err) {
      showToast(`Failed to generate clips: ${err.message}`, 'error');
      setIsGeneratingClips(false);
    }
  };

  const updateGen = (key, value) => {
    setGenSettings((prev) => ({ ...prev, [key]: value }));
  };

  // Auto-apply flash indicator: show when settings change while clip preview is open
  useEffect(() => {
    if (!clipPreview) { prevClipSettingsRef.current = clipSettings; return; }
    if (prevClipSettingsRef.current !== clipSettings) {
      prevClipSettingsRef.current = clipSettings;
      setSettingsAppliedFlash(true);
      if (settingsAppliedTimerRef.current) clearTimeout(settingsAppliedTimerRef.current);
      settingsAppliedTimerRef.current = setTimeout(() => setSettingsAppliedFlash(false), 1800);
    }
  }, [clipSettings, clipPreview]);
  useEffect(() => () => { if (settingsAppliedTimerRef.current) clearTimeout(settingsAppliedTimerRef.current); }, []);

  const handleApplyClipSettings = (settings) => {
    setClipSettings(settings);
    showToast('Clip settings applied to preview & export', 'info');
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-secondary)' }}>
        <div style={{
          width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent-cyan)',
          borderRadius: '50%', animation: 'spin 0.8s linear infinite',
          margin: '0 auto 12px',
        }} />
        <div style={{ fontSize: 14, marginBottom: 4 }}>Connecting to analysis...</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Your video has been uploaded. The analysis pipeline is starting up.
        </div>
      </div>
    );
  }

  if (!job) {
    return <div style={{ textAlign: 'center', padding: 48, color: 'var(--danger)' }}>Job not found</div>;
  }

  const isProcessing = !['complete', 'failed', 'cancelled'].includes(job.status);

  // Parse source video dimensions (plain variable — not a hook, so safe after early returns)
  let sourceDims = { w: 1920, h: 1080 };
  if (job.resolution) {
    const parts = job.resolution.split('x').map(Number);
    if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
      sourceDims = { w: parts[0], h: parts[1] };
    }
  }
  const videoSrc = `/api/files/${jobId}/video.${job.file_path?.split('.').pop() || 'mp4'}`;
  const bestClipId = job.clips?.length ? job.clips.reduce((best, c) => c.viral_score > best.viral_score ? c : best, job.clips[0])?.id : null;

  // Compute subject_x from scenes (with boundary interpolation for clips between scene timestamps)
  const clipSubjectX = clipPreview && job.scenes?.length
    ? computeClipSubjectX(job.scenes, clipPreview.start_time, clipPreview.end_time)
    : 50;

  // Derive unique speakers from transcript
  const speakers = [];
  (job.transcript || []).forEach((seg) => {
    if (!speakers.includes(seg.speaker)) speakers.push(seg.speaker);
  });

  // Always use ClipPreview when a clip is selected so it responds to
  // aspect ratio and subtitle settings changes in real time.
  const showExportPreview = !!clipPreview;

  // Derive unique clip types for filter dropdown
  const analysisClipTypes = [...new Set((job.clips || []).map((c) => c.clip_type).filter(Boolean))].sort();

  // Filter and sort clips
  let filteredClips = [...(job.clips || [])];
  if (filters.minScore > 0) filteredClips = filteredClips.filter((c) => c.viral_score >= filters.minScore);
  if (filters.platform !== 'all') filteredClips = filteredClips.filter((c) => c.platform === filters.platform || c.platform === 'both');
  if (filters.type !== 'all') filteredClips = filteredClips.filter((c) => c.clip_type === filters.type);

  // Apply text search filter — covers all visible text on the clip card
  if (clipSearchQuery.trim()) {
    const q = clipSearchQuery.trim().toLowerCase();
    filteredClips = filteredClips.filter((c) =>
      (c.title || '').toLowerCase().includes(q) ||
      (c.suggested_caption || '').toLowerCase().includes(q) ||
      (c.hook_text || '').toLowerCase().includes(q) ||
      (c.why_this_works || '').toLowerCase().includes(q) ||
      (c.clip_type || '').toLowerCase().includes(q) ||
      (c.platform || '').toLowerCase().includes(q) ||
      (c.viral_score_reasoning || '').toLowerCase().includes(q) ||
      (c.clip_focus || '').toLowerCase().includes(q) ||
      String(c.id).includes(q) ||
      String(c.viral_score).includes(q) ||
      (c.suggested_hashtags || []).some((h) => h.toLowerCase().includes(q))
    );
  }

  filteredClips.sort((a, b) => {
    if (filters.sort === 'newest') return b.id - a.id;
    if (filters.sort === 'duration') return b.duration - a.duration;
    if (filters.sort === 'duration_short') return a.duration - b.duration;
    if (filters.sort === 'timestamp') return a.start_time - b.start_time;
    if (filters.sort === 'score_low') return a.viral_score - b.viral_score;
    if (filters.sort === 'title_az') return (a.title || '').localeCompare(b.title || '');
    return b.viral_score - a.viral_score;
  });

  return (
    <div>
      {/* Video Player (sticky) */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg-base)' }}>
        {showExportPreview ? (
          <div style={{ position: 'relative' }}>
            <ClipPreview
              src={videoSrc}
              clipStart={clipPreview.start_time}
              clipEnd={clipPreview.end_time}
              title={clipPreview.title || `Clip ${clipPreview.id}`}
              aspectRatio={clipSettings.aspectRatio || null}
              sourceWidth={sourceDims.w}
              sourceHeight={sourceDims.h}
              subjectX={clipSubjectX}
              scenes={job.scenes || []}
              subtitlesEnabled={clipSettings.subtitlesEnabled || false}
              subtitleSettings={clipSettings}
              transcript={job.transcript || []}
              onClose={() => setClipPreview(null)}
              inline
            />
            {/* Auto-applied settings indicator */}
            {settingsAppliedFlash && (
              <div style={{
                position: 'absolute', bottom: 52, left: '50%', transform: 'translateX(-50%)',
                zIndex: 20,
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 14px',
                background: 'var(--success)', color: '#fff',
                borderRadius: 'var(--radius-xl)',
                fontSize: 12, fontWeight: 600,
                boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
                animation: 'slideIn 0.25s ease forwards',
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Settings applied to preview
              </div>
            )}
          </div>
        ) : (
          <VideoPlayer
            src={videoSrc}
            clipStart={clipPreview?.start_time}
            clipEnd={clipPreview?.end_time}
            aspectRatio={clipSettings.aspectRatio || null}
            sourceWidth={sourceDims.w}
            sourceHeight={sourceDims.h}
            subjectX={clipSubjectX}
            scenes={job.scenes || []}
          />
        )}
        {/* Export button — visible when a clip is loaded in the preview player */}
        {showExportPreview && clipPreview && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 4px' }}>
            <button
              onClick={() => handleExportClip(clipPreview)}
              disabled={encoding.tasks[`${jobId}_${clipPreview.id}`]?.status === 'encoding'}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 24px',
                fontSize: 12,
                fontWeight: 600,
                background: encoding.tasks[`${jobId}_${clipPreview.id}`]?.status === 'encoding'
                  ? 'var(--bg-elevated)' : 'var(--accent-cyan)',
                color: encoding.tasks[`${jobId}_${clipPreview.id}`]?.status === 'encoding'
                  ? 'var(--text-muted)' : 'var(--bg-base)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                cursor: encoding.tasks[`${jobId}_${clipPreview.id}`]?.status === 'encoding'
                  ? 'default' : 'pointer',
                fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase',
                letterSpacing: '0.03em',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {encoding.tasks[`${jobId}_${clipPreview.id}`]?.status === 'encoding'
                ? 'Exporting...'
                : `Export Clip (${clipSettings.exportQuality || '1080p'})`}
            </button>
          </div>
        )}
        {/* Subject tracking controls */}
        {job.scenes?.length > 0 && (
          <div style={{ display: 'flex', gap: 8, padding: '6px 0', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={async () => {
                try {
                  const res = await fetch(`/api/jobs/${jobId}/recenter-subject`, { method: 'POST' });
                  if (res.ok) {
                    showToast('Subject reset to center — the crop will center on the subject in preview and export', 'success');
                    await fetchJob();
                  } else {
                    showToast('Failed to reset subject position', 'error');
                  }
                } catch {
                  showToast('Failed to reset subject position', 'error');
                }
              }}
              style={{
                padding: '5px 14px',
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
                  showToast('Re-analyzing subject positions with AI — this may take a moment...', 'info');
                  const res = await fetch(`/api/jobs/${jobId}/reanalyze-subject`, { method: 'POST' });
                  if (res.ok) {
                    showToast('AI is re-analyzing subject positions — updates will appear when complete', 'info');
                  } else {
                    const err = await res.json().catch(() => ({}));
                    showToast(err.detail || 'Failed to start re-analysis', 'error');
                  }
                } catch {
                  showToast('Failed to start re-analysis', 'error');
                }
              }}
              style={{
                padding: '5px 14px',
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
              Re-analyze with AI
            </button>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              {clipSettings.aspectRatio ? 'Subject tracking affects crop position in preview & export' : 'Select an aspect ratio (e.g. 9:16) to see subject tracking in action'}
            </span>
          </div>
        )}
        {/* Current detected subject for previewed clip */}
        {clipPreview && job.scenes?.length > 0 && (() => {
          const inRange = (job.scenes || []).filter(
            (s) => s.timestamp >= clipPreview.start_time && s.timestamp <= clipPreview.end_time
          );
          if (!inRange.length) return null;
          const best = inRange.reduce((a, b) => (b.importance_score > a.importance_score ? b : a), inRange[0]);
          return (
            <div style={{
              padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)',
              background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)',
              borderLeft: '2px solid var(--accent-cyan)', lineHeight: 1.4,
              marginTop: 2,
            }}>
              <span style={{ fontWeight: 600, color: 'var(--text-secondary)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                Current subject (Clip {clipPreview.id}):
              </span>{' '}
              {best.description.length > 150 ? best.description.slice(0, 150) + '...' : best.description}
              <span style={{ marginLeft: 6, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--accent-cyan)' }}>
                x={best.subject_x ?? 50}%
              </span>
            </div>
          );
        })()}
      </div>

      {/* Progress for active jobs */}
      {isProcessing && (
        <div style={{ padding: '12px 0' }}>
          {/* Queued waiting banner */}
          {(job.status === 'queued' && (job.progress || 0) <= 1) && (
            <div style={{
              marginBottom: 10, padding: '10px 14px',
              background: 'var(--accent-cyan-dim)', border: '1px solid var(--accent-cyan)',
              borderRadius: 'var(--radius-sm)', fontSize: 12, color: 'var(--accent-cyan)',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent-cyan)', animation: 'pulse 1.5s ease-in-out infinite', flexShrink: 0 }} />
              Upload complete — your video is queued for analysis. The pipeline will start shortly.
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <ProgressBar progress={job.progress || 0} message={job.progress_message || 'Preparing analysis pipeline...'} />
            </div>
            <button
              disabled={cancellingJob}
              onClick={async () => {
                if (cancellingJob) return;
                setCancellingJob(true);
                showToast('Cancelling...', 'info');
                try {
                  await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
                  navigate('/');
                } catch {
                  setCancellingJob(false);
                }
              }}
              style={{
                padding: '6px 16px',
                background: 'var(--amber-dim)',
                border: '1px solid var(--accent-amber)',
                color: 'var(--accent-amber)',
                fontSize: 12,
                fontWeight: 600,
                cursor: cancellingJob ? 'default' : 'pointer',
                borderRadius: 'var(--radius-sm)',
                whiteSpace: 'nowrap',
                flexShrink: 0,
                opacity: cancellingJob ? 0.6 : 1,
              }}
            >
              {cancellingJob ? 'Cancelling...' : 'Cancel'}
            </button>
          </div>
          {/* Stuck/slow warning */}
          {stuckSeconds >= 60 && (
            <div style={{
              marginTop: 8, padding: '8px 12px',
              background: stuckSeconds >= 300 ? 'var(--danger-dim, rgba(255,59,48,0.08))' : 'var(--amber-dim)',
              border: `1px solid ${stuckSeconds >= 300 ? 'var(--danger, #ff3b30)' : 'var(--accent-amber)'}`,
              borderRadius: 'var(--radius-sm)', fontSize: 12,
              color: stuckSeconds >= 300 ? 'var(--danger, #ff3b30)' : 'var(--accent-amber)',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ animation: 'pulse 1.5s ease-in-out infinite', flexShrink: 0 }}>{'\u25CF'}</span>
              <span>
                {stuckSeconds >= 300
                  ? `No progress update for ${Math.floor(stuckSeconds / 60)}m — the pipeline may be stuck. You can cancel and retry, or check the activity log for details.`
                  : stuckSeconds >= 180
                    ? `No progress update for ${Math.floor(stuckSeconds / 60)}m — the container may be processing a large file. Check the activity log below for details.`
                    : `Still working... no update for ${stuckSeconds}s — large files can take a while to process.`
                }
              </span>
            </div>
          )}
        </div>
      )}

      {/* Activity Log */}
      {activityLog.length > 0 && (isProcessing || job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled') && (
        <div style={{
          background: 'var(--bg-panel)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)', marginBottom: 16, overflow: 'hidden',
        }}>
          <button
            onClick={() => setLogExpanded((p) => !p)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-secondary)', fontSize: 11, fontFamily: 'var(--font-mono)',
              textTransform: 'uppercase', letterSpacing: '0.05em',
            }}
          >
            <span>
              Processing Log
              <span style={{ color: 'var(--text-muted)', marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>
                ({activityLog.length} events)
              </span>
            </span>
            <span style={{ fontSize: 14 }}>{logExpanded ? '\u25B4' : '\u25BE'}</span>
          </button>
          {logExpanded && (
            <div style={{
              maxHeight: 200, overflowY: 'auto', padding: isMobile ? '8px 12px' : '12px 16px',
              fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.7,
            }}>
              {activityLog.map((entry, i) => {
                const colors = {
                  status: 'var(--text-secondary)',
                  success: 'var(--success)',
                  warning: 'var(--accent-amber)',
                  error: 'var(--danger)',
                  info: 'var(--text-muted)',
                };
                return (
                  <div key={i} style={{ display: 'flex', gap: 8 }}>
                    <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{entry.ts}</span>
                    {entry.progress !== undefined && (
                      <span style={{ color: 'var(--accent-cyan)', flexShrink: 0, minWidth: 30, textAlign: 'right' }}>
                        {entry.progress}%
                      </span>
                    )}
                    <span style={{ color: colors[entry.type] || colors.status }}>
                      {entry.message}
                    </span>
                  </div>
                );
              })}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}

      {/* Cancelled banner */}
      {job.status === 'cancelled' && (
        <div style={{ padding: '12px 16px', background: 'var(--amber-dim)', border: '1px solid var(--accent-amber)', color: 'var(--accent-amber)', fontSize: 13, margin: '12px 0', borderRadius: 'var(--radius-sm)' }}>
          Job was cancelled. Partial results may be available below.
        </div>
      )}

      {/* Error */}
      {job.status === 'failed' && job.error && (
        <div style={{ padding: '12px 16px', background: 'var(--danger-dim)', border: '1px solid var(--danger)', color: 'var(--danger)', fontSize: 13, margin: '12px 0', borderRadius: 'var(--radius-sm)' }}>
          {job.error}
        </div>
      )}

      {/* Metadata bar */}
      <div style={{ display: 'flex', gap: 16, padding: '12px 0', flexWrap: 'wrap', fontSize: 12, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
        {job.duration > 0 && <span style={{ fontFamily: 'var(--font-mono)' }}>Duration: {formatDuration(job.duration)}</span>}
        {job.resolution && <span style={{ fontFamily: 'var(--font-mono)' }}>{job.resolution}</span>}
        {job.fps > 0 && <span style={{ fontFamily: 'var(--font-mono)' }}>{job.fps} FPS</span>}
        {job.file_size_mb > 0 && <span style={{ fontFamily: 'var(--font-mono)' }}>{job.file_size_mb.toFixed(1)} MB</span>}
        {Object.keys(job.provider_used || {}).length > 0 && (
          <span>Providers: {Object.entries(job.provider_used).map(([k, v]) => `${k}=${v}`).join(', ')}</span>
        )}
        {job.analysis_duration_seconds > 0 && (
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--success)' }}>
            Analyzed in {job.analysis_duration_seconds < 60
              ? `${Math.round(job.analysis_duration_seconds)}s`
              : `${Math.floor(job.analysis_duration_seconds / 60)}m ${Math.round(job.analysis_duration_seconds % 60)}s`}
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="responsive-tabs" style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', marginBottom: 24 }}>
        {TABS.map((t, i) => (
          <button
            key={t}
            onClick={() => setTab(i)}
            style={{
              padding: isMobile ? '10px 14px' : '10px 20px',
              background: 'none',
              border: 'none',
              borderBottom: tab === i ? '2px solid var(--accent-cyan)' : '2px solid transparent',
              color: tab === i ? 'var(--accent-cyan)' : 'var(--text-secondary)',
              fontSize: 13,
              fontWeight: tab === i ? 600 : 400,
              fontFamily: 'var(--font-mono)',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {t}
            {i === 3 && job.clips?.length > 0 && (
              <span style={{ marginLeft: 6, fontSize: 10, background: 'var(--accent-amber)', color: 'var(--bg-base)', padding: '1px 5px', borderRadius: 8, fontWeight: 700 }}>
                {job.clips.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {tab === 0 && (
        <div>
          {job.summary ? (
            <div className="slide-in">
              <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 20, marginBottom: 16, boxShadow: 'var(--shadow-sm)' }}>
                <h3 style={{ fontSize: 14, marginBottom: 12, color: 'var(--accent-cyan)' }}>Overview</h3>
                <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--text-primary)' }}>{job.summary.overview}</p>
              </div>

              <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
                <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, flex: 1, minWidth: 200, boxShadow: 'var(--shadow-sm)' }}>
                  <h4 style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Key Topics</h4>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {(job.summary.key_topics || []).map((t, i) => (
                      <span key={i} className="badge badge-cyan">{t}</span>
                    ))}
                  </div>
                </div>
                <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, flex: 1, minWidth: 200, boxShadow: 'var(--shadow-sm)' }}>
                  <h4 style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Details</h4>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                    <div style={{ marginBottom: 4 }}>Tone: <span className="badge badge-gray">{job.summary.tone}</span></div>
                    <div style={{ marginBottom: 4 }}>Audience: {job.summary.estimated_audience}</div>
                    <div>Category: <span className="badge badge-amber">{job.summary.content_category}</span></div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
              {isProcessing ? 'Generating summary...' : 'No summary available'}
            </div>
          )}
        </div>
      )}

      {tab === 1 && (
        <div>
          {/* Add Scene form */}
          <AddSceneForm jobId={jobId} duration={job.duration} onAdded={fetchJob} />

          {/* Management hint */}
          {job.scenes?.length > 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--accent-cyan)' }}>{'\u270E'}</span> Hover over a scene card to edit or delete it
            </div>
          )}

          {/* Timeline bar */}
          {job.scenes?.length > 0 && job.duration > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ display: 'flex', height: 40, gap: 1, alignItems: 'flex-end' }}>
                {job.scenes.map((scene, i) => (
                  <div
                    key={i}
                    onClick={() => handleSeek(scene.timestamp)}
                    style={{
                      flex: 1,
                      height: `${scene.importance_score * 10}%`,
                      background: scene.importance_score >= 8 ? 'var(--accent-amber)' : scene.importance_score >= 5 ? 'var(--accent-cyan)' : 'var(--border)',
                      cursor: 'pointer',
                      minWidth: 4,
                      transition: 'opacity 0.2s',
                    }}
                    title={`${formatDuration(scene.timestamp)} - Score: ${scene.importance_score}/10`}
                  />
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                <span>0:00</span>
                <span>{formatDuration(job.duration)}</span>
              </div>
            </div>
          )}

          <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(240px, 100%), 1fr))', gap: 16 }}>
            {(job.scenes || []).map((scene, i) => (
              <SceneCard key={i} scene={scene} sceneIndex={i} jobId={jobId} onClick={handleSeek} onUpdated={fetchJob} />
            ))}
          </div>
          {(!job.scenes || job.scenes.length === 0) && (
            <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
              {isProcessing ? 'Analyzing scenes...' : 'No scenes analyzed'}
            </div>
          )}
        </div>
      )}

      {tab === 2 && (
        <div>
          {job.transcript?.length > 0 ? (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  onClick={async () => {
                    await fetchJob();
                    showToast('Transcript refreshed — subtitles updated for preview & export', 'success');
                  }}
                  style={{
                    padding: '6px 14px',
                    background: 'var(--accent-cyan-dim)',
                    color: 'var(--accent-cyan)',
                    border: '1px solid var(--accent-cyan)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Update Subtitles
                </button>
                <a
                  href={`/api/jobs/${jobId}/transcript.srt`}
                  download
                  style={{
                    padding: '6px 14px',
                    background: 'var(--bg-elevated)',
                    color: 'var(--accent-cyan)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 12,
                    fontWeight: 600,
                    textDecoration: 'none',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  &#x2B07; Download SRT (with speakers)
                </a>
                <a
                  href={`/api/jobs/${jobId}/transcript.srt?speakers=false`}
                  download
                  style={{
                    padding: '6px 14px',
                    background: 'var(--bg-elevated)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 12,
                    textDecoration: 'none',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  &#x2B07; SRT (no speakers)
                </a>
              </div>
              <TranscriptViewer transcript={job.transcript} onSeek={handleSeek} jobId={jobId} onSpeakerRenamed={fetchJob} onTranscriptUpdated={fetchJob} />
            </>
          ) : (
            <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
              {isProcessing ? 'Transcribing audio...' : 'No transcript available'}
            </div>
          )}
        </div>
      )}

      {tab === 3 && (
        <div>
          {/* Local AI banner */}
          {Object.values(job.provider_used || {}).some((v) => v === 'ollama') && (
            <div style={{ padding: '10px 16px', background: 'var(--amber-dim)', border: '1px solid var(--accent-amber)', marginBottom: 16, fontSize: 13, color: 'var(--accent-amber)', borderRadius: 'var(--radius-sm)' }}>
              Local AI - analysis is free and private. Results may vary from cloud quality.
            </div>
          )}

          {/* Clip Discovery bar */}
          {job.transcript?.length > 0 && job.scenes?.length > 0 && job.summary && (
            <div style={{
              display: 'flex',
              gap: isMobile ? 10 : 16,
              marginBottom: 16,
              padding: isMobile ? '12px 14px' : '14px 18px',
              background: 'var(--bg-panel)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              alignItems: 'flex-end',
              flexWrap: 'wrap',
            }}>
              <div style={{ flex: isMobile ? '1 1 100%' : '0 0 auto', opacity: isGeneratingClips ? 0.5 : 1, pointerEvents: isGeneratingClips ? 'none' : 'auto', transition: 'opacity 0.3s' }}>
                <div style={{
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-primary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginBottom: 8,
                }}>
                  Find Viral Moments
                </div>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
                    Clips
                    <input
                      type="range"
                      min="1"
                      max="100"
                      value={Math.min(100, genSettings.clipCount || 12)}
                      onChange={(e) => updateGen('clipCount', parseInt(e.target.value))}
                      disabled={isGeneratingClips}
                      style={{ width: 80, accentColor: 'var(--accent-cyan)' }}
                    />
                    <input
                      type="number"
                      min="1"
                      max="200"
                      value={genSettings.clipCount || 12}
                      onChange={(e) => {
                        const val = parseInt(e.target.value);
                        if (!isNaN(val) && val >= 1 && val <= 200) updateGen('clipCount', val);
                      }}
                      disabled={isGeneratingClips}
                      style={{
                        width: 48, padding: '3px 4px', fontSize: 13,
                        fontFamily: 'var(--font-mono)', textAlign: 'center',
                        background: 'var(--bg-elevated)', color: isGeneratingClips ? 'var(--text-muted)' : 'var(--accent-cyan)',
                        border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                        outline: 'none',
                      }}
                    />
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
                    Min
                    <input
                      type="text"
                      value={minText}
                      onChange={(e) => setMinText(e.target.value)}
                      onBlur={() => {
                        const val = parseDuration(minText);
                        if (val !== null && val >= 1 && val <= 7200) {
                          updateGen('minDuration', val);
                          if (val >= genSettings.maxDuration) {
                            const newMax = Math.min(7200, val + 30);
                            updateGen('maxDuration', newMax);
                            setMaxText(formatDurationInput(newMax));
                          }
                          setMinText(formatDurationInput(val));
                        } else {
                          setMinText(formatDurationInput(genSettings.minDuration));
                        }
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                      disabled={isGeneratingClips}
                      style={{
                        width: 56,
                        padding: '4px 6px',
                        fontSize: 12,
                        fontFamily: 'var(--font-mono)',
                        background: 'var(--bg-elevated)',
                        color: isGeneratingClips ? 'var(--text-muted)' : 'var(--accent-cyan)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-sm)',
                        outline: 'none',
                        textAlign: 'center',
                      }}
                    />
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
                    Max
                    <input
                      type="text"
                      value={maxText}
                      onChange={(e) => setMaxText(e.target.value)}
                      onBlur={() => {
                        const val = parseDuration(maxText);
                        if (val !== null && val >= 1 && val <= 7200) {
                          updateGen('maxDuration', val);
                          if (val <= genSettings.minDuration) {
                            const newMin = Math.max(1, val - 30);
                            updateGen('minDuration', newMin);
                            setMinText(formatDurationInput(newMin));
                          }
                          setMaxText(formatDurationInput(val));
                        } else {
                          setMaxText(formatDurationInput(genSettings.maxDuration));
                        }
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                      disabled={isGeneratingClips}
                      style={{
                        width: 56,
                        padding: '4px 6px',
                        fontSize: 12,
                        fontFamily: 'var(--font-mono)',
                        background: 'var(--bg-elevated)',
                        color: isGeneratingClips ? 'var(--text-muted)' : 'var(--accent-cyan)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-sm)',
                        outline: 'none',
                        textAlign: 'center',
                      }}
                    />
                  </label>
                </div>
                {/* Viral Score Range — only when clip focus is off */}
                {!clipFocusEnabled && (
                  <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Viral Score</span>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
                      Min
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={genSettings.viralScoreMin ?? 0}
                        onChange={(e) => {
                          const val = parseInt(e.target.value);
                          if (!isNaN(val) && val >= 0 && val <= 100) {
                            updateGen('viralScoreMin', val);
                            if (val > (genSettings.viralScoreMax ?? 100)) updateGen('viralScoreMax', val);
                          }
                        }}
                        disabled={isGeneratingClips}
                        style={{
                          width: 44, padding: '3px 4px', fontSize: 12,
                          fontFamily: 'var(--font-mono)', textAlign: 'center',
                          background: 'var(--bg-elevated)', color: isGeneratingClips ? 'var(--text-muted)' : 'var(--accent-cyan)',
                          border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                          outline: 'none',
                        }}
                      />
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={genSettings.viralScoreMin ?? 0}
                      onChange={(e) => {
                        const val = parseInt(e.target.value);
                        updateGen('viralScoreMin', val);
                        if (val > (genSettings.viralScoreMax ?? 100)) updateGen('viralScoreMax', val);
                      }}
                      disabled={isGeneratingClips}
                      style={{ width: 80, accentColor: 'var(--accent-cyan)' }}
                    />
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>&ndash;</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={genSettings.viralScoreMax ?? 100}
                      onChange={(e) => {
                        const val = parseInt(e.target.value);
                        updateGen('viralScoreMax', val);
                        if (val < (genSettings.viralScoreMin ?? 0)) updateGen('viralScoreMin', val);
                      }}
                      disabled={isGeneratingClips}
                      style={{ width: 80, accentColor: 'var(--accent-cyan)' }}
                    />
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
                      Max
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={genSettings.viralScoreMax ?? 100}
                        onChange={(e) => {
                          const val = parseInt(e.target.value);
                          if (!isNaN(val) && val >= 0 && val <= 100) {
                            updateGen('viralScoreMax', val);
                            if (val < (genSettings.viralScoreMin ?? 0)) updateGen('viralScoreMin', val);
                          }
                        }}
                        disabled={isGeneratingClips}
                        style={{
                          width: 44, padding: '3px 4px', fontSize: 12,
                          fontFamily: 'var(--font-mono)', textAlign: 'center',
                          background: 'var(--bg-elevated)', color: isGeneratingClips ? 'var(--text-muted)' : 'var(--accent-cyan)',
                          border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                          outline: 'none',
                        }}
                      />
                    </label>
                    {(genSettings.viralScoreMin > 0 || genSettings.viralScoreMax < 100) && (
                      <span style={{ fontSize: 10, color: 'var(--accent-amber)' }}>
                        Only clips scoring {genSettings.viralScoreMin}-{genSettings.viralScoreMax} will be kept
                      </span>
                    )}
                  </div>
                )}
                {/* Clip Focus toggle */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10, width: '100%' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Clip Focus</span>
                    <button
                      onClick={() => { if (!isGeneratingClips) setClipFocusEnabled(!clipFocusEnabled); }}
                      disabled={isGeneratingClips}
                      style={{
                        width: 36, height: 20, borderRadius: 10, border: 'none',
                        cursor: isGeneratingClips ? 'not-allowed' : 'pointer',
                        background: clipFocusEnabled ? 'var(--success)' : 'var(--border)',
                        position: 'relative', transition: 'background 0.2s', flexShrink: 0,
                        opacity: isGeneratingClips ? 0.5 : 1,
                      }}
                    >
                      <div style={{
                        width: 14, height: 14, borderRadius: '50%', background: 'white',
                        position: 'absolute', top: 3,
                        left: clipFocusEnabled ? 19 : 3,
                        transition: 'left 0.2s',
                      }} />
                    </button>
                  </div>
                  {clipFocusEnabled && (
                    <textarea
                      placeholder="e.g. fighting, cooking tips, funny moments..."
                      value={clipFocusText}
                      onChange={(e) => setClipFocusText(e.target.value)}
                      rows={3}
                      disabled={isGeneratingClips}
                      style={{
                        width: '100%', padding: '8px 10px', fontSize: 12,
                        fontFamily: 'var(--font-mono)', background: 'var(--bg-elevated)',
                        color: isGeneratingClips ? 'var(--text-muted)' : 'var(--text-primary)',
                        border: `1px solid ${isGeneratingClips ? 'var(--border)' : 'var(--success)'}`,
                        borderRadius: 'var(--radius-sm)', outline: 'none',
                        resize: 'vertical', minHeight: 60, lineHeight: 1.5,
                        opacity: isGeneratingClips ? 0.5 : 1,
                      }}
                    />
                  )}
                  {clipFocusEnabled && (
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.3 }}>
                      Finds clips matching your topic instead of using the viral algorithm
                    </span>
                  )}
                </div>
                {/* Generate button + algorithm link */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, width: '100%' }}>
                  <button
                    onClick={handleGenerateClips}
                    disabled={isGeneratingClips}
                    style={{
                      padding: '8px 20px',
                      background: isGeneratingClips ? 'var(--accent-amber)' : clipFocusEnabled ? 'var(--success)' : 'var(--accent-cyan)',
                      color: 'var(--bg-base)',
                      border: 'none',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: isGeneratingClips ? 'wait' : 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {isGeneratingClips ? 'Generating...' : clipFocusEnabled ? 'Find Focused Clips' : 'Generate Clips'}
                  </button>
                  <span
                    onClick={() => navigate('/settings?tab=prompts&section=viral-algorithm')}
                    style={{
                      fontSize: 10,
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      textDecoration: 'underline',
                      textDecorationStyle: 'dashed',
                    }}
                    title="Customize the AI prompt that controls how viral clips are detected and scored"
                  >
                    Edit Viral Algorithm
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Sidebar + Clips layout */}
          <div className="clip-panel-layout" style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>

            {/* Left: Settings Sidebar (sticky) */}
            {job.transcript?.length > 0 && job.scenes?.length > 0 && job.summary && (
              <div
                className="clip-settings-sidebar"
                style={{
                  width: isMobile ? '100%' : 320,
                  flexShrink: 0,
                  position: isMobile ? 'static' : 'sticky',
                  top: 16,
                  maxHeight: 'calc(100vh - 120px)',
                  overflowY: 'auto',
                }}
              >
                <ClipSettingsPanel
                  speakers={speakers}
                  speakerNames={job.speaker_names}
                  videoResolution={job.resolution}
                  onSettingsChange={setClipSettings}
                  onApplySettings={handleApplyClipSettings}
                  onPresetsLoaded={setClipPresets}
                />

                {/* Export Full Video */}
                <div style={{
                  marginTop: 16,
                  padding: 16,
                  background: 'var(--bg-panel)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--shadow-sm)',
                }}>
                  <h4 style={{
                    fontSize: 12,
                    color: 'var(--text-muted)',
                    marginBottom: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    fontFamily: 'var(--font-mono)',
                  }}>
                    Export Full Video
                  </h4>
                  <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.4 }}>
                    Export the entire video with the clip settings above applied — aspect ratio, subtitles{job.scenes?.length > 0 ? ', and Intelligent Dynamic Subject Tracking' : ''}.
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={() => {
                          if (!job?.duration) return;
                          handleClipPreview({
                            id: 0,
                            start_time: 0,
                            end_time: job.duration,
                            title: job.filename || 'Full Video',
                          });
                        }}
                        style={{
                          flex: 1,
                          padding: '10px 16px',
                          background: 'transparent',
                          color: 'var(--accent-amber)',
                          border: '1px solid var(--accent-amber)',
                          borderRadius: 'var(--radius-sm)',
                          fontSize: 13,
                          fontWeight: 700,
                          cursor: 'pointer',
                          transition: 'background 0.2s, color 0.2s',
                        }}
                      >
                        Preview
                      </button>
                      <button
                        onClick={handleExportFullVideo}
                        disabled={fullVideoExporting}
                        style={{
                          flex: 2,
                          padding: '10px 16px',
                          background: fullVideoExporting ? 'var(--bg-elevated)' : 'var(--accent-amber)',
                          color: fullVideoExporting ? 'var(--text-muted)' : 'var(--bg-base)',
                          border: 'none',
                          borderRadius: 'var(--radius-sm)',
                          fontSize: 13,
                          fontWeight: 700,
                          cursor: fullVideoExporting ? 'wait' : 'pointer',
                          transition: 'background 0.2s',
                        }}
                      >
                        {fullVideoExporting ? 'Starting Export...' : `Export (${clipSettings?.exportQuality || '1080p'})`}
                      </button>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                      {clipSettings?.aspectRatio ? (
                        <span>Aspect ratio: <strong style={{ color: 'var(--text-secondary)' }}>{clipSettings.aspectRatio}</strong></span>
                      ) : (
                        <span>Original aspect ratio</span>
                      )}
                      {clipSettings?.subtitlesEnabled && (
                        <span> &bull; Subtitles enabled</span>
                      )}
                      {job.scenes?.length > 0 && clipSettings?.aspectRatio && (
                        <span> &bull; Subject tracking ({job.scenes.length} scenes)</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Right: Clips area */}
            <div style={{ flex: 1, minWidth: 0 }}>
              {/* Search Bar */}
              {job.clips?.length > 0 && (
                <div style={{ position: 'relative', marginBottom: 12 }}>
                  <div style={{
                    position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
                    color: 'var(--text-muted)', fontSize: 15, pointerEvents: 'none', lineHeight: 1,
                  }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                  </div>
                  <input
                    type="text"
                    value={clipSearchQuery}
                    onChange={(e) => setClipSearchQuery(e.target.value)}
                    placeholder="Search clips by title, caption, hook, type..."
                    style={{
                      width: '100%',
                      padding: '10px 14px 10px 40px',
                      fontSize: 14,
                      background: 'var(--bg-panel)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)',
                      color: 'var(--text-primary)',
                      outline: 'none',
                      transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
                    }}
                    onFocus={(e) => {
                      e.target.style.borderColor = 'var(--accent-cyan)';
                      e.target.style.boxShadow = '0 0 0 3px var(--accent-cyan-dim)';
                    }}
                    onBlur={(e) => {
                      e.target.style.borderColor = 'var(--border)';
                      e.target.style.boxShadow = 'none';
                    }}
                  />
                  {clipSearchQuery && (
                    <button
                      onClick={() => setClipSearchQuery('')}
                      style={{
                        position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                        background: 'var(--bg-elevated)', border: 'none', borderRadius: '50%',
                        width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer', lineHeight: 1,
                      }}
                    >
                      &times;
                    </button>
                  )}
                </div>
              )}

              {/* Filters */}
              {job.clips?.length > 0 && (
                <div style={{
                  display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center',
                  padding: '10px 14px', background: 'var(--bg-panel)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                }}>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    Score
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={filters.minScore}
                      onChange={(e) => setFilters((f) => ({ ...f, minScore: parseInt(e.target.value) }))}
                      style={{ width: 80, accentColor: 'var(--accent-cyan)' }}
                    />
                    <span style={{ fontFamily: 'var(--font-mono)', width: 28, fontSize: 12, color: 'var(--accent-cyan)' }}>{filters.minScore}</span>
                  </label>
                  <select
                    value={filters.platform}
                    onChange={(e) => setFilters((f) => ({ ...f, platform: e.target.value }))}
                    style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', fontSize: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                  >
                    <option value="all">All Platforms</option>
                    <option value="tiktok">TikTok</option>
                    <option value="youtube_shorts">YouTube Shorts</option>
                    <option value="both">Both</option>
                  </select>
                  {analysisClipTypes.length > 1 && (
                    <select
                      value={filters.type}
                      onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}
                      style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', fontSize: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                    >
                      <option value="all">All Types</option>
                      {analysisClipTypes.map((t) => (
                        <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                      ))}
                    </select>
                  )}
                  <select
                    value={filters.sort}
                    onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value }))}
                    style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', fontSize: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                  >
                    <option value="newest">Newest First</option>
                    <option value="viral_score">Score: High to Low</option>
                    <option value="score_low">Score: Low to High</option>
                    <option value="duration">Duration: Longest</option>
                    <option value="duration_short">Duration: Shortest</option>
                    <option value="timestamp">Timestamp</option>
                    <option value="title_az">Title: A-Z</option>
                  </select>

                  {/* Select All / Deselect All */}
                  <button
                    onClick={() => {
                      const allIds = filteredClips.map((c) => c.id);
                      const allSelected = allIds.length > 0 && allIds.every((id) => selectedClips.has(id));
                      if (allSelected) {
                        setSelectedClips(new Set());
                      } else {
                        setSelectedClips(new Set(allIds));
                      }
                    }}
                    style={{
                      padding: '6px 12px',
                      background: 'var(--bg-elevated)',
                      color: 'var(--text-secondary)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {filteredClips.length > 0 && filteredClips.every((c) => selectedClips.has(c.id))
                      ? 'Deselect All'
                      : 'Select All'}
                  </button>

                  {selectedClips.size > 0 && (
                    <button
                      onClick={async () => {
                        for (const clipId of selectedClips) {
                          const clip = job.clips.find((c) => c.id === clipId);
                          if (clip) await handleExportClip(clip);
                        }
                      }}
                      style={{
                        padding: '6px 16px',
                        background: 'var(--accent-cyan)',
                        color: 'var(--bg-base)',
                        border: 'none',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Export Selected ({selectedClips.size})
                    </button>
                  )}

                  {/* Apply Preset to Selected */}
                  {selectedClips.size > 0 && clipPresets.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
                      <select
                        value={selectedPresetId}
                        onChange={(e) => setSelectedPresetId(e.target.value)}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 'var(--radius-sm)',
                          fontSize: 11,
                          background: 'var(--bg-elevated)',
                          border: '1px solid var(--border)',
                          color: 'var(--text-primary)',
                        }}
                      >
                        <option value="">Pick preset...</option>
                        {clipPresets.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                      <button
                        disabled={!selectedPresetId}
                        onClick={async () => {
                          const preset = clipPresets.find((p) => p.id === selectedPresetId);
                          if (!preset) return;
                          // Merge preset settings with current (preserve speaker colors)
                          const merged = {
                            ...clipSettings,
                            ...preset.settings,
                            speakerColors: clipSettings.speakerColors,
                          };
                          // Update UI settings panel to reflect the preset
                          setClipSettings(merged);
                          // Export selected clips using the merged settings directly
                          // (avoids React state batching delay)
                          for (const clipId of selectedClips) {
                            const clip = job.clips.find((c) => c.id === clipId);
                            if (clip) await handleExportClip(clip, merged);
                          }
                          showToast(`Applied "${preset.name}" and exporting ${selectedClips.size} clip(s)`, 'info');
                        }}
                        style={{
                          padding: '6px 12px',
                          background: selectedPresetId ? 'var(--accent-amber)' : 'var(--bg-elevated)',
                          color: selectedPresetId ? 'var(--bg-base)' : 'var(--text-muted)',
                          border: 'none',
                          borderRadius: 'var(--radius-sm)',
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: selectedPresetId ? 'pointer' : 'default',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        Apply &amp; Export
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Clip count */}
              {job.clips?.length > 0 && (
                <div style={{
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-muted)',
                  marginBottom: 12,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}>
                  Showing {filteredClips.length} of {job.clips.length} clips
                </div>
              )}

              {/* Clip cards */}
              <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))', gap: 16 }}>
                {filteredClips.map((clip) => (
                  <ClipCard
                    key={`${clip.id}_${clip.start_time}`}
                    clip={clip}
                    jobId={jobId}
                    isBest={clip.id === bestClipId}
                    onPreview={handleClipPreview}
                    onExport={handleExportClip}
                    onDelete={handleDeleteClip}
                    onTimesChanged={fetchJob}
                    selected={selectedClips.has(clip.id)}
                    onSelect={handleSelectClip}
                    exportQuality={clipSettings?.exportQuality || '1080p'}
                    scenes={job.scenes}
                  />
                ))}
              </div>
              {(!job.clips || job.clips.length === 0) && (
                <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
                  {isProcessing ? 'Detecting viral moments...' : 'No clips detected. Adjust the settings above and click Generate Clips.'}
                </div>
              )}
              {job.clips?.length > 0 && filteredClips.length === 0 && (
                <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
                  {clipSearchQuery.trim()
                    ? `No clips match "${clipSearchQuery.trim()}".`
                    : 'No clips match current filters.'}
                </div>
              )}

              {/* Exported clips */}
              {job.exported_clips?.length > 0 && (
                <div style={{ marginTop: 24 }}>
                  <h3 style={{ fontSize: 14, marginBottom: 12, color: 'var(--accent-cyan)' }}>Exported Clips</h3>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {job.exported_clips.map((ec, i) => (
                      <a
                        key={i}
                        href={`/api/files/${jobId}/clips/${ec.filename}`}
                        download
                        style={{
                          padding: '8px 16px',
                          background: 'var(--bg-elevated)',
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-sm)',
                          fontSize: 12,
                          color: 'var(--accent-cyan)',
                        }}
                      >
                        {ec.filename}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
