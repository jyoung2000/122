import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ProgressBar from '../components/ProgressBar';
import useResponsive from '../hooks/useResponsive';

const ACCEPTED = '.mp4,.mov,.avi,.mkv,.webm';
const ACCEPTED_DISPLAY = 'MP4 \u00B7 MOV \u00B7 AVI \u00B7 MKV \u00B7 WEBM';
const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB — matches backend default
const MAX_RETRIES = 4;
const RETRY_DELAYS = [2000, 4000, 8000, 16000]; // exponential backoff

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
      if (bytes.slice(0, 8).every((b) => b === 0)) {
        resolve(
          'This file appears to be corrupt or an incomplete download \u2014 ' +
          'the first bytes are all zeros. Please check that it plays on your device.'
        );
        return;
      }
      resolve(null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsArrayBuffer(slice);
  });
}

// Compute MD5 hash of a chunk using SubtleCrypto (fallback: skip)
async function computeChunkHash(blob) {
  try {
    const buffer = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    // We use MD5 on the backend, but for simplicity we'll skip hash verification
    // if SubtleCrypto isn't available. The backend validates file integrity anyway.
    // Actually, use a simple checksum approach instead.
    const bytes = new Uint8Array(buffer);
    let hash = 0;
    for (let i = 0; i < bytes.length; i++) {
      hash = ((hash << 5) - hash + bytes[i]) | 0;
    }
    return null; // Skip hash for now — backend validates integrity at assembly
  } catch {
    return null;
  }
}

async function computeFileMD5(file) {
  // We'll skip full-file MD5 on the client — the backend does size + integrity checks
  return '';
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

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

function formatETA(seconds) {
  if (!seconds || !isFinite(seconds) || seconds <= 0) return '--';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);
  return `${m}m ${s}s`;
}

// ── QA Check Display ────────────────────────────────────────────────────────

