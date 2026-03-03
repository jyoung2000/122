import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import ProviderStatus from './ProviderStatus';
import ConnectionStatus from './ConnectionStatus';
import useResponsive from '../hooks/useResponsive';
import useTheme from '../hooks/useTheme';
import useConnectionStatus from '../hooks/useConnectionStatus';
import useEncodingManager from '../hooks/useEncodingManager';
import {
  HomeIcon, UploadIcon, FilmIcon, ListIcon, GearIcon,
  SidebarCollapseIcon, SparkleIcon,
} from './icons';

const NAV_ITEMS = [
  { path: '/', label: 'Dashboard', Icon: HomeIcon },
  { path: '/upload', label: 'Upload', Icon: UploadIcon },
  { path: '/clips', label: 'Clips', Icon: FilmIcon },
  { path: '/logs', label: 'Logs', Icon: ListIcon },
  { path: '/settings', label: 'Settings', Icon: GearIcon },
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
  const [modelHover, setModelHover] = useState(false);
  const location = useLocation();
  const { isMobile, isTablet } = useResponsive();
  const { isDark, toggleTheme } = useTheme();
  const connStatus = useConnectionStatus();
  const { activeCount, latestActivity } = useEncodingManager();

  // Auto-collapse sidebar on tablet
  useEffect(() => {
    if (isTablet && !collapsed) setCollapsed(true);
  }, [isTablet]);

  // Poll /api/allocation to detect any active container activity
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

  const isDisconnected = connStatus.status === 'disconnected';
  const isProcessing = activeCount > 0 || containerActive;
  const systemDotColor = isDisconnected ? 'var(--danger)'
    : isProcessing ? 'var(--success)' : 'var(--text-muted)';
  const systemDotPulse = isDisconnected || isProcessing;

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
        fontSize: 14,
        width: 32,
        height: 32,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'all 0.2s ease',
        flexShrink: 0,
      }}
    >
      {isDark ? '\u2600\uFE0E' : '\u263D'}
    </button>
  );

  // Activity dot with AI shimmer when processing
  const activityDot = (
    <span
      title={isDisconnected ? 'Disconnected' : isProcessing ? 'Processing...' : 'Idle'}
      style={{
        width: 6, height: 6, borderRadius: '50%',
        background: isProcessing
          ? 'var(--ai-gradient, var(--success))'
          : systemDotColor,
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
          background: 'var(--glass-bg)',
          backdropFilter: 'blur(24px) saturate(180%)',
          WebkitBackdropFilter: 'blur(24px) saturate(180%)',
          borderRight: '1px solid var(--glass-border)',
          boxShadow: 'inset -1px 0 0 var(--bg-surface-1)',
          display: 'flex',
          flexDirection: 'column',
          transition: 'width 0.3s var(--ease-spring)',
          flexShrink: 0,
          zIndex: 30,
        }}
      >
        {/* Logo */}
        <div
          style={{
            padding: collapsed ? '16px 12px' : '16px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'space-between',
            gap: 8,
            minHeight: 56,
          }}
        >
          {!collapsed ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {/* Gradient icon */}
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--ai-gradient)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 14,
                  color: '#fff',
                  flexShrink: 0,
                }}
              >
                <SparkleIcon size={16} />
              </div>
              <span
                style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 600,
                  fontSize: 16,
                  letterSpacing: '-0.02em',
                  color: 'var(--text-primary)',
                }}
              >
                ClipAI
              </span>
            </div>
          ) : (
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 'var(--radius-sm)',
                background: 'var(--ai-gradient)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                color: '#fff',
                flexShrink: 0,
              }}
            >
              <SparkleIcon size={16} />
            </div>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              padding: 4,
              borderRadius: 'var(--radius-xs)',
              display: collapsed ? 'none' : 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'color 0.15s, background 0.15s',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => e.currentTarget.style.color = 'var(--text-secondary)'}
            onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-muted)'}
          >
            <SidebarCollapseIcon size={18} />
          </button>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: '8px 0' }}>
          {NAV_ITEMS.map((item) => {
            const isActive = location.pathname === item.path
              || (item.path === '/clips' && location.pathname.startsWith('/clips'))
              || (item.path === '/' && location.pathname.startsWith('/analysis'))
              || (item.path === '/clips' && location.pathname.startsWith('/seo'));
            const isLogs = item.path === '/logs';
            const Icon = item.Icon;
            return (
              <Link
                key={item.path}
                to={item.path}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: collapsed ? '10px 0' : '8px 12px',
                  margin: collapsed ? '2px 0' : '2px 8px',
                  justifyContent: collapsed ? 'center' : 'flex-start',
                  color: isActive ? 'var(--accent-cyan)' : 'var(--text-secondary)',
                  background: isActive ? 'var(--accent-cyan-dim)' : 'transparent',
                  borderRadius: collapsed ? 0 : 'var(--radius-sm)',
                  textDecoration: 'none',
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 400,
                  transition: 'all 0.2s var(--ease-quick)',
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
                    position: 'relative',
                    flexShrink: 0,
                  }}
                >
                  <Icon size={18} style={{
                    color: isActive ? 'var(--accent-cyan)' : 'var(--text-muted)',
                    transition: 'color 0.2s ease',
                  }} />
                  {/* Active encoding badge on Logs nav */}
                  {isLogs && activeCount > 0 && (
                    <span style={{
                      position: 'absolute', top: -2, right: -4,
                      width: 14, height: 14, borderRadius: '50%',
                      background: 'var(--accent-amber)', color: '#fff',
                      fontSize: 8, fontWeight: 700, fontFamily: 'var(--font-mono)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      animation: 'pulse 1.5s ease-in-out infinite',
                    }}>
                      {activeCount}
                    </span>
                  )}
                </span>
                {!collapsed && <span>{item.label}</span>}
              </Link>
            );
          })}
        </nav>

        {/* Theme toggle + collapse toggle (when collapsed) */}
        <div style={{
          padding: collapsed ? '8px 0' : '8px 16px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: collapsed ? 'center' : 'flex-start',
          gap: 8,
        }}>
          {collapsed && (
            <button
              onClick={() => setCollapsed(false)}
              title="Expand sidebar"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                padding: 6,
                borderRadius: 'var(--radius-xs)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <SidebarCollapseIcon size={18} />
            </button>
          )}
          {!collapsed && themeToggleBtn}
        </div>

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
            background: 'var(--glass-bg)',
            backdropFilter: 'blur(24px) saturate(180%)',
            WebkitBackdropFilter: 'blur(24px) saturate(180%)',
            borderBottom: '1px solid var(--glass-border)',
            flexDirection: 'column',
            gap: 6,
            position: 'sticky',
            top: 0,
            zIndex: 40,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  background: 'var(--ai-gradient)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#fff',
                  flexShrink: 0,
                }}
              >
                <SparkleIcon size={13} />
              </div>
              <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.02em' }}>
                {pageName}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {activityDot}
              {themeToggleBtn}
            </div>
          </div>
          {/* Mobile activity ticker */}
          {latestActivity && activeCount > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 8px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius-sm)',
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
            padding: '10px 24px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--glass-bg)',
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 13,
            color: 'var(--text-secondary)',
            gap: 12,
            minHeight: 48,
            position: 'relative',
            zIndex: 100,
          }}
        >
          <span style={{
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: 'var(--text-primary)',
            flexShrink: 0,
          }}>
            {pageName}
          </span>

          {/* Center activity */}
          <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {activityDot}
            {isProcessing && latestActivity && (
              <span style={{
                fontSize: 11,
                color: 'var(--text-muted)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 200,
              }}>
                {latestActivity.message}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            {/* Model status as compact chip with tooltip */}
            {activeModel && activeModel.provider !== 'none' && (
              <div
                style={{ position: 'relative' }}
                onMouseEnter={() => setModelHover(true)}
                onMouseLeave={() => setModelHover(false)}
              >
                <Link
                  to="/settings"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 10px',
                    background: 'var(--bg-surface-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-xl)',
                    textDecoration: 'none',
                    fontSize: 11,
                    fontWeight: 500,
                    color: 'var(--text-secondary)',
                    transition: 'border-color 0.2s, background 0.2s',
                  }}
                >
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: 'var(--success)',
                    flexShrink: 0,
                  }} />
                  <span>AI Models</span>
                </Link>
                {/* Tooltip with full model info */}
                {modelHover && (
                  <div style={{
                    position: 'absolute',
                    top: '100%',
                    right: 0,
                    marginTop: 6,
                    padding: '10px 14px',
                    background: 'var(--glass-bg)',
                    backdropFilter: 'blur(20px) saturate(180%)',
                    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                    border: '1px solid var(--glass-border)',
                    borderRadius: 'var(--radius-md)',
                    boxShadow: 'var(--shadow-lg)',
                    fontSize: 11,
                    fontFamily: 'var(--font-mono)',
                    whiteSpace: 'nowrap',
                    zIndex: 100,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    minWidth: 180,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: 'var(--accent-amber)', fontWeight: 600 }}>T:</span>
                      <span style={{ color: 'var(--text-secondary)' }}>{activeModel.transcript_model || 'whisper-base'}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: 'var(--accent-cyan)', fontWeight: 600 }}>V:</span>
                      <span style={{ color: 'var(--text-secondary)' }}>{activeModel.vision_model ? shortModel(activeModel.vision_model) : '\u2014'}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: 'var(--success)', fontWeight: 600 }}>Tx:</span>
                      <span style={{ color: 'var(--text-secondary)' }}>{activeModel.text_model ? shortModel(activeModel.text_model) : '\u2014'}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
            {themeToggleBtn}
          </div>
        </header>

        <div className="page-enter" style={{ padding: 'var(--page-pad)', flex: 1 }}>
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
          background: 'var(--glass-bg)',
          backdropFilter: 'blur(24px) saturate(180%)',
          WebkitBackdropFilter: 'blur(24px) saturate(180%)',
          borderTop: '1px solid var(--glass-border)',
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
          const Icon = item.Icon;
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
              {/* Active indicator pill */}
              {isActive && (
                <span style={{
                  position: 'absolute',
                  top: 0,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: 32,
                  height: 4,
                  borderRadius: 2,
                  background: 'var(--accent-cyan)',
                }} />
              )}
              <span style={{ position: 'relative', lineHeight: 1 }}>
                <Icon size={22} />
                {isLogs && activeCount > 0 && (
                  <span style={{
                    position: 'absolute', top: -4, right: -8,
                    width: 14, height: 14, borderRadius: '50%',
                    background: 'var(--accent-amber)', color: '#fff',
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
