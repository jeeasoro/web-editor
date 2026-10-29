/* ============================================================================
   symbols.js — what a Ctrl+click lands on, and where it leads.

   A name in one file usually means something in another: a class in the
   markup is styled by a rule in a stylesheet, a selector in the stylesheet
   picks out elements in the markup, a `var(--x)` is declared somewhere else.
   `symbolAt` reads the name under the caret; the other functions find every
   place it points to.

   All of it is pure - text in, offsets out - so the app decides what "go
   there" means and none of this needs a DOM.
   ========================================================================== */
(function (root) {
  'use strict';

  const { parseHtml, parseCss } = root.WS.parse;
  const analyze = root.WS.analyze;

  const NAME = /[\w-]/;

  /**
   * The name under `pos`, or null.
   *
   * @returns {{kind: 'class'|'id'|'var'|'ref'|'anchor', side: 'html'|'css',
   *   name: string, start: number, end: number}|null}
   *   `ref` is an href or src, `anchor` an `href="#id"`. `side` says which
   *   language the name was read from, which decides whether a class leads
   *   to the rules that style it or to the elements that carry it.
   */
  function symbolAt(text, pos, lang) {
    if (lang === 'css') return cssSymbolAt(text, pos, 0);
    if (lang !== 'html') return null;

    const region = analyze.embeddedRegion(text, pos);
    if (region) {
      return region.lang === 'css'
        ? cssSymbolAt(text.slice(region.start, region.end), pos - region.start, region.start)
        : null;
    }

    const ctx = analyze.contextAt(text, pos, 'html');
    if (ctx.kind !== 'attr-value' || ctx.valueStart == null) return null;
    const from = ctx.valueStart, to = ctx.valueEnd;

    if (ctx.attr === 'class') {
      /* One class out of the list: the run of non-space around the caret. */
      let a = pos, b = pos;
      while (a > from && !/\s/.test(text[a - 1])) a--;
      while (b < to && !/\s/.test(text[b])) b++;
      return a === b ? null : { kind: 'class', side: 'html', name: text.slice(a, b), start: a, end: b };
    }

    const value = text.slice(from, to);
    const trimmed = value.trim();
    if (!trimmed) return null;
    const start = from + value.indexOf(trimmed);
    const end = start + trimmed.length;

    if (ctx.attr === 'id') return { kind: 'id', side: 'html', name: trimmed, start, end };
    if (ctx.attr === 'href' || ctx.attr === 'src') {
      /* `href="#top"` points at an element on this page, not at a file. */
      if (trimmed[0] === '#' && trimmed.length > 1) {
        return { kind: 'anchor', side: 'html', name: trimmed.slice(1), start, end };
      }
      return { kind: 'ref', side: 'html', name: trimmed, start, end };
    }
    return null;
  }

  /** A `.class`, `#id` in a selector, or `var(--x)` in a value. */
  function cssSymbolAt(css, pos, offset) {
    const state = analyze.cssStateAt(css, pos);
    if (state.inComment || state.inString) return null;

    let a = pos, b = pos;
    while (a > 0 && NAME.test(css[a - 1])) a--;
    while (b < css.length && NAME.test(css[b])) b++;
    /* The caret on the sigil itself still means the name after it. */
    if (a === b && (css[pos] === '.' || css[pos] === '#')) {
      a = b = pos + 1;
      while (b < css.length && NAME.test(css[b])) b++;
    }
    if (a === b) return null;
    const word = css.slice(a, b);

    if (state.blockKind === 'rule') {
      /* Inside a declaration only a custom property leads anywhere. */
      if (!word.startsWith('--')) return null;
      return { kind: 'var', side: 'css', name: word, start: a + offset, end: b + offset };
    }

    const sigil = css[a - 1];
    if (sigil !== '.' && sigil !== '#') return null;
    if (/^\d/.test(word)) return null;              // `.5em` in an at-rule prelude
    return {
      kind: sigil === '.' ? 'class' : 'id',
      side: 'css',
      name: word,
      start: a - 1 + offset,
      end: b + offset
    };
  }

  /* A class like `md:flex` is written `.md\:flex` in a selector. */
  const cssEscape = (name) => name.replace(/[^\w-]/g, (c) => '\\' + c);
  const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** A pattern for `.name` or `#name` as a whole token inside a selector. */
  function selectorPattern(kind, name) {
    return new RegExp((kind === 'class' ? '\\.' : '#') + reEscape(cssEscape(name)) + '(?![\\w-])', 'g');
  }

  /**
   * Every rule whose selector names the class or id.
   *
   * @param {{text: string, offset?: number}[]} sheets stylesheet texts, with
   *   the offset each one sits at inside its document (non-zero for a
   *   `<style>` block).
   * @returns {object[]} `{sheet, start, end, selector, mark, media,
   *   declarations}`; `start`/`end` cover the name inside the selector, in
   *   the coordinates of the sheet's document; `mark` is the same span within
   *   the whitespace-folded `selector`.
   */
  function rulesFor(sheets, symbol) {
    const out = [];
    for (const sheet of sheets) {
      let rules;
      try { rules = parseCss(sheet.text).rules; } catch (e) { continue; }
      for (const rule of rules) {
        if (rule.kind !== 'rule') continue;
        const re = selectorPattern(symbol.kind, symbol.name);
        const m = re.exec(sheet.text.slice(rule.selectorStart, rule.selectorEnd));
        if (!m) continue;
        const at = (sheet.offset || 0) + rule.selectorStart + m.index;
        const selector = rule.selector.replace(/\s+/g, ' ');
        re.lastIndex = 0;
        const shown = re.exec(selector);
        out.push({
          sheet,
          start: at,
          end: at + m[0].length,
          selector,
          mark: shown ? [shown.index, shown.index + shown[0].length] : null,
          media: rule.at ? rule.at.selector.replace(/\s+/g, ' ') : '',
          declarations: rule.declarations.map((d) => ({ name: d.name, value: d.value }))
        });
      }
    }
    return out;
  }

  /**
   * Every element carrying the class or id.
   *
   * @param {{text: string}[]} pages
   * @returns {object[]} `{page, start, end, tag, code}`; `code` is the
   *   element's opening tag, folded onto one line.
   */
  function usesFor(pages, symbol) {
    const out = [];
    const attr = symbol.kind === 'class' ? 'class' : 'id';
    for (const page of pages) {
      let tree;
      try { tree = parseHtml(page.text); } catch (e) { continue; }
      for (const node of tree.elements) {
        const range = (node.attrRanges || []).find((r) => r.name.toLowerCase() === attr);
        if (!range || range.valueStart < 0) continue;
        const hit = attr === 'class'
          ? classToken(range, symbol.name)
          : range.value.trim() === symbol.name ? range.valueStart + range.value.indexOf(symbol.name) : -1;
        if (hit < 0) continue;
        out.push({
          page,
          start: hit,
          end: hit + symbol.name.length,
          tag: node.tag,
          code: page.text.slice(node.start, node.openEnd).replace(/\s+/g, ' ')
        });
      }
    }
    return out;
  }

  function classToken(range, name) {
    const re = /\S+/g;
    let m;
    while ((m = re.exec(range.value))) if (m[0] === name) return range.valueStart + m.index;
    return -1;
  }

  /**
   * Where a custom property is declared.
   * @returns {object[]} `{sheet, start, end, selector, value, media}`
   */
  function varsFor(sheets, name) {
    const out = [];
    for (const sheet of sheets) {
      let rules;
      try { rules = parseCss(sheet.text).rules; } catch (e) { continue; }
      for (const rule of rules) {
        if (rule.kind !== 'rule') continue;
        const css = sheet.text;
        for (const d of rule.declarations) {
          if (d.name !== name) continue;
          out.push({
            sheet,
            start: (sheet.offset || 0) + d.nameStart,
            end: (sheet.offset || 0) + d.nameEnd,
            selector: rule.selector.replace(/\s+/g, ' '),
            value: css.slice(d.valueStart, d.valueEnd).trim(),
            media: rule.at ? rule.at.selector.replace(/\s+/g, ' ') : ''
          });
        }
      }
    }
    return out;
  }

  /* ── which rule wins ─────────────────────────────────────────────────── */

  /* States the page is not in at the moment you click it. Without them a
     `.button:hover` rule would never count as styling the button. */
  const STATEFUL = /::?(?:hover|active|focus-visible|focus-within|focus|visited|link|target|before|after|first-line|first-letter|placeholder|selection|marker|backdrop|-webkit-[\w-]+|-moz-[\w-]+)\b/gi;

  const withoutState = (selector) => selector.replace(STATEFUL, '');

  /** A selector list split at its top-level commas: `a, :is(b, c)` is two. */
  function splitSelectors(selector) {
    const out = [];
    let depth = 0;
    let from = 0;
    for (let i = 0; i < selector.length; i++) {
      const ch = selector[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) { out.push(selector.slice(from, i).trim()); from = i + 1; }
    }
    out.push(selector.slice(from).trim());
    return out.filter(Boolean);
  }

  /**
   * `[ids, classes, types]` for one complex selector. Near enough to the real
   * calculation to rank rules by: `:where()` counts for nothing, and `:not()`,
   * `:is()` and `:has()` count by what is inside them.
   */
  function specificity(selector) {
    const s = selector.replace(/:where\([^)]*\)/g, '').replace(/"[^"]*"|'[^']*'/g, '');
    const ids = (s.match(/#[\w-]+/g) || []).length;
    const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):(?!:)(?!(?:not|is|has)\()[\w-]+/g) || []).length;
    const bare = s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+(\([^)]*\))?/g, ' ');
    const types = (bare.match(/[a-zA-Z][\w-]*/g) || []).length + (s.match(/::[\w-]+/g) || []).length;
    return [ids, classes, types];
  }

  const compareSpecificity = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

  /** 1-based line of an offset, for the `file:line` a result is labelled with. */
  function lineOf(text, pos) {
    let line = 1;
    for (let i = 0; i < pos && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
    return line;
  }

  root.WS.symbols = {
    symbolAt, rulesFor, usesFor, varsFor, lineOf, selectorPattern,
    splitSelectors, specificity, compareSpecificity, withoutState
  };
})(window);
