import React from 'react';
import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Upload from './pages/Upload';
import Analysis from './pages/Analysis';
import ViralClips from './pages/ViralClips';
import Logs from './pages/Logs';
import Settings from './pages/Settings';
import ClipSEO from './pages/ClipSEO';
import ToastContainer from './components/Toast';
import { EncodingProvider } from './hooks/useEncodingManager';

export default function App() {
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
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </Layout>
    </EncodingProvider>
  );
}
