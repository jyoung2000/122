/**
 * Subject tracking utilities for dynamic crop positioning.
 *
 * These functions build keyframes from scene analysis data and interpolate
 * the subject's horizontal position at any point in time, enabling the
 * preview player and FFmpeg export to follow the subject smoothly.
 *
 * Processing pipeline (applied in order):
 *   1. buildSubjectKeyframes()        — raw (time, subject_x) pairs with DYNAMIC safe margin
 *   2. handleSceneCuts()              — insert 1ms instant-jump keyframes at hard cuts
 *   3. compressRange()                — limit total sx swing per clip toward median
 *   4. applyDeadZone()                — eliminate micro-movements based on VISIBLE crop delta
 *   5. smoothKeyframesBidirectional() — two-pass speed limiting (maxSpeed=25)
 *   6. mergeHolds()                   — merge similar consecutive values into rests (tolerance=3)
 *   7. interpolateSubjectX()          — smoothstep ease-in/ease-out interpolation
 */

/** Legacy safety margin — used when no aspect ratio info is provided. */
const SAFE_MARGIN = 10;

/**
 * Compute the safe subject_x range for a given aspect ratio conversion.
 * Ensures that any subject_x within this range will produce a non-clamped
 * objectPosition value — meaning the subject can actually be centered.
 *
 * @param {number} srcRatio - Source video aspect ratio (e.g., 16/9)
 * @param {number} targetRatio - Target crop aspect ratio (e.g., 9/16)
 * @param {number} edgeBuffer - Buffer from objectPosition 0%/100% (default 5)
 * @returns {{ min: number, max: number }} Safe subject_x range
 */
export function computeSafeRange(srcRatio, targetRatio, edgeBuffer = 5) {
  const R = srcRatio / targetRatio;
  if (R <= 1.01) {
    // No horizontal overflow — any subject_x is fine
    return { min: 5, max: 95 };
  }
  // Invert the centerPct formula: sx = (pct * (R - 1) + 50) / R
  const sxAtMin = (edgeBuffer * (R - 1) + 50) / R;
  const sxAtMax = ((100 - edgeBuffer) * (R - 1) + 50) / R;
  return {
    min: Math.ceil(Math.max(5, sxAtMin)),
    max: Math.floor(Math.min(95, sxAtMax)),
  };
}

/**
 * Clamp subject_x to the safe range for a given aspect ratio.
 * Falls back to static margin if no aspect ratio info provided.
 * Matches backend _safe_subject_x() exactly for preview-export parity.
 *
 * @param {number} sx - Raw subject_x value (0-100)
 * @param {number|null} srcRatio - Source video aspect ratio (optional)
 * @param {number|null} targetRatio - Target crop aspect ratio (optional)
 * @returns {number} Clamped subject_x
 */
export function safeSubjectX(sx, srcRatio = null, targetRatio = null) {
  if (srcRatio && targetRatio) {
    const range = computeSafeRange(srcRatio, targetRatio);
    return Math.max(range.min, Math.min(range.max, Math.round(sx)));
  }
  // Fallback: static margin (legacy behavior)
  return Math.max(SAFE_MARGIN, Math.min(100 - SAFE_MARGIN, Math.round(sx)));
}

/**
 * Build sorted keyframes from scenes for a clip range.
 *
 * Uses scenes both within and outside the clip range.  Scenes outside the
 * clip boundaries are used to interpolate accurate subject_x values at the
 * clip start/end, preventing a fallback to center (50) when no scenes fall
 * strictly within range.  Matches backend _build_subject_keyframes() logic.
 *
 * @param {Array} scenes - Scene objects with {timestamp, subject_x}
 * @param {number} clipStart - Clip start time in seconds
 * @param {number} clipEnd - Clip end time in seconds
 * @param {number|null} srcRatio - Source video aspect ratio (optional)
 * @param {number|null} targetRatio - Target crop aspect ratio (optional)
 * @returns {Array<{t: number, x: number}>} Sorted keyframes (t = seconds from clip start)
 */
