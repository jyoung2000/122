import { useState, useEffect } from 'react';

/**
 * Hook for reading the client GPU preferences from localStorage.
 * Settings.jsx is the producer — this hook is the consumer.
 */
export function useClientGpuPreferences() {
  const [prefs, setPrefs] = useState({
    enabled: false,
    selectedGpuId: '',
    whisperEnabled: true,
    encodingEnabled: true,
  });

  useEffect(() => {
    const load = () => {
      try {
        const saved = localStorage.getItem('clipai_client_gpu');
        if (saved) setPrefs(JSON.parse(saved));
      } catch { /* ignore */ }
    };
    load();

    // Listen for changes from other tabs/components
    window.addEventListener('storage', load);
    return () => window.removeEventListener('storage', load);
  }, []);

  const shouldUseClientWhisper = prefs.enabled && prefs.whisperEnabled;
  const shouldUseClientEncoding = prefs.enabled && prefs.encodingEnabled;

  return { ...prefs, shouldUseClientWhisper, shouldUseClientEncoding };
}
