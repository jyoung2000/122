import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import useResponsive from '../hooks/useResponsive';
import { SearchIcon } from '../components/icons';

function formatDuration(seconds) {
  if (!seconds) return '-';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

const STATUS_STYLES = {
  queued: { className: 'badge-gray', label: 'Queued' },
  extracting_frames: { className: 'badge-cyan pulse', label: 'Processing' },
  transcribing: { className: 'badge-cyan pulse', label: 'Processing' },
  analyzing_scenes: { className: 'badge-cyan pulse', label: 'Processing' },
  generating_summary: { className: 'badge-cyan pulse', label: 'Processing' },
  detecting_clips: { className: 'badge-cyan pulse', label: 'Processing' },
  complete: { className: 'badge-green', label: 'Complete' },
  failed: { className: 'badge-red', label: 'Failed' },
  cancelled: { className: 'badge-amber', label: 'Cancelled' },
};

const CANCELLABLE = [
  'queued', 'extracting_frames', 'transcribing',
  'analyzing_scenes', 'generating_summary', 'detecting_clips',
];

export default function Dashboard() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState({});
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortBy, setSortBy] = useState('newest');
  const navigate = useNavigate();
  const { isMobile } = useResponsive();

  // Track cancelled job IDs so the 5-second poll never brings them back
  const cancelledIdsRef = React.useRef(new Set());

  const handleCancel = async (e, jobId) => {
    e.stopPropagation();
    if (cancelling[jobId]) return; // debounce
    setCancelling((prev) => ({ ...prev, [jobId]: true }));

    // Mark this ID as cancelled so polls will filter it out
    cancelledIdsRef.current.add(jobId);

    // Optimistically remove from UI immediately
    setJobs((prev) => prev.filter((j) => j.job_id !== jobId));

    try {
      await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
      // Wait for status to transition then delete the job files
      _waitAndDelete(jobId);
    } catch {
      // If cancel fails, still try to clean up
      _waitAndDelete(jobId);
    }
  };

  // Poll for cancelled status then auto-delete job files
  const _waitAndDelete = async (jobId) => {
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        if (!res.ok) {
          // Already gone — clean up tracking
          cancelledIdsRef.current.delete(jobId);
          setCancelling((prev) => { const n = { ...prev }; delete n[jobId]; return n; });
          return;
        }
        const job = await res.json();
        if (job.status === 'cancelled' || job.status === 'failed') {
          await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
          cancelledIdsRef.current.delete(jobId);
          setCancelling((prev) => { const n = { ...prev }; delete n[jobId]; return n; });
          return;
        }
      } catch {
        cancelledIdsRef.current.delete(jobId);
        setCancelling((prev) => { const n = { ...prev }; delete n[jobId]; return n; });
        return;
      }
    }
    // Timed out — try deleting anyway
    try { await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' }); } catch {}
    cancelledIdsRef.current.delete(jobId);
    setCancelling((prev) => { const n = { ...prev }; delete n[jobId]; return n; });
  };

  const handleDelete = async (e, jobId) => {
    e.stopPropagation();
    try {
      const res = await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
      if (res.ok) {
        setJobs((prev) => prev.filter((j) => j.job_id !== jobId));
      }
    } catch {}
  };

  const [fetchError, setFetchError] = useState(false);
  const [lastFetchTime, setLastFetchTime] = useState(null);

  useEffect(() => {
    const fetchJobs = async () => {
      try {
        const res = await fetch('/api/jobs');
        if (res.ok) {
          const data = await res.json();
          // Filter out jobs that are being cancelled — prevents them from reappearing
          const filtered = data.filter((j) => !cancelledIdsRef.current.has(j.job_id));
          setJobs(filtered);
          setFetchError(false);
          setLastFetchTime(Date.now());
        } else {
          setFetchError(true);
        }
      } catch {
        setFetchError(true);
      } finally {
        setLoading(false);
      }
    };
    fetchJobs();
    const interval = setInterval(fetchJobs, 5000);
    return () => clearInterval(interval);
  }, []);

  // Filter and sort jobs
  let filteredJobs = jobs;
  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    filteredJobs = filteredJobs.filter((j) =>
      (j.filename || '').toLowerCase().includes(q) ||
      (j.progress_message || '').toLowerCase().includes(q) ||
      (j.job_id || '').toLowerCase().includes(q)
    );
  }
  if (statusFilter !== 'all') {
    if (statusFilter === 'processing') {
      filteredJobs = filteredJobs.filter((j) => !['complete', 'failed', 'queued', 'cancelled'].includes(j.status));
    } else {
      filteredJobs = filteredJobs.filter((j) => j.status === statusFilter);
    }
  }
  filteredJobs = [...filteredJobs].sort((a, b) => {
    if (sortBy === 'oldest') return (a.created_at || '').localeCompare(b.created_at || '');
    if (sortBy === 'name') return (a.filename || '').localeCompare(b.filename || '');
    if (sortBy === 'clips') return (b.clips_count || 0) - (a.clips_count || 0);
    return (b.created_at || '').localeCompare(a.created_at || ''); // newest
  });

  const totalClips = jobs.reduce((sum, j) => sum + (j.clips_count || 0), 0);
  const processingCount = jobs.filter((j) => !['complete', 'failed', 'queued', 'cancelled'].includes(j.status)).length;

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-secondary)' }}>
        <div style={{
          width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent-cyan)',
          borderRadius: '50%', animation: 'spin 0.8s linear infinite',
          margin: '0 auto 12px',
        }} />
        Connecting to container...
      </div>
    );
  }

  return (
    <div className="page-enter">
      {/* Connection error banner */}
      {fetchError && (
        <div style={{
          padding: '10px 16px', marginBottom: 'var(--space-md)',
          background: 'var(--amber-dim)', border: '1px solid var(--accent-amber)',
          borderRadius: 'var(--radius-md)', fontSize: 13, color: 'var(--accent-amber)',
          display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
        }}>
          <span style={{ fontSize: 10, animation: 'pulse 1.5s ease-in-out infinite' }}>{'\u25CF'}</span>
          Unable to reach the backend — retrying automatically...
        </div>
      )}

      {/* Full-width search bar */}
      <div style={{
        position: 'relative', width: '100%', marginBottom: 'var(--space-lg)',
      }}>
        <div style={{
          position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)',
          color: 'var(--text-muted)', pointerEvents: 'none', lineHeight: 1,
          display: 'flex', alignItems: 'center',
        }}>
          <SearchIcon size={18} />
        </div>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search videos by name, ID, or status..."
          style={{
            width: '100%',
            padding: '14px 44px 14px 48px',
            fontSize: 15,
            background: 'var(--bg-surface-1)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text-primary)',
            outline: 'none',
            transition: 'border-color 0.3s var(--ease-spring), box-shadow 0.3s var(--ease-spring), background 0.3s ease',
          }}
          onFocus={(e) => {
            e.target.style.borderColor = 'var(--accent-cyan)';
            e.target.style.boxShadow = '0 0 0 3px var(--accent-cyan-dim)';
            e.target.style.background = 'var(--bg-surface-2)';
          }}
          onBlur={(e) => {
            e.target.style.borderColor = 'var(--border)';
            e.target.style.boxShadow = 'none';
            e.target.style.background = 'var(--bg-surface-1)';
          }}
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery('')}
            style={{
              position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)',
              background: 'var(--bg-surface-3)', border: 'none', borderRadius: '50%',
              width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-muted)', fontSize: 13, cursor: 'pointer', lineHeight: 1,
            }}
          >
            &times;
          </button>
        )}
      </div>

      {/* Stats cards with glass treatment */}
      <div style={{
        display: 'flex', gap: isMobile ? 'var(--space-sm)' : 'var(--space-md)',
        marginBottom: isMobile ? 'var(--space-lg)' : 'var(--space-xl)',
        flexWrap: 'wrap',
      }}>
        {[
          { label: 'Total Videos', value: jobs.length, color: 'var(--accent-cyan)' },
          { label: 'Clips Extracted', value: totalClips, color: 'var(--accent-amber)' },
          { label: 'Processing', value: processingCount, color: processingCount > 0 ? 'var(--accent-amber)' : 'var(--text-primary)' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{
            background: 'var(--glass-bg)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: isMobile ? 'var(--space-sm) var(--space-md)' : 'var(--space-md) var(--space-lg)',
            flex: 1, minWidth: isMobile ? 0 : 140,
            boxShadow: 'var(--shadow-sm)',
            transition: 'transform 0.3s var(--ease-spring), box-shadow 0.3s var(--ease-spring)',
          }}>
            <div style={{
              fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
              textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 'var(--space-xs)',
            }}>
              {label}
            </div>
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: isMobile ? 22 : 28,
              fontWeight: 700, color, lineHeight: 1.1,
            }}>
              {value}
            </div>
          </div>
        ))}
      </div>

      {/* Filter & Sort bar */}
      {jobs.length > 0 && (
        <div style={{
          marginBottom: 'var(--space-md)', display: 'flex', gap: 'var(--space-sm)',
          flexWrap: 'wrap', alignItems: 'stretch',
        }}>
          {/* Status filter */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{
              padding: '10px 12px', borderRadius: 'var(--radius-md)', fontSize: 13,
              background: 'var(--bg-surface-1)', border: '1px solid var(--border)',
              color: 'var(--text-primary)', outline: 'none', cursor: 'pointer',
            }}
          >
            <option value="all">All Status</option>
            <option value="processing">Processing</option>
            <option value="complete">Complete</option>
            <option value="failed">Failed</option>
            <option value="queued">Queued</option>
          </select>

          {/* Sort */}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            style={{
              padding: '10px 12px', borderRadius: 'var(--radius-md)', fontSize: 13,
              background: 'var(--bg-surface-1)', border: '1px solid var(--border)',
              color: 'var(--text-primary)', outline: 'none', cursor: 'pointer',
            }}
          >
            <option value="newest">Newest First</option>
            <option value="oldest">Oldest First</option>
            <option value="name">By Name</option>
            <option value="clips">Most Clips</option>
          </select>
        </div>
      )}

      {/* Job list or empty state */}
      {jobs.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: isMobile ? 'var(--space-2xl) var(--space-lg)' : '80px var(--space-xl)',
            border: '2px dashed var(--border)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-surface-1)',
          }}
        >
          {/* Film reel SVG illustration */}
          <div style={{ marginBottom: 'var(--space-lg)', opacity: 0.35 }}>
            <svg width="96" height="96" viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="48" cy="48" r="42" stroke="currentColor" strokeWidth="3" style={{ color: 'var(--text-secondary)' }} />
              <circle cx="48" cy="48" r="12" stroke="currentColor" strokeWidth="2.5" style={{ color: 'var(--text-secondary)' }} />
              <circle cx="48" cy="48" r="3" fill="currentColor" style={{ color: 'var(--text-secondary)' }} />
              {/* Sprocket holes */}
              <circle cx="48" cy="14" r="5" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-secondary)' }} />
              <circle cx="48" cy="82" r="5" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-secondary)' }} />
              <circle cx="14" cy="48" r="5" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-secondary)' }} />
              <circle cx="82" cy="48" r="5" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-secondary)' }} />
              <circle cx="24" cy="24" r="5" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-secondary)' }} />
              <circle cx="72" cy="24" r="5" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-secondary)' }} />
              <circle cx="24" cy="72" r="5" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-secondary)' }} />
              <circle cx="72" cy="72" r="5" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-secondary)' }} />
              {/* Spokes */}
              <line x1="48" y1="36" x2="48" y2="19" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--text-secondary)' }} />
              <line x1="48" y1="60" x2="48" y2="77" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--text-secondary)' }} />
              <line x1="36" y1="48" x2="19" y2="48" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--text-secondary)' }} />
              <line x1="60" y1="48" x2="77" y2="48" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--text-secondary)' }} />
              <line x1="39.5" y1="39.5" x2="28" y2="28" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--text-secondary)' }} />
              <line x1="56.5" y1="39.5" x2="68" y2="28" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--text-secondary)' }} />
              <line x1="39.5" y1="56.5" x2="28" y2="68" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--text-secondary)' }} />
              <line x1="56.5" y1="56.5" x2="68" y2="68" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--text-secondary)' }} />
            </svg>
          </div>
          <h3 style={{
            fontSize: 20, marginBottom: 'var(--space-sm)', color: 'var(--text-secondary)',
            fontWeight: 600, letterSpacing: '-0.01em',
          }}>
            No videos analyzed yet
          </h3>
          <p style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-xl)', fontSize: 14 }}>
            Upload your first video to start extracting clips
          </p>
          <Link
            to="/upload"
            style={{
              display: 'inline-block',
              padding: '12px 32px',
              background: 'var(--accent-cyan)',
              color: 'var(--bg-base)',
              fontWeight: 600,
              fontSize: 15,
              borderRadius: 'var(--radius-md)',
              textDecoration: 'none',
              transition: 'transform 0.2s var(--ease-spring), box-shadow 0.2s var(--ease-spring)',
              boxShadow: 'var(--shadow-sm)',
            }}
          >
            Upload Video
          </Link>
        </div>
      ) : filteredJobs.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: 'var(--space-2xl) var(--space-lg)',
          color: 'var(--text-muted)', fontSize: 14,
        }}>
          {searchQuery.trim()
            ? `No videos match "${searchQuery.trim()}".`
            : 'No videos match the selected filter.'}
        </div>
      ) : (
        <div
          className="responsive-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))',
            gap: isMobile ? 'var(--space-sm)' : 'var(--space-md)',
          }}
        >
          {filteredJobs.map((job, i) => {
            const statusInfo = STATUS_STYLES[job.status] || STATUS_STYLES.queued;
            return (
              <div
                key={job.job_id}
                className="card-hover"
                onClick={() => navigate(`/analysis/${job.job_id}`)}
                style={{
                  background: 'var(--bg-surface-1)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--shadow-sm)',
                  cursor: 'pointer',
                  opacity: 0,
                  animation: `cardAppear 0.4s var(--ease-spring) forwards`,
                  animationDelay: `${i * 60}ms`,
                  overflow: 'hidden',
                }}
              >
                {/* Progress bar for active jobs */}
                {job.progress > 0 && job.progress < 100 && (
                  <div style={{ height: 3, background: 'var(--bg-surface-3)' }}>
                    <div
                      className="shimmer"
                      style={{
                        height: '100%', width: `${job.progress}%`,
                        background: 'var(--accent-cyan)',
                        borderRadius: '0 2px 2px 0',
                        transition: 'width 0.5s var(--ease-spring)',
                      }}
                    />
                  </div>
                )}

                <div style={{ padding: 'var(--space-md)' }}>
                  {/* Top row: filename + status badge */}
                  <div style={{
                    display: 'flex', justifyContent: 'space-between',
                    alignItems: 'flex-start', marginBottom: 'var(--space-sm)',
                    gap: 'var(--space-sm)',
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <h4 style={{
                        fontSize: 14, fontWeight: 600, marginBottom: 4,
                        wordBreak: 'break-word', lineHeight: 1.3,
                        color: 'var(--text-primary)',
                      }}>
                        {job.filename}
                      </h4>
                    </div>
                    <span
                      className={`badge ${statusInfo.className}`}
                      style={{ borderRadius: 'var(--radius-xl)', whiteSpace: 'nowrap', flexShrink: 0 }}
                    >
                      {statusInfo.label}
                    </span>
                  </div>

                  {/* Upload date */}
                  <div style={{
                    fontSize: 12, color: 'var(--text-muted)',
                    marginBottom: 'var(--space-sm)',
                  }}>
                    {formatDate(job.created_at)}
                  </div>

                  {/* Meta row: duration, size, clip count */}
                  <div style={{
                    display: 'flex', gap: 'var(--space-md)', fontSize: 12,
                    color: 'var(--text-secondary)', flexWrap: 'wrap',
                    alignItems: 'center',
                  }}>
                    <span style={{ fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 4 }}>
                      {formatDuration(job.duration)}
                    </span>
                    {job.file_size_mb > 0 && (
                      <span style={{ fontFamily: 'var(--font-mono)' }}>
                        {job.file_size_mb.toFixed(1)} MB
                      </span>
                    )}
                    <span style={{
                      fontFamily: 'var(--font-mono)',
                      color: (job.clips_count || 0) > 0 ? 'var(--accent-amber)' : 'var(--text-muted)',
                      fontWeight: (job.clips_count || 0) > 0 ? 600 : 400,
                    }}>
                      {job.clips_count || 0} {(job.clips_count || 0) === 1 ? 'clip' : 'clips'}
                    </span>
                  </div>

                  {job.progress_message && job.status !== 'complete' && (
                    <div style={{
                      marginTop: 'var(--space-sm)', fontSize: 11,
                      color: 'var(--accent-cyan)',
                    }}>
                      {job.progress_message}
                    </div>
                  )}

                  {/* Action buttons */}
                  <div style={{ display: 'flex', gap: 'var(--space-sm)', marginTop: 'var(--space-sm)' }}>
                    {CANCELLABLE.includes(job.status) && (
                      <button
                        onClick={(e) => handleCancel(e, job.job_id)}
                        disabled={cancelling[job.job_id]}
                        style={{
                          padding: '6px 14px',
                          background: 'var(--amber-dim)',
                          border: '1px solid var(--accent-amber)',
                          color: 'var(--accent-amber)',
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: cancelling[job.job_id] ? 'default' : 'pointer',
                          borderRadius: 'var(--radius-sm)',
                          opacity: cancelling[job.job_id] ? 0.6 : 1,
                        }}
                      >
                        {cancelling[job.job_id] ? 'Cancelling...' : 'Cancel'}
                      </button>
                    )}
                    {(job.status === 'failed' || job.status === 'cancelled') && (
                      <button
                        onClick={(e) => handleDelete(e, job.job_id)}
                        style={{
                          padding: '6px 14px',
                          background: 'var(--danger-dim)',
                          border: '1px solid var(--danger)',
                          color: 'var(--danger)',
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: 'pointer',
                          borderRadius: 'var(--radius-sm)',
                        }}
                      >
                        Remove
                      </button>
                    )}
                    {job.status === 'complete' && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`Delete "${job.filename}" and all its clips? This cannot be undone.`)) {
                            handleDelete(e, job.job_id);
                          }
                        }}
                        style={{
                          padding: '6px 14px',
                          background: 'var(--danger-dim)',
                          border: '1px solid var(--danger)',
                          color: 'var(--danger)',
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: 'pointer',
                          borderRadius: 'var(--radius-sm)',
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
