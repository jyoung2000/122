import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import useTimelineStore from '../stores/timelineStore';

/**
 * InteractiveOverlay renders selectable, draggable, resizable, and rotatable
 * handles over overlay items (text, shape, image) in the video preview viewport.
 *
 * Props:
 *   currentTime  – playhead position (seconds, relative to clip start)
 *   clipStart    – absolute start of the clip
 *   containerRef – ref to the viewport container div
 *   onInteraction – callback(bool) to pause/resume play-on-click behavior
 */
export default function InteractiveOverlay({ currentTime = 0, clipStart = 0, containerRef, onInteraction }) {
  const items = useTimelineStore((s) => s.items);
  const selectedItemId = useTimelineStore((s) => s.selectedItemId);
  const setSelectedItemId = useTimelineStore((s) => s.setSelectedItemId);
  const updateItem = useTimelineStore((s) => s.updateItem);

  const absTime = clipStart + currentTime;

  // Filter to visible overlay items (text, shape, image, overlay) at current time.
  // Subtitle items are excluded — they are rendered by SubtitleOverlay (the "Subs On"
  // system) and edited via the timeline track + PropertiesPanel instead.
  const visible = useMemo(() => {
    return items.filter((it) => {
      if (it.type === 'video' || it.type === 'audio' || it.type === 'subtitle') return false;
      return absTime >= it.start && absTime < it.end;
    });
  }, [items, absTime]);

  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedItemId) || null,
    [items, selectedItemId],
  );

  // Deselect when clicking the overlay background (not on an item)
  // Let the click through to the viewport (togglePlay) by not stopping propagation
  const handleBackgroundClick = useCallback((e) => {
    if (e.target === e.currentTarget) {
      setSelectedItemId(null);
      // Don't stopPropagation – allow togglePlay to fire on the viewport
    }
  }, [setSelectedItemId]);

  if (visible.length === 0 && !selectedItem) return null;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 10,
        // Allow clicks through to items, but capture on items themselves
        pointerEvents: 'auto',
      }}
      onMouseDown={handleBackgroundClick}
    >
      {visible.map((item) => (
        <InteractiveElement
          key={item.id}
          item={item}
          isSelected={item.id === selectedItemId}
          containerRef={containerRef}
          onSelect={() => setSelectedItemId(item.id)}
          onUpdate={(updates) => updateItem(item.id, updates)}
          onInteraction={onInteraction}
        />
      ))}
    </div>
  );
}


// ── Corner / edge handle positions ────────────────────────────────
const HANDLES = [
  { id: 'nw', cursor: 'nwse-resize', x: 0, y: 0 },
  { id: 'ne', cursor: 'nesw-resize', x: 1, y: 0 },
  { id: 'sw', cursor: 'nesw-resize', x: 0, y: 1 },
  { id: 'se', cursor: 'nwse-resize', x: 1, y: 1 },
  { id: 'n',  cursor: 'ns-resize',   x: 0.5, y: 0 },
  { id: 's',  cursor: 'ns-resize',   x: 0.5, y: 1 },
  { id: 'w',  cursor: 'ew-resize',   x: 0, y: 0.5 },
  { id: 'e',  cursor: 'ew-resize',   x: 1, y: 0.5 },
];


