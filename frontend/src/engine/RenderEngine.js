/**
 * RenderEngine — Canvas-based compositor for preview and export.
 *
 * THE #1 RULE: the same renderFrame() function is called for both
 * real-time preview (via rAF) and stepped export (via ExportEngine).
 * This guarantees pixel-perfect WYSIWYG — what the user sees in
 * preview is exactly what appears in the exported MP4.
 */

// ── Builtin font URL map (mirrors SubtitleOverlay / ClipSettingsPanel) ────
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
};

const DEFAULT_SPEAKER_PALETTE = [
  '#00D9FF', '#F59E0B', '#10B981', '#A78BFA', '#EF4444', '#EC4899',
];

const FONT_SIZE_MAP = { small: 22, medium: 30, large: 40 };
const REF_W = 1920;
const REF_H = 1080;

// ── Transition renderers ──────────────────────────────────────────────────
const TRANSITIONS = {
  dissolve(ctx, outCanvas, inCanvas, progress, w, h) {
    ctx.globalAlpha = 1 - progress;
    ctx.drawImage(outCanvas, 0, 0, w, h);
    ctx.globalAlpha = progress;
    ctx.drawImage(inCanvas, 0, 0, w, h);
    ctx.globalAlpha = 1;
  },
  fade(ctx, outCanvas, inCanvas, progress, w, h) {
    if (progress < 0.5) {
      ctx.globalAlpha = 1 - progress * 2;
      ctx.drawImage(outCanvas, 0, 0, w, h);
    } else {
      ctx.globalAlpha = (progress - 0.5) * 2;
      ctx.drawImage(inCanvas, 0, 0, w, h);
    }
    ctx.globalAlpha = 1;
  },
  'wipe-left'(ctx, outCanvas, inCanvas, progress, w, h) {
    const splitX = w * progress;
    ctx.drawImage(outCanvas, 0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, splitX, h);
    ctx.clip();
    ctx.drawImage(inCanvas, 0, 0, w, h);
    ctx.restore();
  },
  'wipe-right'(ctx, outCanvas, inCanvas, progress, w, h) {
    const splitX = w * (1 - progress);
    ctx.drawImage(outCanvas, 0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(splitX, 0, w - splitX, h);
    ctx.clip();
    ctx.drawImage(inCanvas, 0, 0, w, h);
    ctx.restore();
  },
  'slide-left'(ctx, outCanvas, inCanvas, progress, w, h) {
    const offset = w * progress;
    ctx.drawImage(outCanvas, -offset, 0, w, h);
    ctx.drawImage(inCanvas, w - offset, 0, w, h);
  },
  'slide-right'(ctx, outCanvas, inCanvas, progress, w, h) {
    const offset = w * progress;
    ctx.drawImage(outCanvas, offset, 0, w, h);
    ctx.drawImage(inCanvas, -w + offset, 0, w, h);
  },
  zoom(ctx, outCanvas, inCanvas, progress, w, h) {
    const scale = 1 + progress * 0.3;
    ctx.globalAlpha = 1 - progress;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(scale, scale);
    ctx.translate(-w / 2, -h / 2);
    ctx.drawImage(outCanvas, 0, 0, w, h);
    ctx.restore();
    ctx.globalAlpha = progress;
    ctx.drawImage(inCanvas, 0, 0, w, h);
    ctx.globalAlpha = 1;
  },
};

export default class RenderEngine {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    // Request GPU-accelerated canvas — willReadFrequently: false lets Chrome
    // keep the canvas on the GPU (hardware composited) instead of forcing
    // software readback on every frame.
    this.ctx = canvas.getContext('2d', { willReadFrequently: false }) || canvas.getContext('2d');
    this.width = options.width || 1920;
    this.height = options.height || 1080;
    this._fontCache = new Set();
    this._transitionBuffer1 = null;
    this._transitionBuffer2 = null;
  }

  /**
   * Set output resolution. Called when aspect ratio changes.
   */
  setResolution(width, height) {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this._transitionBuffer1 = null;
    this._transitionBuffer2 = null;
  }

  /**
   * Pre-load a font via FontFace API so canvas text rendering works.
   */
  async loadFont(fontName, url) {
    if (this._fontCache.has(fontName)) return;
    try {
      const builtinUrl = url || BUILTIN_FONT_FILES[fontName];
      if (!builtinUrl) return;
      const face = new FontFace(fontName, `url(${builtinUrl})`);
      await face.load();
      document.fonts.add(face);
      this._fontCache.add(fontName);
    } catch {
      // Font load failed — canvas will use fallback
    }
  }

  /**
   * Core render function — composites all visible items at the given time.
   *
   * @param {number} currentTime - Playback time in seconds
   * @param {Array} tracks - Track definitions from store
   * @param {Array} clips - All clip/item objects from store
   * @param {Object} settings - Project settings (backgroundColor, subtitleSettings, etc.)
   * @param {Map} mediaElements - Map of assetId → HTMLVideoElement | HTMLImageElement
   */
  renderFrame(currentTime, tracks, clips, settings, mediaElements) {
    const { ctx, width, height } = this;

    // Clear and fill background
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = settings.backgroundColor || '#000000';
    ctx.fillRect(0, 0, width, height);

    // Collect visible clips at currentTime, sorted by track order (bottom-to-top)
    // Subtitle items are rendered last (on top) via the canvas engine, using the
    // same timeline store items that SubtitleOverlay uses (single source of truth).
    const visibleClips = [];
    for (const clip of clips) {
      if (currentTime >= clip.start && currentTime < clip.end) {
        const track = tracks.find(t => t.id === clip.trackId);
        if (track && track.visible !== false && !track.muted) {
          visibleClips.push({ clip, track, order: track.order ?? tracks.indexOf(track) });
        }
      }
    }
    visibleClips.sort((a, b) => a.order - b.order);

    // Render each visible clip bottom-to-top
    for (const { clip, track } of visibleClips) {
      try {
        this._renderClip(ctx, clip, track, currentTime, settings, mediaElements, clips);
      } catch {
        // Skip failed clips gracefully
      }
    }
  }

  _renderClip(ctx, clip, track, currentTime, settings, mediaElements, allClips) {
    const { width, height } = this;

    // Check for transition on this clip's leading edge
    if (clip.transition && clip.transition.duration > 0) {
      const transStart = clip.start;
      const transDur = clip.transition.duration;
      const transEnd = transStart + transDur;

      if (currentTime >= transStart && currentTime < transEnd) {
        const progress = (currentTime - transStart) / transDur;
        this._renderTransition(ctx, clip, track, currentTime, progress, settings, mediaElements, allClips);
        return;
      }
    }

    ctx.save();

    // Apply clip opacity with fadeIn/fadeOut
    let opacity = clip.opacity ?? 1;
    const clipDur = clip.end - clip.start;
    const elapsed = currentTime - clip.start;
    if (clip.fadeIn > 0 && elapsed < clip.fadeIn) {
      opacity *= elapsed / clip.fadeIn;
    }
    if (clip.fadeOut > 0 && (clipDur - elapsed) < clip.fadeOut) {
      opacity *= (clipDur - elapsed) / clip.fadeOut;
    }
    if (opacity < 1) {
      ctx.globalAlpha = opacity;
    }

    // Build filter string from clip effects
    const filterStr = this._buildFilterString(clip.effects);
    if (filterStr) {
      ctx.filter = filterStr;
    }

    switch (clip.type) {
      case 'video':
        this._renderVideo(ctx, clip, currentTime, settings, mediaElements);
        break;
      case 'audio':
        // Audio clips don't render visually
        break;
      case 'image':
      case 'overlay':
        this._renderImage(ctx, clip, mediaElements);
        break;
      case 'text':
        this._renderText(ctx, clip, currentTime);
        break;
      case 'subtitle':
        this._renderSubtitle(ctx, clip, currentTime, settings);
        break;
      case 'shape':
        this._renderShape(ctx, clip);
        break;
    }

    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  _renderVideo(ctx, clip, currentTime, settings, mediaElements) {
    const mediaEl = mediaElements?.get(clip.mediaRef || clip.id);
    if (!mediaEl || !(mediaEl instanceof HTMLVideoElement)) return;

    const { width, height } = this;
    const vw = mediaEl.videoWidth || width;
    const vh = mediaEl.videoHeight || height;

    // Calculate crop region for aspect ratio
    const srcAR = vw / vh;
    const dstAR = width / height;

    let sx = 0, sy = 0, sw = vw, sh = vh;

    if (Math.abs(srcAR - dstAR) > 0.01) {
      // Need to crop source to match destination AR
      if (srcAR > dstAR) {
        // Source is wider — crop horizontally
        sw = Math.round(vh * dstAR);
        const subjectPct = clip.subjectX ?? settings.subjectX ?? 50;
        sx = Math.round(((vw - sw) * subjectPct) / 100);
      } else {
        // Source is taller — crop vertically
        sh = Math.round(vw / dstAR);
        sy = Math.round((vh - sh) / 2);
      }
    }

    // Apply transform (position, scale)
    const transform = clip.transform || {};
    const dx = (transform.x || 0) * width / 100;
    const dy = (transform.y || 0) * height / 100;
    const scaleX = transform.scaleX ?? 1;
    const scaleY = transform.scaleY ?? 1;
    const rotation = transform.rotation ?? 0;

    if (rotation !== 0 || scaleX !== 1 || scaleY !== 1 || dx !== 0 || dy !== 0) {
      ctx.save();
      ctx.translate(width / 2 + dx, height / 2 + dy);
      if (rotation !== 0) ctx.rotate((rotation * Math.PI) / 180);
      ctx.scale(scaleX, scaleY);
      ctx.drawImage(mediaEl, sx, sy, sw, sh, -width / 2, -height / 2, width, height);
      ctx.restore();
    } else {
      ctx.drawImage(mediaEl, sx, sy, sw, sh, 0, 0, width, height);
    }
  }

  _renderImage(ctx, clip, mediaElements) {
    const mediaEl = mediaElements?.get(clip.mediaRef || clip.id);
    if (!mediaEl) return;

    const { width, height } = this;
    const transform = clip.transform || {};
    // pos is center-based (DOM uses left/top + translate(-50%, -50%))
    const pos = clip.position || { x: 50, y: 50 };
    const size = clip.size || { w: 30, h: 30 };

    const cx = (pos.x / 100) * width;
    const cy = (pos.y / 100) * height;
    const dw = (size.w / 100) * width;
    const dh = (size.h / 100) * height;
    const rotation = transform.rotation ?? 0;

    ctx.save();
    ctx.translate(cx, cy);
    if (rotation !== 0) ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(mediaEl, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  _renderText(ctx, clip, currentTime) {
    const { width, height } = this;
    const text = clip.textContent || clip.subtitleText || '';
    if (!text) return;

    const style = clip.textStyle || {};
    const fontSize = style.fontSize || 48;
    const fontFamily = style.fontFamily || 'DM Sans';
    const fontWeight = style.fontWeight || 400;
    const color = style.color || '#FFFFFF';
    const align = style.textAlign || 'center';
    const pos = clip.position || { x: 50, y: 50 };
    const size = clip.size || { w: 80, h: 20 };
    const rotation = (clip.transform?.rotation) ?? 0;

    ctx.save();

    // Animation
    let animAlpha = 1;
    let animOffsetY = 0;
    let animScale = 1;
    const anim = style.animation || 'none';
    const clipDur = clip.end - clip.start;
    const elapsed = currentTime - clip.start;

    if (anim === 'fade-in' && elapsed < 0.5) {
      animAlpha = elapsed / 0.5;
    } else if (anim === 'slide-up' && elapsed < 0.5) {
      animOffsetY = (1 - elapsed / 0.5) * 30;
      animAlpha = elapsed / 0.5;
    } else if (anim === 'pop' && elapsed < 0.3) {
      const t = elapsed / 0.3;
      animScale = 0.5 + 0.5 * (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    }

    ctx.globalAlpha *= animAlpha;

    // Font
    ctx.font = `${fontWeight} ${fontSize}px "${fontFamily}", sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';

    const x = (pos.x / 100) * width;
    const y = (pos.y / 100) * height + animOffsetY;

    // Apply rotation and pop scale around center
    ctx.translate(x, y);
    if (rotation !== 0) ctx.rotate((rotation * Math.PI) / 180);
    if (animScale !== 1) ctx.scale(animScale, animScale);
    // Now draw relative to origin (which is the text center)
    const drawX = 0;
    const drawY = 0;

    // Adjust textAlign anchor for centered drawing
    const textAlignX = align === 'center' ? 0 : align === 'right' ? 0 : 0;

    // Background box
    if (style.bgColor && style.bgOpacity > 0) {
      const metrics = ctx.measureText(text);
      const pad = style.bgPadding || 8;
      const boxW = metrics.width + pad * 2;
      const boxH = fontSize * 1.4 + pad * 2;
      ctx.fillStyle = this._hexToRgba(style.bgColor, (style.bgOpacity || 75) / 100);
      const bx = align === 'center' ? -boxW / 2 : align === 'right' ? -boxW : 0;
      ctx.beginPath();
      ctx.roundRect(bx, -boxH / 2, boxW, boxH, style.bgRadius || 4);
      ctx.fill();
    }

    // Text outline/stroke
    if (style.outlineWidth > 0) {
      ctx.strokeStyle = style.outlineColor || '#000000';
      ctx.lineWidth = style.outlineWidth * 2;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, drawX, drawY);
    }

    // Text shadow
    if (style.shadowBlur > 0 || style.shadowOffsetX || style.shadowOffsetY) {
      ctx.shadowColor = style.shadowColor || 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = style.shadowBlur || 2;
      ctx.shadowOffsetX = style.shadowOffsetX || 1;
      ctx.shadowOffsetY = style.shadowOffsetY || 1;
    }

    // Fill text
    ctx.fillStyle = color;

    // Use item's width for text wrapping (matches DOM rendering)
    const maxWidth = (size.w / 100) * width;

    if (anim === 'typewriter') {
      const charsToShow = Math.floor((elapsed / clipDur) * text.length);
      ctx.fillText(text.slice(0, charsToShow), drawX, drawY);
    } else {
      this._drawWrappedText(ctx, text, drawX, drawY, maxWidth, fontSize * 1.4);
    }

    ctx.restore();
  }

  _renderSubtitle(ctx, clip, currentTime, settings) {
    const { width, height } = this;
    const text = clip.subtitleText || '';
    if (!text) return;

    const subSettings = settings.subtitle || settings || {};
    const fontName = subSettings.subtitleFont || 'DM Sans';
    const sizeLabel = subSettings.subtitleSize || 'medium';
    const basePx = typeof sizeLabel === 'number' ? sizeLabel : (FONT_SIZE_MAP[sizeLabel] || 30);
    const outputW = width;
    const outputH = height;
    const fontScale = Math.min(outputW, outputH) / Math.min(REF_W, REF_H);
    const fontSize = Math.max(16, Math.round(basePx * fontScale));
    const fontWeight = subSettings.subtitleFontWeight === 'bold' ? 700 : subSettings.subtitleFontWeight === 'black' ? 900 : 400;
    const settingsPosition = subSettings.subtitlePosition || 'bottom';
    const maxWidthPct = subSettings.subtitleMaxWidth ?? 90;
    const offsetVPct = subSettings.subtitleOffsetV ?? 4;
    const bgEnabled = subSettings.subtitleBgEnabled || false;
    const bgColor = subSettings.subtitleBgColor || '#000000';
    const bgOpacity = subSettings.subtitleBgOpacity ?? 75;
    const outlineColor = subSettings.subtitleOutlineColor || '#000000';
    const outlineOpacity = (subSettings.subtitleOutlineOpacity ?? 100) / 100;
    const outlineWidth = Math.max(0, Math.round((subSettings.subtitleOutlineWidth ?? 2) * fontScale));
    const fontColor = subSettings.subtitleFontColor || '#FFFFFF';
    const activeWordEnabled = subSettings.activeWordEnabled || false;
    const activeWordColor = subSettings.activeWordColor || '#FFD700';

    // Per-item position and rotation from timeline store
    const itemPos = clip.position || { x: 50, y: 90 };
    const itemRotation = (clip.transform?.rotation) ?? 0;
    const hasCustomPosition = itemPos.x !== 50 || itemPos.y !== 90;

    ctx.save();

    // Position: use per-item position if set, otherwise use settings-based position
    const maxWidth = (maxWidthPct / 100) * width;
    let x, y;
    if (hasCustomPosition) {
      x = (itemPos.x / 100) * width;
      y = (itemPos.y / 100) * height;
    } else {
      x = width / 2;
      if (settingsPosition === 'top') {
        y = (offsetVPct / 100) * height + fontSize;
      } else if (settingsPosition === 'center') {
        y = height / 2;
      } else {
        y = height - (offsetVPct / 100) * height - fontSize * 0.4;
      }
    }

    // Apply rotation around the subtitle's position
    if (itemRotation !== 0) {
      ctx.translate(x, y);
      ctx.rotate((itemRotation * Math.PI) / 180);
      ctx.translate(-x, -y);
    }

    ctx.font = `${fontWeight} ${fontSize}px "${fontName}", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Measure for background
    const lines = this._wrapText(ctx, text, maxWidth);
    const lineHeight = fontSize * 1.4;
    const totalHeight = lines.length * lineHeight;

    // Background box
    if (bgEnabled) {
      let maxLineW = 0;
      for (const line of lines) {
        maxLineW = Math.max(maxLineW, ctx.measureText(line).width);
      }
      const pad = Math.max(4, Math.round(8 * fontScale));
      ctx.fillStyle = this._hexToRgba(bgColor, bgOpacity / 100);
      ctx.beginPath();
      ctx.roundRect(
        x - maxLineW / 2 - pad,
        y - totalHeight / 2 - pad,
        maxLineW + pad * 2,
        totalHeight + pad * 2,
        4
      );
      ctx.fill();
    }

    // Draw each line
    const startY = y - (totalHeight - lineHeight) / 2;
    for (let i = 0; i < lines.length; i++) {
      const lineY = startY + i * lineHeight;

      // Outline
      if (outlineWidth > 0 && !bgEnabled) {
        ctx.strokeStyle = this._hexToRgba(outlineColor, outlineOpacity);
        ctx.lineWidth = outlineWidth * 2;
        ctx.lineJoin = 'round';
        ctx.strokeText(lines[i], x, lineY);
      }

      // Active word highlighting
      if (activeWordEnabled && clip._activeWordIndex >= 0) {
        const words = lines[i].split(/\s+/);
        let wordX = x - ctx.measureText(lines[i]).width / 2;
        ctx.textAlign = 'left';
        for (let w = 0; w < words.length; w++) {
          const word = words[w];
          const ww = ctx.measureText(word + ' ').width;
          ctx.fillStyle = w === clip._activeWordIndex ? activeWordColor : fontColor;
          ctx.fillText(word, wordX, lineY);
          wordX += ww;
        }
        ctx.textAlign = 'center';
      } else {
        ctx.fillStyle = fontColor;
        ctx.fillText(lines[i], x, lineY);
      }
    }

    ctx.restore();
  }

  _renderShape(ctx, clip) {
    const { width, height } = this;
    // pos is center-based (DOM uses left/top + translate(-50%, -50%))
    const pos = clip.position || { x: 10, y: 10 };
    const size = clip.size || { w: 20, h: 20 };
    const style = clip.shapeStyle || {};
    const rotation = (clip.transform?.rotation) ?? 0;

    const cx = (pos.x / 100) * width;
    const cy = (pos.y / 100) * height;
    const dw = (size.w / 100) * width;
    const dh = (size.h / 100) * height;

    ctx.save();
    // Translate to center, apply rotation, then draw relative to center
    ctx.translate(cx, cy);
    if (rotation !== 0) ctx.rotate((rotation * Math.PI) / 180);

    ctx.fillStyle = style.fillColor || '#FF3B30';
    ctx.strokeStyle = style.strokeColor || '#FFFFFF';
    ctx.lineWidth = style.strokeWidth || 2;

    const shapeType = clip.shapeType || 'rectangle';

    switch (shapeType) {
      case 'rectangle':
        ctx.beginPath();
        ctx.roundRect(-dw / 2, -dh / 2, dw, dh, style.cornerRadius || 0);
        if (style.fillColor) ctx.fill();
        if (style.strokeWidth > 0) ctx.stroke();
        break;
      case 'circle':
      case 'ellipse':
        ctx.beginPath();
        ctx.ellipse(0, 0, dw / 2, dh / 2, 0, 0, Math.PI * 2);
        if (style.fillColor) ctx.fill();
        if (style.strokeWidth > 0) ctx.stroke();
        break;
      case 'arrow':
        ctx.beginPath();
        ctx.moveTo(-dw / 2, 0);
        ctx.lineTo(dw * 0.2, 0);
        ctx.lineTo(dw * 0.2, -dh / 2);
        ctx.lineTo(dw / 2, 0);
        ctx.lineTo(dw * 0.2, dh / 2);
        ctx.lineTo(dw * 0.2, 0);
        ctx.closePath();
        if (style.fillColor) ctx.fill();
        if (style.strokeWidth > 0) ctx.stroke();
        break;
      case 'line':
        ctx.beginPath();
        ctx.moveTo(-dw / 2, -dh / 2);
        ctx.lineTo(dw / 2, dh / 2);
        ctx.stroke();
        break;
    }

    ctx.restore();
  }

  _renderTransition(ctx, incomingClip, track, currentTime, progress, settings, mediaElements, allClips) {
    // Find the outgoing clip (the clip that ends where this one starts)
    const outgoingClip = allClips.find(c =>
      c.trackId === track.id &&
      c.id !== incomingClip.id &&
      Math.abs(c.end - incomingClip.start) < 0.05
    );

    if (!outgoingClip) {
      // No outgoing clip — just render incoming with fade
      ctx.globalAlpha = progress;
      this._renderClipDirect(ctx, incomingClip, currentTime, settings, mediaElements);
      ctx.globalAlpha = 1;
      return;
    }

    // Get or create transition buffers
    if (!this._transitionBuffer1 || this._transitionBuffer1.width !== this.width) {
      this._transitionBuffer1 = new OffscreenCanvas(this.width, this.height);
      this._transitionBuffer2 = new OffscreenCanvas(this.width, this.height);
    }

    // Render outgoing to buffer 1
    const ctx1 = this._transitionBuffer1.getContext('2d', { willReadFrequently: false });
    ctx1.clearRect(0, 0, this.width, this.height);
    this._renderClipToCtx(ctx1, outgoingClip, currentTime, settings, mediaElements);

    // Render incoming to buffer 2
    const ctx2 = this._transitionBuffer2.getContext('2d', { willReadFrequently: false });
    ctx2.clearRect(0, 0, this.width, this.height);
    this._renderClipToCtx(ctx2, incomingClip, currentTime, settings, mediaElements);

    // Apply transition
    const transType = incomingClip.transition.type || 'dissolve';
    const renderer = TRANSITIONS[transType] || TRANSITIONS.dissolve;
    renderer(ctx, this._transitionBuffer1, this._transitionBuffer2, progress, this.width, this.height);
  }

  _renderClipDirect(ctx, clip, currentTime, settings, mediaElements) {
    const filterStr = this._buildFilterString(clip.effects);
    if (filterStr) ctx.filter = filterStr;
    if (clip.type === 'video') this._renderVideo(ctx, clip, currentTime, settings, mediaElements);
    else if (clip.type === 'image' || clip.type === 'overlay') this._renderImage(ctx, clip, mediaElements);
    ctx.filter = 'none';
  }

  _renderClipToCtx(targetCtx, clip, currentTime, settings, mediaElements) {
    // Simple version — render directly to target context
    const filterStr = this._buildFilterString(clip.effects);
    if (filterStr) targetCtx.filter = filterStr;
    if (clip.type === 'video') {
      const mediaEl = mediaElements?.get(clip.mediaRef || clip.id);
      if (mediaEl) {
        targetCtx.drawImage(mediaEl, 0, 0, this.width, this.height);
      }
    }
    targetCtx.filter = 'none';
  }

  _buildFilterString(effects) {
    if (!effects || typeof effects !== 'object' || Array.isArray(effects)) return null;
    const parts = [];
    if (effects.brightness != null && effects.brightness !== 0) {
      parts.push(`brightness(${1 + effects.brightness / 100})`);
    }
    if (effects.contrast != null && effects.contrast !== 0) {
      parts.push(`contrast(${1 + effects.contrast / 100})`);
    }
    if (effects.saturation != null && effects.saturation !== 0) {
      parts.push(`saturate(${1 + effects.saturation / 100})`);
    }
    if (effects.blur > 0) {
      parts.push(`blur(${effects.blur}px)`);
    }
    if (effects.hueRotate > 0) {
      parts.push(`hue-rotate(${effects.hueRotate}deg)`);
    }
    if (effects.sepia > 0) {
      parts.push(`sepia(${effects.sepia / 100})`);
    }
    return parts.length > 0 ? parts.join(' ') : null;
  }

  _wrapText(ctx, text, maxWidth) {
    const words = text.split(/\s+/);
    const lines = [];
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      if (ctx.measureText(testLine).width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines.length > 0 ? lines : [''];
  }

  _drawWrappedText(ctx, text, x, y, maxWidth, lineHeight) {
    const lines = this._wrapText(ctx, text, maxWidth);
    const startY = y - ((lines.length - 1) * lineHeight) / 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x, startY + i * lineHeight);
    }
  }

  _hexToRgba(hex, alpha) {
    hex = (hex || '#000000').replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  /**
   * Clean up resources
   */
  destroy() {
    this._transitionBuffer1 = null;
    this._transitionBuffer2 = null;
    this._fontCache.clear();
  }
}
