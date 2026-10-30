import { useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { useToast } from '../toast';

export function ShareDialog({ projectId, share, onChange, onClose }: { projectId: string; share: any; onChange: (s: any) => void; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = async (body: any) => {
    setBusy(true);
    try {
      const r = await api(`/projects/${projectId}/share`, { body });
      onChange(r.share);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(share.url); toast('Link copied'); } catch { toast('Copy failed — select the link and copy it manually', 'error'); }
  };
  const expiryDays = share?.expiresAt ? Math.max(1, Math.round((new Date(share.expiresAt).getTime() - Date.now()) / 86400000)) : null;
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()} data-testid="share-dialog">
        <div className="dialog-head"><h2>Share for feedback</h2><span className="spacer" /><button className="icon-btn" onClick={onClose}><Icon.x /></button></div>
        <div className="dialog-body">
          <p className="muted" style={{ margin: 0 }}>Anyone with this link can view the website, leave comments and reply — no account needed.</p>
          <div className="row">
            <input className="input" readOnly value={share?.url || ''} onFocus={(e) => e.target.select()} data-testid="share-url" style={{ opacity: share?.enabled ? 1 : 0.5 }} />
            <button className="btn btn-primary" onClick={copy} disabled={!share?.enabled}><Icon.copy size={15} /> Copy</button>
          </div>
          <label className="row" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={!!share?.enabled} disabled={busy} onChange={(e) => act({ action: e.target.checked ? 'enable' : 'disable' })} data-testid="share-enabled" />
            Link sharing enabled
          </label>
          <div className="row">
            <span className="label" style={{ margin: 0 }}>Expires</span>
            <select className="input" style={{ width: 160, height: 32 }} value={expiryDays ? String(expiryDays) : ''} onChange={(e) => act({ action: 'expiry', days: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Never</option>
              {expiryDays && ![7, 30, 90].includes(expiryDays) && <option value={String(expiryDays)}>In {expiryDays} days</option>}
              <option value="7">In 7 days</option>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
            </select>
          </div>
        </div>
        <div className="dialog-foot" style={{ justifyContent: 'space-between' }}>
          <button className="btn btn-danger" disabled={busy} onClick={() => confirm('Generate a new link? The current link will stop working immediately.') && act({ action: 'regenerate' })} data-testid="share-regenerate">
            <Icon.reload size={15} /> Regenerate link
          </button>
          <button className="btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

export function SettingsDialog({ project, onSaved, onClose }: { project: any; onSaved: (p: any) => void; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(project.name);
  const [renderMode, setRenderMode] = useState(project.renderMode);
  const [authType, setAuthType] = useState(project.siteAuthType);
  const [user, setUser] = useState(project.siteAuthUser || '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body: any = { name, renderMode };
      if (authType !== project.siteAuthType || password || (authType === 'basic' && user !== (project.siteAuthUser || ''))) body.siteAuth = { type: authType, user, password: password || undefined };
      const r = await api(`/projects/${project.id}`, { method: 'PATCH', body });
      onSaved(r.project);
      toast('Settings saved');
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const rescan = async () => {
    await api(`/projects/${project.id}/rediscover`, { body: {} });
    toast('Re-scanning pages…');
  };
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()} data-testid="settings-dialog">
        <div className="dialog-head"><h2>Project settings</h2><span className="spacer" /><button className="icon-btn" onClick={onClose}><Icon.x /></button></div>
        <div className="dialog-body">
          <div><label className="label">Project name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div>
            <label className="label">Rendering</label>
            <select className="input" value={renderMode} onChange={(e) => setRenderMode(e.target.value)}>
              <option value="live">Live proxy (interactive, recommended)</option>
              <option value="snapshot">Snapshot (server-rendered, scripts removed)</option>
            </select>
            <div className="muted small" style={{ marginTop: 4 }}>Use Snapshot for sites whose scripts don't work in the live preview.</div>
          </div>
          <div>
            <label className="label">Password-protected site</label>
            <select className="input" value={authType} onChange={(e) => setAuthType(e.target.value)} data-testid="auth-type">
              <option value="none">Not protected</option>
              <option value="webflow">Webflow site password</option>
              <option value="shopify">Shopify storefront password</option>
              <option value="basic">HTTP Basic authentication</option>
            </select>
          </div>
          {authType === 'basic' && <div><label className="label">Username</label><input className="input" value={user} onChange={(e) => setUser(e.target.value)} /></div>}
          {authType !== 'none' && (
            <div>
              <label className="label">Site password</label>
              <input className="input" type="password" autoComplete="new-password" placeholder={project.hasSitePassword ? '•••••••• (saved — enter to replace)' : 'Password'} value={password} onChange={(e) => setPassword(e.target.value)} data-testid="auth-password" />
              <div className="muted small" style={{ marginTop: 4 }}>Stored encrypted. Reviewers never see it — the server signs in for them.</div>
            </div>
          )}
        </div>
        <div className="dialog-foot" style={{ justifyContent: 'space-between' }}>
          <button className="btn" onClick={rescan}><Icon.reload size={15} /> Re-scan pages</button>
          <div className="row"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save} disabled={busy} data-testid="settings-save">Save</button></div>
        </div>
      </div>
    </div>
  );
}

export function Lightbox({ url, download, onClose }: { url: string; download: string; onClose: () => void }) {
  return (
    <div className="lightbox" onClick={onClose} data-testid="lightbox">
      <div className="bar" onClick={(e) => e.stopPropagation()}>
        <span className="spacer" />
        <a className="btn btn-sm" href={download}><Icon.download size={14} /> Download</a>
        <button className="btn btn-sm" onClick={onClose}><Icon.x size={14} /> Close</button>
      </div>
      <div className="img"><img src={url} alt="Screenshot" onClick={(e) => e.stopPropagation()} /></div>
    </div>
  );
}
