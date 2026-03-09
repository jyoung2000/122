import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { temporal } from 'zundo';

// ── Default track setup ─────────────────────────────────────────────────────
const createDefaultTracks = () => [
  { id: 'v1', type: 'video', name: 'Video', order: 0, muted: false, locked: false, visible: true },
  { id: 'v2', type: 'overlay', name: 'Overlay', order: 1, muted: false, locked: false, visible: true },
  { id: 'a1', type: 'audio', name: 'Audio', order: 2, muted: false, locked: false, visible: true },
  { id: 'a2', type: 'audio', name: 'Music', order: 3, muted: false, locked: false, visible: true },
  { id: 't1', type: 'subtitle', name: 'Subtitles', order: 4, muted: false, locked: false, visible: true },
];

// Track-item type compatibility map
// Defines which item types are allowed on each track type
export const TRACK_ALLOWED_TYPES = {
  video: ['video'],
  overlay: ['text', 'shape', 'image', 'overlay'],
  audio: ['audio'],
  subtitle: ['subtitle'],
};

// Check if an item type is compatible with a track type
function isTrackCompatible(itemType, trackType) {
  const allowed = TRACK_ALLOWED_TYPES[trackType];
  return allowed ? allowed.includes(itemType) : false;
}

// Find the first compatible track for an item type
function findCompatibleTrack(tracks, itemType) {
  return tracks.find((t) => isTrackCompatible(itemType, t.type)) || null;
}

