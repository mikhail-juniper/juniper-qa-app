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
  customStart: '',
  customEnd: '',
  filterMode: 'vendor',
  vendor: '',
  factoryCode: ''
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
  if (periodKey === 'custom') {
    const start = state.customStart ? new Date(state.customStart) : new Date('2020-01-01');
    const customEnd = state.customEnd ? new Date(state.customEnd) : end;
    return { start, end: customEnd };
  }
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
  if (state.filterMode === 'vendor') {
    if (!state.vendor) { vendorData = null; return; }
    const { start, end } = periodToRange(state.period);
    const res = await fetch(`/api/analytics/vendor?creator=${encodeURIComponent(state.vendor)}&start=${isoDate(start)}&end=${isoDate(end)}`);
    vendorData = await res.json();
  } else {
    if (!state.factoryCode) { vendorData = null; return; }
    const { start, end } = periodToRange(state.period);
    const res = await fetch(`/api/analytics/factory?factoryCode=${encodeURIComponent(state.factoryCode)}&start=${isoDate(start)}&end=${isoDate(end)}`);
    vendorData = await res.json();
  }
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
          <option value="custom" ${state.period === 'custom' ? 'selected' : ''}>${escapeHtml(bi('customDateRange', 'Custom Range').en)} / ${escapeHtml(bi('customDateRange', 'Custom Range').zh)}</option>
        </select>
      </div>
      ${state.period === 'custom' ? `
        <div class="field-row" style="margin-top:10px;">
          <div class="field" style="flex:1;">
            <label class="field-label">${escapeHtml(bi('startDate', 'Start Date').en)} <span class="zh">${escapeHtml(bi('startDate', 'Start Date').zh)}</span></label>
            <input type="date" id="customStartInput" value="${escapeHtml(state.customStart)}" />
          </div>
          <div class="field" style="flex:1;">
            <label class="field-label">${escapeHtml(bi('endDate', 'End Date').en)} <span class="zh">${escapeHtml(bi('endDate', 'End Date').zh)}</span></label>
            <input type="date" id="customEndInput" value="${escapeHtml(state.customEnd)}" />
          </div>
        </div>
      ` : ''}
    </div>

    <div class="step-title" style="font-size:19px;">${escapeHtml(bi('overallStatsTitle').en)}<span class="zh">${escapeHtml(bi('overallStatsTitle').zh)}</span></div>
    <div id="categorySection">${renderCategorySection()}</div>

    <div class="step-title" style="font-size:19px; margin-top:26px;">${escapeHtml(bi('vendorStatsTitle').en)}<span class="zh">${escapeHtml(bi('vendorStatsTitle').zh)}</span></div>
    <div class="card">
      <div class="field">
        <label class="field-label">${escapeHtml(bi('filterBy').en)} <span class="zh">${escapeHtml(bi('filterBy').zh)}</span></label>
        <div class="segmented">
          <div class="segmented-option ${state.filterMode === 'vendor' ? 'selected' : ''}" data-filter-mode="vendor">${escapeHtml(bi('selectVendor').en)}<span class="zh">${escapeHtml(bi('selectVendor').zh)}</span></div>
          <div class="segmented-option ${state.filterMode === 'factory' ? 'selected' : ''}" data-filter-mode="factory">${escapeHtml(bi('factoryCode').en)}<span class="zh">${escapeHtml(bi('factoryCode').zh)}</span></div>
        </div>
      </div>
      <div class="field" id="vendorFilterField">
        ${state.filterMode === 'vendor' ? `
          <label class="field-label">${escapeHtml(bi('selectVendor').en)} <span class="zh">${escapeHtml(bi('selectVendor').zh)}</span></label>
          <select id="vendorSelect">
            <option value="">${escapeHtml(bi('selectPlaceholder', 'Select...').en)}</option>
            ${(CONFIG.options.creators || []).slice().sort().map((c) => `<option value="${escapeHtml(c)}" ${state.vendor === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
          </select>
        ` : `
          <label class="field-label">${escapeHtml(bi('factoryCode').en)} <span class="zh">${escapeHtml(bi('factoryCode').zh)}</span></label>
          <select id="factorySelect">
            <option value="">${escapeHtml(bi('selectPlaceholder', 'Select...').en)}</option>
            ${(CONFIG.options.factoryCodes || []).slice().sort().map((c) => `<option value="${escapeHtml(c)}" ${state.factoryCode === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
          </select>
        `}
      </div>
    </div>
    <div id="vendorSection">${renderVendorSection()}</div>
  `;
  attachHandlers();
}

const exportDataRegistry = {};

/** Builds an Excel/Sheets-friendly CSV string - UTF-8 BOM so accented/
 *  non-Latin characters display correctly, CRLF line endings, and quoting
 *  around any value that contains a comma, quote, or newline. */
function buildCsvContent(monthRows, totalRow) {
  const cols = [
    ['month', 'month'],
    ['posPlaced', 'posPlaced'],
    ['manufacturedQuantity', 'manufacturedQuantity'],
    ['unitsCheckedStat', 'unitsChecked'],
    ['unitsRejectedStat', 'unitsRejected'],
    ['defectiveRate', 'defectiveRate'],
    ['passRate', 'passRate']
  ];
  const csvCell = (val) => {
    const s = val === null || val === undefined ? '' : String(val);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // bi() swaps .en/.zh internally to match this app's Chinese-first display
  // convention, so a header needs both sides pulled out explicitly rather
  // than reused as-is - "Month / 月份", not just one language.
  const bilingual = (l) => `${l.zh} / ${l.en}`;
  const rawVal = (key, row, isTotal) => {
    if (key === 'month') return isTotal ? bilingual(bi('totalRow')) : row.month;
    const v = row[key];
    if (v === null || v === undefined) return '';
    if (key === 'defectiveRate' || key === 'passRate') return `${v}%`;
    return v;
  };
  const header = cols.map(([labelKey]) => csvCell(bilingual(bi(labelKey)))).join(',');
  const rowLine = (row, isTotal) => cols.map(([, dataKey]) => csvCell(rawVal(dataKey, row, isTotal))).join(',');
  const lines = [header, ...monthRows.map((r) => rowLine(r, false)), rowLine(totalRow, true)];
  return '\ufeff' + lines.join('\r\n');
}

function downloadCsv(filename, csvContent) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function statsTableHtml(monthRows, totalRow, exportKey, exportLabel) {
  if (!monthRows.length) {
    return `<div class="section-help" style="padding:14px 0;">${escapeHtml(bi('noDataForPeriod').en)}<br/>${escapeHtml(bi('noDataForPeriod').zh)}</div>`;
  }
  if (exportKey) exportDataRegistry[exportKey] = { monthRows, totalRow, label: exportLabel || exportKey };
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
    ${exportKey ? `
      <div style="display:flex; justify-content:flex-end; margin-bottom:8px;">
        <button class="btn btn-secondary" style="width:auto; padding:6px 14px; font-size:12px;" data-export-csv="${escapeHtml(exportKey)}">${escapeHtml(bi('exportCsv').en)} / ${escapeHtml(bi('exportCsv').zh)}</button>
      </div>
    ` : ''}
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
  return categoryData.map((cat) => {
    const label = bi(CATEGORY_LABEL_KEYS[cat.category]).en;
    return `
    <div class="card">
      <div class="section-title">${escapeHtml(bi(CATEGORY_LABEL_KEYS[cat.category]).en)}<span class="zh">${escapeHtml(bi(CATEGORY_LABEL_KEYS[cat.category]).zh)}</span></div>
      ${statsTableHtml(cat.months, cat.total, `category_${cat.category}`, label)}
    </div>
  `;
  }).join('');
}

function renderVendorSection() {
  const filterVal = state.filterMode === 'vendor' ? state.vendor : state.factoryCode;
  if (!filterVal) return `<div class="section-help" style="margin:10px 0;">${escapeHtml(bi('selectVendor').en)}</div>`;
  if (!vendorData) return `<div class="section-help">...</div>`;
  const label = vendorData.creator || vendorData.factoryCode;
  return `
    <div class="card">
      <div class="section-title">${escapeHtml(label)}</div>
      ${statsTableHtml(vendorData.months, vendorData.total, `vendor_${label}`, label)}
    </div>
  `;
}

function attachHandlers() {
  const periodSelect = document.getElementById('periodSelect');
  if (periodSelect) {
    periodSelect.addEventListener('change', async (e) => {
      state.period = e.target.value;
      if (state.period === 'custom') {
        // Just show the date fields - wait for the user to actually pick
        // dates before firing off requests with an incomplete range.
        render();
        return;
      }
      await Promise.all([loadCategoryStats(), loadVendorStats()]);
      document.getElementById('categorySection').innerHTML = renderCategorySection();
      document.getElementById('vendorSection').innerHTML = renderVendorSection();
    });
  }
  const customStartInput = document.getElementById('customStartInput');
  const customEndInput = document.getElementById('customEndInput');
  const reloadIfCustomRangeComplete = async (e) => {
    if (e.target === customStartInput) state.customStart = e.target.value;
    else state.customEnd = e.target.value;
    if (!state.customStart || !state.customEnd) return;
    await Promise.all([loadCategoryStats(), loadVendorStats()]);
    document.getElementById('categorySection').innerHTML = renderCategorySection();
    document.getElementById('vendorSection').innerHTML = renderVendorSection();
  };
  if (customStartInput) customStartInput.addEventListener('change', reloadIfCustomRangeComplete);
  if (customEndInput) customEndInput.addEventListener('change', reloadIfCustomRangeComplete);
  document.querySelectorAll('[data-filter-mode]').forEach((el) => {
    el.addEventListener('click', () => {
      state.filterMode = el.getAttribute('data-filter-mode');
      vendorData = null;
      render();
    });
  });
  const vendorSelect = document.getElementById('vendorSelect');
  if (vendorSelect) {
    vendorSelect.addEventListener('change', async (e) => {
      state.vendor = e.target.value;
      document.getElementById('vendorSection').innerHTML = `<div class="section-help">...</div>`;
      await loadVendorStats();
      document.getElementById('vendorSection').innerHTML = renderVendorSection();
    });
  }
  const factorySelect = document.getElementById('factorySelect');
  if (factorySelect) {
    factorySelect.addEventListener('change', async (e) => {
      state.factoryCode = e.target.value;
      document.getElementById('vendorSection').innerHTML = `<div class="section-help">...</div>`;
      await loadVendorStats();
      document.getElementById('vendorSection').innerHTML = renderVendorSection();
    });
  }
}

(async function init() {
  try {
    // Delegated once, since the category/vendor sections get replaced
    // independently of a full page render (attachHandlers only runs on
    // those) - this keeps working no matter how the tables get redrawn.
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-export-csv]');
      if (!btn) return;
      const key = btn.getAttribute('data-export-csv');
      const entry = exportDataRegistry[key];
      if (!entry) return;
      const safeLabel = String(entry.label).replace(/[^a-zA-Z0-9_-]+/g, '_');
      downloadCsv(`juniper-qa-analytics-${safeLabel}-${isoDate(new Date())}.csv`, buildCsvContent(entry.monthRows, entry.totalRow));
    });
    await loadConfig();
    await loadCategoryStats();
    render();
  } catch (e) {
    console.error(e);
    showToast('Failed to load analytics / 加载数据分析失败', true);
  }
})();
