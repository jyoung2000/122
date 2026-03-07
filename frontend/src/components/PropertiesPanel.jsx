import React, { useCallback, useMemo, useState } from 'react';
import useTimelineStore from '../stores/timelineStore';

const SPEED_PRESETS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 4.0];
const FONT_OPTIONS = [
  'DM Sans', 'Montserrat', 'Open Sans', 'Roboto', 'Poppins', 'Inter',
  'Nunito', 'Lato', 'Oswald', 'Playfair Display', 'Bebas Neue',
  'Liberation Sans', 'DejaVu Sans',
];
const TEXT_ANIMATIONS = [
  { id: 'none', label: 'None' },
  { id: 'fade-in', label: 'Fade In' },
  { id: 'typewriter', label: 'Typewriter' },
  { id: 'slide-up', label: 'Slide Up' },
  { id: 'pop', label: 'Pop' },
  { id: 'bounce', label: 'Bounce' },
];
const SHAPE_TYPES = [
  { id: 'rectangle', label: 'Rectangle', icon: '▬' },
  { id: 'circle', label: 'Circle', icon: '●' },
  { id: 'ellipse', label: 'Ellipse', icon: '⬮' },
  { id: 'arrow', label: 'Arrow', icon: '➜' },
  { id: 'line', label: 'Line', icon: '╱' },
];

