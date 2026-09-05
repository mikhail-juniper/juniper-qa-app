/* Juniper QA/QC Report - Settings page */

let I18N = {};
let currentOptions = { creators: [], factoryCodes: [], qaLeads: [], pointCheckRates: [], sourcers: [] };
let currentCreatorTiers = { defaultTier: 2, tiers: {} };
let currentAqlRecommendation = null;
let currentUnitCosts = null;
let dirty = false;
let backupStatus = null;
let scheduledBackups = [];
let restoreMode = 'ignore';
let restoreResult = null;
let restoreInProgress = false;

const LISTS = [
  { key: 'qaLeads', labelKey: 'qaLead', pluralEn: 'QA/QC Leads', pluralZh: 'QA/QC 负责人' },
  { key: 'productDevelopmentLeads', labelKey: 'productDevelopmentLead', pluralEn: 'Product Development Leads', pluralZh: '产品开发负责人' },
  { key: 'sourcers', labelKey: 'sourcer', pluralEn: 'Sourcers', pluralZh: '采购负责人' }
];
const RISKS = ['high', 'medium', 'low'];
const BANDS = ['>20k', '5-20k', '<5k'];
const CATEGORY_LABELS = {
  apparel: { en: 'Apparel', zh: '服装' },
  bags: { en: 'Bags', zh: '箱包' },
  accessories: { en: 'Accessories', zh: '配件' },
  plush: { en: 'Plush Toys', zh: '毛绒玩具' }
};

/* One active language at a time, chosen with the header toggle (see
 * i18n-shared.js). The returned shape is unchanged so every existing
 * biHtml/biBlockHtml call site still works - the secondary slot is just
 * always empty now, which makes those helpers render a single language. */
/** True when the header toggle is set to English. Used by the few labels
 *  built from raw config data rather than the i18n table. */
function langIsEn() {
  return ((window.JuniperLang && window.JuniperLang.get()) || 'zh') === 'en';
}

