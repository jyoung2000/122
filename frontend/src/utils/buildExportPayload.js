/**
 * Shared utility to build a properly structured export payload
 * that matches the backend ExportRequest Pydantic model exactly.
 *
 * Used by both ExportDialog and ViralClips to ensure the exported
 * MP4 matches the preview player 1:1.
 */

/**
 * Build video_effects object from a video timeline item.
 * @param {Object} videoItem - Timeline item of type 'video'
 * @returns {Object|null} - VideoEffects payload or null if no effects
 */
function buildVideoEffects(videoItem) {
  if (!videoItem) return null;

  const fx = videoItem.effects || {};
  const pos = videoItem.position || {};
  const sz = videoItem.size || {};
  const rot = videoItem.transform?.rotation || 0;
  const fadeIn = videoItem.fadeIn || 0;
  const fadeOut = videoItem.fadeOut || 0;

  const hasEffects =
    (fx.brightness || 0) !== 0 ||
    (fx.contrast || 0) !== 0 ||
    (fx.saturation || 0) !== 0 ||
    (fx.blur || 0) > 0 ||
    (fx.hueRotate || 0) > 0 ||
    (fx.sepia || 0) > 0 ||
    (videoItem.opacity ?? 1) < 1;

  const hasTransform =
    (pos.x != null && pos.x !== 50) ||
    (pos.y != null && pos.y !== 50) ||
    (sz.w != null && sz.w !== 100) ||
    (sz.h != null && sz.h !== 100) ||
    rot !== 0 ||
    fadeIn > 0 ||
    fadeOut > 0;

  if (!hasEffects && !hasTransform) return null;

  return {
    brightness: fx.brightness || 0,
    contrast: fx.contrast || 0,
    saturation: fx.saturation || 0,
    blur: fx.blur || 0,
    hue_rotate: fx.hueRotate || 0,
    sepia: fx.sepia || 0,
    opacity: videoItem.opacity ?? 1,
    position_x: pos.x ?? 50,
    position_y: pos.y ?? 50,
    width: sz.w ?? 100,
    height: sz.h ?? 100,
    rotation: rot,
    fade_in: fadeIn,
    fade_out: fadeOut,
  };
}

/**
 * Build text_overlays array from timeline items.
 * @param {Array} items - All timeline items
 * @returns {Array} - TextOverlay payloads
 */
function buildTextOverlays(items) {
  return items
    .filter((it) => it.type === 'text')
    .map((it) => ({
      text: it.textContent || '',
      x: it.position?.x ?? 50,
      y: it.position?.y ?? 50,
      font_size: it.textStyle?.fontSize || 48,
      font_color: it.textStyle?.color || '#FFFFFF',
      font_family: it.textStyle?.fontFamily || 'sans-serif',
      font_weight: it.textStyle?.fontWeight || 400,
      background_color: it.textStyle?.bgColor || null,
      background_opacity: it.textStyle?.bgOpacity ?? 50,
      background_padding: it.textStyle?.bgPadding ?? 5,
      outline_width: it.textStyle?.outlineWidth || 0,
      outline_color: it.textStyle?.outlineColor || '#000000',
      shadow_color: it.textStyle?.shadowColor || null,
      shadow_blur: it.textStyle?.shadowBlur || 0,
      shadow_offset_x: it.textStyle?.shadowOffsetX || 0,
      shadow_offset_y: it.textStyle?.shadowOffsetY || 0,
      start_time: it.start || 0,
      end_time: it.end || 0,
      rotation: it.transform?.rotation || 0,
      opacity: it.opacity ?? 1,
      fade_in: it.fadeIn || 0,
      fade_out: it.fadeOut || 0,
    }));
}

/**
 * Build image_overlays array from timeline items.
 * @param {Array} items - All timeline items
 * @param {Array} mediaLibrary - Media library entries for resolving mediaRef
 * @returns {Array} - ImageOverlay payloads
 */
function buildImageOverlays(items, mediaLibrary = []) {
  return items
    .filter((it) => it.type === 'image' || it.type === 'overlay')
    .map((it) => {
      let src = it.src || '';
      if (!src && it.mediaRef) {
        const mediaEntry = mediaLibrary.find((m) => m.id === it.mediaRef);
        src = mediaEntry?.url || it.mediaRef;
      }
      return {
        src,
        x: it.position?.x ?? 50,
        y: it.position?.y ?? 50,
        width: it.size?.w ?? 30,
        height: it.size?.h ?? 30,
        start_time: it.start || 0,
        end_time: it.end || 0,
        opacity: it.opacity ?? 1,
        fade_in: it.fadeIn || 0,
        fade_out: it.fadeOut || 0,
        rotation: it.transform?.rotation || 0,
      };
    });
}

/**
 * Build shape_overlays array from timeline items.
 * @param {Array} items - All timeline items
 * @returns {Array} - ShapeOverlay payloads
 */
