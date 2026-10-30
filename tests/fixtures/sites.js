// Local fixture websites used by the automated tests (the CI sandbox cannot
// reach the public internet). They reproduce behaviours of real platforms:
//  static.test   - multi-page marketing site (Webflow-like markup, sitemap index,
//                  CSS url(), fonts, srcset, lazy data-src, forms, analytics + chat + cookie banner scripts)
//  spa.test      - client-side routed app (pushState router, fetch to root-relative API,
//                  JS-created root-relative images, dynamic import, location.pathname routing)
//  wfpass.test   - Webflow password-protected site (/.wf_auth -> wf_auth cookie)
//  shoppass.test - Shopify password page (/password -> storefront_digest cookie)
import http from 'node:http';

export const FIXTURE_PORTS = { static: 4101, spa: 4102, wfpass: 4103, shoppass: 4104 };
export const TEST_HOST_MAP = Object.entries(FIXTURE_PORTS).map(([k, p]) => `${k}.test=127.0.0.1:${p}`).join(',');
export const MUTABLE = { heroText: 'Build better websites', insertWrapper: false, removeSub: false };
const DEFAULT_STATE = { ...MUTABLE };

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function layout(title, body, extraHead = '') {
  return `<!DOCTYPE html><html data-wf-page="abc" lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'">
<link rel="stylesheet" href="/css/site.css">
<script src="https://www.googletagmanager.com/gtag/js?id=G-TEST"></script>
<script>window.dataLayer=[];function gtag(){dataLayer.push(arguments)}gtag('config','G-TEST');</script>
<script src="https://widget.intercom.io/widget/abc"></script>
<script src="https://consent.cookiebot.com/uc.js"></script>
${extraHead}</head><body>
<div id="CybotCookiebotDialog" style="position:fixed;bottom:0;left:0;right:0;height:120px;background:#000;color:#fff">We use cookies</div>
<nav class="navbar"><a href="/" class="nav-link">Home</a> <a href="/about" class="nav-link">About</a> <a href="services/web-design" class="nav-link">Web design</a> <a href="/blog/first-post" class="nav-link">Blog</a> <a href="https://external.example.org/x" class="nav-link ext">External</a> <a href="#contact" class="nav-link">Jump</a></nav>
${body}
<footer id="contact" class="footer" style="margin-top:1200px"><p class="footer-text">Contact us at hello@static.test</p>
<form class="contact-form" method="post" action="/contact"><input name="email"><button type="submit" class="submit-btn">Send</button></form>
<form role="search" action="/search" method="get"><input type="search" name="q"><button>Search</button></form></footer>
<script src="/js/site.js"></script></body></html>`;
}

