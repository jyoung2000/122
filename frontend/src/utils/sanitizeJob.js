/**
 * Sanitize job data from API to ensure no objects leak into React children.
 * React error #310 ("Objects are not valid as a React child") happens when
 * an object/array ends up inside JSX {} interpolation. This recursively
 * converts any non-primitive leaves in known display fields to strings.
 */
export default function sanitizeJob(job) {
  if (!job || typeof job !== 'object') return job;
  const safe = { ...job };

  // Scalar display fields — force to string/number/null
  const stringFields = ['filename', 'file_path', 'language', 'resolution', 'status',
    'progress_message', 'created_at', 'updated_at', 'analysis_started_at', 'error'];
  for (const f of stringFields) {
    if (safe[f] != null && typeof safe[f] === 'object') safe[f] = JSON.stringify(safe[f]);
  }

  // summary — ensure all leaves are strings
  if (safe.summary && typeof safe.summary === 'object') {
    const s = { ...safe.summary };
    for (const k of ['overview', 'tone', 'estimated_audience', 'content_category']) {
      if (s[k] != null && typeof s[k] !== 'string') s[k] = String(s[k]);
    }
    if (s.key_topics && Array.isArray(s.key_topics)) {
      s.key_topics = s.key_topics.map((t) => (typeof t === 'string' ? t : String(t)));
    }
    safe.summary = s;
  }

  // provider_used — ensure values are strings
  if (safe.provider_used && typeof safe.provider_used === 'object') {
    const pu = {};
    for (const [k, v] of Object.entries(safe.provider_used)) {
      pu[k] = typeof v === 'string' ? v : String(v);
    }
    safe.provider_used = pu;
  }

  // clips — sanitize display-text fields
  if (Array.isArray(safe.clips)) {
    safe.clips = safe.clips.map(sanitizeClip);
  }

  // transcript segments — ensure text and speaker are strings
  if (Array.isArray(safe.transcript)) {
    safe.transcript = safe.transcript.map((seg) => {
      if (!seg || typeof seg !== 'object') return seg;
      const ss = { ...seg };
      if (typeof ss.text !== 'string') ss.text = String(ss.text ?? '');
      if (typeof ss.speaker !== 'string') ss.speaker = String(ss.speaker ?? '');
      return ss;
    });
  }

  // scenes — ensure description is a string
  if (Array.isArray(safe.scenes)) {
    safe.scenes = safe.scenes.map((sc) => {
      if (!sc || typeof sc !== 'object') return sc;
      const s = { ...sc };
      if (typeof s.description !== 'string') s.description = String(s.description ?? '');
      return s;
    });
  }

  return safe;
}

/**
 * Sanitize a single clip object to ensure all display fields are primitives.
 */
export function sanitizeClip(c) {
  if (!c || typeof c !== 'object') return c;
  const sc = { ...c };
  const textFields = ['title', 'viral_score_reasoning', 'clip_type', 'platform',
    'suggested_caption', 'hook_text', 'why_this_works', 'clip_focus',
    'seo_title', 'seo_description', 'seo_platform_tips',
    'shorts_description', 'longform_description'];
  for (const f of textFields) {
    if (sc[f] != null && typeof sc[f] !== 'string') sc[f] = String(sc[f]);
  }
  if (Array.isArray(sc.seo_tags)) {
    sc.seo_tags = sc.seo_tags.map((t) => (typeof t === 'string' ? t : String(t)));
  }
  return sc;
}

/**
 * Safe string helper for JSX rendering.
 * Converts any value to a string safe for React children.
 */
export function safeStr(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return JSON.stringify(val);
}
