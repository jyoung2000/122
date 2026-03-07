import React, { useCallback, useMemo, useState } from 'react';
import useTimelineStore from '../stores/timelineStore';

const SPEED_PRESETS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 4.0];
const BLEND_MODES = ['Normal', 'Multiply', 'Screen', 'Overlay'];
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
const SHAPE_TYPES = ['rectangle', 'circle', 'ellipse', 'arrow', 'line'];

function formatTime(s) {
  if (!s || isNaN(s) || s < 0) return '0:00.00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 100);
  return `${m}:${sec.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

export default function PropertiesPanel({ compact = false, settings = null, onSettingsChange = null }) {
  const selectedItemId = useTimelineStore((s) => s.selectedItemId);
  const items = useTimelineStore((s) => s.items);
  const updateItem = useTimelineStore((s) => s.updateItem);
  const removeItem = useTimelineStore((s) => s.removeItem);
  const [activeSection, setActiveSection] = useState(null);

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

  return (
    <div className={`ve-properties${compact ? ' ve-properties--compact' : ''}`}>
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

      {/* ── Fades ── */}
      <div className="ve-properties__section">
        <label className="ve-properties__label">Fades</label>
        <div className="ve-properties__row">
          <div className="ve-properties__field">
            <span className="ve-properties__field-label">Fade In</span>
            <input
              type="number"
              min="0"
              max={duration}
              step="0.1"
              value={item.fadeIn}
              onChange={(e) => update('fadeIn', parseFloat(e.target.value) || 0)}
              className="ve-properties__input"
            />
          </div>
          <div className="ve-properties__field">
            <span className="ve-properties__field-label">Fade Out</span>
            <input
              type="number"
              min="0"
              max={duration}
              step="0.1"
              value={item.fadeOut}
              onChange={(e) => update('fadeOut', parseFloat(e.target.value) || 0)}
              className="ve-properties__input"
            />
          </div>
        </div>
      </div>

      {/* ── Volume (video & audio) ── */}
      {(item.type === 'video' || item.type === 'audio') && (
        <div className="ve-properties__section">
          <label className="ve-properties__label">Audio</label>
          <div className="ve-properties__slider-row">
            <span className="ve-properties__field-label">Volume</span>
            <input
              type="range"
              min="0"
              max="2"
              step="0.01"
              value={item.volume}
              onChange={(e) => update('volume', parseFloat(e.target.value))}
              className="ve-properties__slider"
            />
            <span className="ve-properties__slider-value">{Math.round(item.volume * 100)}%</span>
          </div>
          <div className="ve-properties__row">
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">Audio Fade In</span>
              <input
                type="number"
                min="0"
                max="5"
                step="0.1"
                value={item.fadeIn || 0}
                onChange={(e) => update('fadeIn', parseFloat(e.target.value) || 0)}
                className="ve-properties__input"
              />
            </div>
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">Audio Fade Out</span>
              <input
                type="number"
                min="0"
                max="5"
                step="0.1"
                value={item.fadeOut || 0}
                onChange={(e) => update('fadeOut', parseFloat(e.target.value) || 0)}
                className="ve-properties__input"
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Speed (video & audio) ── */}
      {(item.type === 'video' || item.type === 'audio') && (
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
      {(item.type !== 'audio') && (
        <div className="ve-properties__section">
          <label className="ve-properties__label">Opacity</label>
          <div className="ve-properties__slider-row">
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={item.opacity}
              onChange={(e) => update('opacity', parseFloat(e.target.value))}
              className="ve-properties__slider"
            />
            <span className="ve-properties__slider-value">{Math.round(item.opacity * 100)}%</span>
          </div>
        </div>
      )}

      {/* ── Transform (position, scale, rotation) ── */}
      {(item.type === 'image' || item.type === 'overlay' || item.type === 'text' || item.type === 'shape') && (
        <div className="ve-properties__section">
          <label className="ve-properties__label">Transform</label>
          <div className="ve-properties__row">
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">X %</span>
              <input
                type="number"
                min="0"
                max="100"
                value={item.position?.x || 0}
                onChange={(e) => update('position', { ...item.position, x: parseFloat(e.target.value) || 0 })}
                className="ve-properties__input"
              />
            </div>
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">Y %</span>
              <input
                type="number"
                min="0"
                max="100"
                value={item.position?.y || 0}
                onChange={(e) => update('position', { ...item.position, y: parseFloat(e.target.value) || 0 })}
                className="ve-properties__input"
              />
            </div>
          </div>
          <div className="ve-properties__row">
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">W %</span>
              <input
                type="number"
                min="1"
                max="200"
                value={item.size?.w || 100}
                onChange={(e) => update('size', { ...item.size, w: parseFloat(e.target.value) || 100 })}
                className="ve-properties__input"
              />
            </div>
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">H %</span>
              <input
                type="number"
                min="1"
                max="200"
                value={item.size?.h || 100}
                onChange={(e) => update('size', { ...item.size, h: parseFloat(e.target.value) || 100 })}
                className="ve-properties__input"
              />
            </div>
          </div>
          <div className="ve-properties__row">
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">Rotation</span>
              <input
                type="number"
                min="-360"
                max="360"
                value={item.transform?.rotation || 0}
                onChange={(e) => updateNested('transform', 'rotation', parseFloat(e.target.value) || 0)}
                className="ve-properties__input"
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Effects (video & image) ── */}
      {(item.type === 'video' || item.type === 'image' || item.type === 'overlay') && (
        <div className="ve-properties__section">
          <label className="ve-properties__label">Effects</label>
          {[
            { key: 'brightness', label: 'Brightness', min: -100, max: 100 },
            { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
            { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
            { key: 'blur', label: 'Blur', min: 0, max: 20 },
          ].map(ctrl => {
            const effects = item.effects || {};
            const val = effects[ctrl.key] ?? 0;
            return (
              <div key={ctrl.key} className="ve-properties__slider-row">
                <span className="ve-properties__field-label" style={{ minWidth: 60 }}>{ctrl.label}</span>
                <input
                  type="range"
                  min={ctrl.min}
                  max={ctrl.max}
                  step={ctrl.key === 'blur' ? '0.5' : '1'}
                  value={val}
                  onChange={(e) => {
                    const effects = { ...(item.effects || {}), [ctrl.key]: parseFloat(e.target.value) };
                    update('effects', effects);
                  }}
                  className="ve-properties__slider"
                />
                <span className="ve-properties__slider-value">{val}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Text styling ── */}
      {item.type === 'text' && (
        <div className="ve-properties__section">
          <label className="ve-properties__label">Text</label>
          <textarea
            value={item.textContent || ''}
            onChange={(e) => update('textContent', e.target.value)}
            className="ve-properties__textarea"
            rows={2}
            placeholder="Enter text..."
          />
          <div className="ve-properties__row">
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">Font</span>
              <select
                value={item.textStyle?.fontFamily || 'DM Sans'}
                onChange={(e) => updateNested('textStyle', 'fontFamily', e.target.value)}
                className="ve-properties__select"
              >
                {FONT_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">Size</span>
              <input
                type="number"
                min="8"
                max="200"
                value={item.textStyle?.fontSize || 48}
                onChange={(e) => updateNested('textStyle', 'fontSize', parseInt(e.target.value) || 48)}
                className="ve-properties__input"
              />
            </div>
          </div>
          <div className="ve-properties__row">
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">Color</span>
              <input
                type="color"
                value={item.textStyle?.color || '#FFFFFF'}
                onChange={(e) => updateNested('textStyle', 'color', e.target.value)}
                className="ve-properties__color"
              />
            </div>
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">Weight</span>
              <select
                value={item.textStyle?.fontWeight || 400}
                onChange={(e) => updateNested('textStyle', 'fontWeight', parseInt(e.target.value))}
                className="ve-properties__select"
              >
                <option value={400}>Regular</option>
                <option value={700}>Bold</option>
                <option value={900}>Black</option>
              </select>
            </div>
          </div>
          <div className="ve-properties__row">
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">Align</span>
              <select
                value={item.textStyle?.textAlign || 'center'}
                onChange={(e) => updateNested('textStyle', 'textAlign', e.target.value)}
                className="ve-properties__select"
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </div>
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">Animation</span>
              <select
                value={item.textStyle?.animation || 'none'}
                onChange={(e) => updateNested('textStyle', 'animation', e.target.value)}
                className="ve-properties__select"
              >
                {TEXT_ANIMATIONS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </div>
          </div>
          {/* Outline */}
          <div className="ve-properties__row">
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">Outline</span>
              <input
                type="number"
                min="0"
                max="10"
                value={item.textStyle?.outlineWidth || 0}
                onChange={(e) => updateNested('textStyle', 'outlineWidth', parseFloat(e.target.value) || 0)}
                className="ve-properties__input"
              />
            </div>
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">Outline Color</span>
              <input
                type="color"
                value={item.textStyle?.outlineColor || '#000000'}
                onChange={(e) => updateNested('textStyle', 'outlineColor', e.target.value)}
                className="ve-properties__color"
              />
            </div>
          </div>
          {/* Background */}
          <div className="ve-properties__row">
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">BG Color</span>
              <input
                type="color"
                value={item.textStyle?.bgColor || '#000000'}
                onChange={(e) => updateNested('textStyle', 'bgColor', e.target.value)}
                className="ve-properties__color"
              />
            </div>
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">BG Opacity</span>
              <input
                type="number"
                min="0"
                max="100"
                value={item.textStyle?.bgOpacity || 0}
                onChange={(e) => updateNested('textStyle', 'bgOpacity', parseInt(e.target.value) || 0)}
                className="ve-properties__input"
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Shape styling ── */}
      {item.type === 'shape' && (
        <div className="ve-properties__section">
          <label className="ve-properties__label">Shape</label>
          <div className="ve-properties__row">
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">Type</span>
              <select
                value={item.shapeType || 'rectangle'}
                onChange={(e) => update('shapeType', e.target.value)}
                className="ve-properties__select"
              >
                {SHAPE_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="ve-properties__row">
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">Fill</span>
              <input
                type="color"
                value={item.shapeStyle?.fillColor || '#FF3B30'}
                onChange={(e) => updateNested('shapeStyle', 'fillColor', e.target.value)}
                className="ve-properties__color"
              />
            </div>
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">Stroke</span>
              <input
                type="color"
                value={item.shapeStyle?.strokeColor || '#FFFFFF'}
                onChange={(e) => updateNested('shapeStyle', 'strokeColor', e.target.value)}
                className="ve-properties__color"
              />
            </div>
          </div>
          <div className="ve-properties__row">
            <div className="ve-properties__field">
              <span className="ve-properties__field-label">Stroke Width</span>
              <input
                type="number"
                min="0"
                max="20"
                value={item.shapeStyle?.strokeWidth || 2}
                onChange={(e) => updateNested('shapeStyle', 'strokeWidth', parseFloat(e.target.value) || 0)}
                className="ve-properties__input"
              />
            </div>
            {item.shapeType === 'rectangle' && (
              <div className="ve-properties__field">
                <span className="ve-properties__field-label">Radius</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={item.shapeStyle?.cornerRadius || 0}
                  onChange={(e) => updateNested('shapeStyle', 'cornerRadius', parseFloat(e.target.value) || 0)}
                  className="ve-properties__input"
                />
              </div>
            )}
          </div>
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
              <div className="ve-properties__field">
                <span className="ve-properties__field-label">Duration</span>
                <input
                  type="number"
                  min="0.1"
                  max="3"
                  step="0.1"
                  value={item.transition?.duration || 0.5}
                  onChange={(e) => update('transition', {
                    ...item.transition,
                    duration: parseFloat(e.target.value) || 0.5,
                  })}
                  className="ve-properties__input"
                />
              </div>
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