function staticSite(req, res) {
  const url = new URL(req.url, 'http://static.test');
  const p = url.pathname;
  const send = (type, body, status = 200, headers = {}) => {
    res.writeHead(status, { 'content-type': type, 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", ...headers });
    res.end(body);
  };
  // Test hooks: mutate the page between page loads / simulate a slow server.
  if (p === '/__fixture/state' && req.method === 'POST') {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { Object.assign(MUTABLE, DEFAULT_STATE, b ? JSON.parse(b) : {}); send('application/json', JSON.stringify(MUTABLE)); });
    return;
  }
  if (p === '/slow') return setTimeout(() => send('text/html', '<h1>slow</h1>'), 8000);
  if (p === '/robots.txt') return send('text/plain', 'User-agent: *\nSitemap: https://static.test/sitemap_index.xml\n');
  if (p === '/sitemap_index.xml') return send('application/xml', `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://static.test/page-sitemap.xml</loc></sitemap><sitemap><loc>https://static.test/post-sitemap.xml</loc></sitemap></sitemapindex>`);
  if (p === '/page-sitemap.xml') return send('application/xml', `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://static.test/</loc></url><url><loc>https://static.test/about</loc></url><url><loc>https://static.test/services/web-design</loc></url><url><loc>https://static.test/services/seo</loc></url><url><loc>https://static.test/about/</loc></url></urlset>`);
  if (p === '/post-sitemap.xml') return send('application/xml', `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc><![CDATA[https://static.test/blog/first-post]]></loc></url><url><loc>https://static.test/blog/second-post?utm_source=x</loc></url><url><loc>https://static.test/files/brochure.pdf</loc></url></urlset>`);
  if (p === '/css/site.css') return send('text/css', `@import "/css/extra.css";\n@font-face{font-family:Fixture;src:url("../fonts/fixture.woff2") format("woff2")}\nbody{font-family:Fixture,Arial,sans-serif;margin:0;background:#fff}.hero{background:url(/img/bg.png) #eef;padding:80px 40px}.hero-heading{font-size:48px;margin:0}.navbar{padding:16px;display:flex;gap:16px}.card{display:inline-block;width:200px;margin:10px;padding:16px;border:1px solid #ddd}`);
  if (p === '/css/extra.css') return send('text/css', `.footer{padding:40px;background:#222;color:#fff}`);
  if (p === '/fonts/fixture.woff2') return send('font/woff2', Buffer.alloc(0));
  if (p.startsWith('/img/')) return send('image/png', PNG, 200, { 'cache-control': 'max-age=60' });
  if (p === '/js/site.js') return send('application/javascript', `document.documentElement.classList.add('js-ran');
document.querySelectorAll('img[data-src]').forEach(function(i){ i.src = i.getAttribute('data-src').replace('/p/', '/p/') });
fetch('/api/status.json').then(r=>r.json()).then(j=>{ var b=document.createElement('div'); b.id='api-status'; b.textContent='API: '+j.status; document.body.appendChild(b); });
var dyn = new Image(); dyn.id='dyn-img'; dyn.src='/img/dynamic.png'; document.body.appendChild(dyn);`);
  if (p === '/api/status.json') return send('application/json', JSON.stringify({ status: 'ok', host: req.headers.host, cookie: req.headers.cookie || '' }), 200, { 'set-cookie': 'visited=1; Path=/; HttpOnly' });
  if (p === '/contact' && req.method === 'POST') return send('text/html', '<h1>FORM WAS SUBMITTED</h1>');
  if (p === '/search') return send('text/html', layout('Search', `<h1 class="search-title">Results for ${String(url.searchParams.get('q') || '').replace(/[<>&"]/g, '')}</h1>`));
  if (p === '/old-page') return send('text/html', '', 301, { location: '/about' });
  if (p === '/' || p === '/index.html') {
    const heading = `<h1 class="hero-heading" data-w-id="hero-h1">${MUTABLE.heroText}</h1>`;
    return send('text/html', layout('Home – Static Fixture', `<section class="hero">${MUTABLE.insertWrapper ? `<div class="wrap">${heading}</div>` : heading}
${MUTABLE.removeSub ? '' : '<p class="hero-sub">We design and build websites for growing brands.</p>'}
<a href="/about" class="button cta">Learn more</a>
<img class="hero-img" src="img/hero.png" srcset="/img/hero.png 1x, /img/hero@2x.png 2x" alt="Hero image" width="300" height="150">
<img class="lazy" data-src="/img/lazy.png" alt="Lazy image" width="50" height="50"></section>
<section class="cards">${[1, 2, 3].map((i) => `<div class="card"><h3 class="card-title">Service ${i}</h3><p>Description of service number ${i}.</p><a href="/services/web-design" class="card-link">Learn more</a></div>`).join('')}</section>`));
  }
  if (p === '/about') return send('text/html', layout('About us', `<h1 class="page-title">About us</h1><p class="about-text">We are a small studio.</p>`));
  if (p.startsWith('/services/') || p.startsWith('/blog/')) return send('text/html', layout(p.split('/').pop(), `<h1 class="page-title">${p}</h1>`));
  return send('text/html', layout('Not found', '<h1>404</h1>'), 404);
}

function spaSite(req, res) {
  const url = new URL(req.url, 'http://spa.test');
  const p = url.pathname;
  if (p === '/api/items') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': 'http://spa.test' });
    return res.end(JSON.stringify({ items: ['Alpha', 'Beta', 'Gamma'], path: p }));
  }
  if (p === '/assets/chunk.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    return res.end(`export const label = 'chunk loaded';`);
  }
  if (p.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
  if (p === '/assets/app.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    return res.end(`
function render(){
  var path = location.pathname;
  var app = document.getElementById('app');
  if (path === '/' ) app.innerHTML = '<h1 class="spa-title">SPA Home</h1><a href="/products" data-link class="spa-link">Products</a>';
  else if (path === '/products') app.innerHTML = '<h1 class="spa-title">Products</h1><ul id="items"></ul><a href="/" data-link class="spa-link">Back home</a>';
  else app.innerHTML = '<h1 class="spa-title">Client 404 for ' + path + '</h1>';
  if (path === '/products') fetch('/api/items').then(function(r){return r.json()}).then(function(j){
    document.getElementById('items').innerHTML = j.items.map(function(i){return '<li class="item">'+i+'</li>'}).join('');
  });
  var img = document.createElement('img'); img.className='spa-img'; img.src = '/img/logo.png'; img.width=20; app.appendChild(img);
}
document.addEventListener('click', function(e){
  var a = e.target.closest('a[data-link]'); if(!a) return; e.preventDefault();
  history.pushState({}, '', a.getAttribute('href')); render();
});
window.addEventListener('popstate', render);
render();
import('/assets/chunk.js').then(function(m){ var d=document.createElement('div'); d.id='chunk'; d.textContent=m.label; document.body.appendChild(d); });
`);
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html><head><title>SPA Fixture</title></head><body><div id="app"></div><script type="module" src="/assets/app.js"></script></body></html>`);
}

function passwordSite(kind) {
  const cookieName = kind === 'webflow' ? 'wf_auth' : 'storefront_digest';
  return (req, res) => {
    const url = new URL(req.url, 'http://x');
    const authed = (req.headers.cookie || '').includes(`${cookieName}=good`);
    if (req.method === 'POST' && (url.pathname === '/.wf_auth' || url.pathname === '/password')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const f = new URLSearchParams(body);
        const pw = f.get('pass') || f.get('password');
        if (pw === 'secret123') {
          res.writeHead(302, { location: '/', 'set-cookie': `${cookieName}=good; Path=/; HttpOnly` });
        } else res.writeHead(302, { location: '/?e=1' });
        res.end();
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (!authed) {
      return res.end(kind === 'webflow'
        ? `<html><body class="w-password-page"><form action="/.wf_auth" method="post"><input type="password" name="pass"><input type="hidden" name="path" value="/"></form></body></html>`
        : `<html><body><form method="post" action="/password"><input type="hidden" name="form_type" value="storefront_password"><input type="password" name="password"></form></body></html>`);
    }
    res.end(`<html><head><title>Protected ${kind}</title></head><body><h1 class="secret-title">Protected ${kind} content</h1><a href="/inner">Inner</a></body></html>`);
  };
}

export async function startFixtures() {
  const servers = [];
  const handlers = { static: staticSite, spa: spaSite, wfpass: passwordSite('webflow'), shoppass: passwordSite('shopify') };
  for (const [k, port] of Object.entries(FIXTURE_PORTS)) {
    const s = http.createServer(handlers[k]);
    await new Promise((r) => s.listen(port, '127.0.0.1', r));
    servers.push(s);
  }
  return () => Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
}

if (process.argv[1]?.endsWith('sites.js')) startFixtures().then(() => console.log('fixtures up', TEST_HOST_MAP));
