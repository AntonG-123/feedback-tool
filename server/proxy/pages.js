import { escapeHtml } from '../lib/email.js';

const TITLES = {
  invalid_url: 'Invalid URL',
  blocked_url: 'Address not allowed',
  timeout: 'Website timed out',
  site_unavailable: 'Website unavailable',
  auth_required: 'Authentication required',
  auth_failed: 'Site password rejected',
  render_failed: 'Page could not be rendered',
  session_expired: 'Preview session expired',
  form_blocked: 'Form submission disabled',
  unsupported: 'Unsupported page',
  not_found: 'Not found',
};

// Error page shown inside the preview frame. It also notifies the parent app
// so the workspace can show its own error state.
export function errorPage({ code, message, detail, appOrigin }) {
  const title = TITLES[code] || 'Something went wrong';
  const payload = JSON.stringify({ type: 'agm:error', code, title, message }).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{margin:0;font:14px/1.5 Inter,system-ui,-apple-system,Segoe UI,sans-serif;color:#1f2430;background:#f5f6f8;display:flex;align-items:center;justify-content:center;min-height:100vh}
.c{max-width:440px;padding:32px;background:#fff;border:1px solid #e4e6eb;border-radius:12px;text-align:center}
h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#5b6170}code{display:block;margin-top:16px;font-size:12px;color:#8a909c;word-break:break-word}</style></head>
<body><div class="c" data-agm-error="${escapeHtml(code)}"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${detail ? `<code>${escapeHtml(String(detail).slice(0, 300))}</code>` : ''}</div>
<script>try{parent.postMessage(${payload}, ${JSON.stringify(appOrigin)})}catch(e){}</script></body></html>`;
}

// A navigation escaped the proxy namespace and no context could be recovered:
// ask the parent app to navigate the frame properly.
export function lostPage(p, appOrigin) {
  const payload = JSON.stringify({ type: 'agm:lost', path: p }).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Loading…</title></head><body style="font:14px system-ui;color:#5b6170;padding:40px">Loading page…
<script>try{parent.postMessage(${payload}, ${JSON.stringify(appOrigin)})}catch(e){}</script></body></html>`;
}
