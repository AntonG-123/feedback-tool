export function timeAgo(d: string | number | Date) {
  const s = Math.max(1, Math.round((Date.now() - new Date(d).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(d).toLocaleDateString();
}

const COLORS = ['#5b5bf6', '#e2663b', '#1f9e8e', '#c2459b', '#3b82c4', '#8a5cf6', '#d18b17', '#3a9e4d'];
export function colorFor(name: string) {
  let h = 0;
  for (const c of name || '?') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
export const initials = (name: string) => (name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('');

export type Page = { id: string; url: string; path: string; title: string | null; source: string; openCount: number; resolvedCount: number };
export type TreeNode = { key: string; label: string; page?: Page; children: TreeNode[]; open: number; resolved: number };

const pretty = (seg: string) => decodeURIComponent(seg).replace(/[-_]+/g, ' ').replace(/\.(html?|php)$/, '').replace(/^\w/, (c) => c.toUpperCase());

// Builds Category > Subcategory > Page from URL paths. Nodes that are both a
// page and a parent (e.g. /services and /services/seo) carry `page`.
export function buildTree(pages: Page[]): TreeNode {
  const root: TreeNode = { key: '/', label: 'Home', children: [], open: 0, resolved: 0 };
  const sorted = [...pages].sort((a, b) => a.path.localeCompare(b.path));
  for (const p of sorted) {
    const pathOnly = p.path.split('?')[0];
    const segs = pathOnly.split('/').filter(Boolean);
    if (!segs.length && !p.path.includes('?')) {
      root.page = p;
      continue;
    }
    let node = root;
    let key = '';
    segs.forEach((seg, i) => {
      key += '/' + seg;
      let child = node.children.find((c) => c.key === key);
      if (!child) {
        child = { key, label: pretty(seg), children: [], open: 0, resolved: 0 };
        node.children.push(child);
      }
      node = child;
      if (i === segs.length - 1) {
        if (p.path.includes('?')) {
          node.children.push({ key: p.path, label: p.title || p.path.split('?')[1], page: p, children: [], open: 0, resolved: 0 });
        } else {
          node.page = p;
          if (p.title && segs.length === 1) node.label = shortTitle(p.title) || node.label;
        }
      }
    });
  }
  const sum = (n: TreeNode) => {
    n.open = n.page?.openCount || 0;
    n.resolved = n.page?.resolvedCount || 0;
    for (const c of n.children) {
      sum(c);
      n.open += c.open;
      n.resolved += c.resolved;
    }
  };
  sum(root);
  return root;
}

function shortTitle(t: string) {
  const s = t.split(/\s[|–—-]\s/)[0].trim();
  return s.length > 40 ? '' : s;
}

export function pageLabel(p: Page) {
  if (p.path === '/') return 'Home';
  return (p.title && shortTitle(p.title)) || pretty(p.path.split('?')[0].split('/').filter(Boolean).pop() || p.path);
}
