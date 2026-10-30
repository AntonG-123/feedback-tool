import { useRef, useState } from 'react';
import { api, getGuest } from '../api';
import { Icon } from '../icons';
import { colorFor, initials, timeAgo } from '../util';
import { NamePrompt, uploadFile, Attachment } from './Composer';
import { useToast } from '../toast';

export type Comment = any;

function Attachments({ list }: { list: any[] }) {
  if (!list?.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
      <div className="thumbs">
        {list.filter((a) => a.kind === 'image').map((a) => (
          <a key={a.id} className="thumb" href={a.url} target="_blank" rel="noreferrer"><img src={a.url} alt={a.name || 'image'} /></a>
        ))}
      </div>
      {list.filter((a) => a.kind === 'audio').map((a) => (
        <div key={a.id} className="audio-chip">
          <audio controls src={a.url} preload="metadata" />
          {a.transcript && <div className="small muted">Transcript: “{a.transcript}”</div>}
        </div>
      ))}
    </div>
  );
}

export function Screenshot({ shots, onOpen, onRetry }: { shots: any; onOpen: (url: string, download: string) => void; onRetry?: () => void }) {
  const crop = shots?.crop;
  const full = shots?.full;
  if (!crop) return null;
  if (crop.status === 'pending') return <div className="shot-pending" data-testid="shot-pending"><span className="spinner" style={{ width: 14, height: 14 }} /> Capturing screenshot…</div>;
  if (crop.status === 'failed')
    return <div className="shot-pending" style={{ flexDirection: 'column' }}>Screenshot could not be captured.{onRetry && <button className="btn btn-sm" onClick={onRetry}>Retry</button>}</div>;
  return (
    <div>
      <a className="shot" onClick={() => onOpen(crop.url, crop.downloadUrl)} data-testid="shot-crop"><img src={crop.url} alt="Screenshot of the commented element" /></a>
      <div className="row small" style={{ marginTop: 4 }}>
        {full?.status === 'ready' && <a className="muted" style={{ cursor: 'pointer' }} onClick={() => onOpen(full.url, full.downloadUrl)}>Full page</a>}
        <span className="spacer" />
        <a className="muted row" href={crop.downloadUrl} style={{ gap: 4 }} data-testid="shot-download"><Icon.download size={13} /> Download</a>
      </div>
    </div>
  );
}

function Message({ c, isRoot, canDelete, onChanged, onDeleted }: { c: Comment; isRoot: boolean; canDelete: boolean; onChanged: (c: Comment) => void; onDeleted: () => void }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(c.body);
  const [err, setErr] = useState<string | string[]>('');
  const [menu, setMenu] = useState(false);
  const save = async () => {
    setErr('');
    try {
      const r = await api(`/comments/${c.id}`, { method: 'PATCH', body: { body } });
      onChanged(r.comment);
      setEditing(false);
    } catch (e: any) {
      setErr(e.data?.validation?.questions || e.message);
    }
  };
  const del = async () => {
    setMenu(false);
    if (!confirm(isRoot ? 'Delete this comment thread and all replies?' : 'Delete this reply?')) return;
    await api(`/comments/${c.id}`, { method: 'DELETE' });
    onDeleted();
  };
  return (
    <div className="msg" data-testid={isRoot ? 'thread-root' : 'thread-reply'}>
      <span className="avatar" style={{ background: colorFor(c.authorName) }}>{initials(c.authorName)}</span>
      <div className="content">
        <div className="who">
          <b>{c.authorName}</b>
          {c.authorType === 'owner' && <span className="badge">Owner</span>}
          <span className="muted small" title={new Date(c.createdAt).toLocaleString()}>{timeAgo(c.createdAt)}{c.editedAt ? ' · edited' : ''}</span>
          <span className="spacer" />
          {(c.isMine || canDelete) && (
            <span style={{ position: 'relative' }}>
              <button className="icon-btn icon-btn-sm" onClick={() => setMenu(!menu)} aria-label="Comment actions" data-testid="comment-menu"><Icon.more size={16} /></button>
              {menu && (
                <div className="menu" style={{ right: 0, top: 28 }}>
                  {c.isMine && <button className="menu-item" onClick={() => { setMenu(false); setEditing(true); }}><Icon.pen size={15} /> Edit</button>}
                  <button className="menu-item danger" onClick={del} data-testid="delete-comment"><Icon.trash size={15} /> Delete</button>
                </div>
              )}
            </span>
          )}
        </div>
        {editing ? (
          <div style={{ marginTop: 4 }}>
            <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} autoFocus data-testid="edit-input" />
            {err && <div className="validation">{Array.isArray(err) ? err.join(' ') : err}</div>}
            <div className="row" style={{ marginTop: 6, justifyContent: 'flex-end' }}>
              <button className="btn btn-sm btn-ghost" onClick={() => { setEditing(false); setBody(c.body); }}>Cancel</button>
              <button className="btn btn-sm btn-primary" onClick={save} disabled={!body.trim()} data-testid="save-edit">Save</button>
            </div>
          </div>
        ) : (
          <div className="text" data-testid="comment-text">{c.body}</div>
        )}
        <Attachments list={c.attachments} />
      </div>
    </div>
  );
}

