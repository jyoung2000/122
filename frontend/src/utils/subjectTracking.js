/**
 * Subject tracking utilities for dynamic crop positioning.
 *
 * These functions build keyframes from scene analysis data and interpolate
 * the subject's horizontal position at any point in time, enabling the
 * preview player and FFmpeg export to follow the subject smoothly.
 *
 * Processing pipeline (applied in order):
 *   1. buildSubjectKeyframes()     — raw (time, subject_x) pairs from scenes
 *   2. handleSceneCuts()           — insert instant-jump keyframes at hard cuts
 *   3. applyDeadZone()             — eliminate jittery micro-movements
 *   4. smoothKeyframesBidirectional() — two-pass speed limiting
 *   5. mergeHolds()                — merge similar consecutive values into rests
 *   6. interpolateSubjectX()       — smoothstep ease-in/ease-out interpolation
 */

/** Safety margin to prevent subjects being cut off at frame edges. */
const SAFE_MARGIN = 10;

/**
 * Clamp subject_x to a safe range to prevent edge-cutting during crop.
 * Maps [0, 100] → [SAFE_MARGIN, 100-SAFE_MARGIN].
 * Matches backend _safe_subject_x() exactly for preview-export parity.
 *
 * @param {number} sx - Raw subject_x value (0-100)
 * @returns {number} Clamped subject_x
 */
export function safeSubjectX(sx) {
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
 * @returns {Array<{t: number, x: number}>} Sorted keyframes (t = seconds from clip start)
 */
export function buildSubjectKeyframes(scenes, clipStart, clipEnd) {
  if (!scenes?.length) return [{ t: 0, x: 50 }];

  const sorted = [...scenes].sort((a, b) => a.timestamp - b.timestamp);
  const before = sorted.filter((s) => s.timestamp < clipStart);
  const within = sorted.filter((s) => clipStart <= s.timestamp && s.timestamp <= clipEnd);
  const after = sorted.filter((s) => s.timestamp > clipEnd);

  const raw = within.map((s) => ({
    t: s.timestamp - clipStart,
    x: safeSubjectX(s.subject_x ?? 50),
  }));

  const interp = (tAbs, s1, s2) => {
    const dt = s2.timestamp - s1.timestamp;
    if (dt <= 0) return safeSubjectX(s1.subject_x ?? 50);
    const frac = Math.min(1, Math.max(0, (tAbs - s1.timestamp) / dt));
    return safeSubjectX(Math.round(
      (s1.subject_x ?? 50) + ((s2.subject_x ?? 50) - (s1.subject_x ?? 50)) * frac
    ));
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
      sx0 = safeSubjectX(before[before.length - 1].subject_x ?? 50);
    } else if (within.length) {
      sx0 = safeSubjectX(within[0].subject_x ?? 50);
    } else if (after.length) {
      sx0 = safeSubjectX(after[0].subject_x ?? 50);
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
      sxEnd = safeSubjectX(after[0].subject_x ?? 50);
    } else if (within.length) {
      sxEnd = safeSubjectX(within[within.length - 1].subject_x ?? 50);
    } else if (before.length) {
      sxEnd = safeSubjectX(before[before.length - 1].subject_x ?? 50);
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
 * Inserts a keyframe 1 frame (33ms at 30fps) before the cut with the OLD
 * position, so the transition is instant (step function) instead of linear.
 *
 * Matches backend _handle_scene_cuts() exactly for preview-export parity.
 *
 * @param {Array<{t: number, x: number}>} keyframes - Sorted keyframes
 * @param {number} jumpThreshold - Minimum subject_x delta to treat as a cut (default 15)
 * @returns {Array<{t: number, x: number}>} Keyframes with instant-cut transitions
 */
export function handleSceneCuts(keyframes, jumpThreshold = 15) {
  if (!keyframes || keyframes.length <= 1) return keyframes ? [...keyframes] : [];

  const result = [keyframes[0]];
  for (let i = 1; i < keyframes.length; i++) {
    const prev = result[result.length - 1];
    const cur = keyframes[i];
    const delta = Math.abs(cur.x - prev.x);

    if (delta >= jumpThreshold && (cur.t - prev.t) > 0.1) {
      // Large jump detected — insert instant cut
      // Add a keyframe 33ms (1 frame at 30fps) before the new position
      const cutTime = Math.round((cur.t - 0.033) * 1000) / 1000;
      if (cutTime > prev.t) {
        result.push({ t: cutTime, x: prev.x }); // Hold old position until cut
      }
    }

    result.push({ t: cur.t, x: cur.x });
  }

  return result;
}

/**
 * Eliminate jittery micro-movements by snapping small changes to previous value.
 *
 * A human editor would hold the frame still for movements smaller than
 * threshold (in subject_x units, where 1 unit = 1% of frame width).
 *
 * Matches backend _apply_dead_zone() exactly for preview-export parity.
 *
 * @param {Array<{t: number, x: number}>} keyframes - Sorted keyframes
 * @param {number} threshold - Minimum delta to allow movement (default 5)
 * @returns {Array<{t: number, x: number}>} Keyframes with micro-movements removed
 */
export function applyDeadZone(keyframes, threshold = 5) {
  if (!keyframes || keyframes.length <= 1) return keyframes ? [...keyframes] : [];

  const result = [keyframes[0]];
  for (let i = 1; i < keyframes.length; i++) {
    const cur = keyframes[i];
    const prevX = result[result.length - 1].x;
    if (Math.abs(cur.x - prevX) < threshold) {
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
 * @param {number} maxSpeed - Maximum subject_x units per second (default 40)
 * @returns {Array<{t: number, x: number}>} Smoothed keyframes
 */
export function smoothKeyframesBidirectional(keyframes, maxSpeed = 40) {
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
 * @param {number} tolerance - Maximum delta to merge (default 2)
 * @returns {Array<{t: number, x: number}>} Keyframes with holds merged
 */
export function mergeHolds(keyframes, tolerance = 2) {
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
 * Full keyframe processing pipeline: build → scene cuts → dead zone →
 * bidirectional smooth → merge holds.
 *
 * Matches the backend export_clip() pipeline exactly for preview-export parity.
 *
 * @param {Array} scenes - Scene objects with {timestamp, subject_x}
 * @param {number} clipStart - Clip start time in seconds
 * @param {number} clipEnd - Clip end time in seconds
 * @returns {Array<{t: number, x: number}>} Fully processed keyframes
 */
export function processKeyframes(scenes, clipStart, clipEnd) {
  const raw = buildSubjectKeyframes(scenes, clipStart, clipEnd);
  if (!raw || raw.length <= 1) return raw;

  const afterCuts = handleSceneCuts(raw);
  const afterDeadZone = applyDeadZone(afterCuts);
  const afterSmooth = smoothKeyframesBidirectional(afterDeadZone);
  const afterHolds = mergeHolds(afterSmooth);

  return afterHolds;
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
