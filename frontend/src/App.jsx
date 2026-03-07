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

export default function App() {
  const [cloudReady, setCloudReady] = useState(false);

  // Pull cloud settings before rendering pages so localStorage is populated
  useEffect(() => {
    pullFromCloud().finally(() => setCloudReady(true));
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
  );
}
