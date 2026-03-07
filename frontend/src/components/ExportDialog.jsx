import React, { useState, useCallback, useRef } from 'react';
import ExportEngine from '../engine/ExportEngine';

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
}) {
  const [quality, setQuality] = useState('1080p');
  const [exportMode, setExportMode] = useState('server'); // 'server' | 'client'
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const exportEngineRef = useRef(null);

  const canClientExport = ExportEngine.isWebCodecsAvailable();

  const handleExport = useCallback(async () => {
    setError(null);

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
      setError('Render engine not available');
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
      fps: 30,
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
  }, [exportMode, quality, renderEngine, tracks, clips, settings, mediaElements, startTime, endTime, aspectRatio, onServerExport, onClose]);

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
