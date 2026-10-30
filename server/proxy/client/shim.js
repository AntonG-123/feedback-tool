/* AGM proxy runtime shim. Runs first in every proxied document.
 * Keeps URLs created by site JavaScript inside the proxy namespace, restores
 * the original pathname for client-side routers, blocks real form
 * submissions and service workers, and reports navigation to the app. */
(function () {
  'use strict';
  var C = window.__AGM__;
  if (!C || window.__AGM_SHIM__) return;
  window.__AGM_SHIM__ = true;

  var PROXY = location.origin;
  var PREFIX = '/p/' + C.token;
  var target = new URL(C.target);
  var projHost = new URL(C.projectOrigin).hostname;
  var PASS = { 'fonts.googleapis.com': 1, 'fonts.gstatic.com': 1, 'cdnjs.cloudflare.com': 1, 'cdn.jsdelivr.net': 1, 'unpkg.com': 1,
    'ajax.googleapis.com': 1, 'code.jquery.com': 1, 'www.youtube.com': 1, 'player.vimeo.com': 1, 'www.google.com': 1 };
  var framed = window.parent !== window;

  function bare(h) { return String(h).toLowerCase().replace(/^www\./, ''); }
  function sameSite(a, b) { a = bare(a); b = bare(b); return a === b || a.slice(-(b.length + 1)) === '.' + b || b.slice(-(a.length + 1)) === '.' + a; }
  function post(msg) { if (framed) try { window.parent.postMessage(msg, C.appOrigin); } catch (e) {} }
  window.__agmPost = post;

  function proxify(u) {
    return PREFIX + '/' + u.protocol.slice(0, -1) + '/' + u.host + u.pathname + u.search + u.hash;
  }
  // Original (unproxied) URL from a proxied absolute URL, or null.
  function unproxy(u) {
    var m = u.pathname.match(/^\/p\/[^/]+\/(https?|wss?)\/([^/]+)(\/.*)?$/);
    if (!m) return null;
    return new URL(m[1] + '://' + m[2] + (m[3] || '/') + u.search + u.hash);
  }
  function currentOriginal() {
    return new URL(location.pathname + location.search + location.hash, target.origin);
  }
  // Resolve any URL the page uses into an absolute URL, interpreting
  // root-relative proxy-origin URLs as belonging to the current site.
  function resolveOriginal(input) {
    var u = new URL(String(input).trim(), document.baseURI);
    if (u.origin === PROXY) {
      if (u.pathname.indexOf('/p/') === 0) return unproxy(u) || u;
      if (u.pathname.indexOf('/__agm/') === 0) return u;
      return new URL(u.pathname + u.search + u.hash, target.origin);
    }
    return u;
  }
  function rw(input, kind) {
    if (input == null) return input;
    var s = String(input).trim();
    if (!s || /^(#|data:|blob:|javascript:|mailto:|tel:|about:|sms:)/i.test(s)) return input;
    var u;
    try { u = resolveOriginal(s); } catch (e) { return input; }
    if (u.origin === PROXY) return u.href;
    if (u.protocol === 'ws:' || u.protocol === 'wss:') return PROXY.replace(/^http/, 'ws') + proxify(u);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return input;
    if (PASS[u.hostname]) return u.href;
    if (kind === 'frame' && !sameSite(u.hostname, projHost)) return u.href;
    return PROXY + proxify(u);
  }
  function rwSrcset(v) {
    return String(v).split(/,(?=\s*\S)/).map(function (p) {
      var m = p.trim().match(/^(\S+)(\s+.*)?$/);
      return m ? rw(m[1]) + (m[2] || '') : p;
    }).join(', ');
  }
  window.__agmRewrite = rw;
  window.__agmOriginalUrl = function () { return currentOriginal().href; };

  // ---- Restore the original path for client-side routers -----------------
  var oPush = history.pushState, oReplace = history.replaceState;
  var baseEl = document.querySelector('base');
  function updateBase() {
    if (baseEl) baseEl.setAttribute('href', PROXY + proxify(new URL(location.pathname + location.search, target.origin)));
  }
  function cleanStateUrl(url) {
    if (url == null) return url;
    try {
      var u = new URL(String(url), document.baseURI);
      if (u.origin === PROXY) {
        var o = u.pathname.indexOf('/p/') === 0 ? unproxy(u) : u;
        if (o && o.origin !== PROXY && !sameSite(o.hostname, target.hostname)) return url;
        return o.pathname + o.search + o.hash;
      }
      if (sameSite(u.hostname, target.hostname)) return u.pathname + u.search + u.hash;
    } catch (e) {}
    return url;
  }
  try { oReplace.call(history, history.state, '', target.pathname + target.search + location.hash); } catch (e) {}
  var lastNav = '';
  function notifyNav() {
    var href = currentOriginal().href;
    if (href === lastNav) return;
    lastNav = href;
    post({ type: 'agm:nav', url: href, title: document.title });
  }
  window.__agmNotifyNav = notifyNav;
  history.pushState = function (state, title, url) {
    var r = oPush.call(history, state, title, cleanStateUrl(url));
    updateBase(); setTimeout(notifyNav, 0);
    return r;
  };
  history.replaceState = function (state, title, url) {
    var r = oReplace.call(history, state, title, cleanStateUrl(url));
    updateBase(); setTimeout(notifyNav, 0);
    return r;
  };
  window.addEventListener('popstate', function () { updateBase(); notifyNav(); });
  window.addEventListener('hashchange', notifyNav);

  // ---- Network APIs -------------------------------------------------------
  var oFetch = window.fetch;
  if (oFetch) window.fetch = function (input, init) {
    try {
      if (typeof input === 'string' || input instanceof URL) input = rw(input);
      else if (input && input.url) { var nu = rw(input.url); if (nu !== input.url) input = new Request(nu, input); }
    } catch (e) {}
    return oFetch.call(this, input, init);
  };
  var oOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, url) {
    var args = Array.prototype.slice.call(arguments);
    try { args[1] = rw(url); } catch (e) {}
    return oOpen.apply(this, args);
  };
  if (navigator.sendBeacon) {
    var oBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) { try { return oBeacon(rw(url), data); } catch (e) { return true; } };
  }
  function wrapCtor(name, kind) {
    var O = window[name];
    if (!O) return;
    var W = function (url, opt) { return arguments.length > 1 ? new O(rw(url, kind), opt) : new O(rw(url, kind)); };
    W.prototype = O.prototype;
    for (var k in O) try { W[k] = O[k]; } catch (e) {}
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (s) { if (s in O) try { Object.defineProperty(W, s, { value: O[s] }); } catch (e) {} });
    window[name] = W;
  }
  wrapCtor('WebSocket'); wrapCtor('EventSource'); wrapCtor('Worker'); wrapCtor('SharedWorker');

  var oWinOpen = window.open;
  window.open = function (url) {
    if (url == null || url === '') return oWinOpen.apply(window, arguments);
    try {
      var o = resolveOriginal(url);
      if (o.origin !== PROXY && !sameSite(o.hostname, projHost)) {
        post({ type: 'agm:external', url: o.href });
        return null;
      }
      location.assign(rw(url));
      return window;
    } catch (e) { return null; }
  };

  // ---- DOM URL properties / attributes ----------------------------------
  function patchProp(Ctor, prop, kind) {
    var p = Ctor && Ctor.prototype;
    if (!p) return;
    var d = Object.getOwnPropertyDescriptor(p, prop);
    if (!d || !d.set) return;
    Object.defineProperty(p, prop, {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set: function (v) { d.set.call(this, /srcset/i.test(prop) ? rwSrcset(v) : rw(v, kind)); },
    });
  }
  patchProp(window.HTMLImageElement, 'src'); patchProp(window.HTMLImageElement, 'srcset');
  patchProp(window.HTMLScriptElement, 'src'); patchProp(window.HTMLLinkElement, 'href');
  patchProp(window.HTMLLinkElement, 'imageSrcset'); patchProp(window.HTMLIFrameElement, 'src', 'frame');
  patchProp(window.HTMLSourceElement, 'src'); patchProp(window.HTMLSourceElement, 'srcset');
  patchProp(window.HTMLMediaElement, 'src'); patchProp(window.HTMLVideoElement, 'poster');
  patchProp(window.HTMLFormElement, 'action'); patchProp(window.HTMLObjectElement, 'data');
  patchProp(window.HTMLEmbedElement, 'src'); patchProp(window.HTMLAnchorElement, 'href');

  var URL_ATTRS = { src: 1, href: 1, action: 1, poster: 1, data: 1, formaction: 1, 'data-src': 1, 'component-url': 1, 'renderer-url': 1, srcset: 2, 'data-srcset': 2, imagesrcset: 2 };
  function attrValue(el, name, value) {
    var k = URL_ATTRS[name];
    if (!k || value == null) return value;
    var tag = el.tagName;
    if (name === 'data' && tag !== 'OBJECT') return value;
    if (name === 'href' && !/^(A|LINK|AREA|BASE|use|image|USE|IMAGE)$/.test(tag)) return value;
    if (tag === 'BASE') return value;
    return k === 2 ? rwSrcset(value) : rw(value, tag === 'IFRAME' || tag === 'FRAME' ? 'frame' : undefined);
  }
  var oSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    var n = String(name).toLowerCase();
    if (URL_ATTRS[n] && !(this.hasAttribute && this.hasAttribute('data-agm'))) value = attrValue(this, n, value);
    return oSetAttr.call(this, name, value);
  };

  // Elements inserted through innerHTML / templates.
  function fixElement(el) {
    if (el.nodeType !== 1 || el.hasAttribute('data-agm')) return;
    for (var n in URL_ATTRS) {
      if (!el.hasAttribute(n)) continue;
      var v = el.getAttribute(n), nv = attrValue(el, n, v);
      if (nv !== v) oSetAttr.call(el, n, nv);
    }
    if (el.tagName === 'STYLE' && /url\(\s*['"]?\//.test(el.textContent)) {
      el.textContent = el.textContent.replace(/url\(\s*(['"]?)(\/[^'")]+)\1\s*\)/g, function (a, q, u) { return 'url(' + q + rw(u) + q + ')'; });
    }
  }
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var node = added[j];
        if (node.nodeType !== 1) continue;
        fixElement(node);
        if (node.querySelectorAll) {
          var list = node.querySelectorAll('[src],[href],[srcset],[action],[poster],[data-src],[data-srcset],style');
          for (var k = 0; k < list.length; k++) fixElement(list[k]);
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ---- Service workers ------------------------------------------------------
  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.getRegistrations().then(function (rs) { rs.forEach(function (r) { r.unregister(); }); }).catch(function () {});
      Object.defineProperty(ServiceWorkerContainer.prototype, 'register', {
        configurable: true,
        value: function () { return Promise.reject(new DOMException('Service workers are disabled in the review preview', 'SecurityError')); },
      });
    }
  } catch (e) {}

  // ---- Forms: never submit real data from the preview ------------------------
  function isSearchForm(f) {
    var method = (f.getAttribute('method') || 'get').toLowerCase();
    if (method !== 'get') return false;
    if (f.getAttribute('role') === 'search' || /search/i.test(f.getAttribute('action') || '')) return true;
    return !!f.querySelector('input[type=search],input[name=q],input[name=s],input[name=query],input[name=search]');
  }
  window.addEventListener('submit', function (e) {
    var f = e.target;
    if (f && f.tagName === 'FORM' && isSearchForm(f)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    post({ type: 'agm:formBlocked' });
  }, true);
  HTMLFormElement.prototype.submit = function () { if (isSearchForm(this)) return; post({ type: 'agm:formBlocked' }); };
  HTMLFormElement.prototype.requestSubmit = function () { if (isSearchForm(this)) return; post({ type: 'agm:formBlocked' }); };

  // ---- Navigation: keep every document navigation inside the proxy ----------
  // Returns null when the navigation may proceed unchanged.
  function navigationFix(dest) {
    var u = new URL(dest);
    if (u.origin === PROXY && (u.pathname.indexOf('/__agm/') === 0)) return null;
    var orig = u.origin === PROXY ? (u.pathname.indexOf('/p/') === 0 ? unproxy(u) : new URL(u.pathname + u.search + u.hash, target.origin)) : u;
    if (!orig) return null;
    var cur = currentOriginal();
    if (orig.hash && orig.origin === cur.origin && orig.pathname === cur.pathname && orig.search === cur.search) return { hash: orig.hash };
    if (orig.origin !== cur.origin && !sameSite(orig.hostname, projHost)) return { external: orig.href };
    var proxied = PROXY + proxify(orig);
    return proxied === u.href ? null : { url: proxied };
  }
  if (window.navigation && window.navigation.addEventListener) {
    window.navigation.addEventListener('navigate', function (e) {
      if (!e.cancelable || e.hashChange || e.downloadRequest || e.navigationType === 'traverse' || e.destination.sameDocument) return;
      var fix = navigationFix(e.destination.url);
      if (!fix) return;
      e.preventDefault();
      if (fix.hash) location.hash = fix.hash;
      else if (fix.external) post({ type: 'agm:external', url: fix.external });
      else location.assign(fix.url);
    });
  }
  // Link clicks (also covers browsers without the Navigation API).
  window.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.hasAttribute('download')) return;
    var raw = a.getAttribute('href');
    if (/^\s*#/.test(raw)) {
      e.preventDefault();
      var id = raw.trim().slice(1);
      if (id) { location.hash = id; var t = document.getElementById(decodeURIComponent(id)); if (t) t.scrollIntoView(); }
      return;
    }
    if (/^\s*(javascript:|mailto:|tel:)/i.test(raw)) return;
    var fix;
    try { fix = navigationFix(new URL(raw, document.baseURI).href); } catch (er) { return; }
    var tgt = (a.getAttribute('target') || '').toLowerCase();
    if (fix && fix.external) { e.preventDefault(); post({ type: 'agm:external', url: fix.external }); return; }
    if (fix && fix.hash) { e.preventDefault(); location.hash = fix.hash; return; }
    if (tgt === '_blank' || tgt === '_top' || tgt === '_parent') {
      e.preventDefault();
      location.assign(fix ? fix.url : a.href);
      return;
    }
    if (fix && fix.url) oSetAttr.call(a, 'href', fix.url);
  });

  document.addEventListener('DOMContentLoaded', function () { lastNav = ''; notifyNav(); });
  var lastTitle = '';
  setInterval(function () {
    if (document.title !== lastTitle) { lastTitle = document.title; lastNav = ''; notifyNav(); }
  }, 1500);
})();
