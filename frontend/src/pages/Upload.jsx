import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ProgressBar from '../components/ProgressBar';
import useResponsive from '../hooks/useResponsive';
import { UploadIcon, XIcon } from '../components/icons';

const ACCEPTED = '.mp4,.mov,.avi,.mkv,.webm';
const ACCEPTED_DISPLAY = 'MP4 \u00B7 MOV \u00B7 AVI \u00B7 MKV \u00B7 WEBM';

// Quick client-side check: read first 12 bytes to catch obviously corrupt files
function validateFileHeader(file) {
  return new Promise((resolve) => {
    const slice = file.slice(0, 12);
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      if (bytes.length < 8) {
        resolve('File is too small to be a valid video');
        return;
      }
      // All-zero header = corrupt or incomplete download
      if (bytes.slice(0, 8).every((b) => b === 0)) {
        resolve(
          'This file appears to be corrupt or an incomplete download \u2014 ' +
          'the first bytes are all zeros. Please check that it plays on your device.'
        );
        return;
      }
      resolve(null); // OK
    };
    reader.onerror = () => resolve(null); // skip check on read error
    reader.readAsArrayBuffer(slice);
  });
}

const LANGUAGES = [
  { code: '', label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ru', label: 'Russian' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'nl', label: 'Dutch' },
  { code: 'pl', label: 'Polish' },
  { code: 'tr', label: 'Turkish' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'th', label: 'Thai' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'sv', label: 'Swedish' },
];

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export default function Upload() {
  const [dragOver, setDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [language, setLanguage] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadDone, setUploadDone] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);
  const navigate = useNavigate();
  const { isMobile } = useResponsive();

  // Warn user before leaving during upload
  useEffect(() => {
    if (!uploading) return;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [uploading]);

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) {
      setError(`Unsupported format: .${ext}`);
      return;
    }
    // Quick header check before accepting
    const headerErr = await validateFileHeader(file);
    if (headerErr) {
      setError(headerErr);
      setSelectedFile(null);
      return;
    }
    setSelectedFile(file);
    setError(null);
    setUploadDone(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    handleFile(file);
  }, [handleFile]);

  const handleDeselect = useCallback(() => {
    setSelectedFile(null);
    setError(null);
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  const handleUpload = async () => {
    if (!selectedFile) return;
    setUploading(true);
    setUploadDone(false);
    setProgress(0);
    setError(null);

    const formData = new FormData();
    formData.append('file', selectedFile);
    if (language) {
      formData.append('language', language);
    }

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          setProgress(Math.round((e.loaded / e.total) * 100));
        }
      };

      const response = await new Promise((resolve, reject) => {
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(JSON.parse(xhr.responseText));
          } else {
            // Parse FastAPI error format {"detail": "..."}
            let msg = 'Upload failed';
            try {
              const body = JSON.parse(xhr.responseText);
              if (body.detail) msg = body.detail;
            } catch {
              if (xhr.responseText) msg = xhr.responseText;
            }
            reject(new Error(msg));
          }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(formData);
      });

      setProgress(100);
      setUploadDone(true);

      // Navigate immediately — the analysis page has its own loading/progress UI.
      // A small delay lets React paint the 100% state before unmounting.
      setTimeout(() => {
        navigate(`/analysis/${response.job_id}`);
      }, 150);
    } catch (err) {
      setError(err.message);
      setUploading(false);
    }
  };

  const uploadMessage = uploadDone
    ? 'Upload complete — starting analysis...'
    : 'Uploading...';

  return (
    <div className="page-enter" style={{ position: 'relative', maxWidth: isMobile ? '100%' : 640, margin: '0 auto', paddingTop: uploading ? 0 : undefined }}>

      {/* Thin Safari-style progress bar at top of component */}
      {uploading && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: 'var(--bg-surface-2)',
          borderRadius: 1,
          overflow: 'hidden',
          zIndex: 10,
        }}>
          <div style={{
            height: '100%',
            width: `${progress}%`,
            background: uploadDone ? 'var(--success)' : 'var(--accent-cyan)',
            transition: 'width 0.3s var(--ease-spring)',
            borderRadius: 1,
          }} />
        </div>
      )}

      <h2 style={{
        fontSize: isMobile ? 18 : 20,
        marginBottom: isMobile ? 'var(--space-lg)' : 'var(--space-xl)',
        marginTop: uploading ? 'var(--space-sm)' : 0,
      }}>
        Upload Video
      </h2>

      {/* Drop zone -- larger, vertically centered, dashed border */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => !uploading && fileRef.current?.click()}
        style={{
          border: `2px dashed ${dragOver ? 'var(--accent-cyan)' : 'var(--border)'}`,
          background: dragOver ? 'var(--accent-cyan-dim)' : 'var(--bg-surface-1)',
          borderRadius: 'var(--radius-md)',
          padding: isMobile ? '48px 20px' : '72px 32px',
          textAlign: 'center',
          cursor: uploading ? 'default' : 'pointer',
          transition: 'all 0.3s var(--ease-spring)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: isMobile ? 200 : 260,
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED}
          onChange={(e) => handleFile(e.target.files?.[0])}
          style={{ display: 'none' }}
        />

        {/* Animated upload icon -- drifts up on hover via CSS-in-JS trick */}
        <div style={{
          marginBottom: 'var(--space-md)',
          color: dragOver ? 'var(--accent-cyan)' : 'var(--text-muted)',
          transition: 'transform 0.4s var(--ease-spring), color 0.3s var(--ease-spring)',
          transform: dragOver ? 'translateY(-6px)' : 'translateY(0)',
        }}>
          <UploadIcon size={isMobile ? 36 : 44} />
        </div>

        <p style={{
          color: 'var(--text-secondary)',
          marginBottom: 'var(--space-sm)',
          fontSize: isMobile ? 14 : 15,
          lineHeight: 1.5,
        }}>
          Drag and drop your video here, or click to browse
        </p>
        <p style={{
          color: 'var(--text-muted)',
          fontSize: 12,
          letterSpacing: '0.04em',
        }}>
          {ACCEPTED_DISPLAY}
        </p>
      </div>

      {/* Selected file card -- shown below drop zone */}
      {selectedFile && (
        <div style={{
          marginTop: 'var(--space-md)',
          padding: 'var(--space-sm) var(--space-md)',
          background: 'var(--bg-surface-2)',
          borderRadius: 'var(--radius-md)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-sm)',
          transition: 'all 0.3s var(--ease-spring)',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--text-primary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              {selectedFile.name}
            </div>
            <div style={{
              fontSize: 12,
              color: 'var(--text-muted)',
              marginTop: 2,
            }}>
              {formatFileSize(selectedFile.size)}
            </div>
          </div>
          {!uploading && (
            <button
              onClick={(e) => { e.stopPropagation(); handleDeselect(); }}
              aria-label="Deselect file"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: 'var(--radius-md)',
                border: 'none',
                background: 'var(--bg-surface-3)',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                flexShrink: 0,
                transition: 'background 0.2s var(--ease-spring), color 0.2s var(--ease-spring)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--danger-dim)';
                e.currentTarget.style.color = 'var(--danger)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--bg-surface-3)';
                e.currentTarget.style.color = 'var(--text-muted)';
              }}
            >
              <XIcon size={14} />
            </button>
          )}
        </div>
      )}

      {/* Language selector with glass treatment */}
      {selectedFile && !uploading && (
        <div style={{ marginTop: 'var(--space-md)' }}>
          <label
            htmlFor="lang-select"
            style={{
              display: 'block',
              fontSize: 13,
              color: 'var(--text-secondary)',
              marginBottom: 'var(--space-xs)',
            }}
          >
            Video language (helps transcription accuracy)
          </label>
          <select
            id="lang-select"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            style={{
              width: '100%',
              padding: 'var(--space-sm) var(--space-md)',
              background: 'var(--glass-bg)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              fontSize: 14,
              borderRadius: 'var(--radius-md)',
              outline: 'none',
              transition: 'border-color 0.2s var(--ease-spring)',
              appearance: 'none',
              WebkitAppearance: 'none',
              backgroundImage: `url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 12px center',
              paddingRight: 'var(--space-xl)',
            }}
          >
            {LANGUAGES.map(({ code, label }) => (
              <option key={code} value={code}>{label}</option>
            ))}
          </select>
        </div>
      )}

      {/* Upload complete banner */}
      {uploadDone && (
        <div style={{
          marginTop: 'var(--space-md)',
          padding: 'var(--space-sm) var(--space-md)',
          background: 'var(--success-dim)',
          border: '1px solid var(--success-border)',
          color: 'var(--success)',
          fontSize: 14,
          fontWeight: 600,
          textAlign: 'center',
          borderRadius: 'var(--radius-md)',
        }}>
          Upload complete — redirecting to analysis...
        </div>
      )}

      {/* Progress -- detailed ProgressBar component */}
      {uploading && (
        <div style={{ marginTop: 'var(--space-md)' }}>
          <ProgressBar
            progress={progress}
            message={uploadMessage}
            variant={uploadDone ? 'green' : 'cyan'}
          />
        </div>
      )}

      {/* Upload in-progress warning */}
      {uploading && !uploadDone && (
        <div style={{
          marginTop: 'var(--space-sm)',
          padding: 'var(--space-sm) var(--space-md)',
          background: 'rgba(245, 158, 11, 0.08)',
          border: '1px solid rgba(245, 158, 11, 0.3)',
          borderRadius: 'var(--radius-md)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-sm)',
        }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>&#9888;</span>
          <span style={{ fontSize: 12, color: 'var(--accent-amber)', lineHeight: 1.4 }}>
            Upload in progress — do not close this tab or navigate away until the upload is complete.
          </span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{
          marginTop: 'var(--space-md)',
          padding: 'var(--space-sm) var(--space-md)',
          background: 'var(--danger-dim)',
          border: '1px solid var(--danger)',
          color: 'var(--danger)',
          fontSize: 13,
          borderRadius: 'var(--radius-md)',
        }}>
          {error}
        </div>
      )}

      {/* Upload button */}
      {selectedFile && !uploading && (
        <button
          onClick={handleUpload}
          style={{
            marginTop: 'var(--space-md)',
            width: '100%',
            padding: 'var(--space-sm) var(--space-md)',
            background: 'var(--accent-cyan)',
            color: 'var(--bg-base)',
            border: 'none',
            fontSize: 14,
            fontWeight: 600,
            borderRadius: 'var(--radius-md)',
            cursor: 'pointer',
            transition: 'opacity 0.2s var(--ease-spring), transform 0.2s var(--ease-spring)',
            minHeight: 44,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
        >
          Upload & Analyze
        </button>
      )}
    </div>
  );
}
