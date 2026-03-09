import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import useTimelineStore from '../stores/timelineStore';

// ── Constants ────────────────────────────────────────────────────────────────
const TRACK_HEIGHT = 64;
const TRACK_GAP = 1;
const LABEL_WIDTH = 90;
const HANDLE_WIDTH = 6;
const HANDLE_HIT_AREA = 12;
const SNAP_THRESHOLD_PX = 5;
const RULER_HEIGHT = 28;

const TRACK_COLORS = {
  video: '#3B82F6',
  overlay: '#F59E0B',
  audio: '#10B981',
  subtitle: '#8B5CF6',
  text: '#EC4899',
  shape: '#F97316',
};

const TRACK_ICONS = {
  video: '\uD83C\uDFAC',
  overlay: '\uD83D\uDDBC',
  audio: '\uD83C\uDFB5',
  subtitle: '\uD83D\uDCAC',
  text: 'T',
  shape: '\u25A1',
};

function formatTime(s) {
  if (!s || isNaN(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function formatTimeMs(s) {
  if (!s || isNaN(s) || s < 0) return '0:00.00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 100);
  return `${m}:${sec.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

export default function Timeline({ compact = false, onSeek, onItemSelect }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  const tracks = useTimelineStore((s) => s.tracks);
  const items = useTimelineStore((s) => s.items);
  const playhead = useTimelineStore((s) => s.playhead);
  const duration = useTimelineStore((s) => s.duration);
  const zoom = useTimelineStore((s) => s.zoom);
  const scrollX = useTimelineStore((s) => s.scrollX);
  const snapEnabled = useTimelineStore((s) => s.snapEnabled);
  const selectedItemId = useTimelineStore((s) => s.selectedItemId);
  const activeTool = useTimelineStore((s) => s.activeTool);
  const isPlaying = useTimelineStore((s) => s.isPlaying);
  const setPlayhead = useTimelineStore((s) => s.setPlayhead);
  const setZoom = useTimelineStore((s) => s.setZoom);
  const setScrollX = useTimelineStore((s) => s.setScrollX);
  const setSelectedItemId = useTimelineStore((s) => s.setSelectedItemId);
  const updateItem = useTimelineStore((s) => s.updateItem);
  const addItem = useTimelineStore((s) => s.addItem);
  const splitItem = useTimelineStore((s) => s.splitItem);
  const removeItem = useTimelineStore((s) => s.removeItem);
  const toggleSnap = useTimelineStore((s) => s.toggleSnap);
  const addTrack = useTimelineStore((s) => s.addTrack);
  const segments = useTimelineStore((s) => s.segments);

  const [isDragging, setIsDragging] = useState(false);
  const [dragInfo, setDragInfo] = useState(null);
  const [hoverTime, setHoverTime] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [showAddTrack, setShowAddTrack] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);

  // Spacebar hold for pan mode
  useEffect(() => {
    const onKeyDown = (e) => { if (e.code === 'Space' && !e.repeat) setSpaceHeld(true); };
    const onKeyUp = (e) => { if (e.code === 'Space') setSpaceHeld(false); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, []);

  const basePPS = compact ? 40 : 60;
  const pps = basePPS * zoom;

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
    const sx = scrollX;

    // ── Ruler ──
    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)';
    ctx.fillRect(0, 0, canvasW, RULER_HEIGHT);

    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
    ctx.font = '10px "SF Mono", "Menlo", monospace';
    ctx.textAlign = 'center';

    let interval = 1;
    if (pps < 15) interval = 10;
    else if (pps < 30) interval = 5;
    else if (pps < 60) interval = 2;
    else if (pps > 120) interval = 0.5;

    const maxTime = duration || 30;
    for (let t = 0; t <= maxTime; t += interval) {
      const x = contentLeft + t * pps - sx;
      if (x < contentLeft - 10 || x > canvasW + 10) continue;
      ctx.fillText(formatTime(t), x, 16);

      // Tick marks
      ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT - 4);
      ctx.lineTo(x, RULER_HEIGHT);
      ctx.stroke();

      // Grid lines
      ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)';
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT);
      ctx.lineTo(x, canvasH);
      ctx.stroke();
    }

    // ── Track lanes ──
    const visibleTracks = tracks.filter((t) => t.visible !== false);
    visibleTracks.forEach((track, idx) => {
      const y = RULER_HEIGHT + idx * (TRACK_HEIGHT + TRACK_GAP);

      // Track label background
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';
      ctx.fillRect(0, y, LABEL_WIDTH - 1, TRACK_HEIGHT);

      // Track label
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.6)';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      const icon = TRACK_ICONS[track.type] || '';
      ctx.fillText(`${icon} ${track.name}`, 6, y + TRACK_HEIGHT / 2 + 4);

      // Lock/mute indicators
      if (track.locked) {
        ctx.fillStyle = isDark ? 'rgba(255,59,48,0.3)' : 'rgba(255,59,48,0.15)';
        ctx.fillText('\uD83D\uDD12', LABEL_WIDTH - 18, y + 12);
      }
      if (track.muted) {
        ctx.fillStyle = isDark ? 'rgba(255,59,48,0.3)' : 'rgba(255,59,48,0.15)';
        ctx.fillText('M', LABEL_WIDTH - 18, y + TRACK_HEIGHT - 6);
      }

      // Track lane background
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)';
      ctx.fillRect(contentLeft, y, contentWidth, TRACK_HEIGHT);

      // Track border
      ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
      ctx.strokeRect(contentLeft, y, contentWidth, TRACK_HEIGHT);

      // Muted overlay
      if (track.muted) {
        ctx.fillStyle = isDark ? 'rgba(255,59,48,0.06)' : 'rgba(255,59,48,0.04)';
        ctx.fillRect(contentLeft, y, contentWidth, TRACK_HEIGHT);
      }
    });

    // ── Items (clips) ──
    items.forEach((item) => {
      const trackIdx = visibleTracks.findIndex((t) => t.id === item.trackId);
      if (trackIdx < 0) return;
      const y = RULER_HEIGHT + trackIdx * (TRACK_HEIGHT + TRACK_GAP);
      const x1 = contentLeft + item.start * pps - sx;
      const x2 = contentLeft + item.end * pps - sx;
      const w = x2 - x1;

      if (x2 < contentLeft || x1 > canvasW) return;

      const color = TRACK_COLORS[item.type] || TRACK_COLORS.video;
      const isSelected = item.id === selectedItemId;

      // Clip body
      ctx.fillStyle = isSelected ? color + 'DD' : color + '77';
      const rr = 4;
      ctx.beginPath();
      ctx.roundRect(Math.max(x1, contentLeft), y + 2, Math.min(w, canvasW - Math.max(x1, contentLeft)), TRACK_HEIGHT - 4, rr);
      ctx.fill();

      // Selected border
      if (isSelected) {
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(Math.max(x1, contentLeft), y + 2, Math.min(w, canvasW - Math.max(x1, contentLeft)), TRACK_HEIGHT - 4, rr);
        ctx.stroke();
        ctx.lineWidth = 1;
      }

      // Transition indicator
      if (item.transition) {
        const transDur = item.transition.duration || 0.5;
        const transW = transDur * pps;
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.beginPath();
        ctx.moveTo(x1, y + 2);
        ctx.lineTo(x1 + transW, y + 2);
        ctx.lineTo(x1, y + TRACK_HEIGHT - 2);
        ctx.closePath();
        ctx.fill();
      }

      // Clip label
      if (w > 35) {
        ctx.fillStyle = '#fff';
        ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'left';
        const label = item.textContent
          ? item.textContent.slice(0, 25)
          : item.subtitleText
            ? item.subtitleText.slice(0, 25)
            : item.type;
        ctx.fillText(label, Math.max(x1 + 8, contentLeft + 4), y + TRACK_HEIGHT / 2 + 4, w - 16);
      }

      // Trim handles (visual, for selected items)
      if (isSelected && w > 20) {
        ctx.fillStyle = '#FFFFFF';
        ctx.globalAlpha = 0.8;
        ctx.fillRect(x1, y + 4, HANDLE_WIDTH, TRACK_HEIGHT - 8);
        ctx.fillRect(x2 - HANDLE_WIDTH, y + 4, HANDLE_WIDTH, TRACK_HEIGHT - 8);
        ctx.globalAlpha = 1;
      }

      // Effects indicator dot
      const effects = item.effects;
      if (effects && typeof effects === 'object' && !Array.isArray(effects)) {
        const hasEffects = Object.entries(effects).some(([k, v]) => v !== 0 && v !== undefined && v !== null);
        if (hasEffects) {
          ctx.fillStyle = '#FFD700';
          ctx.beginPath();
          ctx.arc(x2 - 12, y + 8, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });

    // ── Segment boundaries ──
    if (segments && segments.length > 0) {
      segments.forEach((seg) => {
        const segStart = seg.start != null ? seg.start : 0;
        const segEnd = seg.end != null ? seg.end : 0;
        for (const edge of [segStart, segEnd]) {
          const ex = contentLeft + edge * pps - sx;
          if (ex < contentLeft || ex > canvasW) continue;
          ctx.strokeStyle = seg.color || '#FF9F0A';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(ex, RULER_HEIGHT);
          ctx.lineTo(ex, canvasH);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineWidth = 1;
        }
        const sx1 = contentLeft + segStart * pps - sx;
        const sx2 = contentLeft + segEnd * pps - sx;
        if (sx2 > contentLeft && sx1 < canvasW && seg.label) {
          ctx.fillStyle = (seg.color || '#FF9F0A') + '18';
          ctx.fillRect(Math.max(sx1, contentLeft), RULER_HEIGHT, Math.min(sx2, canvasW) - Math.max(sx1, contentLeft), canvasH - RULER_HEIGHT);
          ctx.fillStyle = seg.color || '#FF9F0A';
          ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(seg.label, Math.max(sx1 + 4, contentLeft + 4), RULER_HEIGHT + 10);
        }
      });
    }

    // ── Playhead ──
    const phX = contentLeft + playhead * pps - sx;
    if (phX >= contentLeft && phX <= canvasW) {
      ctx.strokeStyle = '#FF3B30';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(phX, 0);
      ctx.lineTo(phX, canvasH);
      ctx.stroke();
      ctx.lineWidth = 1;

      // Playhead diamond
      ctx.fillStyle = '#FF3B30';
      ctx.beginPath();
      ctx.moveTo(phX - 7, 0);
      ctx.lineTo(phX + 7, 0);
      ctx.lineTo(phX, 9);
      ctx.closePath();
      ctx.fill();
    }

    // ── Hover indicator ──
    if (hoverTime !== null) {
      const hx = contentLeft + hoverTime * pps - sx;
      if (hx >= contentLeft && hx <= canvasW) {
        ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(hx, RULER_HEIGHT);
        ctx.lineTo(hx, canvasH);
        ctx.stroke();
        ctx.setLineDash([]);

        // Tooltip
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
        const tooltipText = formatTimeMs(hoverTime);
        const tw = ctx.measureText(tooltipText).width + 10;
        ctx.beginPath();
        ctx.roundRect(Math.min(hx - tw / 2, canvasW - tw - 4), 3, tw, 16, 4);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '10px "SF Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(tooltipText, Math.min(hx, canvasW - tw / 2 - 4), 14);
      }
    }

    // ── Razor cursor indicator ──
    if (activeTool === 'razor' && hoverTime !== null) {
      const rx = contentLeft + hoverTime * pps - sx;
      if (rx >= contentLeft && rx <= canvasW) {
        ctx.strokeStyle = '#FF9500';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 3]);
        ctx.beginPath();
        ctx.moveTo(rx, RULER_HEIGHT);
        ctx.lineTo(rx, canvasH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
      }
    }
  }, [tracks, items, playhead, duration, zoom, scrollX, selectedItemId, hoverTime, pps, compact, activeTool, segments]);

  // Continuous redraw during playback
  useEffect(() => {
    if (!isPlaying) return;
    let rafId;
    const tick = () => { draw(); rafId = requestAnimationFrame(tick); };
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
    const y = clientY - rect.top - RULER_HEIGHT;
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

    // Middle-click or space+left-click: pan/scroll
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      e.preventDefault();
      setIsDragging(true);
      setDragInfo({ type: 'pan', startX: e.clientX, origScrollX: scrollX });
      return;
    }

    // Razor tool: split on click
    if (activeTool === 'razor') {
      const time = getTimeFromX(e.clientX);
      const hit = hitTestItem(e.clientX, e.clientY);
      if (hit?.item) {
        splitItem(hit.item.id, time);
      }
      return;
    }

    const hit = hitTestItem(e.clientX, e.clientY);
    if (hit) {
      setSelectedItemId(hit.item.id);
      onItemSelect?.(hit.item);

      if (hit.edge === 'left' || hit.edge === 'right') {
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
      // Click on empty area: seek
      const time = getTimeFromX(e.clientX);
      setPlayhead(time);
      setSelectedItemId(null);
      onSeek?.(time);

      setIsDragging(true);
      setDragInfo({ type: 'scrub', startX: e.clientX });
    }
  }, [hitTestItem, getTimeFromX, setPlayhead, setSelectedItemId, onSeek, activeTool, splitItem, spaceHeld, scrollX, onItemSelect]);

  useEffect(() => {
    if (!isDragging || !dragInfo) return;

    const onMove = (e) => {
      if (dragInfo.type === 'pan') {
        const dx = e.clientX - dragInfo.startX;
        setScrollX(Math.max(0, dragInfo.origScrollX - dx));
        return;
      }

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
              newStart = edge; break;
            }
            if (Math.abs((newStart + dur - edge) * pps) < SNAP_THRESHOLD_PX) {
              newStart = edge - dur; break;
            }
          }
        }

        const track = getTrackFromY(e.clientY);
        let trackId = dragInfo.origTrackId;
        if (track) {
          // Enforce track type constraints: items can only move to compatible tracks
          const draggedItem = items.find((i) => i.id === dragInfo.itemId);
          const itemType = draggedItem?.type;
          const trackType = track.type;
          const compatible =
            (itemType === 'video' && trackType === 'video') ||
            (itemType === 'audio' && trackType === 'audio') ||
            ((itemType === 'text' || itemType === 'shape' || itemType === 'image' || itemType === 'overlay') && trackType === 'overlay') ||
            (itemType === 'subtitle' && trackType === 'subtitle');
          if (compatible) trackId = track.id;
        }
        updateItem(dragInfo.itemId, { start: newStart, end: newStart + dur, trackId });
      }
    };

    const onUp = () => {
      setIsDragging(false);
      setDragInfo(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [isDragging, dragInfo, items, pps, scrollX, snapEnabled, playhead, getTimeFromX, getTrackFromY, updateItem, setPlayhead, onSeek, setScrollX]);

  // ── Hover ──────────────────────────────────────────────────────────────────
  const onPointerMove = useCallback((e) => {
    if (isDragging) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < LABEL_WIDTH) { setHoverTime(null); canvas.style.cursor = 'default'; return; }

    setHoverTime(getTimeFromX(e.clientX));

    if (spaceHeld) {
      canvas.style.cursor = 'grab';
      return;
    }

    if (activeTool === 'razor') {
      canvas.style.cursor = 'crosshair';
      return;
    }

    const hit = hitTestItem(e.clientX, e.clientY);
    if (hit) {
      canvas.style.cursor = hit.edge === 'left' || hit.edge === 'right' ? 'col-resize' : 'grab';
    } else {
      canvas.style.cursor = 'pointer';
    }
  }, [isDragging, getTimeFromX, hitTestItem, activeTool, spaceHeld]);

  const onPointerLeave = useCallback(() => setHoverTime(null), []);

  // ── Zoom via Ctrl+Wheel ────────────────────────────────────────────────────
  const onWheel = useCallback((e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom(zoom + delta);
    } else {
      setScrollX(scrollX + e.deltaX + (e.shiftKey ? e.deltaY : 0));
    }
  }, [zoom, scrollX, setZoom, setScrollX]);

  // ── Drop from media library ────────────────────────────────────────────────
  const onDrop = useCallback((e) => {
    e.preventDefault();
    const data = e.dataTransfer.getData('application/x-clipai-media');
    if (!data) return;
    try {
      const media = JSON.parse(data);
      const time = getTimeFromX(e.clientX);
      const dropTrack = getTrackFromY(e.clientY);
      if (!dropTrack) return;

      // Auto-route items to the correct track type if dropped on an incompatible track
      const itemType = media.type;
      const dropTrackType = dropTrack.type;
      let targetTrackId = dropTrack.id;

      const compatible =
        (itemType === 'video' && dropTrackType === 'video') ||
        (itemType === 'audio' && dropTrackType === 'audio') ||
        ((itemType === 'text' || itemType === 'shape' || itemType === 'image' || itemType === 'overlay') && dropTrackType === 'overlay') ||
        (itemType === 'subtitle' && dropTrackType === 'subtitle');

      if (!compatible) {
        // Find the first compatible track
        const compatTrack = tracks.find((t) => {
          if (itemType === 'video') return t.type === 'video';
          if (itemType === 'audio') return t.type === 'audio';
          if (itemType === 'text' || itemType === 'shape' || itemType === 'image' || itemType === 'overlay') return t.type === 'overlay';
          if (itemType === 'subtitle') return t.type === 'subtitle';
          return false;
        });
        if (compatTrack) targetTrackId = compatTrack.id;
      }

      addItem({
        trackId: targetTrackId,
        type: media.type,
        mediaRef: media.id,
        start: time,
        end: time + (media.duration || 5),
      });
    } catch { /* invalid data */ }
  }, [getTimeFromX, getTrackFromY, addItem, tracks]);

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
        if (item) useTimelineStore.getState().duplicateItem(item.id);
        break;
    }
    setContextMenu(null);
  }, [contextMenu, splitItem, removeItem]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  // ── Compute canvas height ──────────────────────────────────────────────────
  const visibleTracks = tracks.filter((t) => t.visible !== false);
  const canvasHeight = RULER_HEIGHT + visibleTracks.length * (TRACK_HEIGHT + TRACK_GAP) + 12;

  return (
    <div ref={containerRef} className="ve-multi-timeline" style={{ position: 'relative', height: '100%' }}>
      {/* Toolbar row */}
      <div className="ve-multi-timeline__toolbar">
        <button
          className="ve-btn"
          onClick={() => setZoom(Math.max(0.01, zoom - 0.2))}
          title="Zoom out"
          style={{ fontSize: 12, padding: '2px 6px', minWidth: 24, minHeight: 24 }}
        >
          -
        </button>
        <input
          type="range"
          min="0.01"
          max="10"
          step="0.01"
          value={zoom}
          onChange={(e) => setZoom(parseFloat(e.target.value))}
          className="ve-multi-timeline__zoom-slider"
        />
        <button
          className="ve-btn"
          onClick={() => setZoom(Math.min(10, zoom + 0.2))}
          title="Zoom in"
          style={{ fontSize: 12, padding: '2px 6px', minWidth: 24, minHeight: 24 }}
        >
          +
        </button>
        <button
          className="ve-btn"
          onClick={() => {
            // Fit entire duration in view
            const canvas = canvasRef.current;
            if (canvas && duration > 0) {
              const availableWidth = canvas.getBoundingClientRect().width - LABEL_WIDTH;
              const fitZoom = Math.max(0.01, availableWidth / (duration * basePPS));
              setZoom(fitZoom);
              setScrollX(0);
            }
          }}
          title="Fit entire video in view"
          style={{ fontSize: 10, padding: '2px 8px', minWidth: 'auto', minHeight: 24, fontWeight: 600 }}
        >
          Fit
        </button>
        <button
          className={`ve-btn${snapEnabled ? ' ve-btn--active-snap' : ''}`}
          onClick={toggleSnap}
          title={`Snap: ${snapEnabled ? 'ON' : 'OFF'} (N)`}
          style={{ fontSize: 10, padding: '2px 6px', minWidth: 'auto', minHeight: 24 }}
        >
          Snap {snapEnabled ? 'ON' : 'OFF'}
        </button>
        <div style={{ flex: 1 }} />
        <div style={{ position: 'relative' }}>
          <button
            className="ve-btn"
            onClick={() => setShowAddTrack(!showAddTrack)}
            style={{ fontSize: 10, padding: '2px 8px', minHeight: 24 }}
          >
            + Track
          </button>
          {showAddTrack && (
            <div className="ve-multi-timeline__add-track-dropdown">
              {['video', 'audio', 'overlay', 'subtitle'].map(type => (
                <button
                  key={type}
                  onClick={() => { addTrack(type); setShowAddTrack(false); }}
                  className="ve-multi-timeline__add-track-option"
                >
                  {TRACK_ICONS[type]} {type.charAt(0).toUpperCase() + type.slice(1)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        className="ve-multi-timeline__canvas"
        style={{ width: '100%', height: Math.max(canvasHeight, 280) }}
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
          {contextMenu.item ? (
            <>
              <button onClick={() => handleContextAction('split')}>Split at cursor</button>
              <button onClick={() => handleContextAction('delete')}>Delete</button>
              <button onClick={() => handleContextAction('duplicate')}>Duplicate</button>
            </>
          ) : (
            <div style={{ padding: '4px 8px', fontSize: 10, color: 'var(--ve-text-muted)' }}>
              No item selected
            </div>
          )}
        </div>
      )}
    </div>
  );
}
