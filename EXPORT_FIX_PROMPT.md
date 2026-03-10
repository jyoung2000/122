# Claude Code Opus 4.6 Prompt: Fix FFmpeg MP4 Export to Match Preview Player 1:1

## Context

This is a video editor web application with a React frontend and Python/FastAPI backend. The preview player uses a canvas-based `RenderEngine` that composites video, text, images, shapes, and subtitles in real-time. When the user exports, the server-side FFmpeg pipeline should produce an MP4 that looks **exactly** like the preview player. Currently, the exported MP4 looks and sounds **nothing** like the preview — this is the #1 bug to fix.

## Architecture Overview

### Preview Pipeline (works correctly)
- `frontend/src/engine/RenderEngine.js` — Canvas compositor, renders all item types (video, text, image, shape, subtitle) with effects, transforms, fades, opacity
- `frontend/src/engine/PlaybackEngine.js` — Master clock, media element sync, audio routing via Web Audio API
- `frontend/src/components/VideoPlayer.jsx` — Simple HTML5 video preview (used on ViralClips page)
- `frontend/src/stores/timelineStore.js` — Single source of truth for all timeline items (video, audio, text, image, shape, subtitle tracks)

### Export Pipeline (BROKEN)
- `frontend/src/components/ExportDialog.jsx` — Collects timeline items and sends export request to backend
- `frontend/src/hooks/useEncodingManager.jsx` — Manages export lifecycle, calls correct API endpoint
- `frontend/src/pages/ViralClips.jsx` — `handleExportClip()` builds export body and calls `encoding.startExport()`
- `backend/routers/clips.py` — `POST /api/jobs/{job_id}/export-clip` endpoint
- `backend/services/clip_exporter.py` — FFmpeg command builder (~4300 lines), builds filter chains
- `backend/models.py` — Pydantic models: `ExportRequest`, `VideoEffects`, `TextOverlay`, `ImageOverlay`

---

## CRITICAL BUGS TO FIX (Priority Order)

### BUG 1: ExportDialog sends to WRONG endpoint with WRONG payload format
**File:** `frontend/src/components/ExportDialog.jsx` lines 86-191

When `onServerExport` is `null` (which it always is — see `VideoEditor.jsx` line 3221), the ExportDialog falls through to a direct `fetch()`:
```javascript
fetch(`/api/export/${jobId}/${clipId}`, { ... })  // WRONG URL!
```

**Problems:**
- The correct endpoint is `/api/jobs/${jobId}/export-clip` (see `clips.py` line 94)
- The payload uses `startTime`/`endTime` instead of `start`/`end` (ExportRequest model expects `start`/`end`)
- The payload uses `quality` (preset ID like "1080p") instead of `export_quality`
- The payload is missing `clip_id` field
- The `...(settings || {})` spread dumps raw frontend settings which don't match backend field names
- `.catch(() => {})` silently swallows all errors — user never sees the failure

**Fix:** Restructure the export payload to match the `ExportRequest` Pydantic model exactly:
```javascript
const exportPayload = {
  start: startTime,
  end: endTime,
  clip_id: clipId,
  export_quality: preset.id,
  aspect_ratio: aspectRatio || null,
  subtitles_enabled: Boolean(settings?.subtitlesEnabled),
  // ... properly mapped subtitle_settings, volume, speed, segments
  video_effects: { ... },  // already correctly structured
  text_overlays: [ ... ],  // already correctly structured
  image_overlays: [ ... ], // already correctly structured
};
```
And use the correct endpoint: `/api/jobs/${jobId}/export-clip`

Better yet, use the `useEncodingManager` hook's `startExport()` which already uses the correct endpoint. The ExportDialog should call `encoding.startExport()` instead of raw `fetch()`.

### BUG 2: ViralClips export path DROPS all multi-track editor state
**File:** `frontend/src/pages/ViralClips.jsx` lines 805-849

