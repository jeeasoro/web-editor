/* ============================================================================
   files.js — getting your files in and out.

   Three routes, in order of preference:

     1. The local server, when the launcher opened a file for you. It can read
        and write the exact path you double-clicked, and it resolves the
        stylesheet and script your HTML references so a project arrives whole.
     2. The File System Access API, when the browser has it. Save then writes
        back to the file you opened rather than dropping another copy in
        Downloads.
     3. A download, as the last resort.

   Whatever happens, the current text is mirrored into localStorage after every
   pause so closing the window is never how you lose work.
   ========================================================================== */
(function (root) {
  'use strict';

  const params = new URLSearchParams(location.search);
  const TOKEN = params.get('token') || '';
  const SERVED = location.protocol.startsWith('http') && !!TOKEN;

  const hasPicker = typeof window.showOpenFilePicker === 'function';
  const hasSavePicker = typeof window.showSaveFilePicker === 'function';

  const EXT = { html: 'html', css: 'css', js: 'js' };

  const langOf = (name) => {
    const ext = String(name).toLowerCase().split('.').pop();
    if (ext === 'css') return 'css';
    if (ext === 'js' || ext === 'mjs') return 'js';
    return 'html';
  };

  /* ── the server route ────────────────────────────────────────────────── */

  const api = (path, query) => {
    const url = new URL(path, location.origin);
    url.searchParams.set('token', TOKEN);
    for (const key in (query || {})) url.searchParams.set(key, query[key]);
    return url.toString();
  };

  /** Paths the launcher has queued for this window, if any. */
  async function collectOpened() {
    if (!SERVED) return [];
    try {
      const res = await fetch(api('/__pending'), { cache: 'no-store' });
      if (!res.ok) return [];
      const data = await res.json();
      return data.paths || [];
    } catch (e) {
      return [];
    }
  }

  /**
   * Load a file and, when it is HTML, whatever local stylesheet and script it
   * references. The server resolves those paths — it is the only side that
   * knows where the file actually lives.
   */
  async function loadProject(path) {
    const res = await fetch(api('/__project', { path }), { cache: 'no-store' });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async function writeThroughServer(path, text) {
    const res = await fetch(api('/__file', { path }), { method: 'PUT', body: text });
    if (!res.ok) throw new Error(await res.text());
  }

  /* ── the picker route ────────────────────────────────────────────────── */

  const TYPES = [{
    description: 'Web files',
    accept: {
      'text/html': ['.html', '.htm'],
      'text/css': ['.css'],
      'text/javascript': ['.js', '.mjs']
    }
  }];

  /** @returns {Promise<Array<{name, text, handle, lang}>>} */
  async function pickFiles() {
    if (!hasPicker) return pickWithInput();
    const handles = await window.showOpenFilePicker({ multiple: true, types: TYPES });
    const out = [];
    for (const handle of handles) {
      const file = await handle.getFile();
      out.push({ name: file.name, text: await file.text(), handle, lang: langOf(file.name) });
    }
    return out;
  }

  /* ── the folder route ────────────────────────────────────────────────── */

  /* Folders that are never the thing you came to edit. Walking into
     node_modules turns a two-second open into a thirty-second one and buries
     your own files in the tree. */
  const SKIP_DIRS = new Set(['node_modules', 'bower_components', 'vendor', 'jspm_packages',
    '.git', '.svn', '.hg', '.cache', '.parcel-cache', '.next', '.nuxt', '.svelte-kit',
    'dist', 'build', 'out', 'coverage', '.idea', '.vscode', '.vs', 'obj', 'bin']);

  const WEB_FILE = /\.(html?|css|m?js)$/i;

  /* Guard rails, so opening the wrong folder is a disappointment rather than a
     frozen tab. Both are generous for anything hand-written. */
  const MAX_FILES = 500;
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_DEPTH = 12;

  /**
   * Read every HTML, CSS and JavaScript file in a folder and its subfolders.
   *
   * @param {FileSystemDirectoryHandle} dir
   * @returns {Promise<{files: object[], skipped: number, truncated: boolean}>}
   *   each file carries `relPath` — its path from the folder you picked, which
   *   is what the tree shows and what `<link href>` is resolved against.
   */
  async function readFolder(dir) {
    const files = [];
    const report = { skipped: 0, truncated: false };
    await walk(dir, '', 0, files, report);
    files.sort((a, b) => a.relPath.localeCompare(b.relPath, undefined, { numeric: true }));
    return { files, skipped: report.skipped, truncated: report.truncated };
  }

  async function walk(dir, prefix, depth, files, report) {
    if (depth > MAX_DEPTH) return;

    const entries = [];
    for await (const entry of dir.entries()) entries.push(entry);
    /* Files before folders, each alphabetical: the same order the tree draws,
       so the first file found is the first one you would have clicked. */
    entries.sort((a, b) => (a[1].kind === b[1].kind)
      ? a[0].localeCompare(b[0], undefined, { numeric: true })
      : (a[1].kind === 'file' ? -1 : 1));

    for (const [name, handle] of entries) {
      const relPath = prefix ? prefix + '/' + name : name;

      if (handle.kind === 'directory') {
        if (name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase())) continue;
        await walk(handle, relPath, depth + 1, files, report);
        continue;
      }
      if (!WEB_FILE.test(name)) continue;
      if (files.length >= MAX_FILES) { report.truncated = true; continue; }

      try {
        const file = await handle.getFile();
        /* A minified bundle is not something you are going to edit here, and
           it would make every keystroke in the app slower. */
        if (file.size > MAX_BYTES) { report.skipped++; continue; }
        files.push({
          name, relPath, handle,
          lang: langOf(name),
          text: await file.text()
        });
      } catch (err) {
        report.skipped++;                 // locked, deleted mid-walk, unreadable
      }
    }
  }

  /** Pick a folder and read all of it. */
  async function pickFolder() {
    if (typeof window.showDirectoryPicker !== 'function') {
      throw new Error('This browser cannot open a folder. Open the files instead.');
    }
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    const result = await readFolder(dir);
    if (!result.files.length) throw new Error('No HTML, CSS or JavaScript in that folder.');
    return Object.assign({ dirHandle: dir, name: dir.name }, result);
  }

  /** Re-read a folder from a handle we already hold. */
  async function refreshFolder(dir) {
    return Object.assign({ dirHandle: dir, name: dir.name }, await readFolder(dir));
  }

  /** For browsers with no picker at all. */
  function pickWithInput() {
    return new Promise((done) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = '.html,.htm,.css,.js,.mjs';
      input.onchange = async () => {
        const out = [];
        for (const file of input.files) {
          out.push({ name: file.name, text: await file.text(), handle: null, lang: langOf(file.name) });
        }
        done(out);
      };
      input.click();
    });
  }

  async function ensureWritable(handle) {
    if (!handle || !handle.queryPermission) return false;
    if (await handle.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
    return await handle.requestPermission({ mode: 'readwrite' }) === 'granted';
  }

  /**
   * Write a document back where it came from.
   * @returns {Promise<'server'|'handle'|'download'|'saved-as'>} how it was saved
   */
  async function save(doc, opts) {
    opts = opts || {};
    if (!opts.forceNew && doc.path && SERVED) {
      await writeThroughServer(doc.path, doc.text);
      return 'server';
    }
    if (!opts.forceNew && doc.handle && await ensureWritable(doc.handle)) {
      const stream = await doc.handle.createWritable();
      await stream.write(doc.text);
      await stream.close();
      return 'handle';
    }
    return saveAs(doc);
  }

  async function saveAs(doc) {
    if (!hasSavePicker) { download(doc.name, doc.text); return 'download'; }
    const ext = EXT[doc.lang] || 'txt';
    const handle = await window.showSaveFilePicker({
      suggestedName: doc.name,
      types: [{ description: doc.lang.toUpperCase(), accept: { 'text/plain': ['.' + ext] } }]
    });
    const stream = await handle.createWritable();
    await stream.write(doc.text);
    await stream.close();
    doc.handle = handle;
    doc.name = handle.name;
    doc.path = null;              // the handle is now the way back to this file
    return 'saved-as';
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ── the draft ───────────────────────────────────────────────────────── */

  const DRAFT_KEY = 'web-studio:draft';

  const DRAFT_BUDGET = 2 * 1024 * 1024;

  /**
   * Mirror the work into localStorage so closing the window is never how you
   * lose it.
   *
   * With a folder open this keeps only what could not be recovered by opening
   * that folder again — the unsaved edits — because a few hundred untouched
   * files would blow the quota and take the unsaved ones down with them.
   */
  function saveDraft(state) {
    const worth = state.folder
      ? state.docs.filter((d) => d.dirty)
      : state.docs;

    const docs = [];
    let budget = DRAFT_BUDGET;
    for (const d of worth) {
      budget -= d.text.length;
      if (budget < 0) break;
      docs.push({
        name: d.name, lang: d.lang, text: d.text,
        path: d.path || null, relPath: d.relPath || null, dirty: !!d.dirty
      });
    }

    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        at: Date.now(), docs, active: state.active, folder: state.folder || null
      }));
    } catch (e) { /* private mode, or the quota; not worth interrupting for */ }
  }

  function readDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  const clearDraft = () => { try { localStorage.removeItem(DRAFT_KEY); } catch (e) {} };

  root.WS.files = {
    served: SERVED,
    token: TOKEN,
    hasPicker,
    langOf,
    collectOpened,
    loadProject,
    pickFiles,
    pickFolder,
    readFolder,
    refreshFolder,
    save,
    saveAs,
    download,
    saveDraft,
    readDraft,
    clearDraft
  };
})(window);
