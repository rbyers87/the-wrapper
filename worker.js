// Cloudflare Worker: a small allow-listed proxy that lets your PWA run userscripts.
//
// Why it exists: browsers don't let one site's JavaScript reach into another site's page
// (the "same-origin policy"), and many sites refuse to be shown in an iframe at all.
// This Worker fetches the page for you, removes the headers that block embedding, and adds a
// tiny "bridge" that receives your scripts from the PWA and runs them inside the page.
//
// Deploy: Cloudflare dashboard -> Workers & Pages -> Create -> Hello World -> Edit code ->
// paste this file -> Deploy. Then paste the *.workers.dev address into the PWA's Settings -> Proxy.

// Edit these two values:
const ALLOWED_HOSTS = ['craftzone.laserpecker.net'];   // sites this proxy may fetch (subdomains included)
const ALLOWED_PARENT = 'https://rbyers87.github.io';   // origin of your PWA (no path, no trailing slash)

// ---------------------------------------------------------------------------
// Runs INSIDE the proxied page. Must not reference anything outside this function.
// ---------------------------------------------------------------------------
function bridge(cfg) {
  if (window.__upsBridge) return;
  window.__upsBridge = true;

  function send(type, data) {
    window.parent.postMessage(Object.assign({ source: 'ups-bridge', type: type }, data), cfg.parentOrigin);
  }

  window.unsafeWindow = window;
  window.GM_addStyle = function (css) {
    var s = document.createElement('style');
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
    return s;
  };
  window.__upsErr = function (id, e) {
    send('log', { id: id, ok: false, msg: String((e && e.message) || e) });
  };

  function run(s) {
    try {
      new Function(s.code); // syntax check only; nothing runs here
    } catch (e) {
      send('log', { id: s.id, ok: false, msg: 'Syntax error: ' + e.message });
      return;
    }
    var tag = document.createElement('script');
    tag.textContent =
      '(function(){try{\n' + s.code + '\n}catch(e){window.__upsErr(' + JSON.stringify(String(s.id)) + ',e)}})();';
    (document.head || document.documentElement).appendChild(tag);
    tag.remove();
    send('log', { id: s.id, ok: true });
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || e.origin !== cfg.parentOrigin) return;
    var m = e.data;
    if (!m || m.source !== 'ups-parent' || m.type !== 'run' || !Array.isArray(m.scripts)) return;
    m.scripts.forEach(function (s) {
      if (s.runAt === 'start' || document.readyState !== 'loading') run(s);
      else document.addEventListener('DOMContentLoaded', function () { run(s); });
    });
  });

  // Keep link clicks inside the proxy so scripts keep working after you navigate.
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey) return;
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a || (a.target && a.target !== '_self')) return;
    var u;
    try { u = new URL(a.href, cfg.realUrl); } catch (_) { return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (u.href.split('#')[0] === cfg.realUrl.split('#')[0]) return; // in-page anchor
    e.preventDefault();
    window.location.href = cfg.proxyBase + '/?url=' + encodeURIComponent(u.href);
  }, true);

  send('ready', { href: cfg.realUrl });
}

// ---------------------------------------------------------------------------

const STRIP_HEADERS = [
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'set-cookie',
];

function text(body, status) {
  return new Response(body, { status: status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hostAllowed(hostname) {
  return ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h));
}

// Put the injected tags where they can't change how the page renders: inside <head>, and never
// before the <!DOCTYPE> (anything ahead of it switches the browser into quirks mode, which
// changes layout and text sizing).
function injectIntoHtml(html, inject) {
  const head = /<head(\s[^>]*)?>/i; // not <header>
  if (head.test(html)) return html.replace(head, (m) => m + inject);
  const root = /<html(\s[^>]*)?>/i;
  if (root.test(html)) return html.replace(root, (m) => m + '<head>' + inject + '</head>');
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  if (doctype) return doctype[0] + inject + html.slice(doctype[0].length);
  return inject + html;
}

function bridgeTag(cfg) {
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return '<script>(' + bridge.toString() + ')(' + json + ');</script>';
}

export default {
  async fetch(request) {
    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');
    if (!target) return text('Userscript proxy is running. Use /?url=https://…', 200);

    let t;
    try { t = new URL(target); } catch (_) { return text('Bad url parameter.', 400); }
    if (t.protocol !== 'http:' && t.protocol !== 'https:') return text('Only http(s) is supported.', 400);
    if (!hostAllowed(t.hostname)) return text('Host not allowed by this proxy: ' + t.hostname, 403);
    if (request.method !== 'GET' && request.method !== 'HEAD') return text('Method not allowed.', 405);

    const fwd = new Headers();
    // Pass the phone's identity along so the site serves its mobile version.
    for (const h of ['user-agent', 'accept', 'accept-language', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']) {
      const v = request.headers.get(h);
      if (v) fwd.set(h, v);
    }
    const upstream = await fetch(t.href, { headers: fwd, redirect: 'manual' });

    // Keep redirects inside the proxy.
    if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.get('location')) {
      const next = new URL(upstream.headers.get('location'), t.href);
      return Response.redirect(reqUrl.origin + '/?url=' + encodeURIComponent(next.href), 302);
    }

    const headers = new Headers(upstream.headers);
    STRIP_HEADERS.forEach((h) => headers.delete(h));

    const type = headers.get('content-type') || '';
    if (!type.includes('text/html')) {
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    let html = await upstream.text();
    html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');
    const inject =
      '<base href="' + escapeAttr(t.href) + '">' +
      bridgeTag({ parentOrigin: ALLOWED_PARENT, realUrl: t.href, proxyBase: reqUrl.origin });
    html = injectIntoHtml(html, inject);

    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.set('cache-control', 'no-store');
    return new Response(html, { status: upstream.status, headers });
  },
};
