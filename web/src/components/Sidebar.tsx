import { useMemo, useState } from 'react';
import { Icon } from '../icons';
import { buildTree, colorFor, initials, Page, pageLabel, timeAgo, TreeNode } from '../util';
import type { Comment } from './Thread';

function Count({ open, resolved }: { open: number; resolved: number }) {
  if (open) return <span className="count" title={`${open} open`}>{open}</span>;
  if (resolved) return <span className="count done" title={`${resolved} resolved`}>✓</span>;
  return null;
}

function Node({ n, depth, current, onOpen, expanded, toggle }: { n: TreeNode; depth: number; current: string; onOpen: (p: Page) => void; expanded: Set<string>; toggle: (k: string) => void }) {
  const hasKids = n.children.length > 0;
  const isOpen = expanded.has(n.key);
  const active = n.page && n.page.url === current;
  return (
    <>
      <div
        className={`tree-row ${active ? 'active' : ''} ${hasKids && depth === 0 ? 'category' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => (n.page ? onOpen(n.page) : toggle(n.key))}
        data-testid="tree-row"
        data-path={n.page?.path || n.key}
        title={n.page?.url || n.key}
      >
        <span className={`chev ${isOpen ? 'open' : ''}`} onClick={(e) => { if (hasKids) { e.stopPropagation(); toggle(n.key); } }} data-testid={hasKids ? 'tree-toggle' : undefined}>
          {hasKids ? <Icon.chevron size={14} /> : null}
        </span>
        {hasKids ? <Icon.folder size={15} /> : <Icon.file size={15} />}
        <span className="name">{n.page ? (n.page.path === '/' ? 'Home' : n.label) : n.label}</span>
        {(hasKids && !isOpen) || !hasKids ? <Count open={n.open} resolved={n.resolved} /> : n.page ? <Count open={n.page.openCount} resolved={n.page.resolvedCount} /> : null}
      </div>
      {hasKids && isOpen && n.children.map((c) => <Node key={c.key} n={c} depth={depth + 1} current={current} onOpen={onOpen} expanded={expanded} toggle={toggle} />)}
    </>
  );
}

export function PagesPanel({ pages, current, onOpen, discovery }: { pages: Page[]; current: string; onOpen: (p: Page) => void; discovery: string }) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => (q ? pages.filter((p) => (p.path + ' ' + (p.title || '')).toLowerCase().includes(q.toLowerCase())) : pages), [pages, q]);
  const tree = useMemo(() => buildTree(filtered), [filtered]);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>();
    // Expand the branch containing the current page.
    try {
      const path = new URL(current).pathname.split('/').filter(Boolean);
      let k = '';
      for (const seg of path.slice(0, -1)) { k += '/' + seg; s.add(k); }
    } catch {}
    return s;
  });
  const toggle = (k: string) => setExpanded((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const all = q ? new Set(tree.children.flatMap(function walk(n: TreeNode): string[] { return [n.key, ...n.children.flatMap(walk)]; })) : expanded;
  return (
    <>
      <div className="sidebar-tools">
        <div style={{ position: 'relative', flex: 1 }}>
          <span style={{ position: 'absolute', left: 8, top: 7, color: 'var(--muted)' }}><Icon.search size={15} /></span>
          <input className="input" style={{ height: 30, paddingLeft: 30, fontSize: 13 }} placeholder="Search pages" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="sidebar-scroll" data-testid="pages-tree">
        {(discovery === 'pending' || discovery === 'running') && <div className="row muted small" style={{ padding: '6px 14px' }}><span className="spinner" style={{ width: 13, height: 13 }} /> Discovering pages…</div>}
        {discovery === 'failed' && <div className="muted small" style={{ padding: '6px 14px' }}>Page discovery failed — pages you visit are added automatically.</div>}
        {tree.page && <Node n={{ ...tree, children: [] }} depth={0} current={current} onOpen={onOpen} expanded={all} toggle={toggle} />}
        {tree.children.map((n) => <Node key={n.key} n={n} depth={0} current={current} onOpen={onOpen} expanded={all} toggle={toggle} />)}
        {!pages.length && <div className="muted small" style={{ padding: 14 }}>No pages yet.</div>}
      </div>
    </>
  );
}

export function CommentsPanel({ comments, currentUrl, selectedId, onSelect, filter, setFilter, scope, setScope, pages }:
  { comments: Comment[]; currentUrl: string; selectedId: string | null; onSelect: (c: Comment) => void; filter: string; setFilter: (f: any) => void; scope: string; setScope: (s: any) => void; pages: Page[] }) {
  const list = comments.filter((c) => (filter === 'all' || c.status === filter) && (scope === 'all' || c.pageUrl === currentUrl));
  const pageName = (c: Comment) => {
    const p = pages.find((x) => x.id === c.pageId);
    return p ? pageLabel(p) : c.pagePath;
  };
  return (
    <>
      <div className="sidebar-tools" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <div className="segmented" style={{ width: '100%' }}>
          {(['all', 'open', 'resolved'] as const).map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} style={{ flex: 1, justifyContent: 'center' }} onClick={() => setFilter(f)} data-testid={`filter-${f}`}>
              {f[0].toUpperCase() + f.slice(1)} <span className="muted small">{comments.filter((c) => (f === 'all' || c.status === f) && (scope === 'all' || c.pageUrl === currentUrl)).length}</span>
            </button>
          ))}
        </div>
        <div className="row small">
          <label className="row" style={{ gap: 4, cursor: 'pointer' }}><input type="radio" checked={scope === 'page'} onChange={() => setScope('page')} /> This page</label>
          <label className="row" style={{ gap: 4, cursor: 'pointer' }}><input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> All pages</label>
        </div>
      </div>
      <div className="sidebar-scroll" style={{ paddingTop: 0 }} data-testid="comments-list">
        {list.length === 0 && <div className="empty small" style={{ padding: '40px 20px' }}>{comments.length ? 'No comments match this filter.' : 'No comments yet. Switch to Comment mode and click anywhere on the page.'}</div>}
        {list.map((c) => (
          <div key={c.id} className={`c-item ${selectedId === c.id ? 'active' : ''}`} onClick={() => onSelect(c)} data-testid="comment-item">
            <span className={`pin`} style={{ position: 'static', margin: 0, width: 24, height: 24, fontSize: 11, flex: 'none', background: c.status === 'resolved' ? 'var(--resolved)' : c.anchor?.state === 'needs_attention' ? 'var(--warning)' : 'var(--primary)' }}>{c.number}</span>
            <div className="body">
              <div className="row" style={{ gap: 6 }}>
                <span className="avatar avatar-sm" style={{ background: colorFor(c.authorName) }}>{initials(c.authorName)}</span>
                <b style={{ fontSize: 13 }}>{c.authorName}</b>
                <span className="muted small">{timeAgo(c.createdAt)}</span>
              </div>
              <div className="text" style={{ marginTop: 4 }}>{c.body}</div>
              <div className="meta">
                {scope === 'all' && <span>{pageName(c)}</span>}
                <span className="badge">{c.breakpoint}</span>
                {c.replies.length > 0 && <span>{c.replies.length} repl{c.replies.length > 1 ? 'ies' : 'y'}</span>}
                {c.status === 'resolved' && <span className="badge badge-resolved">Resolved</span>}
                {c.anchor?.state === 'needs_attention' && <span className="badge badge-warn">Check anchor</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
