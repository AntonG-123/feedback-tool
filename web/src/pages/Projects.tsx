import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon, Logo } from '../icons';
import { timeAgo } from '../util';
import { useToast } from '../toast';

type Project = { id: string; name: string; url: string; origin: string; pageCount: number; openCount: number; commentCount: number; createdAt: string; lastCommentAt: string | null };

export function ProjectsPage() {
  const { user, loading, setUser } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [url, setUrl] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) nav('/login', { replace: true });
    if (user) api('/projects').then((r) => setProjects(r.projects)).catch((e) => toast(e.message, 'error'));
  }, [user, loading]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setCreating(true);
    try {
      const r = await api('/projects', { body: { url } });
      nav(`/projects/${r.project.id}`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };
  const remove = async (p: Project) => {
    setMenu(null);
    if (!confirm(`Delete "${p.name}" and all its comments? This cannot be undone.`)) return;
    await api(`/projects/${p.id}`, { method: 'DELETE' });
    setProjects((x) => x!.filter((y) => y.id !== p.id));
  };
  const logout = async () => {
    await api('/auth/logout', { body: {} });
    setUser(null);
    nav('/login');
  };

  if (!user) return null;
  return (
    <div style={{ minHeight: '100%', background: 'var(--surface-2)' }} onClick={() => setMenu(null)}>
      <header className="app-header">
        <Logo />
        <div className="spacer" />
        <span className="muted small">{user.email}</span>
        <button className="icon-btn" title="Log out" onClick={logout}><Icon.logout /></button>
      </header>
      <main className="projects-main">
        <h1 style={{ fontSize: 22 }}>Projects</h1>
        <p className="muted" style={{ margin: '4px 0 16px' }}>Paste a website URL to collect visual feedback on it — nothing needs to be installed on the site.</p>
        <form className="card new-project" onSubmit={create}>
          <div style={{ flex: 1 }}>
            <label className="label" htmlFor="url">Website URL</label>
            <input id="url" className="input" style={{ height: 40 }} placeholder="https://example.com" value={url} onChange={(e) => setUrl(e.target.value)} required />
            {error && <div className="error-text" style={{ marginTop: 6 }}>{error}</div>}
          </div>
          <button className="btn btn-primary btn-lg" disabled={creating || !url.trim()}>{creating ? 'Creating…' : <><Icon.plus size={16} /> Create project</>}</button>
        </form>

        {projects === null ? (
          <div className="empty"><span className="spinner" style={{ display: 'inline-block' }} /></div>
        ) : projects.length === 0 ? (
          <div className="empty">No projects yet. Enter a website URL above to create your first one.</div>
        ) : (
          <div className="project-grid">
            {projects.map((p) => (
              <div key={p.id} className="card project-card" onClick={() => nav(`/projects/${p.id}`)} data-testid="project-card">
                <div className="project-thumb">{p.name.replace(/^www\./, '').charAt(0).toUpperCase()}</div>
                <div className="row">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                    <div className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.url}</div>
                  </div>
                  <button className="icon-btn" onClick={(e) => { e.stopPropagation(); setMenu(menu === p.id ? null : p.id); }} aria-label="Project menu"><Icon.more /></button>
                  {menu === p.id && (
                    <div className="menu" style={{ right: 12, top: 190 }} onClick={(e) => e.stopPropagation()}>
                      <button className="menu-item" onClick={() => nav(`/projects/${p.id}/comments`)}><Icon.list size={16} /> All comments</button>
                      <button className="menu-item danger" onClick={() => remove(p)}><Icon.trash size={16} /> Delete project</button>
                    </div>
                  )}
                </div>
                <div className="row small muted" style={{ marginTop: 10 }}>
                  <span>{p.pageCount} pages</span>·
                  <span className={p.openCount ? 'badge badge-open' : ''}>{p.openCount} open</span>·
                  <span>{p.commentCount} comments</span>
                  <span className="spacer" />
                  <span>{p.lastCommentAt ? timeAgo(p.lastCommentAt) : timeAgo(p.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