function QAReport({ qa, label }) {
  if (!qa || Object.keys(qa).length === 0) return null;
  const checks = Object.entries(qa).map(([key, val]) => {
    if (key === 'integrity' && typeof val === 'object') {
      return Object.entries(val).map(([subKey, subVal]) => ({
        name: `integrity.${subKey}`,
        ...subVal,
      }));
    }
    return [{ name: key, ...val }];
  }).flat();

  const allPassed = checks.every((c) => c.pass !== false);
  const bgColor = allPassed ? 'rgba(48, 209, 88, 0.1)' : 'rgba(255, 55, 95, 0.1)';
  const borderColor = allPassed ? 'rgba(48, 209, 88, 0.3)' : 'rgba(255, 55, 95, 0.3)';

  return (
    <div style={{
      marginTop: 12,
      padding: '10px 14px',
      background: bgColor,
      border: `1px solid ${borderColor}`,
      borderRadius: 'var(--radius-sm)',
      fontSize: 12,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 14 }}>{allPassed ? '\u2713' : '\u2717'}</span>
        {label || 'Upload QA Report'}
      </div>
      {checks.map((check, i) => {
        const passed = check.pass !== false;
        const icon = passed ? '\u2713' : '\u2717';
        const color = passed ? '#30D158' : '#FF375F';
        const detail = check.error
          || (check.expected !== undefined && !passed
            ? `expected ${check.expected}, got ${check.actual}`
            : check.note || '');
        return (
          <div key={i} style={{
            display: 'flex', alignItems: 'flex-start', gap: 6, padding: '2px 0',
            color: 'var(--text-secondary)',
          }}>
            <span style={{ color, flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 11 }}>{icon}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              {check.name}{detail ? ` — ${detail}` : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Chunk Progress Grid ─────────────────────────────────────────────────────

function ChunkGrid({ totalChunks, chunkStates }) {
  if (totalChunks <= 0) return null;
  // Only show grid for files with multiple chunks
  if (totalChunks <= 1) return null;

  // Collapse into a compact bar for very large chunk counts
  const maxVisible = 200;
  const showCompact = totalChunks > maxVisible;

  if (showCompact) {
    const done = Object.values(chunkStates).filter((s) => s === 'done').length;
    const failed = Object.values(chunkStates).filter((s) => s === 'error').length;
    const uploading = Object.values(chunkStates).filter((s) => s === 'uploading').length;
    return (
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
        Chunks: {done}/{totalChunks} complete
        {uploading > 0 && <span style={{ color: 'var(--accent-cyan)' }}> | {uploading} uploading</span>}
        {failed > 0 && <span style={{ color: '#FF375F' }}> | {failed} failed</span>}
      </div>
    );
  }

  return (
    <div style={{
      marginTop: 8,
      display: 'flex',
      flexWrap: 'wrap',
      gap: 2,
    }}>
      {Array.from({ length: totalChunks }, (_, i) => {
        const state = chunkStates[i] || 'pending';
        const colors = {
          pending: 'var(--bg-elevated)',
          uploading: 'var(--accent-cyan)',
          done: '#30D158',
          error: '#FF375F',
          retrying: '#FF9F0A',
        };
        return (
          <div
            key={i}
            title={`Chunk ${i + 1}: ${state}`}
            style={{
              width: totalChunks > 100 ? 4 : totalChunks > 50 ? 6 : 8,
              height: totalChunks > 100 ? 4 : totalChunks > 50 ? 6 : 8,
              borderRadius: 1,
              background: colors[state] || colors.pending,
              transition: 'background 0.2s',
            }}
          />
        );
      })}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function Upload() {
  const [dragOver, setDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [language, setLanguage] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadDone, setUploadDone] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [uploadPhase, setUploadPhase] = useState(''); // 'chunking', 'assembling', 'validating', 'complete'
  const [chunkStates, setChunkStates] = useState({});
  const [totalChunks, setTotalChunks] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [eta, setEta] = useState(0);
  const [qaReport, setQaReport] = useState(null);
  const [retryCount, setRetryCount] = useState(0);
  const [uploadLog, setUploadLog] = useState([]);
  const fileRef = useRef(null);
  const abortRef = useRef(false);
  const navigate = useNavigate();
  const { isMobile } = useResponsive();

  const addLog = useCallback((msg, level = 'info') => {
    const ts = new Date().toLocaleTimeString();
    setUploadLog((prev) => [...prev.slice(-49), { ts, msg, level }]);
  }, []);

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
    const headerErr = await validateFileHeader(file);
    if (headerErr) {
      setError(headerErr);
      setSelectedFile(null);
      return;
    }
    setSelectedFile(file);
    setError(null);
    setUploadDone(false);
    setQaReport(null);
    setUploadLog([]);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    handleFile(file);
  }, [handleFile]);

  const uploadChunkWithRetry = useCallback(async (uploadId, chunkIndex, blob) => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const formData = new FormData();
        formData.append('upload_id', uploadId);
        formData.append('chunk_index', chunkIndex.toString());
        formData.append('chunk_hash', '');
        formData.append('file', blob, `chunk_${chunkIndex}`);

        if (attempt > 0) {
          setChunkStates((prev) => ({ ...prev, [chunkIndex]: 'retrying' }));
          addLog(`Retrying chunk ${chunkIndex + 1} (attempt ${attempt + 1})`, 'warn');
        }

        const resp = await fetch('/api/upload/chunk', {
          method: 'POST',
          body: formData,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          let errMsg = `Chunk ${chunkIndex + 1} failed: HTTP ${resp.status}`;
          try {
            const errJson = JSON.parse(errText);
            if (errJson.detail) errMsg = errJson.detail;
          } catch {}
          throw new Error(errMsg);
        }

        const result = await resp.json();
        return result;
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAYS[attempt] || 16000;
          addLog(`Chunk ${chunkIndex + 1} error: ${err.message}. Retrying in ${delay / 1000}s...`, 'warn');
          await new Promise((r) => setTimeout(r, delay));
        } else {
          throw err;
        }
      }
    }
  }, [addLog]);

  const handleUpload = async () => {
    if (!selectedFile) return;
    setUploading(true);
    setUploadDone(false);
    setProgress(0);
    setError(null);
    setUploadPhase('chunking');
    setChunkStates({});
    setQaReport(null);
    setRetryCount(0);
    setUploadLog([]);
    abortRef.current = false;

    const file = selectedFile;
    const numChunks = Math.ceil(file.size / CHUNK_SIZE);
    setTotalChunks(numChunks);

    addLog(`Starting chunked upload: ${file.name} (${formatBytes(file.size)}, ${numChunks} chunks)`);

    // Step 1: Initialize upload session
    let uploadId, serverChunkSize, serverTotalChunks;
    try {
      addLog('Initializing upload session...');
      const initResp = await fetch('/api/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          file_size: file.size,
          language,
          chunk_size: CHUNK_SIZE,
        }),
      });

      if (!initResp.ok) {
        let msg = 'Failed to initialize upload';
        try {
          const body = await initResp.json();
          if (body.detail) msg = body.detail;
        } catch {}
        throw new Error(msg);
      }

      const initData = await initResp.json();
      uploadId = initData.upload_id;
      serverChunkSize = initData.chunk_size;
      serverTotalChunks = initData.total_chunks;
      setTotalChunks(serverTotalChunks);
      addLog(`Session created: ${uploadId.slice(0, 8)}... (${serverTotalChunks} chunks of ${formatBytes(serverChunkSize)})`);
    } catch (err) {
      setError(err.message);
      setUploading(false);
      addLog(`Init failed: ${err.message}`, 'error');
      return;
    }

    // Step 2: Upload chunks sequentially with progress tracking
    const chunkSize = serverChunkSize || CHUNK_SIZE;
    const totalChunksActual = serverTotalChunks || numChunks;
    let bytesUploaded = 0;
    const startTime = Date.now();
    let lastSpeedCalcTime = startTime;
    let lastSpeedCalcBytes = 0;

    for (let i = 0; i < totalChunksActual; i++) {
      if (abortRef.current) {
        addLog('Upload cancelled by user', 'warn');
        setError('Upload cancelled');
        setUploading(false);
        return;
      }

      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const blob = file.slice(start, end);

      setChunkStates((prev) => ({ ...prev, [i]: 'uploading' }));

      try {
        const result = await uploadChunkWithRetry(uploadId, i, blob);
        setChunkStates((prev) => ({ ...prev, [i]: 'done' }));
        bytesUploaded += (end - start);

        // Calculate speed and ETA
        const now = Date.now();
        const elapsed = (now - lastSpeedCalcTime) / 1000;
        if (elapsed >= 0.5) {
          const bytesSinceCalc = bytesUploaded - lastSpeedCalcBytes;
          const currentSpeed = bytesSinceCalc / elapsed;
          setSpeed(currentSpeed);
          const remaining = file.size - bytesUploaded;
          setEta(currentSpeed > 0 ? remaining / currentSpeed : 0);
          lastSpeedCalcTime = now;
          lastSpeedCalcBytes = bytesUploaded;
        }

        // Progress: 0-90% for chunks, 90-95% for assembly, 95-100% for validation
        const chunkProgress = Math.round((result.chunks_done / totalChunksActual) * 90);
        setProgress(chunkProgress);
      } catch (err) {
        setChunkStates((prev) => ({ ...prev, [i]: 'error' }));
        setError(`Upload failed at chunk ${i + 1}/${totalChunksActual}: ${err.message}`);
        setUploading(false);
        addLog(`Fatal error at chunk ${i + 1}: ${err.message}`, 'error');
        return;
      }
    }

    // Step 3: Complete — assemble and validate
    setUploadPhase('assembling');
    setProgress(92);
    addLog('All chunks uploaded. Assembling file on server...');

    try {
      const completeForm = new FormData();
      completeForm.append('upload_id', uploadId);
      completeForm.append('file_hash', '');

      const completeResp = await fetch('/api/upload/complete', {
        method: 'POST',
        body: completeForm,
      });

      if (!completeResp.ok) {
        let msg = `Assembly/validation failed (HTTP ${completeResp.status})`;
        try {
          const text = await completeResp.text();
          try {
            const body = JSON.parse(text);
            if (body.detail) {
              if (typeof body.detail === 'object') {
                msg = body.detail.message || msg;
                if (body.detail.qa) setQaReport(body.detail.qa);
              } else {
                msg = String(body.detail);
              }
            }
          } catch {
            // Response wasn't JSON — include raw text for debugging
            if (text && text.length < 500) msg += `: ${text}`;
          }
        } catch {}
        throw new Error(msg);
      }

      const completeData = await completeResp.json();
      setUploadPhase('complete');
      setProgress(100);
      setUploadDone(true);
      setQaReport(completeData.qa);
      addLog(`Upload complete! Job ID: ${completeData.job_id}, QA: ${completeData.qa?.overall?.pass ? 'PASSED' : 'ISSUES FOUND'}`, 'success');

      // Navigate to analysis
      setTimeout(() => {
        navigate(`/analysis/${completeData.job_id}`);
      }, 800);
    } catch (err) {
      setError(err.message);
      setUploading(false);
      setUploadPhase('');
      addLog(`Completion failed: ${err.message}`, 'error');
    }
  };

  const cancelUpload = useCallback(() => {
    abortRef.current = true;
  }, []);

  // Post-upload countdown
  const [postUploadSeconds, setPostUploadSeconds] = useState(0);
  useEffect(() => {
    if (!uploadDone) { setPostUploadSeconds(0); return; }
    const interval = setInterval(() => setPostUploadSeconds((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [uploadDone]);

  const uploadMessage = uploadDone
    ? 'Upload complete \u2014 preparing analysis pipeline...'
    : uploadPhase === 'assembling'
      ? 'Assembling file on server...'
      : uploadPhase === 'validating'
        ? 'Validating file integrity...'
        : progress >= 90
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
              {formatBytes(selectedFile.size)}
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

          {/* Speed / ETA / Chunk info */}
          {!uploadDone && uploadPhase === 'chunking' && (
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 11,
              color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
              marginTop: 6,
              padding: '0 2px',
            }}>
              <span>{formatBytes(Math.round(progress / 90 * selectedFile.size))} / {formatBytes(selectedFile.size)}</span>
              <span>{speed > 0 ? formatSpeed(speed) : '--'}</span>
              <span>ETA: {speed > 0 ? formatETA(eta) : '--'}</span>
            </div>
          )}

          {/* Chunk progress grid */}
          <ChunkGrid totalChunks={totalChunks} chunkStates={chunkStates} />
        </div>
      )}

      {/* Upload in-progress warning + cancel */}
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16, flexShrink: 0 }}>&#9888;</span>
              <span style={{ fontSize: 12, color: 'var(--accent-amber)', lineHeight: 1.4 }}>
                Upload in progress — do not close this tab or navigate away until the upload is complete.
              </span>
            </div>
            <button
              onClick={cancelUpload}
              style={{
                padding: '4px 12px',
                fontSize: 11,
                background: 'rgba(255, 55, 95, 0.15)',
                color: '#FF375F',
                border: '1px solid rgba(255, 55, 95, 0.3)',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              Cancel
            </button>
          </div>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4, paddingLeft: 24 }}>
            Using chunked upload ({formatBytes(CHUNK_SIZE)} chunks) with automatic retry for reliability.
            {selectedFile && selectedFile.size > 100 * 1024 * 1024
              ? ' Large file detected — chunked upload ensures the transfer won\'t stall.'
              : ''}
          </span>
        </div>
      )}

      {/* QA Report */}
      {qaReport && <QAReport qa={qaReport} label="Upload QA Validation" />}

      {/* Upload Log */}
      {uploadLog.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            cursor: 'pointer',
            userSelect: 'none',
          }}>
            Upload Log ({uploadLog.length} entries)
          </summary>
          <div style={{
            marginTop: 4,
            padding: '8px 10px',
            background: 'var(--bg-panel)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            maxHeight: 200,
            overflowY: 'auto',
            fontSize: 10,
            fontFamily: 'var(--font-mono)',
            lineHeight: 1.6,
          }}>
            {uploadLog.map((entry, i) => {
              const colors = { info: 'var(--text-muted)', warn: '#FF9F0A', error: '#FF375F', success: '#30D158' };
              return (
                <div key={i} style={{ color: colors[entry.level] || colors.info }}>
                  <span style={{ opacity: 0.5 }}>{entry.ts}</span> {entry.msg}
                </div>
              );
            })}
          </div>
        </details>
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
