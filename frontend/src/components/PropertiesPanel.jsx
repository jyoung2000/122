import React, { useCallback, useMemo } from 'react';
import useTimelineStore from '../stores/timelineStore';

const SPEED_PRESETS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 4.0];
const BLEND_MODES = ['Normal', 'Multiply', 'Screen', 'Overlay'];

function formatTime(s) {
  if (!s || isNaN(s) || s < 0) return '0:00.00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 100);
  return `${m}:${sec.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

export default function PropertiesPanel({ compact = false }) {
  const selectedItemId = useTimelineStore((s) => s.selectedItemId);
  const items = useTimelineStore((s) => s.items);
  const updateItemWithSnapshot = useTimelineStore((s) => s.updateItemWithSnapshot);
  const removeItem = useTimelineStore((s) => s.removeItem);

  const item = useMemo(
    () => items.find((i) => i.id === selectedItemId) || null,
    [items, selectedItemId],
  );

  const update = useCallback(
    (field, value) => {
      if (!item) return;
      updateItemWithSnapshot(item.id, { [field]: value });
    },
    [item, updateItemWithSnapshot],
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

      {/* Timing */}
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

      {/* Fades */}
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

      {/* Volume (video & audio) */}
      {(item.type === 'video' || item.type === 'audio') && (
        <div className="ve-properties__section">
          <label className="ve-properties__label">Volume</label>
          <div className="ve-properties__slider-row">
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
        </div>
      )}

      {/* Speed (video & audio) */}
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

      {/* Opacity (all visual items) */}
      {(item.type === 'video' || item.type === 'image' || item.type === 'overlay') && (
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

      {/* Position & Size (image/overlay) */}
      {(item.type === 'image' || item.type === 'overlay') && (
        <div className="ve-properties__section">
          <label className="ve-properties__label">Position & Size</label>
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
        </div>
      )}

      {/* Subtitle text */}
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
    </div>
  );
}