function InteractiveElement({ item, isSelected, containerRef, onSelect, onUpdate, onInteraction }) {
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const editRef = useRef(null);
  const dragState = useRef(null);

  const pos = item.position || { x: 50, y: 50 };
  const size = item.size || { w: 30, h: 30 };
  const rotation = item.transform?.rotation || 0;

  // Text and subtitle don't use height in the same way
  const isText = item.type === 'text';
  const isSubtitle = item.type === 'subtitle';
  const isAutoHeight = isText || isSubtitle;

  // ── Get container dimensions ──
  const getContainerRect = useCallback(() => {
    if (containerRef?.current) {
      return containerRef.current.getBoundingClientRect();
    }
    return { width: 1, height: 1, left: 0, top: 0 };
  }, [containerRef]);

  // ── DRAG ──────────────────────────────────────────────
  const handleDragStart = useCallback((e) => {
    e.stopPropagation();
    e.preventDefault();
    onSelect();
    onInteraction?.(true);

    const rect = getContainerRect();
    dragState.current = {
      type: 'drag',
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startPosX: pos.x,
      startPosY: pos.y,
      containerW: rect.width,
      containerH: rect.height,
    };
    setIsDragging(true);
  }, [pos, getContainerRect, onSelect, onInteraction]);

  // ── RESIZE ────────────────────────────────────────────
  const handleResizeStart = useCallback((e, handleId) => {
    e.stopPropagation();
    e.preventDefault();
    onInteraction?.(true);

    const rect = getContainerRect();
    dragState.current = {
      type: 'resize',
      handle: handleId,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startPosX: pos.x,
      startPosY: pos.y,
      startW: size.w,
      startH: size.h,
      containerW: rect.width,
      containerH: rect.height,
    };
    setIsResizing(true);
  }, [pos, size, getContainerRect, onInteraction]);

  // ── ROTATE ────────────────────────────────────────────
  const handleRotateStart = useCallback((e) => {
    e.stopPropagation();
    e.preventDefault();
    onInteraction?.(true);

    const rect = getContainerRect();
    // Center of the element in viewport coordinates
    const centerX = rect.left + (pos.x / 100) * rect.width;
    const centerY = rect.top + (pos.y / 100) * rect.height;

    dragState.current = {
      type: 'rotate',
      centerX,
      centerY,
      startAngle: Math.atan2(e.clientY - centerY, e.clientX - centerX) * (180 / Math.PI),
      startRotation: rotation,
    };
    setIsRotating(true);
  }, [pos, rotation, getContainerRect, onInteraction]);

  // ── Mouse move / up handlers ──────────────────────────
  useEffect(() => {
    if (!isDragging && !isResizing && !isRotating) return;

    const handleMouseMove = (e) => {
      const ds = dragState.current;
      if (!ds) return;

      if (ds.type === 'drag') {
        const dx = e.clientX - ds.startMouseX;
        const dy = e.clientY - ds.startMouseY;
        const newX = ds.startPosX + (dx / ds.containerW) * 100;
        const newY = ds.startPosY + (dy / ds.containerH) * 100;
        onUpdate({
          position: {
            x: Math.max(0, Math.min(100, Math.round(newX * 10) / 10)),
            y: Math.max(0, Math.min(100, Math.round(newY * 10) / 10)),
          },
        });
      }

      if (ds.type === 'resize') {
        const dx = ((e.clientX - ds.startMouseX) / ds.containerW) * 100;
        const dy = ((e.clientY - ds.startMouseY) / ds.containerH) * 100;
        const h = ds.handle;

        let newX = ds.startPosX;
        let newY = ds.startPosY;
        let newW = ds.startW;
        let newH = ds.startH;

        // The position is center-based (translate -50%, -50%), so
        // left edge = pos.x - w/2, right edge = pos.x + w/2
        // When dragging a corner/edge, we adjust both pos and size.

        if (h.includes('e')) {
          // Right edge moves: increase width, shift center right
          newW = Math.max(2, ds.startW + dx);
          newX = ds.startPosX + dx / 2;
        }
        if (h.includes('w')) {
          // Left edge moves: decrease width, shift center left
          newW = Math.max(2, ds.startW - dx);
          newX = ds.startPosX + dx / 2;
        }
        if (h.includes('s')) {
          newH = Math.max(2, ds.startH + dy);
          newY = ds.startPosY + dy / 2;
        }
        if (h.includes('n')) {
          newH = Math.max(2, ds.startH - dy);
          newY = ds.startPosY + dy / 2;
        }

        // Shift key = lock aspect ratio
        if (e.shiftKey && ds.startW > 0 && ds.startH > 0) {
          const aspect = ds.startW / ds.startH;
          if (h === 'e' || h === 'w') {
            newH = newW / aspect;
          } else if (h === 'n' || h === 's') {
            newW = newH * aspect;
          } else {
            // Corner: constrain by whichever dimension changed more
            const dw = Math.abs(newW - ds.startW);
            const dh = Math.abs(newH - ds.startH);
            if (dw > dh) {
              newH = newW / aspect;
            } else {
              newW = newH * aspect;
            }
          }
        }

        onUpdate({
          position: {
            x: Math.round(newX * 10) / 10,
            y: Math.round(newY * 10) / 10,
          },
          size: {
            w: Math.round(Math.max(2, newW) * 10) / 10,
            h: Math.round(Math.max(2, newH) * 10) / 10,
          },
        });
      }

      if (ds.type === 'rotate') {
        const angle = Math.atan2(e.clientY - ds.centerY, e.clientX - ds.centerX) * (180 / Math.PI);
        let newRotation = ds.startRotation + (angle - ds.startAngle);

        // Snap to 0/90/180/270 when within 5 degrees
        if (e.shiftKey) {
          newRotation = Math.round(newRotation / 15) * 15;
        }
        // Normalize to -360..360
        newRotation = ((newRotation % 360) + 360) % 360;
        if (newRotation > 180) newRotation -= 360;

        onUpdate({
          transform: { ...(item.transform || {}), rotation: Math.round(newRotation) },
        });
      }
    };

    const handleMouseUp = () => {
      dragState.current = null;
      setIsDragging(false);
      setIsResizing(false);
      setIsRotating(false);
      // Delay clearing interaction flag so the viewport's onClick
      // (which fires after mouseup) doesn't trigger togglePlay
      setTimeout(() => onInteraction?.(false), 100);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, isResizing, isRotating, item, onUpdate, onInteraction]);

  // ── Click to select ───────────────────────────────────
  const handleClick = useCallback((e) => {
    e.stopPropagation();
    onSelect();
  }, [onSelect]);

  // ── Double-click to edit text/subtitle ────────────────
  const handleDoubleClick = useCallback((e) => {
    e.stopPropagation();
    if (item.type === 'text' || item.type === 'subtitle') {
      setIsEditing(true);
      onInteraction?.(true);
      // Focus the input after render
      setTimeout(() => editRef.current?.focus(), 50);
    }
  }, [item.type, onInteraction]);

  const handleEditBlur = useCallback(() => {
    setIsEditing(false);
    onInteraction?.(false);
  }, [onInteraction]);

  const handleEditChange = useCallback((e) => {
    const val = e.target.value;
    if (item.type === 'text') {
      onUpdate({ textContent: val });
    } else if (item.type === 'subtitle') {
      onUpdate({ subtitleText: val });
    }
  }, [item.type, onUpdate]);

  const handleEditKeyDown = useCallback((e) => {
    e.stopPropagation(); // prevent keyboard shortcuts
    if (e.key === 'Escape') {
      setIsEditing(false);
      onInteraction?.(false);
    }
  }, [onInteraction]);

  // Determine the bounding box style.
  // Elements use percentage-based position (center) and size.
  const boxStyle = {
    position: 'absolute',
    left: `${pos.x}%`,
    top: `${pos.y}%`,
    width: `${size.w}%`,
    height: isAutoHeight ? 'auto' : `${size.h}%`,
    transform: `translate(-50%, -50%) ${rotation ? `rotate(${rotation}deg)` : ''}`,
    cursor: isDragging ? 'grabbing' : 'grab',
    // Make hitbox slightly bigger for small elements
    minWidth: 20,
    minHeight: 20,
    zIndex: isSelected ? 20 : 10,
  };

  const isActive = isDragging || isResizing || isRotating;

  return (
    <div
      style={boxStyle}
      onMouseDown={isEditing ? undefined : handleDragStart}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Invisible hit area matching the element */}
      <div style={{
        position: 'absolute',
        inset: -4,
        borderRadius: 2,
      }} />

      {/* Inline text editing */}
      {isEditing && (item.type === 'text' || item.type === 'subtitle') && (
        <textarea
          ref={editRef}
          value={item.type === 'text' ? (item.textContent || '') : (item.subtitleText || '')}
          onChange={handleEditChange}
          onBlur={handleEditBlur}
          onKeyDown={handleEditKeyDown}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            minHeight: 40,
            background: 'rgba(0,0,0,0.6)',
            color: '#fff',
            border: '2px solid #0A84FF',
            borderRadius: 4,
            padding: '6px 8px',
            fontSize: 14,
            fontFamily: 'inherit',
            resize: 'none',
            outline: 'none',
            zIndex: 50,
            backdropFilter: 'blur(4px)',
          }}
        />
      )}

      {/* Hover outline (when not selected) */}
      {isHovered && !isSelected && (
        <div style={{
          position: 'absolute',
          inset: -1,
          border: '1px dashed rgba(10, 132, 255, 0.5)',
          borderRadius: 2,
          pointerEvents: 'none',
        }} />
      )}

      {/* Selection outline */}
      {isSelected && (
        <>
          {/* Dashed border */}
          <div style={{
            position: 'absolute',
            inset: -2,
            border: '2px solid #0A84FF',
            borderRadius: 2,
            pointerEvents: 'none',
            boxShadow: '0 0 0 1px rgba(10, 132, 255, 0.3)',
          }} />

          {/* Resize handles */}
          {HANDLES.map((h) => (
            <div
              key={h.id}
              style={{
                position: 'absolute',
                left: `${h.x * 100}%`,
                top: `${h.y * 100}%`,
                width: 10,
                height: 10,
                transform: 'translate(-50%, -50%)',
                background: '#fff',
                border: '2px solid #0A84FF',
                borderRadius: h.id.length === 2 ? 2 : '50%', // corners = square, edges = round
                cursor: h.cursor,
                zIndex: 30,
                boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
              }}
              onMouseDown={(e) => handleResizeStart(e, h.id)}
            />
          ))}

          {/* Rotation handle (above the element) */}
          <div style={{
            position: 'absolute',
            left: '50%',
            top: -32,
            transform: 'translateX(-50%)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            zIndex: 30,
          }}>
            {/* Stem line connecting to element */}
            <div style={{
              width: 1,
              height: 16,
              background: '#0A84FF',
              position: 'absolute',
              bottom: -16,
            }} />
            {/* Rotation circle handle */}
            <div
              style={{
                width: 16,
                height: 16,
                borderRadius: '50%',
                background: '#fff',
                border: '2px solid #0A84FF',
                cursor: 'grab',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
              }}
              onMouseDown={handleRotateStart}
              title="Rotate"
            >
              {/* Rotation icon */}
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="#0A84FF" strokeWidth="2">
                <path d="M14 8A6 6 0 1 1 8 2" strokeLinecap="round" />
                <path d="M8 0l3 2-3 2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </div>

          {/* Info badge showing position/size while dragging */}
          {isActive && (
            <div style={{
              position: 'absolute',
              left: '50%',
              bottom: -24,
              transform: 'translateX(-50%)',
              background: 'rgba(0,0,0,0.8)',
              color: '#fff',
              fontSize: 10,
              fontFamily: 'var(--ve-font-mono, monospace)',
              padding: '2px 6px',
              borderRadius: 3,
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              zIndex: 40,
              backdropFilter: 'blur(4px)',
            }}>
              {isDragging && `${pos.x.toFixed(1)}%, ${pos.y.toFixed(1)}%`}
              {isResizing && `${size.w.toFixed(1)}% x ${size.h.toFixed(1)}%`}
              {isRotating && `${rotation}°`}
            </div>
          )}
        </>
      )}
    </div>
  );
}
