/* ============================================================================
   editor.js — a small code editor built on a textarea.

   The textarea stays the real editing surface: native caret, native selection,
   native undo, native IME. A <pre> underneath paints the syntax colours and a
   gutter tracks it. Programmatic edits go through execCommand('insertText') so
   they land on the browser's own undo stack rather than wiping it.

   `lang` is one of 'html', 'css' or 'js', and decides how Enter, `>` and
   Ctrl+/ behave.

   Several selections at once - Ctrl+D, Alt+click and friends - are the one
   thing a textarea cannot do, so they live beside it. The native selection
   stays the primary one; the others are kept here and painted on a layer
   under the text, and an edit made with several of them goes in as a single
   replacement, so it is still one step on the native undo stack.
   ========================================================================== */
(function (root) {
  'use strict';

  const INDENT = '  ';

  function Editor(host, opts) {
    opts = opts || {};
    const ta = host.querySelector('.ed-input');
    const layer = host.querySelector('.ed-layer code');
    const scroll = host.querySelector('.ed-scroll');
    const gutter = host.querySelector('.ed-gutter');
    const gutterInner = host.querySelector('.ed-gutter-inner');

    /* Extra carets, selections, matches and the like, painted under the text
       so they never hide what they mark. */
    const marksLayer = document.createElement('div');
    marksLayer.className = 'ed-marks';
    marksLayer.setAttribute('aria-hidden', 'true');
    scroll.insertBefore(marksLayer, scroll.firstChild);

    const listeners = { change: [], caret: [], scroll: [], key: [], notice: [] };
    let diagnostics = [];
    let lineCount = -1;
    let frame = 0;
    let mirror = null;
    let suppress = false;

    let lang = opts.lang || 'html';

    /* ── events ──────────────────────────────────────────────────────── */

    function on(name, fn) { (listeners[name] || (listeners[name] = [])).push(fn); return api; }
    function emit(name, arg) { for (const fn of (listeners[name] || [])) fn(arg); }

    /* ── rendering ───────────────────────────────────────────────────── */

    function scheduleRender() {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; render(); });
    }

    function render() {
      const text = ta.value;
      layer.innerHTML = root.WS.highlight.render(text, lang, diagnostics);
      renderGutter(text);
      syncScroll();
    }

    function renderGutter(text) {
      const lines = countLines(text);
      if (lines !== lineCount) {
        lineCount = lines;
        const frag = document.createDocumentFragment();
        for (let i = 1; i <= lines; i++) {
          const el = document.createElement('div');
          el.className = 'ed-ln';
          el.textContent = String(i);
          frag.appendChild(el);
        }
        gutterInner.replaceChildren(frag);
      }
      markGutter(text);
    }

    function markGutter(text) {
      const rows = gutterInner.children;
      for (const row of rows) row.className = 'ed-ln';

      const starts = root.WS.lineStarts(text);
      for (const d of diagnostics) {
        const { line } = root.WS.posToLineCol(starts, d.start);
        const row = rows[line - 1];
        if (!row) continue;
        if (d.severity === 'error') row.classList.add('has-error');
        else if (d.severity === 'warning' && !row.classList.contains('has-error')) row.classList.add('has-warning');
      }
      for (const pos of [ta.selectionStart, ...extras.map((s) => s.head)]) {
        const cur = root.WS.posToLineCol(starts, pos).line;
        if (rows[cur - 1]) rows[cur - 1].classList.add('is-current');
      }
    }

    function countLines(text) {
      let count = 1;
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
      return count;
    }

    function syncScroll() {
      const x = ta.scrollLeft, y = ta.scrollTop;
      layer.parentNode.style.transform = `translate(${-x}px, ${-y}px)`;
      marksLayer.style.transform = `translate(${-x}px, ${-y}px)`;
      gutterInner.style.transform = `translateY(${-y}px)`;
    }

    /* ── text geometry ───────────────────────────────────────────────── */

    /* Measured with a canvas rather than a mirror element: the marks layer
       asks for dozens of positions per frame, and a canvas answers without a
       layout pass each time. */
    let metrics = null;

    function measure() {
      if (metrics) return metrics;
      const cs = getComputedStyle(ta);
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      metrics = {
        ctx,
        padTop: parseFloat(cs.paddingTop) || 0,
        padLeft: parseFloat(cs.paddingLeft) || 0,
        lh: parseFloat(cs.lineHeight) || 20,
        tab: parseInt(cs.tabSize, 10) || 2
      };
      return metrics;
    }

    /** Width of a run of text that starts at the beginning of a line. */
    function textWidth(s) {
      const m = measure();
      if (s.includes('\t')) {
        let out = '';
        for (const ch of s) out += ch === '\t' ? ' '.repeat(m.tab - (out.length % m.tab)) : ch;
        s = out;
      }
      return m.ctx.measureText(s).width;
    }

    let startsText = null;
    let startsCache = [0];

    function starts() {
      if (ta.value !== startsText) {
        startsText = ta.value;
        startsCache = root.WS.lineStarts(startsText);
      }
      return startsCache;
    }

    /** 0-based line of `pos`. */
    const lineOf = (pos) => root.WS.posToLineCol(starts(), pos).line - 1;

    function lineEndOf(line) {
      const s = starts();
      return line + 1 < s.length ? s[line + 1] - 1 : ta.value.length;
    }

    /** Where `pos` sits in the text's own coordinates, padding included. */
    function pointAt(pos) {
      const m = measure();
      const line = lineOf(pos);
      const from = starts()[line];
      return { line, x: m.padLeft + textWidth(ta.value.slice(from, pos)), y: m.padTop + line * m.lh };
    }

    /**
     * The text offset under a point on screen. `inside` says whether the
     * point is over actual characters rather than the space after a line.
     */
    function posFromPoint(clientX, clientY) {
      const m = measure();
      const box = ta.getBoundingClientRect();
      const s = starts();
      const line = Math.floor((clientY - box.top + ta.scrollTop - m.padTop) / m.lh);
      if (line < 0 || line >= s.length) return null;
      const x = clientX - box.left + ta.scrollLeft - m.padLeft;
      const text = ta.value.slice(s[line], lineEndOf(line));
      let lo = 0, hi = text.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((textWidth(text.slice(0, mid)) + textWidth(text.slice(0, mid + 1))) / 2 < x) lo = mid + 1;
        else hi = mid;
      }
      return { pos: s[line] + lo, inside: x >= 0 && x <= textWidth(text) };
    }

    /* ── marks: extra carets, extra selections, matches, links ──────── */

    let paintFrame = 0;
    let link = null;              // {start, end} underlined while Ctrl is held
    let flash = null;             // a line briefly lit after a jump
    let flashTimer = 0;
    let matches = [];             // other occurrences of the selected text

    function schedulePaint() {
      if (paintFrame) return;
      paintFrame = requestAnimationFrame(() => { paintFrame = 0; paint(); });
    }

    function paint() {
      const m = measure();
      const s = starts();
      /* Only what is on screen, give or take; scrolling repaints. */
      const first = Math.max(0, Math.floor((ta.scrollTop - m.padTop) / m.lh) - 4);
      const last = Math.min(s.length - 1, Math.ceil((ta.scrollTop + ta.clientHeight) / m.lh) + 4);
      const out = [];

      const mark = (cls, x, y, w, h) => {
        const el = document.createElement('div');
        el.className = 'ed-mark ' + cls;
        el.style.cssText = `left:${x}px;top:${y}px;width:${Math.max(0, w)}px;height:${h}px`;
        out.push(el);
      };

      const range = (start, end, cls) => {
        const a = lineOf(start), b = lineOf(end);
        for (let line = Math.max(a, first); line <= Math.min(b, last); line++) {
          const from = s[line];
          const segStart = Math.max(start, from);
          const segEnd = Math.min(end, lineEndOf(line));
          const x0 = textWidth(ta.value.slice(from, segStart));
          /* A selection that runs on past the line end shows a sliver for
             the newline, the way the native one does. */
          const x1 = textWidth(ta.value.slice(from, segEnd)) + (line < b ? 6 : 0);
          mark(cls, m.padLeft + x0, m.padTop + line * m.lh, x1 - x0, m.lh);
        }
      };

      for (const r of matches) {
        const line = lineOf(r.start);
        if (line >= first && line <= last) range(r.start, r.end, 'ed-match');
      }
      for (const sel of extras) {
        const a = Math.min(sel.anchor, sel.head), b = Math.max(sel.anchor, sel.head);
        if (b > a) range(a, b, 'ed-msel');
        const p = pointAt(sel.head);
        if (p.line >= first && p.line <= last) mark('ed-mcaret', p.x - 1, p.y, 2, m.lh);
      }
      if (link) range(link.start, link.end, 'ed-link');
      if (flash != null && flash < s.length) {
        mark('ed-flash', 0, m.padTop + flash * m.lh, Math.max(ta.scrollWidth, ta.clientWidth), m.lh);
      }
      marksLayer.replaceChildren(...out);
    }

    /** Light the line holding `pos` for a moment, so a jump lands visibly. */
    function flashLine(pos) {
      flash = lineOf(pos);
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { flash = null; schedulePaint(); }, 1500);
      /* A fresh element restarts the fade even when the line is the same. */
      marksLayer.replaceChildren();
      schedulePaint();
    }

    function setLink(range) {
      const same = (link && range && link.start === range.start && link.end === range.end) || (!link && !range);
      if (same) return;
      link = range ? { start: range.start, end: range.end } : null;
      schedulePaint();
    }

    /* ── caret geometry ──────────────────────────────────────────────── */

    function ensureMirror() {
      if (mirror) return mirror;
      mirror = document.createElement('div');
      const cs = getComputedStyle(ta);
      Object.assign(mirror.style, {
        position: 'absolute', top: '0', left: '0',
        visibility: 'hidden', pointerEvents: 'none',
        whiteSpace: 'pre', font: cs.font, letterSpacing: cs.letterSpacing,
        padding: cs.padding, tabSize: cs.tabSize, lineHeight: cs.lineHeight
      });
      scroll.appendChild(mirror);
      return mirror;
    }

    /** Caret position in pixels, relative to the editor host. */
    function caretCoords(pos) {
      const m = ensureMirror();
      m.textContent = ta.value.slice(0, pos == null ? ta.selectionStart : pos);
      const marker = document.createElement('span');
      marker.textContent = '​';
      m.appendChild(marker);
      const x = marker.offsetLeft;
      const y = marker.offsetTop;
      m.textContent = '';

      const scrollBox = scroll.getBoundingClientRect();
      const hostBox = host.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
      return {
        x: x - ta.scrollLeft + (scrollBox.left - hostBox.left),
        y: y - ta.scrollTop + (scrollBox.top - hostBox.top),
        lineHeight: lh
      };
    }

    /* ── edits ───────────────────────────────────────────────────────── */

    /** Replace [start,end) with `text`, keeping the native undo stack intact. */
    function replaceRange(start, end, text, caretOffset) {
      /* An edit from outside moves text under the extra carets; they would
         be pointing at the wrong characters afterwards. */
      dropExtras();
      ta.focus();
      ta.setSelectionRange(start, end);
      let ok = false;
      try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
      if (!ok) {
        const v = ta.value;
        ta.value = v.slice(0, start) + text + v.slice(end);
      }
      const caret = start + (caretOffset == null ? text.length : caretOffset);
      ta.setSelectionRange(caret, caret);
      onInput();
    }

    function insert(text, caretOffset) {
      replaceRange(ta.selectionStart, ta.selectionEnd, text, caretOffset);
    }

    /* ── several selections ──────────────────────────────────────────── */

    let extras = [];              // {anchor, head}, besides the native selection
    let wordSeed = null;          // the word Ctrl+D picked up from a bare caret
    let wholeWord = false;        // ...which makes the following matches whole-word only
    let applying = false;
    let committed = null;         // the text the last several-caret edit left

    const lo = (s) => Math.min(s.anchor, s.head);
    const hi = (s) => Math.max(s.anchor, s.head);
    const wordChar = (ch) => !!ch && (lang === 'js' ? /[\w$]/ : /[\w-]/).test(ch);

    function nativeSel() {
      return ta.selectionDirection === 'backward'
        ? { anchor: ta.selectionEnd, head: ta.selectionStart }
        : { anchor: ta.selectionStart, head: ta.selectionEnd };
    }

    /** Sorted, with anything overlapping folded together. */
    function normalise(list) {
      list.sort((a, b) => lo(a) - lo(b) || hi(a) - hi(b));
      const out = [];
      for (const s of list) {
        const prev = out[out.length - 1];
        const touches = prev && (lo(s) < hi(prev) ||
          (lo(s) === hi(prev) && (lo(s) === hi(s) || lo(prev) === hi(prev))));
        if (!touches) { out.push(s); continue; }
        const a = Math.min(lo(prev), lo(s)), b = Math.max(hi(prev), hi(s));
        prev.anchor = a;
        prev.head = b;
        prev.primary = prev.primary || s.primary;
      }
      return out;
    }

    /** Every selection, the native one included, in document order. */
    function selections() {
      const all = extras.map((s) => ({ anchor: s.anchor, head: s.head, primary: false }));
      all.push(Object.assign(nativeSel(), { primary: true }));
      return normalise(all);
    }

    function setSelections(list) {
      list = normalise(list);
      const primary = list.find((s) => s.primary) || list[list.length - 1];
      extras = list.filter((s) => s !== primary).map((s) => ({ anchor: s.anchor, head: s.head }));
      ta.setSelectionRange(lo(primary), hi(primary), primary.head < primary.anchor ? 'backward' : 'forward');
      emitCaret();
    }

    function dropExtras() {
      if (applying || !extras.length) return;
      extras = [];
      schedulePaint();
    }

    function collapse() {
      if (!extras.length) return;
      extras = [];
      emitCaret();
    }

    /**
     * Apply one change per selection as a single undoable replacement.
     *
     * `each(sel, text)` returns `{from, to, text, sel}` - `sel` being the new
     * anchor and head, relative to `from` in the new text - or null to leave
     * that selection where it is.
     */
    function editEach(each) {
      const v = ta.value;
      const changes = selections().map((s) => {
        const c = each(s, v);
        return c
          ? Object.assign({ primary: s.primary }, c)
          : { from: lo(s), to: lo(s), text: '', sel: [s.anchor - lo(s), s.head - lo(s)], primary: s.primary };
      });

      let out = '';
      let last = 0;
      let delta = 0;
      const next = [];
      for (const c of changes) {
        /* Two carets side by side can both reach for the same character. */
        if (c.from < last) c.from = last;
        if (c.to < c.from) c.to = c.from;
        out += v.slice(last, c.from) + c.text;
        const base = c.from + delta;
        const sel = c.sel || [c.text.length, c.text.length];
        next.push({ anchor: base + sel[0], head: base + sel[1], primary: c.primary });
        delta += c.text.length - (c.to - c.from);
        last = c.to;
      }
      out += v.slice(last);
      commit(v, out, next);
    }

    /** Write `next` over `prev` as one native edit, then place the selections. */
    function commit(prev, next, sels) {
      if (next !== prev) {
        let a = 0;
        const limit = Math.min(prev.length, next.length);
        while (a < limit && prev.charCodeAt(a) === next.charCodeAt(a)) a++;
        let tail = 0;
        while (tail < limit - a &&
          prev.charCodeAt(prev.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)) tail++;

        applying = true;
        ta.focus();
        ta.setSelectionRange(a, prev.length - tail);
        let ok = false;
        try { ok = document.execCommand('insertText', false, next.slice(a, next.length - tail)); }
        catch (e) { ok = false; }
        if (!ok || ta.value !== next) ta.value = next;
        applying = false;
        committed = ta.value;
        setTimeout(() => { committed = null; }, 0);
        onInput();
      }
      setSelections(sels);
      reveal(ta.selectionStart);
    }

    const typeAll = (text) => editEach((s) => ({ from: lo(s), to: hi(s), text }));

    function newlineAll() {
      editEach((s, v) => {
        const from = v.lastIndexOf('\n', lo(s) - 1) + 1;
        const indent = (/^[ \t]*/.exec(v.slice(from, lo(s))) || [''])[0];
        return { from: lo(s), to: hi(s), text: '\n' + indent };
      });
    }

    function deleteAll(dir, byWord) {
      editEach((s, v) => {
        if (lo(s) !== hi(s)) return { from: lo(s), to: hi(s), text: '' };
        const p = s.head;
        if (dir < 0) {
          if (p === 0) return null;
          return { from: byWord ? wordLeft(v, p) : charLeft(v, p), to: p, text: '' };
        }
        if (p >= v.length) return null;
        return { from: p, to: byWord ? wordRight(v, p) : charRight(v, p), text: '' };
      });
    }

    /* A surrogate pair is one character to whoever is typing. */
    const charLeft = (v, p) => Math.max(0, p - (/[\udc00-\udfff]/.test(v[p - 1] || '') && p > 1 ? 2 : 1));
    const charRight = (v, p) => Math.min(v.length, p + (/[\ud800-\udbff]/.test(v[p] || '') ? 2 : 1));

    function wordLeft(v, p) {
      let i = p;
      while (i > 0 && /[ \t]/.test(v[i - 1])) i--;
      if (i > 0 && wordChar(v[i - 1])) { while (i > 0 && wordChar(v[i - 1])) i--; }
      else if (i > 0 && v[i - 1] !== '\n') { while (i > 0 && !wordChar(v[i - 1]) && !/\s/.test(v[i - 1])) i--; }
      else if (i === p && i > 0) i--;
      return i;
    }

    function wordRight(v, p) {
      let i = p;
      while (i < v.length && /[ \t]/.test(v[i])) i++;
      if (i < v.length && wordChar(v[i])) { while (i < v.length && wordChar(v[i])) i++; }
      else if (i < v.length && v[i] !== '\n') { while (i < v.length && !wordChar(v[i]) && !/\s/.test(v[i])) i++; }
      else if (i === p && i < v.length) i++;
      return i;
    }

    /** Tab with several carets indents at each; with a selection, whole lines. */
    function indentAll(outdent) {
      const list = selections();
      if (!outdent && list.every((s) => s.anchor === s.head)) return typeAll(INDENT);

      const v = ta.value;
      const lineStarts = new Set();
      for (const s of list) {
        let from = v.lastIndexOf('\n', lo(s) - 1) + 1;
        lineStarts.add(from);
        for (;;) {
          const nl = v.indexOf('\n', from);
          if (nl < 0 || nl + 1 >= hi(s)) break;
          from = nl + 1;
          lineStarts.add(from);
        }
      }
      const edits = [...lineStarts].sort((a, b) => a - b).map((from) => {
        if (!outdent) return { from, to: from, text: INDENT };
        const m = /^( {1,2}|\t)/.exec(v.slice(from, from + 2));
        return { from, to: from + (m ? m[0].length : 0), text: '' };
      });

      const map = (p, collapsed) => {
        let d = 0;
        for (const e of edits) {
          if (e.from > p || (e.from === p && e.to === e.from && !collapsed)) break;
          d += e.to === e.from ? e.text.length : -(Math.min(e.to, p) - e.from);
        }
        return p + d;
      };
      let out = '';
      let last = 0;
      for (const e of edits) { out += v.slice(last, e.from) + e.text; last = e.to; }
      out += v.slice(last);
      commit(v, out, list.map((s) => ({
        anchor: map(s.anchor, s.anchor === s.head),
        head: map(s.head, s.anchor === s.head),
        primary: s.primary
      })));
    }

    /* ── moving every caret ──────────────────────────────────────────── */

    function vertical(dir) {
      return (v, p) => {
        const s = starts();
        const at = root.WS.posToLineCol(s, p);
        const line = at.line - 1 + dir;
        if (line < 0) return 0;
        if (line >= s.length) return v.length;
        return Math.min(s[line] + at.col - 1, lineEndOf(line));
      };
    }

    function home(v, p) {
      const from = v.lastIndexOf('\n', p - 1) + 1;
      const text = (/^[ \t]*/.exec(v.slice(from)) || [''])[0];
      return p === from + text.length ? from : from + text.length;
    }

    function end(v, p) {
      const at = v.indexOf('\n', p);
      return at < 0 ? v.length : at;
    }

    function moveKey(e) {
      const ctrl = e.ctrlKey || e.metaKey;
      switch (e.key) {
        case 'ArrowLeft': return { fn: ctrl ? wordLeft : charLeft, side: 'start' };
        case 'ArrowRight': return { fn: ctrl ? wordRight : charRight, side: 'end' };
        case 'ArrowUp': return ctrl ? null : { fn: vertical(-1), side: 'start' };
        case 'ArrowDown': return ctrl ? null : { fn: vertical(1), side: 'end' };
        case 'Home': return { fn: ctrl ? () => 0 : home };
        case 'End': return { fn: ctrl ? (v) => v.length : end };
        default: return null;
      }
    }

    function moveAll(move, extend) {
      const v = ta.value;
      setSelections(selections().map((s) => {
        /* An arrow on a selection lands on its edge, like the native one. */
        const head = !extend && s.anchor !== s.head && move.side
          ? (move.side === 'start' ? lo(s) : hi(s))
          : move.fn(v, s.head);
        return { anchor: extend ? s.anchor : head, head, primary: s.primary };
      }));
      reveal(nativeSel().head);
    }

    /* ── adding selections ───────────────────────────────────────────── */

    function wordAround(v, p) {
      let a = p, b = p;
      while (a > 0 && wordChar(v[a - 1])) a--;
      while (b < v.length && wordChar(v[b])) b++;
      return a === b ? null : { start: a, end: b };
    }

    function occurrences(v, needle, whole) {
      const out = [];
      if (!needle) return out;
      let at = v.indexOf(needle);
      while (at >= 0 && out.length < 5000) {
        if (!whole || (!wordChar(v[at - 1]) && !wordChar(v[at + needle.length]))) out.push(at);
        at = v.indexOf(needle, at + needle.length);
      }
      return out;
    }

    /** What Ctrl+D and Ctrl+Shift+L search for, picking up a word if need be. */
    function searchTerm() {
      const v = ta.value;
      const p = nativeSel();
      if (p.anchor === p.head) {
        const w = wordAround(v, p.head);
        return w ? { needle: v.slice(w.start, w.end), whole: true, from: w.start, word: w } : null;
      }
      const a = lo(p), b = hi(p);
      /* Whole-word matching sticks for as long as the run that began with a
         bare caret does; a selection you dragged yourself matches anywhere. */
      const seeded = wordSeed && wordSeed.start === a && wordSeed.end === b;
      return { needle: v.slice(a, b), whole: extras.length ? wholeWord : !!seeded, from: a };
    }

    /** Ctrl+D: select the word, then the next match each time after that. */
    function addNext() {
      const term = searchTerm();
      if (!term) return;
      if (term.word) {
        wordSeed = term.word;
        setSelections([...extras.map((s) => ({ anchor: s.anchor, head: s.head })),
          { anchor: term.word.start, head: term.word.end, primary: true }]);
        return;
      }
      wholeWord = term.whole;
      const v = ta.value;
      const len = term.needle.length;
      const taken = selections();
      const free = (at) => !taken.some((s) => lo(s) === at && hi(s) === at + len);
      const all = occurrences(v, term.needle, term.whole);
      const after = hi(nativeSel());
      const at = all.filter((x) => x >= after).concat(all.filter((x) => x < after)).find(free);
      if (at == null) { emit('notice', all.length > 1 ? 'Every match is already selected' : 'No other match'); return; }

      const list = taken.map((s) => ({ anchor: s.anchor, head: s.head }));
      list.push({ anchor: at, head: at + len, primary: true });
      setSelections(list);
      reveal(at, { center: true });
    }

    /** Ctrl+Shift+L: every match at once, the one you are on staying primary. */
    function selectAll() {
      const term = searchTerm();
      if (!term) return;
      wholeWord = term.whole;
      if (term.word) wordSeed = term.word;
      const len = term.needle.length;
      const all = occurrences(ta.value, term.needle, term.whole);
      if (all.length < 2) { emit('notice', 'No other match'); return; }
      setSelections(all.map((at) => ({ anchor: at, head: at + len, primary: at === term.from })));
      emit('notice', all.length + ' selected. Type to change them all; Esc for one cursor.');
    }

    /** Ctrl+Alt+Up/Down: another caret on the next line out. */
    function addVertical(dir) {
      const list = selections();
      const edge = dir < 0 ? list[0] : list[list.length - 1];
      const line = lineOf(edge.head);
      if ((dir < 0 && line === 0) || (dir > 0 && line >= starts().length - 1)) return;
      const at = vertical(dir)(ta.value, edge.head);
      const next = list.map((s) => ({ anchor: s.anchor, head: s.head }));
      next.push({ anchor: at, head: at, primary: true });
      setSelections(next);
      reveal(at);
    }

    /** What a copy with several selections puts on the clipboard. */
    function clipText() {
      const parts = selections().filter((s) => s.anchor !== s.head).map((s) => ta.value.slice(lo(s), hi(s)));
      return parts.length ? parts.join('\n') : null;
    }

    /**
     * Replace `before` characters ahead of every caret, plus its selection,
     * with `text` - what accepting a suggestion means with several carets.
     */
    function replaceEach(before, text, caretOffset) {
      const caret = caretOffset == null ? text.length : caretOffset;
      editEach((s) => ({ from: Math.max(0, lo(s) - before), to: hi(s), text, sel: [caret, caret] }));
    }

    /** Keys that mean something different, or anything at all, with several carets. */
    function multiKey(e) {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key;
      if (mod && !e.altKey && !e.shiftKey && (k === 'd' || k === 'D')) { e.preventDefault(); addNext(); return true; }
      if (mod && e.shiftKey && !e.altKey && (k === 'l' || k === 'L')) { e.preventDefault(); selectAll(); return true; }
      if (mod && e.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) {
        e.preventDefault();
        addVertical(k === 'ArrowUp' ? -1 : 1);
        return true;
      }
      if (!extras.length) return false;

      if (k === 'Escape') { e.preventDefault(); collapse(); return true; }
      if (k === 'Tab') { e.preventDefault(); indentAll(e.shiftKey); return true; }
      const move = !e.altKey && moveKey(e);
      if (move) { e.preventDefault(); moveAll(move, e.shiftKey); return true; }
      if (k === 'PageUp' || k === 'PageDown') { dropExtras(); emitCaret(); return true; }
      /* Undo, redo and select-all are the browser's; one caret is what they
         can deal with. */
      if (mod && /^[zZyYaA]$/.test(k)) { dropExtras(); emitCaret(); return true; }
      if (mod && k === '/') { dropExtras(); emitCaret(); return false; }
      /* Everything else - letters, Enter, Backspace - arrives as beforeinput
         and is applied at every caret there. The single-caret helpers below
         (bracket pairs, tag closing) must not see it. */
      return true;
    }

    ta.addEventListener('beforeinput', (e) => {
      if (!extras.length || applying) return;
      switch (e.inputType) {
        case 'insertText':
        case 'insertReplacementText':
          if (e.data == null) break;
          e.preventDefault();
          typeAll(e.data);
          return;
        case 'insertLineBreak':
        case 'insertParagraph':
          e.preventDefault(); newlineAll(); return;
        case 'deleteContentBackward': e.preventDefault(); deleteAll(-1, false); return;
        case 'deleteContentForward': e.preventDefault(); deleteAll(1, false); return;
        case 'deleteWordBackward': e.preventDefault(); deleteAll(-1, true); return;
        case 'deleteWordForward': e.preventDefault(); deleteAll(1, true); return;
        case 'insertFromPaste':
        case 'deleteByCut':
          return;                        // handled by the clipboard events
        default:
          break;
      }
      /* An IME composition or a drop: no way to repeat it faithfully, so it
         happens once, at the primary caret. */
      dropExtras();
    });

    ta.addEventListener('copy', (e) => {
      if (!extras.length) return;
      const text = clipText();
      if (text == null) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', text);
    });

    ta.addEventListener('cut', (e) => {
      if (!extras.length) return;
      const text = clipText();
      if (text == null) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', text);
      typeAll('');
    });

    ta.addEventListener('paste', (e) => {
      if (!extras.length) return;
      e.preventDefault();
      const text = (e.clipboardData.getData('text/plain') || '').replace(/\r\n?/g, '\n');
      const lines = text.split('\n');
      /* One line per caret pastes one line at each, which is what makes
         copy-with-three-carets, paste-with-three-carets work. */
      if (lines.length > 1 && lines.length === selections().length) {
        let i = 0;
        editEach((s) => ({ from: lo(s), to: hi(s), text: lines[i++] }));
      } else {
        typeAll(text);
      }
    });

    /* Alt+click adds a caret; a plain click goes back to one. */
    let altFrom = null;
    ta.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.offsetX > ta.clientWidth || e.offsetY > ta.clientHeight) return;     // the scrollbar
      if (e.altKey && !e.ctrlKey && !e.metaKey) { altFrom = nativeSel(); return; }
      altFrom = null;
      if (extras.length) { extras = []; schedulePaint(); }
    });

    ta.addEventListener('mouseup', () => {
      if (!altFrom) return;
      const was = altFrom;
      altFrom = null;
      const now = nativeSel();
      const same = (s) => s.anchor === now.anchor && s.head === now.head;
      /* Alt+clicking a caret that is already there takes it away again -
         and if that was the primary one, the newest of the rest takes over. */
      if (now.anchor === now.head && extras.length && (same(was) || extras.some(same))) {
        const rest = extras.filter((s) => !same(s));
        const keep = same(was) ? rest.pop() : was;
        setSelections([...rest, Object.assign({ primary: true }, keep || now)]);
        return;
      }
      extras.push(was);
      setSelections([...extras, Object.assign({ primary: true }, now)]);
    });

    /* ── key handling ────────────────────────────────────────────────── */

    const CLOSERS = { '"': '"', "'": "'", '`': '`', '(': ')', '[': ']', '{': '}' };

    function onKeyDown(e) {
      emit('key', e);
      if (e.defaultPrevented) return;
      if (multiKey(e)) return;

      const start = ta.selectionStart, end = ta.selectionEnd, v = ta.value;

      /* Tab / Shift+Tab — indent or outdent whole lines when text is selected */
      if (e.key === 'Tab') {
        e.preventDefault();
        if (start !== end || e.shiftKey) {
          const from = v.lastIndexOf('\n', start - 1) + 1;
          const toRaw = v.indexOf('\n', end);
          const to = toRaw < 0 ? v.length : toRaw;
          const block = v.slice(from, to);
          const shifted = e.shiftKey
            ? block.replace(/^([ \t]{1,2})/gm, '')
            : block.replace(/^/gm, INDENT);
          const delta = shifted.length - block.length;
          ta.setSelectionRange(from, to);
          try { document.execCommand('insertText', false, shifted); }
          catch (err) { ta.value = v.slice(0, from) + shifted + v.slice(to); }
          ta.setSelectionRange(from, to + delta);
          onInput();
        } else {
          insert(INDENT);
        }
        return;
      }

      /* Enter — carry the indent, and open a block between a pair */
      if (e.key === 'Enter' && !e.shiftKey && start === end) {
        const lineStart = v.lastIndexOf('\n', start - 1) + 1;
        const lineHead = v.slice(lineStart, start);
        const indent = (/^[ \t]*/.exec(lineHead) || [''])[0];
        const before = lineHead.trimEnd();
        const after = v.slice(start);

        const opensTag = /<[A-Za-z][^<>]*>$/.test(before) && !/\/>$/.test(before) &&
          !/^<\//.test(before.slice(before.lastIndexOf('<')));
        const opensBrace = /[{([]$/.test(before);
        const opensBlock = lang === 'html' ? (opensTag || opensBrace) : opensBrace;
        const closesNext = lang === 'html'
          ? /^\s*(<\/|[)\]}])/.test(after)
          : /^\s*[)\]}]/.test(after);

        if (opensBlock && closesNext) {
          e.preventDefault();
          insert('\n' + indent + INDENT + '\n' + indent, 1 + indent.length + INDENT.length);
          return;
        }
        if (opensBlock) { e.preventDefault(); insert('\n' + indent + INDENT); return; }
        if (indent) { e.preventDefault(); insert('\n' + indent); return; }
        return;
      }

      /* `>` — close the tag you just opened, unless it is a void element */
      if (e.key === '>' && lang === 'html' && start === end) {
        const openAt = v.lastIndexOf('<', start - 1);
        if (openAt >= 0 && !/[<>]/.test(v.slice(openAt + 1, start))) {
          const inner = v.slice(openAt + 1, start);
          const m = /^([A-Za-z][\w.:-]*)/.exec(inner);
          if (m && !inner.endsWith('/') && !inner.startsWith('/') &&
              !inner.startsWith('!') && !inner.startsWith('?')) {
            const name = m[1];
            if (!root.WS.schema.isVoid(name)) {
              e.preventDefault();
              insert('></' + name + '>', 1);
              return;
            }
          }
        }
      }

      /* Bracket and quote pairing, and typing over the closing half */
      if (CLOSERS[e.key] && start === end) {
        const next = v.charAt(start);
        if (!/[\w-]/.test(next)) {
          e.preventDefault();
          insert(e.key + CLOSERS[e.key], 1);
          return;
        }
      }
      if (/^["'`)\]}]$/.test(e.key) && start === end && v.charAt(start) === e.key) {
        e.preventDefault();
        ta.setSelectionRange(start + 1, start + 1);
        emitCaret();
        return;
      }

      /* Backspace inside an empty pair deletes both halves */
      if (e.key === 'Backspace' && start === end && start > 0) {
        const prev = v.charAt(start - 1), next = v.charAt(start);
        if (CLOSERS[prev] === next) {
          e.preventDefault();
          replaceRange(start - 1, start + 1, '');
          return;
        }
      }

      /* Ctrl+/ — toggle comments on the selected lines */
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        toggleComment();
        return;
      }
    }

    /* JavaScript gets line comments — they nest, and `/*` inside a regex or a
       string is a genuinely nasty thing to toggle back off. */
    function toggleComment() {
      if (lang === 'js') return toggleLineComment();

      const v = ta.value, start = ta.selectionStart, end = ta.selectionEnd;
      const from = v.lastIndexOf('\n', start - 1) + 1;
      const toRaw = v.indexOf('\n', end);
      const to = toRaw < 0 ? v.length : toRaw;
      const block = v.slice(from, to);
      const open = lang === 'css' ? '/*' : '<!--';
      const close = lang === 'css' ? '*/' : '-->';
      const trimmed = block.trim();
      const indent = (/^[ \t]*/.exec(block) || [''])[0];

      let next;
      if (trimmed.startsWith(open) && trimmed.endsWith(close)) {
        next = indent + block.replace(open, '')
          .replace(new RegExp(close.replace(/[-*/]/g, '\\$&') + '\\s*$'), '').trim();
      } else {
        next = indent + open + ' ' + block.slice(indent.length).trimEnd() + ' ' + close;
      }
      writeBlock(from, to, next);
    }

    function toggleLineComment() {
      const v = ta.value, start = ta.selectionStart, end = ta.selectionEnd;
      const from = v.lastIndexOf('\n', start - 1) + 1;
      const toRaw = v.indexOf('\n', end);
      const to = toRaw < 0 ? v.length : toRaw;
      const block = v.slice(from, to);
      const lines = block.split('\n');
      const meaningful = lines.filter((l) => l.trim());
      const allCommented = meaningful.length > 0 && meaningful.every((l) => /^\s*\/\//.test(l));

      const next = lines.map((line) => {
        if (!line.trim()) return line;
        if (allCommented) return line.replace(/^(\s*)\/\/ ?/, '$1');
        const indent = (/^[ \t]*/.exec(line) || [''])[0];
        return indent + '// ' + line.slice(indent.length);
      }).join('\n');
      writeBlock(from, to, next);
    }

    function writeBlock(from, to, next) {
      const v = ta.value;
      ta.setSelectionRange(from, to);
      try { document.execCommand('insertText', false, next); }
      catch (e) { ta.value = v.slice(0, from) + next + v.slice(to); }
      ta.setSelectionRange(from, from + next.length);
      onInput();
    }

    /* ── plumbing ────────────────────────────────────────────────────── */

    function onInput() {
      if (suppress) return;
      scheduleRender();
      emit('change', ta.value);
      emitCaret();
    }

    function emitCaret() {
      findMatches();
      emit('caret', { start: ta.selectionStart, end: ta.selectionEnd });
      if (!frame) markGutter(ta.value);
      schedulePaint();
    }

    /**
     * The other places the selected text appears, for the faint boxes that
     * tell you Ctrl+D has somewhere to go.
     */
    function findMatches() {
      matches = [];
      const a = ta.selectionStart, b = ta.selectionEnd;
      if (b - a < 1 || b - a > 200) return;
      const v = ta.value;
      const needle = v.slice(a, b);
      if (!needle.trim() || needle.includes('\n')) return;
      if (needle.length < 2 && !wordChar(needle)) return;
      const seeded = wordSeed && wordSeed.start === a && wordSeed.end === b;
      const whole = extras.length ? wholeWord : !!seeded;
      matches = occurrences(v, needle, whole).map((at) => ({ start: at, end: at + needle.length }));
      if (matches.length < 2) matches = [];
    }

    ta.addEventListener('input', () => {
      /* Our own edit: commit() reports it once when it is done, rather than
         once for every line the browser split it into. Typed through an IME
         the same events arrive late, after commit() has returned; the text
         they leave behind is how they are recognised. */
      if (applying || (committed !== null && ta.value === committed)) return;
      committed = null;
      /* Anything else - a drop, a composition - has moved the text under
         the extra carets. */
      if (extras.length) { extras = []; schedulePaint(); }
      onInput();
    });
    ta.addEventListener('keydown', onKeyDown);
    ta.addEventListener('scroll', () => {
      syncScroll();
      if (extras.length || matches.length || link || flash != null) schedulePaint();
      emit('scroll');
    }, { passive: true });
    ta.addEventListener('click', emitCaret);
    ta.addEventListener('select', emitCaret);
    ta.addEventListener('keyup', (e) => {
      if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' ||
          e.key === 'PageUp' || e.key === 'PageDown') emitCaret();
    });
    gutter.addEventListener('wheel', (e) => { ta.scrollTop += e.deltaY; }, { passive: true });

    /**
     * Scroll `pos` into view with a little breathing room.
     * @param {{center?: boolean}} [opts] `center` puts a far-off target in the
     *   middle of the pane, which is where your eye goes after a jump.
     */
    function reveal(pos, opts) {
      const p = pointAt(pos);
      const lh = measure().lh;
      const y = p.y - ta.scrollTop;
      const height = ta.clientHeight;
      if (y < 0 || y + lh > height) {
        ta.scrollTop = opts && opts.center
          ? p.y - height / 2 + lh / 2
          : y < 0 ? p.y - lh : p.y + lh * 2 - height;
      }
      const x = p.x - ta.scrollLeft;
      if (x < 0) ta.scrollLeft = Math.max(0, p.x - 40);
      else if (x > ta.clientWidth - 20) ta.scrollLeft = p.x - ta.clientWidth + 60;
    }

    const api = {
      el: host,
      textarea: ta,
      get lang() { return lang; },
      /** Switching document type re-colours in place; the text is set separately. */
      setLang(next) { lang = next; lineCount = -1; render(); },
      on,
      focus: () => ta.focus(),
      get value() { return ta.value; },
      set value(v) {
        suppress = true;
        ta.value = v;
        suppress = false;
        extras = [];
        wordSeed = null;
        lineCount = -1;
        render();
        emit('change', v);
        emitCaret();
      },
      get selection() { return { start: ta.selectionStart, end: ta.selectionEnd }; },
      /**
       * @param {{focus?:boolean, center?:boolean}} [opts] pass `focus: false`
       *   to move the caret in a pane that is not on screen without pulling
       *   focus off the one that is; `center` for a jump from elsewhere.
       */
      setSelection(start, end, opts) {
        extras = [];
        if (!opts || opts.focus !== false) ta.focus();
        ta.setSelectionRange(start, end == null ? start : end);
        reveal(start, opts);
        scheduleRender();
        emitCaret();
      },
      setDiagnostics(list) { diagnostics = list || []; scheduleRender(); },
      replaceRange,
      /** Several carets: replace `before` chars ahead of each, and its selection. */
      replaceEach,
      insert,
      caretCoords,
      posFromPoint,
      reveal,
      flashLine,
      /** Underline a range, the way a link looks while Ctrl is held over it. */
      setLink,
      /** Back to the primary selection alone. */
      collapse,
      get cursorCount() { return extras.length + 1; },
      get matchCount() { return matches.length; },
      refresh: render
    };
    return api;
  }

  root.WS = root.WS || {};
  root.WS.Editor = Editor;
  root.WS.INDENT = INDENT;
})(window);
