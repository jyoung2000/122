import React, { useState, useMemo } from 'react';
import ScoreRing from './ScoreRing';
import { SparkleIcon, TrashIcon } from './icons';

function formatDuration(seconds) {
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

export default function ClipCard({ clip, jobId, isBest, onPreview, onExport, onDelete, onTimesChanged, selected, onSelect, exportQuality = '1080p', scenes }) {
  const [exporting, setExporting] = useState(false);
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editingTimes, setEditingTimes] = useState(false);
  const [startText, setStartText] = useState('');
  const [endText, setEndText] = useState('');
  const [savingTimes, setSavingTimes] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleText, setTitleText] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Find the most important scene description within this clip's time range
  const clipSubject = useMemo(() => {
    if (!scenes?.length) return null;
    const inRange = scenes.filter(
      (s) => s.timestamp >= clip.start_time && s.timestamp <= clip.end_time
    );
    if (!inRange.length) return null;
    const best = inRange.reduce((a, b) => (b.importance_score > a.importance_score ? b : a), inRange[0]);
    return best.description;
  }, [scenes, clip.start_time, clip.end_time]);

  const handleExport = async (qualityOverride) => {
    setExporting(true);
    setQualityMenuOpen(false);
    try {
      await onExport(clip, qualityOverride);
    } finally {
      setExporting(false);
    }
  };

  const openTimeEdit = () => {
    setStartText(formatDuration(clip.start_time));
    setEndText(formatDuration(clip.end_time));
    setEditingTimes(true);
  };

  const cancelTimeEdit = () => {
    setEditingTimes(false);
  };

  const saveTimeEdit = async () => {
    const newStart = parseDuration(startText);
    const newEnd = parseDuration(endText);
    if (newStart === null || newEnd === null || newStart >= newEnd || newStart < 0) return;
    setSavingTimes(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/clips/${clip.id}/times`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_time: newStart, end_time: newEnd }),
      });
      if (res.ok) {
        setEditingTimes(false);
        if (onTimesChanged) onTimesChanged();
      }
    } catch {
      // ignore
    } finally {
      setSavingTimes(false);
    }
  };

  const openTitleEdit = () => {
    setTitleText(clip.title || '');
    setEditingTitle(true);
  };

  const saveTitleEdit = async () => {
    const trimmed = titleText.trim();
    if (!trimmed || trimmed === clip.title) { setEditingTitle(false); return; }
    setSavingTitle(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/clips/${clip.id}/title`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      });
      if (res.ok) {
        setEditingTitle(false);
        if (onTimesChanged) onTimesChanged();
      }
    } catch {
      // ignore
    } finally {
      setSavingTitle(false);
    }
  };

  const platformLabel = (clip.platform || '').replace(/_/g, ' ');

  return (
    <div
      className="card-hover"
      style={{
        background: 'var(--bg-panel)',
        border: `1px solid ${selected ? 'var(--accent-cyan)' : isBest ? 'var(--accent-amber)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-sm)',
        overflow: 'hidden',
        animation: 'cardAppear 0.4s var(--ease-spring) forwards',
        animationDelay: `${(clip.id % 20) * 60}ms`,
        opacity: 0,
        ...(selected ? {
          borderLeftWidth: 3,
          borderLeftColor: 'var(--accent-cyan)',
          background: 'var(--accent-cyan-dim)',
        } : {}),
      }}
    >
      {/* Thumbnail area */}
      <div
        style={{
          position: 'relative',
          background: 'var(--video-bg)',
          height: 140,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          overflow: 'hidden',
        }}
        onClick={() => onPreview(clip)}
      >
        {/* Thumbnail image (try to load from API) */}
        {jobId && (
          <img
            src={`/api/jobs/${jobId}/clips/${clip.id}/thumb`}
            alt=""
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              position: 'absolute',
              inset: 0,
            }}
            onError={(e) => { e.target.style.display = 'none'; }}
          />
        )}
        {/* Play overlay */}
        <div style={{
          width: 40,
          height: 40,
          borderRadius: '50%',
          background: 'rgba(0,0,0,0.45)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          zIndex: 2,
        }}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
            <path d="M5.5 3.5a1 1 0 011.5-.87l10 6a1 1 0 010 1.74l-10 6A1 1 0 015.5 15.5v-12z" />
          </svg>
        </div>
        {/* Duration badge */}
        <span style={{
          position: 'absolute',
          bottom: 6,
          right: 6,
          padding: '2px 8px',
          background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(8px)',
          borderRadius: 'var(--radius-xl)',
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          fontWeight: 600,
          color: '#fff',
          zIndex: 2,
        }}>
          {formatDuration(clip.duration)}
        </span>
        {/* Best badge */}
        {isBest && (
          <span style={{
            position: 'absolute',
            top: 6,
            left: 6,
            padding: '2px 8px',
            background: 'var(--accent-amber)',
            borderRadius: 'var(--radius-xl)',
            fontSize: 10,
            fontWeight: 700,
            color: '#fff',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            zIndex: 2,
          }}>
            Best
          </span>
        )}
        {/* Select checkbox */}
        {onSelect && (
          <div style={{ position: 'absolute', top: 6, right: 6, zIndex: 3 }} onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={selected || false}
              onChange={(e) => onSelect(clip.id, e.target.checked)}
              style={{ accentColor: 'var(--accent-cyan)', width: 16, height: 16, cursor: 'pointer' }}
            />
          </div>
        )}
        {/* Delete button */}
        {onDelete && (
          <button
            className="clip-delete-btn"
            onClick={async (e) => {
              e.stopPropagation();
              if (!window.confirm(`Delete clip ${clip.id} "${clip.title}"?`)) return;
              setDeleting(true);
              try { await onDelete(clip); } finally { setDeleting(false); }
            }}
            disabled={deleting}
            title="Delete clip"
            style={{
              position: 'absolute',
              top: 6,
              right: onSelect ? 28 : 6,
              padding: 4,
              background: 'rgba(0,0,0,0.5)',
              backdropFilter: 'blur(8px)',
              color: 'var(--danger)',
              border: '1px solid transparent',
              borderRadius: 'var(--radius-xs)',
              cursor: deleting ? 'default' : 'pointer',
              opacity: 0,
              transition: 'opacity 0.15s',
              zIndex: 3,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <TrashIcon size={14} />
          </button>
        )}
      </div>

      {/* Card body */}
      <div style={{ padding: '12px 14px' }}>
        {/* Title */}
        {editingTitle ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
            <input
              type="text"
              value={titleText}
              onChange={(e) => setTitleText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveTitleEdit(); if (e.key === 'Escape') setEditingTitle(false); }}
              autoFocus
              style={{
                flex: 1, padding: '4px 8px', fontSize: 13, fontWeight: 600,
                background: 'var(--bg-base)', color: 'var(--text-primary)',
                border: '1px solid var(--accent-cyan)', borderRadius: 'var(--radius-sm)',
                outline: 'none', lineHeight: 1.3, minWidth: 0,
              }}
            />
            <button
              onClick={saveTitleEdit}
              disabled={savingTitle}
              style={{
                padding: '3px 8px', fontSize: 10, fontWeight: 600,
                background: 'var(--accent-cyan)', color: '#fff',
                border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
              }}
            >
              {savingTitle ? '...' : 'Save'}
            </button>
          </div>
        ) : (
          <h4
            onClick={jobId && onTimesChanged ? openTitleEdit : undefined}
            title={jobId && onTimesChanged ? 'Click to edit title' : undefined}
            style={{
              fontSize: 13, fontWeight: 500, marginBottom: 8, lineHeight: 1.4,
              cursor: jobId && onTimesChanged ? 'pointer' : 'default',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              letterSpacing: '-0.01em',
            }}
          >
            {clip.title}
          </h4>
        )}

        {/* Score ring + metadata row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <ScoreRing score={clip.viral_score} size={36} />

          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Time display / editor */}
            {editingTimes ? (
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={startText}
                  onChange={(e) => setStartText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveTimeEdit(); if (e.key === 'Escape') cancelTimeEdit(); }}
                  placeholder="0:00"
                  style={{
                    width: 48, padding: '2px 4px', fontSize: 11,
                    fontFamily: 'var(--font-mono)', background: 'var(--bg-base)',
                    border: '1px solid var(--accent-cyan)', borderRadius: 'var(--radius-xs)',
                    color: 'var(--accent-cyan)', textAlign: 'center', outline: 'none',
                  }}
                />
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>&rarr;</span>
                <input
                  type="text"
                  value={endText}
                  onChange={(e) => setEndText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveTimeEdit(); if (e.key === 'Escape') cancelTimeEdit(); }}
                  placeholder="0:00"
                  style={{
                    width: 48, padding: '2px 4px', fontSize: 11,
                    fontFamily: 'var(--font-mono)', background: 'var(--bg-base)',
                    border: '1px solid var(--accent-cyan)', borderRadius: 'var(--radius-xs)',
                    color: 'var(--accent-cyan)', textAlign: 'center', outline: 'none',
                  }}
                />
                <button
                  onClick={saveTimeEdit}
                  disabled={savingTimes}
                  style={{
                    padding: '2px 6px', fontSize: 9, fontWeight: 600,
                    background: 'var(--accent-cyan)', color: '#fff',
                    border: 'none', borderRadius: 'var(--radius-xs)', cursor: 'pointer',
                  }}
                >
                  {savingTimes ? '...' : 'OK'}
                </button>
                <button
                  onClick={cancelTimeEdit}
                  style={{
                    padding: '2px 6px', fontSize: 9,
                    background: 'none', color: 'var(--text-muted)',
                    border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <span
                  onClick={jobId && onTimesChanged ? openTimeEdit : undefined}
                  title={jobId && onTimesChanged ? 'Click to edit clip times' : undefined}
                  style={{
                    fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)',
                    cursor: jobId && onTimesChanged ? 'pointer' : 'default',
                  }}
                >
                  {formatDuration(clip.start_time)} &rarr; {formatDuration(clip.end_time)}
                </span>
                {clip.speaker && (
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    {clip.speaker}
                  </span>
                )}
              </div>
            )}

            {/* Platform tags */}
            {!editingTimes && (
              <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 10, fontWeight: 500,
                  padding: '1px 7px',
                  borderRadius: 'var(--radius-xl)',
                  background: 'var(--bg-surface-2)',
                  color: 'var(--text-secondary)',
                  textTransform: 'capitalize',
                }}>
                  {platformLabel}
                </span>
                <span style={{
                  fontSize: 10, fontWeight: 500,
                  padding: '1px 7px',
                  borderRadius: 'var(--radius-xl)',
                  background: 'var(--bg-surface-2)',
                  color: 'var(--text-muted)',
                }}>
                  {clip.clip_type}
                </span>
                {clip.clip_focus && (
                  <span style={{
                    fontSize: 10, fontWeight: 600,
                    padding: '1px 7px',
                    borderRadius: 'var(--radius-xl)',
                    background: 'var(--success-dim)',
                    color: 'var(--success)',
                  }}>
                    {clip.clip_focus}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Expandable details */}
        {(clip.hook_text || clip.suggested_caption || clip.why_this_works || clipSubject) && (
          <>
            <button
              onClick={() => setExpanded(!expanded)}
              style={{
                background: 'none',
                border: 'none',
                fontSize: 11,
                color: 'var(--accent-cyan)',
                cursor: 'pointer',
                padding: '2px 0',
                marginBottom: expanded ? 8 : 0,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              {expanded ? 'Less' : 'Details'}
              <span style={{
                display: 'inline-block',
                transition: 'transform 0.2s var(--ease-spring)',
                transform: expanded ? 'rotate(180deg)' : 'rotate(0)',
                fontSize: 10,
              }}>
                ▾
              </span>
            </button>
            {expanded && (
              <div style={{
                fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5,
                padding: '8px 10px',
                background: 'var(--bg-surface-1)',
                borderRadius: 'var(--radius-sm)',
                marginBottom: 8,
              }}>
                {clipSubject && (
                  <div style={{ marginBottom: 6, fontSize: 11, color: 'var(--text-muted)', borderLeft: '2px solid var(--accent-cyan)', paddingLeft: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-secondary)' }}>Subject: </span>
                    {clipSubject.length > 120 ? clipSubject.slice(0, 120) + '...' : clipSubject}
                  </div>
                )}
                {clip.hook_text && (
                  <div style={{ marginBottom: 4 }}>
                    <strong style={{ color: 'var(--text-primary)', fontSize: 11 }}>Hook:</strong> {clip.hook_text}
                  </div>
                )}
                {clip.suggested_caption && (
                  <div style={{ marginBottom: 4 }}>
                    <strong style={{ color: 'var(--text-primary)', fontSize: 11 }}>Caption:</strong> {clip.suggested_caption}
                  </div>
                )}
                {clip.why_this_works && (
                  <div style={{ marginBottom: 4 }}>
                    <strong style={{ color: 'var(--text-primary)', fontSize: 11 }}>Why it works:</strong> {clip.why_this_works}
                  </div>
                )}
                {clip.viral_score_reasoning && (
                  <div>
                    <strong style={{ color: 'var(--text-primary)', fontSize: 11 }}>Score reasoning:</strong> {clip.viral_score_reasoning}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
          <button
            onClick={() => onPreview(clip)}
            style={{
              flex: '1 1 0%',
              padding: '8px 8px',
              background: 'var(--bg-surface-2)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12,
              fontWeight: 500,
              whiteSpace: 'nowrap',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              transition: 'all 0.15s ease',
            }}
          >
            Preview
          </button>
          <div style={{ flex: '1 1 0%', position: 'relative', minWidth: 0, display: 'flex' }}>
            <div style={{ display: 'flex', flex: 1, minWidth: 0 }}>
              <button
                onClick={() => handleExport()}
                disabled={exporting}
                style={{
                  flex: 1,
                  padding: '8px 8px',
                  background: exporting ? 'var(--bg-elevated)' : 'var(--accent-cyan)',
                  color: exporting ? 'var(--text-secondary)' : '#fff',
                  border: 'none',
                  borderRadius: 'var(--radius-sm) 0 0 var(--radius-sm)',
                  fontSize: 12,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                }}
              >
                <SparkleIcon size={12} />
                {exporting ? 'Exporting...' : 'Export'}
              </button>
              <button
                onClick={() => setQualityMenuOpen(!qualityMenuOpen)}
                disabled={exporting}
                style={{
                  padding: '8px 6px',
                  background: exporting ? 'var(--bg-elevated)' : 'var(--accent-cyan)',
                  color: exporting ? 'var(--text-secondary)' : '#fff',
                  border: 'none',
                  borderLeft: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
                  fontSize: 10,
                  cursor: exporting ? 'default' : 'pointer',
                  flexShrink: 0,
                }}
              >
                ▾
              </button>
            </div>
            {qualityMenuOpen && (
              <div style={{
                position: 'absolute', bottom: '100%', left: 0, right: 0,
                marginBottom: 2, background: 'var(--glass-bg)',
                backdropFilter: 'blur(20px)',
                border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-sm)',
                zIndex: 20, overflow: 'hidden',
                boxShadow: 'var(--shadow-lg)',
              }}>
                {['720p', '1080p', '4k'].map((q) => (
                  <button
                    key={q}
                    onClick={() => handleExport(q)}
                    style={{
                      display: 'block', width: '100%', padding: '8px 12px',
                      background: q === exportQuality ? 'var(--accent-cyan-dim)' : 'transparent',
                      color: q === exportQuality ? 'var(--accent-cyan)' : 'var(--text-primary)',
                      border: 'none', fontSize: 12, textAlign: 'left',
                      cursor: 'pointer',
                      fontWeight: q === exportQuality ? 600 : 400,
                    }}
                  >
                    {q === '720p' ? '720p' : q === '1080p' ? '1080p' : '4K'}
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 }}>
                      {q === '720p' ? 'Smaller' : q === '1080p' ? 'Default' : 'Best'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
