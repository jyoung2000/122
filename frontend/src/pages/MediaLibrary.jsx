import React, { useState, useEffect, useCallback, useRef } from 'react';
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
  const fileRef = useRef(null);
  const [filter, setFilter] = useState('all');

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
    e.dataTransfer.setData('application/x-clipai-media', JSON.stringify(media));
    e.dataTransfer.effectAllowed = 'copy';
  }, []);

  return (
    <div style={{ maxWidth: isMobile ? '100%' : 960, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h2 style={{ fontSize: isMobile ? 18 : 20, margin: 0 }}>Media Library</h2>
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
        {filtered.map((media) => (
          <div
            key={media.id}
            draggable
            onDragStart={(e) => handleDragStart(e, media)}
            style={{
              background: 'var(--bg-panel)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              overflow: 'hidden',
              cursor: 'grab',
              transition: 'border-color 0.15s',
            }}
          >
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
                <button
                  onClick={(e) => { e.stopPropagation(); removeMedia(media.id); }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-muted)',
                    fontSize: 12,
                    cursor: 'pointer',
                    padding: '2px 4px',
                    borderRadius: 'var(--radius-xs)',
                  }}
                  title="Remove"
                >
                  x
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 16, lineHeight: 1.5 }}>
        Drag items from here onto the multi-track timeline in the video editor.
        Supported formats: video (MP4, MOV, WebM), audio (MP3, WAV, OGG), images (PNG, JPG, GIF, WebP, SVG).
      </p>
    </div>
  );
}
