import React from 'react';

// All icons: 20x20 viewBox, stroke-based, 1.5px stroke weight (SF Symbols aesthetic)
// Use currentColor for fill/stroke to inherit from parent

export function HomeIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 7.5L10 2l7 5.5v8.5a1 1 0 01-1 1H4a1 1 0 01-1-1V7.5z" />
      <path d="M7.5 17V11h5v6" />
    </svg>
  );
}

export function UploadIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 13.5v2a1.5 1.5 0 001.5 1.5h11a1.5 1.5 0 001.5-1.5v-2" />
      <path d="M10 13V3" />
      <path d="M6 7l4-4 4 4" />
    </svg>
  );
}

export function FilmIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="2" y="3" width="16" height="14" rx="1.5" />
      <path d="M2 7h16M2 13h16M6 3v4M6 13v4M14 3v4M14 13v4" />
    </svg>
  );
}

export function ListIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 5h14M3 10h14M3 15h10" />
    </svg>
  );
}

export function GearIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 1.5l1.1 2.2a1 1 0 00.9.5h2.5l-1.2 2a1 1 0 000 1.1l1.2 2h-2.5a1 1 0 00-.9.5L10 12l-1.1-2.2a1 1 0 00-.9-.5H5.5l1.2-2a1 1 0 000-1.1l-1.2-2H8a1 1 0 00.9-.5L10 1.5z" />
      <path d="M16.5 10a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" strokeOpacity="0" />
    </svg>
  );
}

export function PlayIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" stroke="none" {...props}>
      <path d="M5.5 3.5a1 1 0 011.5-.87l10 6a1 1 0 010 1.74l-10 6A1 1 0 015.5 15.5v-12z" />
    </svg>
  );
}

export function PauseIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" stroke="none" {...props}>
      <rect x="4" y="3" width="4" height="14" rx="1" />
      <rect x="12" y="3" width="4" height="14" rx="1" />
    </svg>
  );
}

export function SkipBackIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M16 15l-7-5 7-5v10z" fill="currentColor" stroke="none" />
      <path d="M4 5v10" />
    </svg>
  );
}

export function SkipForwardIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 5l7 5-7 5V5z" fill="currentColor" stroke="none" />
      <path d="M16 5v10" />
    </svg>
  );
}

export function VolumeIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 8v4h3l4 3.5V4.5L6 8H3z" fill="currentColor" strokeWidth="0" />
      <path d="M14 7a3.5 3.5 0 010 6" />
      <path d="M16 5a6.5 6.5 0 010 10" />
    </svg>
  );
}

export function VolumeOffIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 8v4h3l4 3.5V4.5L6 8H3z" fill="currentColor" strokeWidth="0" />
      <path d="M14 7.5l4 5M18 7.5l-4 5" />
    </svg>
  );
}

export function FullscreenIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 7V4a1 1 0 011-1h3M13 3h3a1 1 0 011 1v3M17 13v3a1 1 0 01-1 1h-3M7 17H4a1 1 0 01-1-1v-3" />
    </svg>
  );
}

export function ExitFullscreenIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M7 3v3a1 1 0 01-1 1H3M13 3v3a1 1 0 001 1h3M3 13h3a1 1 0 011 1v3M17 13h-3a1 1 0 00-1 1v3" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M7 4l6 6-6 6" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 7l6 6 6-6" />
    </svg>
  );
}

export function SearchIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="8.5" cy="8.5" r="5.5" />
      <path d="M13 13l4 4" />
    </svg>
  );
}

export function XIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 5l10 10M15 5L5 15" />
    </svg>
  );
}

export function PlusIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M10 3v14M3 10h14" />
    </svg>
  );
}

export function DownloadIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 13.5v2a1.5 1.5 0 001.5 1.5h11a1.5 1.5 0 001.5-1.5v-2" />
      <path d="M10 3v10" />
      <path d="M6 10l4 4 4-4" />
    </svg>
  );
}

export function TrashIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 5h14M7 5V3.5A1.5 1.5 0 018.5 2h3A1.5 1.5 0 0113 3.5V5" />
      <path d="M5 5l1 12a1.5 1.5 0 001.5 1.5h5A1.5 1.5 0 0014 17l1-12" />
      <path d="M8 8.5v6M12 8.5v6" />
    </svg>
  );
}

export function StarIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M10 2l2.4 5 5.6.8-4 3.9 1 5.5L10 14.5l-5 2.7 1-5.5-4-3.9 5.6-.8L10 2z" />
    </svg>
  );
}

export function SparkleIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" stroke="none" {...props}>
      <path d="M10 1l1.8 5.7L17.5 8l-5.7 1.3L10 15l-1.8-5.7L2.5 8l5.7-1.3L10 1z" />
      <path d="M15 12l.8 2.5 2.7.5-2.7.5-.8 2.5-.8-2.5L11.5 15l2.7-.5L15 12z" opacity="0.6" />
    </svg>
  );
}

export function SpeakerIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="10" cy="7" r="3.5" />
      <path d="M3 17.5c0-3.5 3.1-6.5 7-6.5s7 3 7 6.5" />
    </svg>
  );
}

export function ChevronLeftIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M13 4l-6 6 6 6" />
    </svg>
  );
}

export function SidebarCollapseIcon({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="2" y="3" width="16" height="14" rx="2" />
      <path d="M7 3v14" />
    </svg>
  );
}