function buildShapeOverlays(items) {
  return items
    .filter((it) => it.type === 'shape')
    .map((it) => {
      const style = it.shapeStyle || {};
      return {
        shape_type: it.shapeType || 'rectangle',
        x: it.position?.x ?? 50,
        y: it.position?.y ?? 50,
        width: it.size?.w ?? 20,
        height: it.size?.h ?? 20,
        fill_color: style.fillColor || null,
        stroke_color: style.strokeColor || '#FFFFFF',
        stroke_width: style.strokeWidth || 2,
        corner_radius: style.cornerRadius || 0,
        start_time: it.start || 0,
        end_time: it.end || 0,
        rotation: it.transform?.rotation || 0,
        opacity: it.opacity ?? 1,
        fade_in: it.fadeIn || 0,
        fade_out: it.fadeOut || 0,
      };
    });
}

/**
 * Build subtitle_settings object from frontend clip settings (camelCase → snake_case).
 * @param {Object} cs - Clip settings (frontend camelCase format)
 * @returns {Object} - SubtitleSettings payload matching backend model
 */
function buildSubtitleSettings(cs) {
  return {
    font: cs.subtitleFont || 'DM Sans',
    size: cs.subtitleSize ?? 30,
    font_weight: cs.subtitleFontWeight || 'bold',
    font_color: cs.subtitleFontColor || '#FFFFFF',
    position: cs.subtitlePosition || 'bottom',
    speaker_colors: cs.speakerColors || {},
    use_speaker_colors: cs.useSpeakerColors ?? true,
    background_enabled: cs.subtitleBgEnabled ?? false,
    background_color: cs.subtitleBgColor || '#000000',
    background_opacity: cs.subtitleBgOpacity ?? 75,
    background_radius: cs.subtitleBgRadius ?? 0,
    outline_color: cs.subtitleOutlineColor || '#000000',
    outline_opacity: cs.subtitleOutlineOpacity ?? 100,
    outline_width: cs.subtitleOutlineWidth ?? 2,
    show_speaker_labels: cs.showSpeakerLabels ?? false,
    max_width: cs.subtitleMaxWidth ?? 90,
    offset_v: cs.subtitleOffsetV ?? 4,
    max_words: cs.subtitleMaxWords ?? 0,
    active_word_enabled: cs.activeWordEnabled ?? false,
    active_word_color: cs.activeWordColor || '#FFD700',
    active_word_outline_color: cs.activeWordOutlineColor || '#000000',
    active_word_bg_color: cs.activeWordBgColor || '#000000',
    active_word_bg_opacity: cs.activeWordBgOpacity ?? 0,
  };
}

/**
 * Build the full export payload from timeline state and settings.
 * Produces a payload matching the backend ExportRequest Pydantic model.
 *
 * @param {Object} opts
 * @param {number} opts.startTime - Clip start time
 * @param {number} opts.endTime - Clip end time
 * @param {number} opts.clipId - Clip ID
 * @param {string} [opts.clipTitle] - Clip title
 * @param {string} opts.exportQuality - Quality preset ID ('720p', '1080p', etc.)
 * @param {string|null} [opts.aspectRatio] - Aspect ratio
 * @param {Object} [opts.settings] - Frontend clip settings (camelCase)
 * @param {Array} [opts.timelineItems] - Timeline items from store
 * @param {Array} [opts.mediaLibrary] - Media library for resolving image refs
 * @param {Array} [opts.segments] - Per-segment settings
 * @returns {Object} - ExportRequest-compatible payload
 */
export function buildExportPayload({
  startTime,
  endTime,
  clipId,
  clipTitle,
  exportQuality = '1080p',
  aspectRatio = null,
  settings = {},
  timelineItems = [],
  mediaLibrary = [],
  segments = [],
}) {
  const payload = {
    start: startTime,
    end: endTime,
    clip_id: clipId,
    export_quality: exportQuality,
  };

  if (clipTitle) payload.clip_title = clipTitle;
  if (aspectRatio) payload.aspect_ratio = aspectRatio;

  // Subtitle settings
  payload.subtitles_enabled = Boolean(settings.subtitlesEnabled);
  if (settings.subtitlesEnabled) {
    payload.subtitle_settings = buildSubtitleSettings(settings);
  }

  // Volume and speed
  if (settings.playbackVolume != null && settings.playbackVolume !== 100) {
    payload.volume = settings.playbackVolume / 100;
  }
  if (settings.playbackSpeed != null && settings.playbackSpeed !== 1.0) {
    payload.speed = settings.playbackSpeed;
  }

  // Segments
  if (segments && segments.length > 0) {
    payload.segments = segments;
  }

  // Video effects from timeline
  const videoItem = timelineItems.find((it) => it.type === 'video');
  const videoEffects = buildVideoEffects(videoItem);
  if (videoEffects) {
    payload.video_effects = videoEffects;
  }

  // Text overlays
  const textOverlays = buildTextOverlays(timelineItems);
  if (textOverlays.length > 0) {
    payload.text_overlays = textOverlays;
  }

  // Image overlays
  const imageOverlays = buildImageOverlays(timelineItems, mediaLibrary);
  if (imageOverlays.length > 0) {
    payload.image_overlays = imageOverlays;
  }

  // Shape overlays
  const shapeOverlays = buildShapeOverlays(timelineItems);
  if (shapeOverlays.length > 0) {
    payload.shape_overlays = shapeOverlays;
  }

  return payload;
}

export {
  buildVideoEffects,
  buildTextOverlays,
  buildImageOverlays,
  buildShapeOverlays,
  buildSubtitleSettings,
};
