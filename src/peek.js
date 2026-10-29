/* ============================================================================
   peek.js — the small window a name opens onto.

   Hold Ctrl over a class and this shows the rules that style it, properties
   and all, without leaving the markup. It is a glance: move off the name or
   let go of Ctrl and it is gone.

   Ctrl+click where there is more than one place to go and it stays: arrow
   keys or the mouse pick one, Enter or a click goes there, Esc or the corner
   button closes it.
   ========================================================================== */
(function (root) {
  'use strict';

  const esc = (s) => root.WS.escapeHtml(String(s));

  /**
   * @param {object} editor from WS.Editor
   */
  function Peek(editor) {
    const box = document.createElement('div');
    box.className = 'peek';
    box.hidden = true;
    box.setAttribute('role', 'dialog');

    const head = document.createElement('div');
    head.className = 'peek-head';
    const title = document.createElement('span');
    title.className = 'peek-title';
    const hint = document.createElement('span');
    hint.className = 'peek-hint';
    const shut = document.createElement('button');
    shut.type = 'button';
    shut.className = 'peek-close';
    shut.title = 'Close (Esc)';
    shut.setAttribute('aria-label', 'Close');
    shut.textContent = '×';
    head.append(title, hint, shut);

    const list = document.createElement('div');
    list.className = 'peek-list';
    box.append(head, list);
    editor.el.appendChild(box);

    let items = [];
    let index = 0;
    let pinned = false;
    let anchor = 0;

    /**
     * @param {{title: string, items: object[]}} model each item is
     *   `{label, mark?, note?, where?, lines?, code?, action?, go}`: `lines`
     *   are `{name, value}` declarations, `code` a line of markup, `action`
     *   marks an item that does something rather than going somewhere.
     * @param {number} at the offset the window hangs from
     * @param {{pinned?: boolean}} [opts]
     */
    function show(model, at, opts) {
      items = model.items || [];
      index = 0;
      anchor = at;
      pinned = !!(opts && opts.pinned);
      title.innerHTML = model.title;
      hint.innerHTML = pinned
        ? (items.length > 1 ? '<kbd>↑</kbd><kbd>↓</kbd> <kbd>Enter</kbd>' : '<kbd>Enter</kbd>')
        : 'Ctrl+click to go';
      box.classList.toggle('is-pinned', pinned);
      render();
      box.hidden = false;
      place();
    }

    function hide() {
      if (box.hidden) return;
      box.hidden = true;
      pinned = false;
      items = [];
    }

    function render() {
      const frag = document.createDocumentFragment();
      items.forEach((item, i) => {
        const row = document.createElement('div');
        row.className = 'peek-item' + (item.action ? ' is-action' : '') + (pinned && i === index ? ' is-active' : '');
        row.dataset.index = String(i);

        const top = document.createElement('div');
        top.className = 'peek-item-head';
        const label = document.createElement('span');
        label.className = 'peek-label';
        label.innerHTML = item.mark
          ? esc(item.label.slice(0, item.mark[0])) + '<b>' + esc(item.label.slice(item.mark[0], item.mark[1])) +
            '</b>' + esc(item.label.slice(item.mark[1]))
          : esc(item.label);
        top.appendChild(label);
        if (item.note) {
          const note = document.createElement('span');
          note.className = 'peek-note';
          note.textContent = item.note;
          top.appendChild(note);
        }
        if (item.where) {
          const where = document.createElement('span');
          where.className = 'peek-where';
          where.textContent = item.where;
          top.appendChild(where);
        }
        row.appendChild(top);

        if (item.lines && item.lines.length) {
          const body = document.createElement('div');
          body.className = 'peek-body';
          const shown = item.lines.slice(0, 14);
          body.innerHTML = shown.map((d) =>
            '<div><span class="pk-prop">' + esc(d.name) + '</span>: <span class="pk-value">' +
            esc(d.value) + '</span>;</div>').join('') +
            (item.lines.length > shown.length
              ? '<div class="pk-more">+ ' + (item.lines.length - shown.length) + ' more</div>' : '');
          row.appendChild(body);
        } else if (item.lines) {
          const body = document.createElement('div');
          body.className = 'peek-body pk-more';
          body.textContent = 'No declarations yet.';
          row.appendChild(body);
        }
        if (item.code) {
          const body = document.createElement('div');
          body.className = 'peek-body peek-code';
          body.textContent = item.code.length > 140 ? item.code.slice(0, 139) + '…' : item.code;
          row.appendChild(body);
        }
        frag.appendChild(row);
      });
      list.replaceChildren(frag);
      const active = list.children[index];
      if (pinned && active) active.scrollIntoView({ block: 'nearest' });
    }

    /** Under the name if it fits, above it if not; inside the editor either way. */
    function place() {
      const caret = editor.caretCoords(anchor);
      const hostW = editor.el.clientWidth;
      const hostH = editor.el.clientHeight;
      box.style.left = '0px';
      box.style.top = '0px';
      box.style.maxHeight = '';
      const w = box.offsetWidth;
      box.style.left = Math.max(4, Math.min(caret.x - 12, hostW - w - 8)) + 'px';

      const below = caret.y + caret.lineHeight + 4;
      const roomBelow = hostH - below - 6;
      const roomAbove = caret.y - 10;
      if (box.offsetHeight > roomBelow && roomAbove > roomBelow) {
        box.style.maxHeight = roomAbove + 'px';
        box.style.top = Math.max(4, caret.y - 4 - box.offsetHeight) + 'px';
      } else {
        box.style.maxHeight = Math.max(80, roomBelow) + 'px';
        box.style.top = below + 'px';
      }
    }

    function go(i) {
      const item = items[i];
      if (!item) return;
      hide();
      item.go();
    }

    function move(delta) {
      if (!items.length) return;
      index = (index + delta + items.length) % items.length;
      render();
    }

    /* Clicks in here must not take the caret away from where it is. */
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const row = e.target.closest('.peek-item');
      if (row) go(Number(row.dataset.index));
    });
    shut.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); });
    shut.addEventListener('click', () => { hide(); editor.focus(); });

    editor.on('key', (e) => {
      if (box.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); hide(); return; }
      if (!pinned) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); go(index); return; }
      /* Typing means you have moved on. */
      if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') hide();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !box.hidden && e.target !== editor.textarea) hide();
    });
    editor.textarea.addEventListener('blur', () => hide());
    editor.on('scroll', () => { if (!box.hidden) hide(); });

    return {
      show,
      hide,
      get open() { return !box.hidden; },
      get pinned() { return !box.hidden && pinned; },
      contains: (node) => box.contains(node)
    };
  }

  root.WS.Peek = Peek;
})(window);
