import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ProgressBar from '../components/ProgressBar';
import useResponsive from '../hooks/useResponsive';

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

  // After upload completes, show a post-upload countdown/spinner so the user
  // knows the page isn't stuck — analysis pipeline initialization takes a moment.
  const [postUploadSeconds, setPostUploadSeconds] = useState(0);
  useEffect(() => {
    if (!uploadDone) { setPostUploadSeconds(0); return; }
    const interval = setInterval(() => setPostUploadSeconds(s => s + 1), 1000);
    return () => clearInterval(interval);
  }, [uploadDone]);

  const uploadMessage = uploadDone
    ? 'Upload complete — preparing analysis pipeline...'
    : progress >= 95
      ? 'Finishing upload...'
      : 'Uploading...';

  return (
    <div style={{ maxWidth: isMobile ? '100%' : 640, margin: '0 auto' }}>
      <h2 style={{ fontSize: isMobile ? 18 : 20, marginBottom: isMobile ? 20 : 24 }}>Upload Video</h2>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => !uploading && fileRef.current?.click()}
        style={{
          border: `2px dashed ${dragOver ? 'var(--accent-cyan)' : 'var(--border)'}`,
          background: dragOver ? 'var(--accent-cyan-dim)' : 'var(--bg-panel)',
          borderRadius: 'var(--radius-lg)',
          padding: isMobile ? '36px 16px' : '48px 24px',
          textAlign: 'center',
          cursor: uploading ? 'default' : 'pointer',
          transition: 'all 0.2s ease',
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED}
          onChange={(e) => handleFile(e.target.files?.[0])}
          style={{ display: 'none' }}
        />

        {!selectedFile ? (
          <>
            <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.4 }}>&#x2B06;</div>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>
              Drag and drop your video here, or click to browse
            </p>
            <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {ACCEPTED_DISPLAY}
            </p>
          </>
        ) : (
          <div>
            <div style={{ fontSize: 14, color: 'var(--text-primary)', marginBottom: 8, fontWeight: 600 }}>
              {selectedFile.name}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB
            </div>
          </div>
        )}
      </div>

      {/* Language selector */}
      {selectedFile && !uploading && (
        <div style={{ marginTop: 16 }}>
          <label
            htmlFor="lang-select"
            style={{ display: 'block', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}
          >
            Video language (helps transcription accuracy)
          </label>
          <select
            id="lang-select"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px',
              background: 'var(--bg-panel)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              fontSize: 14,
              borderRadius: 'var(--radius-sm)',
              outline: 'none',
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
          marginTop: 16,
          padding: '16px 20px',
          background: 'var(--success-dim)',
          border: '1px solid var(--success-border)',
          borderRadius: 'var(--radius-sm)',
          textAlign: 'center',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 8 }}>
            <div style={{
              width: 16, height: 16, border: '2px solid var(--success)',
              borderTopColor: 'transparent', borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
            }} />
            <span style={{ color: 'var(--success)', fontSize: 14, fontWeight: 600 }}>
              Upload complete — starting analysis pipeline...
            </span>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px', lineHeight: 1.5 }}>
            Redirecting to analysis page{postUploadSeconds > 0 ? ` (${postUploadSeconds}s)` : ''}...
            You'll see live progress for each step on the analysis page.
          </p>
          <div style={{ textAlign: 'left', margin: '0 auto', maxWidth: 340 }}>
            {[
              { label: 'Frame extraction', est: '~30s' },
              { label: 'Audio transcription', est: '~1-2 min' },
              { label: 'Scene analysis', est: '~1-2 min' },
              { label: 'Viral clip detection', est: '~30s' },
            ].map((step, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '4px 0', fontSize: 12, color: 'var(--text-secondary)',
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: 'var(--text-muted)', flexShrink: 0,
                }} />
                <span style={{ flex: 1 }}>{step.label}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{step.est}</span>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '10px 0 0', lineHeight: 1.4, fontStyle: 'italic' }}>
            Total estimated time: 3-5 minutes depending on video length
          </p>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* Progress */}
      {uploading && (
        <div style={{ marginTop: 16 }}>
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
          marginTop: 12,
          padding: '10px 14px',
          background: 'rgba(245, 158, 11, 0.08)',
          border: '1px solid rgba(245, 158, 11, 0.3)',
          borderRadius: 'var(--radius-sm)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16, flexShrink: 0 }}>&#9888;</span>
            <span style={{ fontSize: 12, color: 'var(--accent-amber)', lineHeight: 1.4 }}>
              Upload in progress — do not close this tab or navigate away until the upload is complete.
            </span>
          </div>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4, paddingLeft: 24 }}>
            After upload, you'll be redirected to the analysis page where AI will extract frames,
            transcribe audio, analyze scenes, and detect viral clips (3-5 min).
          </span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ marginTop: 16, padding: '10px 16px', background: 'var(--danger-dim)', border: '1px solid var(--danger)', color: 'var(--danger)', fontSize: 13, borderRadius: 'var(--radius-sm)' }}>
          {error}
        </div>
      )}

      {/* Upload button */}
      {selectedFile && !uploading && (
        <button
          onClick={handleUpload}
          style={{
            marginTop: 16,
            width: '100%',
            padding: '12px',
            background: 'var(--accent-cyan)',
            color: 'var(--bg-base)',
            border: 'none',
            fontSize: 14,
            fontWeight: 600,
            borderRadius: 'var(--radius-sm)',
          }}
        >
          Upload & Analyze
        </button>
      )}
    </div>
  );
}
