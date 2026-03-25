import React, { useState, useEffect, useRef, useCallback } from 'react';

// ── Colors ──────────────────────────────────────────────────────────────
const STATUS_COLORS = {
  pass: '#22c55e',
  warn: '#f59e0b',
  fail: '#ef4444',
  running: '#3b82f6',
};
const VRAM_COLORS = {
  vision: '#8b5cf6',
  text: '#3b82f6',
  other: '#ec4899',
  free: '#1f2937',
};

const STATUS_ICONS = { pass: '\u2705', warn: '\u26a0\ufe0f', fail: '\u274c', running: null };

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

// ── VRAM Gauge ──────────────────────────────────────────────────────────
function VramGauge({ gpu, loadedModels, onUnload }) {
  if (!gpu || !gpu.cuda_available) {
    return (
      <div style={cardStyle}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {gpu ? 'No GPU detected — Ollama running on CPU' : 'Loading GPU info...'}
        </div>
      </div>
    );
  }

  const totalBytes = gpu.vram_total_bytes || 1;
  const usedBytes = gpu.vram_used_bytes || 0;
  const usedPct = Math.min(100, (usedBytes / totalBytes) * 100);
  const barColor = usedPct > 85 ? '#ef4444' : usedPct > 60 ? '#f59e0b' : '#22c55e';

  // Build model segments for the bar
  const segments = loadedModels.map((m) => {
    const pct = Math.min(100, (m.vram_bytes / totalBytes) * 100);
    const isVision = /moondream|llava|vision/i.test(m.name);
    return { name: m.name, pct, color: isVision ? VRAM_COLORS.vision : VRAM_COLORS.text };
  });

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
          GPU: {gpu.name || 'Unknown'}
        </span>
        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: barColor }}>
          {formatBytes(usedBytes)} / {formatBytes(totalBytes)}
        </span>
      </div>

      {/* VRAM bar */}
      <div style={{
        height: 20, borderRadius: 4, background: VRAM_COLORS.free,
        overflow: 'hidden', display: 'flex', position: 'relative',
      }}>
        {segments.map((seg, i) => (
          <div key={i} title={`${seg.name}: ${seg.pct.toFixed(1)}%`} style={{
            width: `${seg.pct}%`, height: '100%', background: seg.color,
            transition: 'width 0.3s',
          }} />
        ))}
      </div>

      {/* Legend */}
      {loadedModels.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {loadedModels.map((m, i) => {
            const isVision = /moondream|llava|vision/i.test(m.name);
            const vramPct = m.size_bytes > 0 ? ((m.vram_bytes / m.size_bytes) * 100).toFixed(0) : '0';
            return (
              <div key={i} style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginTop: 2 }}>
                <span style={{
                  display: 'inline-block', width: 8, height: 8, borderRadius: 2, marginRight: 6,
                  background: isVision ? VRAM_COLORS.vision : VRAM_COLORS.text,
                }} />
                {m.name} — {vramPct}% GPU — {formatBytes(m.vram_bytes)} VRAM
              </div>
            );
          })}
        </div>
      )}
      {loadedModels.length === 0 && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
          No models loaded
        </div>
      )}

      <button onClick={onUnload} style={smallBtnStyle} title="Free all GPU memory">
        Unload All Models
      </button>
    </div>
  );
}

// ── Spinner ─────────────────────────────────────────────────────────────
function Spinner() {
  return (
    <span style={{
      display: 'inline-block', width: 14, height: 14,
      border: '2px solid var(--border)', borderTopColor: STATUS_COLORS.running,
      borderRadius: '50%', animation: 'spin 0.8s linear infinite',
    }} />
  );
}

