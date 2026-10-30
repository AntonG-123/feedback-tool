import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, setShareToken } from '../api';
import { Icon, Logo } from '../icons';
import { colorFor, initials, timeAgo } from '../util';
import { Lightbox } from '../components/Dialogs';

export function OverviewPage() {
  const { projectId: routeId, shareToken } = useParams();
  const nav = useNavigate();
  const [projectId, setProjectId] = useState(routeId || null);
  const [project, setProject] = useState<any>(null);
  const [comments, setComments] = useState<any[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'open' | 'resolved'>('all');
  const [error, setError] = useState('');
  const [lightbox, setLightbox] = useState<any>(null);

  useEffect(() => {
    if (shareToken) {
      setShareToken(shareToken);
      api(`/share/${shareToken}`).then((r) => setProjectId(r.projectId)).catch((e) => setError(e.message));
    }
  }, [shareToken]);
  useEffect(() => {
    if (!projectId) return;
    api(`/projects/${projectId}`).then((r) => setProject(r.project)).catch((e) => setError(e.message));
    api(`/projects/${projectId}/comments`).then((r) => setComments(r.comments)).catch((e) => setError(e.message));
  }, [projectId]);

  const base = shareToken ? `/s/${shareToken}` : `/projects/${projectId}`;
  const list = (comments || []).filter((c) => filter === 'all' || c.status === filter);
  if (error) return <div className="auth-page"><div className="card auth-card"><p className="error-text">{error}</p></div></div>;

  return (
    <div style={{ minHeight: '100%', background: 'var(--surface-2)' }}>
      <header className="app-header">
        <Link className="icon-btn" to={base} title="Back to website"><Icon.back /></Link>
        <Logo />
        <span className="muted">/</span>
        <b>{project?.name}</b>
        <span className="spacer" />
        <Link className="btn" to={base}><Icon.desktop size={15} /> Open website</Link>
      </header>
      <main className="ov-main">
        <div className="row" style={{ marginBottom: 16 }}>
          <h1 style={{ fontSize: 20 }}>Comments</h1>
          <span className="spacer" />
          <div className="segmented" data-testid="overview-filter">
            {(['all', 'open', 'resolved'] as const).map((f) => (
              <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)} data-testid={`ov-filter-${f}`}>
                {f[0].toUpperCase() + f.slice(1)} <span className="muted small">{(comments || []).filter((c) => f === 'all' || c.status === f).length}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="ov-row head"><span>#</span><span>Screenshot</span><span>Comment</span><span>Page</span><span>Status</span></div>
          {comments === null && <div className="empty"><span className="spinner" style={{ display: 'inline-block' }} /></div>}
          {comments && list.length === 0 && <div className="empty">No comments{filter !== 'all' ? ` with status "${filter}"` : ''}.</div>}
          {list.map((c) => (
            <div key={c.id} className="ov-row" data-testid="ov-row" onClick={() => nav(`${base}?comment=${c.id}`)}>
              <span className="pin" style={{ position: 'static', margin: 0, background: c.status === 'resolved' ? 'var(--resolved)' : 'var(--primary)' }}>{c.number}</span>
              <div className="ov-shot" onClick={(e) => { if (c.screenshots?.crop?.url) { e.stopPropagation(); setLightbox({ url: c.screenshots.full?.url || c.screenshots.crop.url, download: c.screenshots.full?.downloadUrl || c.screenshots.crop.downloadUrl }); } }}>
                {c.screenshots?.crop?.url ? <img src={c.screenshots.crop.url} alt="" /> : <span className="muted small">{c.screenshots?.crop?.status === 'failed' ? 'No screenshot' : 'Rendering…'}</span>}
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}>
                  <span className="avatar avatar-sm" style={{ background: colorFor(c.authorName) }}>{initials(c.authorName)}</span>
                  <b style={{ fontSize: 13 }}>{c.authorName}</b>
                  <span className="muted small">{timeAgo(c.createdAt)}</span>
                  <span className="badge">{c.breakpoint}</span>
                  {c.replies.length > 0 && <span className="muted small">{c.replies.length} repl{c.replies.length > 1 ? 'ies' : 'y'}</span>}
                </div>
                <div style={{ marginTop: 4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{c.body}</div>
              </div>
              <span className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.pageUrl}>{c.pageTitle || c.pagePath}</span>
              <span><span className={`badge ${c.status === 'resolved' ? 'badge-resolved' : 'badge-open'}`}>{c.status === 'resolved' ? 'Resolved' : 'Open'}</span></span>
            </div>
          ))}
        </div>
      </main>
      {lightbox && <Lightbox {...lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
