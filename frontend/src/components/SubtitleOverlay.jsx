import React, { useState, useEffect, useMemo, useRef } from 'react';
import { outlineTextShadow } from '../utils/textOutline';

// ── Backend-matching constants (ass_generator.py / clip_exporter.py) ──────
const ASPECT_RATIO_DIMS = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
};

const FONT_SIZE_MAP = { small: 22, medium: 30, large: 40 };
const REF_W = 1920;
const REF_H = 1080;

// ── Builtin font URL map (mirrors ClipSettingsPanel) ─────────────────────
const BUILTIN_FONT_FILES = {
  'DM Sans': '/api/fonts/builtin/DMSans.ttf',
  'Montserrat': '/api/fonts/builtin/Montserrat.ttf',
  'Open Sans': '/api/fonts/builtin/OpenSans.ttf',
  'Roboto': '/api/fonts/builtin/Roboto.ttf',
  'Poppins': '/api/fonts/builtin/Poppins-Regular.ttf',
  'Inter': '/api/fonts/builtin/Inter.ttf',
  'Nunito': '/api/fonts/builtin/Nunito.ttf',
  'Lato': '/api/fonts/builtin/Lato-Regular.ttf',
  'Oswald': '/api/fonts/builtin/Oswald.ttf',
  'Playfair Display': '/api/fonts/builtin/PlayfairDisplay.ttf',
  'Bebas Neue': '/api/fonts/builtin/BebasNeue-Regular.ttf',
  'Liberation Sans': '/api/fonts/builtin/LiberationSans-Regular.ttf',
  'Liberation Serif': '/api/fonts/builtin/LiberationSerif-Regular.ttf',
  'Liberation Mono': '/api/fonts/builtin/LiberationMono-Regular.ttf',
  'DejaVu Sans': '/api/fonts/builtin/DejaVuSans.ttf',
  'DejaVu Serif': '/api/fonts/builtin/DejaVuSerif.ttf',
  'DejaVu Sans Mono': '/api/fonts/builtin/DejaVuSansMono.ttf',
  'FreeSans': '/api/fonts/builtin/FreeSans.ttf',
};

function registerFontFace(fontName, url) {
  const existingId = `custom-font-${fontName.replace(/\s+/g, '-')}`;
  if (document.getElementById(existingId)) return;
  const style = document.createElement('style');
  style.id = existingId;
  style.textContent = `@font-face { font-family: '${fontName}'; src: url('${url}'); font-weight: 100 900; font-display: swap; }`;
  document.head.appendChild(style);
}

const DEFAULT_SPEAKER_PALETTE = [
  '#00D9FF', '#F59E0B', '#10B981', '#A78BFA', '#EF4444', '#EC4899',
];

// ── Active word timing (matches ClipPreview) ────────────────────────────
const _BASE_OVERHEAD_S = 0.04;
const _ANTICIPATION_S  = 0.10;
const _AUDIO_BUFFER_S  = 0.12;
const _PUNCT_PAUSE = { ',': 0.15, ';': 0.16, ':': 0.12, '.': 0.22, '!': 0.22, '?': 0.24, '\u2014': 0.12, '\u2013': 0.10 };
const _FAST_WORDS = new Set([
  'the', 'a', 'an', 'to', 'in', 'on', 'at', 'of', 'for',
  'and', 'but', 'or', 'is', 'was', 'are', 'were', 'it',
  'its', 'this', 'that',
]);

function computeSpeakerRates(segments) {
  const stats = {};
  for (const seg of segments) {
    const wc = (seg.text || '').split(/\s+/).filter(Boolean).length;
    const dur = seg.end - seg.start;
    if (dur <= 0 || wc === 0) continue;
    if (!stats[seg.speaker]) stats[seg.speaker] = { words: 0, time: 0 };
    stats[seg.speaker].words += wc;
    stats[seg.speaker].time += dur;
  }
  const rates = {};
  for (const [sp, s] of Object.entries(stats)) {
    rates[sp] = s.time > 0 ? s.words / s.time : 3.0;
  }
  return rates;
}

