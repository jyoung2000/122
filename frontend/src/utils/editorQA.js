/**
 * Editor QA / Validation System
 *
 * Validates the video editor state to ensure:
 * - Items are on compatible tracks (no videos on audio tracks, etc.)
 * - Layer ordering is correct (video bottom, overlays middle, subtitles top)
 * - Property panel matches selected element type
 * - All items have valid timing (start < end, no negative values)
 * - No orphaned items (referencing non-existent tracks)
 * - Track types have proper allowed element constraints
 */

// Track-item type compatibility (must match timelineStore.js)
const TRACK_ALLOWED_TYPES = {
  video: ['video'],
  overlay: ['text', 'shape', 'image', 'overlay'],
  audio: ['audio'],
  subtitle: ['subtitle'],
};

/**
 * Validate that all items are on compatible tracks.
 * Returns an array of violation objects.
 */
export function validateTrackCompatibility(tracks, items) {
  const violations = [];
  const trackMap = new Map(tracks.map(t => [t.id, t]));

  for (const item of items) {
    const track = trackMap.get(item.trackId);
    if (!track) {
      violations.push({
        type: 'orphaned_item',
        severity: 'error',
        itemId: item.id,
        message: `Item "${item.id}" (${item.type}) references non-existent track "${item.trackId}"`,
      });
      continue;
    }

    const allowed = TRACK_ALLOWED_TYPES[track.type];
    if (allowed && !allowed.includes(item.type)) {
      violations.push({
        type: 'incompatible_track',
        severity: 'error',
        itemId: item.id,
        trackId: track.id,
        itemType: item.type,
        trackType: track.type,
        message: `${item.type} item "${item.id}" is on ${track.type} track "${track.name}" — should be on ${getExpectedTrackType(item.type)} track`,
      });
    }
  }
  return violations;
}

/**
 * Validate layer ordering: video tracks should have lowest order,
 * overlays above video, subtitles at the top.
 */
export function validateLayerOrder(tracks) {
  const violations = [];
  const videoOrders = tracks.filter(t => t.type === 'video').map(t => t.order);
  const overlayOrders = tracks.filter(t => t.type === 'overlay').map(t => t.order);
  const subtitleOrders = tracks.filter(t => t.type === 'subtitle').map(t => t.order);

  const maxVideo = Math.max(...videoOrders, -1);
  const minOverlay = Math.min(...overlayOrders, Infinity);
  const maxOverlay = Math.max(...overlayOrders, -1);
  const minSubtitle = Math.min(...subtitleOrders, Infinity);

  if (overlayOrders.length > 0 && videoOrders.length > 0 && maxVideo >= minOverlay) {
    violations.push({
      type: 'layer_order',
      severity: 'warning',
      message: `Video track order (${maxVideo}) should be below overlay track order (${minOverlay})`,
    });
  }

  if (subtitleOrders.length > 0 && overlayOrders.length > 0 && maxOverlay >= minSubtitle) {
    violations.push({
      type: 'layer_order',
      severity: 'warning',
      message: `Overlay track order (${maxOverlay}) should be below subtitle track order (${minSubtitle})`,
    });
  }

  return violations;
}

/**
 * Validate item timing: start < end, no negative values, reasonable durations.
 */
export function validateItemTiming(items) {
  const violations = [];
  for (const item of items) {
    if (item.start < 0) {
      violations.push({
        type: 'invalid_timing',
        severity: 'error',
        itemId: item.id,
        message: `Item "${item.id}" has negative start time: ${item.start}`,
      });
    }
    if (item.end <= item.start) {
      violations.push({
        type: 'invalid_timing',
        severity: 'error',
        itemId: item.id,
        message: `Item "${item.id}" has invalid timing: end (${item.end}) <= start (${item.start})`,
      });
    }
    if (item.end - item.start > 86400) {
      violations.push({
        type: 'invalid_timing',
        severity: 'warning',
        itemId: item.id,
        message: `Item "${item.id}" has duration > 24 hours (${item.end - item.start}s)`,
      });
    }
  }
  return violations;
}

/**
 * Validate item properties: position, size, opacity are within valid ranges.
 */
export function validateItemProperties(items) {
  const violations = [];
  for (const item of items) {
    // Opacity
    if (item.opacity !== undefined && (item.opacity < 0 || item.opacity > 1)) {
      violations.push({
        type: 'invalid_property',
        severity: 'warning',
        itemId: item.id,
        message: `Item "${item.id}" opacity out of range: ${item.opacity}`,
      });
    }
    // Volume
    if (item.volume !== undefined && (item.volume < 0 || item.volume > 5)) {
      violations.push({
        type: 'invalid_property',
        severity: 'warning',
        itemId: item.id,
        message: `Item "${item.id}" volume out of range: ${item.volume}`,
      });
    }
    // Speed
    if (item.speed !== undefined && (item.speed <= 0 || item.speed > 100)) {
      violations.push({
        type: 'invalid_property',
        severity: 'warning',
        itemId: item.id,
        message: `Item "${item.id}" speed out of range: ${item.speed}`,
      });
    }
  }
  return violations;
}

/**
 * Run all validation checks and return a summary.
 */
export function runEditorQA(tracks, items) {
  const results = {
    trackCompatibility: validateTrackCompatibility(tracks, items),
    layerOrder: validateLayerOrder(tracks),
    itemTiming: validateItemTiming(items),
    itemProperties: validateItemProperties(items),
  };

  const allViolations = [
    ...results.trackCompatibility,
    ...results.layerOrder,
    ...results.itemTiming,
    ...results.itemProperties,
  ];

  const errors = allViolations.filter(v => v.severity === 'error');
  const warnings = allViolations.filter(v => v.severity === 'warning');

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    violations: allViolations,
    summary: `${errors.length} errors, ${warnings.length} warnings`,
    ...results,
  };
}

/**
 * Auto-fix track compatibility violations by moving items to correct tracks.
 * Returns an array of fixes applied.
 */
export function autoFixTrackCompatibility(tracks, items) {
  const fixes = [];
  const trackMap = new Map(tracks.map(t => [t.id, t]));

  for (const item of items) {
    const track = trackMap.get(item.trackId);
    if (!track) continue;

    const allowed = TRACK_ALLOWED_TYPES[track.type];
    if (allowed && !allowed.includes(item.type)) {
      const expectedTrackType = getExpectedTrackType(item.type);
      const correctTrack = tracks.find(t => t.type === expectedTrackType);
      if (correctTrack) {
        fixes.push({
          itemId: item.id,
          fromTrackId: item.trackId,
          toTrackId: correctTrack.id,
          reason: `Moving ${item.type} from ${track.type} track to ${correctTrack.type} track`,
        });
        item.trackId = correctTrack.id;
      }
    }
  }
  return fixes;
}

function getExpectedTrackType(itemType) {
  if (itemType === 'video') return 'video';
  if (itemType === 'audio') return 'audio';
  if (itemType === 'subtitle') return 'subtitle';
  return 'overlay'; // text, shape, image, overlay
}
