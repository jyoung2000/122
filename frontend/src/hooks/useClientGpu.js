import { useState, useEffect } from 'react';

/**
 * Hook for reading the client GPU preferences from localStorage.
 * Settings.jsx is the producer — this hook is the consumer.
 */
export function useClientGpuPreferences() {
  const [prefs, setPrefs] = useState({
    enabled: false,
    selectedGpuId: '',
    selectedGpuName: '',
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

    // Listen for changes from other tabs and same-tab updates
    window.addEventListener('storage', load);
    window.addEventListener('clientgpu-changed', load);
    return () => {
      window.removeEventListener('storage', load);
      window.removeEventListener('clientgpu-changed', load);
    };
  }, []);

  const shouldUseClientWhisper = prefs.enabled && prefs.whisperEnabled;
  const shouldUseClientEncoding = prefs.enabled && prefs.encodingEnabled;

  return { ...prefs, shouldUseClientWhisper, shouldUseClientEncoding };
}
