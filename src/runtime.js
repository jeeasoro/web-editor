/* ============================================================================
   runtime.js — the code that gets injected into the preview.

   It is kept as a string rather than a file because the preview is built with
   `srcdoc`: there is no URL for the page to fetch a script from. Written in
   plain ES5-ish JavaScript with no build step, since it runs inside whatever
   document you are authoring, not inside the app.

   It does three jobs:

     • forwards console output and errors to the app;
     • draws the selection, hover, match and drop indicators, because only
       the document itself knows where its own boxes are once your CSS has
       had its say;
     • reports gestures — pick, move, resize, reposition, delete — and leaves
       the app to decide what they mean for the source.

   Three modes: 'off' leaves the page alone, 'inspect' turns a click into
   "show me the markup" and nothing more, 'design' adds dragging, resizing
   and deleting on top of that.

   It deliberately does not edit your markup. Everything it changes visually
   during a drag is a temporary inline style that is thrown away when the
   preview reloads from the real source a moment later.
   ========================================================================== */
(function (root) {
  'use strict';

  const RUNTIME = String.raw`
(function () {
  var HOST = '*';
  var send = function (kind, payload) {
    try { parent.postMessage({ ws: true, kind: kind, payload: payload }, HOST); } catch (e) {}
  };

  /* ---- console ---------------------------------------------------------- */

  var show = function (value, seen) {
    seen = seen || [];
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    var type = typeof value;
    if (type === 'string') return value;
    if (type === 'number' || type === 'boolean') return String(value);
    if (type === 'function') return value.name ? 'function ' + value.name + '()' : 'function ()';
    if (type === 'symbol' || type === 'bigint') return String(value);
    if (value instanceof Error) return value.name + ': ' + value.message;
    if (typeof Element !== 'undefined' && value instanceof Element) return describe(value);
    if (seen.indexOf(value) >= 0) return '[circular]';
    seen = seen.concat([value]);
    if (Array.isArray(value)) {
      if (value.length > 40) return '[' + value.length + ' items]';
      return '[' + value.map(function (v) { return show(v, seen); }).join(', ') + ']';
    }
    try {
      var keys = Object.keys(value);
      if (!keys.length) return '{}';
      if (keys.length > 24) return '{' + keys.length + ' keys}';
      return '{ ' + keys.map(function (k) { return k + ': ' + show(value[k], seen); }).join(', ') + ' }';
    } catch (e) { return String(value); }
  };

  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      var args = [].slice.call(arguments);
      send('console', { level: level, text: args.map(function (a) { return show(a); }).join(' ') });
      if (original) original.apply(console, args);
    };
  });
  window.addEventListener('error', function (e) {
    send('console', { level: 'error', text: e.message + (e.lineno ? '  (line ' + e.lineno + ')' : '') });
  });
  window.addEventListener('unhandledrejection', function (e) {
    send('console', { level: 'error', text: 'Uncaught (in promise) ' + show(e.reason) });
  });

  /* ---- what the app can point at ---------------------------------------- */

  var ATTR = 'data-ws-node';
  var idOf = function (el) { return el && el.hasAttribute(ATTR) ? Number(el.getAttribute(ATTR)) : null; };

  var nodeAt = function (el) {
    while (el && el.nodeType === 1 && !el.hasAttribute(ATTR)) el = el.parentElement;
    return el && el.nodeType === 1 ? el : null;
  };

  var byId = function (id) { return document.querySelector('[' + ATTR + '="' + id + '"]'); };

  function describe(el) {
    var out = el.tagName.toLowerCase();
    if (el.id) out += '#' + el.id;
    if (el.className && typeof el.className === 'string') {
      out += '.' + el.className.trim().split(/\s+/).join('.');
    }
    return out;
  }

  /* Elements you should not be able to drag away or resize. */
  var STRUCTURAL = { HTML: 1, HEAD: 1, BODY: 1, SCRIPT: 1, STYLE: 1, META: 1, TITLE: 1, LINK: 1, BASE: 1 };
  var movable = function (el) { return el && !STRUCTURAL[el.tagName]; };

  /* ---- the overlay ------------------------------------------------------ */

  var layer = null;
  var parts = {};

  function ensureLayer() {
    if (layer && layer.parentNode) return layer;
    layer = document.createElement('div');
    layer.setAttribute('data-ws-overlay', '');
    layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;' +
      'pointer-events:none;z-index:2147483647';

    parts.hover = box('1px dashed rgba(74,163,255,.9)', 'rgba(74,163,255,.10)');
    parts.select = box('1px solid #4aa3ff', 'transparent');
    parts.marker = document.createElement('div');
    parts.marker.style.cssText = 'position:absolute;background:#ff9ec4;border-radius:2px;' +
      'box-shadow:0 0 0 1px rgba(0,0,0,.25);display:none';
    parts.label = document.createElement('div');
    parts.label.style.cssText = 'position:absolute;background:#4aa3ff;color:#fff;display:none;' +
      'font:11px/1.5 ui-monospace,Consolas,monospace;padding:1px 6px;border-radius:3px 3px 0 0;' +
      'white-space:nowrap;transform:translateY(-100%)';
    /* What you are pointing at, and how big it is - the question you were
       about to answer by clicking. */
    parts.tip = document.createElement('div');
    parts.tip.style.cssText = 'position:absolute;background:rgba(21,23,28,.92);color:#dfe4ec;' +
      'display:none;font:11px/1.5 ui-monospace,Consolas,monospace;padding:1px 6px;' +
      'border-radius:3px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    parts.matches = [];

    layer.appendChild(parts.hover);
    layer.appendChild(parts.select);
    layer.appendChild(parts.marker);
    layer.appendChild(parts.label);
    layer.appendChild(parts.tip);

    parts.handles = {};
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(function (dir) {
      var h = document.createElement('div');
      h.setAttribute('data-ws-handle', dir);
      h.style.cssText = 'position:absolute;width:9px;height:9px;margin:-5px 0 0 -5px;' +
        'background:#fff;border:1px solid #4aa3ff;border-radius:2px;display:none;' +
        'pointer-events:auto;cursor:' + dir + '-resize';
      parts.handles[dir] = h;
      layer.appendChild(h);
    });

    (document.body || document.documentElement).appendChild(layer);
    return layer;
  }

  function box(border, fill) {
    var el = document.createElement('div');
    el.style.cssText = 'position:absolute;border:' + border + ';background:' + fill +
      ';border-radius:2px;display:none;box-sizing:border-box';
    return el;
  }

  function place(el, target) {
    if (!target) { el.style.display = 'none'; return null; }
    var r = target.getBoundingClientRect();
    el.style.left = (r.left + window.scrollX) + 'px';
    el.style.top = (r.top + window.scrollY) + 'px';
    el.style.width = r.width + 'px';
    el.style.height = r.height + 'px';
    el.style.display = 'block';
    return r;
  }

  var hide = function (el) { if (el) el.style.display = 'none'; };

  /* ---- state ------------------------------------------------------------ */

  var mode = 'off';            // 'off' | 'inspect' | 'design'
  var hovered = null;
  var selected = null;
  var gesture = null;          // an in-flight drag or resize
  var matchSelector = null;    // the CSS rule the caret is in, over in the editor
  var matched = [];

  function paintSelection() {
    ensureLayer();
    if (!selected || !selected.isConnected) {
      selected = null;
      hide(parts.select);
      hide(parts.label);
      showHandles(false);
      return;
    }
    var r = place(parts.select, selected);
    parts.label.textContent = describe(selected);
    parts.label.style.left = (r.left + window.scrollX) + 'px';
    parts.label.style.top = (r.top + window.scrollY) + 'px';
    parts.label.style.display = 'block';
    if (mode === 'design') layoutHandles(r); else showHandles(false);
  }

  function layoutHandles(r) {
    var x = r.left + window.scrollX, y = r.top + window.scrollY;
    var mx = x + r.width / 2, my = y + r.height / 2;
    var at = { nw: [x, y], n: [mx, y], ne: [x + r.width, y], e: [x + r.width, my],
               se: [x + r.width, y + r.height], s: [mx, y + r.height],
               sw: [x, y + r.height], w: [x, my] };
    for (var dir in at) {
      var h = parts.handles[dir];
      h.style.left = at[dir][0] + 'px';
      h.style.top = at[dir][1] + 'px';
      h.style.display = 'block';
    }
  }

  function showHandles(on) {
    for (var dir in parts.handles) parts.handles[dir].style.display = on ? 'block' : 'none';
  }

  function refresh() {
    if (mode === 'off') return;
    paintSelection();
    placeMatches();
    if (hovered) showTip(hovered);
  }
  window.addEventListener('resize', refresh);
  window.addEventListener('scroll', refresh, true);

  /* ---- every element a rule applies to ----------------------------------- */

  /* States the page is not in right now. Without them, the caret in
     a .button:hover rule would match nothing, which is the wrong answer. */
  var DYNAMIC = /::?(?:hover|active|focus-visible|focus-within|focus|visited|link|target|before|after|first-line|first-letter|placeholder|selection|marker|backdrop|-webkit-[\w-]+|-moz-[\w-]+)\b/gi;

  function findMatches(selector) {
    if (!selector) return [];
    var tries = [selector, selector.replace(DYNAMIC, '')];
    for (var i = 0; i < tries.length; i++) {
      var found;
      try { found = document.querySelectorAll(tries[i]); } catch (e) { continue; }
      var out = [];
      for (var j = 0; j < found.length && out.length < 300; j++) {
        if (!layer || !layer.contains(found[j])) out.push(found[j]);
      }
      if (out.length) return out;
    }
    return [];
  }

  function placeMatches() {
    ensureLayer();
    while (parts.matches.length < matched.length) {
      var b = box('1px dashed #ffb86c', 'rgba(255,184,108,.13)');
      parts.matches.push(b);
      layer.insertBefore(b, layer.firstChild);
    }
    for (var i = 0; i < parts.matches.length; i++) {
      var el = matched[i];
      var r = el && el.isConnected ? el.getBoundingClientRect() : null;
      if (r && (r.width || r.height)) place(parts.matches[i], el); else hide(parts.matches[i]);
    }
  }

  function showMatches(selector) {
    matchSelector = selector || null;
    matched = findMatches(matchSelector);
    placeMatches();
    /* Bring one into view, unless one already is. */
    var seen = false;
    for (var i = 0; i < matched.length && !seen; i++) {
      var r = matched[i].getBoundingClientRect();
      seen = r.bottom > 0 && r.top < innerHeight && (r.width || r.height);
    }
    if (!seen && matched.length) matched[0].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* ---- hover ------------------------------------------------------------ */

  function showTip(el) {
    var r = el.getBoundingClientRect();
    var tip = parts.tip;
    tip.textContent = describe(el) + '  ' + Math.round(r.width) + ' × ' + Math.round(r.height);
    tip.style.display = 'block';
    var above = r.top > 24;
    tip.style.left = Math.max(0, r.left + window.scrollX) + 'px';
    tip.style.top = (above ? r.top + window.scrollY - 3 : r.bottom + window.scrollY + 3) + 'px';
    tip.style.transform = above ? 'translateY(-100%)' : '';
  }

  document.addEventListener('mousemove', function (e) {
    if (mode === 'off' || gesture) return;
    var el = nodeAt(e.target);
    if (el === hovered) return;
    hovered = el;
    ensureLayer();
    if (el && el !== selected) { place(parts.hover, el); showTip(el); }
    else { hide(parts.hover); hide(parts.tip); }
  }, true);

  document.addEventListener('mouseleave', function () {
    if (mode === 'off') return;
    hovered = null;
    hide(parts.hover);
    hide(parts.tip);
  }, true);

  /* ---- gestures --------------------------------------------------------- */

  var DRAG_THRESHOLD = 4;

  document.addEventListener('pointerdown', function (e) {
    if (mode === 'off' || e.button !== 0) return;

    var handle = e.target.getAttribute && e.target.getAttribute('data-ws-handle');
    if (handle && selected) {
      e.preventDefault();
      e.stopPropagation();
      startResize(e, handle);
      return;
    }

    var el = nodeAt(e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();

    selected = el;
    hide(parts.hover);
    hide(parts.tip);
    paintSelection();

    if (mode !== 'design' || !movable(el)) {
      gesture = { kind: 'click', id: idOf(el) };
      return;
    }

    var style = getComputedStyle(el);
    var positioned = style.position === 'absolute' || style.position === 'fixed' ||
      (style.position === 'relative' && (style.left !== 'auto' || style.top !== 'auto'));

    gesture = {
      kind: positioned ? 'reposition' : 'move',
      pending: true,
      id: idOf(el),
      el: el,
      x: e.clientX, y: e.clientY,
      left: parseFloat(style.left) || 0,
      top: parseFloat(style.top) || 0,
      wasStyle: el.getAttribute('style'),
      drop: null
    };
  }, true);

  function startResize(e, dir) {
    var r = selected.getBoundingClientRect();
    var style = getComputedStyle(selected);
    gesture = {
      kind: 'resize',
      dir: dir,
      id: idOf(selected),
      el: selected,
      x: e.clientX, y: e.clientY,
      width: r.width, height: r.height,
      unit: unitOf(style.width) || 'px',
      wasStyle: selected.getAttribute('style')
    };
  }

  /* Keep whatever unit the author was already using where we can tell. */
  function unitOf(value) {
    var m = /[a-z%]+$/i.exec(String(value).trim());
    return m ? m[0] : null;
  }

  document.addEventListener('pointermove', function (e) {
    if (!gesture) return;
    var dx = e.clientX - gesture.x;
    var dy = e.clientY - gesture.y;

    if (gesture.pending) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      gesture.pending = false;
      if (gesture.kind === 'move') {
        gesture.el.style.opacity = '0.45';
        document.documentElement.style.cursor = 'grabbing';
      }
    }

    if (gesture.kind === 'resize') return dragResize(e, dx, dy);
    if (gesture.kind === 'reposition') return dragPosition(dx, dy);
    if (gesture.kind === 'move') return dragMove(e);
  }, true);

  function dragResize(e, dx, dy) {
    var dir = gesture.dir;
    var width = gesture.width + (dir.indexOf('e') >= 0 ? dx : dir.indexOf('w') >= 0 ? -dx : 0);
    var height = gesture.height + (dir.indexOf('s') >= 0 ? dy : dir.indexOf('n') >= 0 ? -dy : 0);
    /* Shift keeps the shape you started with. */
    if (e.shiftKey && gesture.width && gesture.height && dir.length === 2) {
      height = width * (gesture.height / gesture.width);
    }
    gesture.newWidth = Math.max(1, Math.round(width));
    gesture.newHeight = Math.max(1, Math.round(height));
    if (dir !== 'n' && dir !== 's') gesture.el.style.width = gesture.newWidth + 'px';
    if (dir !== 'e' && dir !== 'w') gesture.el.style.height = gesture.newHeight + 'px';
    paintSelection();
    send('measure', { width: gesture.newWidth, height: gesture.newHeight });
  }

  function dragPosition(dx, dy) {
    gesture.newLeft = Math.round(gesture.left + dx);
    gesture.newTop = Math.round(gesture.top + dy);
    gesture.el.style.left = gesture.newLeft + 'px';
    gesture.el.style.top = gesture.newTop + 'px';
    paintSelection();
    send('measure', { left: gesture.newLeft, top: gesture.newTop });
  }

  function dragMove(e) {
    var drop = dropAt(e.clientX, e.clientY, gesture.el);
    gesture.drop = drop;
    if (!drop) { hide(parts.marker); send('measure', { drop: null }); return; }
    drawMarker(drop);
    send('measure', { drop: drop.position + ' ' + describe(drop.el) });
  }

  /**
   * Where would a drop here land? Walks the elements under the pointer,
   * skipping the one being dragged and anything inside it.
   */
  function dropAt(x, y, dragged) {
    var stack = document.elementsFromPoint(x, y);
    for (var i = 0; i < stack.length; i++) {
      var el = nodeAt(stack[i]);
      if (!el || el === dragged || dragged.contains(el) || !movable(el)) continue;
      if (el.tagName === 'BODY') return { el: el, position: 'inside' };

      var r = el.getBoundingClientRect();
      /* An empty container is a place to drop into, not next to. */
      if (!el.children.length && canHoldChildren(el) && r.width > 12 && r.height > 12) {
        return { el: el, position: 'inside' };
      }
      var horizontal = flowsHorizontally(el);
      var past = horizontal ? (x - r.left) > r.width / 2 : (y - r.top) > r.height / 2;
      return { el: el, position: past ? 'after' : 'before', horizontal: horizontal };
    }
    return null;
  }

  var VOID = { AREA: 1, BASE: 1, BR: 1, COL: 1, EMBED: 1, HR: 1, IMG: 1, INPUT: 1,
    LINK: 1, META: 1, SOURCE: 1, TRACK: 1, WBR: 1, TEXTAREA: 1, SELECT: 1 };
  var canHoldChildren = function (el) { return !VOID[el.tagName] && !el.textContent.trim(); };

  function flowsHorizontally(el) {
    var parent = el.parentElement;
    if (!parent) return false;
    var style = getComputedStyle(parent);
    if (style.display === 'flex' || style.display === 'inline-flex') {
      return style.flexDirection.indexOf('row') === 0;
    }
    if (style.display === 'grid' || style.display === 'inline-grid') return true;
    return getComputedStyle(el).display.indexOf('inline') === 0;
  }

  function drawMarker(drop) {
    var r = drop.el.getBoundingClientRect();
    var x = r.left + window.scrollX, y = r.top + window.scrollY;
    var m = parts.marker;
    if (drop.position === 'inside') {
      m.style.left = (x + 3) + 'px';
      m.style.top = (y + 3) + 'px';
      m.style.width = Math.max(0, r.width - 6) + 'px';
      m.style.height = Math.max(0, r.height - 6) + 'px';
      m.style.background = 'rgba(255,158,196,.20)';
      m.style.border = '2px dashed #ff9ec4';
    } else {
      m.style.background = '#ff9ec4';
      m.style.border = '0';
      if (drop.horizontal) {
        m.style.left = (drop.position === 'after' ? x + r.width - 1 : x - 1) + 'px';
        m.style.top = y + 'px';
        m.style.width = '3px';
        m.style.height = r.height + 'px';
      } else {
        m.style.left = x + 'px';
        m.style.top = (drop.position === 'after' ? y + r.height - 1 : y - 1) + 'px';
        m.style.width = r.width + 'px';
        m.style.height = '3px';
      }
    }
    m.style.display = 'block';
  }

  document.addEventListener('pointerup', function (e) {
    if (!gesture) return;
    var g = gesture;
    gesture = null;
    document.documentElement.style.cursor = mode === 'off' ? '' : 'default';
    hide(parts.marker);

    if (g.el) {
      g.el.style.opacity = '';
      /* Whatever we changed live is thrown away: the app is about to rebuild
         this page from the source, which is the only copy that counts. */
      if (g.wasStyle === null) g.el.removeAttribute('style');
      else g.el.setAttribute('style', g.wasStyle);
    }

    if (g.kind === 'click' || g.pending) {
      send('pick', { node: g.id });
    } else if (g.kind === 'resize') {
      send('resize', { node: g.id, width: g.newWidth, height: g.newHeight,
        dir: g.dir, unit: g.unit });
    } else if (g.kind === 'reposition') {
      send('reposition', { node: g.id, left: g.newLeft, top: g.newTop });
    } else if (g.kind === 'move' && g.drop) {
      send('move', { node: g.id, target: idOf(g.drop.el), position: g.drop.position });
    }
    send('measure', null);
    paintSelection();
  }, true);

  document.addEventListener('click', function (e) {
    if (mode !== 'off') { e.preventDefault(); e.stopPropagation(); }
  }, true);

  /* ---- links ------------------------------------------------------------ */

  /* This page is a srcdoc, so a relative link resolves against the editor's
     own address: left alone, about.html would load the editor's 404, and
     even #top would load the editor itself into the preview. The app knows
     where the project's pages are, so it follows them instead.

     Listened for on the window, after the page's own handlers, so a link a
     script has already taken care of (a router, a menu toggle) is left to
     that script. */
  function followLink(e) {
    if (mode !== 'off' || e.defaultPrevented) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href], area[href]') : null;
    if (!a || a.hasAttribute('download')) return;
    var href = (a.getAttribute('href') || '').trim();
    if (!href) return;
    if (/^https?:|^\/\//i.test(href)) {
      /* Most sites refuse to be framed; a real tab is where they work. */
      e.preventDefault();
      send('open', { url: /^\/\//.test(href) ? 'https:' + href : href });
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return;       // mailto:, tel:, javascript:
    e.preventDefault();
    if (href.charAt(0) === '#') { jumpTo(href.slice(1)); return; }
    send('navigate', { href: href });
  }

  window.addEventListener('click', followLink);
  window.addEventListener('auxclick', function (e) { if (e.button === 1) followLink(e); });

  /** Scroll to #id, the way following a fragment would. (No backticks in
      here: this whole runtime is one template string.) */
  function jumpTo(id) {
    try { id = decodeURIComponent(id); } catch (err) { /* use it as written */ }
    var target = id ? document.getElementById(id) || document.getElementsByName(id)[0] : null;
    if (target) target.scrollIntoView();
    else if (!id || id === 'top') window.scrollTo(0, 0);
  }

  /* Back, the way a browser would take it: Alt+Left, or the mouse's back
     button. Both would otherwise act on the iframe's own history, which is
     a stack of rebuilds rather than of pages. */
  window.addEventListener('mouseup', function (e) {
    if (e.button === 3) { e.preventDefault(); send('back', null); }
  });

  document.addEventListener('keydown', function (e) {
    /* The mode keys have to work with focus in here too, or the first click
       on the page would trap you in whichever mode you were in. */
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[123]$/.test(e.code)) {
      e.preventDefault();
      send('key', { code: e.code });
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      send('back', null);
      return;
    }
    if (mode === 'off' || !selected) return;
    if (e.key === 'Escape') { selected = null; paintSelection(); send('pick', { node: null }); return; }
    if (mode !== 'design') return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      send('remove', { node: idOf(selected) });
      return;
    }
    /* Arrow keys nudge a positioned element; 10px with Shift. */
    if (e.key.indexOf('Arrow') !== 0) return;
    var style = getComputedStyle(selected);
    if (style.position === 'static') return;
    e.preventDefault();
    var step = e.shiftKey ? 10 : 1;
    var dx = (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0);
    var dy = (e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0);
    send('reposition', {
      node: idOf(selected),
      left: Math.round((parseFloat(style.left) || 0) + dx),
      top: Math.round((parseFloat(style.top) || 0) + dy)
    });
  }, true);

  /* ---- messages from the app -------------------------------------------- */

  window.addEventListener('message', function (e) {
    var data = e.data;
    if (!data || !data.wsHost) return;

    if (data.kind === 'mode') {
      mode = data.mode;
      ensureLayer();
      document.documentElement.style.cursor = mode === 'off' ? '' : 'default';
      hovered = null;
      hide(parts.hover);
      hide(parts.tip);
      if (mode !== 'inspect') showMatches(null);
      if (mode === 'off') {
        selected = null;
        hide(parts.select);
        hide(parts.label);
        hide(parts.marker);
        showHandles(false);
      } else {
        paintSelection();
      }
    }
    if (data.kind === 'match') showMatches(data.selector);
    if (data.kind === 'hash') jumpTo(data.id);
    if (data.kind === 'select') {
      selected = byId(data.node);
      if (selected) selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      paintSelection();
    }
    if (data.kind === 'flash') {
      var target = byId(data.node);
      if (!target) return;
      ensureLayer();
      place(parts.hover, target);
      target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      setTimeout(function () { if (!hovered) hide(parts.hover); }, 900);
    }
  });

  send('ready', { title: document.title });
})();
`;

  root.WS.runtime = RUNTIME;
})(window);