export function buildSubjectKeyframes(scenes, clipStart, clipEnd, srcRatio = null, targetRatio = null) {
  if (!scenes?.length) return [{ t: 0, x: 50 }];

  const sorted = [...scenes].sort((a, b) => a.timestamp - b.timestamp);
  const before = sorted.filter((s) => s.timestamp < clipStart);
  const within = sorted.filter((s) => clipStart <= s.timestamp && s.timestamp <= clipEnd);
  const after = sorted.filter((s) => s.timestamp > clipEnd);

  const raw = within.map((s) => ({
    t: s.timestamp - clipStart,
    x: safeSubjectX(s.subject_x ?? 50, srcRatio, targetRatio),
  }));

  const interp = (tAbs, s1, s2) => {
    const dt = s2.timestamp - s1.timestamp;
    if (dt <= 0) return safeSubjectX(s1.subject_x ?? 50, srcRatio, targetRatio);
    const frac = Math.min(1, Math.max(0, (tAbs - s1.timestamp) / dt));
    return safeSubjectX(Math.round(
      (s1.subject_x ?? 50) + ((s2.subject_x ?? 50) - (s1.subject_x ?? 50)) * frac
    ), srcRatio, targetRatio);
  };

  const clipDur = clipEnd - clipStart;

  // Compute accurate boundary value at t=0 (clipStart)
  if (raw.length === 0 || raw[0].t > 0) {
    let sx0;
    if (before.length && within.length) {
      sx0 = interp(clipStart, before[before.length - 1], within[0]);
    } else if (before.length && after.length && !within.length) {
      sx0 = interp(clipStart, before[before.length - 1], after[0]);
    } else if (before.length) {
      sx0 = safeSubjectX(before[before.length - 1].subject_x ?? 50, srcRatio, targetRatio);
    } else if (within.length) {
      sx0 = safeSubjectX(within[0].subject_x ?? 50, srcRatio, targetRatio);
    } else if (after.length) {
      sx0 = safeSubjectX(after[0].subject_x ?? 50, srcRatio, targetRatio);
    } else {
      sx0 = 50;
    }
    raw.unshift({ t: 0, x: sx0 });
  }

  // Compute accurate boundary value at t=clipDur (clipEnd)
  if (clipDur > 0 && (raw.length === 0 || raw[raw.length - 1].t < clipDur)) {
    let sxEnd;
    if (after.length && within.length) {
      sxEnd = interp(clipEnd, within[within.length - 1], after[0]);
    } else if (before.length && after.length && !within.length) {
      sxEnd = interp(clipEnd, before[before.length - 1], after[0]);
    } else if (after.length) {
      sxEnd = safeSubjectX(after[0].subject_x ?? 50, srcRatio, targetRatio);
    } else if (within.length) {
      sxEnd = safeSubjectX(within[within.length - 1].subject_x ?? 50, srcRatio, targetRatio);
    } else if (before.length) {
      sxEnd = safeSubjectX(before[before.length - 1].subject_x ?? 50, srcRatio, targetRatio);
    } else {
      sxEnd = 50;
    }
    raw.push({ t: clipDur, x: sxEnd });
  }

  return raw.length ? raw : [{ t: 0, x: 50 }];
}

/**
 * Detect large subject_x jumps between consecutive keyframes and insert
 * instant-jump keyframes at likely scene cuts.
 *
 * When subject_x changes by more than jumpThreshold between consecutive
 * keyframes, this is likely a scene cut — the subject didn't physically
 * move, the camera cut to a new shot.  Human editors cut-to instantly,
 * they never pan across a scene cut.
 *
 * Inserts a keyframe 1ms before the cut with the OLD position, so the
 * transition is truly instant — below one frame at any display rate.
 *
 * Matches backend _handle_scene_cuts() exactly for preview-export parity.
 *
 * @param {Array<{t: number, x: number}>} keyframes - Sorted keyframes
 * @param {number} jumpThreshold - Minimum subject_x delta to treat as a cut (default 12)
 * @returns {Array<{t: number, x: number}>} Keyframes with instant-cut transitions
 */
export function handleSceneCuts(keyframes, jumpThreshold = 12) {
  if (!keyframes || keyframes.length <= 1) return keyframes ? [...keyframes] : [];

  const result = [keyframes[0]];
  for (let i = 1; i < keyframes.length; i++) {
    const prev = result[result.length - 1];
    const cur = keyframes[i];
    const delta = Math.abs(cur.x - prev.x);

    if (delta >= jumpThreshold && (cur.t - prev.t) > 0.1) {
      // Large jump detected — insert instant cut
      // 1ms gap: below one frame at any frame rate, so smoothstep can't catch it
      const cutTime = Math.round((cur.t - 0.001) * 1000) / 1000;
      if (cutTime > prev.t) {
        result.push({ t: cutTime, x: prev.x }); // Hold old position until cut
      }
    }

    result.push({ t: cur.t, x: cur.x });
  }

  return result;
}