function formatTime(s) {
  if (!s || isNaN(s) || s < 0) return '0:00.00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 100);
  return `${m}:${sec.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

/* Reusable slider row */
function SliderRow({ label, value, min, max, step = 1, unit = '', onChange }) {
  return (
    <div className="ve-properties__slider-row">
      <span className="ve-properties__field-label" style={{ minWidth: 55 }}>{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="ve-properties__slider"
      />
      <span className="ve-properties__slider-value">{typeof value === 'number' ? (Number.isInteger(value) ? value : value.toFixed(1)) : value}{unit}</span>
    </div>
  );
}

/* Reusable number field */
function NumField({ label, value, min, max, step = 1, onChange }) {
  return (
    <div className="ve-properties__field">
      <span className="ve-properties__field-label">{label}</span>
      <input
        type="number" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="ve-properties__input"
      />
    </div>
  );
}

/* Reusable color field */
function ColorField({ label, value, onChange }) {
  return (
    <div className="ve-properties__field">
      <span className="ve-properties__field-label">{label}</span>
      <input
        type="color" value={value || '#FFFFFF'}
        onChange={(e) => onChange(e.target.value)}
        className="ve-properties__color"
      />
    </div>
  );
}

export default function PropertiesPanel({ compact = false, settings = null, onSettingsChange = null }) {
  const selectedItemId = useTimelineStore((s) => s.selectedItemId);
  const items = useTimelineStore((s) => s.items);
  const updateItem = useTimelineStore((s) => s.updateItem);
  const removeItem = useTimelineStore((s) => s.removeItem);
  const [expandedSections, setExpandedSections] = useState({});

  const item = useMemo(
    () => items.find((i) => i.id === selectedItemId) || null,
    [items, selectedItemId],
  );

  const update = useCallback(
    (field, value) => {
      if (!item) return;
      updateItem(item.id, { [field]: value });
    },
    [item, updateItem],
  );

  const updateNested = useCallback(
    (field, subField, value) => {
      if (!item) return;
      const current = item[field] || {};
      updateItem(item.id, { [field]: { ...current, [subField]: value } });
    },
    [item, updateItem],
  );

  const toggleSection = (name) => setExpandedSections(prev => ({ ...prev, [name]: !prev[name] }));

  if (!item) {
    return (
      <div className="ve-properties ve-properties--empty">
        <span className="ve-properties__placeholder">
          Select a timeline item to edit properties
        </span>
      </div>
    );
  }

  const duration = item.end - item.start;
  const isVisual = item.type !== 'audio';
  const isMediaClip = item.type === 'video' || item.type === 'audio';
  const isOverlay = item.type === 'text' || item.type === 'shape' || item.type === 'image' || item.type === 'overlay';

  return (
    <div className={`ve-properties${compact ? ' ve-properties--compact' : ''}`}>
      {/* Header */}
      <div className="ve-properties__header">
        <span className="ve-properties__type-badge" data-type={item.type}>
          {item.type}
        </span>
        <button
          className="ve-properties__delete"
          onClick={() => removeItem(item.id)}
          title="Delete item"
        >
          ✕
        </button>
      </div>

      {/* ── Timing ── */}
      <div className="ve-properties__section">
        <label className="ve-properties__label">Timing</label>
        <div className="ve-properties__row">
          <div className="ve-properties__field">
            <span className="ve-properties__field-label">Start</span>
            <span className="ve-properties__field-value">{formatTime(item.start)}</span>
          </div>
          <div className="ve-properties__field">
            <span className="ve-properties__field-label">End</span>
            <span className="ve-properties__field-value">{formatTime(item.end)}</span>
          </div>
          <div className="ve-properties__field">
            <span className="ve-properties__field-label">Duration</span>
            <span className="ve-properties__field-value">{formatTime(duration)}</span>
          </div>
        </div>
      </div>

      {/* ── Position & Size (all visual overlay items) ── */}
      {isOverlay && (
        <div className="ve-properties__section">
          <label className="ve-properties__label">Position & Size</label>
          <SliderRow label="X" value={item.position?.x ?? 50} min={0} max={100} step={0.5} unit="%" onChange={(v) => update('position', { ...item.position, x: v })} />
          <SliderRow label="Y" value={item.position?.y ?? 50} min={0} max={100} step={0.5} unit="%" onChange={(v) => update('position', { ...item.position, y: v })} />
          <SliderRow label="Width" value={item.size?.w ?? 50} min={1} max={200} step={0.5} unit="%" onChange={(v) => update('size', { ...item.size, w: v })} />
          <SliderRow label="Height" value={item.size?.h ?? 50} min={1} max={200} step={0.5} unit="%" onChange={(v) => update('size', { ...item.size, h: v })} />
          <SliderRow label="Rotation" value={item.transform?.rotation ?? 0} min={-360} max={360} step={1} unit="°" onChange={(v) => updateNested('transform', 'rotation', v)} />
        </div>
      )}

      {/* ── Fades ── */}
      <div className="ve-properties__section">
        <label className="ve-properties__label">Fades</label>
        <div className="ve-properties__row">
          <NumField label="Fade In" value={item.fadeIn || 0} min={0} max={duration} step={0.1} onChange={(v) => update('fadeIn', v)} />
          <NumField label="Fade Out" value={item.fadeOut || 0} min={0} max={duration} step={0.1} onChange={(v) => update('fadeOut', v)} />
        </div>
      </div>

      {/* ── Volume (video & audio) ── */}
      {isMediaClip && (
        <div className="ve-properties__section">
          <label className="ve-properties__label">Audio</label>
          <SliderRow label="Volume" value={item.volume ?? 1} min={0} max={2} step={0.01} onChange={(v) => update('volume', v)} />
        </div>
      )}

      {/* ── Speed (video & audio) ── */}
      {isMediaClip && (
        <div className="ve-properties__section">
          <label className="ve-properties__label">Speed</label>
          <div className="ve-properties__speed-pills">
            {SPEED_PRESETS.map((s) => (
              <button
                key={s}
                className={`ve-properties__speed-pill${item.speed === s ? ' ve-properties__speed-pill--active' : ''}`}
                onClick={() => update('speed', s)}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Opacity (all visual items) ── */}
      {isVisual && (
        <div className="ve-properties__section">
          <label className="ve-properties__label">Opacity</label>
          <SliderRow label="" value={item.opacity ?? 1} min={0} max={1} step={0.01} onChange={(v) => update('opacity', v)} />
        </div>
      )}

      {/* ── Transform (video items with position override) ── */}
      {(item.type === 'video' || item.type === 'image' || item.type === 'overlay') && !isOverlay && (
        <div className="ve-properties__section">
          <label className="ve-properties__label">Transform</label>
          <div className="ve-properties__row">
            <NumField label="X %" value={item.position?.x || 0} min={0} max={100} onChange={(v) => update('position', { ...item.position, x: v })} />
            <NumField label="Y %" value={item.position?.y || 0} min={0} max={100} onChange={(v) => update('position', { ...item.position, y: v })} />
          </div>
          <div className="ve-properties__row">
            <NumField label="W %" value={item.size?.w || 100} min={1} max={200} onChange={(v) => update('size', { ...item.size, w: v })} />
            <NumField label="H %" value={item.size?.h || 100} min={1} max={200} onChange={(v) => update('size', { ...item.size, h: v })} />
          </div>
          <div className="ve-properties__row">
            <NumField label="Rotation" value={item.transform?.rotation || 0} min={-360} max={360} onChange={(v) => updateNested('transform', 'rotation', v)} />
          </div>
        </div>
      )}

      {/* ── Effects (video, image, overlay) ── */}
      {(item.type === 'video' || item.type === 'image' || item.type === 'overlay') && (
        <div className="ve-properties__section">
          <label className="ve-properties__label" onClick={() => toggleSection('effects')} style={{ cursor: 'pointer' }}>
            Effects {expandedSections.effects === false ? '▸' : '▾'}
          </label>
          {expandedSections.effects !== false && (
            <>
              {[
                { key: 'brightness', label: 'Brightness', min: -100, max: 100 },
                { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
                { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
                { key: 'blur', label: 'Blur', min: 0, max: 20, step: 0.5 },
                { key: 'hueRotate', label: 'Hue', min: 0, max: 360 },
                { key: 'sepia', label: 'Sepia', min: 0, max: 100 },
              ].map(ctrl => (
                <SliderRow
                  key={ctrl.key}
                  label={ctrl.label}
                  value={(item.effects || {})[ctrl.key] ?? 0}
                  min={ctrl.min}
                  max={ctrl.max}
                  step={ctrl.step || 1}
                  onChange={(v) => update('effects', { ...(item.effects || {}), [ctrl.key]: v })}
                />
              ))}
            </>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════
          TEXT STYLING — comprehensive controls
         ══════════════════════════════════════════════ */}
      {item.type === 'text' && (
        <>
          {/* Text Content */}
          <div className="ve-properties__section">
            <label className="ve-properties__label">Text Content</label>
            <textarea
              value={item.textContent || ''}
              onChange={(e) => update('textContent', e.target.value)}
              className="ve-properties__textarea"
              rows={3}
              placeholder="Enter text..."
            />
          </div>

          {/* Font */}
          <div className="ve-properties__section">
            <label className="ve-properties__label">Font</label>
            <div className="ve-properties__row">
              <div className="ve-properties__field" style={{ flex: 2 }}>
                <span className="ve-properties__field-label">Family</span>
                <select
                  value={item.textStyle?.fontFamily || 'DM Sans'}
                  onChange={(e) => updateNested('textStyle', 'fontFamily', e.target.value)}
                  className="ve-properties__select"
                >
                  {FONT_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
              <div className="ve-properties__field">
                <span className="ve-properties__field-label">Weight</span>
                <select
                  value={item.textStyle?.fontWeight || 700}
                  onChange={(e) => updateNested('textStyle', 'fontWeight', parseInt(e.target.value))}
                  className="ve-properties__select"
                >
                  <option value={300}>Light</option>
                  <option value={400}>Regular</option>
                  <option value={600}>Semi</option>
                  <option value={700}>Bold</option>
                  <option value={900}>Black</option>
                </select>
              </div>
            </div>
            <SliderRow label="Size" value={item.textStyle?.fontSize || 48} min={8} max={200} step={1} unit="px" onChange={(v) => updateNested('textStyle', 'fontSize', v)} />
            <div className="ve-properties__row">
              <ColorField label="Color" value={item.textStyle?.color || '#FFFFFF'} onChange={(v) => updateNested('textStyle', 'color', v)} />
              <div className="ve-properties__field">
                <span className="ve-properties__field-label">Align</span>
                <div style={{ display: 'flex', gap: 2 }}>
                  {['left', 'center', 'right'].map(a => (
                    <button
                      key={a}
                      className={`ve-properties__speed-pill${(item.textStyle?.textAlign || 'center') === a ? ' ve-properties__speed-pill--active' : ''}`}
                      onClick={() => updateNested('textStyle', 'textAlign', a)}
                      style={{ padding: '3px 7px', fontSize: 9, textTransform: 'capitalize' }}
                    >
                      {a === 'left' ? '◀' : a === 'right' ? '▶' : '◆'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Outline & Shadow */}
          <div className="ve-properties__section">
            <label className="ve-properties__label" onClick={() => toggleSection('textOutline')} style={{ cursor: 'pointer' }}>
              Outline & Shadow {expandedSections.textOutline === false ? '▸' : '▾'}
            </label>
            {expandedSections.textOutline !== false && (
              <>
                <div className="ve-properties__row">
                  <NumField label="Outline" value={item.textStyle?.outlineWidth || 0} min={0} max={10} step={0.5} onChange={(v) => updateNested('textStyle', 'outlineWidth', v)} />
                  <ColorField label="Stroke" value={item.textStyle?.outlineColor || '#000000'} onChange={(v) => updateNested('textStyle', 'outlineColor', v)} />
                </div>
                <SliderRow label="Shadow" value={item.textStyle?.shadowBlur || 0} min={0} max={20} step={0.5} unit="px" onChange={(v) => updateNested('textStyle', 'shadowBlur', v)} />
                <div className="ve-properties__row">
                  <NumField label="Shd X" value={item.textStyle?.shadowOffsetX || 0} min={-20} max={20} onChange={(v) => updateNested('textStyle', 'shadowOffsetX', v)} />
                  <NumField label="Shd Y" value={item.textStyle?.shadowOffsetY || 0} min={-20} max={20} onChange={(v) => updateNested('textStyle', 'shadowOffsetY', v)} />
                </div>
                <div className="ve-properties__row">
                  <ColorField label="Shadow" value={item.textStyle?.shadowColor || 'rgba(0,0,0,0.5)'} onChange={(v) => updateNested('textStyle', 'shadowColor', v)} />
                </div>
              </>
            )}
          </div>

          {/* Background Box */}
          <div className="ve-properties__section">
            <label className="ve-properties__label" onClick={() => toggleSection('textBg')} style={{ cursor: 'pointer' }}>
              Background Box {expandedSections.textBg === false ? '▸' : '▾'}
            </label>
            {expandedSections.textBg !== false && (
              <>
                <div className="ve-properties__row">
                  <ColorField label="BG Color" value={item.textStyle?.bgColor || '#000000'} onChange={(v) => updateNested('textStyle', 'bgColor', v)} />
                  <NumField label="Opacity" value={item.textStyle?.bgOpacity || 0} min={0} max={100} onChange={(v) => updateNested('textStyle', 'bgOpacity', v)} />
                </div>
                <div className="ve-properties__row">
                  <NumField label="Padding" value={item.textStyle?.bgPadding || 8} min={0} max={40} onChange={(v) => updateNested('textStyle', 'bgPadding', v)} />
                  <NumField label="Radius" value={item.textStyle?.bgRadius || 4} min={0} max={40} onChange={(v) => updateNested('textStyle', 'bgRadius', v)} />
                </div>
              </>
            )}
          </div>

          {/* Animation */}
          <div className="ve-properties__section">
            <label className="ve-properties__label">Animation</label>
            <div className="ve-properties__speed-pills">
              {TEXT_ANIMATIONS.map(a => (
                <button
                  key={a.id}
                  className={`ve-properties__speed-pill${(item.textStyle?.animation || 'none') === a.id ? ' ve-properties__speed-pill--active' : ''}`}
                  onClick={() => updateNested('textStyle', 'animation', a.id)}
                  style={{ fontSize: 9 }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ══════════════════════════════════════════════
          SHAPE STYLING — comprehensive controls
         ══════════════════════════════════════════════ */}
      {item.type === 'shape' && (
        <>
          <div className="ve-properties__section">
            <label className="ve-properties__label">Shape Type</label>
            <div className="ve-properties__speed-pills">
              {SHAPE_TYPES.map(s => (
                <button
                  key={s.id}
                  className={`ve-properties__speed-pill${(item.shapeType || 'rectangle') === s.id ? ' ve-properties__speed-pill--active' : ''}`}
                  onClick={() => update('shapeType', s.id)}
                  title={s.label}
                  style={{ fontSize: 12, padding: '4px 8px' }}
                >
                  {s.icon}
                </button>
              ))}
            </div>
          </div>

          <div className="ve-properties__section">
            <label className="ve-properties__label">Colors</label>
            <div className="ve-properties__row">
              <ColorField label="Fill" value={item.shapeStyle?.fillColor || '#FF3B30'} onChange={(v) => updateNested('shapeStyle', 'fillColor', v)} />
              <ColorField label="Stroke" value={item.shapeStyle?.strokeColor || '#FFFFFF'} onChange={(v) => updateNested('shapeStyle', 'strokeColor', v)} />
            </div>
            <SliderRow label="Stroke W" value={item.shapeStyle?.strokeWidth ?? 2} min={0} max={20} step={0.5} unit="px" onChange={(v) => updateNested('shapeStyle', 'strokeWidth', v)} />
            {(item.shapeType === 'rectangle' || !item.shapeType) && (
              <SliderRow label="Radius" value={item.shapeStyle?.cornerRadius ?? 0} min={0} max={100} step={1} unit="px" onChange={(v) => updateNested('shapeStyle', 'cornerRadius', v)} />
            )}
          </div>
        </>
      )}

      {/* ══════════════════════════════════════════════
          IMAGE/OVERLAY — media controls
         ══════════════════════════════════════════════ */}
      {(item.type === 'image' || item.type === 'overlay') && (
        <div className="ve-properties__section">
          <label className="ve-properties__label">Media</label>
          {item.mediaSrc || item.mediaRef ? (
            <div style={{ fontSize: 10, color: 'var(--ve-text-muted)', wordBreak: 'break-all', marginBottom: 6 }}>
              {(item.mediaSrc || item.mediaRef || '').split('/').pop() || 'Media file'}
            </div>
          ) : (
            <div style={{ fontSize: 10, color: 'var(--ve-text-muted)', marginBottom: 6, fontStyle: 'italic' }}>
              No media source — drag from Media Library
            </div>
          )}
        </div>
      )}

      {/* ── Subtitle text ── */}
      {item.type === 'subtitle' && (
        <div className="ve-properties__section">
          <label className="ve-properties__label">Subtitle Text</label>
          <textarea
            value={item.subtitleText || ''}
            onChange={(e) => update('subtitleText', e.target.value)}
            className="ve-properties__textarea"
            rows={3}
          />
        </div>
      )}

      {/* ── Transition ── */}
      {(item.type === 'video' || item.type === 'image') && (
        <div className="ve-properties__section">
          <label className="ve-properties__label">Transition</label>
          <div className="ve-properties__row">
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">Type</span>
              <select
                value={item.transition?.type || 'none'}
                onChange={(e) => {
                  if (e.target.value === 'none') {
                    update('transition', null);
                  } else {
                    update('transition', {
                      type: e.target.value,
                      duration: item.transition?.duration || 0.5,
                    });
                  }
                }}
                className="ve-properties__select"
              >
                <option value="none">None</option>
                <option value="dissolve">Dissolve</option>
                <option value="fade">Fade</option>
                <option value="wipe-left">Wipe Left</option>
                <option value="wipe-right">Wipe Right</option>
                <option value="slide-left">Slide Left</option>
                <option value="slide-right">Slide Right</option>
                <option value="zoom">Zoom</option>
              </select>
            </div>
            {item.transition && (
              <NumField label="Duration" value={item.transition?.duration || 0.5} min={0.1} max={3} step={0.1} onChange={(v) => update('transition', { ...item.transition, duration: v })} />
            )}
          </div>
        </div>
      )}

      {/* ── Clip Settings (apply global settings to this timeline item) ── */}
      {(item.type === 'video') && settings && (
        <div className="ve-properties__section">
          <label className="ve-properties__label">Clip Settings</label>
          <p style={{ fontSize: 10, color: 'var(--ve-text-muted, #888)', margin: '0 0 8px', lineHeight: 1.4 }}>
            Apply your subtitle and export settings from the main editor to this clip.
          </p>
          <div className="ve-properties__row" style={{ flexDirection: 'column', gap: 6 }}>
            <button
              className="ve-properties__preset-btn"
              onClick={() => {
                updateItem(item.id, {
                  clipSettings: { ...settings },
                });
              }}
            >
              Apply Current Settings
            </button>
            {item.clipSettings && (
              <span style={{ fontSize: 9, color: 'var(--ve-accent, #0A84FF)', fontFamily: 'var(--ve-font-mono, monospace)' }}>
                Settings applied ({item.clipSettings.exportQuality || '1080p'}, subs {item.clipSettings.subtitlesEnabled ? 'on' : 'off'})
              </span>
            )}
          </div>
          {/* Export quality override */}
          <div className="ve-properties__row" style={{ marginTop: 8 }}>
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">Quality</span>
              <select
                value={item.clipSettings?.exportQuality || settings?.exportQuality || '1080p'}
                onChange={(e) => {
                  const cs = { ...(item.clipSettings || settings || {}), exportQuality: e.target.value };
                  updateItem(item.id, { clipSettings: cs });
                }}
                className="ve-properties__select"
              >
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
                <option value="4k">4K</option>
              </select>
            </div>
          </div>
          {/* Subtitles toggle */}
          <div className="ve-properties__slider-row" style={{ marginTop: 6 }}>
            <span className="ve-properties__field-label">Subtitles</span>
            <button
              className={`ve-properties__speed-pill${(item.clipSettings?.subtitlesEnabled ?? settings?.subtitlesEnabled) ? ' ve-properties__speed-pill--active' : ''}`}
              onClick={() => {
                const cs = { ...(item.clipSettings || settings || {}), subtitlesEnabled: !(item.clipSettings?.subtitlesEnabled ?? settings?.subtitlesEnabled) };
                updateItem(item.id, { clipSettings: cs });
              }}
            >
              {(item.clipSettings?.subtitlesEnabled ?? settings?.subtitlesEnabled) ? 'On' : 'Off'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