The `handleExportClip()` function builds the export body but **completely ignores** the multi-track timeline state. It only includes:
- Basic clip info (start, end, quality, aspect ratio)
- Subtitle settings
- Volume and speed

**Missing from ViralClips export:**
- `video_effects` (brightness, contrast, saturation, blur, hue, sepia, opacity, position, size, rotation, fades)
- `text_overlays` (all text items from timeline)
- `image_overlays` (all image/overlay items from timeline)
- Shape overlays (not supported at all)
- Audio track items (separate audio clips with their own volume)

**Fix:** Read the timeline store's `items` and package them into `video_effects`, `text_overlays`, and `image_overlays` — using the same logic that ExportDialog uses (lines 97-178). Extract this into a shared utility function like `buildExportPayloadFromTimeline(timelineItems, timelineMediaLibrary)` that both ExportDialog and ViralClips can use.

### BUG 3: Subtitle settings NOT properly mapped in ExportDialog
**File:** `frontend/src/components/ExportDialog.jsx` line 90

The export payload does `...(settings || {})` which spreads raw frontend settings. But the backend `ExportRequest` model expects specific field names in `subtitle_settings`:
- Frontend uses camelCase: `subtitleFont`, `subtitleSize`, `subtitleFontColor`, `subtitlePosition`, etc.
- Backend expects snake_case: `font`, `size`, `font_color`, `position`, etc.

Compare how ViralClips.jsx (lines 818-842) correctly maps these:
```javascript
subtitle_settings: {
  font: cs.subtitleFont || 'DM Sans',
  size: cs.subtitleSize ?? 30,
  font_weight: cs.subtitleFontWeight || 'bold',
  // ...
}
```

The ExportDialog does NOT do this mapping. The backend receives garbled field names and uses defaults for everything, which is why subtitles don't match.

**Fix:** ExportDialog must explicitly build `subtitle_settings` with proper field name mapping, matching what ViralClips does.