function getCurrentWordIndex(segment, relativeTime, speakerRates) {
  if (!segment || !segment.text) return -1;
  const words = segment.text.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return words.length === 1 ? 0 : -1;

  if (segment.words && segment.words.length === words.length) {
    const adjusted = relativeTime + 0.10 - _AUDIO_BUFFER_S;
    if (adjusted < segment.words[0].start) return -1;
    for (let i = 0; i < segment.words.length; i++) {
      if (adjusted < segment.words[i].end) return i;
    }
    return segment.words.length - 1;
  }

  const totalChars = words.reduce((sum, w) => sum + w.length, 0);
  if (totalChars === 0) return -1;
  const segDuration = segment.end - segment.start;
  const speakerWps = (speakerRates && speakerRates[segment.speaker]) || 3.0;
  const rateScale = Math.max(0.6, Math.min(1.6, 3.0 / speakerWps));
  const anticipation = _ANTICIPATION_S * rateScale;
  const elapsed = (relativeTime - segment.start) + anticipation - _AUDIO_BUFFER_S;
  if (elapsed < 0) return -1;

  const punctPauses = words.map((w) => {
    const last = w[w.length - 1];
    return (_PUNCT_PAUSE[last] || 0) * rateScale;
  });
  const totalPunct = punctPauses.reduce((a, b) => a + b, 0);
  const baseOverhead = _BASE_OVERHEAD_S * rateScale * words.length;
  const totalPause = baseOverhead + totalPunct;
  const charTime = Math.max(segDuration - totalPause, segDuration * 0.45);
  const pauseScale = (segDuration - charTime) / Math.max(totalPause, 0.01);

  let t = 0;
  for (let i = 0; i < words.length; i++) {
    const charDur = charTime * (words[i].length / totalChars);
    const pause = (_BASE_OVERHEAD_S * rateScale + punctPauses[i]) * pauseScale;
    let wordDur = charDur + pause;
    const stripped = words[i].toLowerCase().replace(/[.,!?;:\u2014\u2013]+$/, '');
    if (_FAST_WORDS.has(stripped)) wordDur *= 0.75;
    if (i === 0) wordDur *= 1.15;
    else if (i === words.length - 1) wordDur *= 1.10;
    if (elapsed < t + wordDur) return i;
    t += wordDur;
  }
  return words.length - 1;
}

function splitSegmentsByMaxWords(segments, maxWords) {
  if (!maxWords || maxWords <= 0) return segments;
  const result = [];
  for (const seg of segments) {
    const words = (seg.text || '').split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) { result.push(seg); continue; }
    const totalWords = words.length;
    const duration = seg.end - seg.start;
    let ct = seg.start;
    for (let i = 0; i < totalWords; i += maxWords) {
      const chunkWords = words.slice(i, i + maxWords);
      const chunkDuration = duration * (chunkWords.length / totalWords);
      let chunkEnd = ct + chunkDuration;
      if (i + maxWords >= totalWords) chunkEnd = seg.end;
      if (chunkEnd - ct >= 0.1) {
        result.push({ start: ct, end: chunkEnd, text: chunkWords.join(' '), speaker: seg.speaker, words: null });
      }
      ct = chunkEnd;
    }
  }
  return result;
}

function getSpeakerColor(speaker, speakersOrdered, settings) {
  const useSpeaker = settings?.useSpeakerColors ?? true;
  if (!useSpeaker) return settings?.subtitleFontColor || '#FFFFFF';
  const speakerColors = settings?.speakerColors || {};
  if (speakerColors[speaker]) return speakerColors[speaker];
  const idx = speakersOrdered.indexOf(speaker);
  return DEFAULT_SPEAKER_PALETTE[(idx >= 0 ? idx : 0) % DEFAULT_SPEAKER_PALETTE.length];
}