// ── Phase Result Row ────────────────────────────────────────────────────
function PhaseRow({ phase }) {
  const icon = phase.status === 'running' ? <Spinner /> : STATUS_ICONS[phase.status] || '';
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0',
      borderBottom: '1px solid var(--border-subtle, rgba(128,128,128,0.1))',
    }}>
      <span style={{ fontSize: 14, width: 20, textAlign: 'center', flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>
          {phase.label}
          {phase.duration_ms != null && (
            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 }}>
              {phase.duration_ms}ms
            </span>
          )}
        </div>
        {phase.message && phase.status !== 'running' && (
          <div style={{
            fontSize: 10, fontFamily: 'var(--font-mono)', marginTop: 2,
            color: phase.status === 'fail' ? '#ef4444' : phase.status === 'warn' ? '#f59e0b' : 'var(--text-muted)',
          }}>
            {phase.message}
          </div>
        )}
        {phase.gpu_status && phase.status !== 'running' && (
          <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginTop: 1 }}>
            GPU: {phase.gpu_status}
          </div>
        )}
        {phase.sample_output && (
          <div style={{
            fontSize: 10, fontStyle: 'italic', color: 'var(--text-muted)',
            marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            "{phase.sample_output}"
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────
export default function PipelineDiagnostics() {
  const [gpuStatus, setGpuStatus] = useState(null);
  const [loadedModels, setLoadedModels] = useState([]);
  const [ollamaAvailable, setOllamaAvailable] = useState(null);
  const [testRunning, setTestRunning] = useState(false);
  const [testPhases, setTestPhases] = useState([]);
  const [testOverall, setTestOverall] = useState(null);
  const abortRef = useRef(null);

  // Poll GPU status every 2s
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const resp = await fetch('/api/diagnostics/gpu-status');
        if (!resp.ok) return;
        const data = await resp.json();
        if (!active) return;
        setGpuStatus(data.gpu);
        setLoadedModels(data.loaded_models || []);
        setOllamaAvailable(data.ollama_available);
      } catch { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => { active = false; clearInterval(id); };
  }, []);

  const handleUnload = useCallback(async () => {
    try {
      await fetch('/api/diagnostics/unload-models', { method: 'POST' });
    } catch { /* ignore */ }
  }, []);

  const runTest = useCallback(async () => {
    setTestRunning(true);
    setTestPhases([]);
    setTestOverall(null);

    try {
      const resp = await fetch('/api/diagnostics/test-pipeline', { method: 'POST' });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'phase_start') {
              setTestPhases((prev) => [
                ...prev,
                { phase: evt.data.phase, label: evt.data.label, status: 'running' },
              ]);
            } else if (evt.type === 'phase_result') {
              setTestPhases((prev) =>
                prev.map((p) => (p.phase === evt.data.phase ? { ...p, ...evt.data } : p)),
              );
            } else if (evt.type === 'complete') {
              setTestOverall(evt.data);
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch (e) {
      setTestOverall({ overall_status: 'fail', error: e.message });
    } finally {
      setTestRunning(false);
    }
  }, []);

  const isOllama = ollamaAvailable !== null;

  return (
    <div style={{ marginBottom: 32 }}>
      <h3 style={{ fontSize: 14, marginBottom: 16, color: 'var(--text-secondary)' }}>
        Pipeline Diagnostics
      </h3>

      {/* Live VRAM Gauge */}
      {isOllama && (
        <VramGauge gpu={gpuStatus} loadedModels={loadedModels} onUnload={handleUnload} />
      )}

      {/* Test Runner */}
      <div style={{ ...cardStyle, marginTop: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
          Tests vision + text model loading on GPU before uploading a video.
          Catches VRAM contention, OOM errors, and CPU fallback in under 60 seconds.
        </div>

        <button
          onClick={runTest}
          disabled={testRunning}
          style={{
            ...smallBtnStyle,
            background: testRunning ? 'var(--bg-elevated)' : 'var(--accent-cyan)',
            color: testRunning ? 'var(--text-muted)' : '#fff',
            cursor: testRunning ? 'default' : 'pointer',
            marginBottom: 12, padding: '6px 16px',
          }}
        >
          {testRunning ? 'Running...' : 'Run Pipeline Test'}
        </button>

        {/* Phase results */}
        {testPhases.length > 0 && (
          <div style={{
            padding: '8px 12px', background: 'var(--bg-base)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
          }}>
            {testPhases.map((p) => <PhaseRow key={p.phase} phase={p} />)}

            {testOverall && (
              <div style={{
                marginTop: 8, padding: '8px 0', fontSize: 12, fontWeight: 600,
                color: testOverall.overall_status === 'pass' ? '#22c55e' : '#ef4444',
                textAlign: 'center',
              }}>
                {testOverall.overall_status === 'pass'
                  ? '\u2705 Pipeline ready for video analysis'
                  : '\u274c Pipeline has issues — check results above'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Shared Styles ───────────────────────────────────────────────────────
const cardStyle = {
  padding: '12px 16px', background: 'var(--bg-panel)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
};

const smallBtnStyle = {
  marginTop: 8, padding: '4px 12px', fontSize: 10, fontFamily: 'var(--font-mono)',
  background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
};