### BUG 4: Shape overlays completely missing from export
**Files:** `RenderEngine.js` (renders shapes), `ExportDialog.jsx` (doesn't collect shapes), `models.py` (no ShapeOverlay model), `clip_exporter.py` (no shape filter builder)

The preview renders rectangles, circles, ellipses, arrows, and lines via `_renderShape()`. But:
- ExportDialog never collects shape items from the timeline
- The backend has no `ShapeOverlay` model
- No FFmpeg filter builder for shapes

**Fix:**
1. Add `ShapeOverlay` model to `models.py` with fields: `shape_type`, `x`, `y`, `width`, `height`, `fill_color`, `stroke_color`, `stroke_width`, `corner_radius`, `start_time`, `end_time`, `rotation`, `opacity`, `fade_in`, `fade_out`
2. Add `shape_overlays: list[ShapeOverlay] = []` to `ExportRequest`
3. Build FFmpeg filter for shapes using `drawbox` (rectangles) and `overlay` with generated PNG images (circles, arrows)
4. Collect shape items in ExportDialog alongside text and image items

### BUG 5: Text overlay features missing/wrong in FFmpeg export
**File:** `backend/services/clip_exporter.py` `_build_text_overlay_filters()` (lines 3195-3257)

| Feature | Preview (RenderEngine) | FFmpeg Export | Match? |
|---------|----------------------|---------------|--------|
| Font weight (bold) | `ctx.font = '700 48px "DM Sans"'` | Not applied (drawtext uses fontfile only) | NO |
| Text rotation | `ctx.rotate()` | Not applied (drawtext has no rotation) | NO |
| Text animations | fade-in, typewriter, slide-up, pop, bounce | Not supported | NO |
| Background box | Proper bgColor, bgOpacity, bgPadding, bgRadius | `box=1:boxcolor={color}@0.5:boxborderw=5` (hardcoded opacity/padding) | NO |
| Text wrapping | `_wrapText()` with maxWidth | No wrapping in drawtext | NO |
| Text shadow | shadowBlur, shadowColor, shadowOffset | Not applied | NO |

**Fix for font weight:** Resolve bold font files separately (e.g., `DMSans-Bold.ttf` for weight ≥ 600). Add bold/italic font file variants to `_FONT_FAMILY_MAP`.

**Fix for text background:** Use actual bgOpacity value: `boxcolor={bg_color}@{opacity}:boxborderw={padding}` instead of hardcoded values.

**Fix for text rotation:** Use FFmpeg `rotate` filter on a per-text overlay basis — render text to a transparent canvas, rotate, then overlay. Or use ASS subtitle format for rotated text.

**Fix for text wrapping:** Either pre-wrap text into multiple `\n`-separated lines based on estimated character width, or use ASS subtitles which support line wrapping.

**Fix for text animations:** For fade-in/fade-out, the alpha expression already works. For typewriter, use `text=` expression with `if(lt(t,...))` to reveal characters over time. For slide-up, use `y=` expression that interpolates. Pop/bounce are visual-only and can be approximated with scale expressions.

### BUG 6: Image overlay rotation missing
**Files:** `models.py` `ImageOverlay` (no rotation field), `clip_exporter.py` `_build_image_overlay_data()` (no rotation)

The preview rotates images via `ctx.rotate()` in `_renderImage()`, but:
- `ImageOverlay` model has no `rotation` field
- `_build_image_overlay_data()` doesn't apply rotation
- ExportDialog doesn't send `rotation` for images

**Fix:**
1. Add `rotation: float = 0.0` to `ImageOverlay` model
2. In `_build_image_overlay_data()`, add `rotate` filter after scale: `,rotate={radians}:fillcolor=none:ow=rotw({radians}):oh=roth({radians})`
3. In ExportDialog, include `rotation: it.transform?.rotation || 0` in image overlay data

### BUG 7: Audio items from multi-track timeline not exported
The timeline can have separate audio clips (type 'audio') with their own volume settings. These are completely ignored during export — only the original video's audio track is processed.

**Fix:**
1. Collect audio items from timeline in ExportDialog (with volume, start/end times, fade in/out)
2. Add `audio_overlays` field to ExportRequest model
3. In FFmpeg, mix additional audio tracks using `amix` or `amerge` + per-track volume/timing

### BUG 8: Multiple video clips only get first item's effects
**File:** `frontend/src/components/ExportDialog.jsx` line 98

```javascript
const videoItem = timelineItems.find(it => it.type === 'video');  // Only FIRST video!
```

If the timeline has multiple video clips on different tracks, only the first one's effects/transforms get sent.

**Fix:** Collect effects for ALL video items and send them as an array, keyed by item ID or track position. The backend should apply per-clip effects accordingly.

---

## IMPLEMENTATION PLAN

### Phase 1: Fix the Export Pipeline Connection (Critical)
1. **Create shared utility** `frontend/src/utils/buildExportPayload.js`:
   - Extract timeline item collection logic from ExportDialog into a reusable function
   - Properly map all settings to backend field names (camelCase → snake_case)
   - Handle video_effects, text_overlays, image_overlays, subtitle_settings
   - Return a properly structured ExportRequest-compatible payload

2. **Fix ExportDialog.jsx**:
   - Import and use `useEncodingManager` hook instead of raw `fetch()`
   - Or fix the endpoint URL to `/api/jobs/${jobId}/export-clip` and payload format
   - Use `buildExportPayload()` utility for proper field mapping
   - Remove silent `.catch(() => {})` — show errors to the user

3. **Fix ViralClips.jsx `handleExportClip()`**:
   - Import `buildExportPayload()` utility
   - Read timeline store state for the clip being exported
   - Include video_effects, text_overlays, image_overlays in the export body

### Phase 2: Fix Backend FFmpeg Filters to Match Preview
4. **Fix text overlay filters** in `clip_exporter.py`:
   - Support font weight via bold font file resolution
   - Use actual background opacity/padding values instead of hardcoded ones
   - Add text shadow support via `shadowcolor`/`shadowx`/`shadowy` drawtext params

5. **Add image rotation** support:
   - Add `rotation` field to `ImageOverlay` model
   - Apply FFmpeg `rotate` filter in `_build_image_overlay_data()`

6. **Add shape overlay** support:
   - Create `ShapeOverlay` model
   - Build FFmpeg filter for shapes (drawbox for rectangles, overlay with generated images for circles)
   - Collect shapes from timeline in export payload

### Phase 3: Enhance QA Validation
7. **Update `subtitleQA.js`** validation:
   - Add checks for shape overlay export parity
   - Validate that text rotation/animation features generate warnings
   - Check that all timeline items have been included in the export payload
   - Add a "complete item audit" that compares timeline item count vs export payload item count

8. **Add backend export validation**:
   - Log all received vs expected overlay counts
   - Validate that video_effects values are within expected ranges
   - Add visual diff check: render a frame via backend and compare with expected output

---

## KEY FILES TO MODIFY

### Frontend
- `frontend/src/utils/buildExportPayload.js` — **NEW FILE**: Shared export payload builder
- `frontend/src/components/ExportDialog.jsx` — Fix endpoint, payload format, use encoding manager
- `frontend/src/components/VideoEditor.jsx` — Pass encoding manager to ExportDialog (or remove `onServerExport={null}`)
- `frontend/src/pages/ViralClips.jsx` — Include timeline state in export body
- `frontend/src/utils/subtitleQA.js` — Enhanced validation checks

### Backend
- `backend/models.py` — Add `ShapeOverlay`, add `rotation` to `ImageOverlay`, add `shape_overlays`/`audio_overlays` to `ExportRequest`
- `backend/services/clip_exporter.py` — Fix text overlay filters, add image rotation, add shape support
- `backend/routers/clips.py` — Pass new overlay types through to `export_clip()`

---

## TESTING CHECKLIST

After making changes, verify each of these scenarios produces an MP4 matching the preview:

1. **Basic video** — No effects, no overlays, just trim and export
2. **Video effects** — Apply brightness +30, contrast -20, saturation +50, verify export matches
3. **Video transform** — Move video to position (30%, 70%), resize to 80%, rotate 15°, verify export
4. **Text overlay** — Add text "Hello World" at center with bold font, red color, verify export
5. **Text with background** — Text with bgColor=#000, bgOpacity=80, verify export
6. **Image overlay** — Add image at (25%, 25%) with 50% size, verify position matches preview
7. **Image with rotation** — Rotate image overlay 45°, verify export
8. **Shape overlay** — Add rectangle and circle, verify they appear in export
9. **Subtitle burn-in** — Enable subtitles with custom font/color/position, verify export
10. **Active word highlighting** — Enable with custom colors, verify word-by-word highlight timing matches
11. **Multiple overlays** — Combine text + image + shape + subtitle, all at once
12. **Audio volume** — Set video volume to 0.5, verify export audio is quieter
13. **Speed change** — Set 0.5x speed, verify export is slower and audio pitch matches
14. **Fade in/out** — Apply 1s fade in + 2s fade out on video, verify export
15. **Aspect ratio crop** — Export 16:9 source as 9:16, verify subject centering matches preview

## IMPORTANT CONSTRAINTS

- Do NOT break the existing ViralClips export flow — it must continue to work for basic exports
- Do NOT modify the RenderEngine or PlaybackEngine — they work correctly for preview
- The backend FFmpeg filter chain ordering matters — effects must be applied AFTER crop/scale but BEFORE subtitle burn-in
- All text overlay timing is RELATIVE to clip start — the frontend sends absolute times, the backend must subtract clip_start
- Image overlay paths must be resolved via `_resolve_image_path()` — don't pass raw URLs to FFmpeg
- Keep the QA validation in ExportDialog — it should still block exports with errors
- Maintain backward compatibility — old export requests without new fields should still work
