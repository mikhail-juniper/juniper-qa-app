/* Sizing Charts - the single source of truth for apparel sizing standards
 * across the whole app. This IS the original QA/QC "Apparel Sizing Charts"
 * editor (previously in Settings, backed by fits.json) - moved here
 * verbatim rather than reimplemented, since it's load-bearing for
 * tolerance checks during actual inspections (Pre-Production/Bulk
 * reports) and for the "established fit carries forward to the next PO"
 * behavior. The simpler standalone sizing-chart list that used to live on
 * this page has been retired in favor of this one real system.
 */

let I18N = {};
let currentFits = null;
let selectedFitKey = '';
let draftNewFit = { label_en: '', label_zh: '', group: 'other', points: [], pointLabels: {}, sizes: {} };
let draftNewFitKey = '';
let dirty = false;

const NEW_FIT_SENTINEL = '__new_fit__';
const FIT_GROUPS = ['hoodie', 'crewnecks', 't_shirt', 'jacket', 'hat', 'other'];

function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.style.background = isError ? 'var(--jc-fail)' : 'var(--jc-teal-dark)';
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add('hidden'), 3200);
}

function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function bi(key, fallback) {
  const e = I18N[key];
  if (!e) return { en: fallback || key, zh: '' };
  return { en: e.zh, zh: e.en };
}

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
  if (!currentFits) return '<div class="om-empty">Loading...</div>';
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
      <div class="section-title">${escapeHtml(bi('manageFitsTitle', 'Apparel Sizing Charts').en)}<span class="zh">${escapeHtml(bi('manageFitsTitle').zh)}</span></div>
      <div class="section-help">${escapeHtml(bi('manageFitsHelp', 'The full chart, saved standards, and tolerance points used across QA/QC reporting and approval.').en)}<br/>${escapeHtml(bi('manageFitsHelp').zh)}</div>
      <div class="field" style="margin-top:10px;">
        <label class="field-label">${escapeHtml(bi('selectStandard', 'Select a standard').en)} <span class="zh">${escapeHtml(bi('selectStandard').zh)}</span></label>
        <select id="fitSelectSetting">
          <option value="">${escapeHtml(bi('selectPlaceholder', 'Select...').en)}</option>
          ${options}
          <option value="${NEW_FIT_SENTINEL}" ${selectedFitKey === NEW_FIT_SENTINEL ? 'selected' : ''}>${escapeHtml(bi('addNewStandard', '+ Add new standard').en)} ${escapeHtml(bi('addNewStandard').zh)}</option>
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
        <div style="flex:1"><label class="field-label">${escapeHtml(bi('fitLabelZh', 'Label (Chinese)').en)}</label><input type="text" id="fitLabelZh" value="${escapeHtml(fit.label_zh)}" /></div>
        <div style="flex:1"><label class="field-label">${escapeHtml(bi('fitLabelEn', 'Label (English)').en)}</label><input type="text" id="fitLabelEn" value="${escapeHtml(fit.label_en)}" /></div>
      </div>
      <div class="field">
        <label class="field-label">${escapeHtml(bi('fitGroupLabel', 'Group').en)}</label>
        <select id="fitGroupSelect">
          ${FIT_GROUPS.map((g) => `<option value="${g}" ${fit.group === g ? 'selected' : ''}>${g}</option>`).join('')}
        </select>
      </div>
      ${key === NEW_FIT_SENTINEL ? `
        <div class="field">
          <label class="field-label">${escapeHtml(bi('fitKeyLabel', 'Standard key').en)}</label>
          <input type="text" id="fitKeyInput" placeholder="${escapeHtml(bi('fitKeyPlaceholder', 'e.g. crewnecks_standard').en)}" />
        </div>
      ` : ''}

      <div class="size-table-wrap" style="margin-top:10px;">
        <table class="size-table">
          <thead><tr><th></th>${pointHeaderCells}</tr></thead>
          <tbody>${sizeRowsHtml}</tbody>
        </table>
      </div>
      <div class="field-row" style="margin-top:10px;">
        <button type="button" class="btn btn-secondary" id="btnAddFitSize" style="flex:1;">${escapeHtml(bi('addSizeRow', '+ Add size row').en)}</button>
        <button type="button" class="btn btn-secondary" id="btnAddFitPoint" style="flex:1;">${escapeHtml(bi('addMeasurementPoint', '+ Add measurement point').en)}</button>
      </div>
      ${key !== NEW_FIT_SENTINEL ? `<button type="button" class="settings-remove" id="btnDeleteFit" style="margin-top:10px;">${escapeHtml(bi('deleteStandard', 'Delete this standard').en)}</button>` : ''}
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

function render() {
  const root = document.getElementById('scRoot');
  root.innerHTML = `
    <h2 class="om-view-title">Sizing Charts</h2>
    ${renderFitsCard()}
    <div style="margin-top:20px;display:flex;justify-content:flex-end;">
      <button class="btn btn-primary" id="btnSaveFits" style="flex:none;width:auto;padding:10px 24px;" ${dirty ? '' : 'disabled'}>${dirty ? 'Save changes' : 'Saved'}</button>
    </div>
  `;

  const fitSelectSetting = document.getElementById('fitSelectSetting');
  if (fitSelectSetting) {
    fitSelectSetting.addEventListener('change', (e) => {
      selectedFitKey = e.target.value;
      render();
    });
  }
  attachFitEditorHandlers();

  const btnSave = document.getElementById('btnSaveFits');
  if (btnSave) btnSave.addEventListener('click', saveFits);
}

async function saveFits() {
  const btn = document.getElementById('btnSaveFits');
  btn.disabled = true;
  const originalText = btn.innerHTML;
  btn.innerHTML = `Saving...`;
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

    const res = await fetch('/api/fits', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fits: currentFits.fits })
    });
    if (!res.ok) throw new Error('Save failed');
    dirty = false;
    showToast('Sizing charts saved');
    render();
  } catch (e) {
    showToast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function loadFits() {
  const root = document.getElementById('scRoot');
  root.innerHTML = `<div class="om-empty">Loading...</div>`;
  try {
    const [configRes, fitsRes] = await Promise.all([
      fetch('/api/config'),
      fetch('/api/fits')
    ]);
    const config = await configRes.json();
    I18N = config.i18n || {};
    currentFits = await fitsRes.json();
    render();
  } catch (e) { showToast(e.message, true); }
}

loadFits();
