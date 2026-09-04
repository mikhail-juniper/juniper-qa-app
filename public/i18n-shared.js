/**
 * Shared bilingual helpers for the Order Management side of the app.
 *
 * The QA/QC reporting pages (app.js, approval.js) each carry their own copy
 * of these; this module exists so order-management.js, app-shell.js and the
 * other Product Information pages can render the same Chinese-first,
 * English-second labels without duplicating the logic a third time.
 *
 * Convention matches the rest of the app: config/i18n.json stores entries as
 * { en, zh }, and the render helpers deliberately put CHINESE FIRST with the
 * English underneath in a .zh span. The factory-side staff who read these
 * screens are Chinese-first, so that ordering is the point - the .zh class
 * name is historical and just means "the secondary line".
 */
(function (global) {
  let I18N = {};
  let ready = null;

  /** Fetch and cache the shared i18n table. Safe to call repeatedly - the
   *  in-flight promise is reused so N callers cause one request. */
  function loadI18n() {
    if (ready) return ready;
    ready = fetch('/api/config')
      .then((r) => (r.ok ? r.json() : {}))
      .then((cfg) => { I18N = (cfg && cfg.i18n) || {}; return I18N; })
      .catch(() => { I18N = {}; return I18N; }); // never block the page on this
    return ready;
  }

  function esc(str) {
    if (str === undefined || str === null) return '';
    return String(str).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  /** Raw pair for a key, already swapped to primary=Chinese,
   *  secondary=English. Unknown keys degrade to the English fallback with no
   *  second line, so a missing translation shows real text, never a key. */
  function pair(key, fallback) {
    const e = I18N[key];
    if (!e) return { primary: fallback || key, secondary: '' };
    return { primary: e.zh || e.en || fallback || key, secondary: e.zh ? (e.en || '') : '' };
  }

  /** Chinese with English stacked underneath - for labels, section titles,
   *  buttons and anything with room for two lines. */
  function t(key, fallback) {
    const p = pair(key, fallback);
    if (!p.secondary) return esc(p.primary);
    return `${esc(p.primary)}<span class="zh">${esc(p.secondary)}</span>`;
  }

  /** Same pair on a single line ("中文 English") - for tight spots like table
   *  headers and inline chips where a stacked span would break the layout. */
  function tInline(key, fallback) {
    const p = pair(key, fallback);
    if (!p.secondary) return esc(p.primary);
    return `${esc(p.primary)} <span class="zh-inline">${esc(p.secondary)}</span>`;
  }

  /** Plain text, no markup - for placeholders, title attributes, toasts,
   *  confirm() dialogs and anywhere HTML would be shown literally. */
  function tText(key, fallback) {
    const p = pair(key, fallback);
    return p.secondary ? `${p.primary} / ${p.secondary}` : p.primary;
  }

  /** Chinese only - for places already tight on space where the English
   *  would be redundant next to an adjacent translated label. */
  function tZh(key, fallback) {
    return esc(pair(key, fallback).primary);
  }

  global.JuniperI18n = { loadI18n, t, tInline, tText, tZh, pair, esc,
    get table() { return I18N; } };
}(window));
