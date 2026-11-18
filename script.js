(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  Settings storage
   * ------------------------------------------------------------------ */
  const STORE_KEY = 'ups:v1';

  function defaults() {
    return {
      url: 'https://craftzone.laserpecker.net/en/', // home page: change here or in Settings
      last: '',
      proxy: '',
      scriptsEnabled: true,
      scripts: [],
      ui: { corner: 'bottom-right', fade: true, keepAwake: false, remember: true },
    };
  }

  function uid() {
    return Math.random().toString(36).slice(2, 10);
  }

  function cleanScript(s) {
    return {
      id: String(s.id || uid()),
      name: String(s.name || 'Untitled script'),
      match: String(s.match || ''),
      runAt: s.runAt === 'start' ? 'start' : 'end',
      code: String(s.code),
      enabled: s.enabled !== false,
    };
  }

  function normalize(raw) {
    const d = defaults();
    return {
      url: typeof raw.url === 'string' && raw.url ? raw.url : d.url,
      last: typeof raw.last === 'string' ? raw.last : '',
      proxy: typeof raw.proxy === 'string' ? raw.proxy : '',
      scriptsEnabled: raw.scriptsEnabled !== false,
      scripts: Array.isArray(raw.scripts)
        ? raw.scripts.filter((s) => s && typeof s.code === 'string').map(cleanScript)
        : [],
      ui: Object.assign(d.ui, raw.ui && typeof raw.ui === 'object' ? raw.ui : {}),
    };
  }

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (raw && typeof raw === 'object') return normalize(raw);
    } catch (_) { /* fall through to defaults */ }
    return defaults();
  }

  let state = load();

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* private mode etc. */ }
  }

  /* ------------------------------------------------------------------ *
   *  Helpers
   * ------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    for (const c of children) node.append(c);
    return node;
  }

  function normalizeUrl(input) {
    let v = String(input || '').trim();
    if (!v) return '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v;
    try {
      const u = new URL(v);
      return /^https?:$/.test(u.protocol) ? u.href : '';
    } catch (_) {
      return '';
    }
  }

  function proxyBase() {
    const v = normalizeUrl(state.proxy);
    return v ? v.replace(/\/+$/, '') : '';
  }

  function proxyOrigin() {
    const b = proxyBase();
    return b ? new URL(b).origin : '';
  }

  function frameSrc(target) {
    const b = proxyBase();
    return b ? `${b}/?url=${encodeURIComponent(target)}` : target;
  }

  // Glob match for @match-style patterns: "*" matches anything. Blank = every page.
  function matches(patterns, href) {
    const list = String(patterns || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    if (!list.length) return true;
    return list.some((p) => {
      const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
      return re.test(href);
    });
  }

  // Reads the ==UserScript== header block (name, @match/@include, @run-at) if present.
  function parseHeader(code) {
    const meta = { name: '', match: [], runAt: 'end' };
    const block = code.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
    if (!block) return meta;
    for (const line of block[1].split('\n')) {
      const m = line.match(/^\s*\/\/\s*@(\S+)\s+(.+?)\s*$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const val = m[2];
      if (key === 'name' && !meta.name) meta.name = val;
      else if ((key === 'match' || key === 'include') && !/^\/.*\/$/.test(val)) meta.match.push(val);
      else if (key === 'run-at') meta.runAt = val === 'document-start' ? 'start' : 'end';
    }
    return meta;
  }

  /* ------------------------------------------------------------------ *
   *  Page loading and the userscript bridge
   * ------------------------------------------------------------------ */
  const frame = $('frame');
  let currentHref = '';   // real address of the page now showing
  let runStatus = {};     // script id -> { ok, msg } from the last run

  function startUrl() {
    const last = normalizeUrl(state.last);
    return state.ui.remember && last ? last : normalizeUrl(state.url);
  }

  function loadFrame(target) {
    currentHref = target;
    runStatus = {};
    frame.src = frameSrc(target);
    renderScripts();
  }

  function reloadFrame() {
    const target = currentHref || startUrl();
    frame.src = 'about:blank';
    setTimeout(() => loadFrame(target), 30);
    setDirty(false);
  }

  function pushScripts() {
    const origin = proxyOrigin();
    if (!origin || !frame.contentWindow) return;
    const scripts = state.scriptsEnabled
      ? state.scripts.filter((s) => s.enabled && matches(s.match, currentHref))
      : [];
    runStatus = {};
    frame.contentWindow.postMessage(
      {
        source: 'ups-parent',
        type: 'run',
        scripts: scripts.map(({ id, name, code, runAt }) => ({ id, name, code, runAt })),
      },
      origin
    );
    renderScripts();
  }

  window.addEventListener('message', (e) => {
    const origin = proxyOrigin();
    if (!origin || e.origin !== origin || e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!m || m.source !== 'ups-bridge') return;
    if (m.type === 'ready') {
      currentHref = String(m.href || currentHref);
      if (state.ui.remember) { state.last = currentHref; save(); }
      pushScripts();
    } else if (m.type === 'log') {
      runStatus[String(m.id)] = { ok: !!m.ok, msg: String(m.msg || '') };
      renderScripts();
    }
  });

  /* ------------------------------------------------------------------ *
   *  Settings sheet
   * ------------------------------------------------------------------ */
  const overlay = $('overlay');
  let editingId = null;

  function openSheet() {
    syncControls();
    showView('main');
    overlay.hidden = false;
    $('closeBtn').focus();
  }

  function closeSheet() {
    overlay.hidden = true;
    $('settingsBtn').focus();
  }

  function showView(name) {
    $('mainView').hidden = name !== 'main';
    $('editView').hidden = name !== 'edit';
    $('sheet').scrollTop = 0;
  }

  function setDirty(on) {
    $('applyBar').hidden = !on;
  }

  function applyUi() {
    document.body.dataset.corner = state.ui.corner;
    document.body.classList.toggle('fade', !!state.ui.fade);
  }

  function syncControls() {
    $('masterToggle').checked = state.scriptsEnabled;
    $('urlInput').value = state.url;
    $('proxyInput').value = state.proxy;
    $('cornerSelect').value = state.ui.corner;
    $('fadeToggle').checked = state.ui.fade;
    $('rememberToggle').checked = state.ui.remember;
    $('awakeToggle').checked = state.ui.keepAwake;
    $('awakeToggle').disabled = !('wakeLock' in navigator);
    $('fullscreenRow').hidden = !document.fullscreenEnabled;
    renderMode();
    renderScripts();
  }

  function renderMode() {
    const note = $('modeNote');
    if (proxyBase()) {
      note.textContent = 'Proxy active: scripts run on matching pages each time a page loads.';
      note.className = 'note ok';
    } else {
      note.textContent =
        "No proxy set. The page loads directly, and browsers stop scripts from touching another site's page, " +
        'so userscripts cannot run yet. Add a proxy URL below.';
      note.className = 'note warn';
    }
  }

  function renderScripts() {
    const ul = $('scriptList');
    ul.textContent = '';
    if (!state.scripts.length) {
      ul.append(el('li', { className: 'empty', textContent: 'No scripts yet. Add one or import a .js file.' }));
      return;
    }
    for (const s of state.scripts) {
      const cb = el('input', { type: 'checkbox', checked: s.enabled });
      cb.dataset.act = 'toggle';
      cb.dataset.id = s.id;
      cb.setAttribute('aria-label', `Enable ${s.name}`);
      const sw = el('label', { className: 'switch' }, cb, el('span', { className: 'track' }));

      const st = runStatus[s.id];
      const sub = el('div', { className: 'sub' });
      if (st) {
        sub.textContent = st.ok ? 'Ran OK on this page' : `Error: ${st.msg}`;
        sub.classList.add(st.ok ? 'ok' : 'err');
      } else {
        sub.textContent = s.match.trim() ? s.match.trim().replace(/\s*\n\s*/g, ', ') : 'Every page';
      }

      const edit = el('button', { type: 'button', className: 'small', textContent: 'Edit' });
      edit.dataset.act = 'edit';
      edit.dataset.id = s.id;

      ul.append(
        el('li', {}, sw, el('div', { className: 'meta' }, el('div', { className: 'name', textContent: s.name }), sub), edit)
      );
    }
  }

  /* --- script editor --- */
  function openEditor(script, prefill) {
    editingId = script ? script.id : null;
    const src = script || prefill || { name: '', match: '', runAt: 'end', code: '' };
    $('editTitle').textContent = script ? 'Edit script' : 'New script';
    $('edName').value = src.name;
    $('edMatch').value = src.match;
    $('edRunAt').value = src.runAt;
    $('edCode').value = src.code;
    $('edDelete').hidden = !script;
    showView('edit');
  }

  function saveEditor() {
    const code = $('edCode').value;
    if (!code.trim()) { $('edCode').focus(); return; }
    const data = {
      name: $('edName').value.trim() || 'Untitled script',
      match: $('edMatch').value.trim(),
      runAt: $('edRunAt').value === 'start' ? 'start' : 'end',
      code,
    };
    const existing = state.scripts.find((s) => s.id === editingId);
    if (existing) Object.assign(existing, data);
    else state.scripts.push(cleanScript(Object.assign({ id: uid(), enabled: true }, data)));
    save();
    renderScripts();
    setDirty(true);
    showView('main');
  }

  function deleteEditing() {
    const s = state.scripts.find((x) => x.id === editingId);
    if (!s || !confirm(`Delete "${s.name}"?`)) return;
    state.scripts = state.scripts.filter((x) => x.id !== editingId);
    save();
    renderScripts();
    setDirty(true);
    showView('main');
  }

  function readFile(input, cb) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => cb(String(reader.result), file.name);
    reader.readAsText(file);
  }

  /* --- wake lock --- */
  let wakeLock = null;
  async function applyWakeLock() {
    try {
      if (state.ui.keepAwake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        if (!wakeLock) {
          wakeLock = await navigator.wakeLock.request('screen');
          wakeLock.addEventListener('release', () => { wakeLock = null; });
        }
      } else if (wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (_) { /* denied or unsupported */ }
  }
  document.addEventListener('visibilitychange', applyWakeLock);

  /* --- wiring --- */
  $('settingsBtn').addEventListener('click', openSheet);
  $('closeBtn').addEventListener('click', closeSheet);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSheet(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) closeSheet();
  });
  $('applyBtn').addEventListener('click', () => { reloadFrame(); closeSheet(); });

  $('masterToggle').addEventListener('change', (e) => {
    state.scriptsEnabled = e.target.checked;
    save();
    setDirty(true);
  });

  $('scriptList').addEventListener('click', (e) => {
    const t = e.target.closest('[data-act="edit"]');
    if (!t) return;
    const s = state.scripts.find((x) => x.id === t.dataset.id);
    if (s) openEditor(s);
  });
  $('scriptList').addEventListener('change', (e) => {
    const t = e.target.closest('[data-act="toggle"]');
    if (!t) return;
    const s = state.scripts.find((x) => x.id === t.dataset.id);
    if (!s) return;
    s.enabled = t.checked;
    save();
    setDirty(true);
  });

  $('addScriptBtn').addEventListener('click', () => openEditor(null));
  $('importScriptBtn').addEventListener('click', () => $('importScriptFile').click());
  $('importScriptFile').addEventListener('change', (e) => {
    readFile(e.target, (text, filename) => {
      const meta = parseHeader(text);
      openEditor(null, {
        name: meta.name || filename.replace(/\.(user\.)?(js|txt)$/i, ''),
        match: meta.match.join('\n'),
        runAt: meta.runAt,
        code: text,
      });
    });
  });
  $('edSave').addEventListener('click', saveEditor);
  $('edCancel').addEventListener('click', () => showView('main'));
  $('edDelete').addEventListener('click', deleteEditing);

  $('goBtn').addEventListener('click', () => {
    const url = normalizeUrl($('urlInput').value);
    if (!url) { alert('Enter a valid web address (https://…).'); return; }
    state.url = url;
    state.last = '';
    save();
    setDirty(false);
    loadFrame(url);
    closeSheet();
  });
  $('reloadBtn').addEventListener('click', () => { reloadFrame(); closeSheet(); });
  $('openTabBtn').addEventListener('click', () => {
    window.open(currentHref || startUrl(), '_blank', 'noopener');
  });

  $('proxyInput').addEventListener('change', (e) => {
    const raw = e.target.value.trim();
    const v = raw ? normalizeUrl(raw) : '';
    if (raw && !v) { alert('That is not a valid web address.'); e.target.value = state.proxy; return; }
    state.proxy = v ? v.replace(/\/+$/, '') : '';
    e.target.value = state.proxy;
    save();
    renderMode();
    setDirty(true);
  });

  $('cornerSelect').addEventListener('change', (e) => { state.ui.corner = e.target.value; save(); applyUi(); });
  $('fadeToggle').addEventListener('change', (e) => { state.ui.fade = e.target.checked; save(); applyUi(); });
  $('rememberToggle').addEventListener('change', (e) => { state.ui.remember = e.target.checked; save(); });
  $('awakeToggle').addEventListener('change', (e) => { state.ui.keepAwake = e.target.checked; save(); applyWakeLock(); });
  $('fullscreenBtn').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (_) { /* not allowed here */ }
    closeSheet();
  });

  $('exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'userscript-pwa-settings.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('importDataBtn').addEventListener('click', () => $('importDataFile').click());
  $('importDataFile').addEventListener('change', (e) => {
    readFile(e.target, (text) => {
      try {
        const raw = JSON.parse(text);
        if (!raw || typeof raw !== 'object') throw new Error('bad file');
        if (!confirm('Replace all current settings and scripts with this file?')) return;
        state = normalize(raw);
        save();
        applyUi();
        applyWakeLock();
        syncControls();
        setDirty(true);
      } catch (_) {
        alert('That file is not a valid settings export.');
      }
    });
  });
  $('resetBtn').addEventListener('click', () => {
    if (!confirm('Reset all settings and delete all scripts?')) return;
    try { localStorage.removeItem(STORE_KEY); } catch (_) { /* ignore */ }
    state = defaults();
    applyUi();
    applyWakeLock();
    syncControls();
    loadFrame(startUrl());
    setDirty(false);
  });

  /* ------------------------------------------------------------------ *
   *  Start
   * ------------------------------------------------------------------ */
  applyUi();
  applyWakeLock();
  loadFrame(startUrl());

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      // Relative path so it also works on a GitHub Pages project site (/RepoName/).
      navigator.serviceWorker.register('service-worker.js').catch((err) => {
        console.error('[Service Worker] Registration failed:', err);
      });
    });
  }
})();