function bi(key, fallback) {
  const e = I18N[key];
  if (!e) return { en: fallback || key, zh: '' };
  const lang = (window.JuniperLang && window.JuniperLang.get()) || 'zh';
  const primary = lang === 'en' ? (e.en || e.zh) : (e.zh || e.en);
  return { en: primary || fallback || key, zh: '' };
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

async function loadEverything() {
  try {
    const [configRes, optionsRes, tiersRes, recRes, costsRes, backupStatusRes, scheduledBackupsRes] = await Promise.all([
      fetch('/api/config'),
      fetch('/api/options'),
      fetch('/api/creator-tiers'),
      fetch('/api/aql-recommendation'),
      fetch('/api/unit-costs'),
      fetch('/api/backup/status'),
      fetch('/api/backup/scheduled')
    ]);
    const config = await configRes.json();
    I18N = config.i18n || {};
    currentOptions = await optionsRes.json();
    currentCreatorTiers = await tiersRes.json();
    currentAqlRecommendation = await recRes.json();
    currentUnitCosts = await costsRes.json();
    backupStatus = await backupStatusRes.json();
    scheduledBackups = (await scheduledBackupsRes.json()).backups || [];
  } catch (e) {
    console.error(e);
    showToast('Failed to load settings / 加载设置失败', true);
  }
}

/* ---- Backup: download everything, and flag if DATA_DIR isn't set up
 * right (which is otherwise invisible - it looks fine until a deploy wipes
 * it). ---- */
function renderBackupCard() {
  const warning = backupStatus && backupStatus.warning
    ? `<div class="card" style="background:#fde2e1; border-color:var(--jc-fail);">
        <div class="section-title" style="color:var(--jc-fail);">⚠ ${escapeHtml(bi('dataDirWarningTitle', 'Data storage is not set up correctly').en)}</div>
        <div class="section-help" style="color:var(--jc-text);">${escapeHtml(backupStatus.warning)}</div>
      </div>`
    : '';
  const resultBanner = restoreResult
    ? `<div class="section-help" style="margin-top:10px; padding:10px; border-radius:var(--radius-sm); background:var(--jc-mint-light); color:var(--jc-teal-dark);">
        ${escapeHtml(bi('restoreResultAdded', 'Added').en)}: ${restoreResult.added} · ${escapeHtml(bi('restoreResultOverridden', 'Replaced').en)}: ${restoreResult.overridden} · ${escapeHtml(bi('restoreResultSkipped', 'Skipped (already existed)').en)}: ${restoreResult.skipped}
      </div>`
    : '';
  return `
    <div class="card">
      <div class="section-title">${escapeHtml(bi('backupTitle', 'Backup').en)}</div>
      <div class="section-help">${escapeHtml(bi('backupHelp').en)}<br/>${escapeHtml(bi('backupHelp').zh)}</div>
      ${warning}
      <a href="/api/backup/download" class="btn btn-primary" style="display:inline-block; width:auto; padding:10px 18px; text-decoration:none; margin-top:10px;">${escapeHtml(bi('downloadBackup').en)}</a>

      <div style="margin-top:16px;">
        <div class="section-title" style="font-size:14px;">Automatic weekly backups</div>
        <div class="section-help">A backup is saved automatically about once a week - this list is just a safety net alongside the manual download above.</div>
        ${scheduledBackups.length ? `
          <div class="settings-list" style="margin-top:8px;">
            ${scheduledBackups.map((b) => `
              <div class="settings-item">
                <span>${escapeHtml(b.filename)} &middot; ${new Date(b.createdAt).toLocaleDateString()} &middot; ${(b.sizeBytes / 1024 / 1024).toFixed(1)} MB</span>
                <a href="/api/backup/scheduled/${encodeURIComponent(b.filename)}" style="font-weight:600;">Download</a>
              </div>
            `).join('')}
          </div>
        ` : `<div class="section-help">No automatic backups yet - the first one is created shortly after this app starts.</div>`}
      </div>

      <div style="margin-top:20px; padding-top:16px; border-top:1px solid var(--jc-border);">
        <div class="section-title" style="font-size:15px;">${escapeHtml(bi('restoreBackupTitle', 'Restore from Backup').en)}</div>
        <div class="section-help">${escapeHtml(bi('restoreBackupHelp', "Upload a previously downloaded backup zip. Any PO it contains that isn't already in the system gets added. Choose below what happens for a PO that already exists.").en)}<br/>${escapeHtml(bi('restoreBackupHelp').zh)}</div>
        <div class="field" style="margin-top:10px;">
          <label class="field-label">${escapeHtml(bi('duplicatePoHandling', 'If a PO already exists').en)}</label>
          <select id="restoreModeSelect">
            <option value="ignore" ${restoreMode === 'ignore' ? 'selected' : ''}>${escapeHtml(bi('restoreModeIgnore', 'Skip it - keep the current data').en)}</option>
            <option value="override" ${restoreMode === 'override' ? 'selected' : ''}>${escapeHtml(bi('restoreModeOverride', 'Replace it with the backup version').en)}</option>
          </select>
        </div>
        <input type="file" id="restoreFileInput" accept=".zip" style="margin-top:10px;" ${restoreInProgress ? 'disabled' : ''} />
        ${resultBanner}
      </div>
    </div>
  `;
}

function render() {
  const root = document.getElementById('settingsRoot');
  root.innerHTML = `
    <a href="index.html" class="btn btn-secondary" style="display:inline-block;width:auto;padding:10px 18px;margin-bottom:16px;text-decoration:none;">
      ← ${escapeHtml(bi('backToApp').en)}
    </a>
    <div class="step-title">${escapeHtml(bi('manageDropdowns').en)}<span class="zh">${escapeHtml(bi('manageDropdowns').zh)}</span></div>
    <div class="section-help" style="margin-bottom:16px;">${escapeHtml(bi('manageDropdownsHelp').en)}<br/>${escapeHtml(bi('manageDropdownsHelp').zh)}</div>
    ${renderBackupCard()}
    ${LISTS.map(renderListCard).join('')}

    ${renderAqlTableCard()}
    ${renderUnitCostsCard()}
    <div class="card">
      <div class="section-title">Apparel Sizing Charts</div>
      <div class="section-help">Moved to its own page under Product Information, since it's now the shared source of truth for sizing standards across Order Management too, not just QA/QC reporting.</div>
      <a href="sizing-charts.html" class="btn btn-secondary" style="display:inline-block;width:auto;padding:9px 18px;text-decoration:none;margin-top:8px;">Go to Sizing Charts →</a>
    </div>

    <div class="nav-buttons">
      <button class="btn btn-primary" id="btnSave">${escapeHtml(bi('saveSettings').en)}</button>
    </div>
  `;
  attachHandlers();
}

/* ---- Dropdown lists (existing) ---- */
function renderListCard(def) {
  const items = currentOptions[def.key] || [];
  const l = bi(def.labelKey);
  const rows = items.map((item, idx) => `
    <div class="settings-item" data-list="${def.key}" data-idx="${idx}">
      <span>${escapeHtml(item)}</span>
      <button type="button" class="settings-remove" data-remove-item="${def.key}" data-idx="${idx}">✕</button>
    </div>
  `).join('');

  return `
    <div class="card">
      <div class="section-title">${escapeHtml(langIsEn() ? def.pluralEn : def.pluralZh)}</div>
      <div class="settings-list" id="list_${def.key}">
        ${rows || `<div class="section-help">No entries yet.</div>`}
      </div>
      <div class="field-row" style="margin-top:12px;">
        <input type="text" id="add_input_${def.key}" placeholder="${escapeHtml(l.en)}..." style="flex:1;" />
        <button type="button" class="btn btn-secondary" style="flex:0 0 auto;" data-add-item="${def.key}">
          ${escapeHtml(bi('addOption').en)}
        </button>
      </div>
    </div>
  `;
}

/* ---- Creator Tiers: moved to the "Clients" page under Product Information ---- */

/* ---- AQL Recommendation Table ---- */
function renderAqlTableCard() {
  if (!currentAqlRecommendation) return '';
  const tierBlocks = ['1', '2', '3'].map((tier) => {
    const rows = RISKS.map((risk) => {
      const cells = BANDS.map((band) => {
        const cell = currentAqlRecommendation.table[tier][risk][band];
        return `
          <td>
            <input type="text" value="${escapeHtml(cell.pointCheck)}" data-aql-cell="${tier}|${risk}|${band}|pointCheck" style="width:80px; margin-bottom:4px;" />
            <select data-aql-cell="${tier}|${risk}|${band}|inspectionLevel" style="width:56px;">
              ${[1, 2, 3].map((l) => `<option value="${l}" ${cell.inspectionLevel === l ? 'selected' : ''}>L${l}</option>`).join('')}
            </select>
          </td>
        `;
      }).join('');
      return `<tr><td class="size-name">${risk}</td>${cells}</tr>`;
    }).join('');

    return `
      <div style="margin-top:10px;">
        <div class="section-photos-label">Tier ${tier}</div>
        <div class="size-table-wrap">
          <table class="size-table">
            <thead><tr><th></th>${BANDS.map((b) => `<th>${escapeHtml(b)}</th>`).join('')}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="card">
      <div class="section-title">QA/QC Recommendation Table</div>
      <div class="section-help">${escapeHtml(bi('manageAqlTableHelp').en)}<br/>${escapeHtml(bi('manageAqlTableHelp').zh)}</div>
      ${tierBlocks}
    </div>
  `;
}

/* ---- Unit Costs ---- */
function renderUnitCostsCard() {
  if (!currentUnitCosts) return '';
  const catBlocks = Object.keys(currentUnitCosts.categories).map((cat) => {
    const label = CATEGORY_LABELS[cat] || { en: cat, zh: '' };
    const subs = currentUnitCosts.categories[cat];
    const rows = Object.keys(subs).map((sub) => `
      <div class="field-row" style="margin-bottom:8px; align-items:center;">
        <span style="flex:1; font-size:13.5px; text-transform:capitalize;">${escapeHtml(sub)}</span>
        <span style="margin-right:4px;">$</span>
        <input type="number" min="0" step="0.5" value="${subs[sub]}" data-unit-cost="${cat}|${sub}" style="width:90px;" />
      </div>
    `).join('');
    return `
      <div style="margin-top:10px;">
        <div class="section-photos-label">${escapeHtml(langIsEn() ? (label.en || label.zh) : (label.zh || label.en))}</div>
        ${rows}
      </div>
    `;
  }).join('');

  return `
    <div class="card">
      <div class="section-title">${escapeHtml(bi('manageUnitCosts').en)}<span class="zh">${escapeHtml(bi('manageUnitCosts').zh)}</span></div>
      <div class="section-help">${escapeHtml(bi('manageUnitCostsHelp').en)}<br/>${escapeHtml(bi('manageUnitCostsHelp').zh)}</div>
      <div class="section-help" style="margin-top:6px; padding:8px 10px; background:var(--jc-mint-light); border-radius:var(--radius-sm); color:var(--jc-teal-dark);">
        A real factory price from a matching Order Management PO is now used automatically when one exists for a SKU (converted from RMB using the rate below). This table is only the fallback for SKUs without PO data yet.
      </div>
      <div class="field-row" style="margin-top:10px; align-items:center;">
        <span style="flex:1; font-size:13.5px;">RMB → USD exchange rate <span class="zh">人民币兑美元汇率</span></span>
        <span style="margin-right:4px;">¥1 =</span>
        <input type="number" min="0" step="0.001" value="${currentUnitCosts.rmbToUsdRate || 0.14}" id="rmbToUsdRateInput" style="width:90px;" />
        <span style="margin-left:4px;">$</span>
      </div>
      ${catBlocks}
      <div class="field-row" style="margin-top:10px; align-items:center;">
        <span style="flex:1; font-size:13.5px;">Other category (top-level) <span class="zh">其他（顶层类别）</span></span>
        <span style="margin-right:4px;">$</span>
        <input type="number" min="0" step="0.5" value="${currentUnitCosts.otherCategoryFlat}" id="otherCategoryFlatInput" style="width:90px;" />
      </div>
    </div>
  `;
}

function attachHandlers() {
  document.querySelectorAll('[data-remove-item]').forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.getAttribute('data-remove-item');
      const idx = parseInt(el.getAttribute('data-idx'), 10);
      currentOptions[key].splice(idx, 1);
      dirty = true;
      render();
    });
  });
  document.querySelectorAll('[data-add-item]').forEach((el) => {
    el.addEventListener('click', () => addItem(el.getAttribute('data-add-item')));
  });
  LISTS.forEach((def) => {
    const input = document.getElementById(`add_input_${def.key}`);
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addItem(def.key); }
      });
    }
  });

  // AQL table
  document.querySelectorAll('[data-aql-cell]').forEach((el) => {
    el.addEventListener('change', (e) => {
      const [tier, risk, band, field] = el.getAttribute('data-aql-cell').split('|');
      const cell = currentAqlRecommendation.table[tier][risk][band];
      cell[field] = field === 'inspectionLevel' ? parseInt(e.target.value, 10) : e.target.value;
      dirty = true;
    });
  });

  // Unit costs
  document.querySelectorAll('[data-unit-cost]').forEach((el) => {
    el.addEventListener('change', (e) => {
      const [cat, sub] = el.getAttribute('data-unit-cost').split('|');
      const n = parseFloat(e.target.value);
      if (!isNaN(n)) currentUnitCosts.categories[cat][sub] = n;
      dirty = true;
    });
  });
  const otherFlatInput = document.getElementById('otherCategoryFlatInput');
  if (otherFlatInput) {
    otherFlatInput.addEventListener('change', (e) => {
      const n = parseFloat(e.target.value);
      if (!isNaN(n)) currentUnitCosts.otherCategoryFlat = n;
      dirty = true;
    });
  }
  const rmbRateInput = document.getElementById('rmbToUsdRateInput');
  if (rmbRateInput) {
    rmbRateInput.addEventListener('change', (e) => {
      const n = parseFloat(e.target.value);
      if (!isNaN(n) && n > 0) currentUnitCosts.rmbToUsdRate = n;
      dirty = true;
    });
  }

  const btnSave = document.getElementById('btnSave');
  if (btnSave) btnSave.addEventListener('click', saveSettings);

  const restoreModeSelect = document.getElementById('restoreModeSelect');
  if (restoreModeSelect) restoreModeSelect.addEventListener('change', (e) => { restoreMode = e.target.value; });

  const restoreFileInput = document.getElementById('restoreFileInput');
  if (restoreFileInput) {
    restoreFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const modeLabel = restoreMode === 'override'
        ? 'Replace any PO that already exists with the backup version? This cannot be undone.'
        : 'Add any POs from this backup that are missing, skipping ones that already exist?';
      if (!confirm(modeLabel)) { restoreFileInput.value = ''; return; }

      restoreInProgress = true;
      restoreResult = null;
      render();

      try {
        const formData = new FormData();
        formData.append('backup', file);
        formData.append('mode', restoreMode);
        const res = await fetch('/api/backup/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Restore failed');
        restoreResult = data;
        showToast(`Restore complete - ${data.added} added, ${data.overridden} replaced, ${data.skipped} skipped.`);
      } catch (err) {
        showToast(err.message || 'Restore failed', true);
      } finally {
        restoreInProgress = false;
        render();
      }
    });
  }
}

