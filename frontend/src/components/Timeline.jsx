import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import useTimelineStore from '../stores/timelineStore';

// ── Constants ────────────────────────────────────────────────────────────────
const TRACK_HEIGHT = 40;
const TRACK_GAP = 2;
const LABEL_WIDTH = 60;
const HANDLE_WIDTH = 6;
const HANDLE_HIT_AREA = 12;
const SNAP_THRESHOLD_PX = 5;
const MIN_PPS = 10;  // min pixels per second
const MAX_PPS = 200; // max pixels per second

const TRACK_COLORS = {
  video: '#3B82F6',
  overlay: '#F59E0B',
  audio: '#10B981',
  subtitle: '#8B5CF6',
};

function formatTime(s) {
  if (!s || isNaN(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export default function Timeline({ compact = false, onSeek }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const animRef = useRef(null);

  const tracks = useTimelineStore((s) => s.tracks);
  const items = useTimelineStore((s) => s.items);
  const playhead = useTimelineStore((s) => s.playhead);
  const duration = useTimelineStore((s) => s.duration);
  const zoom = useTimelineStore((s) => s.zoom);
  const snapEnabled = useTimelineStore((s) => s.snapEnabled);
  const selectedItemId = useTimelineStore((s) => s.selectedItemId);
  const isPlaying = useTimelineStore((s) => s.isPlaying);
  const setPlayhead = useTimelineStore((s) => s.setPlayhead);
  const setZoom = useTimelineStore((s) => s.setZoom);
  const setSelectedItemId = useTimelineStore((s) => s.setSelectedItemId);
  const updateItem = useTimelineStore((s) => s.updateItem);
  const updateItemWithSnapshot = useTimelineStore((s) => s.updateItemWithSnapshot);
  const addItem = useTimelineStore((s) => s.addItem);
  const splitItem = useTimelineStore((s) => s.splitItem);
  const removeItem = useTimelineStore((s) => s.removeItem);
  const toggleSnap = useTimelineStore((s) => s.toggleSnap);

  const [scrollX, setScrollX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragInfo, setDragInfo] = useState(null);
  const [hoverTime, setHoverTime] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);

  const basePPS = compact ? 40 : 60; // base pixels per second
  const pps = basePPS * zoom;
  const totalWidth = Math.max((duration || 30) * pps, 400);
  const trackAreaWidth = useMemo(() => {
    const container = containerRef.current;
    return container ? container.clientWidth - LABEL_WIDTH : 600;
  }, []);

  // ── Canvas rendering ──────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const canvasW = rect.width;
    const canvasH = rect.height;
    const isDark = document.documentElement.dataset?.theme === 'dark';
    const contentLeft = LABEL_WIDTH;
    const contentWidth = canvasW - LABEL_WIDTH;

    // ── Ruler ──
    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)';
    ctx.fillRect(0, 0, canvasW, 20);

    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';

    // Determine ruler interval based on zoom
    let interval = 1;
    if (pps < 15) interval = 10;
    else if (pps < 30) interval = 5;
    else if (pps < 60) interval = 2;
    else if (pps > 120) interval = 0.5;

    const maxTime = duration || 30;
    for (let t = 0; t <= maxTime; t += interval) {
      const x = contentLeft + t * pps - scrollX;
      if (x < contentLeft - 10 || x > canvasW + 10) continue;
      ctx.fillText(formatTime(t), x, 14);

      ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
      ctx.beginPath();
      ctx.moveTo(x, 18);
      ctx.lineTo(x, canvasH);
      ctx.stroke();
    }

    // ── Track lanes ──
    const visibleTracks = tracks.filter((t) => t.visible !== false);
    visibleTracks.forEach((track, idx) => {
      const y = 22 + idx * (TRACK_HEIGHT + TRACK_GAP);

      // Track label background
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)';
      ctx.fillRect(0, y, LABEL_WIDTH - 2, TRACK_HEIGHT);

      // Track label text
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
      ctx.font = '8px sans-serif';
      ctx.textAlign = 'left';
      const typeIcon = track.type === 'video' || track.type === 'overlay' ? '🎬' : track.type === 'audio' ? '🎵' : '💬';
      ctx.fillText(`${typeIcon} ${track.name}`, 4, y + TRACK_HEIGHT / 2 + 3);

      // Track lane bg
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)';
      ctx.fillRect(contentLeft, y, contentWidth, TRACK_HEIGHT);

      // Track border
      ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
      ctx.strokeRect(contentLeft, y, contentWidth, TRACK_HEIGHT);

      // Muted indicator
      if (track.muted) {
        ctx.fillStyle = isDark ? 'rgba(255,59,48,0.08)' : 'rgba(255,59,48,0.06)';
        ctx.fillRect(contentLeft, y, contentWidth, TRACK_HEIGHT);
      }
    });

    // ── Items ──
    items.forEach((item) => {
      const trackIdx = visibleTracks.findIndex((t) => t.id === item.trackId);
      if (trackIdx < 0) return;
      const y = 22 + trackIdx * (TRACK_HEIGHT + TRACK_GAP);
      const x1 = contentLeft + item.start * pps - scrollX;
      const x2 = contentLeft + item.end * pps - scrollX;
      const w = x2 - x1;

      if (x2 < contentLeft || x1 > canvasW) return; // off-screen

      const color = TRACK_COLORS[item.type] || TRACK_COLORS.video;
      const isSelected = item.id === selectedItemId;

      // Item body
      ctx.fillStyle = isSelected ? color + 'CC' : color + '66';
      const rr = 3;
      ctx.beginPath();
      ctx.roundRect(x1, y + 2, w, TRACK_HEIGHT - 4, rr);
      ctx.fill();

      // Selected border
      if (isSelected) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(x1, y + 2, w, TRACK_HEIGHT - 4, rr);
        ctx.stroke();
        ctx.lineWidth = 1;
      }

      // Item label
      if (w > 30) {
        ctx.fillStyle = '#fff';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        const label = item.subtitleText
          ? item.subtitleText.slice(0, 20)
          : item.type;
        ctx.fillText(label, x1 + 6, y + TRACK_HEIGHT / 2 + 3, w - 12);
      }

      // Trim handles (visual only, hit detection is in pointer handler)
      if (isSelected) {
        ctx.fillStyle = color;
        ctx.fillRect(x1, y + 2, HANDLE_WIDTH, TRACK_HEIGHT - 4);
        ctx.fillRect(x2 - HANDLE_WIDTH, y + 2, HANDLE_WIDTH, TRACK_HEIGHT - 4);
      }

      // Opacity indicator
      if (item.opacity < 1) {
        ctx.fillStyle = isDark ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.3)';
        ctx.fillRect(x1, y + 2, w, TRACK_HEIGHT - 4);
      }
    });

    // ── Playhead ──
    const phX = contentLeft + playhead * pps - scrollX;
    if (phX >= contentLeft && phX <= canvasW) {
      ctx.strokeStyle = '#FF3B30';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(phX, 0);
      ctx.lineTo(phX, canvasH);
      ctx.stroke();
      ctx.lineWidth = 1;

      // Playhead triangle
      ctx.fillStyle = '#FF3B30';
      ctx.beginPath();
      ctx.moveTo(phX - 6, 0);
      ctx.lineTo(phX + 6, 0);
      ctx.lineTo(phX, 8);
      ctx.closePath();
      ctx.fill();
    }

    // ── Hover time indicator ──
    if (hoverTime !== null) {
      const hx = contentLeft + hoverTime * pps - scrollX;
      if (hx >= contentLeft && hx <= canvasW) {
        ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(hx, 20);
        ctx.lineTo(hx, canvasH);
        ctx.stroke();
        ctx.setLineDash([]);

        // Tooltip
        ctx.fillStyle = 'rgba(0,0,0,0.8)';
        const tooltipText = formatTime(hoverTime);
        const tw = ctx.measureText(tooltipText).width + 8;
        ctx.beginPath();
        ctx.roundRect(hx - tw / 2, 2, tw, 14, 3);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(tooltipText, hx, 12);
      }
    }

    // ── Snap guideline ──
    // (rendered during drag by the drag handler)

  }, [tracks, items, playhead, duration, zoom, scrollX, selectedItemId, hoverTime, pps, compact]);

  // Continuous redraw during playback
  useEffect(() => {
    if (!isPlaying) return;
    let rafId;
    const tick = () => {
      draw();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, draw]);

  // Redraw on state changes
  useEffect(() => { draw(); }, [draw]);

  // Resize observer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [draw]);

  // ── Pointer helpers ────────────────────────────────────────────────────────
  const getTimeFromX = useCallback((clientX) => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left - LABEL_WIDTH + scrollX;
    return Math.max(0, x / pps);
  }, [pps, scrollX]);

  const getTrackFromY = useCallback((clientY) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const y = clientY - rect.top - 22;
    const visibleTracks = tracks.filter((t) => t.visible !== false);
    const idx = Math.floor(y / (TRACK_HEIGHT + TRACK_GAP));
    return visibleTracks[idx] || null;
  }, [tracks]);

  const hitTestItem = useCallback((clientX, clientY) => {
    const time = getTimeFromX(clientX);
    const track = getTrackFromY(clientY);
    if (!track) return null;

    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;

    for (const item of items) {
      if (item.trackId !== track.id) continue;
      if (time < item.start || time > item.end) continue;

      const x1 = LABEL_WIDTH + item.start * pps - scrollX;
      const x2 = LABEL_WIDTH + item.end * pps - scrollX;

      // Check trim handles
      if (Math.abs(px - x1) < HANDLE_HIT_AREA) return { item, edge: 'left' };
      if (Math.abs(px - x2) < HANDLE_HIT_AREA) return { item, edge: 'right' };
      return { item, edge: 'body' };
    }
    return null;
  }, [items, pps, scrollX, getTimeFromX, getTrackFromY]);

  // ── Pointer events ─────────────────────────────────────────────────────────
  const onPointerDown = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();

    // Right-click context menu
    if (e.button === 2) {
      e.preventDefault();
      const time = getTimeFromX(e.clientX);
      const hit = hitTestItem(e.clientX, e.clientY);
      setContextMenu({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        time,
        item: hit?.item || null,
      });
      return;
    }

    setContextMenu(null);

    const hit = hitTestItem(e.clientX, e.clientY);
    if (hit) {
      setSelectedItemId(hit.item.id);

      if (hit.edge === 'left' || hit.edge === 'right') {
        // Trim handle drag
        setIsDragging(true);
        setDragInfo({
          type: 'trim',
          itemId: hit.item.id,
          edge: hit.edge,
          origStart: hit.item.start,
          origEnd: hit.item.end,
          origTrimStart: hit.item.trimStart,
          origTrimEnd: hit.item.trimEnd,
          startX: e.clientX,
        });
      } else {
        // Body drag (move)
        setIsDragging(true);
        setDragInfo({
          type: 'move',
          itemId: hit.item.id,
          origStart: hit.item.start,
          origEnd: hit.item.end,
          origTrackId: hit.item.trackId,
          startX: e.clientX,
          startY: e.clientY,
        });
      }
    } else {
      // Click on empty area: seek playhead
      const time = getTimeFromX(e.clientX);
      setPlayhead(time);
      setSelectedItemId(null);
      onSeek?.(time);

      // Drag to scrub
      setIsDragging(true);
      setDragInfo({ type: 'scrub', startX: e.clientX });
    }
  }, [hitTestItem, getTimeFromX, setPlayhead, setSelectedItemId, onSeek]);

  useEffect(() => {
    if (!isDragging || !dragInfo) return;

    const onMove = (e) => {
      const time = getTimeFromX(e.clientX);

      if (dragInfo.type === 'scrub') {
        setPlayhead(time);
        onSeek?.(time);
      } else if (dragInfo.type === 'trim') {
        const item = items.find((i) => i.id === dragInfo.itemId);
        if (!item) return;
        if (dragInfo.edge === 'left') {
          const newStart = Math.max(0, Math.min(dragInfo.origEnd - 0.1, time));
          updateItem(dragInfo.itemId, { start: newStart });
        } else {
          const newEnd = Math.max(dragInfo.origStart + 0.1, time);
          updateItem(dragInfo.itemId, { end: newEnd });
        }
      } else if (dragInfo.type === 'move') {
        const dx = (e.clientX - dragInfo.startX) / pps;
        let newStart = Math.max(0, dragInfo.origStart + dx);
        const dur = dragInfo.origEnd - dragInfo.origStart;
        // Snap
        if (snapEnabled) {
          const edges = items
            .filter((i) => i.id !== dragInfo.itemId)
            .flatMap((i) => [i.start, i.end]);
          edges.push(playhead);
          for (const edge of edges) {
            if (Math.abs((newStart - edge) * pps) < SNAP_THRESHOLD_PX) {
              newStart = edge;
              break;
            }
            if (Math.abs((newStart + dur - edge) * pps) < SNAP_THRESHOLD_PX) {
              newStart = edge - dur;
              break;
            }
          }
        }
        // Track change via Y movement
        const track = getTrackFromY(e.clientY);
        const trackId = track ? track.id : dragInfo.origTrackId;
        updateItem(dragInfo.itemId, { start: newStart, end: newStart + dur, trackId });
      }
    };

    const onUp = () => {
      if (dragInfo.type === 'trim' || dragInfo.type === 'move') {
        // Take snapshot for undo on completion
        const item = items.find((i) => i.id === dragInfo.itemId);
        if (item && (item.start !== dragInfo.origStart || item.end !== dragInfo.origEnd)) {
          // Already modified inline, no additional action needed
        }
      }
      setIsDragging(false);
      setDragInfo(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [isDragging, dragInfo, items, pps, scrollX, snapEnabled, playhead, getTimeFromX, getTrackFromY, updateItem, setPlayhead, onSeek]);

  // ── Hover ──────────────────────────────────────────────────────────────────
  const onPointerMove = useCallback((e) => {
    if (isDragging) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < LABEL_WIDTH) {
      setHoverTime(null);
      canvas.style.cursor = 'default';
      return;
    }
    const time = getTimeFromX(e.clientX);
    setHoverTime(time);

    const hit = hitTestItem(e.clientX, e.clientY);
    if (hit) {
      if (hit.edge === 'left' || hit.edge === 'right') {
        canvas.style.cursor = 'col-resize';
      } else {
        canvas.style.cursor = 'grab';
      }
    } else {
      canvas.style.cursor = 'pointer';
    }
  }, [isDragging, getTimeFromX, hitTestItem]);

  const onPointerLeave = useCallback(() => {
    setHoverTime(null);
  }, []);

  // ── Zoom via Ctrl+Wheel ────────────────────────────────────────────────────
  const onWheel = useCallback((e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom(zoom + delta);
    } else {
      // Horizontal scroll
      setScrollX((prev) => Math.max(0, prev + e.deltaX + (e.shiftKey ? e.deltaY : 0)));
    }
  }, [zoom, setZoom]);

  // ── Drop from media library ────────────────────────────────────────────────
  const onDrop = useCallback((e) => {
    e.preventDefault();
    const data = e.dataTransfer.getData('application/x-clipai-media');
    if (!data) return;
    try {
      const media = JSON.parse(data);
      const time = getTimeFromX(e.clientX);
      const track = getTrackFromY(e.clientY);
      if (!track) return;

      addItem({
        trackId: track.id,
        type: media.type,
        mediaRef: media.id,
        start: time,
        end: time + (media.duration || 5),
        volume: 1.0,
        speed: 1.0,
        opacity: 1.0,
      });
    } catch { /* invalid data */ }
  }, [getTimeFromX, getTrackFromY, addItem]);

  const onDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  // ── Context menu ───────────────────────────────────────────────────────────
  const onContextMenu = useCallback((e) => e.preventDefault(), []);

  const handleContextAction = useCallback((action) => {
    if (!contextMenu) return;
    const { time, item } = contextMenu;
    switch (action) {
      case 'split':
        if (item) splitItem(item.id, time);
        break;
      case 'delete':
        if (item) removeItem(item.id);
        break;
      case 'duplicate':
        if (item) {
          const store = useTimelineStore.getState();
          store.duplicateItem(item.id);
        }
        break;
    }
    setContextMenu(null);
  }, [contextMenu, splitItem, removeItem]);

  // Close context menu on click elsewhere
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  // ── Compute canvas height ──────────────────────────────────────────────────
  const visibleTracks = tracks.filter((t) => t.visible !== false);
  const canvasHeight = 22 + visibleTracks.length * (TRACK_HEIGHT + TRACK_GAP) + 8;

  return (
    <div
      ref={containerRef}
      className="ve-multi-timeline"
      style={{ position: 'relative' }}
    >
      {/* Zoom toolbar */}
      <div className="ve-multi-timeline__toolbar">
        <button
          className="ve-btn"
          onClick={() => setZoom(zoom - 0.2)}
          title="Zoom out (−)"
          style={{ fontSize: 12, padding: '2px 6px', minWidth: 24, minHeight: 24 }}
        >
          −
        </button>
        <input
          type="range"
          min="0.1"
          max="5"
          step="0.1"
          value={zoom}
          onChange={(e) => setZoom(parseFloat(e.target.value))}
          className="ve-multi-timeline__zoom-slider"
        />
        <button
          className="ve-btn"
          onClick={() => setZoom(zoom + 0.2)}
          title="Zoom in (+)"
          style={{ fontSize: 12, padding: '2px 6px', minWidth: 24, minHeight: 24 }}
        >
          +
        </button>
        <button
          className={`ve-btn${snapEnabled ? ' ve-btn--active-snap' : ''}`}
          onClick={toggleSnap}
          title={`Snap: ${snapEnabled ? 'ON' : 'OFF'}`}
          style={{ fontSize: 10, padding: '2px 6px', minWidth: 'auto', minHeight: 24 }}
        >
          ⚡ Snap
        </button>
      </div>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        className="ve-multi-timeline__canvas"
        style={{ width: '100%', height: canvasHeight }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onWheel={onWheel}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onContextMenu={onContextMenu}
      />

      {/* Context menu */}
      {contextMenu && (
        <div
          className="ve-multi-timeline__context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.item && (
            <>
              <button onClick={() => handleContextAction('split')}>Split at playhead</button>
              <button onClick={() => handleContextAction('delete')}>Delete</button>
              <button onClick={() => handleContextAction('duplicate')}>Duplicate</button>
            </>
          )}
          {!contextMenu.item && (
            <div style={{ padding: '4px 8px', fontSize: 10, color: 'var(--ve-text-muted)' }}>
              No item selected
            </div>
          )}
        </div>
      )}
    </div>
  );
}
