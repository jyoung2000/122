import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { sendNotification } from '../utils/notifications';

const EncodingContext = createContext(null);

const LOGS_STORAGE_KEY = 'clipai_activity_logs';
const MAX_LOGS = 2000;

function loadPersistedLogs() {
  try {
    const saved = localStorage.getItem(LOGS_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) return parsed.slice(0, MAX_LOGS);
    }
  } catch {}
  return [];
}

function persistLogs(logs) {
  try {
    localStorage.setItem(LOGS_STORAGE_KEY, JSON.stringify(logs.slice(0, MAX_LOGS)));
  } catch {}
}

/**
 * Global encoding state manager.
 * Tracks all active clip exports across pages so encoding persists
 * even when the user navigates away from the clips tab.
 *
 * Also maintains a persistent activity log (localStorage-backed) that
 * captures all processing events: exports, analysis progress, errors,
 * cancellations, clip generation, etc.
 */
export function EncodingProvider({ children }) {
  const [tasks, setTasks] = useState({});
  const [logs, setLogs] = useState(loadPersistedLogs);
  const logIdRef = useRef(
    // Resume log IDs from persisted data to avoid collisions
    logs.length > 0 ? Math.max(...logs.map((l) => l.id || 0)) + 1 : 1
  );
  const wsRefs = useRef({});
  // Track which job WebSockets we've opened for global monitoring
  const monitorWsRefs = useRef({});
  // Dedup: track recently downloaded URLs to prevent duplicate browser downloads
  // (multiple WS connections can receive the same export_complete broadcast)
  const recentDownloadsRef = useRef(new Set());
  // Guard: track in-flight export IDs to prevent duplicate export requests
  // (e.g., double-click before React state update disables the button)
  const activeExportsRef = useRef(new Set());

  // Persist logs whenever they change
  useEffect(() => {
    persistLogs(logs);
  }, [logs]);

  const pushLog = useCallback((level, message, extra) => {
    const id = ++logIdRef.current;
    const entry = { id, timestamp: Date.now(), level, message };
    if (extra) entry.extra = extra;
    setLogs((prev) => [entry, ...prev].slice(0, MAX_LOGS));
    return entry;
  }, []);

  const startExport = useCallback((jobId, clipId, clipTitle, exportBody, options) => {
    const exportId = `${jobId}_${clipId}`;

    // Prevent duplicate exports: if this exact export is already in-flight,
    // ignore the second request (protects against double-clicks and race
    // conditions before React state updates disable the button).
    if (activeExportsRef.current.has(exportId)) {
      return exportId;
    }
    activeExportsRef.current.add(exportId);

    const quality = exportBody?.export_quality || '1080p';
    const apiEndpoint = (options && options.endpoint) || `/api/jobs/${jobId}/export-clip`;

    setTasks((prev) => ({
      ...prev,
      [exportId]: {
        jobId,
        clipId,
        clipTitle: clipTitle || `Clip ${clipId}`,
        status: 'encoding',
        message: 'Starting export...',
        startedAt: Date.now(),
        downloadUrl: null,
        exportQuality: quality,
      },
    }));

    pushLog('info', `Export started: ${clipTitle || `Clip ${clipId}`} [${quality}]`);

    fetch(apiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(exportBody),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Export request failed: ${res.status}`);
        _openWs(jobId, clipId, clipTitle);
      })
      .catch((err) => {
        activeExportsRef.current.delete(exportId);
        setTasks((prev) => ({
          ...prev,
          [exportId]: { ...prev[exportId], status: 'error', message: err.message },
        }));
        pushLog('error', `Export failed for ${clipTitle || `Clip ${clipId}`}: ${err.message}`);
      });

    return exportId;
  }, [pushLog]);

  const _openWs = useCallback((jobId, clipId, clipTitle) => {
    const exportId = `${jobId}_${clipId}`;
    if (wsRefs.current[jobId]) {
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/jobs/${jobId}`);
    wsRefs.current[jobId] = ws;

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'status' && msg.status === 'exporting') {
          setTasks((prev) => {
            const task = prev[exportId];
            if (!task) return prev;
            return { ...prev, [exportId]: {
              ...task,
              message: msg.message || 'Encoding...',
              progress: msg.progress ?? task.progress ?? 0,
            } };
          });
          pushLog('info', msg.message || 'Encoding...');
        } else if (msg.type === 'export_complete') {
          const completedExportId = `${jobId}_${msg.clip_id}`;
          activeExportsRef.current.delete(completedExportId);
          setTasks((prev) => {
            const task = prev[completedExportId];
            if (!task) return prev;
            return {
              ...prev,
              [completedExportId]: {
                ...task,
                status: 'complete',
                message: msg.message || 'Export complete',
                downloadUrl: msg.download_url || null,
              },
            };
          });
          pushLog('success', msg.message || `Clip exported successfully`);
          sendNotification('Export Complete', {
            body: `${clipTitle || `Clip ${msg.clip_id}`} is ready for download.`,
            tag: `export-${jobId}-${msg.clip_id}`,
          });
          if (msg.download_url && !recentDownloadsRef.current.has(msg.download_url)) {
            // Dedup: mark this URL so duplicate WS messages don't trigger
            // multiple browser downloads for the same file.
            recentDownloadsRef.current.add(msg.download_url);
            setTimeout(() => recentDownloadsRef.current.delete(msg.download_url), 10000);
            const a = document.createElement('a');
            a.href = msg.download_url;
            a.download = '';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          }
          _maybeCloseWs(jobId);
        } else if (msg.type === 'error') {
          // Clear active export guards for all exports on this job
          for (const key of activeExportsRef.current) {
            if (key.startsWith(`${jobId}_`)) activeExportsRef.current.delete(key);
          }
          setTasks((prev) => {
            const next = { ...prev };
            for (const key of Object.keys(next)) {
              if (key.startsWith(`${jobId}_`) && next[key].status === 'encoding') {
                next[key] = { ...next[key], status: 'error', message: msg.message || 'Export failed' };
              }
            }
            return next;
          });
          pushLog('error', msg.message || 'Export error');
          _maybeCloseWs(jobId);
        } else if (msg.type === 'subject_tracking') {
          pushLog(msg.enabled ? 'info' : 'warning', msg.message);
        }
      } catch {}
    };

    ws.onerror = () => {
      pushLog('error', `WebSocket error for job ${jobId}`);
    };

    ws.onclose = () => {
      delete wsRefs.current[jobId];
    };
  }, [pushLog]);

  const _maybeCloseWs = useCallback((jobId) => {
    setTimeout(() => {
      setTasks((prev) => {
        const hasActive = Object.keys(prev).some(
          (k) => k.startsWith(`${jobId}_`) && prev[k].status === 'encoding'
        );
        if (!hasActive && wsRefs.current[jobId]) {
          wsRefs.current[jobId].close();
          delete wsRefs.current[jobId];
        }
        return prev;
      });
    }, 1000);
  }, []);

  // --- Global job monitor ---
  // Connects to active/running jobs to capture all processing logs
  // (analysis, transcription, scene detection, clip detection, etc.)
  const monitorJob = useCallback((jobId, jobFilename) => {
    if (monitorWsRefs.current[jobId]) return;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/jobs/${jobId}`);
    monitorWsRefs.current[jobId] = ws;

    const label = jobFilename || jobId.slice(0, 8);

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'status') {
          const level = msg.status === 'failed' ? 'error' : 'status';
          pushLog(level, `[${label}] ${msg.message || `Status: ${msg.status}`}`, {
            jobId, status: msg.status, progress: msg.progress,
          });
        } else if (msg.type === 'complete') {
          pushLog('success', `[${label}] ${msg.message || 'Processing complete'}`, { jobId });
          // Close after a short delay
          setTimeout(() => {
            if (monitorWsRefs.current[jobId]) {
              monitorWsRefs.current[jobId].close();
              delete monitorWsRefs.current[jobId];
            }
          }, 2000);
        } else if (msg.type === 'fallback') {
          pushLog('warning', `[${label}] Provider fallback: ${msg.from_provider} -> ${msg.to_provider} (${msg.reason})`, { jobId });
        } else if (msg.type === 'clips_generated') {
          pushLog('success', `[${label}] ${msg.message || `Generated ${msg.count} clips`}`, { jobId });
        } else if (msg.type === 'cancelled') {
          pushLog('warning', `[${label}] Job cancelled`, { jobId });
        } else if (msg.type === 'error') {
          pushLog('error', `[${label}] ${msg.message || 'Error'}`, { jobId });
        } else if (msg.type === 'export_complete') {
          pushLog('success', `[${label}] ${msg.message || 'Export complete'}`, { jobId });
        } else if (msg.type === 'subject_tracking') {
          pushLog(msg.enabled ? 'info' : 'warning', `[${label}] ${msg.message}`, { jobId });
        }
      } catch {}
    };

    ws.onclose = () => {
      delete monitorWsRefs.current[jobId];
    };
  }, [pushLog]);

  const stopMonitorJob = useCallback((jobId) => {
    const ws = monitorWsRefs.current[jobId];
    if (ws) {
      ws.close();
      delete monitorWsRefs.current[jobId];
    }
  }, []);

  const cancelExport = useCallback(async (exportId) => {
    const task = tasks[exportId];
    if (!task || task.status !== 'encoding') return;

    try {
      const res = await fetch(`/api/jobs/${task.jobId}/cancel-export/${task.clipId}`, {
        method: 'POST',
      });
      if (res.ok) {
        activeExportsRef.current.delete(exportId);
        setTasks((prev) => ({
          ...prev,
          [exportId]: { ...prev[exportId], status: 'cancelled', message: 'Cancelled by user' },
        }));
        pushLog('warning', `Export cancelled: ${task.clipTitle}`);
      }
    } catch (err) {
      pushLog('error', `Failed to cancel: ${err.message}`);
    }
  }, [tasks, pushLog]);

  const clearTask = useCallback((exportId) => {
    setTasks((prev) => {
      const next = { ...prev };
      delete next[exportId];
      return next;
    });
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
    persistLogs([]);
  }, []);

  const exportLogsAsFile = useCallback(() => {
    const lines = logs.slice().reverse().map((entry) => {
      const d = new Date(entry.timestamp);
      const ts = d.toLocaleString();
      const level = (entry.level || 'info').toUpperCase().padEnd(7);
      return `[${ts}] ${level} ${entry.message}`;
    });
    const content = lines.join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clipai-logs-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [logs]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      Object.values(wsRefs.current).forEach((ws) => {
        try { ws.close(); } catch {}
      });
      Object.values(monitorWsRefs.current).forEach((ws) => {
        try { ws.close(); } catch {}
      });
    };
  }, []);

  const activeCount = Object.values(tasks).filter((t) => t.status === 'encoding').length;

  // Latest activity message for the global status indicator
  const latestActivity = logs.length > 0 ? logs[0] : null;

  // Count of monitored (processing) jobs
  const monitoredJobCount = Object.keys(monitorWsRefs.current).length;

  return (
    <EncodingContext.Provider value={{
      tasks,
      logs,
      activeCount,
      latestActivity,
      monitoredJobCount,
      startExport,
      cancelExport,
      clearTask,
      clearLogs,
      pushLog,
      exportLogsAsFile,
      monitorJob,
      stopMonitorJob,
    }}>
      {children}
    </EncodingContext.Provider>
  );
}

export default function useEncodingManager() {
  const ctx = useContext(EncodingContext);
  if (!ctx) throw new Error('useEncodingManager must be used within EncodingProvider');
  return ctx;
}
