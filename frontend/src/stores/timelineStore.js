import { create } from 'zustand';

// ── Default track setup ─────────────────────────────────────────────────────
const createDefaultTracks = () => [
  { id: 'v1', type: 'video', name: 'Video', muted: false, locked: false, visible: true },
  { id: 'v2', type: 'overlay', name: 'Overlay', muted: false, locked: false, visible: true },
  { id: 'a1', type: 'audio', name: 'Audio', muted: false, locked: false, visible: true },
  { id: 'a2', type: 'audio', name: 'Music', muted: false, locked: false, visible: true },
  { id: 't1', type: 'subtitle', name: 'Subtitles', muted: false, locked: false, visible: true },
];

let _itemIdCounter = 1;
const nextItemId = () => `item-${_itemIdCounter++}`;
const nextMediaId = () => `media-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

// ── Store ────────────────────────────────────────────────────────────────────
const useTimelineStore = create((set, get) => ({
  // Timeline data
  tracks: createDefaultTracks(),
  items: [],
  mediaLibrary: [],

  // Playback state
  playhead: 0,
  duration: 0,
  zoom: 1.0, // pixels per second multiplier
  snapEnabled: true,
  selectedItemId: null,
  isPlaying: false,

  // Undo / redo
  undoStack: [],
  redoStack: [],

  // ── Actions ────────────────────────────────────────

  // Snapshot current state for undo
  _snapshot: () => {
    const { tracks, items } = get();
    const snapshot = JSON.parse(JSON.stringify({ tracks, items }));
    set((s) => ({
      undoStack: [...s.undoStack.slice(-99), snapshot],
      redoStack: [],
    }));
  },

  undo: () => {
    const { undoStack, tracks, items } = get();
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    const current = JSON.parse(JSON.stringify({ tracks, items }));
    set({
      tracks: prev.tracks,
      items: prev.items,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...get().redoStack, current],
    });
  },

  redo: () => {
    const { redoStack, tracks, items } = get();
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    const current = JSON.parse(JSON.stringify({ tracks, items }));
    set({
      tracks: next.tracks,
      items: next.items,
      redoStack: redoStack.slice(0, -1),
      undoStack: [...get().undoStack, current],
    });
  },

  // Playback
  setPlayhead: (t) => set({ playhead: t }),
  setIsPlaying: (v) => set({ isPlaying: v }),
  setDuration: (d) => set({ duration: d }),
  setZoom: (z) => set({ zoom: Math.max(0.1, Math.min(10, z)) }),
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
  setSelectedItemId: (id) => set({ selectedItemId: id }),

  // Track operations
  addTrack: (type, name) => {
    get()._snapshot();
    const id = `${type.charAt(0)}${get().tracks.length + 1}`;
    set((s) => ({
      tracks: [...s.tracks, { id, type, name: name || `${type} ${s.tracks.length + 1}`, muted: false, locked: false, visible: true }],
    }));
  },

  removeTrack: (trackId) => {
    get()._snapshot();
    set((s) => ({
      tracks: s.tracks.filter((t) => t.id !== trackId),
      items: s.items.filter((i) => i.trackId !== trackId),
    }));
  },

  updateTrack: (trackId, updates) => {
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, ...updates } : t)),
    }));
  },

  toggleTrackMute: (trackId) => {
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, muted: !t.muted } : t)),
    }));
  },

  toggleTrackLock: (trackId) => {
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, locked: !t.locked } : t)),
    }));
  },

  toggleTrackVisibility: (trackId) => {
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, visible: !t.visible } : t)),
    }));
  },

  // Item operations
  addItem: (item) => {
    get()._snapshot();
    const id = item.id || nextItemId();
    const newItem = {
      id,
      trackId: item.trackId || 'v1',
      type: item.type || 'video',
      mediaRef: item.mediaRef || null,
      start: item.start || 0,
      end: item.end || 0,
      trimStart: item.trimStart || 0,
      trimEnd: item.trimEnd || null,
      volume: item.volume ?? 1.0,
      speed: item.speed ?? 1.0,
      opacity: item.opacity ?? 1.0,
      position: item.position || { x: 0, y: 0 },
      size: item.size || { w: 100, h: 100 },
      effects: item.effects || [],
      fadeIn: item.fadeIn || 0,
      fadeOut: item.fadeOut || 0,
      subtitleText: item.subtitleText || null,
      subtitleStyle: item.subtitleStyle || null,
    };
    set((s) => ({
      items: [...s.items, newItem],
      duration: Math.max(s.duration, newItem.end),
    }));
    return id;
  },

  removeItem: (itemId) => {
    get()._snapshot();
    set((s) => ({
      items: s.items.filter((i) => i.id !== itemId),
      selectedItemId: s.selectedItemId === itemId ? null : s.selectedItemId,
    }));
  },

  updateItem: (itemId, updates) => {
    set((s) => ({
      items: s.items.map((i) => (i.id === itemId ? { ...i, ...updates } : i)),
    }));
  },

  updateItemWithSnapshot: (itemId, updates) => {
    get()._snapshot();
    set((s) => ({
      items: s.items.map((i) => (i.id === itemId ? { ...i, ...updates } : i)),
    }));
  },

  splitItem: (itemId, time) => {
    get()._snapshot();
    const item = get().items.find((i) => i.id === itemId);
    if (!item || time <= item.start || time >= item.end) return;
    const item1 = { ...item, end: time };
    const item2Id = nextItemId();
    const offset = time - item.start;
    const item2 = {
      ...item,
      id: item2Id,
      start: time,
      trimStart: (item.trimStart || 0) + offset,
    };
    set((s) => ({
      items: s.items.map((i) => (i.id === itemId ? item1 : i)).concat(item2),
      selectedItemId: item2Id,
    }));
  },

  duplicateItem: (itemId) => {
    get()._snapshot();
    const item = get().items.find((i) => i.id === itemId);
    if (!item) return;
    const dur = item.end - item.start;
    const newId = nextItemId();
    set((s) => ({
      items: [...s.items, { ...item, id: newId, start: item.end, end: item.end + dur }],
      selectedItemId: newId,
    }));
  },

  // Media library
  addMedia: (media) => {
    const id = media.id || nextMediaId();
    const entry = {
      id,
      type: media.type || 'video',
      filename: media.filename || 'untitled',
      duration: media.duration || 0,
      url: media.url || '',
      thumbnailUrl: media.thumbnailUrl || '',
      waveformData: media.waveformData || [],
    };
    set((s) => ({ mediaLibrary: [...s.mediaLibrary, entry] }));
    return id;
  },

  removeMedia: (mediaId) => {
    set((s) => ({
      mediaLibrary: s.mediaLibrary.filter((m) => m.id !== mediaId),
      items: s.items.filter((i) => i.mediaRef !== mediaId),
    }));
  },

  // Initialize timeline with clip data
  initFromClip: (clipData) => {
    const { src, clipStart, clipEnd, subtitleSegments } = clipData;
    const duration = clipEnd - clipStart;

    const baseMediaId = nextMediaId();
    const mediaLibrary = [
      { id: baseMediaId, type: 'video', filename: 'Source Video', duration, url: src, thumbnailUrl: '', waveformData: [] },
    ];

    const items = [
      {
        id: nextItemId(),
        trackId: 'v1',
        type: 'video',
        mediaRef: baseMediaId,
        start: 0,
        end: duration,
        trimStart: clipStart,
        trimEnd: clipEnd,
        volume: 1.0,
        speed: 1.0,
        opacity: 1.0,
        position: { x: 0, y: 0 },
        size: { w: 100, h: 100 },
        effects: [],
        fadeIn: 0,
        fadeOut: 0,
      },
      {
        id: nextItemId(),
        trackId: 'a1',
        type: 'audio',
        mediaRef: baseMediaId,
        start: 0,
        end: duration,
        trimStart: clipStart,
        trimEnd: clipEnd,
        volume: 1.0,
        speed: 1.0,
        opacity: 1.0,
        position: { x: 0, y: 0 },
        size: { w: 100, h: 100 },
        effects: [],
        fadeIn: 0,
        fadeOut: 0,
      },
    ];

    // Add subtitle items if provided
    if (Array.isArray(subtitleSegments)) {
      subtitleSegments.forEach((seg) => {
        if (seg.start >= clipStart && seg.end <= clipEnd) {
          items.push({
            id: nextItemId(),
            trackId: 't1',
            type: 'subtitle',
            mediaRef: null,
            start: seg.start - clipStart,
            end: seg.end - clipStart,
            trimStart: 0,
            trimEnd: null,
            volume: 1.0,
            speed: 1.0,
            opacity: 1.0,
            position: { x: 50, y: 90 },
            size: { w: 100, h: 100 },
            effects: [],
            fadeIn: 0,
            fadeOut: 0,
            subtitleText: seg.text,
            subtitleStyle: null,
          });
        }
      });
    }

    set({
      tracks: createDefaultTracks(),
      items,
      mediaLibrary,
      playhead: 0,
      duration,
      zoom: 1.0,
      selectedItemId: null,
      isPlaying: false,
      undoStack: [],
      redoStack: [],
    });
  },

  // Reset to defaults
  reset: () => {
    set({
      tracks: createDefaultTracks(),
      items: [],
      mediaLibrary: [],
      playhead: 0,
      duration: 0,
      zoom: 1.0,
      snapEnabled: true,
      selectedItemId: null,
      isPlaying: false,
      undoStack: [],
      redoStack: [],
    });
  },

  // Get items visible at a specific time
  getVisibleItems: (time) => {
    return get().items.filter((item) => time >= item.start && time < item.end);
  },

  // Get items on a specific track
  getTrackItems: (trackId) => {
    return get().items.filter((item) => item.trackId === trackId);
  },

  // Export state for persistence
  exportState: () => {
    const { tracks, items, mediaLibrary, duration } = get();
    return { tracks, items, mediaLibrary, duration };
  },

  // Import state from persistence
  importState: (state) => {
    if (state && state.tracks && state.items) {
      set({
        tracks: state.tracks,
        items: state.items,
        mediaLibrary: state.mediaLibrary || [],
        duration: state.duration || 0,
      });
    }
  },
}));

export default useTimelineStore;
