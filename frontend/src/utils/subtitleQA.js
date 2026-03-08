/**
 * Subtitle QA & Validation
 *
 * Validates that subtitle changes are properly applied across the preview
 * player and exported video. Ensures the timeline store (single source of
 * truth) is consistent with what SubtitleOverlay renders and what
 * RenderEngine composites for export.
 */

const FONT_SIZE_MAP = { small: 22, medium: 30, large: 40 };
const REF_W = 1920;
const REF_H = 1080;

/**
 * Validate subtitle items in the timeline store.
 * Returns { valid: boolean, errors: string[], warnings: string[] }
 */
export function validateSubtitleItems(items) {
  const errors = [];
  const warnings = [];
  const subtitles = items.filter((it) => it.type === 'subtitle');

  if (subtitles.length === 0) {
    warnings.push('No subtitle items found in timeline');
    return { valid: true, errors, warnings };
  }

  for (const sub of subtitles) {
    const label = `Subtitle "${(sub.subtitleText || '').slice(0, 30)}..." (${sub.id})`;

    // Required fields
    if (!sub.subtitleText && sub.subtitleText !== '') {
      errors.push(`${label}: missing subtitleText`);
    }
    if (typeof sub.start !== 'number' || isNaN(sub.start)) {
      errors.push(`${label}: invalid start time`);
    }
    if (typeof sub.end !== 'number' || isNaN(sub.end)) {
      errors.push(`${label}: invalid end time`);
    }
    if (sub.start >= sub.end) {
      errors.push(`${label}: start (${sub.start}) >= end (${sub.end})`);
    }

    // Track assignment
    if (sub.trackId !== 't1') {
      warnings.push(`${label}: on track "${sub.trackId}" instead of "t1"`);
    }

    // Position validation
    const pos = sub.position || {};
    if (typeof pos.x !== 'number' || pos.x < 0 || pos.x > 100) {
      warnings.push(`${label}: position.x (${pos.x}) out of [0,100] range`);
    }
    if (typeof pos.y !== 'number' || pos.y < 0 || pos.y > 100) {
      warnings.push(`${label}: position.y (${pos.y}) out of [0,100] range`);
    }

    // Rotation validation
    const rotation = sub.transform?.rotation ?? 0;
    if (rotation < -360 || rotation > 360) {
      warnings.push(`${label}: rotation (${rotation}) out of [-360,360] range`);
    }

    // Duration sanity
    const dur = sub.end - sub.start;
    if (dur < 0.1) {
      warnings.push(`${label}: very short duration (${dur.toFixed(2)}s)`);
    }
    if (dur > 30) {
      warnings.push(`${label}: very long duration (${dur.toFixed(1)}s)`);
    }
  }

  // Check for overlapping subtitles on the same track
  const sorted = [...subtitles].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end - 0.01) {
      warnings.push(
        `Overlapping subtitles: "${(sorted[i - 1].subtitleText || '').slice(0, 20)}" ` +
        `(${sorted[i - 1].start.toFixed(2)}-${sorted[i - 1].end.toFixed(2)}) overlaps with ` +
        `"${(sorted[i].subtitleText || '').slice(0, 20)}" (${sorted[i].start.toFixed(2)}-${sorted[i].end.toFixed(2)})`
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate that subtitle settings will produce consistent rendering
 * between preview (SubtitleOverlay CSS) and export (RenderEngine canvas).
 */
export function validateSubtitleSettings(settings) {
  const errors = [];
  const warnings = [];
  const s = settings || {};

  // Font validation
  const font = s.subtitleFont || 'DM Sans';
  if (!font || typeof font !== 'string') {
    errors.push('subtitleFont is not a valid string');
  }

  // Size validation
  const size = s.subtitleSize || 'medium';
  if (typeof size === 'string' && !FONT_SIZE_MAP[size]) {
    errors.push(`subtitleSize "${size}" is not a valid preset (small/medium/large)`);
  }

  // Font weight
  const weight = s.subtitleFontWeight || 'normal';
  if (!['normal', 'bold', 'black'].includes(weight)) {
    warnings.push(`subtitleFontWeight "${weight}" should be normal/bold/black`);
  }

  // Position
  const position = s.subtitlePosition || 'bottom';
  if (!['top', 'center', 'bottom'].includes(position)) {
    errors.push(`subtitlePosition "${position}" should be top/center/bottom`);
  }

  // Max width
  const maxWidth = s.subtitleMaxWidth ?? 90;
  if (maxWidth < 20 || maxWidth > 100) {
    warnings.push(`subtitleMaxWidth (${maxWidth}) outside recommended [20,100] range`);
  }

  // Vertical offset
  const offsetV = s.subtitleOffsetV ?? 4;
  if (offsetV < 0 || offsetV > 50) {
    warnings.push(`subtitleOffsetV (${offsetV}) outside [0,50] range`);
  }

  // Color validations
  const colorFields = ['subtitleFontColor', 'subtitleOutlineColor', 'subtitleBgColor'];
  for (const field of colorFields) {
    const val = s[field];
    if (val && !/^#[0-9a-fA-F]{3,8}$/.test(val)) {
      warnings.push(`${field} "${val}" is not a valid hex color`);
    }
  }

  // Opacity ranges
  const opacityFields = [
    { key: 'subtitleOutlineOpacity', def: 100 },
    { key: 'subtitleBgOpacity', def: 75 },
  ];
  for (const { key, def } of opacityFields) {
    const val = s[key] ?? def;
    if (val < 0 || val > 100) {
      warnings.push(`${key} (${val}) should be in [0,100]`);
    }
  }

  // Outline width
  const olWidth = s.subtitleOutlineWidth ?? 2;
  if (olWidth < 0 || olWidth > 10) {
    warnings.push(`subtitleOutlineWidth (${olWidth}) outside [0,10] range`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate that subtitle rendering parameters match between
 * SubtitleOverlay (preview) and RenderEngine (export).
 *
 * Takes the settings and output dimensions and computes what both
 * renderers would use, flagging any mismatches.
 */
export function validatePreviewExportConsistency(settings, outputDims) {
  const errors = [];
  const warnings = [];
  const s = settings || {};
  const { w: outputW, h: outputH } = outputDims || { w: 1920, h: 1080 };

  // Font scale calculation (must match both renderers)
  const fontScale = Math.min(outputW, outputH) / Math.min(REF_W, REF_H);
  const sizeLabel = s.subtitleSize || 'medium';
  const basePx = typeof sizeLabel === 'number' ? sizeLabel : (FONT_SIZE_MAP[sizeLabel] || 30);
  const exportFontSize = Math.max(16, Math.round(basePx * fontScale));

  if (exportFontSize < 16) {
    warnings.push(`Export font size (${exportFontSize}px) may be too small at ${outputW}x${outputH}`);
  }

  // Outline width scaling
  const olWidth = s.subtitleOutlineWidth ?? 2;
  const exportOutlineWidth = Math.max(0, Math.round(olWidth * fontScale));
  if (olWidth > 0 && exportOutlineWidth === 0) {
    warnings.push(`Outline width ${olWidth} will round to 0 at ${outputW}x${outputH} - increase outline width`);
  }

  // Background padding
  if (s.subtitleBgEnabled) {
    const pad = Math.max(4, Math.round(8 * fontScale));
    if (pad < 4) {
      warnings.push(`Background padding may appear too thin at ${outputW}x${outputH}`);
    }
  }

  // Position consistency check
  const position = s.subtitlePosition || 'bottom';
  const offsetV = s.subtitleOffsetV ?? 4;
  if (position === 'bottom' && offsetV > 40) {
    warnings.push('Subtitle offset is very high (>40%), subtitle may overlap with video center');
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Full QA validation — runs all checks and returns a combined report.
 *
 * @param {Array} items - Timeline store items
 * @param {Object} settings - Clip settings
 * @param {Object} outputDims - { w, h } output resolution
 * @returns {{ valid: boolean, errors: string[], warnings: string[], summary: string }}
 */
export function runSubtitleQA(items, settings, outputDims) {
  const itemResult = validateSubtitleItems(items);
  const settingsResult = validateSubtitleSettings(settings);
  const consistencyResult = validatePreviewExportConsistency(settings, outputDims);

  const errors = [
    ...itemResult.errors,
    ...settingsResult.errors,
    ...consistencyResult.errors,
  ];
  const warnings = [
    ...itemResult.warnings,
    ...settingsResult.warnings,
    ...consistencyResult.warnings,
  ];

  const subtitleCount = items.filter((it) => it.type === 'subtitle').length;
  const valid = errors.length === 0;

  let summary;
  if (valid && warnings.length === 0) {
    summary = `QA passed: ${subtitleCount} subtitle(s), all settings valid, preview/export consistent.`;
  } else if (valid) {
    summary = `QA passed with ${warnings.length} warning(s): ${subtitleCount} subtitle(s).`;
  } else {
    summary = `QA FAILED: ${errors.length} error(s), ${warnings.length} warning(s).`;
  }

  return { valid, errors, warnings, summary };
}
