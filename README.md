# Userscript PWA

A small Progressive Web App that shows one website full screen and can run your own userscripts on it, with a settings sheet to control everything. Plain HTML, CSS and JavaScript, hosted on GitHub Pages.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `style.css`, `script.js` | The app: full-screen page, settings button and sheet, script manager |
| `manifest.json` | Install info (must be strict JSON: no `//` comments) |
| `service-worker.js` | Caches the app shell so it opens offline. Bump `CACHE_NAME` after changing files |
| `worker.js` | Cloudflare Worker proxy that makes userscripts possible (see below) |
| `icon-192x192.png`, `icon-512x512.png` | App icons. Replace with your own at the same sizes |

Change the app name in `manifest.json` (`name`, `short_name`) and in `index.html` (`<title>` and `apple-mobile-web-app-title`). Change the default site in `script.js` (`defaults().url`) or in Settings > Page.

## Settings

- **Userscripts**: master switch, per-script switch, add, edit, delete, import a `.js` file (the `// ==UserScript==` header is read for `@name`, `@match`, `@include` and `@run-at`).
- **Page**: address, reload, open in your normal browser.
- **Proxy**: address of your Worker (needed for scripts).
- **Display**: button corner, fade the button, reopen the last page, keep the screen on, fullscreen (where the browser allows it).
- **Data**: export and import everything as JSON, reset.

Script changes apply the next time the page loads; the sheet shows a "Reload now" bar when needed. Match patterns use `*` as a wildcard, for example `https://craftzone.laserpecker.net/*`. Leave blank to run everywhere. Scripts can use `GM_addStyle(css)` and `unsafeWindow`.

## Why a proxy is needed

Browsers never let one site's JavaScript reach into another site's page, and many sites refuse to be shown in an iframe. So a static PWA that frames a site cannot run scripts in it. The Worker fetches the page, removes the embedding blocks, and adds a small bridge that receives your scripts from the PWA (only from your PWA's address) and runs them in the page.

### Set up the Worker (free tier is plenty)

1. Cloudflare dashboard > Workers & Pages > Create > Hello World > Deploy, then Edit code.
2. Paste `worker.js`. Set `ALLOWED_HOSTS` to the site(s) you want and `ALLOWED_PARENT` to `https://<your-username>.github.io`.
3. Deploy, copy the `https://….workers.dev` address into Settings > Proxy in the app, then reload.

The Worker only fetches hosts in `ALLOWED_HOSTS`, so it can't be used as an open proxy.

### Limits to expect

- Cookies are not forwarded, so sites that need you to sign in may not work through the proxy.
- Pages that call their own API with relative URLs can break, because those calls go to the real site from a different origin.
- Link clicks are kept inside the proxy; forms, `window.open` and some single-page-app navigation may leave it.
- Only text/HTML pages get the bridge; other files pass straight through.

If the target is a login-heavy web app, a userscript manager inside a real browser (Userscripts for Safari, Tampermonkey or Violentmonkey) is the more reliable route.

## Install as an app

Open the GitHub Pages address, then Add to Home Screen (iPhone: Share > Add to Home Screen; Android: menu > Install app). If you had installed an earlier version, delete that icon and add it again so the new manifest is used.
