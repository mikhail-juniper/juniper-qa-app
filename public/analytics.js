/* Juniper QA/QC Report - Analytics dashboard (vendor + overall category stats) */

let I18N = {};
let CONFIG = { options: {}, categories: { categories: {} } };
let vendorData = null;
let categoryData = null;

const PERIOD_PRESETS = {
  '30': { labelKey: 'last30Days', days: 30 },
  '90': { labelKey: 'last90Days', days: 90 },
  '180': { labelKey: 'last6Months', days: 180 },
  '365': { labelKey: 'lastYear', days: 365 },
  'all': { labelKey: 'allTime', days: null }
};

const state = {
  period: '90',
  vendor: ''
};

function bi(key, fallback) {
  const e = I18N[key];
  if (!e) return { en: fallback || key, zh: '' };
  return { en: e.zh, zh: e.en };
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
  setTimeout(() => { t.className = 'toast hidden'; }, 3200);
}

function periodToRange(periodKey) {
  const end = new Date();
  if (periodKey === 'all') {
    return { start: new Date('2020-01-01'), end };
  }
  const preset = PERIOD_PRESETS[periodKey] || PERIOD_PRESETS['90'];
  const start = new Date(end.getTime() - preset.days * 24 * 60 * 60 * 1000);
  return { start, end };
}
function isoDate(d) { return d.toISOString().slice(0, 10); }

const CATEGORY_LABEL_KEYS = {
  apparel: 'categoryApparel', plush: 'categoryPlush', bags: 'categoryBags',
  accessories: 'categoryAccessories', other: 'categoryOther'
};

async function loadConfig() {
  const res = await fetch('/api/config');
  CONFIG = await res.json();
  I18N = CONFIG.i18n || {};
}

async function loadCategoryStats() {
  const { start, end } = periodToRange(state.period);
  const res = await fetch(`/api/analytics/category?start=${isoDate(start)}&end=${isoDate(end)}`);
  const data = await res.json();
  categoryData = data.categories;
}

async function loadVendorStats() {
  if (!state.vendor) { vendorData = null; return; }
  const { start, end } = periodToRange(state.period);
  const res = await fetch(`/api/analytics/vendor?creator=${encodeURIComponent(state.vendor)}&start=${isoDate(start)}&end=${isoDate(end)}`);
  vendorData = await res.json();
}

