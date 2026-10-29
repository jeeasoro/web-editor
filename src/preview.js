/* ============================================================================
   preview.js — the running page.

   The three documents are assembled into one HTML string and handed to an
   iframe through `srcdoc`. Two things are added on the way in:

     • the runtime from runtime.js at the very top, which forwards console
       output and errors back to the app and draws the selection, drag and
       resize overlays;
     • a `data-ws-node` attribute on every element, so a click or a drag in
       the preview names an element the app can find in the source.

   A `<link>` or `<script src>` pointing at one of your own files is replaced
   in place by that file's contents rather than left to 404. The reference is
   followed properly — relative to the folder the page sits in — so a project
   with `about.html` pulling in `../css/site.css` previews as the page it
   actually is, and the files on disk go on referencing each other normally.
   ========================================================================== */
(function (root) {
  'use strict';

  const RUNTIME = () => root.WS.runtime;

  /* ── assembling the document ─────────────────────────────────────────── */

  const LINK_TAG = /<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*>/gi;
  const SCRIPT_TAG = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script\s*>/gi;
  const EXTERNAL = /^(https?:)?\/\/|^data:|^blob:/i;

  /* ── resolving one file's reference to another ───────────────────────── */

  const dirOf = (path) => {
    const at = String(path || '').lastIndexOf('/');
    return at < 0 ? '' : path.slice(0, at);
  };

  const baseName = (path) => String(path || '').split('/').pop();

  /** Fold `.` and `..` out of a path, the way a browser would. */
  function normalisePath(path) {
    const out = [];
    for (const part of String(path).split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { out.pop(); continue; }
      out.push(part);
    }
    return out.join('/');
  }

  /**
   * Find the open document a `href` or `src` points at.
   *
   * Tried in order: the reference resolved against the referring file's own
   * folder, then the reference as written from the project root, then the file
   * name alone. The last one is what makes a loose handful of files — no
   * folder, no paths — behave the way you would expect.
   *
   * @param {object[]} files `{path, name, lang, text}`
   * @param {string} base the folder the referring document sits in
   * @returns {object|null}
   */
  function resolveRef(files, base, ref) {
    if (!files || !files.length || !ref) return null;
    const clean = String(ref).split(/[?#]/)[0].trim();
    if (!clean || EXTERNAL.test(clean)) return null;

    const rooted = clean.replace(/^\/+/, '');
    const wanted = [normalisePath(base ? base + '/' + clean : clean), normalisePath(rooted)];
    for (const want of wanted) {
      const hit = files.find((f) => f.path === want);
      if (hit) return hit;
    }
    const leaf = baseName(rooted);
    return files.find((f) => f.name === leaf) || null;
  }

  /**
   * @param {{html: string, base?: string, files?: object[], css?: string, js?: string}} docs
   *   `files` and `base` let a reference be followed to the right file in a
   *   folder; `css`/`js` are the fallback for a page that references nothing.
   * @param {{ids?: boolean}} [opts] `ids: false` skips the data-ws-node pass,
   *   which is what you want when exporting rather than previewing.
   * @returns {string} a complete HTML document
   */
  function build(docs, opts) {
    opts = opts || {};
    let html = opts.ids === false ? docs.html : tagNodes(docs.html);

    const files = docs.files || [];
    const base = docs.base || '';
    const used = new Set();

    const styleFor = (text) => text && text.trim() ? '<style>\n' + text + '\n</style>' : '';
    const scriptFor = (text) => text && text.trim() ? '<script>\n' + text + '\n<\/script>' : '';

    /* Follow each local stylesheet link to the file it names. */
    let linkedAny = false;
    html = html.replace(LINK_TAG, (tag) => {
      const href = (/\bhref\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1] || '';
      if (EXTERNAL.test(href)) return tag;
      linkedAny = true;
      const found = resolveRef(files, base, href);
      if (!found) return '';                 // referenced but not open: nothing to inline
      used.add(found);
      return styleFor(found.text);
    });

    let scriptedAny = false;
    html = html.replace(SCRIPT_TAG, (tag, src) => {
      if (EXTERNAL.test(src)) return tag;
      scriptedAny = true;
      const found = resolveRef(files, base, src);
      if (!found) return '';
      used.add(found);
      /* A module keeps its type, or `import` in the file would stop working. */
      const isModule = /\btype\s*=\s*["']?module["']?/i.test(tag);
      return isModule
        ? '<script type="module">\n' + found.text + '\n<\/script>'
        : scriptFor(found.text);
    });

    /* A page that links to nothing still wants its stylesheet — that is the
       single-page case, and leaving it unstyled would be pedantry. */
    if (!linkedAny) {
      const block = styleFor(docs.css || '');
      if (block) html = insertBefore(html, /<\/head\s*>/i, block) || prepend(html, block);
    }
    if (!scriptedAny) {
      const block = scriptFor(docs.js || '');
      if (block) html = insertBefore(html, /<\/body\s*>/i, block) || (html + '\n' + block);
    }

    const runtime = '<script>' + RUNTIME() + '<\/script>';
    return insertAfterDoctype(html, runtime);
  }

  function insertBefore(html, pattern, block) {
    const m = pattern.exec(html);
    if (!m) return null;
    return html.slice(0, m.index) + block + '\n' + html.slice(m.index);
  }

  function prepend(html, block) {
    const head = /<head\b[^>]*>/i.exec(html);
    if (head) {
      const at = head.index + head[0].length;
      return html.slice(0, at) + '\n' + block + html.slice(at);
    }
    return block + '\n' + html;
  }

  /** The runtime has to run before anything the page does, but after doctype. */
  function insertAfterDoctype(html, block) {
    const doctype = /<!doctype[^>]*>/i.exec(html);
    const head = /<head\b[^>]*>/i.exec(html);
    if (head) {
      const at = head.index + head[0].length;
      return html.slice(0, at) + block + html.slice(at);
    }
    if (doctype) {
      const at = doctype.index + doctype[0].length;
      return html.slice(0, at) + block + html.slice(at);
    }
    return block + html;
  }

  /** Add `data-ws-node="n"` to every open tag, keeping the source order. */
  function tagNodes(html) {
    let tree;
    try { tree = root.WS.parse.parseHtml(html); } catch (e) { return html; }
    const edits = tree.elements
      .filter((node) => node.openEnd > node.start)
      .map((node) => ({ at: node.openEnd - (node.selfClosing ? 2 : 1), text: ` data-ws-node="${node.id}"` }))
      .sort((a, b) => b.at - a.at);          // back to front, so offsets hold

    let out = html;
    for (const edit of edits) out = out.slice(0, edit.at) + edit.text + out.slice(edit.at);
    return out;
  }

  /* ── viewports ───────────────────────────────────────────────────────── */

  const VIEWPORTS = [
    { id: 'fill', label: 'Fill', width: 0, height: 0 },
    { id: 'phone', label: 'Phone', width: 390, height: 844 },
    { id: 'phone-sm', label: 'Phone (small)', width: 360, height: 640 },
    { id: 'tablet', label: 'Tablet', width: 768, height: 1024 },
    { id: 'laptop', label: 'Laptop', width: 1280, height: 800 },
    { id: 'desktop', label: 'Desktop', width: 1920, height: 1080 }
  ];

  /**
   * @param {HTMLIFrameElement} frame
   * @param {{onConsole: function, onPick: function, onReady: function}} hooks
   */
  function Preview(frame, hooks) {
    const stage = frame.parentElement;
    let viewport = VIEWPORTS[0];
    let zoom = 'fit';
    let rotated = false;
    let mode = 'off';
    let pendingReload = 0;
    let restoreSelection = null;
    let restoreMatch = null;
    let pendingHash = null;

    /* The gestures the runtime reports, and the hook each one answers to. */
    const GESTURES = {
      pick: 'onPick', move: 'onMove', resize: 'onResize',
      reposition: 'onReposition', remove: 'onRemove', measure: 'onMeasure',
      key: 'onKey', navigate: 'onNavigate', open: 'onOpen', back: 'onBack'
    };

    window.addEventListener('message', (e) => {
      const data = e.data;
      if (!data || data.ws !== true || e.source !== frame.contentWindow) return;

      if (data.kind === 'console') return hooks.onConsole && hooks.onConsole(data.payload);
      if (data.kind === 'ready') {
        /* A reload throws the overlay away, so the mode and the selection have
           to be put back or the page you were editing comes back inert. */
        post({ kind: 'mode', mode });
        if (restoreSelection != null) post({ kind: 'select', node: restoreSelection });
        if (restoreMatch) post({ kind: 'match', selector: restoreMatch });
        if (pendingHash) { post({ kind: 'hash', id: pendingHash }); pendingHash = null; }
        return hooks.onReady && hooks.onReady(data.payload);
      }
      const hook = GESTURES[data.kind];
      if (hook && hooks[hook]) hooks[hook](data.payload);
    });

    function post(message) {
      if (!frame.contentWindow) return;
      try { frame.contentWindow.postMessage(Object.assign({ wsHost: true }, message), '*'); }
      catch (e) { /* the frame is mid-reload */ }
    }

    /** Rebuild and reload. Debounced, because it runs on every keystroke. */
    function update(docs, delay) {
      clearTimeout(pendingReload);
      pendingReload = setTimeout(() => {
        if (hooks.onBeforeReload) hooks.onBeforeReload();
        frame.srcdoc = build(docs);
      }, delay == null ? 220 : delay);
    }

    function setViewport(id) {
      viewport = VIEWPORTS.find((v) => v.id === id) || VIEWPORTS[0];
      layout();
      return viewport;
    }

    function setZoom(next) { zoom = next; layout(); }
    function rotate() { rotated = !rotated; layout(); return rotated; }
    /**
     * @param {'off'|'inspect'|'design'} next 'off' is the page left alone;
     *   'inspect' only points at things; 'design' also moves them.
     */
    function setMode(next) {
      mode = next;
      stage.classList.toggle('is-inspect', next === 'inspect');
      stage.classList.toggle('is-design', next === 'design');
      if (next === 'off') restoreSelection = null;
      if (next !== 'inspect') restoreMatch = null;
      post({ kind: 'mode', mode: next });
    }

    function select(nodeId) {
      restoreSelection = nodeId;
      post({ kind: 'select', node: nodeId });
    }

    /** Outline every element a selector matches; null clears them. */
    function match(selector) {
      restoreMatch = selector || null;
      post({ kind: 'match', selector: restoreMatch });
    }

    function flash(nodeId) { post({ kind: 'flash', node: nodeId }); }

    /**
     * Scroll to `#id` in the page - now, or, with `afterReload`, in the page
     * that is about to replace this one.
     */
    function scrollToHash(id, afterReload) {
      if (!id) return;
      if (afterReload) pendingHash = id;
      else post({ kind: 'hash', id });
    }

    /** Size the frame at its true resolution, then scale it to fit the stage. */
    function layout() {
      const box = stage.getBoundingClientRect();
      if (!viewport.width) {
        frame.style.width = '100%';
        frame.style.height = '100%';
        frame.style.transform = '';
        stage.classList.remove('is-device');
        return { scale: 1 };
      }
      stage.classList.add('is-device');
      const w = rotated ? viewport.height : viewport.width;
      const h = rotated ? viewport.width : viewport.height;
      frame.style.width = w + 'px';
      frame.style.height = h + 'px';

      const pad = 32;
      const fit = Math.min((box.width - pad) / w, (box.height - pad) / h, 1);
      const scale = zoom === 'fit' ? fit : Number(zoom);
      frame.style.transform = `scale(${scale})`;
      return { scale, width: w, height: h };
    }

    let resizeFrame = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(layout);
    }).observe(stage);

    return {
      update,
      setViewport,
      setZoom,
      rotate,
      setMode,
      select,
      match,
      flash,
      scrollToHash,
      layout,
      reload: (docs) => update(docs, 0),
      get viewport() { return viewport; },
      get rotated() { return rotated; },
      get mode() { return mode; },
      get selected() { return restoreSelection; }
    };
  }

  root.WS.preview = { Preview, build, tagNodes, VIEWPORTS, resolveRef, dirOf, normalisePath };
})(window);
