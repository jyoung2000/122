import { useEffect, useCallback, useRef } from 'react';
import useTimelineStore from '../stores/timelineStore';

/**
 * Centralized keyboard shortcut handling for the video editor.
 * Covers tool selection, transport controls, undo/redo, and clip manipulation.
 */
export default function useKeyboardShortcuts({
  enabled = true,
  onTogglePlay,
  onSeek,
  onSkipTime,
  onToggleMute,
  onShuttleSpeed,
} = {}) {
  const setActiveTool = useTimelineStore((s) => s.setActiveTool);
  const removeItem = useTimelineStore((s) => s.removeItem);
  const removeItems = useTimelineStore((s) => s.removeItems);
  const splitItem = useTimelineStore((s) => s.splitItem);

  // Arrow key hold-to-repeat state
  const arrowHoldRef = useRef({ key: null, interval: null });
  const onSkipTimeRef = useRef(onSkipTime);
  onSkipTimeRef.current = onSkipTime;

  const handleKeyDown = useCallback((e) => {
    if (!enabled) return;

    // Don't capture when typing in inputs/textareas/contenteditable
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.target.contentEditable === 'true') return;

    // Ctrl/Cmd shortcuts
    if (e.ctrlKey || e.metaKey) {
      switch (e.code) {
        case 'KeyZ':
          e.preventDefault();
          if (e.shiftKey) {
            useTimelineStore.temporal.getState().redo();
          } else {
            useTimelineStore.temporal.getState().undo();
          }
          return;
        case 'KeyY':
          e.preventDefault();
          useTimelineStore.temporal.getState().redo();
          return;
        case 'KeyS':
          e.preventDefault();
          // TODO: Project save
          return;
        case 'KeyA':
          e.preventDefault();
          // Read items from store at call time (not closure)
          const allIds = useTimelineStore.getState().items.map(i => i.id);
          useTimelineStore.getState().setSelectedItemIds(allIds);
          return;
        case 'KeyG': {
          e.preventDefault();
          const state = useTimelineStore.getState();
          const selIds = state.selectedItemIds;
          if (e.shiftKey) {
            // Ctrl+Shift+G: Ungroup selected items
            if (selIds.length > 0) {
              state.ungroupItems(selIds);
            }
          } else {
            // Ctrl+G: Toggle — ungroup if all selected share the same group, otherwise group
            if (selIds.length >= 2) {
              const selItems = selIds.map(id => state.items.find(i => i.id === id)).filter(Boolean);
              const firstGroupId = selItems[0]?.groupId;
              const allSameGroup = firstGroupId && selItems.every(i => i.groupId === firstGroupId);
              if (allSameGroup) {
                state.ungroupItems(selIds);
              } else {
                state.groupItems(selIds);
              }
            }
          }
          return;
        }
      }
    }

    switch (e.code) {
      // Transport
      case 'Space':
        e.preventDefault();
        onTogglePlay?.();
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        e.preventDefault();
        if (e.repeat) return; // handled by our own interval
        const dir = e.code === 'ArrowLeft' ? -1 : 1;
        const delta = e.shiftKey ? dir : dir / 30;
        onSkipTimeRef.current?.(delta);
        // Start hold-to-repeat interval
        const hold = arrowHoldRef.current;
        if (hold.interval) clearInterval(hold.interval);
        hold.key = e.code;
        hold.interval = setInterval(() => {
          onSkipTimeRef.current?.(delta);
        }, 1000 / 15); // 15 steps per second while held
        break;
      }

      // J/K/L shuttle
      case 'KeyJ':
        e.preventDefault();
        onShuttleSpeed?.('reverse');
        break;
      case 'KeyK':
        e.preventDefault();
        onShuttleSpeed?.('stop');
        break;
      case 'KeyL':
        e.preventDefault();
        onShuttleSpeed?.('forward');
        break;

      // Home/End
      case 'Home':
        e.preventDefault();
        onSeek?.(0);
        break;
      case 'End':
        e.preventDefault();
        onSeek?.(useTimelineStore.getState().duration);
        break;

      // Mute
      case 'KeyM':
        e.preventDefault();
        onToggleMute?.();
        break;

      // Tool selection
      case 'KeyV':
        e.preventDefault();
        setActiveTool('select');
        break;
      case 'KeyC':
        e.preventDefault();
        setActiveTool('razor');
        break;
      case 'KeyT':
        e.preventDefault();
        setActiveTool('text');
        break;
      case 'KeyR':
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          setActiveTool('shape');
        }
        break;

      // Snap toggle
      case 'KeyN':
        e.preventDefault();
        useTimelineStore.getState().toggleSnap();
        break;

      // Delete selected (supports multi-select) — single undo snapshot
      case 'Delete':
      case 'Backspace':
        if (!e.target.closest('[contenteditable]')) {
          const state = useTimelineStore.getState();
          const idsToDelete = state.selectedItemIds.length > 0
            ? state.selectedItemIds
            : (state.selectedItemId ? [state.selectedItemId] : []);
          if (idsToDelete.length > 0) {
            e.preventDefault();
            if (idsToDelete.length === 1) {
              removeItem(idsToDelete[0]);
            } else {
              removeItems(idsToDelete);
            }
          }
        }
        break;

      // Escape — deselect
      case 'Escape':
        e.preventDefault();
        useTimelineStore.getState().setSelectedItemId(null);
        break;

      // Split at playhead — read playhead and items from store at call time
      case 'KeyS':
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          const st = useTimelineStore.getState();
          const itemAtPlayhead = st.items.find(i =>
            st.playhead > i.start + 0.1 && st.playhead < i.end - 0.1 &&
            (i.type === 'video' || i.type === 'audio')
          );
          if (itemAtPlayhead) {
            splitItem(itemAtPlayhead.id, st.playhead);
          }
        }
        break;
    }
  }, [enabled, onTogglePlay, onSeek, onToggleMute, onShuttleSpeed,
      setActiveTool, removeItem, removeItems, splitItem]);

  const handleKeyUp = useCallback((e) => {
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      const hold = arrowHoldRef.current;
      if (hold.key === e.code && hold.interval) {
        clearInterval(hold.interval);
        hold.interval = null;
        hold.key = null;
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      const hold = arrowHoldRef.current;
      if (hold.interval) {
        clearInterval(hold.interval);
        hold.interval = null;
        hold.key = null;
      }
    };
  }, [enabled, handleKeyDown, handleKeyUp]);
}
