import { useState, useCallback } from 'react';

const STORAGE_KEY = 'clipai-theme';

function getInitialTheme() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return stored;
  // Default to dark for video editing (accurate color perception)
  if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}

export default function useTheme() {
  const [theme, setTheme] = useState(() => {
    // Sync with what's already on the DOM (set by inline script in index.html)
    const domTheme = document.documentElement.dataset.theme;
    const initial = getInitialTheme();
    if (domTheme !== initial) {
      document.documentElement.dataset.theme = initial;
    }
    return initial;
  });

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }, []);

  return { theme, toggleTheme, isDark: theme === 'dark' };
}
