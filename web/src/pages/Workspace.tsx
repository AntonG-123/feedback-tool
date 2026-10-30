import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { api, getGuest, setShareToken } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Page } from '../util';
import { useToast } from '../toast';
import { normalizePageUrl } from '../../../shared/urls.js';
import { PagesPanel, CommentsPanel } from '../components/Sidebar';
import { Composer, Attachment } from '../components/Composer';
import { Thread, Comment } from '../components/Thread';
import { DrawingLayer, Shape } from '../components/Drawing';
import { ShareDialog, SettingsDialog, Lightbox } from '../components/Dialogs';

type Bp = 'desktop' | 'tablet' | 'mobile';
type Pos = { id: string; x: number; y: number; visible: boolean; state: string; rect: { x: number; y: number; w: number; h: number } | null };
const norm = (u: string) => { try { return normalizePageUrl(u); } catch { return u; } };
const LOAD_TIMEOUT_MS = 45000;

function proxiedSrc(proxy: { origin: string; token: string }, url: string) {
  const u = new URL(url);
  return `${proxy.origin}/p/${proxy.token}/${u.protocol.slice(0, -1)}/${u.host}${u.pathname}${u.search}`;
}

export function WorkspacePage() {
  const { projectId: routeProjectId, shareToken } = useParams();
  const [search, setSearch] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const { user, loading: authLoading } = useAuth();

  const [projectId, setProjectId] = useState<string | null>(routeProjectId || null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [discovery, setDiscovery] = useState('pending');
  const [comments, setComments] = useState<Comment[]>([]);
  const [currentUrl, setCurrentUrl] = useState<string>('');
  const [frameUrl, setFrameUrl] = useState<string>('');
  const [frameKey, setFrameKey] = useState(0);
  const [frameState, setFrameState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [frameError, setFrameError] = useState<any>(null);
  const [bp, setBp] = useState<Bp>((search.get('bp') as Bp) || 'desktop');
  const [mode, setMode] = useState<'browse' | 'comment'>('comment');
  const [pinsView, setPinsView] = useState<'all' | 'open' | 'none'>('all');
  const [positions, setPositions] = useState<Record<string, Pos>>({});
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const [pending, setPending] = useState<any>(null);
  const [selectedId, setSelectedId] = useState<string | null>(search.get('comment'));
  const [drawActive, setDrawActive] = useState(false);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [fullscreen, setFullscreen] = useState(false);
  const [tab, setTab] = useState<'pages' | 'comments'>(search.get('comment') ? 'comments' : 'pages');
  const [filter, setFilter] = useState<'all' | 'open' | 'resolved'>('all');
  const [scope, setScope] = useState<'page' | 'all'>('page');
  const [dialog, setDialog] = useState<null | 'share' | 'settings'>(null);
  const [pinsMenu, setPinsMenu] = useState(false);
  const [lightbox, setLightbox] = useState<{ url: string; download: string } | null>(null);
  const [, setGuestName] = useState(getGuest()?.name || '');

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const deviceRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<HTMLDivElement>(null);
  const scrollToRef = useRef<string | null>(search.get('comment'));
  const stateRef = useRef<any>({});
  stateRef.current = { comments, currentUrl, mode, bp, pinsView, pages, data, selectedId, pending };

  const role: 'owner' | 'guest' = data?.role || 'guest';
  const proxy = data?.proxy;

  // ---------- load project ----------
  useEffect(() => {
    if (shareToken) {
      setShareToken(shareToken);
      api(`/share/${shareToken}`).then((r) => setProjectId(r.projectId)).catch((e) => setFatal(e.message));
    } else {
      setShareToken(null);
      if (!authLoading && !user) nav('/login', { replace: true });
    }
  }, [shareToken, authLoading, user]);

  const loadPages = useCallback(async () => {
    if (!projectId) return;
    const r = await api(`/projects/${projectId}/pages`);
    setPages(r.pages);
    setDiscovery(r.discoveryStatus);
    return r;
  }, [projectId]);
  const loadComments = useCallback(async () => {
    if (!projectId) return;
    const r = await api(`/projects/${projectId}/comments`);
    setComments(r.comments);
    return r.comments as Comment[];
  }, [projectId]);

  useEffect(() => {
    if (!projectId || (!shareToken && !user)) return;
    (async () => {
      try {
        const d = await api(`/projects/${projectId}`);
        setData(d);
        const [, list] = await Promise.all([loadPages(), loadComments()]);
        const deep = search.get('comment') && list?.find((c) => c.id === search.get('comment'));
        const start = deep ? deep.pageUrl : search.get('page') || d.project.url;
        if (deep) setBp(deep.breakpoint);
        setCurrentUrl(norm(start));
        setFrameUrl(norm(start));
      } catch (e: any) {
        setFatal(e.message);
      }
    })();
  }, [projectId, user]);

  // Poll for updates from other reviewers; faster while screenshots render.
  useEffect(() => {
    if (!projectId || !data) return;
    const anyPending = comments.some((c) => c.screenshots?.crop?.status === 'pending');
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') { loadComments().catch(() => {}); if (discovery === 'pending' || discovery === 'running') loadPages().catch(() => {}); }
    }, anyPending ? 3000 : 10000);
    return () => clearInterval(t);
  }, [projectId, data, comments, discovery]);

  // Proxy tokens expire after 12h: refresh before navigating the frame.
  const refreshToken = async () => {
    const d = await api(`/projects/${projectId}`);
    setData(d);
    return d.proxy;
  };

  // ---------- frame lifecycle ----------
  useEffect(() => {
    if (!frameUrl || !proxy) return;
    setFrameState('loading');
    setFrameError(null);
    setPositions({});
    const t = setTimeout(() => {
      setFrameState((s) => {
        if (s === 'loading') setFrameError({ code: 'timeout', title: 'Website timed out', message: 'The website did not finish loading through the preview in time.' });
        return s === 'loading' ? 'error' : s;
      });
    }, LOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [frameUrl, frameKey, proxy?.token]);

  const pinsFor = useCallback(() => {
    const s = stateRef.current;
    if (s.pinsView === 'none') return [];
    return s.comments
      .filter((c: Comment) => c.pageUrl === s.currentUrl && c.breakpoint === s.bp && c.anchor && (s.pinsView === 'all' || c.status === 'open' || c.id === s.selectedId))
      .map((c: Comment) => ({ id: c.id, locator: c.anchor.locator, rx: c.anchor.rx, ry: c.anchor.ry, docX: c.anchor.docX, docY: c.anchor.docY, bp: c.breakpoint }));
  }, []);
  const post = useCallback((msg: any) => {
    const w = iframeRef.current?.contentWindow;
    if (w && proxy) w.postMessage(msg, proxy.origin);
  }, [proxy]);

  // Messages from the overlay inside the proxied page.
  useEffect(() => {
    if (!proxy) return;
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== proxy.origin || e.source !== iframeRef.current?.contentWindow || !e.data?.type) return;
      const m = e.data;
      const s = stateRef.current;
      switch (m.type) {
        case 'agm:ready':
          setFrameState('ready');
          post({ type: 'agm:hello', mode: s.mode, breakpoint: s.bp, pins: pinsFor() });
          if (scrollToRef.current) {
            const id = scrollToRef.current;
            setTimeout(() => post({ type: 'agm:scrollTo', id, smooth: false }), 300);
            scrollToRef.current = null;
          }
          break;
        case 'agm:nav': {
          const u = norm(m.url);
          if (u !== s.currentUrl) {
            setCurrentUrl(u);
            setPending(null);
            setShapes([]);
            setDrawActive(false);
            if (!s.comments.some((c: Comment) => c.id === s.selectedId && c.pageUrl === u)) setSelectedId(null);
          }
          if (!s.pages.some((p: Page) => p.url === u)) {
            api(`/projects/${s.data.project.id}/pages`, { body: { url: u, title: m.title } }).then(() => loadPages()).catch(() => {});
          }
          break;
        }
        case 'agm:select':
          if (s.mode !== 'comment') break;
          setSelectedId(null);
          setShapes([]);
          setPending(m);
          break;
        case 'agm:positions': {
          const map: Record<string, Pos> = {};
          for (const p of m.pins) map[p.id] = p;
          setPositions(map);
          setScroll(m.scroll);
          break;
        }
        case 'agm:anchorState': {
          const c = s.comments.find((x: Comment) => x.id === m.id);
          if (c && c.anchor && c.anchor.state !== m.state) {
            api(`/comments/${c.id}/anchor-state`, { body: { state: m.state } }).catch(() => {});
            setComments((list) => list.map((x) => (x.id === c.id ? { ...x, anchor: { ...x.anchor, state: m.state } } : x)));
          }
          break;
        }
        case 'agm:error':
          setFrameState('error');
          setFrameError(m);
          break;
        case 'agm:lost':
          setFrameUrl(norm(new URL(m.path, s.data.project.origin).toString()));
          setFrameKey((k) => k + 1);
          break;
        case 'agm:external':
          window.open(m.url, '_blank', 'noopener');
          toast('External link opened in a new tab');
          break;
        case 'agm:formBlocked':
          toast('Form submissions are disabled in the review preview');
          break;
        case 'agm:escape':
          setPending(null);
          setSelectedId(null);
          setDrawActive(false);
          break;
        case 'agm:toggleMode':
          setMode((x) => (x === 'comment' ? 'browse' : 'comment'));
          break;
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [proxy, post, pinsFor]);

  useEffect(() => { post({ type: 'agm:mode', mode }); }, [mode, post]);
  useEffect(() => { post({ type: 'agm:pins', breakpoint: bp, pins: pinsFor() }); }, [comments, currentUrl, bp, pinsView, selectedId, post]);
  useEffect(() => { if (!pending) post({ type: 'agm:clearPending' }); }, [pending, post]);
  useEffect(() => { setPending(null); setShapes([]); setDrawActive(false); }, [bp]);

  // Keyboard shortcuts on the app side.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
      if (e.key === 'Escape') { if (drawActive) setDrawActive(false); else { setPending(null); setSelectedId(null); } }
      if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey) setMode((x) => (x === 'comment' ? 'browse' : 'comment'));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawActive]);

  // Fullscreen: browser fullscreen on the workspace + layout without chrome.
  useEffect(() => {
    const onFs = () => { if (!document.fullscreenElement) setFullscreen(false); };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);
  const toggleFullscreen = async () => {
    if (fullscreen) {
      setFullscreen(false);
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    } else {
      setFullscreen(true);
      await wsRef.current?.requestFullscreen?.().catch(() => {});
    }
  };

  // ---------- actions ----------
  const openPage = async (url: string) => {
    const u = norm(url);
    setPending(null);
    setShapes([]);
    setDrawActive(false);
    if (u === currentUrl && frameState !== 'error') return;
    setCurrentUrl(u);
    setFrameUrl(u);
    setFrameKey((k) => k + 1);
  };
  const reload = async () => {
    await refreshToken().catch(() => {});
    setFrameUrl(currentUrl);
    setFrameKey((k) => k + 1);
  };
  const selectComment = (c: Comment) => {
    setPending(null);
    setSelectedId(c.id);
    setSearch((sp) => { sp.set('comment', c.id); return sp; }, { replace: true });
    if (c.breakpoint !== bp) setBp(c.breakpoint);
    if (c.pageUrl !== currentUrl) {
      scrollToRef.current = c.id;
      setCurrentUrl(c.pageUrl);
      setFrameUrl(c.pageUrl);
      setFrameKey((k) => k + 1);
    } else {
      setTimeout(() => post({ type: 'agm:scrollTo', id: c.id }), c.breakpoint !== bp ? 400 : 0);
    }
  };
  const closeThread = () => {
    setSelectedId(null);
    setSearch((sp) => { sp.delete('comment'); return sp; }, { replace: true });
  };
  const upsertComment = (c: Comment) => setComments((list) => (list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [...list, c]));
  const submitComment = async (body: string, atts: Attachment[]) => {
    const pend = stateRef.current.pending;
    const pos = positions.pending;
    const rect = pos?.rect;
    const shapesOut = shapes.map((s) => ({
      ...s,
      points: s.points.map((p) => ({ x: p.x, y: p.y, ...(rect ? { rel: { x: p.x - (rect.x + scroll.x), y: p.y - (rect.y + scroll.y) } } : {}) })),
    }));
    try {
      const r = await api(`/projects/${data.project.id}/comments`, {
        body: {
          pageUrl: currentUrl, pageTitle: iframeTitle(), breakpoint: bp, body,
          anchor: { locator: pend.locator, rx: pend.rx, ry: pend.ry, docX: pend.docX, docY: pend.docY, viewportW: pend.viewport.w, viewportH: pend.viewport.h },
          drawing: shapesOut.length ? { shapes: shapesOut } : null,
          attachmentIds: atts.map((a) => a.id),
        },
      });
      upsertComment(r.comment);
      setPending(null);
      setShapes([]);
      setDrawActive(false);
      setSelectedId(r.comment.id);
      loadPages().catch(() => {});
      toast(`Comment #${r.comment.number} added`);
    } catch (e: any) {
      if (e.code === 'validation_failed') return e.data.validation;
      throw e;
    }
  };
  const iframeTitle = () => stateRef.current.pages.find((p: Page) => p.url === currentUrl)?.title || null;

  // ---------- derived ----------
  const selected = comments.find((c) => c.id === selectedId) || null;
  const visiblePins = useMemo(() => {
    if (pinsView === 'none') return [];
    return comments.filter((c) => c.pageUrl === currentUrl && c.breakpoint === bp && (pinsView === 'all' || c.status === 'open' || c.id === selectedId));
  }, [comments, currentUrl, bp, pinsView, selectedId]);
  const deviceBox = deviceRef.current?.getBoundingClientRect();

  const popStyle = (x: number, y: number): React.CSSProperties => {
    const W = deviceBox?.width || 1000, H = deviceBox?.height || 700;
    const w = 360;
    let left = x + 24;
    if (left + w > W - 8) left = Math.max(8, x - w - 16);
    const top = Math.max(8, Math.min(y - 20, H - 420));
    return { left, top };
  };
  const pendingPos = positions.pending;
  const selPos = selected ? positions[selected.id] : null;
  const dockStyle: React.CSSProperties = { right: 12, top: 12 };

  // ---------- render ----------
  if (fatal) {
    return (
      <div className="auth-page"><div className="card auth-card"><h1 style={{ fontSize: 18 }}>Can't open this project</h1><p className="muted">{fatal}</p>{user && <Link className="btn" to="/projects">Back to projects</Link>}</div></div>
    );
  }
  if (!data) return <div className="auth-page"><span className="spinner" /></div>;

  const overviewHref = shareToken ? `/s/${shareToken}/comments` : `/projects/${data.project.id}/comments`;
  const currentPath = (() => { try { const u = new URL(currentUrl); return u.pathname + u.search; } catch { return currentUrl; } })();
  const pinsLabel = { all: 'Show all pins', open: 'Hide resolved', none: 'Hide all pins' }[pinsView];

  const modeToggle = (
    <div className="segmented" data-testid="mode-toggle">
      <button className={mode === 'browse' ? 'on' : ''} onClick={() => setMode('browse')} title="Browse mode — interact with the website (C)" data-testid="mode-browse"><Icon.cursor size={15} /> Browse</button>
      <button className={mode === 'comment' ? 'on' : ''} onClick={() => setMode('comment')} title="Comment mode — click to leave feedback (C)" data-testid="mode-comment"><Icon.comment size={15} /> Comment</button>
    </div>
  );
  const deviceToggle = (
    <div className="segmented icons" data-testid="device-toggle">
      {(['desktop', 'tablet', 'mobile'] as Bp[]).map((d) => {
        const I = Icon[d];
        return <button key={d} className={bp === d ? 'on' : ''} onClick={() => setBp(d)} title={d[0].toUpperCase() + d.slice(1)} data-testid={`bp-${d}`}><I size={16} /></button>;
      })}
    </div>
  );
  const pinsButton = (
    <span style={{ position: 'relative' }}>
      <button className={`icon-btn ${pinsView !== 'all' ? 'active' : ''}`} title={pinsLabel} onClick={() => setPinsMenu(!pinsMenu)} data-testid="pins-menu">{pinsView === 'none' ? <Icon.eyeOff /> : <Icon.eye />}</button>
      {pinsMenu && (
        <div className="menu" style={{ right: 0, top: 38 }} onMouseLeave={() => setPinsMenu(false)}>
          {(['all', 'open', 'none'] as const).map((v) => (
            <button key={v} className={`menu-item ${pinsView === v ? 'on' : ''}`} onClick={() => { setPinsView(v); setPinsMenu(false); }} data-testid={`pins-${v}`}>
              {pinsView === v ? <Icon.check size={15} /> : <span style={{ width: 15 }} />} {{ all: 'Show all pins', open: 'Hide resolved pins', none: 'Hide all pins' }[v]}
            </button>
          ))}
        </div>
      )}
    </span>
  );

  return (
    <div className={`ws ${fullscreen ? 'fullscreen' : ''}`} ref={wsRef} onClick={() => pinsMenu && setPinsMenu(false)}>
      <header className="ws-header">
        <div className="left">
          {role === 'owner' && <Link className="icon-btn" to="/projects" title="All projects"><Icon.back /></Link>}
          <div className="ws-title"><b>{data.project.name}</b><span>{currentPath}</span></div>
        </div>
        <div className="row" style={{ gap: 12 }}>{modeToggle}{deviceToggle}</div>
        <div className="right">
          {pinsButton}
          <button className="icon-btn" title="Fullscreen" onClick={toggleFullscreen} data-testid="fullscreen"><Icon.expand /></button>
          <Link className="btn btn-ghost" to={overviewHref} data-testid="overview-link"><Icon.list size={16} /> Overview</Link>
          {role === 'owner' && <button className="icon-btn" title="Project settings" onClick={() => setDialog('settings')} data-testid="settings"><Icon.settings /></button>}
          {role === 'owner' && <button className="btn btn-primary" onClick={() => setDialog('share')} data-testid="share"><Icon.share size={15} /> Share</button>}
        </div>
      </header>
      <div className="ws-body">
        <aside className="sidebar">
          <div className="sidebar-tabs">
            <button className={tab === 'pages' ? 'on' : ''} onClick={() => setTab('pages')} data-testid="tab-pages">Pages <span className="muted small">{pages.length}</span></button>
            <button className={tab === 'comments' ? 'on' : ''} onClick={() => setTab('comments')} data-testid="tab-comments">Comments <span className="muted small">{comments.filter((c) => c.status === 'open').length}</span></button>
          </div>
          {tab === 'pages'
            ? <PagesPanel pages={pages} current={currentUrl} onOpen={(p) => openPage(p.url)} discovery={discovery} />
            : <CommentsPanel comments={comments} currentUrl={currentUrl} selectedId={selectedId} onSelect={selectComment} filter={filter} setFilter={setFilter} scope={scope} setScope={setScope} pages={pages} />}
        </aside>
        <main className="canvas">
          <div className="addr">
            <button className="icon-btn icon-btn-sm" title="Reload" onClick={reload}><Icon.reload size={15} /></button>
            <div className="url" title={currentUrl} data-testid="current-url">{currentUrl}</div>
            <a className="icon-btn icon-btn-sm" href={currentUrl} target="_blank" rel="noreferrer noopener" title="Open original page"><Icon.external size={15} /></a>
          </div>
          <div className="stage">
            <div ref={deviceRef} className={`device ${bp} ${mode === 'comment' ? 'comment-mode' : ''}`} data-testid="device" data-bp={bp}>
              {frameUrl && proxy && (
                <iframe
                  key={frameKey}
                  ref={iframeRef}
                  src={proxiedSrc(proxy, frameUrl)}
                  title="Website preview"
                  data-testid="preview-frame"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
                  allow="autoplay; fullscreen"
                  onLoad={() => setTimeout(() => setFrameState((s) => (s === 'loading' ? 'ready' : s)), 4000)}
                />
              )}
              {frameState === 'loading' && <div className="state-cover" style={{ background: 'rgba(255,255,255,.85)' }}><span className="spinner" /><p className="small">Loading website…</p></div>}
              {frameState === 'error' && frameError && (
                <div className="state-cover" data-testid="frame-error" data-code={frameError.code}>
                  <Icon.alert size={28} />
                  <h3>{frameError.title}</h3>
                  <p>{frameError.message}</p>
                  <div className="row">
                    <button className="btn" onClick={reload}><Icon.reload size={15} /> Try again</button>
                    {role === 'owner' && frameError.code?.startsWith('auth') && <button className="btn btn-primary" onClick={() => setDialog('settings')}>Add site password</button>}
                  </div>
                </div>
              )}

              <DrawingLayer active={drawActive && !!pending} shapes={pending ? shapes : []} setShapes={setShapes} scroll={scroll}
                onScroll={(dx, dy) => post({ type: 'agm:scrollBy', dx, dy })} onDone={() => setDrawActive(false)} />

              <div className="layer" style={{ zIndex: 16 }}>
                {frameState === 'ready' && visiblePins.map((c) => {
                  const p = positions[c.id];
                  if (!p || !p.visible) return null;
                  const cls = c.status === 'resolved' ? 'resolved' : p.state === 'needs_attention' ? 'attention' : '';
                  return (
                    <div key={c.id} className={`pin ${cls} ${selectedId === c.id ? 'selected' : ''}`} style={{ left: p.x, top: p.y }}
                      onClick={(e) => { e.stopPropagation(); selectComment(c); }} data-testid="pin" data-number={c.number} data-status={c.status}
                      title={p.state === 'needs_attention' ? 'Element not found — last known position' : `#${c.number}`}>
                      {p.state === 'needs_attention' ? '!' : c.number}
                    </div>
                  );
                })}
                {pending && pendingPos && <div className="pin pending" style={{ left: pendingPos.x, top: pendingPos.y }} data-testid="pending-pin">+</div>}
                {pending && (
                  <Composer
                    projectId={data.project.id}
                    isOwner={role === 'owner'}
                    ownerName={data.me?.name}
                    element={pending.locator ? { tag: pending.locator.tag, isImage: pending.locator.isImage, text: pending.elementInfo?.text } : null}
                    style={pendingPos ? popStyle(pendingPos.x, pendingPos.y) : popStyle(pending.client.x, pending.client.y)}
                    drawingCount={shapes.length}
                    drawingActive={drawActive}
                    onToggleDraw={() => setDrawActive((x) => !x)}
                    onCancel={() => { setPending(null); setShapes([]); setDrawActive(false); }}
                    onSubmit={submitComment}
                    onGuest={(n) => setGuestName(n)}
                  />
                )}
                {!pending && selected && (
                  <Thread
                    key={selected.id}
                    comment={selected}
                    role={role}
                    projectId={data.project.id}
                    style={selPos && selPos.visible && selected.pageUrl === currentUrl ? popStyle(selPos.x, selPos.y) : dockStyle}
                    onClose={closeThread}
                    onUpdate={upsertComment}
                    onDelete={(id) => { setComments((l) => l.filter((x) => x.id !== id)); closeThread(); loadPages().catch(() => {}); }}
                    onOpenImage={(url, download) => setLightbox({ url, download })}
                    onGuest={(n) => setGuestName(n)}
                  />
                )}
              </div>
            </div>
          </div>
          {fullscreen && (
            <div className="fs-bar" data-testid="fs-bar">
              {modeToggle}
              {deviceToggle}
              {pinsButton}
              <button className="btn btn-sm" onClick={toggleFullscreen} data-testid="exit-fullscreen"><Icon.shrink size={14} /> Exit fullscreen</button>
            </div>
          )}
        </main>
      </div>
      {dialog === 'share' && <ShareDialog projectId={data.project.id} share={data.share} onChange={(s) => setData({ ...data, share: s })} onClose={() => setDialog(null)} />}
      {dialog === 'settings' && <SettingsDialog project={data.project} onSaved={(p) => { setData({ ...data, project: p }); reload(); }} onClose={() => setDialog(null)} />}
      {lightbox && <Lightbox {...lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