let _itemIdCounter = 1;
const nextItemId = () => `item-${_itemIdCounter++}`;
const nextMediaId = () => `media-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

// ── Store with Immer + Zundo ────────────────────────────────────────────────
const useTimelineStore = create(
  temporal(
    immer((set, get) => ({
      // ── Project settings ──
      project: {
        name: 'Untitled',
        resolution: { w: 1920, h: 1080 },
        fps: 30,
        aspectRatio: null,
        backgroundColor: '#000000',
      },

      // ── Timeline data ──
      tracks: createDefaultTracks(),
      items: [],
      mediaLibrary: [],

      // ── Playback state (not tracked by undo) ──
      playhead: 0,
      duration: 0,
      zoom: 1.0,
      scrollX: 0,
      snapEnabled: true,
      selectedItemId: null,
      selectedItemIds: [],
      isPlaying: false,

      // ── Selection & tools ──
      activeTool: 'select', // 'select' | 'razor' | 'text' | 'shape'
      activePanel: 'properties', // 'properties' | 'effects' | 'media'

      // ── Segments (backward compat with VideoEditor segment-based editing) ──
      segments: [],
      selectedSegmentId: null,

      // ── Clip settings (merged from VideoEditor useState) ──
      volume: 100,
      speed: 1.0,
      isMuted: false,
      trimStartOffset: 0,
      trimEndOffset: 0,

      // ── Subtitle settings (from ClipSettingsPanel) ──
      subtitleSettings: {},

      // ── Actions ──

      // Project
      setProject: (updates) => set((state) => {
        Object.assign(state.project, updates);
      }),

      setResolution: (w, h) => set((state) => {
        state.project.resolution = { w, h };
      }),

      setAspectRatio: (ar) => set((state) => {
        state.project.aspectRatio = ar;
      }),

      // Playback (not tracked by undo)
      setPlayhead: (t) => set({ playhead: t }),
      setIsPlaying: (v) => set({ isPlaying: v }),
      setDuration: (d) => set({ duration: d }),
      setZoom: (z) => set({ zoom: Math.max(0.01, Math.min(10, z)) }),
      setScrollX: (x) => set({ scrollX: Math.max(0, x) }),
      toggleSnap: () => set((state) => { state.snapEnabled = !state.snapEnabled; }),
      setSelectedItemId: (id) => set({ selectedItemId: id, selectedItemIds: id ? [id] : [] }),
      setSelectedItemIds: (ids) => set({ selectedItemIds: ids, selectedItemId: ids[0] || null }),
      setActiveTool: (tool) => set({ activeTool: tool }),
      setActivePanel: (panel) => set({ activePanel: panel }),

      // Segment state (backward compat)
      setSegments: (segs) => set({ segments: segs }),
      setSelectedSegmentId: (id) => set({ selectedSegmentId: id }),
      setVolume: (v) => set({ volume: v }),
      setSpeed: (s) => set({ speed: s }),
      setIsMuted: (m) => set({ isMuted: m }),
      setTrimStartOffset: (o) => set({ trimStartOffset: o }),
      setTrimEndOffset: (o) => set({ trimEndOffset: o }),
      setSubtitleSettings: (s) => set({ subtitleSettings: s }),

      // Track operations
      addTrack: (type, name) => set((state) => {
        const id = `${type.charAt(0)}${state.tracks.length + 1}-${Date.now().toString(36)}`;
        state.tracks.push({
          id, type,
          name: name || `${type} ${state.tracks.length + 1}`,
          order: state.tracks.length,
          muted: false, locked: false, visible: true,
        });
      }),

      removeTrack: (trackId) => set((state) => {
        state.tracks = state.tracks.filter(t => t.id !== trackId);
        state.items = state.items.filter(i => i.trackId !== trackId);
      }),

      updateTrack: (trackId, updates) => set((state) => {
        const track = state.tracks.find(t => t.id === trackId);
        if (track) Object.assign(track, updates);
      }),

      toggleTrackMute: (trackId) => set((state) => {
        const track = state.tracks.find(t => t.id === trackId);
        if (track) track.muted = !track.muted;
      }),

      toggleTrackLock: (trackId) => set((state) => {
        const track = state.tracks.find(t => t.id === trackId);
        if (track) track.locked = !track.locked;
      }),

      toggleTrackVisibility: (trackId) => set((state) => {
        const track = state.tracks.find(t => t.id === trackId);
        if (track) track.visible = !track.visible;
      }),

      // Item operations
      addItem: (item) => {
        const id = item.id || nextItemId();
        // Auto-route to the correct track based on item type
        let trackId = item.trackId || 'v1';
        const itemType = item.type || 'video';
        const state = get();
        const track = state.tracks.find((t) => t.id === trackId);
        if (track) {
          if (track.locked || !isTrackCompatible(itemType, track.type)) {
            const correctTrack = findCompatibleTrack(state.tracks, itemType);
            if (correctTrack && !correctTrack.locked) trackId = correctTrack.id;
            else if (correctTrack?.locked) return null; // All compatible tracks are locked
          }
        }
        const newItem = {
          id,
          trackId,
          type: itemType,
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
          transform: item.transform || { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
          effects: item.effects || { brightness: 0, contrast: 0, saturation: 0, blur: 0, hueRotate: 0, sepia: 0 },
          fadeIn: item.fadeIn || 0,
          fadeOut: item.fadeOut || 0,
          transition: item.transition || null,
          subtitleText: item.subtitleText || null,
          subtitleStyle: item.subtitleStyle || null,
          speaker: item.speaker || null,
          words: item.words || null,
          textContent: item.textContent || null,
          textStyle: item.textStyle || null,
          shapeType: item.shapeType || null,
          shapeStyle: item.shapeStyle || null,
          subjectX: item.subjectX ?? 50,
        };
        set((state) => {
          state.items.push(newItem);
          state.duration = Math.max(state.duration, newItem.end);
        });
        return id;
      },

      removeItem: (itemId) => set((state) => {
        const item = state.items.find(i => i.id === itemId);
        if (item) {
          const track = state.tracks.find(t => t.id === item.trackId);
          if (track?.locked) return; // Cannot remove items from locked tracks
        }
        state.items = state.items.filter(i => i.id !== itemId);
        if (state.selectedItemId === itemId) {
          state.selectedItemId = null;
          state.selectedItemIds = [];
        }
      }),

      updateItem: (itemId, updates) => set((state) => {
        const item = state.items.find(i => i.id === itemId);
        if (!item) return;
        // Prevent modifications to items on locked tracks
        const currentTrack = state.tracks.find(t => t.id === item.trackId);
        if (currentTrack?.locked) return;
        // Validate track change: prevent moving items to incompatible tracks
        if (updates.trackId && updates.trackId !== item.trackId) {
          const targetTrack = state.tracks.find(t => t.id === updates.trackId);
          if (targetTrack && !isTrackCompatible(item.type, targetTrack.type)) {
            // Silently reject the track change — keep item on current track
            const { trackId, ...rest } = updates;
            Object.assign(item, rest);
            return;
          }
        }
        Object.assign(item, updates);
      }),

      updateItemWithSnapshot: (itemId, updates) => set((state) => {
        const item = state.items.find(i => i.id === itemId);
        if (item) Object.assign(item, updates);
      }),

      splitItem: (itemId, time) => set((state) => {
        const idx = state.items.findIndex(i => i.id === itemId);
        if (idx < 0) return;
        const item = state.items[idx];
        // Prevent splitting items on locked tracks
        const track = state.tracks.find(t => t.id === item.trackId);
        if (track?.locked) return;
        if (time <= item.start || time >= item.end) return;

        const newId = nextItemId();
        const offset = time - item.start;
        const item2 = {
          ...JSON.parse(JSON.stringify(item)),
          id: newId,
          start: time,
          trimStart: (item.trimStart || 0) + offset,
        };

        state.items[idx].end = time;
        state.items.push(item2);
        state.selectedItemId = newId;
        state.selectedItemIds = [newId];
      }),

      duplicateItem: (itemId) => set((state) => {
        const item = state.items.find(i => i.id === itemId);
        if (!item) return;
        const dur = item.end - item.start;
        const newId = nextItemId();
        const clone = {
          ...JSON.parse(JSON.stringify(item)),
          id: newId,
          start: item.end,
          end: item.end + dur,
        };
        state.items.push(clone);
        state.selectedItemId = newId;
        state.selectedItemIds = [newId];
      }),

      // Batch move items (for multi-select drag)
      moveItems: (itemIds, deltaTime, targetTrackId) => set((state) => {
        for (const id of itemIds) {
          const item = state.items.find(i => i.id === id);
          if (!item) continue;
          const dur = item.end - item.start;
          item.start = Math.max(0, item.start + deltaTime);
          item.end = item.start + dur;
          if (targetTrackId) item.trackId = targetTrackId;
        }
      }),

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
        set((state) => {
          state.mediaLibrary.push(entry);
        });
        return id;
      },

      updateMedia: (mediaId, updates) => set((state) => {
        const item = state.mediaLibrary.find(m => m.id === mediaId);
        if (item) Object.assign(item, updates);
      }),

      removeMedia: (mediaId) => set((state) => {
        state.mediaLibrary = state.mediaLibrary.filter(m => m.id !== mediaId);
        state.items = state.items.filter(i => i.mediaRef !== mediaId);
      }),

      removeMediaBatch: (mediaIds) => set((state) => {
        const idSet = new Set(mediaIds);
        state.mediaLibrary = state.mediaLibrary.filter(m => !idSet.has(m.id));
        state.items = state.items.filter(i => !idSet.has(i.mediaRef));
      }),

      // Initialize timeline with clip data (backward compat)
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
            position: { x: 50, y: 50 },
            size: { w: 100, h: 100 },
            transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
            effects: { brightness: 0, contrast: 0, saturation: 0, blur: 0, hueRotate: 0, sepia: 0 },
            fadeIn: 0,
            fadeOut: 0,
            transition: null,
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
            transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
            effects: {},
            fadeIn: 0,
            fadeOut: 0,
            transition: null,
          },
        ];

        // Add subtitle items if provided
        if (Array.isArray(subtitleSegments)) {
          subtitleSegments.forEach((seg) => {
            if (seg.end > clipStart && seg.start < clipEnd) {
              const clampedStart = Math.max(seg.start, clipStart);
              const clampedEnd = Math.min(seg.end, clipEnd);
              // Preserve word-level timestamps for accurate active word highlighting
              let segWords = null;
              if (seg.words && Array.isArray(seg.words)) {
                segWords = seg.words
                  .filter(w => w.end > clipStart && w.start < clipEnd)
                  .map(w => ({
                    ...w,
                    start: w.start - clipStart,
                    end: w.end - clipStart,
                  }));
              }
              items.push({
                id: nextItemId(),
                trackId: 't1',
                type: 'subtitle',
                mediaRef: null,
                start: clampedStart - clipStart,
                end: clampedEnd - clipStart,
                trimStart: 0,
                trimEnd: null,
                volume: 1.0,
                speed: 1.0,
                opacity: 1.0,
                position: { x: 50, y: 90 },
                size: { w: 100, h: 100 },
                transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
                effects: {},
                fadeIn: 0,
                fadeOut: 0,
                subtitleText: seg.text,
                subtitleStyle: null,
                speaker: seg.speaker || null,
                transition: null,
                words: segWords,
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
          scrollX: 0,
          selectedItemId: null,
          selectedItemIds: [],
          isPlaying: false,
          activeTool: 'select',
        });
      },

      // Reset to defaults
      reset: () => {
        set({
          project: {
            name: 'Untitled',
            resolution: { w: 1920, h: 1080 },
            fps: 30,
            aspectRatio: null,
            backgroundColor: '#000000',
          },
          tracks: createDefaultTracks(),
          items: [],
          mediaLibrary: [],
          playhead: 0,
          duration: 0,
          zoom: 1.0,
          scrollX: 0,
          snapEnabled: true,
          selectedItemId: null,
          selectedItemIds: [],
          isPlaying: false,
          activeTool: 'select',
          segments: [],
          selectedSegmentId: null,
          volume: 100,
          speed: 1.0,
          isMuted: false,
          trimStartOffset: 0,
          trimEndOffset: 0,
          subtitleSettings: {},
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
        const { tracks, items, mediaLibrary, duration, project, segments, subtitleSettings } = get();
        return { tracks, items, mediaLibrary, duration, project, segments, subtitleSettings };
      },

      // Import state from persistence
      importState: (state) => {
        if (state && state.tracks && state.items) {
          set({
            tracks: state.tracks,
            items: state.items,
            mediaLibrary: state.mediaLibrary || [],
            duration: state.duration || 0,
            project: state.project || { name: 'Untitled', resolution: { w: 1920, h: 1080 }, fps: 30, aspectRatio: null, backgroundColor: '#000000' },
            segments: state.segments || [],
            subtitleSettings: state.subtitleSettings || {},
          });
        }
      },
    })),
    {
      // Zundo temporal config
      limit: 100,
      // Only track undo-able state (exclude playback, UI transient state)
      partialize: (state) => ({
        tracks: state.tracks,
        items: state.items,
        project: state.project,
        segments: state.segments,
      }),
    }
  )
);

export default useTimelineStore;
