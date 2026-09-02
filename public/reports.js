/* Juniper QA/QC Reports - look up every PO for a SKU, download a consolidated report */

let I18N = {};

function bi(key, fallback) {
  const e = I18N[key];
  if (!e) return { en: fallback || key, zh: '' };
  return { en: e.zh, zh: e.en };
}
function biBlockHtml(key, fallback) {
  const e = bi(key, fallback);
  return `${escapeHtml(e.en)}<span class="zh">${escapeHtml(e.zh)}</span>`;
}
function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}
function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  setTimeout(() => { t.className = 'toast hidden'; }, 3800);
}

const state = { skuInput: '', pos: null };

async function loadConfig() {
  const res = await fetch('/api/config');
  const config = await res.json();
  I18N = config.i18n || {};
}

function render() {
  const root = document.getElementById('reportsRoot');
  root.innerHTML = `
    <div class="step-title">${biBlockHtml('homeReportsTitle', 'Reports')}</div>
    <div class="card">
      <div class="field">
        <label class="field-label">${biBlockHtml('productSku', 'Product SKU')}</label>
        <input type="text" id="skuInput" value="${escapeHtml(state.skuInput)}" placeholder="${escapeHtml(bi('productSkuPlaceholder').en)}" />
      </div>
      <button class="btn btn-primary" id="btnSkuSearch" style="margin-top:10px;">${biBlockHtml('search', 'Search')}</button>
    </div>
    <div id="poListArea">${renderPoList()}</div>
  `;
  attachHandlers();
}

function renderPoList() {
  if (state.pos === null) return '';
  if (!state.pos.length) return `<div class="card"><div class="section-help">${escapeHtml(bi('noPosForSku').en)}<br/>${escapeHtml(bi('noPosForSku').zh)}</div></div>`;
  return state.pos.map((po) => `
    <div class="card">
      <div class="review-row"><span class="k">${escapeHtml(bi('poNumber').en)}</span><span class="v">${escapeHtml(po.poNumber)}</span></div>
      <div class="review-row"><span class="k">${escapeHtml(bi('date').en)}</span><span class="v">${escapeHtml(po.orderDate || '-')}</span></div>
      <div class="review-row"><span class="k">${escapeHtml(bi('poQuantity').en)}</span><span class="v">${escapeHtml(po.orderQuantity || '-')}</span></div>
      <div class="review-row"><span class="k">${escapeHtml(bi('creator').en)}</span><span class="v">${escapeHtml(po.creator || '-')}</span></div>
      <a href="/api/consolidated-report/${encodeURIComponent(po.poNumber)}" target="_blank" rel="noopener" class="btn btn-primary" style="display:block; text-decoration:none; text-align:center; margin-top:10px;">${biBlockHtml('downloadFullReport', 'Download Full Report')}</a>
    </div>
  `).join('');
}

function attachHandlers() {
  const input = document.getElementById('skuInput');
  if (input) input.addEventListener('input', (e) => { state.skuInput = e.target.value; });
  const btn = document.getElementById('btnSkuSearch');
  if (btn) btn.addEventListener('click', searchSku);
}

async function searchSku() {
  const sku = state.skuInput.trim();
  if (!sku) return;
  const btn = document.getElementById('btnSkuSearch');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/reports/by-sku/${encodeURIComponent(sku)}`);
    const data = await res.json();
    state.pos = data.pos || [];
    document.getElementById('poListArea').innerHTML = renderPoList();
  } catch (e) {
    console.error(e);
    showToast(bi('submitError').en, true);
  } finally {
    btn.disabled = false;
  }
}

(async function init() {
  await loadConfig();
  render();
})();
