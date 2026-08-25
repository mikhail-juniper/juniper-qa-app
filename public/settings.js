/* Juniper QA/QC Report - Settings page */

let I18N = {};
let currentOptions = { creators: [], factoryCodes: [], qaLeads: [], pointCheckRates: [] };
let currentCreatorTiers = { defaultTier: 2, tiers: {} };
let currentAqlRecommendation = null;
let currentUnitCosts = null;
let currentFits = null;
let selectedFitKey = '';
let draftNewFit = { label_en: '', label_zh: '', group: 'other', points: [], pointLabels: {}, sizes: {} };
let draftNewFitKey = '';
let dirty = false;

const NEW_FIT_SENTINEL = '__new_fit__';
const FIT_GROUPS = ['hoodie', 'crewnecks', 't_shirt', 'jacket', 'hat', 'other'];

const LISTS = [
  { key: 'factoryCodes', labelKey: 'factoryCode', pluralEn: 'Factory Codes', pluralZh: '工厂代码' },
  { key: 'creators', labelKey: 'creator', pluralEn: 'Creators / Brands', pluralZh: '创作者 / 品牌方' },
  { key: 'qaLeads', labelKey: 'qaLead', pluralEn: 'QA/QC Leads', pluralZh: 'QA/QC 负责人' }
];
const RISKS = ['high', 'medium', 'low'];
const BANDS = ['>20k', '5-20k', '<5k'];
const CATEGORY_LABELS = {
  apparel: { en: 'Apparel', zh: '服装' },
  bags: { en: 'Bags', zh: '箱包' },
  accessories: { en: 'Accessories', zh: '配件' },
  plush: { en: 'Plush Toys', zh: '毛绒玩具' }
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

async function loadEverything() {
  try {
    const [configRes, optionsRes, tiersRes, recRes, costsRes, fitsRes] = await Promise.all([
      fetch('/api/config'),
      fetch('/api/options'),
      fetch('/api/creator-tiers'),
      fetch('/api/aql-recommendation'),
      fetch('/api/unit-costs'),
      fetch('/api/fits')
    ]);
    const config = await configRes.json();
    I18N = config.i18n || {};
    currentOptions = await optionsRes.json();
    currentCreatorTiers = await tiersRes.json();
    currentAqlRecommendation = await recRes.json();
    currentUnitCosts = await costsRes.json();
    currentFits = await fitsRes.json();
  } catch (e) {
    console.error(e);
    showToast('Failed to load settings / 加载设置失败', true);
  }
}

function render() {
  const root = document.getElementById('settingsRoot');
  root.innerHTML = `
    <a href="index.html" class="btn btn-secondary" style="display:inline-block;width:auto;padding:10px 18px;margin-bottom:16px;text-decoration:none;">
      ← ${escapeHtml(bi('backToApp').en)} / ${escapeHtml(bi('backToApp').zh)}
    </a>
    <div class="step-title">${escapeHtml(bi('manageDropdowns').en)}<span class="zh">${escapeHtml(bi('manageDropdowns').zh)}</span></div>
    <div class="section-help" style="margin-bottom:16px;">${escapeHtml(bi('manageDropdownsHelp').en)}<br/>${escapeHtml(bi('manageDropdownsHelp').zh)}</div>
    ${LISTS.map(renderListCard).join('')}

    ${renderCreatorTiersCard()}
    ${renderAqlTableCard()}
    ${renderUnitCostsCard()}
    ${renderFitsCard()}

    <div class="nav-buttons">
      <button class="btn btn-primary" id="btnSave">${escapeHtml(bi('saveSettings').en)} / ${escapeHtml(bi('saveSettings').zh)}</button>
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
      <div class="section-title">${escapeHtml(def.pluralZh)}<span class="zh">${escapeHtml(def.pluralEn)}</span></div>
      <div class="settings-list" id="list_${def.key}">
        ${rows || `<div class="section-help">No entries yet.</div>`}
      </div>
      <div class="field-row" style="margin-top:12px;">
        <input type="text" id="add_input_${def.key}" placeholder="${escapeHtml(l.en)}..." style="flex:1;" />
        <button type="button" class="btn btn-secondary" style="flex:0 0 auto;" data-add-item="${def.key}">
          ${escapeHtml(bi('addOption').en)} / ${escapeHtml(bi('addOption').zh)}
        </button>
      </div>
    </div>
  `;
}

/* ---- Creator Tiers ---- */
function renderCreatorTiersCard() {
  const tiers = currentCreatorTiers.tiers || {};
  const names = Object.keys(tiers).sort((a, b) => a.localeCompare(b));
  const rows = names.map((name) => `
    <div class="settings-item" data-creator-row="${escapeHtml(name)}">
      <span style="flex:1;">${escapeHtml(name)}</span>
      <select data-creator-tier="${escapeHtml(name)}" style="width:64px; padding:6px; margin-right:8px;">
        ${[1, 2, 3].map((t) => `<option value="${t}" ${tiers[name] === t ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
      <button type="button" class="settings-remove" data-remove-creator="${escapeHtml(name)}">✕</button>
    </div>
  `).join('');

  return `
    <div class="card">
      <div class="section-title">${escapeHtml(bi('manageCreatorTiers').en)}<span class="zh">${escapeHtml(bi('manageCreatorTiers').zh)}</span></div>
      <div class="section-help">${escapeHtml(bi('manageCreatorTiersHelp').en)}<br/>${escapeHtml(bi('manageCreatorTiersHelp').zh)}</div>
      <div class="field" style="margin-top:10px;">
        <label class="field-label">${escapeHtml(bi('defaultTierLabel').en)}</label>
        <select id="defaultTierSelect" style="max-width:120px;">
          ${[1, 2, 3].map((t) => `<option value="${t}" ${currentCreatorTiers.defaultTier === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="settings-list" id="list_creatorTiers" style="max-height:320px; margin-top:10px;">
        ${rows || `<div class="section-help">No entries yet.</div>`}
      </div>
      <div class="field-row" style="margin-top:12px;">
        <input type="text" id="add_creator_name" placeholder="Creator name..." style="flex:1;" />
        <select id="add_creator_tier" style="width:64px;">
          <option value="1">1</option><option value="2" selected>2</option><option value="3">3</option>
        </select>
        <button type="button" class="btn btn-secondary" style="flex:0 0 auto;" id="btnAddCreatorTier">
          ${escapeHtml(bi('addOption').en)} / ${escapeHtml(bi('addOption').zh)}
        </button>
      </div>
    </div>
  `;
}

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
      <div class="section-title">${escapeHtml(bi('manageAqlTable').en)}<span class="zh">${escapeHtml(bi('manageAqlTable').zh)}</span></div>
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
        <div class="section-photos-label">${escapeHtml(label.zh || label.en)} <span class="zh">${escapeHtml(label.en)}</span></div>
        ${rows}
      </div>
    `;
  }).join('');

  return `
    <div class="card">
      <div class="section-title">${escapeHtml(bi('manageUnitCosts').en)}<span class="zh">${escapeHtml(bi('manageUnitCosts').zh)}</span></div>
      <div class="section-help">${escapeHtml(bi('manageUnitCostsHelp').en)}<br/>${escapeHtml(bi('manageUnitCostsHelp').zh)}</div>
      ${catBlocks}
      <div class="field-row" style="margin-top:10px; align-items:center;">
        <span style="flex:1; font-size:13.5px;">Other category (top-level) <span class="zh">其他（顶层类别）</span></span>
        <span style="margin-right:4px;">$</span>
        <input type="number" min="0" step="0.5" value="${currentUnitCosts.otherCategoryFlat}" id="otherCategoryFlatInput" style="width:90px;" />
      </div>
    </div>
  `;
}

/* ---- Apparel Sizing Charts (fits.json) ---- */
function parseFitValue(str) {
  const s = String(str).trim();
  if (!s) return undefined;
  const rangeMatch = s.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
  if (rangeMatch) return { min: parseFloat(rangeMatch[1]), max: parseFloat(rangeMatch[2]) };
  const n = parseFloat(s);
  return isNaN(n) ? undefined : n;
}
function formatFitValue(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return `${v.min}-${v.max}`;
  return String(v);
}
function slugify(str) {
  return String(str).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'new_fit';
}

function renderFitsCard() {
  if (!currentFits) return '';
  const fitKeys = Object.keys(currentFits.fits).sort();
  const options = fitKeys.map((k) => {
    const f = currentFits.fits[k];
    return `<option value="${escapeHtml(k)}" ${selectedFitKey === k ? 'selected' : ''}>${escapeHtml(f.label_zh)} ${escapeHtml(f.label_en)}</option>`;
  }).join('');

  let editorHtml = '';
  if (selectedFitKey === NEW_FIT_SENTINEL) {
    editorHtml = renderFitEditor(NEW_FIT_SENTINEL, draftNewFit);
  } else if (selectedFitKey && currentFits.fits[selectedFitKey]) {
    editorHtml = renderFitEditor(selectedFitKey, currentFits.fits[selectedFitKey]);
  }

  return `
    <div class="card">
      <div class="section-title">${escapeHtml(bi('manageFitsTitle').en)}<span class="zh">${escapeHtml(bi('manageFitsTitle').zh)}</span></div>
      <div class="section-help">${escapeHtml(bi('manageFitsHelp').en)}<br/>${escapeHtml(bi('manageFitsHelp').zh)}</div>
      <div class="field" style="margin-top:10px;">
        <label class="field-label">${escapeHtml(bi('selectStandard').en)} <span class="zh">${escapeHtml(bi('selectStandard').zh)}</span></label>
        <select id="fitSelectSetting">
          <option value="">${escapeHtml(bi('selectPlaceholder').en)}</option>
          ${options}
          <option value="${NEW_FIT_SENTINEL}" ${selectedFitKey === NEW_FIT_SENTINEL ? 'selected' : ''}>${escapeHtml(bi('addNewStandard').en)} ${escapeHtml(bi('addNewStandard').zh)}</option>
        </select>
      </div>
      <div id="fitEditorArea">${editorHtml}</div>
    </div>
  `;
}

function renderFitEditor(key, fit) {
  const points = fit.points || [];
  const sizes = fit.sizes || {};
  const sizeNames = Object.keys(sizes);

  const pointHeaderCells = points.map((p) => {
    const pl = fit.pointLabels[p] || { en: p, zh: '' };
    return `
      <th>
        <input type="text" class="fit-point-label" data-point-label-zh="${escapeHtml(p)}" value="${escapeHtml(pl.zh)}" placeholder="中文" style="width:70px; margin-bottom:3px;" />
        <input type="text" class="fit-point-label" data-point-label-en="${escapeHtml(p)}" value="${escapeHtml(pl.en)}" placeholder="EN" style="width:70px;" />
        <button type="button" class="settings-remove" data-remove-point="${escapeHtml(p)}">✕</button>
      </th>
    `;
  }).join('');

  const sizeRowsHtml = sizeNames.map((sizeName) => {
    const cells = points.map((p) => `
      <td><input type="text" data-fit-cell="${escapeHtml(sizeName)}|${escapeHtml(p)}" value="${escapeHtml(formatFitValue(sizes[sizeName][p]))}" style="width:70px;" placeholder="24 or 24-26" /></td>
    `).join('');
    return `
      <tr>
        <td class="size-name">
          <input type="text" data-size-name-rename="${escapeHtml(sizeName)}" value="${escapeHtml(sizeName)}" style="width:130px;" />
          <button type="button" class="settings-remove" data-remove-size="${escapeHtml(sizeName)}">✕</button>
        </td>
        ${cells}
      </tr>
    `;
  }).join('');

  return `
    <div style="margin-top:12px; padding-top:12px; border-top:1px dashed var(--jc-border);">
      <div class="field-row">
        <div style="flex:1"><label class="field-label">${escapeHtml(bi('fitLabelZh').en)}</label><input type="text" id="fitLabelZh" value="${escapeHtml(fit.label_zh)}" /></div>
        <div style="flex:1"><label class="field-label">${escapeHtml(bi('fitLabelEn').en)}</label><input type="text" id="fitLabelEn" value="${escapeHtml(fit.label_en)}" /></div>
      </div>
      <div class="field">
        <label class="field-label">${escapeHtml(bi('fitGroupLabel').en)}</label>
        <select id="fitGroupSelect">
          ${FIT_GROUPS.map((g) => `<option value="${g}" ${fit.group === g ? 'selected' : ''}>${g}</option>`).join('')}
        </select>
      </div>
      ${key === NEW_FIT_SENTINEL ? `
        <div class="field">
          <label class="field-label">${escapeHtml(bi('fitKeyLabel').en)}</label>
          <input type="text" id="fitKeyInput" placeholder="${escapeHtml(bi('fitKeyPlaceholder').en)}" />
        </div>
      ` : ''}

      <div class="size-table-wrap" style="margin-top:10px;">
        <table class="size-table">
          <thead><tr><th></th>${pointHeaderCells}</tr></thead>
          <tbody>${sizeRowsHtml}</tbody>
        </table>
      </div>
      <div class="field-row" style="margin-top:10px;">
        <button type="button" class="btn btn-secondary" id="btnAddFitSize" style="flex:1;">${escapeHtml(bi('addSizeRow').en)}</button>
        <button type="button" class="btn btn-secondary" id="btnAddFitPoint" style="flex:1;">${escapeHtml(bi('addMeasurementPoint').en)}</button>
      </div>
      ${key !== NEW_FIT_SENTINEL ? `<button type="button" class="settings-remove" id="btnDeleteFit" style="margin-top:10px;">${escapeHtml(bi('deleteStandard').en)}</button>` : ''}
    </div>
  `;
}

function getEditingFitRef() {
  if (selectedFitKey === NEW_FIT_SENTINEL) return draftNewFit;
  return currentFits.fits[selectedFitKey];
}
function attachFitEditorHandlers() {
  const fit = getEditingFitRef();
  if (!fit) return;

  const labelZh = document.getElementById('fitLabelZh');
  if (labelZh) labelZh.addEventListener('input', (e) => { fit.label_zh = e.target.value; dirty = true; });
  const labelEn = document.getElementById('fitLabelEn');
  if (labelEn) labelEn.addEventListener('input', (e) => { fit.label_en = e.target.value; dirty = true; });
  const groupSelect = document.getElementById('fitGroupSelect');
  if (groupSelect) groupSelect.addEventListener('change', (e) => { fit.group = e.target.value; dirty = true; });
  const keyInput = document.getElementById('fitKeyInput');
  if (keyInput) keyInput.addEventListener('input', (e) => { draftNewFitKey = e.target.value; dirty = true; });

  document.querySelectorAll('[data-point-label-en]').forEach((el) => {
    el.addEventListener('input', (e) => {
      const p = el.getAttribute('data-point-label-en');
      fit.pointLabels[p] = fit.pointLabels[p] || { en: '', zh: '' };
      fit.pointLabels[p].en = e.target.value;
      dirty = true;
    });
  });
  document.querySelectorAll('[data-point-label-zh]').forEach((el) => {
    el.addEventListener('input', (e) => {
      const p = el.getAttribute('data-point-label-zh');
      fit.pointLabels[p] = fit.pointLabels[p] || { en: '', zh: '' };
      fit.pointLabels[p].zh = e.target.value;
      dirty = true;
    });
  });
  document.querySelectorAll('[data-remove-point]').forEach((el) => {
    el.addEventListener('click', () => {
      const p = el.getAttribute('data-remove-point');
      fit.points = fit.points.filter((x) => x !== p);
      delete fit.pointLabels[p];
      Object.values(fit.sizes).forEach((s) => delete s[p]);
      dirty = true;
      render();
    });
  });
  document.querySelectorAll('[data-fit-cell]').forEach((el) => {
    el.addEventListener('input', (e) => {
      const [sizeName, p] = el.getAttribute('data-fit-cell').split('|');
      const val = parseFitValue(e.target.value);
      if (val === undefined) delete fit.sizes[sizeName][p];
      else fit.sizes[sizeName][p] = val;
      dirty = true;
    });
  });
  document.querySelectorAll('[data-size-name-rename]').forEach((el) => {
    el.addEventListener('change', (e) => {
      const oldName = el.getAttribute('data-size-name-rename');
      const newName = e.target.value.trim();
      if (!newName || newName === oldName) return;
      fit.sizes[newName] = fit.sizes[oldName];
      delete fit.sizes[oldName];
      dirty = true;
      render();
    });
  });
  document.querySelectorAll('[data-remove-size]').forEach((el) => {
    el.addEventListener('click', () => {
      delete fit.sizes[el.getAttribute('data-remove-size')];
      dirty = true;
      render();
    });
  });
  const btnAddFitSize = document.getElementById('btnAddFitSize');
  if (btnAddFitSize) {
    btnAddFitSize.addEventListener('click', () => {
      let name = 'New Size', i = 1;
      while (fit.sizes[name]) { i += 1; name = `New Size ${i}`; }
      fit.sizes[name] = {};
      dirty = true;
      render();
    });
  }
  const btnAddFitPoint = document.getElementById('btnAddFitPoint');
  if (btnAddFitPoint) {
    btnAddFitPoint.addEventListener('click', () => {
      const label = prompt('New measurement point - English label:');
      if (!label) return;
      const key = slugify(label);
      if (fit.points.includes(key)) { showToast('That point already exists / 该测量项已存在', true); return; }
      fit.points.push(key);
      fit.pointLabels[key] = { en: label, zh: '' };
      dirty = true;
      render();
    });
  }
  const btnDeleteFit = document.getElementById('btnDeleteFit');
  if (btnDeleteFit) {
    btnDeleteFit.addEventListener('click', () => {
      if (!confirm(`Delete "${fit.label_en}"? This applies once you Save.`)) return;
      delete currentFits.fits[selectedFitKey];
      selectedFitKey = '';
      dirty = true;
      render();
    });
  }
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

  // Creator tiers
  const defaultTierSelect = document.getElementById('defaultTierSelect');
  if (defaultTierSelect) {
    defaultTierSelect.addEventListener('change', (e) => {
      currentCreatorTiers.defaultTier = parseInt(e.target.value, 10);
      dirty = true;
    });
  }
  document.querySelectorAll('[data-creator-tier]').forEach((el) => {
    el.addEventListener('change', (e) => {
      currentCreatorTiers.tiers[el.getAttribute('data-creator-tier')] = parseInt(e.target.value, 10);
      dirty = true;
    });
  });
  document.querySelectorAll('[data-remove-creator]').forEach((el) => {
    el.addEventListener('click', () => {
      delete currentCreatorTiers.tiers[el.getAttribute('data-remove-creator')];
      dirty = true;
      render();
    });
  });
  const btnAddCreatorTier = document.getElementById('btnAddCreatorTier');
  if (btnAddCreatorTier) {
    btnAddCreatorTier.addEventListener('click', () => {
      const nameInput = document.getElementById('add_creator_name');
      const tierInput = document.getElementById('add_creator_tier');
      const name = (nameInput.value || '').trim();
      if (!name) return;
      currentCreatorTiers.tiers[name] = parseInt(tierInput.value, 10);
      dirty = true;
      render();
    });
  }

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

  // Apparel sizing charts
  const fitSelectSetting = document.getElementById('fitSelectSetting');
  if (fitSelectSetting) {
    fitSelectSetting.addEventListener('change', (e) => {
      selectedFitKey = e.target.value;
      render();
    });
  }
  attachFitEditorHandlers();

  const btnSave = document.getElementById('btnSave');
  if (btnSave) btnSave.addEventListener('click', saveSettings);
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
    // Commit a pending "new standard" draft into currentFits.fits before saving.
    if (selectedFitKey === NEW_FIT_SENTINEL && draftNewFit.label_en.trim()) {
      const finalKey = slugify(draftNewFitKey || draftNewFit.label_en);
      if (currentFits.fits[finalKey]) {
        showToast('A standard with that key already exists / 已存在相同标识的标准', true);
        btn.disabled = false;
        btn.innerHTML = originalText;
        return;
      }
      currentFits.fits[finalKey] = draftNewFit;
      selectedFitKey = finalKey;
      draftNewFit = { label_en: '', label_zh: '', group: 'other', points: [], pointLabels: {}, sizes: {} };
      draftNewFitKey = '';
    }

    const results = await Promise.all([
      fetch('/api/options', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creators: currentOptions.creators, factoryCodes: currentOptions.factoryCodes, qaLeads: currentOptions.qaLeads })
      }),
      fetch('/api/creator-tiers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tiers: currentCreatorTiers.tiers, defaultTier: currentCreatorTiers.defaultTier })
      }),
      fetch('/api/aql-recommendation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table: currentAqlRecommendation.table })
      }),
      fetch('/api/unit-costs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories: currentUnitCosts.categories, otherCategoryFlat: currentUnitCosts.otherCategoryFlat })
      }),
      fetch('/api/fits', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fits: currentFits.fits })
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
