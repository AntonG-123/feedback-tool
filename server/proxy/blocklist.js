// Third-party scripts that are removed from proxied pages: analytics/tracking,
// advertising, chat widgets and cookie-consent banners. Scripts needed to
// render the site (frameworks, CDNs, site bundles) are never matched here.
export const BLOCKED_SCRIPT_HOSTS = [
  // analytics / tracking
  'google-analytics.com', 'googletagmanager.com', 'analytics.google.com', 'stats.g.doubleclick.net',
  'connect.facebook.net', 'static.hotjar.com', 'script.hotjar.com', 'clarity.ms', 'cdn.segment.com',
  'cdn.mxpnl.com', 'cdn.amplitude.com', 'plausible.io', 'static.cloudflareinsights.com', 'snap.licdn.com',
  'analytics.tiktok.com', 'sc-static.net', 's.pinimg.com', 'bat.bing.com', 'cdn.heapanalytics.com',
  'js.hs-analytics.net', 'js.hs-banner.com', 'js.hsadspixel.net', 'fullstory.com', 'cdn.mouseflow.com',
  'static.ads-twitter.com', 'cdn.matomo.cloud', 'px.ads.linkedin.com', 'cdn.logrocket.io', 'cdn.lr-ingest.io',
  'umami.is', 'cdn.usefathom.com', 'cdn.vercel-insights.com', 'va.vercel-scripts.com',
  // advertising
  'googlesyndication.com', 'doubleclick.net', 'googleadservices.com', 'adservice.google.com', 'amazon-adsystem.com',
  'taboola.com', 'outbrain.com', 'criteo.net', 'criteo.com',
  // chat widgets
  'widget.intercom.io', 'js.intercomcdn.com', 'js.driftt.com', 'client.crisp.chat', 'embed.tawk.to',
  'static.zdassets.com', 'js.usemessages.com', 'cdn.livechatinc.com', 'code.tidio.co', 'wchat.freshchat.com',
  'static.olark.com', 'beacon-v2.helpscout.net', 'js.hs-scripts.com', 'chat.botpress.cloud',
  // cookie banners / consent managers
  'consent.cookiebot.com', 'consentcdn.cookiebot.com', 'cdn.cookielaw.org', 'optanon.blob.core.windows.net',
  'app.usercentrics.eu', 'web.cmp.usercentrics.eu', 'cdn-cookieyes.com', 'app.termly.io', 'cdn.iubenda.com',
  'cs.iubenda.com', 'cmp.osano.com', 'cookie-cdn.cookiepro.com', 'cdn.consentmanager.net', 'policy.app.cookieinformation.com',
  'consent.trustarc.com', 'app.enzuzo.com', 'cdn.finsweet.com/cookie', 'cookie-script.com',
];

// Inline script snippets for the same categories.
export const BLOCKED_INLINE_PATTERNS = [
  /googletagmanager\.com\/gtm\.js/, /\bgtag\(\s*['"]config['"]/, /google-analytics\.com\/analytics\.js/,
  /\bfbq\(\s*['"]init['"]/, /static\.hotjar\.com/, /clarity\.ms\/tag/, /window\.intercomSettings/,
  /embed\.tawk\.to/, /\$crisp\s*=/, /analytics\.load\(/, /_linkedin_partner_id/, /ttq\.load\(/, /snaptr\(/,
];

// CSS that hides common consent / chat containers that may be server-rendered.
export const HIDE_CSS = `
#onetrust-consent-sdk,#onetrust-banner-sdk,#CybotCookiebotDialog,#CybotCookiebotDialogBodyUnderlay,#usercentrics-root,
#usercentrics-cmp-ui,.cky-consent-container,.cky-overlay,#cookie-law-info-bar,.cmplz-cookiebanner,.cc-window,.cc-banner,
#cookiescript_injected,#termly-code-snippet-support,.termly-styles-root,#iubenda-cs-banner,.osano-cm-window,#cmpbox,#cmpbox2,
.fs-cc-components,[fs-cc="banner"],#intercom-container,.intercom-lightweight-app,#hubspot-messages-iframe-container,
#crisp-chatbox,.crisp-client,#tidio-chat,#chat-widget-container,.drift-frame-controller,.drift-conductor-item,#launcher[title*="chat" i]
{display:none!important;visibility:hidden!important}
html.cmp-locked,body.cmp-locked,body.no-scroll-cookie{overflow:auto!important}
`;

export function isBlockedScriptUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const hostPath = (u.hostname + u.pathname).toLowerCase();
  return BLOCKED_SCRIPT_HOSTS.some((h) => {
    if (h.includes('/')) return hostPath.startsWith(h) || hostPath.includes('.' + h);
    return u.hostname === h || u.hostname.endsWith('.' + h);
  });
}

export function isBlockedInlineScript(text) {
  return BLOCKED_INLINE_PATTERNS.some((re) => re.test(text));
}

// Known third-party form endpoints: submissions are refused by the proxy so
// that reviewers cannot send real data from the preview.
const FORM_ENDPOINTS = [
  /webflow\.com\/api\/v1\/form/i, /^https:\/\/formspree\.io\//i, /forms\.hubspot\.com|api\.hsforms\.com/i,
  /\/wp-json\/contact-form-7\//i, /admin-ajax\.php.*(gf_|wpforms|nf_ajax)/i, /getform\.io/i, /formsubmit\.co/i,
  /api\.web3forms\.com/i, /submit-form\.com/i, /\/contact#contact_form/i, /\/contact\?.*form_type=contact/i,
  /framer\.com\/api\/forms|api\.framer\.com\/forms/i, /\/\.netlify\/functions\/.*form/i,
];

export function isFormEndpoint(url) {
  return FORM_ENDPOINTS.some((re) => re.test(url));
}
