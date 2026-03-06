import { useEffect, useRef, useCallback, useState } from 'react';
import { openDB } from 'idb';
import useTimelineStore from '../stores/timelineStore';

const DB_NAME = 'clipai-editor';
const DB_VERSION = 1;
const STORE_NAME = 'projects';
const AUTOSAVE_DEBOUNCE_MS = 500;
const SERVER_SYNC_INTERVAL_MS = 60000;

async function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    },
  });
}

export default function useTimelinePersistence(jobId, clipId) {
  const exportState = useTimelineStore((s) => s.exportState);
  const importState = useTimelineStore((s) => s.importState);
  const tracks = useTimelineStore((s) => s.tracks);
  const items = useTimelineStore((s) => s.items);
  const [recovered, setRecovered] = useState(false);

  const saveTimerRef = useRef(null);
  const serverTimerRef = useRef(null);
  const key = `${jobId || 'unknown'}_${clipId || 'default'}`;

  // ── Load from IndexedDB on mount ──────────────────────────────────────────
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    (async () => {
      try {
        const db = await getDB();
        const saved = await db.get(STORE_NAME, key);
        if (saved && saved.state && !cancelled) {
          const state = saved.state;
          if (Array.isArray(state.items) && state.items.length > 0) {
            importState(state);
            setRecovered(true);
          }
        }
      } catch {
        // IndexedDB unavailable — no recovery
      }
    })();
    return () => { cancelled = true; };
  }, [jobId, clipId, key]);

  // ── Auto-save to IndexedDB (debounced) ────────────────────────────────────
  useEffect(() => {
    if (!jobId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        const state = exportState();
        const db = await getDB();
        await db.put(STORE_NAME, {
          key,
          state,
          lastModified: new Date().toISOString(),
        });
      } catch {
        // Silently fail
      }
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [tracks, items, jobId, clipId, key, exportState]);

  // ── Server sync every 60s ─────────────────────────────────────────────────
  const syncToServer = useCallback(async () => {
    if (!jobId || clipId == null) return;
    try {
      const state = exportState();
      await fetch(`/api/jobs/${jobId}/clips/${clipId}/editor-state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
    } catch {
      // Server sync is best-effort
    }
  }, [jobId, clipId, exportState]);

  useEffect(() => {
    if (!jobId) return;
    serverTimerRef.current = setInterval(syncToServer, SERVER_SYNC_INTERVAL_MS);
    return () => {
      if (serverTimerRef.current) clearInterval(serverTimerRef.current);
    };
  }, [syncToServer, jobId]);

  return { recovered };
}
