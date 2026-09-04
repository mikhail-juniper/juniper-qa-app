/**
 * Site-wide language selection + shared translation helpers.
 *
 * The app used to render every label bilingually (Chinese stacked over
 * English). That got noisy, so instead there's now ONE language active at a
 * time, chosen with the toggle in the top-right of the header and remembered
 * across pages and sessions in localStorage.
 *
 * Two things live here:
 *   1. JuniperLang - the preference itself, plus the header toggle UI. Every
 *      page includes this, so the toggle appears site-wide.
 *   2. JuniperI18n - render helpers for pages using the shared table
 *      (order-management.js, clients.js, app-shell.js). The older pages
 *      (app.js, approval.js, settings.js, ...) keep their own bi() helpers
 *      but read the same JuniperLang preference, so everything switches
 *      together.
 *
 * config/i18n.json entries stay { en, zh } - nothing about the data changed,
 * only which half gets displayed.
 */
(function (global) {
  const STORAGE_KEY = 'juniper.lang';
  const DEFAULT_LANG = 'zh'; // factory-side staff are the primary readers

  function get() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v === 'en' || v === 'zh' ? v : DEFAULT_LANG;
    } catch (e) {
      return DEFAULT_LANG; // private mode / storage disabled
    }
  }

  function set(lang) {
    if (lang !== 'en' && lang !== 'zh') return;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* non-fatal */ }
    // A full reload is deliberate: labels are baked into template strings all
    // over the app, so reloading with the new preference is far more reliable
    // than trying to re-render every open view in place.
    location.reload();
  }

  /** Injects the 中文 / EN toggle into the page header. Called by app-shell
   *  once the header exists, so it appears on every page. */
  function mountToggle(header) {
    if (!header || header.querySelector('.lang-toggle')) return;
    const current = get();
    const wrap = document.createElement('div');
    wrap.className = 'lang-toggle';
    wrap.innerHTML =
      '<button type="button" class="lang-opt ' + (current === 'zh' ? 'active' : '') + '" data-lang="zh">\u4e2d\u6587</button>' +
      '<button type="button" class="lang-opt ' + (current === 'en' ? 'active' : '') + '" data-lang="en">EN</button>';
    wrap.querySelectorAll('.lang-opt').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.dataset.lang !== get()) set(btn.dataset.lang);
      });
    });
    header.appendChild(wrap);
  }

  global.JuniperLang = { get: get, set: set, mountToggle: mountToggle, STORAGE_KEY: STORAGE_KEY };

  // ---- Shared translation helpers ----
  let I18N = {};
  let ready = null;

  function loadI18n() {
    if (ready) return ready;
    ready = fetch('/api/config')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (cfg) { I18N = (cfg && cfg.i18n) || {}; return I18N; })
      .catch(function () { I18N = {}; return I18N; }); // never block the page
    return ready;
  }

  function esc(str2) {
    if (str2 === undefined || str2 === null) return '';
    return String(str2).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  /** The single active-language string for a key. Falls back to the other
   *  language, then to the supplied English fallback, so a partially
   *  translated key always shows real text rather than a key name. */
  function str(key, fallback) {
    const e = I18N[key];
    if (!e) return fallback || key;
    const lang = get();
    return (lang === 'en' ? (e.en || e.zh) : (e.zh || e.en)) || fallback || key;
  }

  // These all render the same single-language string now. They're kept as
  // separate names because call sites use them in different contexts
  // (stacked labels, inline table headers, plain-text attributes) and could
  // diverge again later without touching every call site.
  const t = function (key, fallback) { return esc(str(key, fallback)); };
  const tInline = t;
  const tZh = t;
  const tText = function (key, fallback) { return str(key, fallback); };

  /** Kept for callers that interpolate values into a translated sentence. */
  function pair(key, fallback) {
    return { primary: str(key, fallback), secondary: '' };
  }

  global.JuniperI18n = {
    loadI18n: loadI18n, t: t, tInline: tInline, tText: tText, tZh: tZh,
    str: str, pair: pair, esc: esc,
    get lang() { return get(); },
    get table() { return I18N; }
  };
}(window));
