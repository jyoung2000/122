import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import ProviderStatus from './ProviderStatus';
import ConnectionStatus from './ConnectionStatus';
import useResponsive from '../hooks/useResponsive';
import useTheme from '../hooks/useTheme';
import useConnectionStatus from '../hooks/useConnectionStatus';
import useEncodingManager from '../hooks/useEncodingManager';

const NAV_ITEMS = [
  { path: '/', label: 'Dashboard', icon: 'D', mobileIcon: '\u25A3' },
  { path: '/upload', label: 'Upload', icon: 'U', mobileIcon: '\u2B06' },
  { path: '/clips', label: 'Clips', icon: 'V', mobileIcon: '\u25B6' },
  { path: '/logs', label: 'Logs', icon: 'L', mobileIcon: '\u2630' },
  { path: '/settings', label: 'Settings', icon: 'S', mobileIcon: '\u2699' },
];

function shortModel(modelId) {
  if (!modelId) return '';
  let name = modelId;
  if (name.includes('/')) name = name.split('/').pop();
  name = name.replace(/:free$/, '');
  return name;
}

export default function Layout({ children }) {
  const [collapsed, setCollapsed] = useState(false);
  const [activeModel, setActiveModel] = useState(null);
  const location = useLocation();
  const { isMobile } = useResponsive();
  const { isDark, toggleTheme } = useTheme();
  const connStatus = useConnectionStatus();
  const { activeCount, latestActivity } = useEncodingManager();

  // Poll /api/allocation to detect any active container activity
  // (analysis, transcription, clip detection, exports, etc.)
  const [containerActive, setContainerActive] = useState(false);
  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const res = await fetch('/api/allocation');
        if (res.ok && mounted) {
          const data = await res.json();
          setContainerActive((data.active_jobs || []).length > 0);
        }
      } catch {}
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { mounted = false; clearInterval(id); };
  }, []);

  const pageName = location.pathname === '/' ? 'Dashboard'
    : location.pathname.startsWith('/upload') ? 'Upload'
    : location.pathname.startsWith('/clips') ? 'Viral Clips'
    : location.pathname.startsWith('/logs') ? 'Logs & Exports'
    : location.pathname.startsWith('/settings') ? 'Settings'
    : location.pathname.startsWith('/analysis') ? 'Analysis'
    : location.pathname.startsWith('/seo') ? 'Clip Editor'
    : '';

  const themeToggleBtn = (
    <button
      onClick={() => {
        document.documentElement.classList.add('theme-transition');
        toggleTheme();
        setTimeout(() => document.documentElement.classList.remove('theme-transition'), 350);
      }}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--text-secondary)',
        fontSize: 16,
        width: 34,
        height: 34,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'all 0.2s ease',
        flexShrink: 0,
      }}
    >
      {isDark ? '\u2600' : '\u263D'}
    </button>
  );

  // System status: green pulsing = active/processing, grey = idle, red pulsing = stopped/disconnected
  const isDisconnected = connStatus.status === 'disconnected';
  const isProcessing = activeCount > 0 || containerActive;
  const systemDotColor = isDisconnected ? 'var(--danger)'
    : isProcessing ? 'var(--success)' : 'var(--text-muted)';
  const systemDotPulse = isDisconnected || isProcessing;

  // System status dot — green pulsing = processing, grey = idle, red pulsing = disconnected
  const activityTicker = (
    <span
      style={{
        width: 8, height: 8, borderRadius: '50%',
        background: systemDotColor,
        animation: systemDotPulse ? 'pulse 1.5s ease-in-out infinite' : 'none',
        flexShrink: 0,
        transition: 'background 0.3s ease',
        display: 'inline-block',
      }}
    />
  );

  return (
    <div style={{ display: 'flex', minHeight: '100vh', flexDirection: isMobile ? 'column' : 'row' }}>
      {/* ═══ Desktop Sidebar ═══ */}
      <aside
        className="desktop-sidebar"
        style={{
          width: collapsed ? 64 : 240,
          background: 'var(--bg-panel)',
          backdropFilter: 'blur(20px) saturate(180%)',
          WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          borderRight: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          transition: 'width 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
          flexShrink: 0,
        }}
      >
        {/* Logo */}
        <div
          style={{
            padding: '16px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'space-between',
          }}
        >
          {!collapsed && (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontWeight: 700,
                fontSize: 18,
                color: 'var(--accent-cyan)',
                letterSpacing: '0.02em',
              }}
            >
              CLIP<span style={{ color: 'var(--text-primary)' }}>AI</span>
            </span>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              fontSize: 16,
              padding: 6,
              borderRadius: 'var(--radius-sm)',
              transition: 'background 0.15s',
            }}
          >
            {collapsed ? '\u276F' : '\u276E'}
          </button>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: '8px 0' }}>
          {NAV_ITEMS.map((item) => {
            const isActive = location.pathname === item.path
              || (item.path === '/clips' && location.pathname.startsWith('/clips'));
            const isLogs = item.path === '/logs';
            return (
              <Link
                key={item.path}
                to={item.path}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: collapsed ? '12px 0' : '10px 16px',
                  margin: collapsed ? 0 : '2px 8px',
                  justifyContent: collapsed ? 'center' : 'flex-start',
                  color: isActive ? 'var(--accent-cyan)' : 'var(--text-secondary)',
                  background: isActive ? 'var(--accent-cyan-dim)' : 'transparent',
                  borderRadius: collapsed ? 0 : 'var(--radius-sm)',
                  textDecoration: 'none',
                  fontSize: 14,
                  fontWeight: isActive ? 600 : 400,
                  transition: 'all 0.2s ease',
                  letterSpacing: '-0.01em',
                  position: 'relative',
                }}
              >
                <span
                  style={{
                    width: 28,
                    height: 28,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 700,
                    fontSize: 12,
                    background: isActive ? 'var(--accent-cyan)' : 'var(--bg-elevated)',
                    color: isActive ? 'var(--nav-active-icon-text)' : 'var(--text-secondary)',
                    borderRadius: 'var(--radius-xs)',
                    position: 'relative',
                  }}
                >
                  {item.icon}
                  {/* Active encoding badge on Logs nav */}
                  {isLogs && activeCount > 0 && (
                    <span style={{
                      position: 'absolute', top: -4, right: -4,
                      width: 14, height: 14, borderRadius: '50%',
                      background: 'var(--accent-amber)', color: 'var(--bg-base)',
                      fontSize: 8, fontWeight: 700, fontFamily: 'var(--font-mono)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      animation: 'pulse 1.5s ease-in-out infinite',
                    }}>
                      {activeCount}
                    </span>
                  )}
                </span>
                {!collapsed && item.label}
              </Link>
            );
          })}
        </nav>

        {/* Theme toggle in sidebar */}
        {!collapsed && (
          <div style={{ padding: '8px 16px' }}>
            {themeToggleBtn}
          </div>
        )}

        {/* Provider Status */}
        <ProviderStatus collapsed={collapsed} onActiveChange={setActiveModel} />
      </aside>

      {/* ═══ Main Content ═══ */}
      <main
        className="main-content"
        style={{
          flex: 1,
          overflow: 'auto',
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Connection status banner (visible only when disconnected/reconnecting) */}
        <ConnectionStatus status={connStatus.status} latency={connStatus.latency} />

        {/* Mobile Header */}
        <header
          className="mobile-header"
          style={{
            display: 'none',
            padding: '10px var(--page-pad)',
            background: 'var(--bg-panel)',
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
            borderBottom: '1px solid var(--border)',
            flexDirection: 'column',
            gap: 6,
            position: 'sticky',
            top: 0,
            zIndex: 40,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.02em' }}>
              {pageName}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {/* Connection dot */}
              <span
                title={connStatus.status}
                style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: connStatus.status === 'connected' ? 'var(--success)'
                    : connStatus.status === 'reconnecting' ? 'var(--accent-amber)'
                    : 'var(--danger)',
                  flexShrink: 0,
                  animation: connStatus.status !== 'connected' ? 'pulse 1.5s ease-in-out infinite' : undefined,
                }}
              />
              {themeToggleBtn}
            </div>
          </div>
          {/* Mobile activity ticker */}
          {latestActivity && activeCount > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 8px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)',
              overflow: 'hidden',
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: 'var(--accent-amber)',
                animation: 'pulse 1.5s ease-in-out infinite',
                flexShrink: 0,
              }} />
              <span style={{
                fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {latestActivity.message}
              </span>
            </div>
          )}
        </header>

        {/* Desktop Header */}
        <header
          className="desktop-header"
          style={{
            padding: '12px 24px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 13,
            color: 'var(--text-secondary)',
            gap: 12,
          }}
        >
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', flexShrink: 0 }}>
            {location.pathname === '/' ? 'dashboard' : location.pathname.slice(1).replace(/\//g, ' / ')}
          </span>

          {/* Center activity ticker */}
          <div style={{ flex: 1, display: 'flex', justifyContent: 'center', minWidth: 0 }}>
            {activityTicker}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            {activeModel && activeModel.provider !== 'none' && (
              <Link
                to="/settings"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '4px 12px',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  textDecoration: 'none',
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-secondary)',
                  transition: 'border-color 0.2s',
                }}
                title="Click to change AI models"
              >
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', flexShrink: 0 }} />
                <span><span style={{ color: 'var(--accent-amber)' }}>T:</span> {activeModel.transcript_model || 'whisper-base'}</span>
                <span style={{ color: 'var(--border-strong)' }}>|</span>
                <span><span style={{ color: 'var(--accent-cyan)' }}>V:</span> {activeModel.vision_model ? shortModel(activeModel.vision_model) : '\u2014'}</span>
                <span style={{ color: 'var(--border-strong)' }}>|</span>
                <span><span style={{ color: 'var(--success)' }}>Tx:</span> {activeModel.text_model ? shortModel(activeModel.text_model) : '\u2014'}</span>
              </Link>
            )}
            {/* Connection status is shown by the system dot in the center ticker */}
            {themeToggleBtn}
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent-cyan)' }}>
              v1.0
            </span>
          </div>
        </header>

        <div style={{ padding: 'var(--page-pad)', flex: 1 }}>
          {children}
        </div>
      </main>

      {/* ═══ Mobile Bottom Tab Bar ═══ */}
      <nav
        className="mobile-bottom-nav"
        style={{
          display: 'none',
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          height: 'calc(68px + var(--safe-bottom))',
          paddingBottom: 'var(--safe-bottom)',
          background: 'var(--bg-panel)',
          backdropFilter: 'blur(24px) saturate(180%)',
          WebkitBackdropFilter: 'blur(24px) saturate(180%)',
          borderTop: '1px solid var(--border)',
          alignItems: 'flex-start',
          justifyContent: 'space-around',
          paddingTop: 8,
          zIndex: 50,
        }}
      >
        {NAV_ITEMS.map((item) => {
          const isActive = location.pathname === item.path
            || (item.path === '/clips' && location.pathname.startsWith('/clips'))
            || (item.path === '/logs' && location.pathname.startsWith('/logs'))
            || (item.path === '/' && location.pathname.startsWith('/analysis'))
            || (item.path === '/clips' && location.pathname.startsWith('/seo'));
          const isLogs = item.path === '/logs';
          return (
            <Link
              key={item.path}
              to={item.path}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 3,
                textDecoration: 'none',
                color: isActive ? 'var(--accent-cyan)' : 'var(--text-muted)',
                fontSize: 10,
                fontWeight: isActive ? 600 : 400,
                padding: '4px 16px',
                transition: 'color 0.15s',
                minWidth: 60,
                position: 'relative',
              }}
            >
              <span style={{ fontSize: 22, lineHeight: 1, position: 'relative' }}>
                {item.mobileIcon}
                {isLogs && activeCount > 0 && (
                  <span style={{
                    position: 'absolute', top: -4, right: -8,
                    width: 14, height: 14, borderRadius: '50%',
                    background: 'var(--accent-amber)', color: 'var(--bg-base)',
                    fontSize: 8, fontWeight: 700, fontFamily: 'var(--font-mono)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    animation: 'pulse 1.5s ease-in-out infinite',
                  }}>
                    {activeCount}
                  </span>
                )}
              </span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