function render() {
  const root = document.getElementById('analyticsRoot');
  root.innerHTML = `
    <a href="index.html" class="btn btn-secondary" style="display:inline-block;width:auto;padding:10px 18px;margin-bottom:16px;text-decoration:none;">
      ← ${escapeHtml(bi('backToApp').en)} / ${escapeHtml(bi('backToApp').zh)}
    </a>

    <div class="card">
      <div class="field">
        <label class="field-label">${escapeHtml(bi('timePeriod').en)} <span class="zh">${escapeHtml(bi('timePeriod').zh)}</span></label>
        <select id="periodSelect">
          ${Object.keys(PERIOD_PRESETS).map((k) => `<option value="${k}" ${state.period === k ? 'selected' : ''}>${escapeHtml(bi(PERIOD_PRESETS[k].labelKey).en)} / ${escapeHtml(bi(PERIOD_PRESETS[k].labelKey).zh)}</option>`).join('')}
        </select>
      </div>
    </div>

    <div class="step-title" style="font-size:19px;">${escapeHtml(bi('overallStatsTitle').en)}<span class="zh">${escapeHtml(bi('overallStatsTitle').zh)}</span></div>
    <div id="categorySection">${renderCategorySection()}</div>

    <div class="step-title" style="font-size:19px; margin-top:26px;">${escapeHtml(bi('vendorStatsTitle').en)}<span class="zh">${escapeHtml(bi('vendorStatsTitle').zh)}</span></div>
    <div class="card">
      <div class="field">
        <label class="field-label">${escapeHtml(bi('selectVendor').en)} <span class="zh">${escapeHtml(bi('selectVendor').zh)}</span></label>
        <select id="vendorSelect">
          <option value="">${escapeHtml(bi('selectPlaceholder', 'Select...').en)}</option>
          ${(CONFIG.options.creators || []).slice().sort().map((c) => `<option value="${escapeHtml(c)}" ${state.vendor === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div id="vendorSection">${renderVendorSection()}</div>
  `;
  attachHandlers();
}

function statsTableHtml(monthRows, totalRow) {
  if (!monthRows.length) {
    return `<div class="section-help" style="padding:14px 0;">${escapeHtml(bi('noDataForPeriod').en)}<br/>${escapeHtml(bi('noDataForPeriod').zh)}</div>`;
  }
  const cols = [
    ['month', 'month'],
    ['posPlaced', 'posPlaced'],
    ['manufacturedQuantity', 'manufacturedQuantity'],
    ['unitsCheckedStat', 'unitsChecked'],
    ['unitsRejectedStat', 'unitsRejected'],
    ['defectiveRate', 'defectiveRate'],
    ['passRate', 'passRate']
  ];
  const fmt = (key, val) => {
    if (val === null || val === undefined) return '-';
    if (key === 'defectiveRate' || key === 'passRate') return `${val}%`;
    if (key === 'manufacturedQuantity' || key === 'unitsChecked' || key === 'unitsRejected' || key === 'posPlaced') return Number(val).toLocaleString();
    return val;
  };
  const rowHtml = (row, isTotal) => `
    <tr class="${isTotal ? 'total-row' : ''}">
      ${cols.map(([labelKey, dataKey]) => `<td>${dataKey === 'month' ? (isTotal ? escapeHtml(bi('totalRow').en) : escapeHtml(row.month)) : fmt(dataKey, row[dataKey])}</td>`).join('')}
    </tr>
  `;
  return `
    <div class="size-table-wrap">
      <table class="size-table analytics-table">
        <thead><tr>${cols.map(([labelKey]) => `<th>${escapeHtml(bi(labelKey).en)}<span class="zh">${escapeHtml(bi(labelKey).zh)}</span></th>`).join('')}</tr></thead>
        <tbody>
          ${monthRows.map((r) => rowHtml(r, false)).join('')}
          ${rowHtml(totalRow, true)}
        </tbody>
      </table>
    </div>
  `;
}

function renderCategorySection() {
  if (!categoryData) return `<div class="section-help">...</div>`;
  return categoryData.map((cat) => `
    <div class="card">
      <div class="section-title">${escapeHtml(bi(CATEGORY_LABEL_KEYS[cat.category]).en)}<span class="zh">${escapeHtml(bi(CATEGORY_LABEL_KEYS[cat.category]).zh)}</span></div>
      ${statsTableHtml(cat.months, cat.total)}
    </div>
  `).join('');
}

function renderVendorSection() {
  if (!state.vendor) return `<div class="section-help" style="margin:10px 0;">${escapeHtml(bi('selectVendor').en)}</div>`;
  if (!vendorData) return `<div class="section-help">...</div>`;
  return `
    <div class="card">
      <div class="section-title">${escapeHtml(vendorData.creator)}</div>
      ${statsTableHtml(vendorData.months, vendorData.total)}
    </div>
  `;
}

function attachHandlers() {
  const periodSelect = document.getElementById('periodSelect');
  if (periodSelect) {
    periodSelect.addEventListener('change', async (e) => {
      state.period = e.target.value;
      await Promise.all([loadCategoryStats(), loadVendorStats()]);
      document.getElementById('categorySection').innerHTML = renderCategorySection();
      document.getElementById('vendorSection').innerHTML = renderVendorSection();
    });
  }
  const vendorSelect = document.getElementById('vendorSelect');
  if (vendorSelect) {
    vendorSelect.addEventListener('change', async (e) => {
      state.vendor = e.target.value;
      document.getElementById('vendorSection').innerHTML = `<div class="section-help">...</div>`;
      await loadVendorStats();
      document.getElementById('vendorSection').innerHTML = renderVendorSection();
    });
  }
}

(async function init() {
  try {
    await loadConfig();
    await loadCategoryStats();
    render();
  } catch (e) {
    console.error(e);
    showToast('Failed to load analytics / 加载数据分析失败', true);
  }
})();
