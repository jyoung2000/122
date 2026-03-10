import React, { useState, useCallback, useRef, useEffect } from 'react';
import useTimelineStore from '../stores/timelineStore';

const ACCEPT_MAP = {
  video: { accept: '.mp4,.mov,.webm,.mkv', label: 'Video', icon: '🎬', maxSize: 2 * 1024 * 1024 * 1024 },
  audio: { accept: '.mp3,.wav,.aac,.ogg,.flac', label: 'Audio', icon: '🎵', maxSize: 500 * 1024 * 1024 },
  image: { accept: '.png,.jpg,.jpeg,.gif,.webp', label: 'Image', icon: '🖼️', maxSize: 50 * 1024 * 1024 },
};

const MIME_MAP = {
  video: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/x-wav'],
  image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
};

function detectMediaType(file) {
  for (const [type, mimes] of Object.entries(MIME_MAP)) {
    if (mimes.some((m) => file.type.startsWith(m.split('/')[0]))) return type;
  }
  // Fallback: check extension
  const ext = file.name.split('.').pop().toLowerCase();
  if (['mp4', 'mov', 'webm', 'mkv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'aac', 'ogg', 'flac'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
  return null;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function generateVideoThumbnail(file) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    // Note: don't set crossOrigin for same-origin blob/server URLs

    const captureFrame = () => {
      try {
        const canvas = document.createElement('canvas');
        const w = Math.min(video.videoWidth || 120, 240);
        const h = Math.round(w * (video.videoHeight || 68) / (video.videoWidth || 120));
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(video, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        // Check if the frame is not blank (very short data URL = blank)
        if (dataUrl.length > 500) {
          done({ thumbnailUrl: dataUrl, duration: video.duration || 0 });
          URL.revokeObjectURL(url);
          return true;
        }
      } catch { /* fall through */ }
      return false;
    };

    video.onseeked = () => {
      if (!captureFrame() && video.currentTime === 0) {
        // If seeking to 0.5 failed, try frame at 0
        // Already at 0, just resolve without thumbnail
        done({ thumbnailUrl: '', duration: video.duration || 0 });
        URL.revokeObjectURL(url);
      } else if (!resolved && video.currentTime > 0) {
        // Try time 0 as fallback
        video.currentTime = 0;
      }
    };

    video.onloadedmetadata = () => {
      // Seek to 0.5s or 10% of duration, whichever is smaller
      const seekTime = Math.min(0.5, (video.duration || 1) * 0.1);
      video.currentTime = seekTime;
    };

    video.onerror = () => {
      URL.revokeObjectURL(url);
      done({ thumbnailUrl: '', duration: 0 });
    };

    video.src = url;
    // Load explicitly to trigger metadata loading
    video.load();

    setTimeout(() => {
      // Last resort: try to capture whatever frame is available
      if (!resolved) {
        captureFrame();
        if (!resolved) {
          done({ thumbnailUrl: '', duration: video.duration || 0 });
        }
        URL.revokeObjectURL(url);
      }
    }, 10000);
  });
}

export default function MediaUploader({ jobId, compact = false }) {
  const addMedia = useTimelineStore((s) => s.addMedia);
  const updateMedia = useTimelineStore((s) => s.updateMedia);
  const removeMedia = useTimelineStore((s) => s.removeMedia);
  const mediaLibrary = useTimelineStore((s) => s.mediaLibrary);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(null); // { filename, progress }
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  // Load global media library from backend on mount so items from the
  // Media Library page are available in the editor.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/media/list');
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        const existing = useTimelineStore.getState().mediaLibrary;
        const existingIds = new Set(existing.map(m => m.id));
        for (const item of data.items || []) {
          if (!existingIds.has(item.id)) {
            addMedia({
              id: item.id,
              type: item.type,
              filename: item.filename,
              url: item.url,
              thumbnailUrl: item.type === 'image' ? item.url : '',
              duration: 0,
            });
          }
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [addMedia]);

  // Regenerate missing video thumbnails on mount
  useEffect(() => {
    mediaLibrary.forEach((media) => {
      if (media.type === 'video' && !media.thumbnailUrl && media.url) {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        let done = false;
        const capture = () => {
          if (done) return true;
          try {
            const canvas = document.createElement('canvas');
            const w = Math.min(video.videoWidth || 120, 240);
            const h = Math.round(w * (video.videoHeight || 68) / (video.videoWidth || 120));
            canvas.width = w;
            canvas.height = h;
            canvas.getContext('2d').drawImage(video, 0, 0, w, h);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
            if (dataUrl.length > 500) {
              done = true;
              updateMedia(media.id, { thumbnailUrl: dataUrl });
              return true;
            }
          } catch { /* ignore */ }
          return false;
        };
        video.onseeked = () => { if (!capture() && video.currentTime > 0) video.currentTime = 0; };
        video.onloadedmetadata = () => { video.currentTime = Math.min(0.5, (video.duration || 1) * 0.1); };
        video.src = media.url;
        video.load();
        setTimeout(() => { if (!done) capture(); }, 8000);
      }
    });
  }, [mediaLibrary.length, updateMedia]);

  const handleFiles = useCallback(async (files) => {
    setError(null);
    for (const file of files) {
      const mediaType = detectMediaType(file);
      if (!mediaType) {
        setError(`Unsupported file type: ${file.name}`);
        continue;
      }

      const config = ACCEPT_MAP[mediaType];
      if (file.size > config.maxSize) {
        setError(`${file.name} exceeds ${formatSize(config.maxSize)} limit`);
        continue;
      }

      setUploading({ filename: file.name, progress: 0 });

      const blobUrl = URL.createObjectURL(file);
      let thumbnailUrl = '';
      let duration = 0;

      if (mediaType === 'video') {
        const result = await generateVideoThumbnail(file);
        thumbnailUrl = result.thumbnailUrl;
        duration = result.duration;
      } else if (mediaType === 'image') {
        thumbnailUrl = blobUrl;
      } else if (mediaType === 'audio') {
        // Get audio duration
        try {
          const audio = new Audio(blobUrl);
          duration = await new Promise((resolve) => {
            audio.onloadedmetadata = () => resolve(audio.duration);
            audio.onerror = () => resolve(0);
            setTimeout(() => resolve(0), 5000);
          });
        } catch { /* duration stays 0 */ }
      }

      // Add to local store immediately
      addMedia({
        type: mediaType,
        filename: file.name,
        duration,
        url: blobUrl,
        thumbnailUrl,
        waveformData: [],
      });

      // Upload to backend — uses job_id if available, otherwise defaults to global library
      const uploadUrl = jobId
        ? `/api/media/upload?job_id=${jobId}`
        : '/api/media/upload';
      const CHUNK_THRESHOLD = 50 * 1024 * 1024; // 50MB
      const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks

      if (file.size > CHUNK_THRESHOLD) {
        // Chunked upload for large files
        try {
          const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
          for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunk = file.slice(start, end);
            const chunkForm = new FormData();
            chunkForm.append('file', chunk, file.name);
            chunkForm.append('chunk_index', i.toString());
            chunkForm.append('total_chunks', totalChunks.toString());
            chunkForm.append('filename', file.name);

            let success = false;
            for (let attempt = 0; attempt < 4 && !success; attempt++) {
              try {
                const resp = await fetch(uploadUrl, {
                  method: 'POST',
                  body: chunkForm,
                });
                if (resp.ok) success = true;
                else if (attempt < 3) await new Promise(r => setTimeout(r, [2000, 4000, 8000][attempt]));
              } catch {
                if (attempt < 3) await new Promise(r => setTimeout(r, [2000, 4000, 8000][attempt]));
              }
            }
            setUploading({ filename: file.name, progress: Math.round(((i + 1) / totalChunks) * 100) });
          }
          setUploading(null);
        } catch {
          setUploading(null);
        }
      } else {
        // Standard upload for small files
        try {
          const formData = new FormData();
          formData.append('file', file);
          const xhr = new XMLHttpRequest();
          xhr.open('POST', uploadUrl);
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              setUploading({ filename: file.name, progress: Math.round((e.loaded / e.total) * 100) });
            }
          };
          xhr.onload = () => {
            try {
              const data = JSON.parse(xhr.responseText);
              if (data.url && data.id) {
                // Update the store entry with the backend URL so it persists
                updateMedia(mediaLibrary[mediaLibrary.length - 1]?.id, { url: data.url, id: data.id });
              }
            } catch { /* ignore */ }
            setUploading(null);
          };
          xhr.onerror = () => setUploading(null);
          xhr.send(formData);
        } catch {
          setUploading(null);
        }
      }
    }
  }, [addMedia, jobId]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  }, [handleFiles]);

  const onDragOver = useCallback((e) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => setDragOver(false), []);

  if (compact) {
    return (
      <div className="ve-media-uploader ve-media-uploader--compact">
        <button
          className="ve-media-uploader__add-btn"
          onClick={() => fileInputRef.current?.click()}
          title="Add media"
        >
          + Media
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".mp4,.mov,.webm,.mkv,.mp3,.wav,.aac,.ogg,.flac,.png,.jpg,.jpeg,.gif,.webp"
          style={{ display: 'none' }}
          onChange={(e) => handleFiles(Array.from(e.target.files))}
        />
      </div>
    );
  }

  return (
    <div className="ve-media-uploader">
      {/* Drop zone */}
      <div
        className={`ve-media-uploader__dropzone${dragOver ? ' ve-media-uploader__dropzone--active' : ''}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => fileInputRef.current?.click()}
      >
        <span className="ve-media-uploader__dropzone-icon">+</span>
        <span className="ve-media-uploader__dropzone-text">
          Drop media here or click to browse
        </span>
        <span className="ve-media-uploader__dropzone-hint">
          Video, Audio, Images
        </span>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".mp4,.mov,.webm,.mkv,.mp3,.wav,.aac,.ogg,.flac,.png,.jpg,.jpeg,.gif,.webp"
        style={{ display: 'none' }}
        onChange={(e) => handleFiles(Array.from(e.target.files))}
      />

      {/* Upload progress */}
      {uploading && (
        <div className="ve-media-uploader__progress">
          <span className="ve-media-uploader__progress-name">{uploading.filename}</span>
          <div className="ve-media-uploader__progress-bar">
            <div className="ve-media-uploader__progress-fill" style={{ width: `${uploading.progress}%` }} />
          </div>
          <span className="ve-media-uploader__progress-pct">{uploading.progress}%</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="ve-media-uploader__error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {/* Media library grid */}
      {mediaLibrary.length > 0 && (
        <div className="ve-media-uploader__library">
          {mediaLibrary.map((media) => (
            <div
              key={media.id}
              className="ve-media-uploader__item"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-clipai-media', JSON.stringify(media));
                e.dataTransfer.effectAllowed = 'copy';
              }}
              title={`${media.filename} — drag to timeline`}
            >
              {media.thumbnailUrl ? (
                <img src={media.thumbnailUrl} alt={media.filename} className="ve-media-uploader__thumb" />
              ) : (
                <div className="ve-media-uploader__thumb ve-media-uploader__thumb--placeholder">
                  {media.type === 'audio' ? '🎵' : media.type === 'video' ? '🎬' : '🖼️'}
                </div>
              )}
              <span className="ve-media-uploader__item-name">{media.filename}</span>
              <button
                className="ve-media-uploader__item-delete"
                onClick={async (e) => {
                  e.stopPropagation();
                  try { await fetch(`/api/media/${media.id}`, { method: 'DELETE' }); } catch { /* ignore */ }
                  removeMedia(media.id);
                }}
                title="Delete"
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
