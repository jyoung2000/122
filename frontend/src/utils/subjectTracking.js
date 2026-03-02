/**
 * Subject tracking utilities for dynamic crop positioning.
 *
 * These functions build keyframes from scene analysis data and interpolate
 * the subject's horizontal position at any point in time, enabling the
 * preview player and FFmpeg export to follow the subject smoothly.
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
 * Linear interpolation between surrounding keyframes.
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
      return k0.x + (k1.x - k0.x) * frac;
    }
  }

  return keyframes[keyframes.length - 1].x;
}

/**
 * Smooth keyframes to limit max subject_x change rate.
 * Matches backend _smooth_keyframes(max_speed=50) exactly for preview-export parity.
 *
 * @param {Array<{t: number, x: number}>} keyframes - Sorted keyframes
 * @param {number} maxSpeed - Maximum subject_x units per second (default 50)
 * @returns {Array<{t: number, x: number}>} Smoothed keyframes
 */
export function smoothKeyframes(keyframes, maxSpeed = 50) {
  if (!keyframes || keyframes.length <= 1) return keyframes;
  const smoothed = [keyframes[0]];
  for (let i = 1; i < keyframes.length; i++) {
    const prev = smoothed[smoothed.length - 1];
    const cur = keyframes[i];
    const dt = cur.t - prev.t;
    if (dt <= 0) {
      smoothed.push({ t: cur.t, x: prev.x });
      continue;
    }
    const maxDelta = maxSpeed * dt;
    const delta = cur.x - prev.x;
    let newX = cur.x;
    if (Math.abs(delta) > maxDelta) {
      newX = Math.round(prev.x + maxDelta * (delta > 0 ? 1 : -1));
      newX = Math.max(0, Math.min(100, newX));
    }
    smoothed.push({ t: cur.t, x: newX });
  }
  return smoothed;
}

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
