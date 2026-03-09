import React, { useState, useCallback, useRef } from 'react';
import useTimelineStore from '../stores/timelineStore';
import useResponsive from '../hooks/useResponsive';

const ACCEPTED_IMAGE = '.png,.jpg,.jpeg,.gif,.webp,.svg';
const ACCEPTED_AUDIO = '.mp3,.wav,.ogg,.aac,.flac,.m4a';
const ACCEPTED_VIDEO = '.mp4,.mov,.avi,.mkv,.webm';

function formatDuration(s) {
  if (!s || isNaN(s) || s <= 0) return '--';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export default function MediaLibrary() {
  const { isMobile } = useResponsive();
  const mediaLibrary = useTimelineStore((s) => s.mediaLibrary);
  const addMedia = useTimelineStore((s) => s.addMedia);
  const removeMedia = useTimelineStore((s) => s.removeMedia);
  const removeMediaBatch = useTimelineStore((s) => s.removeMediaBatch);
  const fileRef = useRef(null);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(new Set());
  const [selectMode, setSelectMode] = useState(false);

  const filtered = filter === 'all'
    ? mediaLibrary
    : mediaLibrary.filter((m) => m.type === filter);

  const handleFiles = useCallback((files) => {
    Array.from(files).forEach((file) => {
      const ext = file.name.split('.').pop().toLowerCase();
      let type = 'video';
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) type = 'image';
      else if (['mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a'].includes(ext)) type = 'audio';

      const url = URL.createObjectURL(file);
      addMedia({
        type,
        filename: file.name,
        url,
        thumbnailUrl: type === 'image' ? url : '',
        duration: 0,
      });
    });
  }, [addMedia]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const handleDragStart = useCallback((e, media) => {
    if (selectMode) { e.preventDefault(); return; }
    e.dataTransfer.setData('application/x-clipai-media', JSON.stringify(media));
    e.dataTransfer.effectAllowed = 'copy';
  }, [selectMode]);

  const toggleSelect = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(filtered.map((m) => m.id)));
  }, [filtered]);

  const deselectAll = useCallback(() => {
    setSelected(new Set());
  }, []);

  const deleteSelected = useCallback(() => {
    if (selected.size === 0) return;
    const count = selected.size;
    if (!window.confirm(`Delete ${count} item${count > 1 ? 's' : ''} from the media library? Any timeline items referencing them will also be removed.`)) return;
    removeMediaBatch(Array.from(selected));
    setSelected(new Set());
    setSelectMode(false);
  }, [selected, removeMediaBatch]);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  const enterSelectMode = useCallback(() => {
    setSelectMode(true);
    setSelected(new Set());
  }, []);

  const allFilteredSelected = filtered.length > 0 && filtered.every((m) => selected.has(m.id));

  return (
    <div style={{ maxWidth: isMobile ? '100%' : 960, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ fontSize: isMobile ? 18 : 20, margin: 0 }}>Media Library</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          {selectMode ? (
            <>
              <button
                onClick={allFilteredSelected ? deselectAll : selectAll}
                style={{
                  padding: '8px 14px',
                  background: 'var(--bg-elevated)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                {allFilteredSelected ? 'Deselect All' : 'Select All'}
              </button>
              <button
                onClick={deleteSelected}
                disabled={selected.size === 0}
                style={{
                  padding: '8px 14px',
                  background: selected.size > 0 ? '#FF375F' : 'var(--bg-elevated)',
                  color: selected.size > 0 ? '#fff' : 'var(--text-muted)',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: selected.size > 0 ? 'pointer' : 'default',
                }}
              >
                Delete{selected.size > 0 ? ` (${selected.size})` : ''}
              </button>
              <button
                onClick={exitSelectMode}
                style={{
                  padding: '8px 14px',
                  background: 'var(--bg-elevated)',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              {mediaLibrary.length > 0 && (
                <button
                  onClick={enterSelectMode}
                  style={{
                    padding: '8px 14px',
                    background: 'var(--bg-elevated)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Select
                </button>
              )}
              <button
                onClick={() => fileRef.current?.click()}
                style={{
                  padding: '8px 16px',
                  background: 'var(--accent-cyan)',
                  color: 'var(--bg-base)',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                + Add Media
              </button>
            </>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={`${ACCEPTED_VIDEO},${ACCEPTED_IMAGE},${ACCEPTED_AUDIO}`}
          multiple
          onChange={(e) => handleFiles(e.target.files)}
          style={{ display: 'none' }}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {['all', 'video', 'audio', 'image'].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding: '5px 12px',
              fontSize: 12,
              fontWeight: filter === f ? 600 : 400,
              background: filter === f ? 'var(--accent-cyan-dim)' : 'var(--bg-elevated)',
              color: filter === f ? 'var(--accent-cyan)' : 'var(--text-secondary)',
              border: `1px solid ${filter === f ? 'var(--accent-cyan)' : 'var(--border)'}`,
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              textTransform: 'capitalize',
            }}
          >
            {f}
          </button>
        ))}
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
        onDrop={handleDrop}
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: 12,
          minHeight: 200,
        }}
      >
        {filtered.length === 0 && (
          <div style={{
            gridColumn: '1 / -1',
            textAlign: 'center',
            padding: '48px 24px',
            color: 'var(--text-muted)',
            fontSize: 13,
            border: '2px dashed var(--border)',
            borderRadius: 'var(--radius-lg)',
          }}>
            No media files. Drag and drop files here or click "Add Media".
          </div>
        )}
        {filtered.map((media) => {
          const isSelected = selected.has(media.id);
          return (
            <div
              key={media.id}
              draggable={!selectMode}
              onDragStart={(e) => handleDragStart(e, media)}
              onClick={selectMode ? () => toggleSelect(media.id) : undefined}
              style={{
                background: 'var(--bg-panel)',
                border: `2px solid ${isSelected ? 'var(--accent-cyan)' : 'var(--border)'}`,
                borderRadius: 'var(--radius-sm)',
                overflow: 'hidden',
                cursor: selectMode ? 'pointer' : 'grab',
                transition: 'border-color 0.15s, box-shadow 0.15s',
                boxShadow: isSelected ? '0 0 0 2px rgba(0, 200, 255, 0.2)' : 'none',
                position: 'relative',
              }}
            >
              {/* Selection checkbox overlay */}
              {selectMode && (
                <div style={{
                  position: 'absolute',
                  top: 6,
                  left: 6,
                  zIndex: 2,
                  width: 20,
                  height: 20,
                  borderRadius: 4,
                  background: isSelected ? 'var(--accent-cyan)' : 'rgba(0,0,0,0.5)',
                  border: `2px solid ${isSelected ? 'var(--accent-cyan)' : 'rgba(255,255,255,0.4)'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#fff',
                  fontSize: 12,
                  fontWeight: 700,
                  pointerEvents: 'none',
                }}>
                  {isSelected ? '\u2713' : ''}
                </div>
              )}

              <div style={{
                height: 100,
                background: 'var(--bg-elevated)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
              }}>
                {media.thumbnailUrl ? (
                  <img src={media.thumbnailUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <span style={{ fontSize: 28, opacity: 0.3 }}>
                    {media.type === 'video' ? '\uD83C\uDFAC' : media.type === 'audio' ? '\uD83C\uDFB5' : '\uD83D\uDDBC'}
                  </span>
                )}
              </div>
              <div style={{ padding: '8px 10px' }}>
                <div style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  marginBottom: 4,
                }}>
                  {media.filename}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{
                    fontSize: 10,
                    color: 'var(--text-muted)',
                    textTransform: 'uppercase',
                    fontFamily: 'var(--font-mono)',
                  }}>
                    {media.type} {media.duration > 0 ? `| ${formatDuration(media.duration)}` : ''}
                  </span>
                  {!selectMode && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`Delete "${media.filename}" from the media library?`)) {
                          removeMedia(media.id);
                        }
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-muted)',
                        fontSize: 12,
                        cursor: 'pointer',
                        padding: '2px 4px',
                        borderRadius: 'var(--radius-xs)',
                      }}
                      title="Delete"
                    >
                      x
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 16, lineHeight: 1.5 }}>
        Drag items from here onto the multi-track timeline in the video editor.
        Supported formats: video (MP4, MOV, WebM), audio (MP3, WAV, OGG), images (PNG, JPG, GIF, WebP, SVG).
      </p>
    </div>
  );
}
