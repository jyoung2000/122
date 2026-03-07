import React, { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Upload from './pages/Upload';
import Analysis from './pages/Analysis';
import ViralClips from './pages/ViralClips';
import Logs from './pages/Logs';
import Settings from './pages/Settings';
import ClipSEO from './pages/ClipSEO';
import MediaLibrary from './pages/MediaLibrary';
import ToastContainer from './components/Toast';
import { EncodingProvider } from './hooks/useEncodingManager';
// Import installs localStorage monkey-patches for auto-sync
import { pullFromCloud } from './utils/cloudSync';

// ── Error Boundary — prevents blank page on unhandled errors ──
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Uncaught error:', error, info?.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 48, textAlign: 'center', fontFamily: 'system-ui, sans-serif', color: '#ccc', background: '#0a0a0f', minHeight: '100vh' }}>
          <h2 style={{ color: '#ef4444', marginBottom: 16 }}>Something went wrong</h2>
          <p style={{ fontSize: 14, marginBottom: 12, color: '#888' }}>
            {this.state.error?.message || 'An unexpected error occurred.'}
          </p>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
            style={{ padding: '8px 24px', fontSize: 14, background: '#00D9FF', color: '#000', border: 'none', borderRadius: 6, cursor: 'pointer' }}
          >
            Reload Page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [cloudReady, setCloudReady] = useState(false);

  // Pull cloud settings before rendering pages so localStorage is populated
  // Uses a hard timeout so the app never stays blank indefinitely
  useEffect(() => {
    const timeout = setTimeout(() => setCloudReady(true), 3000);
    pullFromCloud().finally(() => {
      clearTimeout(timeout);
      setCloudReady(true);
    });
  }, []);

  // Apply site customisation (title, favicon) on load
  useEffect(() => {
    fetch('/api/site-config')
      .then((r) => r.json())
      .then((cfg) => {
        if (cfg.title) document.title = cfg.title;
        if (cfg.favicon) {
          let link = document.querySelector("link[rel~='icon']");
          if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
          link.href = `/api/site-uploads/${cfg.favicon}`;
        }
      })
      .catch(() => {});
  }, []);

  // Wait for cloud settings before rendering pages that read localStorage
  if (!cloudReady) return null;

  return (
    <ErrorBoundary>
      <EncodingProvider>
        <ToastContainer />
        <Layout>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/upload" element={<Upload />} />
            <Route path="/clips" element={<ViralClips />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/analysis/:jobId" element={<Analysis />} />
            <Route path="/seo/:jobId/:clipId" element={<ClipSEO />} />
            <Route path="/media" element={<MediaLibrary />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </Layout>
      </EncodingProvider>
    </ErrorBoundary>
  );
}
