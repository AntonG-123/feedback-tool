/* AGM commenting overlay. Runs inside the proxied page.
 * - Comment mode: highlights elements under the pointer, blocks page
 *   interaction and reports the selected element's anchor to the app.
 * - Resolves stored anchors back to elements (layered strategy) and
 *   continuously reports pin positions so the app can draw pins.
 * - Headless helpers (__agmResolve / __agmAnnotate) for the screenshot worker. */
(function () {
  'use strict';
  var C = window.__AGM__;
  if (!C || window.__AGM_OVERLAY__) return;
  window.__AGM_OVERLAY__ = true;
  var post = window.__agmPost || function () {};
  var mode = 'browse';
  var breakpoint = 'desktop';
  var pins = [];          // {id, locator, rx, ry, docX, docY, bp}
  var cache = {};         // id -> {el, state}
  var pending = null;     // {el, rx, ry, docX, docY}
  var lastStates = {};

  // ---------- utilities ----------
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function textOf(el) { return norm(el.textContent).slice(0, 300); }
  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
  function attrEsc(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
  function isOurs(el) { return !el || el === host || (el.closest && el.closest('[data-agm]')); }
  function stableId(id) { return id && id.length < 80 && !/^\d|[0-9a-f]{10,}|\d{5,}|^(ember|react|radix|headlessui|mui|:r|rc-|__next|swiper-wrapper-)/i.test(id); }
  function stableClass(c) {
    return c && c.length < 40 && !/^(css-|sc-|jsx-|svelte-|astro-|_|tw-|framer-[a-z0-9]{5,}$)|[0-9a-f]{7,}|\d{4,}|^(hover|active|focus|is-|has-|js-|w--|selected$|open$|visible$|show$|aos|animate|lazy|loaded)/i.test(c);
  }
  var DATA_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa', 'data-id', 'data-w-id', 'data-framer-name', 'data-section-id', 'data-section-type', 'data-block-id', 'aria-label', 'name', 'role'];
  var KEY_ATTRS = ['href', 'src', 'alt', 'title', 'type', 'placeholder', 'name', 'aria-label'];
  function origAttr(el, a) {
    var v = el.getAttribute(a);
    if (v && (a === 'href' || a === 'src')) {
      var m = v.match(/\/p\/[^/]+\/(https?)\/([^/]+)(\/[^?#]*)?(\?[^#]*)?/);
      if (m) v = m[1] + '://' + m[2] + (m[3] || '/') + (m[4] || '');
    }
    return v;
  }
  function nthOfType(el) {
    var i = 1, s = el;
    while ((s = s.previousElementSibling)) if (s.tagName === el.tagName) i++;
    return i;
  }
  function countOfType(el) {
    var p = el.parentElement;
    if (!p) return 1;
    var n = 0;
    for (var c = p.firstElementChild; c; c = c.nextElementSibling) if (c.tagName === el.tagName) n++;
    return n;
  }
  function domPath(el) {
    var parts = [];
    for (var cur = el; cur && cur.nodeType === 1 && cur !== document.documentElement; cur = cur.parentElement) {
      parts.unshift(cur.tagName.toLowerCase() + ':nth-of-type(' + nthOfType(cur) + ')');
      if (cur === document.body) break;
    }
    return parts.join(' > ');
  }
  function uniqueSelector(el) {
    var parts = [];
    for (var cur = el; cur && cur.nodeType === 1 && cur !== document.documentElement; cur = cur.parentElement) {
      if (stableId(cur.id)) { parts.unshift('#' + cssEsc(cur.id)); break; }
      var s = cur.tagName.toLowerCase();
      var cls = Array.prototype.filter.call(cur.classList || [], stableClass).slice(0, 2);
      if (cls.length) s += '.' + cls.map(cssEsc).join('.');
      if (countOfType(cur) > 1) s += ':nth-of-type(' + nthOfType(cur) + ')';
      parts.unshift(s);
      try { if (document.querySelectorAll(parts.join(' > ')).length === 1) break; } catch (e) { break; }
      if (cur === document.body) break;
    }
    return parts.join(' > ');
  }
  function neighbourText(el, dir) {
    var s = el;
    for (var i = 0; i < 4 && s; i++) {
      var sib = dir < 0 ? s.previousElementSibling : s.nextElementSibling;
      while (sib) {
        var t = textOf(sib);
        if (t) return dir < 0 ? t.slice(-80) : t.slice(0, 80);
        sib = dir < 0 ? sib.previousElementSibling : sib.nextElementSibling;
      }
      s = s.parentElement;
    }
    return '';
  }
  function docRect(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
  }

  // Layered locator for an element (see docs/comment-anchoring.md).
  function describe(el) {
    var data = {};
    DATA_ATTRS.forEach(function (a) { var v = el.getAttribute(a); if (v && v.length < 120) data[a] = v; });
    var attrs = {};
    KEY_ATTRS.forEach(function (a) { var v = origAttr(el, a); if (v && v.length < 500) attrs[a] = v; });
    var classes = Array.prototype.filter.call(el.classList || [], stableClass).slice(0, 8);
    var bg = '';
    try { bg = getComputedStyle(el).backgroundImage; } catch (e) {}
    return {
      v: 1,
      tag: el.tagName.toLowerCase(),
      id: stableId(el.id) ? el.id : null,
      data: data,
      selector: uniqueSelector(el),
      path: domPath(el),
      attrs: attrs,
      classes: classes,
      text: textOf(el),
      prefix: neighbourText(el, -1),
      suffix: neighbourText(el, 1),
      fingerprint: {
        childCount: el.children.length,
        depth: domPath(el).split(' > ').length,
        parentTag: el.parentElement ? el.parentElement.tagName.toLowerCase() : null,
        parentClasses: el.parentElement ? Array.prototype.filter.call(el.parentElement.classList || [], stableClass).slice(0, 4) : [],
      },
      rect: docRect(el),
      isImage: el.tagName === 'IMG' || el.tagName === 'PICTURE' || el.tagName === 'svg' || /url\(/.test(bg),
      url: window.__agmOriginalUrl ? window.__agmOriginalUrl() : location.href,
    };
  }

  function sim(a, b) {
    a = norm(a).toLowerCase(); b = norm(b).toLowerCase();
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    if (a === b) return 1;
    var ta = a.split(' '), tb = b.split(' '), set = {}, inter = 0;
    ta.forEach(function (t) { set[t] = 1; });
    tb.forEach(function (t) { if (set[t] === 1) { inter++; set[t] = 2; } });
    return inter / (ta.length + tb.length - inter);
  }
  function jacc(a, b) {
    if (!a.length && !b.length) return 1;
    var inter = a.filter(function (x) { return b.indexOf(x) >= 0; }).length;
    return inter / (a.length + b.length - inter || 1);
  }
  function matches(el, sel) { try { return !!sel && el.matches(sel); } catch (e) { return false; } }

  function candidates(L) {
    var set = [];
    function add(el) { if (el && el.nodeType === 1 && set.indexOf(el) < 0 && !isOurs(el)) set.push(el); }
    function addAll(sel, max) { try { var l = document.querySelectorAll(sel); for (var i = 0; i < l.length && i < max; i++) add(l[i]); } catch (e) {} }
    if (L.id) add(document.getElementById(L.id));
    Object.keys(L.data || {}).forEach(function (k) { addAll(L.tag + '[' + k + '="' + attrEsc(L.data[k]) + '"]', 20); });
    if (L.selector) addAll(L.selector, 10);
    if (L.path) addAll(L.path, 2);
    if (L.text || L.attrs.src || L.attrs.href) {
      var list = document.getElementsByTagName(L.tag);
      var head = norm(L.text).slice(0, 40).toLowerCase();
      for (var i = 0; i < list.length && i < 5000; i++) {
        var el = list[i];
        if (L.text) {
          var t = textOf(el).toLowerCase();
          if (t === norm(L.text).toLowerCase() || (head.length >= 12 && t.indexOf(head) >= 0)) add(el);
        }
        if (L.attrs.src && origAttr(el, 'src') === L.attrs.src) add(el);
        if (L.attrs.href && origAttr(el, 'href') === L.attrs.href) add(el);
      }
    }
    return set;
  }

  function score(el, L, sameBp) {
    if (el.tagName.toLowerCase() !== L.tag) return -1;
    var s = 0, structural = false;
    if (L.id && el.id === L.id) { s += 30; structural = true; }
    var dataHits = 0;
    Object.keys(L.data || {}).forEach(function (k) { if (el.getAttribute(k) === L.data[k]) dataHits++; });
    if (dataHits) { s += Math.min(30, dataHits * 18); structural = true; }
    if (matches(el, L.selector)) { s += 20; structural = true; }
    if (matches(el, L.path)) { s += 15; structural = true; }
    var tsim = sim(textOf(el), L.text);
    s += 35 * tsim;
    if (!structural && L.text && tsim < 0.8) s -= 25;
    var attrHits = 0;
    Object.keys(L.attrs || {}).forEach(function (k) { if (origAttr(el, k) === L.attrs[k]) attrHits++; });
    s += Math.min(18, attrHits * 6);
    s += 10 * jacc(Array.prototype.filter.call(el.classList || [], stableClass), L.classes || []);
    if (L.prefix || L.suffix) s += 5 * sim(neighbourText(el, -1), L.prefix) + 5 * sim(neighbourText(el, 1), L.suffix);
    if (sameBp && L.rect) {
      var r = docRect(el);
      var d = Math.hypot(r.x + r.w / 2 - (L.rect.x + L.rect.w / 2), r.y + r.h / 2 - (L.rect.y + L.rect.h / 2));
      s += 10 * Math.max(0, 1 - d / 800);
      if (L.rect.w && r.w) s += 4 * Math.min(r.w, L.rect.w) / Math.max(r.w, L.rect.w);
    }
    return s;
  }

  var ACCEPT = 45;
  function resolveLocator(L, sameBp) {
    var list = candidates(L);
    var best = null, bestS = -1, second = -1;
    for (var i = 0; i < list.length; i++) {
      var s = score(list[i], L, sameBp);
      if (s > bestS) { second = bestS; bestS = s; best = list[i]; } else if (s > second) second = s;
    }
    if (best && bestS >= ACCEPT && (bestS - second >= 6 || bestS >= 85)) return { el: best, state: 'ok', score: bestS };
    return { el: null, state: 'needs_attention', score: bestS };
  }
  window.__agmDescribe = describe;
  window.__agmResolveLocator = resolveLocator;

  function resolvePin(p) {
    var c = cache[p.id];
    if (c && c.el && c.el.isConnected) return c;
    c = resolveLocator(p.locator, p.bp === breakpoint);
    cache[p.id] = c;
    return c;
  }

  // ---------- overlay UI (highlight box) ----------
  var host = document.createElement('agm-overlay');
  host.setAttribute('data-agm', '');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  var root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;display:none;border:2px solid #5b5bf6;background:rgba(91,91,246,.08);border-radius:3px;pointer-events:none;transition:all .06s ease-out;box-sizing:border-box';
  root.appendChild(box);
  var style = document.createElement('style');
  style.setAttribute('data-agm', '');
  style.textContent = 'html.agm-comment-mode, html.agm-comment-mode * { cursor: crosshair !important; }';
  function mount() { if (!host.isConnected) document.documentElement.appendChild(host); if (!style.isConnected) document.head.appendChild(style); }

  function pick(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el || isOurs(el)) return null;
    while (el.ownerSVGElement) el = el.ownerSVGElement;
    if (el === document.documentElement) el = document.body;
    return el;
  }
  function showBox(el) {
    if (!el) { box.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
  }

  var BLOCK = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick', 'touchend', 'contextmenu'];
  BLOCK.forEach(function (type) {
    window.addEventListener(type, function (e) {
      if (mode !== 'comment' || isOurs(e.target)) return;
      if (type !== 'touchend') e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (type === 'click') select(e);
    }, true);
  });
  window.addEventListener('pointermove', function (e) {
    if (mode !== 'comment') return;
    showBox(pick(e.clientX, e.clientY));
  }, true);
  document.addEventListener('mouseleave', function () { showBox(null); });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') post({ type: 'agm:escape' });
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || (document.activeElement && document.activeElement.isContentEditable)) return;
    if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey && !e.altKey) post({ type: 'agm:toggleMode' });
  }, true);

  function select(e) {
    var el = pick(e.clientX, e.clientY);
    if (!el) return;
    var r = el.getBoundingClientRect();
    var rx = r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0.5;
    var ry = r.height ? Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) : 0.5;
    pending = { el: el, rx: rx, ry: ry, docX: e.clientX + scrollX, docY: e.clientY + scrollY };
    post({
      type: 'agm:select',
      locator: describe(el), rx: rx, ry: ry,
      docX: pending.docX, docY: pending.docY,
      client: { x: e.clientX, y: e.clientY },
      viewport: { w: innerWidth, h: innerHeight },
      elementInfo: { tag: el.tagName.toLowerCase(), text: textOf(el).slice(0, 80) },
    });
    schedule();
  }

  // ---------- position reporting ----------
  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    if (el.checkVisibility) try { return el.checkVisibility({ visibilityProperty: true }); } catch (e) {}
    return true;
  }
  function pinPos(el, rx, ry, docX, docY) {
    if (el && el.isConnected) {
      var r = el.getBoundingClientRect();
      return { x: r.left + rx * r.width, y: r.top + ry * r.height, visible: visible(el), rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
    }
    return { x: docX - scrollX, y: docY - scrollY, visible: true, rect: null };
  }
  function report() {
    var out = [];
    for (var i = 0; i < pins.length; i++) {
      var p = pins[i], c = resolvePin(p);
      var pos = pinPos(c.el, p.rx, p.ry, p.docX, p.docY);
      pos.id = p.id; pos.state = c.state;
      out.push(pos);
      if (lastStates[p.id] !== c.state) { lastStates[p.id] = c.state; post({ type: 'agm:anchorState', id: p.id, state: c.state }); }
    }
    if (pending) { var pp = pinPos(pending.el, pending.rx, pending.ry, pending.docX, pending.docY); pp.id = 'pending'; pp.state = 'ok'; out.push(pp); }
    post({
      type: 'agm:positions', pins: out,
      scroll: { x: scrollX, y: scrollY }, viewport: { w: innerWidth, h: innerHeight },
      doc: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
    });
  }
  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; report(); });
  }
  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule);
  var moTimer = null;
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) if (!isOurs(records[i].target)) {
      clearTimeout(moTimer);
      moTimer = setTimeout(function () {
        for (var id in cache) if (cache[id].state !== 'ok' || !(cache[id].el && cache[id].el.isConnected)) delete cache[id];
        schedule();
      }, 120);
      return;
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  setInterval(schedule, 1000);

  // ---------- messages from the app ----------
  window.addEventListener('message', function (e) {
    if (e.origin !== C.appOrigin || !e.data || typeof e.data.type !== 'string') return;
    var m = e.data;
    if (m.type === 'agm:hello' || m.type === 'agm:mode') {
      mode = m.mode || mode;
      document.documentElement.classList.toggle('agm-comment-mode', mode === 'comment');
      if (mode !== 'comment') showBox(null);
    }
    if (m.type === 'agm:hello' || m.type === 'agm:pins') {
      if (m.breakpoint && m.breakpoint !== breakpoint) { breakpoint = m.breakpoint; cache = {}; }
      var keep = {};
      pins = (m.pins || []).map(function (p) { keep[p.id] = 1; return p; });
      for (var id in cache) if (!keep[id]) delete cache[id];
      schedule();
    }
    if (m.type === 'agm:clearPending') { pending = null; schedule(); }
    if (m.type === 'agm:scrollTo') {
      var p = pins.filter(function (x) { return x.id === m.id; })[0];
      if (!p) return;
      var c = resolvePin(p);
      if (c.el) c.el.scrollIntoView({ block: 'center', behavior: m.smooth === false ? 'auto' : 'smooth' });
      else window.scrollTo({ top: Math.max(0, p.docY - innerHeight / 2), behavior: 'smooth' });
      schedule();
    }
    if (m.type === 'agm:scrollBy') { window.scrollBy(m.dx || 0, m.dy || 0); }
  });

  function ready() {
    mount();
    post({ type: 'agm:ready', url: window.__agmOriginalUrl ? window.__agmOriginalUrl() : location.href, title: document.title });
    if (window.__agmNotifyNav) window.__agmNotifyNav();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();

  // ---------- headless helpers (screenshot worker) ----------
  window.__agmResolve = function (L, rx, ry, docX, docY) {
    var c = resolveLocator(L, true);
    if (!c.el) return { found: false, point: { x: docX, y: docY }, rect: { x: docX - 1, y: docY - 1, w: 2, h: 2 } };
    var r = docRect(c.el);
    return { found: true, rect: r, point: { x: r.x + rx * r.w, y: r.y + ry * r.h } };
  };
  window.__agmAnnotate = function (shapes, pin) {
    var NS = 'http://www.w3.org/2000/svg';
    var W = Math.max(document.documentElement.scrollWidth, innerWidth), H = Math.max(document.documentElement.scrollHeight, innerHeight);
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('data-agm', '');
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.style.cssText = 'position:absolute;left:0;top:0;z-index:2147483646;pointer-events:none;overflow:visible';
    function mk(tag, attrs) { var n = document.createElementNS(NS, tag); for (var k in attrs) n.setAttribute(k, attrs[k]); svg.appendChild(n); return n; }
    (shapes || []).forEach(function (s) {
      var pts = s.points || [], c = s.color || '#ef4444', w = s.width || 4;
      var common = { stroke: c, 'stroke-width': w, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
      if (pts.length < 2 && s.type !== 'free') return;
      var a = pts[0], b = pts[pts.length - 1];
      if (s.type === 'rect') mk('rect', Object.assign({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y), rx: 2 }, common));
      else if (s.type === 'circle') mk('ellipse', Object.assign({ cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, rx: Math.abs(b.x - a.x) / 2, ry: Math.abs(b.y - a.y) / 2 }, common));
      else if (s.type === 'arrow') {
        mk('line', Object.assign({ x1: a.x, y1: a.y, x2: b.x, y2: b.y }, common));
        var ang = Math.atan2(b.y - a.y, b.x - a.x), L = 10 + w * 3;
        var p1 = (b.x - L * Math.cos(ang - 0.45)) + ',' + (b.y - L * Math.sin(ang - 0.45));
        var p2 = (b.x - L * Math.cos(ang + 0.45)) + ',' + (b.y - L * Math.sin(ang + 0.45));
        mk('polyline', Object.assign({}, common, { points: p1 + ' ' + b.x + ',' + b.y + ' ' + p2 }));
      } else mk('polyline', Object.assign({ points: pts.map(function (p) { return p.x + ',' + p.y; }).join(' ') }, common));
    });
    if (pin) {
      mk('circle', { cx: pin.x, cy: pin.y, r: 15, fill: pin.color || '#5b5bf6', stroke: '#fff', 'stroke-width': 3 });
      var t = mk('text', { x: pin.x, y: pin.y + 5, 'text-anchor': 'middle', fill: '#fff', 'font-size': 14, 'font-weight': 700, 'font-family': 'Arial, sans-serif' });
      t.textContent = String(pin.number);
    }
    // Child of <html>: positioned against the initial containing block, i.e.
    // document coordinates, regardless of body margins/positioning.
    document.documentElement.appendChild(svg);
    return { w: W, h: H };
  };
})();
