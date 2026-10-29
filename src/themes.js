/* ============================================================================
   themes.js — which palette the editor wears.

   The palettes are plain CSS, in themes.css. This file knows their names,
   remembers the one you picked, and puts it on <html> while the page is
   still in <head>, so the window never flashes Studio on its way to yours.
   ========================================================================== */
(function (root) {
  'use strict';

  const KEY = 'web-studio:theme';
  const DEFAULT = 'studio';

  const TONES = [
    { id: 'light', label: 'Light' },
    { id: 'medium', label: 'Medium' },
    { id: 'dark', label: 'Dark' }
  ];

  /* Studio is the palette in styles.css; every other id names a block in
     themes.css. */
  const THEMES = [
    { id: 'paper', label: 'Paper', tone: 'light' },
    { id: 'linen', label: 'Linen', tone: 'light' },
    { id: 'frost', label: 'Frost', tone: 'light' },
    { id: 'blossom', label: 'Blossom', tone: 'light' },
    { id: 'meadow', label: 'Meadow', tone: 'light' },
    { id: 'slate', label: 'Slate', tone: 'medium' },
    { id: 'dusk', label: 'Dusk', tone: 'medium' },
    { id: 'moss', label: 'Moss', tone: 'medium' },
    { id: 'clay', label: 'Clay', tone: 'medium' },
    { id: 'harbor', label: 'Harbor', tone: 'medium' },
    { id: 'studio', label: 'Studio', tone: 'dark' },
    { id: 'ember', label: 'Ember', tone: 'dark' },
    { id: 'deep-sea', label: 'Deep Sea', tone: 'dark' },
    { id: 'forest', label: 'Forest', tone: 'dark' },
    { id: 'plum', label: 'Plum', tone: 'dark' },
    { id: 'carbon', label: 'Carbon', tone: 'dark' }
  ];

  const known = (id) => THEMES.some((t) => t.id === id);

  function saved() {
    try {
      const id = localStorage.getItem(KEY);
      return known(id) ? id : DEFAULT;
    } catch (e) {
      return DEFAULT;
    }
  }

  function apply(id) {
    if (!known(id)) id = DEFAULT;
    const html = document.documentElement;
    html.dataset.theme = id;
    /* The window's title bar takes its colour from this, so it matches the
       toolbar under it. The stylesheets are loaded by the time this runs:
       a script in <head> waits for the ones above it. */
    const meta = document.querySelector('meta[name="theme-color"]');
    const bar = getComputedStyle(html).getPropertyValue('--bg-2').trim();
    if (meta && bar) meta.content = bar;
    return id;
  }

  /** Wear a theme and remember it for next time. */
  function choose(id) {
    id = apply(id);
    try { localStorage.setItem(KEY, id); } catch (e) {}
    return id;
  }

  apply(saved());

  root.WS = root.WS || {};
  root.WS.themes = {
    TONES,
    THEMES,
    current: () => document.documentElement.dataset.theme,
    choose
  };
})(window);
