/* ============================================================================
   app.js — the wiring.

   Everything else in src/ is a piece that can be reasoned about on its own.
   This file owns the state they share: which documents are open, which pane
   shows which one, and the order things happen in after a keystroke.

   The document text is the single source of truth. Panes render it, the
   preview is rebuilt from it, and nothing keeps a second copy that could
   drift.
   ========================================================================== */
(function (root) {
  'use strict';

  const { schema, analyze, parse, complete, files, edits, symbols, themes, preview: pv } = root.WS;
  const $ = (sel) => document.querySelector(sel);

  const state = {
    docs: [],
    panes: [],
    focused: null,
    split: false,
    loading: false,
    builtHtml: '',
    /* The folder you opened, if you opened one. Its handle is what lets the
       tree be re-read without asking again. */
    folder: null,
    /* Which page the preview follows. Null means "work it out" - index.html if
       there is one, otherwise the first page loaded. */
    previewRoot: null,
    rail: 'files',
    collapsed: new Set()
  };

  /* ── documents ───────────────────────────────────────────────────────── */

  const makeDoc = (spec) => ({
    name: spec.name,
    lang: spec.lang || files.langOf(spec.name),
    text: spec.text || '',
    handle: spec.handle || null,
    path: spec.path || null,
    /* Where the file sits inside the folder you opened. It is the identity a
       tree needs, because two folders can both hold an index.html. */
    relPath: spec.relPath || spec.name,
    /* Loaded is not the same as open. A folder loads hundreds of files; the
       tab strip shows the handful you have actually looked at. */
    shown: spec.shown !== false,
    dirty: false
  });

  const docsOfLang = (lang) => state.docs.filter((d) => d.lang === lang);

  /* Tabs sit in the order you opened them, not the order the folder happened
     to be read in - a file you just clicked belongs at the end of the strip,
     not somewhere in the middle of it. */
  let shownSeq = 0;
  const openTab = (doc) => { if (!doc.shownAt) doc.shownAt = ++shownSeq; doc.shown = true; };
  const shownDocs = () => state.docs.filter((d) => d.shown)
    .sort((a, b) => (a.shownAt || 0) - (b.shownAt || 0));

  const dirOf = (path) => {
    const at = String(path || '').lastIndexOf('/');
    return at < 0 ? '' : path.slice(0, at);
  };

  /**
   * The page the preview is showing. Everything that reasons about "the
   * document" - design mode, the export, the element count - means this one.
   */
  function htmlDoc() {
    if (state.previewRoot && state.docs.includes(state.previewRoot)) return state.previewRoot;
    const pages = docsOfLang('html');
    return pages.find((d) => /(^|\/)index\.html?$/i.test(d.relPath))
      || pages.find((d) => !d.relPath.includes('/'))
      || pages[0] || null;
  }

  /** The HTML document the caret is in, for the things that follow the caret. */
  function editingHtml() {
    const pane = focused();
    return pane && pane.doc && pane.doc.lang === 'html' ? pane.doc : htmlDoc();
  }

  /**
   * What the preview is assembled from: the chosen page, the folder it sits in,
   * and every file that could be referenced from it. `css` and `js` are the
   * fallback for a page that links to nothing.
   */
  function snapshot() {
    const html = htmlDoc();
    const base = html ? dirOf(html.relPath) : '';
    return {
      html: html ? html.text : '',
      base,
      files: state.docs.map((d) => ({ path: d.relPath, name: d.name, lang: d.lang, text: d.text })),
      /* Only what sits beside the page, or a folder's every stylesheet would
         pile onto a page that happens to link to none of them. */
      css: sameFolder(docsOfLang('css'), base).map((d) => d.text).join('\n\n'),
      js: sameFolder(docsOfLang('js'), base).map((d) => d.text).join('\n\n')
    };
  }

  const sameFolder = (docs, base) =>
    state.folder ? docs.filter((d) => dirOf(d.relPath) === base) : docs;

  const anyDirty = () => state.docs.some((d) => d.dirty);

  /* ── names shared between documents ──────────────────────────────────── */

  /** Recomputing on every keystroke is wasteful; the text is the cache key. */
  function memo(fn) {
    let key = null;
    let value = null;
    return (input) => {
      if (input === key) return value;
      key = input;
      try { value = fn(input); } catch (e) { value = []; }
      return value;
    };
  }

  const classesInHtml = memo((text) => {
    const found = new Set();
    const tree = parse.parseHtml(text);
    for (const node of tree.elements) {
      const raw = node.attrs.class;
      if (!raw) continue;
      for (const name of raw.split(/\s+/)) if (name) found.add(name);
    }
    return [...found];
  });

  const idsInHtml = memo((text) => {
    const found = new Set();
    const tree = parse.parseHtml(text);
    for (const node of tree.elements) if (node.attrs.id) found.add(node.attrs.id);
    return [...found];
  });

  const CLASS_IN_SELECTOR = /\.(-?[A-Za-z_][\w-]*)/g;

  const classesInCss = memo((text) => {
    const found = new Set();
    for (const rule of parse.parseCss(text).rules) {
      if (rule.kind !== 'rule') continue;
      let m;
      CLASS_IN_SELECTOR.lastIndex = 0;
      while ((m = CLASS_IN_SELECTOR.exec(rule.selector))) found.add(m[1]);
    }
    return [...found];
  });

  const VAR_DECL = /(--[\w-]+)\s*:/g;

  const varsInCss = memo((text) => {
    const found = new Set();
    let m;
    VAR_DECL.lastIndex = 0;
    while ((m = VAR_DECL.exec(text))) found.add(m[1]);
    return [...found];
  });

  const IDENT_DECL = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;

  const identsInJs = memo((text) => {
    const found = new Set();
    let m;
    IDENT_DECL.lastIndex = 0;
    while ((m = IDENT_DECL.exec(text))) found.add(m[1]);
    return [...found];
  });

  /**
   * The CSS that applies here: the stylesheets and the `<style>` blocks.
   *
   * With a folder open this is scoped to the page's own folder, so completing
   * a class name in one project page does not offer you every class in the
   * whole site.
   */
  function allCss() {
    const html = editingHtml();
    const base = html ? dirOf(html.relPath) : '';
    let css = sameFolder(docsOfLang('css'), base).map((d) => d.text).join('\n');
    if (html) {
      const STYLE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
      let m;
      while ((m = STYLE.exec(html.text))) css += '\n' + m[1];
    }
    return css;
  }

  const providers = {
    classes: () => {
      const html = editingHtml();
      const fromCss = classesInCss(allCss());
      const fromHtml = html ? classesInHtml(html.text) : [];
      /* Whichever document you are in, the other one's names are the useful
         half — but both are offered so a class you just invented still
         completes on its second use. */
      return [...new Set([...fromHtml, ...fromCss])];
    },
    ids: () => {
      const html = editingHtml();
      return html ? idsInHtml(html.text) : [];
    },
    vars: () => varsInCss(allCss()),
    identifiers: () => {
      const pane = focused();
      return pane && pane.doc.lang === 'js' ? identsInJs(pane.doc.text) : [];
    }
  };

  /* ── panes ───────────────────────────────────────────────────────────── */

  const focused = () => state.focused || state.panes[0];

  function makePane(el) {
    const host = el.querySelector('.ed');
    const tabs = el.querySelector('.pane-tabs');

    const editor = root.WS.Editor(host, { lang: 'html' });

    const valuesUi = document.getElementById('tpl-values').content.firstElementChild.cloneNode(true);
    el.appendChild(valuesUi);

    const pane = { el, host, tabs, editor, doc: null, diagnostics: [] };

    pane.values = root.WS.ValueTools(editor, { root: valuesUi }, {
      preview: (text) => livePreview(pane, text),
      previewRestore: () => { livePreviewText = null; schedulePreview(); },
      /* The grip edits one value; with several cursors that would be a lie. */
      isBusy: () => (pane.completion && pane.completion.open) || editor.cursorCount > 1
    });

    pane.completion = complete.Completion(editor, {
      getContext: () => contextFor(pane),
      providers,
      onAction: (action) => {
        if (action === 'colour') openColourPicker(pane);
      }
    });

    pane.peek = root.WS.Peek(editor);
    wireLinks(pane);

    editor.on('notice', (text) => toast(text));

    editor.on('change', () => {
      if (state.loading || !pane.doc) return;
      pane.doc.text = editor.value;
      pane.doc.dirty = true;
      onDocChanged(pane);
    });

    editor.on('caret', () => {
      if (pane !== focused()) return;
      updateStatus(pane);
      markOutline(pane);
      followCaret(pane);
    });

    editor.textarea.addEventListener('focus', () => {
      state.focused = pane;
      renderTabs();
      renderOutline();
      updateStatus(pane);
      followCaret(pane);
    });

    return pane;
  }

  function contextFor(pane) {
    if (!pane.doc) return null;
    try {
      return analyze.contextAt(pane.editor.value, pane.editor.selection.start, pane.doc.lang);
    } catch (e) {
      return null;
    }
  }

  /** Put a document in a pane, without the round trip through `change`. */
  function showDoc(pane, doc) {
    if (!doc) return;
    /* The same file open twice would give two textareas racing to write it. */
    for (const other of state.panes) {
      if (other !== pane && other.doc === doc && !other.el.hidden) {
        const spare = state.docs.find((d) => d !== doc);
        if (spare) showDoc(other, spare);
      }
    }
    state.loading = true;
    openTab(doc);
    pane.doc = doc;
    pane.editor.setLang(doc.lang);
    pane.editor.value = doc.text;
    state.loading = false;
    runDiagnostics(pane);
    renderTabs();
    renderTree();
    if (pane === focused()) { renderOutline(); updateStatus(pane); }
  }

  /**
   * Anything that removes a document has to answer for the panes that were
   * showing it, including a hidden one — otherwise splitting the editor later
   * reveals a file that is no longer part of the project.
   */
  function ensurePaneDocs() {
    for (const pane of state.panes) {
      if (state.docs.includes(pane.doc) && pane.doc.shown) continue;
      const open = shownDocs();
      const fallback = open.find((d) => !state.panes.some((p) => p !== pane && p.doc === d))
        || open[0] || state.docs[0];
      if (!fallback) continue;
      if (pane.el.hidden) pane.doc = fallback;      // no visible editor to sync
      else showDoc(pane, fallback);
    }
  }

  function renderTabs() {
    const open = shownDocs();
    /* Two files called the same thing in different folders need telling apart,
       and only then - a folder hint on every tab would be noise. */
    const ambiguous = new Set();
    const byName = new Map();
    for (const doc of open) {
      if (byName.has(doc.name)) ambiguous.add(doc.name);
      byName.set(doc.name, doc);
    }

    for (const pane of state.panes) {
      const frag = document.createDocumentFragment();
      open.forEach((doc) => {
        const tab = document.createElement('div');
        tab.className = 'tab' + (doc === pane.doc ? ' is-active' : '');
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', doc === pane.doc ? 'true' : 'false');
        tab.title = doc.path || doc.relPath;
        tab.tabIndex = 0;

        const label = document.createElement('span');
        label.textContent = doc.name;
        tab.appendChild(label);

        if (ambiguous.has(doc.name) && dirOf(doc.relPath)) {
          const where = document.createElement('span');
          where.className = 'tab-where';
          where.textContent = dirOf(doc.relPath);
          tab.appendChild(where);
        }

        const dot = document.createElement('span');
        dot.className = 'tab-dot';
        dot.hidden = !doc.dirty;
        tab.appendChild(dot);

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'tab-close';
        close.textContent = '\u00d7';
        close.title = 'Close this tab. The file stays in the project.';
        close.addEventListener('click', (e) => { e.stopPropagation(); hideTab(doc); });
        tab.appendChild(close);

        tab.addEventListener('click', () => { showDoc(pane, doc); pane.editor.focus(); });
        tab.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDoc(pane, doc); pane.editor.focus(); }
        });
        tab.addEventListener('auxclick', (e) => { if (e.button === 1) hideTab(doc); });
        frag.appendChild(tab);
      });
      pane.tabs.replaceChildren(frag);
    }
    updateSaveState();
  }

  /**
   * Take a tab off the strip. The document stays loaded - it is still in the
   * tree, still saved by Save, still reachable by the preview - because a file
   * you closed the view of is not a file you removed from the project.
   */
  function hideTab(doc) {
    if (shownDocs().length < 2) return;
    doc.shown = false;
    ensurePaneDocs();
    renderTabs();
    renderTree();
  }

  /* -- writing to a document from outside the editor -------------------- */

  /** The smallest replacement that turns `a` into `b`. */
  function minimalEdit(a, b) {
    let from = 0;
    const limit = Math.min(a.length, b.length);
    while (from < limit && a[from] === b[from]) from++;
    let tail = 0;
    while (tail < limit - from && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    return { from, to: a.length - tail, text: b.slice(from, b.length - tail) };
  }

  /**
   * Replace a document's text on behalf of a gesture in the preview.
   *
   * Routed through the editor rather than assigned, so Ctrl+Z takes a drag
   * back the same way it takes a typo back. execCommand needs the textarea
   * focused, so focus is borrowed and handed straight back - otherwise the
   * first drag would throw you out of the preview.
   */
  function patchDoc(doc, next) {
    if (next == null || next === doc.text) return false;
    const pane = state.panes.find((p) => p.doc === doc && !p.el.hidden);
    if (!pane) {
      doc.text = next;
    } else {
      const active = document.activeElement;
      const patch = minimalEdit(doc.text, next);
      state.loading = true;
      pane.editor.replaceRange(patch.from, patch.to, patch.text, 0);
      state.loading = false;
      doc.text = pane.editor.value;
      if (active && active !== pane.editor.textarea && active.focus) active.focus();
      runDiagnostics(pane);
    }
    doc.dirty = true;
    renderTabs();
    renderTree();
    renderOutline();
    schedulePreview(true);
    return true;
  }

  /* -- the loop after an edit ------------------------------------------- */

  let diagTimer = 0;
  let previewTimer = 0;
  let draftTimer = 0;
  let livePreviewText = null;

  function onDocChanged(pane) {
    clearTimeout(diagTimer);
    diagTimer = setTimeout(() => runDiagnostics(pane), 180);

    schedulePreview();
    renderTabs();
    updateStatus(pane);

    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => files.saveDraft({
      docs: state.docs,
      folder: state.folder ? { name: state.folder.name } : null,
      active: state.docs.indexOf(focused() ? focused().doc : null)
    }), 900);

    if (pane === focused()) {
      clearTimeout(outlineTimer);
      outlineTimer = setTimeout(renderOutline, 200);
    }

    maybeComplete(pane);
  }

  function runDiagnostics(pane) {
    if (!pane.doc) return;
    pane.diagnostics = analyze.diagnose(pane.doc.text, pane.doc.lang);
    pane.editor.setDiagnostics(pane.diagnostics);
    if (pane === focused()) updateStatus(pane);
  }

  function schedulePreview(immediate) {
    clearTimeout(previewTimer);
    const docs = livePreviewText != null ? livePreviewText : snapshot();
    previewTimer = setTimeout(() => {
      state.builtHtml = docs.html;
      previewApi.update(docs, 0);
    }, immediate ? 0 : 120);
  }

  /** A value being dragged previews without the document being touched. */
  function livePreview(pane, text) {
    if (!pane.doc) return;
    const docs = snapshot();
    if (pane.doc.lang === 'html') docs.html = text;
    else if (pane.doc.lang === 'css') docs.css = replaceIn(docs.css, pane.doc.text, text);
    else docs.js = replaceIn(docs.js, pane.doc.text, text);
    livePreviewText = docs;
    schedulePreview();
  }

  const replaceIn = (joined, oldText, newText) =>
    joined.includes(oldText) ? joined.replace(oldText, () => newText) : newText;

  const COMPLETABLE = new Set(['tag', 'close-tag', 'attr', 'attr-value',
    'css-prop', 'css-value', 'css-selector', 'css-at', 'js', 'js-member']);

  function maybeComplete(pane) {
    const ctx = contextFor(pane);
    if (!ctx || !COMPLETABLE.has(ctx.kind)) return pane.completion.close();

    /* A number or colour under the caret gets the popover, not a word list. */
    let onValue = null;
    try { onValue = root.WS.valueTokens.analyse(pane.editor); } catch (e) { onValue = null; }
    if (onValue && !pane.completion.open) return pane.completion.close();

    const pos = pane.editor.selection.start;
    const ch = pane.editor.value[pos - 1] || '';
    const opens = /[\w$-]/.test(ch) || ch === '<' || ch === '.' || ch === '#' ||
      ch === '@' || ch === ':' || ch === '/';
    pane.completion.retrigger(opens && (ctx.word.length > 0 || ch === '<' || ch === '.' || ch === '@'));
  }

  function openColourPicker(pane) {
    /* Give the caret a colour to sit on, then let the popover find it. */
    const sel = pane.editor.selection;
    pane.editor.replaceRange(sel.start, sel.end, '#3b82f6');
    pane.values.open();
  }

  /* ── outline ─────────────────────────────────────────────────────────── */

  let outlineTimer = 0;
  let outlineRows = [];

  function renderOutline() {
    const pane = focused();
    const list = $('#outline');
    if (!pane || !pane.doc) return;
    if (state.rail !== 'outline') {
      /* Still worth keeping the counts current - they sit in the other rail's
         footer and are read at a glance, not navigated. */
      updateCounts();
      return;
    }

    list.dataset.lang = pane.doc.lang;

    const filter = state.rail === 'outline' ? $('#side-filter').value.trim().toLowerCase() : '';
    outlineRows = analyze.outline(pane.doc.text, pane.doc.lang)
      .filter((row) => !filter ||
        (row.label + ' ' + (row.detail || '')).toLowerCase().includes(filter));

    if (!outlineRows.length) {
      const empty = document.createElement('div');
      empty.className = 'side-empty';
      empty.textContent = filter ? 'Nothing matches that.' : 'Nothing here yet.';
      list.replaceChildren(empty);
    } else {
      const frag = document.createDocumentFragment();
      outlineRows.forEach((row, i) => {
        const el = document.createElement('div');
        el.className = 'out-row';
        el.dataset.index = String(i);
        el.style.paddingLeft = (10 + Math.min(row.depth, 8) * 11) + 'px';
        el.setAttribute('role', 'treeitem');

        const label = document.createElement('span');
        label.className = 'out-label';
        label.textContent = row.label;
        el.appendChild(label);

        if (row.detail) {
          const detail = document.createElement('span');
          detail.className = 'out-detail';
          detail.textContent = row.detail;
          el.appendChild(detail);
        }
        frag.appendChild(el);
      });
      list.replaceChildren(frag);
    }

    updateCounts();
    markOutline(pane);
  }

  function updateCounts() {
    const html = htmlDoc();
    $('#stat-elements').textContent = html ? parse.parseHtml(html.text).elements.length : 0;
    $('#stat-rules').textContent = parse.parseCss(allCss()).rules.filter((r) => r.kind === 'rule').length;
  }

  function markOutline(pane) {
    if (!pane || !pane.doc) return;
    const pos = pane.editor.selection.start;
    let best = -1;
    outlineRows.forEach((row, i) => { if (row.pos <= pos) best = i; });
    const list = $('#outline');
    for (const row of list.children) row.classList.remove('is-active');
    const active = list.children[best];
    if (active && active.classList) active.classList.add('is-active');
  }

  $('#outline').addEventListener('click', (e) => {
    const row = e.target.closest('.out-row');
    if (!row) return;
    const item = outlineRows[Number(row.dataset.index)];
    const pane = focused();
    if (!item || !pane) return;
    pane.editor.setSelection(item.pos, item.end != null ? item.pos : undefined);
    pane.editor.focus();
    if (pane.doc.lang !== 'html' || item.nodeId == null) return;
    if (previewApi.mode !== 'off') previewApi.select(item.nodeId);
    else previewApi.flash(item.nodeId);
  });

  $('#side-filter').addEventListener('input', () => {
    if (state.rail === 'files') renderTree(); else renderOutline();
  });

  /* ── the file tree ───────────────────────────────────────────────────── */

  /**
   * Build a folder tree out of the loaded documents' paths.
   *
   * There is no separate model of the folder: the paths the documents already
   * carry are the tree, so it cannot fall out of step with what is loaded.
   */
  function buildTree(docs) {
    const root = { name: '', path: '', dirs: new Map(), files: [] };
    for (const doc of docs) {
      const parts = doc.relPath.split('/');
      const leaf = parts.pop();
      let node = root;
      let path = '';
      for (const part of parts) {
        path = path ? path + '/' + part : part;
        if (!node.dirs.has(part)) {
          node.dirs.set(part, { name: part, path, dirs: new Map(), files: [] });
        }
        node = node.dirs.get(part);
      }
      node.files.push(Object.assign({ leaf }, { doc }));
    }
    return root;
  }

  const ICON = { html: '<>', css: '#', js: 'JS' };

  function renderTree() {
    const list = $('#filetree');
    if (!list) return;

    const filter = state.rail === 'files' ? $('#side-filter').value.trim().toLowerCase() : '';
    const matches = (doc) => !filter || doc.relPath.toLowerCase().includes(filter);
    const visible = state.docs.filter(matches);

    $('#stat-files').textContent = filter
      ? visible.length + ' of ' + state.docs.length
      : state.docs.length;
    $('#stat-folder').textContent = state.folder ? state.folder.name : 'No folder';
    $('#stat-folder').title = state.folder ? state.folder.name : 'Open a folder to see it here';
    $('#btn-refresh-folder').hidden = !state.folder;

    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'tree-empty';
      if (filter) empty.textContent = 'Nothing matches that.';
      else empty.innerHTML = 'No files yet. <b>Folder</b> opens a whole project.';
      list.replaceChildren(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    /* Filtering flattens: when you are hunting for a name, the folders between
       you and it are in the way, not in the picture. */
    if (filter) {
      for (const doc of visible) frag.appendChild(fileRow(doc, 0, true));
    } else {
      drawNode(buildTree(visible), 0, frag);
    }
    list.replaceChildren(frag);
  }

  function drawNode(node, depth, frag) {
    for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const collapsed = state.collapsed.has(dir.path);
      frag.appendChild(dirRow(dir, depth, collapsed));
      if (!collapsed) drawNode(dir, depth + 1, frag);
    }
    for (const entry of node.files) frag.appendChild(fileRow(entry.doc, depth, false));
  }

  function dirRow(dir, depth, collapsed) {
    const row = document.createElement('div');
    row.className = 'tree-row is-dir' + (collapsed ? ' is-collapsed' : '');
    row.style.paddingLeft = (6 + depth * 12) + 'px';
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-expanded', String(!collapsed));
    row.tabIndex = 0;

    const twist = document.createElement('span');
    twist.className = 'tree-twist';
    twist.textContent = '\u25be';

    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = dir.name;

    row.append(twist, name);
    const toggle = () => {
      if (state.collapsed.has(dir.path)) state.collapsed.delete(dir.path);
      else state.collapsed.add(dir.path);
      renderTree();
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    return row;
  }

  function fileRow(doc, depth, flat) {
    const row = document.createElement('div');
    const isCurrent = state.panes.some((p) => !p.el.hidden && p.doc === doc);
    row.className = 'tree-row' + (isCurrent ? ' is-active' : doc.shown ? ' is-open' : '');
    row.style.paddingLeft = (6 + (flat ? 0 : depth * 12) + 12) + 'px';
    row.setAttribute('role', 'treeitem');
    row.title = doc.path || doc.relPath;
    row.tabIndex = 0;

    const icon = document.createElement('span');
    icon.className = 'tree-icon tree-icon-' + doc.lang;
    icon.textContent = ICON[doc.lang] || '\u2022';

    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = doc.name;

    row.append(icon, name);

    if (flat && dirOf(doc.relPath)) {
      const where = document.createElement('span');
      where.className = 'tree-where';
      where.textContent = dirOf(doc.relPath);
      row.appendChild(where);
    }

    /* Which page the preview follows, settable from here - the tree is where
       you are looking when you decide you want to see a different one. */
    if (doc.lang === 'html') {
      const root = document.createElement('button');
      const chosen = htmlDoc() === doc;
      root.type = 'button';
      root.className = 'tree-root' + (chosen ? ' is-root' : '');
      root.textContent = chosen ? '\u25c9' : '\u25cb';
      root.title = chosen ? 'The preview is showing this page' : 'Show this page in the preview';
      root.addEventListener('click', (e) => { e.stopPropagation(); setPreviewRoot(doc); });
      row.appendChild(root);
    }

    const dot = document.createElement('span');
    dot.className = 'tree-dot';
    dot.hidden = !doc.dirty;
    row.appendChild(dot);

    const open = () => {
      const pane = focused();
      showDoc(pane, doc);
      pane.editor.focus();
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    return row;
  }

  /* ── which page the preview follows ──────────────────────────────────── */

  /* The pages the preview showed before this one, newest last - what its
     back button, and Alt+Left inside the page, go back through. */
  const previewTrail = [];

  /**
   * @param {{back?: boolean, note?: string}} [opts] `back` for a step back,
   *   which must not itself be remembered as somewhere to go back to.
   */
  function setPreviewRoot(doc, opts) {
    if (!doc || doc.lang !== 'html') return;
    const was = htmlDoc();
    if (was && was !== doc && !(opts && opts.back)) {
      previewTrail.push(was);
      if (previewTrail.length > 50) previewTrail.shift();
    }
    state.previewRoot = doc;
    renderPreviewRoot();
    renderTree();
    renderOutline();
    schedulePreview(true);
    toast((opts && opts.note) || 'Preview is showing ' + doc.relPath, 'good');
  }

  function previewBack() {
    while (previewTrail.length) {
      const doc = previewTrail.pop();
      if (state.docs.includes(doc) && doc !== htmlDoc()) {
        setPreviewRoot(doc, { back: true, note: 'Back to ' + doc.relPath });
        return;
      }
    }
    renderPreviewRoot();
  }

  $('#btn-pv-back').addEventListener('click', previewBack);

  /**
   * A link clicked in the page. If it leads to one of the project's pages,
   * the preview shows that page - resolved from the folder the current page
   * sits in, the way a browser would resolve it.
   */
  function followPageLink(href) {
    const page = htmlDoc();
    const at = href.indexOf('#');
    const hash = at < 0 ? '' : href.slice(at + 1);
    const path = (at < 0 ? href : href.slice(0, at)).split('?')[0];

    const target = path ? pageAt(path, page) : page;
    if (!target) {
      toast(path + ' is not one of the pages loaded here.' +
        (state.folder ? '' : ' Open the folder and links between its pages will work.'), 'bad');
      return;
    }
    if (target.lang !== 'html') {
      toast('That link goes to ' + target.relPath + ', which is not a page.', 'bad');
      return;
    }
    if (target === page) { previewApi.scrollToHash(hash || 'top', false); return; }
    previewApi.scrollToHash(hash, true);
    setPreviewRoot(target, { note: 'Followed the link to ' + target.relPath });
  }

  /**
   * The document a link path names. Exact paths first - relative to the
   * page, then from the project root, with `folder/` meaning its index.html -
   * and the bare file name only when that cannot be mistaken for another.
   */
  function pageAt(path, page) {
    const base = page ? dirOf(page.relPath) : '';
    const rooted = path.replace(/^\/+/, '');
    const forms = [path];
    if (/\/$/.test(path)) forms.push(path + 'index.html');
    else if (!/\.[a-z0-9]+$/i.test(path.split('/').pop())) forms.push(path + '/index.html', path + '.html');

    for (const form of forms) {
      const clean = form.replace(/^\/+/, '');
      const wanted = /^\//.test(form) ? [clean] : [pv.normalisePath(base ? base + '/' + form : form), clean];
      for (const want of wanted) {
        const hit = state.docs.find((d) => d.relPath === pv.normalisePath(want));
        if (hit) return hit;
      }
    }
    /* A loose handful of files has no folders to resolve against. */
    const leaf = rooted.split('/').pop();
    const named = state.docs.filter((d) => d.name === leaf);
    return named.length === 1 ? named[0] : null;
  }

  function renderPreviewBack() {
    const button = $('#btn-pv-back');
    const before = [...previewTrail].reverse().find((d) => state.docs.includes(d) && d !== htmlDoc());
    button.hidden = !before;
    button.title = before ? 'Back to ' + before.relPath + ' (Alt+Left in the preview)' : '';
  }

  function renderPreviewRoot() {
    renderPreviewBack();
    const select = $('#preview-root');
    const pages = docsOfLang('html');
    const current = htmlDoc();
    select.replaceChildren();

    if (!pages.length) {
      const option = document.createElement('option');
      option.textContent = 'No page';
      select.appendChild(option);
      select.disabled = true;
      return;
    }
    select.disabled = pages.length < 2;
    for (const doc of pages) {
      const option = document.createElement('option');
      option.value = doc.relPath;
      option.textContent = doc.relPath;
      option.selected = doc === current;
      select.appendChild(option);
    }
    select.title = pages.length < 2
      ? 'The only page in the project'
      : 'Which page the preview shows';
  }

  $('#preview-root').addEventListener('change', (e) => {
    const doc = docsOfLang('html').find((d) => d.relPath === e.target.value);
    if (doc) setPreviewRoot(doc);
  });

  /* ── the sidebar rails ───────────────────────────────────────────────── */

  function showRail(rail) {
    state.rail = rail;
    for (const tab of document.querySelectorAll('.side-tab')) {
      const on = tab.dataset.rail === rail;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
    }
    $('#filetree').hidden = rail !== 'files';
    $('#outline').hidden = rail !== 'outline';
    $('#foot-files').hidden = rail !== 'files';
    $('#foot-outline').hidden = rail !== 'outline';
    $('#side-filter').placeholder = rail === 'files' ? 'Filter files' : 'Filter outline';
    $('#side-filter').value = '';
    if (rail === 'files') renderTree(); else renderOutline();
  }

  for (const tab of document.querySelectorAll('.side-tab')) {
    tab.addEventListener('click', () => showRail(tab.dataset.rail));
  }

  $('#btn-refresh-folder').addEventListener('click', () => reopenFolder());

  /* ── inline help ─────────────────────────────────────────────────────── */

  const KIND_LABEL = {
    tag: 'element', 'close-tag': 'element', attr: 'attribute', 'attr-value': 'value',
    'css-prop': 'property', 'css-value': 'value', 'css-selector': 'selector',
    'css-at': 'at-rule', js: 'script', 'js-member': 'member', text: 'text',
    comment: 'comment', none: ''
  };

  function updateStatus(pane) {
    if (!pane || !pane.doc) return;
    const pos = pane.editor.selection.start;
    const starts = root.WS.lineStarts(pane.editor.value);
    const at = root.WS.posToLineCol(starts, pos);
    const cursors = pane.editor.cursorCount;
    $('#caret-pos').textContent = at.line + ':' + at.col + (cursors > 1 ? '  +' + (cursors - 1) : '');

    const errors = pane.diagnostics.filter((d) => d.severity === 'error').length;
    const warnings = pane.diagnostics.length - errors;
    const diag = $('#diag-count');
    diag.textContent = errors || warnings
      ? [errors ? errors + (errors === 1 ? ' error' : ' errors') : '',
         warnings ? warnings + (warnings === 1 ? ' warning' : ' warnings') : '']
        .filter(Boolean).join(', ')
      : '';
    diag.classList.toggle('has-error', errors > 0);

    /* Several cursors, or a selection that has twins: say what the keys do,
       because neither is something you can see the way out of. */
    if (cursors > 1) {
      $('#help-kind').textContent = 'cursors';
      $('#help-text').innerHTML = '<b>' + cursors + ' cursors.</b> Typing goes in at every one. ' +
        'Ctrl+D adds the next match, Esc goes back to one.';
      return;
    }
    const matches = pane.editor.matchCount;
    if (matches > 1 && pane.editor.selection.end > pos) {
      $('#help-kind').textContent = 'selection';
      $('#help-text').innerHTML = '<b>' + matches + ' matches.</b> Ctrl+D adds the next one, ' +
        'Ctrl+Shift+L selects all of them.';
      return;
    }

    /* A message about the thing under the caret beats a definition of it. */
    const here = pane.diagnostics.find((d) => pos >= d.start && pos <= d.end);
    if (here) {
      $('#help-kind').textContent = here.severity;
      $('#help-text').innerHTML = complete.formatDoc(here.message);
      return;
    }
    const ctx = contextFor(pane);
    const help = describe(ctx);
    $('#help-kind').textContent = help.kind;
    $('#help-text').innerHTML = help.html + followHint(pane, pos);
  }

  /** "Ctrl+click goes there", when the caret is on a name that goes somewhere. */
  function followHint(pane, pos) {
    let sym = null;
    try { sym = symbols.symbolAt(pane.doc.text, pos, pane.doc.lang); } catch (e) { sym = null; }
    if (!sym) return '';
    const where = sym.kind === 'ref' ? 'opens the file'
      : sym.kind === 'var' ? 'finds where it is declared'
      : sym.kind === 'anchor' || sym.side === 'css' ? 'finds it in the markup'
      : 'goes to its rule, hold Ctrl to peek';
    return ' <span class="status-follow">Ctrl+click ' + where + '.</span>';
  }

  /** Is what you have typed so far the start of something real? */
  const beginsSomething = (word, table) => {
    if (!word) return false;
    const lower = word.toLowerCase();
    for (const name in table) if (name.toLowerCase().startsWith(lower)) return true;
    return false;
  };

  function describe(ctx) {
    const blank = { kind: '', html: '' };
    if (!ctx) return blank;
    const kind = KIND_LABEL[ctx.kind] || '';

    const wrap = (name, doc) =>
      ({ kind, html: '<b>' + root.WS.escapeHtml(name) + '</b> — ' + complete.formatDoc(doc) });

    /* Half a word is not a mistake. Saying so on every keystroke trains you to
       stop reading the line that also carries the real errors. */
    const partial = (word, table) => beginsSomething(word, table)
      ? { kind, html: 'Keep typing, or press Enter to take a suggestion.' }
      : null;

    switch (ctx.kind) {
      case 'tag':
      case 'close-tag': {
        const name = (ctx.tag || ctx.word || '').toLowerCase();
        if (schema.elements[name]) return wrap('<' + name + '>', schema.elements[name]);
        if (name) {
          return partial(name, schema.elements) ||
            { kind, html: '<b>&lt;' + root.WS.escapeHtml(name) + '&gt;</b> — ' +
              (name.includes('-') ? 'A custom element. Define it with `customElements.define`.'
                : 'Not an element I recognise.') };
        }
        return { kind, html: 'Type an element name.' };
      }
      case 'attr':
      case 'attr-value': {
        const attrs = schema.attrsFor(ctx.tag);
        const name = ctx.kind === 'attr' ? ctx.word : ctx.attr;
        if (attrs[name]) return wrap(name, attrs[name].doc);
        if (name && name.startsWith('data-')) return wrap(name, schema.globalAttrs['data-*']);
        if (name && name.startsWith('on')) {
          return wrap(name, 'An inline event handler. A listener in your script is easier to maintain.');
        }
        if (!name) return { kind, html: 'Type an attribute name.' };
        return partial(name, attrs) ||
          { kind, html: '<b>' + root.WS.escapeHtml(name) + '</b> — not an attribute I know.' };
      }
      case 'css-prop':
      case 'css-value': {
        const name = ctx.kind === 'css-prop' ? ctx.word : ctx.prop;
        if (schema.css[name]) return wrap(name, schema.css[name].doc);
        if (name && name.startsWith('--')) {
          return wrap(name, 'A custom property. Read it back with `var(' + name + ')`.');
        }
        if (!name) return { kind, html: 'Type a property name.' };
        return partial(name, schema.css) ||
          { kind, html: '<b>' + root.WS.escapeHtml(name) + '</b> — not a property I know.' };
      }
      case 'css-selector': {
        const pseudo = /::?[\w-]+$/.exec(ctx.prelude || '');
        if (pseudo && schema.pseudo[pseudo[0]]) return wrap(pseudo[0], schema.pseudo[pseudo[0]]);
        return { kind, html: 'Which elements this rule applies to.' };
      }
      case 'css-at': {
        const name = (/^@[\w-]*/.exec(ctx.word) || [''])[0];
        if (schema.atRules[name]) return wrap(name, schema.atRules[name]);
        return { kind, html: 'An at-rule.' };
      }
      case 'js-member':
        return { kind, html: '<b>' + root.WS.escapeHtml(ctx.object) + '.</b> — Ctrl+Space lists what you can reach.' };
      case 'js':
        return { kind, html: 'Ctrl+Space for suggestions. Anything you log shows in the console.' };
      case 'comment':
        return { kind, html: 'A comment. It never reaches the page.' };
      default:
        return blank;
    }
  }

  /* ── following a name to where it leads ──────────────────────────────── */

  const EXTERNAL_REF = /^(https?:)?\/\/|^data:|^blob:/i;

  /**
   * The stylesheets a page uses, in the order it uses them: what it links,
   * then its own <style> blocks. Every other sheet loaded comes after, marked
   * `elsewhere`, so a rule in a file the page forgot to link is still found -
   * and you are told that is why it does nothing.
   */
  function sheetsFor(page) {
    const out = [];
    const seen = new Set();
    const add = (doc, extra) => {
      if (seen.has(doc)) return;
      seen.add(doc);
      out.push(Object.assign({ doc, text: doc.text, offset: 0, label: doc.relPath }, extra));
    };

    if (page) {
      const list = state.docs.map((d) => ({ path: d.relPath, name: d.name, lang: d.lang, doc: d }));
      const LINK = /<link\b[^>]*>/gi;
      let linked = false;
      let m;
      while ((m = LINK.exec(page.text))) {
        if (!/\brel\s*=\s*["']?stylesheet/i.test(m[0])) continue;
        const href = (/\bhref\s*=\s*["']([^"']+)["']/i.exec(m[0]) || [])[1];
        if (!href || EXTERNAL_REF.test(href)) continue;
        linked = true;
        const found = pv.resolveRef(list, dirOf(page.relPath), href);
        if (found && found.doc.lang === 'css') add(found.doc);
      }
      for (const node of parse.parseHtml(page.text).elements) {
        if (node.tag !== 'style' || node.textStart == null) continue;
        out.push({ doc: page, text: page.text.slice(node.textStart, node.textEnd),
          offset: node.textStart, label: page.relPath + ' <style>' });
      }
      /* A page that links nothing gets the sheets beside it; so does the preview. */
      if (!linked) for (const doc of sameFolder(docsOfLang('css'), dirOf(page.relPath))) add(doc);
    }
    for (const doc of docsOfLang('css')) add(doc, { elsewhere: !!page });
    return out;
  }

  /** The page a name in `doc` is about, then every other page. */
  function pagesFor(doc) {
    const first = doc.lang === 'html' ? doc : htmlDoc();
    return [first, ...docsOfLang('html').filter((d) => d !== first)].filter(Boolean);
  }

  const lineIn = (doc, pos) => symbols.lineOf(doc.text, pos);
  const codeHtml = (s) => '<code>' + root.WS.escapeHtml(s) + '</code>';
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

  /**
   * Everywhere a name leads, as a list the peek window can show and each
   * entry knows how to go to.
   * @returns {{title: string, items: object[], empty?: string}}
   */
  function targetsFor(doc, sym) {
    const page = doc.lang === 'html' ? doc : htmlDoc();

    if (sym.kind === 'ref') {
      const list = state.docs.map((d) => ({ path: d.relPath, name: d.name, lang: d.lang, doc: d }));
      const found = pv.resolveRef(list, dirOf(doc.relPath), sym.name);
      return {
        title: codeHtml(sym.name),
        items: found ? [{ label: found.doc.relPath, where: found.doc.lang.toUpperCase(),
          go: () => openAt(found.doc, 0) }] : [],
        empty: EXTERNAL_REF.test(sym.name)
          ? sym.name + ' is on the web, not in this project.'
          : sym.name + ' is not one of the files loaded here.'
      };
    }

    if (sym.kind === 'var') {
      const hits = symbols.varsFor(sheetsFor(page), sym.name);
      return {
        title: hits.length
          ? codeHtml(sym.name) + ' is declared ' + (hits.length === 1 ? 'once' : hits.length + ' times')
          : codeHtml(sym.name) + ' is never declared',
        items: hits.map((h) => ({
          label: h.selector,
          note: h.media,
          where: h.sheet.label + ':' + lineIn(h.sheet.doc, h.start),
          lines: [{ name: sym.name, value: h.value }],
          go: () => openAt(h.sheet.doc, h.start, h.end)
        })),
        empty: sym.name + ' is not declared in any stylesheet.'
      };
    }

    /* From a selector, or an `href="#id"`: the elements it picks out. */
    if (sym.side === 'css' || sym.kind === 'anchor') {
      const kind = sym.kind === 'anchor' ? 'id' : sym.kind;
      const hits = symbols.usesFor(sym.kind === 'anchor' ? [doc] : pagesFor(doc), { kind, name: sym.name });
      const what = kind === 'class' ? 'class ' + codeHtml(sym.name) : 'id ' + codeHtml(sym.name);
      return {
        title: hits.length ? plural(hits.length, 'element', 'elements') + ' with ' + what
          : 'No element has ' + what,
        items: hits.map((h) => ({
          label: '<' + h.tag + '>',
          where: h.page.relPath + ':' + lineIn(h.page, h.start),
          code: h.code,
          go: () => openAt(h.page, h.start, h.end)
        })),
        empty: 'Nothing in the markup has ' + (kind === 'class' ? 'class "' : 'id "') + sym.name + '".'
      };
    }

    /* A class or id in the markup: the rules that style it. */
    const selector = (sym.kind === 'class' ? '.' : '#') + sym.name;
    const sheets = sheetsFor(page);
    const hits = symbols.rulesFor(sheets, sym);
    const items = hits.map((h) => ({
      label: h.selector,
      mark: h.mark,
      note: [h.media, h.sheet.elsewhere ? 'not linked from this page' : ''].filter(Boolean).join('  '),
      where: h.sheet.label + ':' + lineIn(h.sheet.doc, h.start),
      lines: h.declarations,
      go: () => openAt(h.sheet.doc, h.start, h.end)
    }));
    if (!hits.length) {
      const home = sheets.find((s) => !s.elsewhere) || sheets[0];
      if (home) {
        items.push({ action: true, label: 'Create ' + selector + ' { } in ' + home.label,
          go: () => createRuleIn(home, selector) });
      }
    }
    return {
      title: hits.length ? plural(hits.length, 'rule', 'rules') + ' for ' + codeHtml(selector)
        : 'No rule styles ' + codeHtml(selector) + ' yet',
      items,
      empty: 'There is no stylesheet to put ' + selector + ' in.'
    };
  }

  /** Append an empty rule to a sheet and leave the caret inside it. */
  function createRuleIn(sheet, selector) {
    const doc = sheet.doc;
    const css = sheet.text;
    const gap = !css.trim() ? '' : css.endsWith('\n\n') ? '' : css.endsWith('\n') ? '\n' : '\n\n';
    const at = sheet.offset + css.length;
    const block = selector + ' {\n' + root.WS.INDENT + '\n}\n';
    patchDoc(doc, doc.text.slice(0, at) + gap + block + doc.text.slice(at));
    openAt(doc, at + gap.length + selector.length + 3 + root.WS.INDENT.length);
  }

  /**
   * Go where a name leads. One place: straight there. Several, or none but
   * something to offer: the peek window, pinned, to choose from.
   */
  function follow(pane, sym) {
    const model = targetsFor(pane.doc, sym);
    if (model.items.length === 1 && !model.items[0].action) { model.items[0].go(); return; }
    if (!model.items.length) { toast(model.empty || 'Nothing to go to.', 'bad'); return; }
    pane.peek.show(model, sym.start, { pinned: true });
  }

  /* Where you were before each jump, newest last, for Alt+Left. */
  const trail = [];

  /** Show `doc` with [start, end) selected, in a pane that already has it if one does. */
  function openAt(doc, start, end, opts) {
    if (!state.docs.includes(doc)) return;
    const from = focused();
    if (from && from.doc && !(opts && opts.back)) {
      trail.push({ doc: from.doc, start: from.editor.selection.start, end: from.editor.selection.end });
      if (trail.length > 60) trail.shift();
    }
    let pane = state.panes.find((p) => p.doc === doc && !p.el.hidden);
    if (!pane) { pane = focused(); showDoc(pane, doc); }
    state.focused = pane;
    const max = doc.text.length;
    const a = Math.min(start, max);
    pane.editor.setSelection(a, Math.min(end == null ? start : end, max), { center: true });
    pane.editor.flashLine(a);
  }

  function goBack() {
    while (trail.length) {
      const spot = trail.pop();
      if (!state.docs.includes(spot.doc)) continue;
      openAt(spot.doc, spot.start, spot.end, { back: true });
      return;
    }
    toast('Nowhere to go back to.');
  }

  /**
   * Ctrl over a name underlines it and, after a beat, peeks at where it
   * leads; Ctrl+click goes there.
   */
  function wireLinks(pane) {
    const ed = pane.editor;
    const ta = ed.textarea;
    let pointer = null;       // where the mouse last was over this editor
    let current = null;       // the name under it while Ctrl is down
    let timer = 0;

    function symbolUnder(x, y) {
      if (!pane.doc) return null;
      const hit = ed.posFromPoint(x, y);
      if (!hit || !hit.inside) return null;
      try { return symbols.symbolAt(pane.doc.text, hit.pos, pane.doc.lang); } catch (e) { return null; }
    }

    function clear() {
      clearTimeout(timer);
      if (!current) return;
      current = null;
      ed.setLink(null);
      ta.classList.remove('is-linking');
      if (!pane.peek.pinned) pane.peek.hide();
    }

    function probe(x, y) {
      const sym = symbolUnder(x, y);
      if (!sym) return clear();
      const key = sym.kind + ':' + sym.start + ':' + sym.end;
      if (current && current.key === key) return;
      current = { key, sym };
      ed.setLink(sym);
      ta.classList.add('is-linking');
      if (!pane.peek.pinned) pane.peek.hide();
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!current || current.key !== key || pane.peek.pinned) return;
        const model = targetsFor(pane.doc, sym);
        if (model.items.length) pane.peek.show(model, sym.start);
      }, 220);
    }

    /* Ctrl alone - AltGr arrives as Ctrl+Alt and is a character, not a link. */
    const linking = (e) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;

    ta.addEventListener('mousemove', (e) => {
      pointer = { x: e.clientX, y: e.clientY };
      if (linking(e)) probe(e.clientX, e.clientY); else clear();
    });
    ta.addEventListener('mouseleave', () => { pointer = null; clear(); });
    /* Pressing Ctrl over a name works without having to wiggle the mouse. */
    document.addEventListener('keydown', (e) => {
      if ((e.key === 'Control' || e.key === 'Meta') && pointer && linking(e)) probe(pointer.x, pointer.y);
      else if (e.key !== 'Control' && e.key !== 'Meta') clear();
    });
    document.addEventListener('keyup', (e) => { if (e.key === 'Control' || e.key === 'Meta') clear(); });
    window.addEventListener('blur', clear);

    ta.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !linking(e)) return;
      const sym = symbolUnder(e.clientX, e.clientY);
      if (!sym) return;
      e.preventDefault();               // leave the caret where it was
      clear();
      follow(pane, sym);
    });
  }

  /* ── the preview ─────────────────────────────────────────────────────── */

  const frame = $('#pv-frame');
  const conLog = $('#con-log');
  let conRows = 0;
  let conErrors = 0;

  const previewApi = pv.Preview(frame, {
    onConsole: (entry) => addConsole(entry.level, entry.text),
    onPick: (p) => {
      if (p.node == null) { picked = null; previewApi.select(null); return; }
      previewApi.select(p.node);
      /* With a stylesheet in front of you, the question a click asks is
         "what styles this?" - so the answer is a rule, not the markup. */
      const pane = focused();
      if (previewApi.mode === 'inspect' && pane && pane.doc && pane.doc.lang === 'css') {
        picked = p.node;
        if (revealRule(p.node)) return;
        const el = elementFor(p.node);
        toast('No rule styles ' + (el ? describeElement(el) : 'that') + ' yet, so here is its markup.');
      }
      picked = null;
      revealNode(p.node);
    },
    onMove: (p) => onMove(p),
    onResize: (p) => onResize(p),
    onReposition: (p) => onReposition(p),
    onRemove: (p) => onRemove(p),
    onMeasure: (p) => onMeasure(p),
    onKey: (p) => { if (MODE_KEYS[p.code]) setMode(MODE_KEYS[p.code]); },
    onNavigate: (p) => followPageLink(String(p.href || '')),
    onBack: () => previewBack(),
    /* Off-site links open in a real tab; the preview is not a browser. */
    onOpen: (p) => {
      if (/^https?:\/\//i.test(String(p.url))) window.open(p.url, '_blank', 'noopener');
    },
    onBeforeReload: () => resetConsole(),
    onReady: () => {}
  });

  function resetConsole() {
    conRows = 0;
    conErrors = 0;
    conLog.replaceChildren();
    updateConsoleCount();
  }

  function addConsole(level, text) {
    if (conRows === 0) conLog.replaceChildren();
    const row = document.createElement('div');
    row.className = 'con-row is-' + (level === 'warn' ? 'warn'
      : level === 'error' ? 'error' : level === 'note' ? 'note' : 'info');
    const time = document.createElement('span');
    time.className = 'con-times';
    time.textContent = new Date().toLocaleTimeString(undefined, { hour12: false });
    const body = document.createElement('span');
    body.textContent = text;
    row.append(time, body);
    conLog.appendChild(row);

    conRows++;
    if (level === 'error') conErrors++;
    while (conLog.children.length > 300) conLog.removeChild(conLog.firstChild);
    conLog.scrollTop = conLog.scrollHeight;
    updateConsoleCount();
  }

  function updateConsoleCount() {
    const count = $('#con-count');
    count.textContent = conErrors ? conErrors + (conErrors === 1 ? ' error' : ' errors')
      : conRows ? conRows + ' message' + (conRows === 1 ? '' : 's') : '';
    count.classList.toggle('has-error', conErrors > 0);
  }

  /** A click in the preview: find the markup that made that element. */
  function revealNode(nodeId) {
    const doc = htmlDoc();
    if (!doc) return;
    const tree = parse.parseHtml(state.builtHtml || doc.text);
    const node = tree.elements[nodeId];
    if (!node) return;

    let pane = state.panes.find((p) => p.doc === doc && !p.el.hidden);
    if (!pane) { pane = focused(); showDoc(pane, doc); }
    pane.editor.setSelection(node.start, node.openEnd, { center: true });
    pane.editor.flashLine(node.start);
    pane.editor.focus();
    state.focused = pane;
  }

  /* -- direct manipulation ---------------------------------------------- */

  /** The element the preview is talking about, in the source it came from. */
  function nodeFor(nodeId) {
    const doc = htmlDoc();
    if (!doc) return null;
    const tree = parse.parseHtml(doc.text);
    const node = tree.elements[nodeId];
    return node ? { doc, tree, node } : null;
  }

  /**
   * Every place a stylesheet lives: the .css documents, and any <style> block
   * inside the page. Each can be read and written without the caller having to
   * care which it is.
   */
  function cssTargets() {
    const out = docsOfLang('css').map((doc) => ({
      name: doc.name,
      text: doc.text,
      write: (next) => patchDoc(doc, next)
    }));

    const html = htmlDoc();
    if (!html) return out;
    const source = html.text;
    for (const node of parse.parseHtml(source).elements) {
      if (node.tag !== 'style' || node.textStart == null) continue;
      const from = node.textStart, to = node.textEnd;
      out.push({
        name: html.name + ' <style>',
        text: source.slice(from, to),
        write: (next) => patchDoc(html, source.slice(0, from) + next + source.slice(to))
      });
    }
    return out;
  }

  const styleTarget = () => $('#style-target').value;

  /**
   * Write declarations for an element, into the rule that already styles it
   * where there is one. Falls back to a new rule, then to an inline style - in
   * that order, because a shared rule is what you would have written by hand
   * and `style=""` is what you would have written last.
   */
  function applyStyle(nodeId, props, label) {
    const found = nodeFor(nodeId);
    if (!found) return;
    const { doc, node } = found;
    const said = (where) => toast(label + '  ->  ' + where, 'good');

    if (styleTarget() === 'inline') {
      patchDoc(doc, edits.setInlineStyle(doc.text, node, props));
      return said('style=""');
    }

    for (const sheet of cssTargets()) {
      const rule = edits.ruleFor(parse.parseCss(sheet.text).rules, node);
      if (!rule) continue;
      sheet.write(edits.setRuleProperties(sheet.text, rule, props));
      return said(rule.selector + '  in ' + sheet.name);
    }

    const selector = edits.newSelectorFor(node);
    const sheet = cssTargets()[0];
    if (selector && sheet) {
      sheet.write(edits.createRule(sheet.text, selector, props).text);
      return said('new rule ' + selector + '  in ' + sheet.name);
    }
    patchDoc(doc, edits.setInlineStyle(doc.text, node, props));
    said('style="" - give it a class to keep your styles together');
  }

  function onResize(p) {
    /* A handle that moved one edge should write one dimension, not both. */
    const props = {};
    if (p.dir !== 'n' && p.dir !== 's') props.width = p.width + 'px';
    if (p.dir !== 'e' && p.dir !== 'w') props.height = p.height + 'px';
    applyStyle(p.node, props, [props.width, props.height].filter(Boolean).join(' x '));
  }

  function onReposition(p) {
    applyStyle(p.node, { left: p.left + 'px', top: p.top + 'px' },
      'left ' + p.left + 'px, top ' + p.top + 'px');
  }

  function onMove(p) {
    const found = nodeFor(p.node);
    if (!found) return;
    const target = found.tree.elements[p.target];
    if (!target) return;
    const next = edits.moveNode(found.doc.text, found.node, target, p.position);
    if (!next) return toast('That element cannot go there.', 'bad');
    patchDoc(found.doc, next);
    previewApi.select(p.node);
    toast('Moved ' + p.position + ' <' + target.tag + '>', 'good');
  }

  function onRemove(p) {
    const found = nodeFor(p.node);
    if (!found) return;
    const cut = edits.cutRange(found.doc.text, found.node);
    patchDoc(found.doc, found.doc.text.slice(0, cut.from) + found.doc.text.slice(cut.to));
    toast('Removed <' + found.node.tag + '>. Ctrl+Z puts it back.', 'good');
  }

  /** Live numbers while a gesture is under way, where the size normally sits. */
  function onMeasure(p) {
    const el = $('#pv-size');
    if (!p) return showViewportSize();
    if (p.drop !== undefined) el.textContent = p.drop || 'nowhere';
    else if (p.width != null) el.textContent = p.width + ' x ' + p.height;
    else if (p.left != null) el.textContent = p.left + ', ' + p.top;
  }

  /* -- the three modes --------------------------------------------------- */

  /* Alt and a digit, by key position, so the layout under it does not matter. */
  const MODE_KEYS = { Digit1: 'off', Digit2: 'inspect', Digit3: 'design' };

  /** @param {'off'|'inspect'|'design'} mode Live, Inspect or Design. */
  function setMode(mode) {
    previewApi.setMode(mode);
    for (const btn of document.querySelectorAll('#pv-mode .seg-btn')) {
      btn.setAttribute('aria-checked', String(btn.dataset.mode === mode));
    }
    $('#style-target').hidden = mode !== 'design';
    inspected = '';
    if (mode === 'inspect') inspectCaret(focused());
    if (mode !== 'off' && !htmlDoc()) toast('There is no HTML document to show.', 'bad');
  }

  for (const btn of document.querySelectorAll('#pv-mode .seg-btn')) {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  }

  /* -- inspect: the caret in the code lights up the page ----------------- */

  /* Elements that are in the markup but never on screen. */
  const UNSEEN = new Set(['html', 'head', 'meta', 'title', 'link', 'script', 'style',
    'base', 'noscript', 'template']);
  let inspectTimer = 0;
  let inspected = '';

  function followCaret(pane) {
    if (previewApi.mode !== 'inspect') return;
    clearTimeout(inspectTimer);
    inspectTimer = setTimeout(() => inspectCaret(pane), 60);
  }

  /**
   * In the page's markup, the element the caret is in. In a stylesheet the
   * page uses - or a <style> block - every element the rule under the caret
   * matches.
   */
  function inspectCaret(pane) {
    if (previewApi.mode !== 'inspect' || !pane || !pane.doc) return;
    const page = htmlDoc();
    const pos = pane.editor.selection.start;
    const ruleIn = (css, at) => {
      const rule = parse.ruleAt(parse.parseCss(css), at);
      return rule ? rule.selector : null;
    };

    let node = null;
    let selector = null;
    if (pane.doc === page) {
      const region = analyze.embeddedRegion(page.text, pos);
      if (region && region.lang === 'css') {
        selector = ruleIn(page.text.slice(region.start, region.end), pos - region.start);
      } else if (!region) {
        const hit = parse.nodeAt(parse.parseHtml(page.text), pos);
        node = hit && !UNSEEN.has(hit.tag) ? hit.id : null;
      }
    } else if (pane.doc.lang === 'css' && sheetsFor(page).some((s) => s.doc === pane.doc && !s.elsewhere)) {
      selector = ruleIn(pane.doc.text, pos);
    }

    /* The element you clicked stays picked out for as long as the caret is
       in a rule that styles it - the rule's other elements are outlined
       around it, rather than instead of it. */
    if (selector != null && picked != null) {
      const el = elementFor(picked);
      if (el && ruleHits(el, selector)) node = picked;
    } else if (selector == null) {
      picked = null;
    }

    const key = node + '|' + selector;
    if (key === inspected) return;
    inspected = key;
    previewApi.select(node);
    previewApi.match(selector);
  }

  /* -- inspect from a stylesheet: a click finds the rule, not the markup -- */

  let picked = null;          // the element last clicked with a stylesheet in front of you
  let cycle = null;           // where that click went, so the next click can go further

  function elementFor(nodeId) {
    try { return frame.contentDocument.querySelector('[data-ws-node="' + nodeId + '"]'); }
    catch (e) { return null; }
  }

  /**
   * Whether a rule styles an element, judged by the page itself rather than
   * by reading the selector: descendant combinators, `:nth-child` and the rest
   * all just work. A rule that only applies in a state - `:hover`, `::before`
   * - still counts, but behind one that applies as things are.
   * @returns {{now: boolean, spec: number[]}|null}
   */
  function ruleHits(el, selector) {
    let best = null;
    for (const part of symbols.splitSelectors(selector)) {
      let now = false;
      let later = false;
      try { now = el.matches(part); } catch (e) { now = false; }
      if (!now) {
        try { later = el.matches(symbols.withoutState(part)); } catch (e) { later = false; }
      }
      if (!now && !later) continue;
      const spec = symbols.specificity(part);
      if (!best || (now && !best.now) ||
          (now === best.now && symbols.compareSpecificity(spec, best.spec) > 0)) best = { now, spec };
    }
    return best;
  }

  /** Is every @media around this rule true for the preview as it is sized now? */
  function mediaApplies(rule) {
    const win = frame.contentWindow;
    for (let at = rule.at; at; at = at.at) {
      const m = /^@media\s+([\s\S]+)$/i.exec(at.selector);
      try { if (m && win && !win.matchMedia(m[1]).matches) return false; } catch (e) { /* a query it cannot read */ }
    }
    return true;
  }

  /**
   * Every rule the page uses that styles an element, the one you most likely
   * mean first: one in the file you are in, applying now, at this width, and
   * winning the cascade. A bare `*` comes last, wherever it lives.
   */
  function rulesStyling(nodeId, here) {
    const el = elementFor(nodeId);
    if (!el) return [];
    const out = [];
    let order = 0;
    for (const sheet of sheetsFor(htmlDoc())) {
      if (sheet.elsewhere) continue;
      for (const rule of parse.parseCss(sheet.text).rules) {
        order++;
        if (rule.kind !== 'rule' || !rule.selector) continue;
        const hit = ruleHits(el, rule.selector);
        if (!hit) continue;
        out.push({
          sheet, rule, hit, order,
          weak: hit.spec[0] + hit.spec[1] + hit.spec[2] === 0,
          here: sheet.doc === here,
          media: mediaApplies(rule)
        });
      }
    }
    const rank = (a, b) => (a.weak - b.weak) || (b.here - a.here) || (b.hit.now - a.hit.now) ||
      (b.media - a.media) || symbols.compareSpecificity(b.hit.spec, a.hit.spec) || (b.order - a.order);
    return out.sort(rank);
  }

  const describeElement = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).join('.') : '');

  /**
   * Go to the rule that styles a clicked element. Clicking the same element
   * again, with the caret still where the last click put it, goes on to the
   * next rule that styles it.
   * @returns {boolean} false when nothing in the page's stylesheets does
   */
  function revealRule(nodeId) {
    const pane = focused();
    const again = cycle && cycle.node === nodeId && pane && pane.doc === cycle.doc &&
      pane.editor.selection.start === cycle.start;
    const list = again ? cycle.list : rulesStyling(nodeId, pane && pane.doc);
    if (!list.length) return false;

    const index = again ? (cycle.index + 1) % list.length : 0;
    const hit = list[index];
    const start = hit.sheet.offset + hit.rule.selectorStart;
    openAt(hit.sheet.doc, start, start + hit.rule.selector.length);
    cycle = { node: nodeId, list, index, doc: hit.sheet.doc, start };

    const el = elementFor(nodeId);
    const notes = [];
    if (!hit.media) notes.push('not at this width');
    else if (!hit.hit.now) notes.push('only in a state like :hover');
    if (list.length > 1) notes.push((index + 1) + ' of ' + list.length + ', click again for the next');
    toast((el ? describeElement(el) : 'element') + '  →  ' + hit.rule.selector.replace(/\s+/g, ' ') +
      (notes.length ? '    (' + notes.join('; ') + ')' : ''));
    return true;
  }

  /* -- viewport controls ------------------------------------------------- */

  const viewportSelect = $('#viewport');
  for (const view of pv.VIEWPORTS) {
    const option = document.createElement('option');
    option.value = view.id;
    option.textContent = view.width ? `${view.label} — ${view.width}×${view.height}` : view.label;
    viewportSelect.appendChild(option);
  }

  function showViewportSize() {
    const box = previewApi.layout();
    const view = previewApi.viewport;
    $('#pv-size').textContent = view.width
      ? `${box.width}×${box.height}  ${Math.round(box.scale * 100)}%`
      : '';
    $('#btn-rotate').disabled = !view.width;
  }

  viewportSelect.addEventListener('change', () => {
    previewApi.setViewport(viewportSelect.value);
    showViewportSize();
  });
  $('#zoom').addEventListener('change', () => { previewApi.setZoom($('#zoom').value); showViewportSize(); });
  $('#btn-rotate').addEventListener('click', (e) => {
    e.currentTarget.setAttribute('aria-pressed', String(previewApi.rotate()));
    showViewportSize();
  });
  $('#btn-reload').addEventListener('click', () => schedulePreview(true));
  $('#btn-clear-con').addEventListener('click', resetConsole);
  window.addEventListener('resize', showViewportSize);

  /* ── files ───────────────────────────────────────────────────────────── */

  let toastTimer = 0;

  function toast(message, tone) {
    const el = $('#toast');
    el.textContent = message;
    el.className = 'toast' + (tone ? ' is-' + tone : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, tone === 'bad' ? 5200 : 2400);
  }

  function updateSaveState() {
    const count = state.docs.filter((d) => d.dirty).length;
    $('#dirty-dot').hidden = !count;
    const named = state.docs.filter((d) => d.path || d.handle).length;
    $('#save-note').textContent = count
      ? count + (count === 1 ? ' unsaved file' : ' unsaved files')
      : state.folder ? state.folder.name
      : named ? named + (named === 1 ? ' file on disk' : ' files on disk')
      : 'Not saved yet';
  }

  async function saveAll() {
    const dirty = state.docs.filter((d) => d.dirty);
    if (!dirty.length) { toast('Nothing to save.'); return; }
    let saved = 0;
    for (const doc of dirty) {
      try {
        await files.save(doc);
        doc.dirty = false;
        saved++;
      } catch (e) {
        if (e && e.name === 'AbortError') break;
        toast('Could not save ' + doc.name + ': ' + (e.message || e), 'bad');
      }
    }
    renderTabs();
    if (saved) toast(saved === 1 ? 'Saved ' + dirty[0].name : 'Saved ' + saved + ' files', 'good');
  }

  async function saveCurrentAs() {
    const pane = focused();
    if (!pane || !pane.doc) return;
    try {
      await files.saveAs(pane.doc);
      pane.doc.dirty = false;
      renderTabs();
      toast('Saved as ' + pane.doc.name, 'good');
    } catch (e) {
      if (e && e.name !== 'AbortError') toast(String(e.message || e), 'bad');
    }
  }

  /**
   * The starter is scaffolding, not work. Opening a real page should replace
   * it outright, or its stylesheet would go on decorating the page you just
   * loaded. Anything you have touched or saved stays.
   */
  function dropStarterIfUntouched(incoming) {
    if (!incoming.some((file) => (file.lang || files.langOf(file.name)) === 'html')) return;
    const starterNames = new Set(root.WS.starter.docs().map((d) => d.name));
    state.docs = state.docs.filter((doc) =>
      doc.dirty || doc.path || doc.handle || !starterNames.has(doc.relPath));
    if (!state.docs.length) state.docs = root.WS.starter.docs().map(makeDoc).slice(0, 1);
  }

  /**
   * Put a loaded file into the project, replacing the one it is.
   *
   * Identity is the path where there is one: two folders can each hold an
   * `index.html`, and matching on the bare name would have the second quietly
   * overwrite the first.
   */
  function adoptFile(file) {
    const relPath = file.relPath || file.name;
    const existing = state.docs.find((d) =>
      (file.path && d.path === file.path) || d.relPath === relPath);

    if (existing) {
      existing.text = file.text;
      existing.handle = file.handle || existing.handle;
      existing.path = file.path || existing.path;
      existing.dirty = false;
      return existing;
    }
    const doc = makeDoc(file);
    doc.handle = file.handle || null;
    doc.path = file.path || null;
    state.docs.push(doc);
    return doc;
  }

  async function openFiles() {
    try {
      const picked = await files.pickFiles();
      if (!picked.length) return;
      dropStarterIfUntouched(picked);
      let first = null;
      for (const file of picked) {
        const doc = adoptFile(file);
        if (!first) first = doc;
      }
      ensurePaneDocs();
      showDoc(focused(), first);
      renderPreviewRoot();
      renderTabs();
      renderTree();
      schedulePreview(true);
      toast('Opened ' + picked.map((f) => f.name).join(', '), 'good');
    } catch (e) {
      if (e && e.name !== 'AbortError') toast(String(e.message || e), 'bad');
    }
  }

  async function openFolder() {
    try {
      await adoptFolder(await files.pickFolder());
    } catch (e) {
      if (e && e.name !== 'AbortError') toast(String(e.message || e), 'bad');
    }
  }

  /** Re-read the folder from disk, keeping anything you have not saved. */
  async function reopenFolder() {
    if (!state.folder || !state.folder.handle) return;
    const dirty = state.docs.filter((d) => d.dirty).map((d) => d.relPath);
    if (dirty.length && !confirm(
      'Re-reading the folder will discard unsaved changes in ' +
      dirty.join(', ') + '.\n\nGo ahead?')) return;
    try {
      await adoptFolder(await files.refreshFolder(state.folder.handle));
    } catch (e) {
      toast(String(e.message || e), 'bad');
    }
  }

  /**
   * Load a whole folder: every page, stylesheet and script in it and below it.
   *
   * All of them become documents - saveable, searchable, and reachable by a
   * `<link>` in any page. Only the page the preview lands on gets a tab, so a
   * project with two hundred files does not arrive as two hundred tabs.
   */
  async function adoptFolder(folder) {
    const { files: found, dirHandle, name, skipped, truncated } = folder;

    state.docs = found.map((file) => makeDoc(Object.assign({ shown: false }, file)));
    state.folder = { name, handle: dirHandle };
    state.previewRoot = null;
    state.collapsed = new Set();

    const page = htmlDoc();
    const landing = page || state.docs[0];
    const beside = page
      ? [resolveFromPage(page, /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi, 'css'),
         resolveFromPage(page, /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi, 'js')]
        .filter(Boolean)
      : [];

    /* The page first, then what it pulls in - the same order you would have
       opened them in yourself. */
    for (const doc of [landing, ...beside]) if (doc) openTab(doc);

    state.panes.forEach((pane, i) => {
      const open = shownDocs();
      showDoc(pane, open[Math.min(i, open.length - 1)] || landing);
    });

    ensurePaneDocs();
    renderPreviewRoot();
    renderTabs();
    showRail('files');
    renderOutline();
    schedulePreview(true);
    updateSaveState();

    const notes = [];
    if (truncated) notes.push('stopped at 500');
    if (skipped) notes.push(skipped + ' too large or unreadable');
    toast('Opened ' + name + ' \u2014 ' + found.length + ' files' +
      (notes.length ? ' (' + notes.join(', ') + ')' : ''), 'good');
  }

  /** The first local file a page references with the given tag pattern. */
  function resolveFromPage(page, pattern, lang) {
    pattern.lastIndex = 0;
    const list = state.docs.map((d) => ({ path: d.relPath, name: d.name, lang: d.lang, doc: d }));
    let m;
    while ((m = pattern.exec(page.text))) {
      const found = pv.resolveRef(list, dirOf(page.relPath), m[1]);
      if (found && found.doc.lang === lang) return found.doc;
    }
    return null;
  }

  function exportPage() {
    const html = pv.build(snapshot(), { ids: false });
    const name = (htmlDoc() || { name: 'page.html' }).name;
    files.download(name.replace(/\.html?$/i, '') + '.export.html', html, 'text/html;charset=utf-8');
    toast('Exported one self-contained file', 'good');
  }

  function newProject() {
    if (anyDirty() && !confirm('Start again? Unsaved changes will be lost.')) return;
    files.clearDraft();
    state.docs = root.WS.starter.docs().map(makeDoc);
    state.folder = null;
    state.previewRoot = null;
    state.collapsed = new Set();
    state.panes.forEach((pane, i) => showDoc(pane, state.docs[Math.min(i + (i ? 1 : 0), state.docs.length - 1)]));
    renderPreviewRoot();
    renderTabs();
    renderTree();
    schedulePreview(true);
  }

  $('#btn-open').addEventListener('click', openFiles);
  $('#btn-folder').addEventListener('click', openFolder);
  $('#btn-save').addEventListener('click', saveAll);
  $('#btn-saveas').addEventListener('click', saveCurrentAs);
  $('#btn-export').addEventListener('click', exportPage);
  $('#btn-new').addEventListener('click', newProject);
  $('#btn-help').addEventListener('click', () => $('#help-dialog').showModal());

  /* ── theme ───────────────────────────────────────────────────────────── */

  /* themes.js has already put the saved one on <html>; this only offers the
     rest. The menu is a grid, one column per tone, and the arrow keys move
     through it the way it looks: up and down a column, left and right
     across the row. */
  const themeButton = $('#btn-theme');
  const themeMenu = $('#theme-menu');
  const themeColumns = [];

  /* The sample carries the theme's data-theme, so themes.css paints it and
     no colour is written down twice. The item itself keeps its id in
     data-theme-id instead - data-theme on it would recolour the row. */
  function themeSample(id) {
    const sample = document.createElement('span');
    sample.className = 'sample';
    sample.dataset.theme = id;
    sample.setAttribute('aria-hidden', 'true');
    sample.innerHTML = '<span class="line"></span><span class="line short"></span><span class="dot"></span>';
    return sample;
  }

  themes.TONES.forEach((tone, column) => {
    const head = document.createElement('div');
    head.className = 'menu-tone';
    head.setAttribute('role', 'presentation');
    head.style.setProperty('--column', column + 1);
    head.textContent = tone.label;
    themeMenu.appendChild(head);

    const items = themes.THEMES.filter((each) => each.tone === tone.id).map((each, row) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'menu-item';
      item.setAttribute('role', 'menuitemradio');
      item.tabIndex = -1;
      item.dataset.themeId = each.id;
      item.style.setProperty('--column', column + 1);
      item.style.setProperty('--row', row + 2);

      const label = document.createElement('span');
      label.className = 'item';
      label.append(themeSample(each.id), each.label);
      item.appendChild(label);
      themeMenu.appendChild(item);
      return item;
    });
    themeColumns.push(items);
  });

  const themeItems = () => themeColumns.flat();

  function showTheme() {
    const id = themes.current();
    for (const item of themeItems()) item.setAttribute('aria-checked', String(item.dataset.themeId === id));
  }

  function openThemeMenu() {
    themeMenu.hidden = false;
    themeButton.setAttribute('aria-expanded', 'true');
    const items = themeItems();
    (items.find((item) => item.getAttribute('aria-checked') === 'true') || items[0]).focus();
  }

  function closeThemeMenu(refocus) {
    if (themeMenu.hidden) return;
    themeMenu.hidden = true;
    themeButton.setAttribute('aria-expanded', 'false');
    if (refocus) themeButton.focus();
  }

  themeButton.addEventListener('click', () => {
    if (themeMenu.hidden) openThemeMenu(); else closeThemeMenu(true);
  });

  themeButton.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && themeMenu.hidden) { e.preventDefault(); openThemeMenu(); }
  });

  themeMenu.addEventListener('click', (e) => {
    const item = e.target.closest('[role="menuitemradio"]');
    if (!item) return;
    themes.choose(item.dataset.themeId);
    showTheme();
    closeThemeMenu(true);
  });

  themeMenu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeThemeMenu(true); return; }
    const column = themeColumns.findIndex((items) => items.includes(document.activeElement));
    if (column < 0) return;
    const items = themeColumns[column];
    const row = items.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown') next = items[(row + 1) % items.length];
    if (e.key === 'ArrowUp') next = items[(row - 1 + items.length) % items.length];
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const step = e.key === 'ArrowRight' ? 1 : themeColumns.length - 1;
      const across = themeColumns[(column + step) % themeColumns.length];
      next = across[Math.min(row, across.length - 1)];
    }
    if (e.key === 'Home') next = items[0];
    if (e.key === 'End') next = items[items.length - 1];
    if (next) { e.preventDefault(); next.focus(); }
  });

  /* Tab, a click anywhere else, or a click into the preview all take focus
     out of the menu, and that is what closes it. */
  themeMenu.addEventListener('focusout', (e) => {
    if (!themeMenu.contains(e.relatedTarget) && e.relatedTarget !== themeButton) closeThemeMenu(false);
  });

  showTheme();

  /* ── layout ──────────────────────────────────────────────────────────── */

  function setSplit(on) {
    state.split = on;
    const paneB = state.panes[1];
    paneB.el.hidden = !on;
    $('#pane-split').hidden = !on;
    $('#btn-split').setAttribute('aria-pressed', String(on));
    if (on) {
      const keep = state.docs.includes(paneB.doc) && paneB.doc !== state.panes[0].doc;
      showDoc(paneB, keep ? paneB.doc : state.docs.find((d) => d !== state.panes[0].doc));
      paneB.editor.refresh();
    }
  }

  $('#btn-split').addEventListener('click', () => setSplit(!state.split));

  $('#btn-sidebar').addEventListener('click', (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', String(on));
    $('#side').hidden = !on;
  });

  /** Pointer-driven resizing for the two adjustable edges. */
  function draggable(handle, apply) {
    let active = false;
    handle.addEventListener('pointerdown', (e) => {
      active = true;
      handle.setPointerCapture(e.pointerId);
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => { if (active) apply(e); });
    const stop = (e) => {
      if (!active) return;
      active = false;
      document.body.style.userSelect = '';
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      showViewportSize();
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  draggable($('#drag-main'), (e) => {
    const shell = $('#split-main').getBoundingClientRect();
    const ratio = (e.clientX - shell.left) / shell.width;
    const clamped = Math.max(0.2, Math.min(0.85, ratio));
    $('#editors').style.flex = `1 1 ${clamped * 100}%`;
    $('.preview').style.flex = `1 1 ${(1 - clamped) * 100}%`;
  });

  draggable($('#drag-console'), (e) => {
    const box = $('.preview').getBoundingClientRect();
    const height = Math.max(26, Math.min(box.height - 120, box.bottom - e.clientY));
    $('#console-panel').style.height = height + 'px';
  });

  /* Keyboard, for the same two edges. */
  $('#drag-console').addEventListener('keydown', (e) => {
    const panel = $('#console-panel');
    const current = panel.getBoundingClientRect().height;
    if (e.key === 'ArrowUp') { panel.style.height = (current + 24) + 'px'; e.preventDefault(); }
    if (e.key === 'ArrowDown') { panel.style.height = Math.max(26, current - 24) + 'px'; e.preventDefault(); }
  });

  /* ── global keys ─────────────────────────────────────────────────────── */

  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      if (MODE_KEYS[e.code]) { e.preventDefault(); setMode(MODE_KEYS[e.code]); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); goBack(); return; }
    }

    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;

    if (e.key === 's') {
      e.preventDefault();
      if (e.shiftKey) saveCurrentAs(); else saveAll();
      return;
    }
    if (e.key === 'o') { e.preventDefault(); openFiles(); return; }
    if (e.key === 'b') {
      e.preventDefault();
      $('#btn-sidebar').click();
      return;
    }
    if (e.key === '\\') { e.preventDefault(); setSplit(!state.split); return; }
    /* Ctrl+D is the editor's - add the next match. Anywhere else it would
       only offer to bookmark the app. */
    if (e.key === 'd' || e.key === 'D') { e.preventDefault(); return; }
    if (e.key === 'Enter') { e.preventDefault(); schedulePreview(true); return; }
    if (e.key === 'E' && e.shiftKey) {
      e.preventDefault();
      $('#side').hidden = false;
      $('#btn-sidebar').setAttribute('aria-pressed', 'true');
      showRail('files');
      $('#side-filter').focus();
      return;
    }
    if (e.key >= '1' && e.key <= '9') {
      const doc = shownDocs()[Number(e.key) - 1];
      if (!doc) return;
      e.preventDefault();
      const pane = focused();
      showDoc(pane, doc);
      pane.editor.focus();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    files.saveDraft({
      docs: state.docs,
      folder: state.folder ? { name: state.folder.name } : null,
      active: 0
    });
    if (!anyDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  /* ── starting up ─────────────────────────────────────────────────────── */

  function seed(docs) {
    state.docs = docs;
    showDoc(state.panes[0], state.docs[0]);
    if (state.panes[1]) state.panes[1].doc = state.docs[1] || state.docs[0];
    renderPreviewRoot();
    renderTabs();
    renderTree();
    renderOutline();
    schedulePreview(true);
    updateSaveState();
  }

  async function collectFromServer(announce) {
    if (!files.served) return false;
    let paths = [];
    try { paths = await files.collectOpened(); } catch (e) { return false; }
    if (!paths.length) return false;

    let opened = 0;
    let firstDoc = null;
    for (const path of paths) {
      let project;
      try {
        project = await files.loadProject(path);
      } catch (e) {
        toast('Could not open ' + path, 'bad');
        continue;
      }
      const arrived = ['html', 'css', 'js']
        .map((lang) => (project[lang] ? Object.assign({ lang }, project[lang]) : null))
        .filter(Boolean);
      dropStarterIfUntouched(arrived);
      for (const file of arrived) {
        const doc = adoptFile(file);
        if (!firstDoc || file.lang === 'html') firstDoc = file.lang === 'html' ? doc : firstDoc || doc;
      }
      opened++;
    }
    ensurePaneDocs();
    if (!opened) return false;
    if (firstDoc) showDoc(state.panes[0], firstDoc);
    renderPreviewRoot();
    renderTabs();
    renderTree();
    renderOutline();
    schedulePreview(true);
    if (announce) toast('Opened ' + opened + (opened === 1 ? ' file' : ' files'), 'good');
    return true;
  }

  async function start() {
    state.panes = [...document.querySelectorAll('.pane')].map(makePane);
    state.focused = state.panes[0];
    viewportSelect.value = 'fill';

    /* A file the launcher handed us wins; then a draft; then the starter. */
    const starter = root.WS.starter.docs().map(makeDoc);
    seed(starter);

    const fromServer = await collectFromServer(false);
    if (!fromServer) {
      const draft = files.readDraft();
      if (draft && draft.docs && draft.docs.length) {
        state.docs = draft.docs.map(makeDoc);
        for (const doc of state.docs) doc.dirty = !!doc.dirty;
        showDoc(state.panes[0], state.docs[draft.active] || state.docs[0]);
        renderPreviewRoot();
        renderTabs();
        renderTree();
        renderOutline();
        schedulePreview(true);
        /* A folder cannot be reopened for you - the handle does not survive a
           reload - so say what came back rather than implying the rest did. */
        toast(draft.folder
          ? 'Restored your unsaved changes. Open ' + draft.folder.name + ' again for the rest.'
          : 'Picked up where you left off');
      }
    }

    showRail('files');
    showViewportSize();
    state.panes[0].editor.focus();

    /* Opening a second file usually just focuses this window, so the queue has
       to be checked again whenever the window comes back to the front. */
    if (files.served) {
      window.addEventListener('focus', () => collectFromServer(true));
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) collectFromServer(true);
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  /* A handle for poking at the state from the console while developing. */
  root.__ws = { state, snapshot, previewApi, providers, setMode };
})(window);
