import React, { useState, useCallback, useRef, useMemo } from 'react';
import ExportEngine from '../engine/ExportEngine';
import useTimelineStore from '../stores/timelineStore';
import { runSubtitleQA } from '../utils/subtitleQA';

const QUALITY_PRESETS = [
  { id: '720p', label: '720p', w: 1280, h: 720, bitrate: 4_000_000 },
  { id: '1080p', label: '1080p', w: 1920, h: 1080, bitrate: 8_000_000 },
  { id: '1440p', label: '1440p', w: 2560, h: 1440, bitrate: 16_000_000 },
  { id: '4k', label: '4K', w: 3840, h: 2160, bitrate: 35_000_000 },
];

const ASPECT_DIMS = {
  '16:9': { w: 1920, h: 1080 },
  '9:16': { w: 1080, h: 1920 },
  '1:1': { w: 1080, h: 1080 },
  '4:5': { w: 1080, h: 1350 },
};

export default function ExportDialog({
  onClose,
  onServerExport,
  renderEngine,
  tracks,
  clips,
  settings,
  mediaElements,
  startTime = 0,
  endTime = 0,
  aspectRatio,
  jobId,
  clipId,
  transcript,
  scenes,
  sourceWidth = 1920,
  sourceHeight = 1080,
  subjectX = 50,
}) {
  const [quality, setQuality] = useState('1080p');
  const [exportMode, setExportMode] = useState('server'); // 'server' | 'client'
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [qaReport, setQaReport] = useState(null);
  const exportEngineRef = useRef(null);

  const canClientExport = ExportEngine.isWebCodecsAvailable();

  // Run subtitle QA validation
  const timelineItems = useTimelineStore((s) => s.items);

  // Compute optimal FPS (may be boosted for active word highlighting)
  const exportFPS = useMemo(() => {
    return ExportEngine.computeOptimalFPS(timelineItems, settings, 30);
  }, [timelineItems, settings]);

  const subtitleQA = useMemo(() => {
    const preset = QUALITY_PRESETS.find(p => p.id === quality) || QUALITY_PRESETS[1];
    let exportW = preset.w;
    let exportH = preset.h;
    if (aspectRatio && ASPECT_DIMS[aspectRatio]) {
      const dims = ASPECT_DIMS[aspectRatio];
      const scale = preset.h / dims.h;
      exportW = Math.round(dims.w * scale);
      exportH = Math.round(dims.h * scale);
    }
    const syncInfo = transcript ? { transcript, clipStart: startTime, clipEnd: endTime } : undefined;
    const trackingInfo = scenes?.length ? {
      scenes, clipStart: startTime, clipEnd: endTime,
      srcW: sourceWidth, srcH: sourceHeight, subjectX,
    } : null;
    return runSubtitleQA(timelineItems, settings, { w: exportW, h: exportH }, syncInfo, exportFPS, trackingInfo, aspectRatio);
  }, [timelineItems, settings, quality, aspectRatio, transcript, startTime, endTime, exportFPS, scenes, sourceWidth, sourceHeight, subjectX]);

  const handleExport = useCallback(async () => {
    setError(null);
    setQaReport(subtitleQA);

    // Block export if subtitle QA has errors
    if (!subtitleQA.valid) {
      setError(`Export blocked: ${subtitleQA.errors.join('; ')}`);
      return;
    }

    if (exportMode === 'server') {
      const preset = QUALITY_PRESETS.find(p => p.id === quality) || QUALITY_PRESETS[1];
      const exportPayload = {
        quality: preset.id,
        ...(settings || {}),
        ...(jobId ? { jobId } : {}),
        ...(clipId ? { clipId } : {}),
        startTime,
        endTime,
      };

      // Include multi-track editor video effects so export matches preview 1:1
      const videoItem = timelineItems.find(it => it.type === 'video');
      if (videoItem?.effects) {
        const fx = videoItem.effects;
        const hasEffects = (fx.brightness || 0) !== 0 || (fx.contrast || 0) !== 0 ||
          (fx.saturation || 0) !== 0 || (fx.blur || 0) > 0 ||
          (fx.hueRotate || 0) > 0 || (fx.sepia || 0) > 0 ||
          (videoItem.opacity ?? 1) < 1;
        if (hasEffects) {
          exportPayload.video_effects = {
            brightness: fx.brightness || 0,
            contrast: fx.contrast || 0,
            saturation: fx.saturation || 0,
            blur: fx.blur || 0,
            hue_rotate: fx.hueRotate || 0,
            sepia: fx.sepia || 0,
            opacity: videoItem.opacity ?? 1,
          };
        }
      }

      // Include text overlays from the timeline
      const textItems = timelineItems.filter(it => it.type === 'text');
      if (textItems.length > 0) {
        exportPayload.text_overlays = textItems.map(it => ({
          text: it.text || '',
          x: it.position?.x ?? 50,
          y: it.position?.y ?? 50,
          font_size: it.fontSize || 48,
          font_color: it.fontColor || '#FFFFFF',
          font_family: it.fontFamily || 'sans-serif',
          background_color: it.backgroundColor || null,
          start_time: it.start || 0,
          end_time: it.end || 0,
          rotation: it.transform?.rotation || 0,
          opacity: it.opacity ?? 1,
        }));
      }

      // Include image overlays from the timeline
      const imageItems = timelineItems.filter(it => it.type === 'image' || it.type === 'overlay');
      if (imageItems.length > 0) {
        exportPayload.image_overlays = imageItems.map(it => ({
          src: it.src || it.mediaRef || '',
          x: it.position?.x ?? 50,
          y: it.position?.y ?? 50,
          width: it.size?.w ?? 30,
          height: it.size?.h ?? 30,
          start_time: it.start || 0,
          end_time: it.end || 0,
          opacity: it.opacity ?? 1,
        }));
      }

      if (onServerExport) {
        onServerExport(exportPayload);
      } else if (jobId && clipId) {
        fetch(`/api/export/${jobId}/${clipId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(exportPayload),
        }).catch(() => {});
      }
      onClose?.();
      return;
    }

    // Client-side export
    if (!renderEngine) {
      setError('Client-side export is not yet available. Please use Server Export.');
      return;
    }

    setIsExporting(true);
    setProgress(0);

    const preset = QUALITY_PRESETS.find(p => p.id === quality) || QUALITY_PRESETS[1];
    let exportW = preset.w;
    let exportH = preset.h;

    if (aspectRatio && ASPECT_DIMS[aspectRatio]) {
      const dims = ASPECT_DIMS[aspectRatio];
      const scale = preset.h / dims.h;
      exportW = Math.round(dims.w * scale);
      exportH = Math.round(dims.h * scale);
    }

    const engine = new ExportEngine(renderEngine, {
      fps: exportFPS,
      videoBitrate: preset.bitrate,
      width: exportW,
      height: exportH,
      onProgress: setProgress,
      onError: (msg) => { setError(msg); setIsExporting(false); },
      onComplete: (blob) => {
        setIsExporting(false);
        setProgress(100);
        // Download the blob
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `export-${Date.now()}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      },
    });

    exportEngineRef.current = engine;

    // Ensure render engine is at export resolution
    renderEngine.setResolution(exportW, exportH);

    await engine.export(startTime, endTime, tracks, clips, settings, mediaElements);
  }, [exportMode, quality, renderEngine, tracks, clips, settings, mediaElements, startTime, endTime, aspectRatio, onServerExport, onClose, subtitleQA]);

  const handleCancel = useCallback(() => {
    if (exportEngineRef.current) {
      exportEngineRef.current.cancel();
    }
    setIsExporting(false);
    setProgress(0);
  }, []);

  return (
    <div className="ve-export-dialog" onClick={(e) => e.stopPropagation()}>
      <div className="ve-export-dialog__header">
        <span className="ve-export-dialog__title">Export Video</span>
        <button className="ve-export-dialog__close" onClick={onClose}>✕</button>
      </div>

      {/* Export mode toggle */}
      <div className="ve-export-dialog__mode">
        <button
          className={`ve-export-dialog__mode-btn${exportMode === 'server' ? ' ve-export-dialog__mode-btn--active' : ''}`}
          onClick={() => setExportMode('server')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="2" width="20" height="8" rx="2" />
            <rect x="2" y="14" width="20" height="8" rx="2" />
            <circle cx="6" cy="6" r="1" fill="currentColor" />
            <circle cx="6" cy="18" r="1" fill="currentColor" />
          </svg>
          Server Export
        </button>
        <button
          className={`ve-export-dialog__mode-btn${exportMode === 'client' ? ' ve-export-dialog__mode-btn--active' : ''}`}
          onClick={() => setExportMode('client')}
          disabled={!canClientExport}
          title={canClientExport ? 'Export in browser' : 'WebCodecs not available in this browser'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
          Browser Export {!canClientExport && '(N/A)'}
        </button>
      </div>

      {/* Quality picker */}
      <div className="ve-export-dialog__quality">
        <label className="ve-export-dialog__label">Quality</label>
        <div className="ve-export-dialog__quality-pills">
          {QUALITY_PRESETS.map((p) => (
            <button
              key={p.id}
              className={`ve-export-dialog__quality-pill${quality === p.id ? ' ve-export-dialog__quality-pill--active' : ''}`}
              onClick={() => setQuality(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Info */}
      <div className="ve-export-dialog__info">
        {exportMode === 'server' ? (
          <p>Export will be processed on the server using FFmpeg with full quality encoding.</p>
        ) : (
          <p>Export directly in your browser using WebCodecs. Faster for short clips, no server needed.</p>
        )}
        {exportFPS > 30 && (
          <p style={{ fontSize: 11, color: 'var(--ve-accent, #0A84FF)', marginTop: 4 }}>
            FPS boosted to {exportFPS}fps for smooth active word highlighting.
          </p>
        )}
      </div>

      {/* Progress */}
      {isExporting && (
        <div className="ve-export-dialog__progress">
          <div className="ve-export-dialog__progress-bar">
            <div
              className="ve-export-dialog__progress-fill"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="ve-export-dialog__progress-text">{progress}%</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="ve-export-dialog__error">{error}</div>
      )}

      {/* Subtitle QA Report */}
      <div style={{
        margin: '8px 16px',
        padding: '8px 12px',
        borderRadius: 6,
        fontSize: 11,
        lineHeight: 1.5,
        background: subtitleQA.valid
          ? (subtitleQA.warnings.length > 0 ? 'rgba(255, 159, 10, 0.12)' : 'rgba(48, 209, 88, 0.12)')
          : 'rgba(255, 55, 95, 0.12)',
        border: `1px solid ${subtitleQA.valid
          ? (subtitleQA.warnings.length > 0 ? 'rgba(255, 159, 10, 0.3)' : 'rgba(48, 209, 88, 0.3)')
          : 'rgba(255, 55, 95, 0.3)'}`,
        color: 'var(--ve-text, #fff)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: subtitleQA.errors.length + subtitleQA.warnings.length > 0 ? 4 : 0 }}>
          <span style={{ fontSize: 13 }}>{subtitleQA.valid ? (subtitleQA.warnings.length > 0 ? '⚠' : '✓') : '✕'}</span>
          <span style={{ fontWeight: 600 }}>Export QA: {subtitleQA.summary}</span>
        </div>
        {subtitleQA.confidence && (
          <div style={{ fontSize: 10, paddingLeft: 20, marginBottom: 2, color: subtitleQA.confidence === 'high' ? '#30D158' : subtitleQA.confidence === 'medium' ? '#FF9F0A' : '#FF375F' }}>
            Preview-to-export match confidence: {subtitleQA.confidence}
            {subtitleQA.confidence === 'high' && ' — exported video will look exactly like preview'}
          </div>
        )}
        {/* Per-check breakdown */}
        {subtitleQA.checks && subtitleQA.checks.map((check, ci) => {
          const hasIssues = check.errors.length > 0 || check.warnings.length > 0;
          const icon = check.errors.length > 0 ? '✕' : check.warnings.length > 0 ? '⚠' : '✓';
          const iconColor = check.errors.length > 0 ? '#FF375F' : check.warnings.length > 0 ? '#FF9F0A' : '#30D158';
          return (
            <div key={ci} style={{ marginTop: ci > 0 ? 4 : 2, paddingLeft: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ color: iconColor, fontSize: 10 }}>{icon}</span>
                <span style={{ fontWeight: 500 }}>{check.name}</span>
              </div>
              {check.errors.map((e, i) => (
                <div key={`ce-${ci}-${i}`} style={{ color: '#FF375F', paddingLeft: 18, fontSize: 10 }}>• {e}</div>
              ))}
              {check.warnings.map((w, i) => (
                <div key={`cw-${ci}-${i}`} style={{ color: '#FF9F0A', paddingLeft: 18, fontSize: 10 }}>• {w}</div>
              ))}
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="ve-export-dialog__actions">
        {isExporting ? (
          <button className="ve-export-dialog__btn ve-export-dialog__btn--cancel" onClick={handleCancel}>
            Cancel
          </button>
        ) : (
          <>
            <button className="ve-export-dialog__btn ve-export-dialog__btn--secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="ve-export-dialog__btn ve-export-dialog__btn--primary" onClick={handleExport}>
              Export
            </button>
          </>
        )}
      </div>
    </div>
  );
}