function addItem(key) {
  const input = document.getElementById(`add_input_${key}`);
  const value = (input.value || '').trim();
  if (!value) return;
  if (currentOptions[key].includes(value)) {
    showToast('Already in the list / 已在列表中', true);
    return;
  }
  currentOptions[key].push(value);
  dirty = true;
  render();
}

async function saveSettings() {
  const btn = document.getElementById('btnSave');
  btn.disabled = true;
  const originalText = btn.innerHTML;
  btn.innerHTML = `<span class="spinner"></span>...`;
  try {
    const results = await Promise.all([
      fetch('/api/options', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creators: currentOptions.creators, factoryCodes: currentOptions.factoryCodes, qaLeads: currentOptions.qaLeads, productDevelopmentLeads: currentOptions.productDevelopmentLeads, sourcers: currentOptions.sourcers })
      }),
      fetch('/api/aql-recommendation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table: currentAqlRecommendation.table })
      }),
      fetch('/api/unit-costs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories: currentUnitCosts.categories, otherCategoryFlat: currentUnitCosts.otherCategoryFlat, rmbToUsdRate: currentUnitCosts.rmbToUsdRate })
      })
    ]);
    if (results.some((r) => !r.ok)) throw new Error('Save failed');
    dirty = false;
    showToast(bi('settingsSaved').en + ' / ' + bi('settingsSaved').zh);
    render();
  } catch (e) {
    console.error(e);
    showToast(bi('settingsSaveError').en + ' / ' + bi('settingsSaveError').zh, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

(async function init() {
  await loadEverything();
  render();
})();