function hexToRgba(hex, opacity) {
  hex = (hex || '#000000').replace('#', '');
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${opacity})`;
}

// ── Component ───────────────────────────────────────────────────────────
/**
 * Self-contained subtitle overlay for use inside VideoEditor's viewport.
 * Renders positioned subtitle text based on currentTime prop.
 *
 * Props:
 *  - currentTime: number (absolute video time)
 *  - transcript: array of { start, end, text, speaker, words? }
 *  - clipStart, clipEnd: clip time boundaries
 *  - settings: full clip settings object (subtitlesEnabled, subtitleFont, etc.)
 *  - aspectRatio, sourceWidth, sourceHeight: for font scaling
 */
export default function SubtitleOverlay({
  currentTime = 0,
  transcript = [],
  clipStart = 0,
  clipEnd = 0,
  settings = {},
  aspectRatio,
  sourceWidth = 1920,
  sourceHeight = 1080,
  segments = [],
}) {
  const containerRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [currentWordIdx, setCurrentWordIdx] = useState(-1);

  const subtitlesEnabledGlobal = settings.subtitlesEnabled || false;

  // Per-segment subtitle override: segment's subtitlesEnabled takes precedence
  // over the global toggle when the playhead is inside a segment.
  // This allows segments to ENABLE subtitles even when global is off, and
  // vice versa — each segment controls its own subtitle visibility.
  const subtitlesEnabled = useMemo(() => {
    if (!segments || segments.length === 0) return subtitlesEnabledGlobal;
    const absTime = currentTime;
    for (const seg of segments) {
      if (absTime >= seg.start && absTime < seg.end) {
        // Segment has explicit subtitlesEnabled — use it directly
        return seg.subtitlesEnabled !== false;
      }
    }
    // Not inside any segment — use global setting
    return subtitlesEnabledGlobal;
  }, [segments, currentTime, subtitlesEnabledGlobal]);

  // Track container size for font scaling
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({ w: entry.contentRect.width, h: entry.contentRect.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Register @font-face and preload subtitle font
  // This ensures fonts work even if ClipSettingsPanel hasn't loaded yet
  useEffect(() => {
    const font = settings.subtitleFont;
    if (!font || typeof document === 'undefined') return;

    // Register builtin font @font-face if known
    if (BUILTIN_FONT_FILES[font]) {
      registerFontFace(font, BUILTIN_FONT_FILES[font]);
    } else {
      // Custom font — look up URL from /api/fonts
      fetch('/api/fonts')
        .then((r) => r.ok ? r.json() : [])
        .then((fonts) => {
          const match = fonts.find((f) => f.name === font);
          if (match) {
            registerFontFace(match.name, match.url);
            document.fonts.load(`400 16px "${font}"`).catch(() => {});
            document.fonts.load(`700 16px "${font}"`).catch(() => {});
          }
        })
        .catch(() => {});
    }

    document.fonts.load(`400 16px "${font}"`).catch(() => {});
    document.fonts.load(`700 16px "${font}"`).catch(() => {});
  }, [settings.subtitleFont]);

  // Pre-filter transcript segments to clip range, offset to clip-relative time
  const clipSegments = useMemo(() => {
    if (!subtitlesEnabled || !transcript?.length) return [];
    const filtered = transcript
      .filter((seg) => seg.end > clipStart && seg.start < clipEnd)
      .map((seg) => {
        const segStart = Math.max(seg.start, clipStart);
        const segEnd = Math.min(seg.end, clipEnd);
        let words = null;
        if (seg.words && seg.words.length > 0) {
          words = seg.words
            .filter((w) => w.end > segStart && w.start < segEnd)
            .map((w) => ({ start: w.start - clipStart, end: w.end - clipStart, word: w.word }));
          if (words.length === 0) words = null;
        }
        return {
          start: segStart - clipStart,
          end: segEnd - clipStart,
          text: (seg.text || '').trim(),
          speaker: seg.speaker || '',
          words,
        };
      })
      .filter((seg) => seg.end - seg.start >= 0.1);
    const maxWords = settings.subtitleMaxWords || 0;
    return maxWords > 0 ? splitSegmentsByMaxWords(filtered, maxWords) : filtered;
  }, [subtitlesEnabled, transcript, clipStart, clipEnd, settings.subtitleMaxWords]);

  const speakersOrdered = useMemo(() => {
    const seen = [];
    for (const seg of clipSegments) {
      if (seg.speaker && !seen.includes(seg.speaker)) seen.push(seg.speaker);
    }
    return seen;
  }, [clipSegments]);

  const speakerRates = useMemo(() => computeSpeakerRates(clipSegments), [clipSegments]);

  // Find current subtitle based on currentTime
  const relTime = currentTime - clipStart;
  const currentSubtitle = useMemo(() => {
    if (!subtitlesEnabled || clipSegments.length === 0) return null;
    return clipSegments.find((seg) => seg.start <= relTime && relTime < seg.end) || null;
  }, [subtitlesEnabled, clipSegments, relTime]);

  // Active word tracking
  const activeWordEnabled = settings.activeWordEnabled || false;
  useEffect(() => {
    if (!activeWordEnabled || !currentSubtitle) {
      setCurrentWordIdx(-1);
      return;
    }
    const idx = getCurrentWordIndex(currentSubtitle, relTime, speakerRates);
    setCurrentWordIdx(idx);
  }, [activeWordEnabled, currentSubtitle, relTime, speakerRates]);

  // Output dims for font scaling
  const outputDims = useMemo(() => {
    if (aspectRatio && ASPECT_RATIO_DIMS[aspectRatio]) {
      return { w: ASPECT_RATIO_DIMS[aspectRatio][0], h: ASPECT_RATIO_DIMS[aspectRatio][1] };
    }
    return { w: sourceWidth, h: sourceHeight };
  }, [aspectRatio, sourceWidth, sourceHeight]);

  const subtitleScale = useMemo(() => {
    if (containerSize.w === 0) return 0;
    const scaleW = containerSize.w / outputDims.w;
    const scaleH = containerSize.h / outputDims.h;
    return Math.min(scaleW, scaleH);
  }, [containerSize, outputDims]);

  const backendFontScale = useMemo(
    () => Math.min(outputDims.w, outputDims.h) / Math.min(REF_W, REF_H),
    [outputDims],
  );

  const subtitleFontSize = useMemo(() => {
    if (!subtitlesEnabled || subtitleScale === 0) return 14;
    const size = settings.subtitleSize || 'medium';
    const basePx = typeof size === 'number' ? size : (FONT_SIZE_MAP[size] || 30);
    const backendPx = Math.max(16, Math.round(basePx * backendFontScale));
    return Math.max(8, backendPx * subtitleScale);
  }, [subtitlesEnabled, settings.subtitleSize, subtitleScale, backendFontScale]);

  // Compute the actual video content area within the viewport
  // (accounts for letterboxing when viewport ratio doesn't match output ratio)
  const videoContentRect = useMemo(() => {
    if (containerSize.w === 0 || containerSize.h === 0) {
      return { left: 0, top: 0, width: containerSize.w, height: containerSize.h };
    }
    const videoAR = outputDims.w / outputDims.h;
    const containerAR = containerSize.w / containerSize.h;

    if (Math.abs(videoAR - containerAR) < 0.02) {
      return { left: 0, top: 0, width: containerSize.w, height: containerSize.h };
    }

    if (videoAR > containerAR) {
      // Width-constrained (pillarbox top/bottom)
      const h = containerSize.w / videoAR;
      return { left: 0, top: (containerSize.h - h) / 2, width: containerSize.w, height: h };
    } else {
      // Height-constrained (letterbox left/right)
      const w = containerSize.h * videoAR;
      return { left: (containerSize.w - w) / 2, top: 0, width: w, height: containerSize.h };
    }
  }, [containerSize, outputDims]);

  // Container wrapper — fills parent, used for ResizeObserver
  if (!subtitlesEnabled) {
    return <div ref={containerRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />;
  }

  if (!currentSubtitle) {
    return <div ref={containerRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />;
  }

  // ── Render subtitle ─────────────────────────────────────────────────
  const position = settings.subtitlePosition || 'bottom';
  const maxWidthPct = settings.subtitleMaxWidth ?? 90;
  const offsetVPct = settings.subtitleOffsetV ?? 4;
  const bgEnabled = settings.subtitleBgEnabled || false;
  const bgColor = settings.subtitleBgColor || '#000000';
  const bgOpacity = settings.subtitleBgOpacity ?? 75;
  const fontWeight = settings.subtitleFontWeight === 'bold' ? 700 : settings.subtitleFontWeight === 'black' ? 900 : 400;
  const rawFont = settings.subtitleFont || 'DM Sans';
  const fontFamily = `"${rawFont}", sans-serif`;
  const showLabels = settings.showSpeakerLabels ?? false;
  const color = getSpeakerColor(currentSubtitle.speaker, speakersOrdered, settings);

  // Outline
  const olColorHex = (settings.subtitleOutlineColor || '#000000').replace('#', '');
  const olR = parseInt(olColorHex.substring(0, 2), 16) || 0;
  const olG = parseInt(olColorHex.substring(2, 4), 16) || 0;
  const olB = parseInt(olColorHex.substring(4, 6), 16) || 0;
  const olOpacity = Math.max(0, Math.min(100, settings.subtitleOutlineOpacity ?? 100)) / 100;
  const olWidth = Math.max(0, Math.min(10, settings.subtitleOutlineWidth ?? 2));
  const backendOlWidth = Math.max(0, Math.round(olWidth * backendFontScale));
  const scaledOlWidth = backendOlWidth * subtitleScale;

  let outlineStyle;
  if (bgEnabled) {
    outlineStyle = {};
  } else if (scaledOlWidth > 0) {
    const shadowDepth = Math.max(1, Math.min(4, Math.round(backendOlWidth * 0.75)));
    const scaledShadow = shadowDepth * subtitleScale;
    const olColorStr = `rgba(${olR},${olG},${olB},${olOpacity})`;
    const dropShadow = `${scaledShadow}px ${scaledShadow}px 0px rgba(0,0,0,0.5)`;
    outlineStyle = {
      WebkitTextStroke: `${scaledOlWidth * 2}px ${olColorStr}`,
      paintOrder: 'stroke fill',
      textShadow: outlineTextShadow(scaledOlWidth, olColorStr, dropShadow),
    };
  } else {
    outlineStyle = { textShadow: '1px 1px 2px rgba(0,0,0,0.8)' };
  }

  // Margins
  const clampedMaxWidth = Math.max(20, Math.min(100, maxWidthPct));
  const clampedOffsetV = Math.max(0, Math.min(100, offsetVPct));
  const marginH_px = Math.max(20, Math.floor(outputDims.w * (100 - clampedMaxWidth) / 100 / 2));
  const maxMarginH = Math.floor(outputDims.w * 0.40);
  const effectiveMarginH = Math.min(marginH_px, maxMarginH) / outputDims.w * 100;
  const positionStyle = { bottom: `${clampedOffsetV}%` };

  const text = showLabels && currentSubtitle.speaker
    ? `${currentSubtitle.speaker}: ${currentSubtitle.text}`
    : currentSubtitle.text;

  // Active word highlighting
  const awColor = settings.activeWordColor || '#FFD700';
  const awOutlineColor = settings.activeWordOutlineColor || '#000000';
  const awBgColor = settings.activeWordBgColor || '#000000';
  const awBgOpacity = settings.activeWordBgOpacity ?? 0;

  let textContent;
  if (activeWordEnabled && currentWordIdx >= 0) {
    const words = currentSubtitle.text.split(/\s+/).filter(Boolean);
    const prefix = showLabels && currentSubtitle.speaker ? `${currentSubtitle.speaker}: ` : '';
    const awOlHex = awOutlineColor.replace('#', '');
    const awOlR = parseInt(awOlHex.substring(0, 2), 16) || 0;
    const awOlG = parseInt(awOlHex.substring(2, 4), 16) || 0;
    const awOlB = parseInt(awOlHex.substring(4, 6), 16) || 0;
    textContent = (
      <>
        {prefix}
        {words.map((word, idx) => {
          const isActive = idx === currentWordIdx;
          const wordStyle = isActive ? {
            color: awColor,
            ...(scaledOlWidth > 0 ? {
              WebkitTextStroke: `${scaledOlWidth * 2}px rgba(${awOlR},${awOlG},${awOlB},${olOpacity})`,
              paintOrder: 'stroke fill',
              textShadow: outlineTextShadow(scaledOlWidth, `rgba(${awOlR},${awOlG},${awOlB},${olOpacity})`),
            } : {}),
            ...(awBgOpacity > 0 ? {
              backgroundColor: hexToRgba(awBgColor, awBgOpacity / 100),
              padding: `0 ${Math.max(1, 2 * subtitleScale)}px`,
            } : {}),
          } : {};
          return (
            <span key={idx} style={wordStyle}>
              {word}{idx < words.length - 1 ? ' ' : ''}
            </span>
          );
        })}
      </>
    );
  } else {
    textContent = text;
  }

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }}>
      {/* Constrain subtitles to the actual video content area (handles letterboxing) */}
      <div style={{
        position: 'absolute',
        left: videoContentRect.left,
        top: videoContentRect.top,
        width: videoContentRect.width,
        height: videoContentRect.height,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}>
        <div style={{
          position: 'absolute',
          left: `${effectiveMarginH}%`,
          right: `${effectiveMarginH}%`,
          textAlign: 'center',
          pointerEvents: 'none',
          ...positionStyle,
        }}>
          <span style={{
            display: 'inline-block',
            fontFamily,
            fontSize: subtitleFontSize,
            fontWeight,
            color,
            lineHeight: 1.4,
            wordWrap: 'break-word',
            overflowWrap: 'break-word',
            whiteSpace: 'pre-wrap',
            ...outlineStyle,
            ...(bgEnabled ? {
              background: hexToRgba(bgColor, bgOpacity / 100),
              padding: `${Math.max(1, Math.max(Math.floor(4 * backendFontScale), 2) * subtitleScale)}px`,
            } : {}),
          }}>
            {textContent}
          </span>
        </div>
      </div>
    </div>
  );
}