type Props = {
  comment: Comment;
  role: 'owner' | 'guest';
  projectId: string;
  style: React.CSSProperties;
  onClose: () => void;
  onUpdate: (c: Comment) => void;
  onDelete: (id: string) => void;
  onOpenImage: (url: string, download: string) => void;
  onGuest: (name: string) => void;
};

export function Thread(p: Props) {
  const c = p.comment;
  const toast = useToast();
  const [reply, setReply] = useState('');
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [askName, setAskName] = useState<null | 'reply' | 'resolve'>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const needsName = p.role === 'guest' && !getGuest();
  const resolved = c.status === 'resolved';

  const toggleResolve = async () => {
    if (needsName) return setAskName('resolve');
    const r = await api(`/comments/${c.id}/resolve`, { body: { resolved: !resolved } });
    p.onUpdate(r.comment);
    toast(resolved ? `Comment #${c.number} reopened` : `Comment #${c.number} resolved`);
  };
  const send = async () => {
    if (needsName) return setAskName('reply');
    if (!reply.trim() && !atts.length) return;
    setBusy(true);
    try {
      const r = await api(`/projects/${p.projectId}/comments`, { body: { parentId: c.id, body: reply.trim(), attachmentIds: atts.map((a) => a.id) } });
      p.onUpdate(r.comment);
      setReply('');
      setAtts([]);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const addFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      try { setAtts((x) => [...x]); const a = await uploadFile(p.projectId, f, f.name || 'image.png'); setAtts((x) => [...x, a]); } catch (e: any) { toast(e.message, 'error'); }
    }
  };

  return (
    <div className="pop" style={p.style} data-testid="thread" onMouseDown={(e) => e.stopPropagation()}>
      <div className="pop-head">
        <span className={`pin`} style={{ position: 'static', margin: 0, width: 24, height: 24, fontSize: 11, background: resolved ? 'var(--resolved)' : c.anchor?.state === 'needs_attention' ? 'var(--warning)' : 'var(--primary)', cursor: 'default' }}>{c.number}</span>
        <span className={`badge ${resolved ? 'badge-resolved' : 'badge-open'}`}>{resolved ? 'Resolved' : 'Open'}</span>
        <span className="badge" title="Breakpoint">{c.breakpoint}</span>
        <span className="spacer" />
        <button className={`btn btn-sm ${resolved ? '' : 'btn-primary'}`} onClick={toggleResolve} data-testid="resolve-toggle">
          <Icon.check size={14} /> {resolved ? 'Reopen' : 'Resolve'}
        </button>
        <button className="icon-btn icon-btn-sm" onClick={p.onClose} aria-label="Close"><Icon.x size={16} /></button>
      </div>
      <div className="pop-body">
        {c.anchor?.state === 'needs_attention' && (
          <div className="attention-note" data-testid="anchor-attention"><Icon.alert size={13} /> The commented element could not be found reliably on the current page. The pin is shown at its last known position.</div>
        )}
        <Message c={c} isRoot canDelete={p.role === 'owner'} onChanged={p.onUpdate} onDeleted={() => p.onDelete(c.id)} />
        <Screenshot shots={c.screenshots} onOpen={p.onOpenImage} onRetry={() => api(`/comments/${c.id}/screenshots/retry`, { body: {} }).then(() => p.onUpdate({ ...c, screenshots: { full: { status: 'pending' }, crop: { status: 'pending' } } }))} />
        {resolved && c.resolvedByName && <div className="muted small"><Icon.checkCircle size={13} /> Resolved by {c.resolvedByName} {timeAgo(c.resolvedAt)}</div>}
        {c.replies.map((r: Comment) => (
          <Message key={r.id} c={r} isRoot={false} canDelete={p.role === 'owner'}
            onChanged={p.onUpdate}
            onDeleted={() => p.onUpdate({ ...c, replies: c.replies.filter((x: Comment) => x.id !== r.id) })} />
        ))}
      </div>
      <div className="pop-foot" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
        {askName ? (
          <NamePrompt compact onDone={(n) => { p.onGuest(n); setAskName(null); }} />
        ) : (
          <>
            {atts.length > 0 && <div className="thumbs">{atts.map((a) => <div className="thumb" key={a.id}><img src={a.url} alt="" /></div>)}</div>}
            <textarea className="textarea" style={{ minHeight: 40 }} rows={1} placeholder="Reply…" value={reply} data-testid="reply-input"
              onChange={(e) => setReply(e.target.value)}
              onPaste={(e) => { const fs = Array.from(e.clipboardData.files || []); if (fs.length) { e.preventDefault(); addFiles(fs); } }}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }} />
            <div className="row">
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
              <button className="icon-btn" title="Attach image" onClick={() => fileRef.current?.click()}><Icon.image /></button>
              <span className="spacer" />
              <button className="btn btn-primary btn-sm" disabled={busy || (!reply.trim() && !atts.length)} onClick={send} data-testid="send-reply">Reply</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