/**
 * Compress the range of subject_x values to prevent erratic swinging.
 *
 * If the full range of sx values exceeds maxRange, compress toward the
 * median so total motion stays within bounds. Preserves relative timing
 * and direction of motion — just reduces amplitude.
 *
 * A human editor typically keeps the crop within a narrow band for a
 * single clip, only making large reframes at clear shot changes.
 *
 * Matches backend _compress_range() exactly for preview-export parity.
 *
 * @param {Array<{t: number, x: number}>} keyframes
 * @param {number} maxRange - Maximum allowed range of sx values (default 25)
 * @returns {Array<{t: number, x: number}>}
 */
export function compressRange(keyframes, maxRange = 25) {
  if (!keyframes || keyframes.length <= 1) return keyframes ? [...keyframes] : [];

  const xs = keyframes.map(k => k.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const currentRange = maxX - minX;

  if (currentRange <= maxRange) return [...keyframes.map(k => ({ ...k }))];

  // Compress toward median
  const sorted = xs.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const scale = maxRange / currentRange;

  return keyframes.map(k => ({
    t: k.t,
    x: Math.round(Math.max(0, Math.min(100, median + (k.x - median) * scale))),
  }));
}

/**
 * Eliminate jittery micro-movements by snapping small changes to previous value.
 *
 * When aspect ratio info is provided, the threshold is computed dynamically
 * so it operates on VISIBLE crop movement (~3% of crop width) rather than
 * raw source-frame movement. This prevents the dead zone from being too
 * permissive at high R values (e.g. 16:9→9:16 where R=3.16).
 *
 * Matches backend _apply_dead_zone() exactly for preview-export parity.
 *
 * @param {Array<{t: number, x: number}>} keyframes - Sorted keyframes
 * @param {number} threshold - Minimum delta to allow movement (default 5)
 * @param {number|null} srcRatio - Source video aspect ratio (optional)
 * @param {number|null} targetRatio - Target crop aspect ratio (optional)
 * @returns {Array<{t: number, x: number}>} Keyframes with micro-movements removed
 */
export function applyDeadZone(keyframes, threshold = 5, srcRatio = null, targetRatio = null) {
  if (!keyframes || keyframes.length <= 1) return keyframes ? [...keyframes] : [];

  // Compute effective threshold: we want ~3% of VISIBLE crop width as the dead zone
  const VISIBLE_THRESHOLD = 3; // % of visible crop width
  let effectiveThreshold = threshold;
  if (srcRatio && targetRatio) {
    const R = srcRatio / targetRatio;
    if (R > 1.01) {
      // Convert visible threshold back to source-frame units
      effectiveThreshold = Math.max(2, Math.round(VISIBLE_THRESHOLD * (R - 1) / R));
    }
  }

  const result = [keyframes[0]];
  for (let i = 1; i < keyframes.length; i++) {
    const cur = keyframes[i];
    const prevX = result[result.length - 1].x;
    if (Math.abs(cur.x - prevX) < effectiveThreshold) {
      // Small change — hold position (snap to previous)
      result.push({ t: cur.t, x: prevX });
    } else {
      result.push({ t: cur.t, x: cur.x });
    }
  }

  return result;
}

/**
 * Two-pass bidirectional smoothing that eliminates trailing lag.
 *
 * Forward pass: clamp speed going forward (prevents anticipation overshoot)
 * Reverse pass: clamp speed going backward (prevents trailing lag)
 * Average: blend both passes for natural-feeling movement
 *
 * Matches backend _smooth_keyframes_bidirectional() exactly for preview-export parity.
 *
 * @param {Array<{t: number, x: number}>} keyframes - Sorted keyframes
 * @param {number} maxSpeed - Maximum subject_x units per second (default 25)
 * @returns {Array<{t: number, x: number}>} Smoothed keyframes
 */
export function smoothKeyframesBidirectional(keyframes, maxSpeed = 25) {
  if (!keyframes || keyframes.length <= 1) return keyframes ? [...keyframes] : [];

  // Forward pass
  const fwd = [keyframes[0]];
  for (let i = 1; i < keyframes.length; i++) {
    const prev = fwd[fwd.length - 1];
    const cur = keyframes[i];
    const dt = cur.t - prev.t;
    if (dt <= 0) {
      fwd.push({ t: cur.t, x: prev.x });
      continue;
    }
    const maxDelta = maxSpeed * dt;
    const delta = cur.x - prev.x;
    let newX = cur.x;
    if (Math.abs(delta) > maxDelta) {
      newX = Math.round(prev.x + maxDelta * (delta > 0 ? 1 : -1));
      newX = Math.max(0, Math.min(100, newX));
    }
    fwd.push({ t: cur.t, x: newX });
  }

  // Reverse pass
  const rev = [keyframes[keyframes.length - 1]];
  for (let i = keyframes.length - 2; i >= 0; i--) {
    const next = rev[rev.length - 1];
    const cur = keyframes[i];
    const dt = next.t - cur.t;
    if (dt <= 0) {
      rev.push({ t: cur.t, x: next.x });
      continue;
    }
    const maxDelta = maxSpeed * dt;
    const delta = cur.x - next.x;
    let newX = cur.x;
    if (Math.abs(delta) > maxDelta) {
      newX = Math.round(next.x + maxDelta * (delta > 0 ? 1 : -1));
      newX = Math.max(0, Math.min(100, newX));
    }
    rev.push({ t: cur.t, x: newX });
  }
  rev.reverse();

  // Average both passes
  const result = [];
  for (let i = 0; i < keyframes.length; i++) {
    const avgX = Math.round((fwd[i].x + rev[i].x) / 2);
    result.push({ t: fwd[i].t, x: Math.max(0, Math.min(100, avgX)) });
  }

  return result;
}

/**
 * Merge consecutive keyframes with similar values into holds.
 *
 * If several consecutive keyframes are within tolerance of each other,
 * snap them all to the first value — creating a visible 'rest' period
 * where the crop holds steady.
 *
 * Matches backend _merge_holds() exactly for preview-export parity.
 *
 * @param {Array<{t: number, x: number}>} keyframes - Sorted keyframes
 * @param {number} tolerance - Maximum delta to merge (default 3)
 * @returns {Array<{t: number, x: number}>} Keyframes with holds merged
 */
export function mergeHolds(keyframes, tolerance = 3) {
  if (!keyframes || keyframes.length <= 1) return keyframes ? [...keyframes] : [];

  const result = [keyframes[0]];
  for (let i = 1; i < keyframes.length; i++) {
    const cur = keyframes[i];
    const prevX = result[result.length - 1].x;
    if (Math.abs(cur.x - prevX) <= tolerance) {
      result.push({ t: cur.t, x: prevX }); // Hold at previous position
    } else {
      result.push({ t: cur.t, x: cur.x });
    }
  }

  return result;
}

/**
 * Full keyframe processing pipeline:
 *   build → scene cuts → compress range → dead zone → bidirectional smooth → merge holds
 *
 * Matches the backend export_clip() pipeline exactly for preview-export parity.
 *
 * @param {Array} scenes - Scene objects with {timestamp, subject_x}
 * @param {number} clipStart - Clip start time in seconds
 * @param {number} clipEnd - Clip end time in seconds
 * @param {number|null} srcRatio - Source video aspect ratio (optional)
 * @param {number|null} targetRatio - Target crop aspect ratio (optional)
 * @returns {Array<{t: number, x: number}>} Fully processed keyframes
 */
export function processKeyframes(scenes, clipStart, clipEnd, srcRatio = null, targetRatio = null) {
  const raw = buildSubjectKeyframes(scenes, clipStart, clipEnd, srcRatio, targetRatio);
  if (!raw || raw.length <= 1) return raw;

  const afterCuts = handleSceneCuts(raw);
  const afterCompress = compressRange(afterCuts);
  const afterDeadZone = applyDeadZone(afterCompress, 5, srcRatio, targetRatio);
  const afterSmooth = smoothKeyframesBidirectional(afterDeadZone);
  const afterHolds = mergeHolds(afterSmooth);

  // Final bounds enforcement — ensure every keyframe x is clamped to [0, 100]
  // and within the safe range for the aspect ratio. This prevents any pipeline
  // stage from producing values that would push the crop off-screen.
  if (srcRatio && targetRatio) {
    const range = computeSafeRange(srcRatio, targetRatio);
    return afterHolds.map(kf => ({
      t: kf.t,
      x: Math.max(range.min, Math.min(range.max, Math.round(kf.x))),
    }));
  }

  return afterHolds.map(kf => ({
    t: kf.t,
    x: Math.max(0, Math.min(100, Math.round(kf.x))),
  }));
}

/**
 * Compute a static subject_x value for a clip using interpolation from
 * nearby scenes.  Used as the fallback when dynamic keyframes aren't
 * available.  Matches backend clip_subject_x computation.
 *
 * @param {Array} scenes - All scene objects with {timestamp, subject_x}
 * @param {number} clipStart - Clip start time in seconds
 * @param {number} clipEnd - Clip end time in seconds
 * @returns {number} Subject x position (0-100)
 */
export function computeClipSubjectX(scenes, clipStart, clipEnd) {
  if (!scenes?.length) return 50;

  const sorted = [...scenes].sort((a, b) => a.timestamp - b.timestamp);
  const inRange = sorted.filter((s) => clipStart <= s.timestamp && s.timestamp <= clipEnd);

  if (inRange.length > 0) {
    return safeSubjectX(
      inRange.reduce((sum, s) => sum + (s.subject_x ?? 50), 0) / inRange.length
    );
  }

  // No in-range scenes — interpolate from nearest boundary scenes
  const before = sorted.filter((s) => s.timestamp < clipStart);
  const after = sorted.filter((s) => s.timestamp > clipEnd);
  const nb = before.length ? before[before.length - 1] : null;
  const na = after.length ? after[0] : null;

  if (nb && na) {
    const mid = (clipStart + clipEnd) / 2;
    const dt = na.timestamp - nb.timestamp;
    if (dt > 0) {
      const frac = (mid - nb.timestamp) / dt;
      return safeSubjectX((nb.subject_x ?? 50) + ((na.subject_x ?? 50) - (nb.subject_x ?? 50)) * frac);
    }
    return safeSubjectX(nb.subject_x ?? 50);
  }
  if (nb) return safeSubjectX(nb.subject_x ?? 50);
  if (na) return safeSubjectX(na.subject_x ?? 50);
  return 50;
}

/**
 * Interpolate subject_x at a given time using keyframes.
 * Uses smoothstep (cubic Hermite: 3t^2 - 2t^3) easing for human-feeling
 * ease-in/ease-out movement between keyframes.
 *
 * Matches backend _build_crop_x_expr() smoothstep exactly for preview-export parity.
 *
 * @param {Array<{t: number, x: number}>} keyframes - Sorted keyframes
 * @param {number} t - Time in seconds (relative to clip start)
 * @returns {number} Interpolated subject_x (0-100)
 */
export function interpolateSubjectX(keyframes, t) {
  if (!keyframes?.length) return 50;
  if (keyframes.length === 1) return keyframes[0].x;

  // Clamp before first / after last
  if (t <= keyframes[0].t) return keyframes[0].x;
  if (t >= keyframes[keyframes.length - 1].t) return keyframes[keyframes.length - 1].x;

  // Find surrounding keyframes via linear scan (keyframes are typically < 30 entries)
  for (let i = 0; i < keyframes.length - 1; i++) {
    const k0 = keyframes[i];
    const k1 = keyframes[i + 1];
    if (t >= k0.t && t < k1.t) {
      const dt = k1.t - k0.t;
      if (dt <= 0) return k0.x;
      const frac = (t - k0.t) / dt;
      // Smoothstep easing: 3t^2 - 2t^3 (zero velocity at both endpoints)
      const easedFrac = frac * frac * (3 - 2 * frac);
      return k0.x + (k1.x - k0.x) * easedFrac;
    }
  }

  return keyframes[keyframes.length - 1].x;
}

// Keep old smoothKeyframes export for backward compatibility (unused but safe)
export { smoothKeyframesBidirectional as smoothKeyframes };

/**
 * Check if keyframes represent dynamic motion (more than one unique x value).
 *
 * @param {Array<{t: number, x: number}>} keyframes
 * @returns {boolean}
 */
export function isDynamic(keyframes) {
  if (!keyframes || keyframes.length <= 1) return false;
  const first = keyframes[0].x;
  return keyframes.some((kf) => kf.x !== first);
}
