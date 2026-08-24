/* Juniper QA/QC Report - frontend wizard (vanilla JS, no build step) */

let CONFIG = { fits: { fits: {}, toleranceInches: 0.5 }, i18n: {} };
let I18N = {};

const state = {
  category: null,
  poNumber: '', factoryCode: '', date: todayStr(), pointCheckRate: '', qaLead: '',
  creator: '', productTitle: '', qaType: 'pre_production',
  materials: '', printingMethod: '',
  categoryData: {
    fit: '',
    sizeRows: [],
    fabricColorMatch: { status: '', notes: '' },
    fabricWeightMatch: { status: '', notes: '' },
    embroideryColorMatch: { status: '', notes: '' },
    embroideryDimMatch: { status: '', notes: '' },
    printColorMatch: { status: '', notes: '' },
    printDimMatch: { status: '', notes: '' },
    washTagMatch: { status: '', notes: '' },
    generalSizingMatch: { status: '', notes: '' },
    sleeveDimMatch: { status: '', notes: '' },
    packagingCardMatch: { status: '', notes: '' },
    bagTagsCorrect: { status: '', notes: '' },
    customNotes: ''
  },
  photos: { general: [], tags: [] },
  issues: []
};

let step = 0;
const STEPS = ['category', 'orderInfo', 'categoryDetails', 'photos', 'issues', 'review'];

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function bi(key, fallback) {
  const e = I18N[key];
  if (!e) return fallback || key;
  return { en: e.en, zh: e.zh };
}

function biHtml(key, fallback, tag = 'span') {
  const e = bi(key, fallback);
  if (typeof e === 'string') return e;
  return `${escapeHtml(e.en)} <${tag} class="zh">${escapeHtml(e.zh)}</${tag}>`;
}

function biBlockHtml(key, fallback) {
  const e = bi(key, fallback);
  if (typeof e === 'string') return e;
  return `${escapeHtml(e.en)}<span class="zh">${escapeHtml(e.zh)}</span>`;
}

function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    CONFIG = await res.json();
    I18N = CONFIG.i18n || {};
  } catch (e) {
    console.error('Failed to load config', e);
    showToast('Failed to load app configuration / 加载配置失败', true);
  }
}

function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  setTimeout(() => { t.className = 'toast hidden'; }, 3500);
}

function updateProgress() {
  const pct = Math.round(((step) / (STEPS.length - 1)) * 100);
  document.getElementById('progressFill').style.width = Math.max(8, pct) + '%';
}

function goTo(newStep) {
  step = newStep;
  updateProgress();
  render();
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

function next() {
  if (!validateStep(step)) return;
  if (step < STEPS.length - 1) goTo(step + 1);
}
function back() {
  if (step > 0) goTo(step - 1);
}

function validateStep(s) {
  clearErrors();
  const name = STEPS[s];
  let ok = true;
  if (name === 'category') {
    if (!state.category) { showToast('Please select a product category / 请选择产品类别', true); ok = false; }
  } else if (name === 'orderInfo') {
    const required = ['poNumber', 'factoryCode', 'date', 'qaLead'];
    required.forEach((f) => {
      if (!state[f] || !String(state[f]).trim()) {
        markError(f);
        ok = false;
      }
    });
    if (!ok) showToast('Please fill in all required fields / 请填写所有必填项', true);
  }
  return ok;
}

function markError(fieldId) {
  const el = document.querySelector(`[data-field="${fieldId}"]`);
  if (el) el.classList.add('has-error');
}
function clearErrors() {
  document.querySelectorAll('.has-error').forEach((el) => el.classList.remove('has-error'));
}

/* ---------------- RENDER ---------------- */

function render() {
  const root = document.getElementById('formRoot');
  const name = STEPS[step];
  let html = '';
  if (name === 'category') html = renderCategoryStep();
  else if (name === 'orderInfo') html = renderOrderInfoStep();
  else if (name === 'categoryDetails') html = renderCategoryDetailsStep();
  else if (name === 'photos') html = renderPhotosStep();
  else if (name === 'issues') html = renderIssuesStep();
  else if (name === 'review') html = renderReviewStep();

  root.innerHTML = html;
  attachStepHandlers(name);
}

/* ---- Step 0: Category ---- */
function renderCategoryStep() {
  const options = [
    { key: 'apparel', icon: '👕', labelKey: 'apparel' },
    { key: 'plush', icon: '🧸', labelKey: 'plush' },
    { key: 'other', icon: '📦', labelKey: 'other' }
  ];
  return `
    <div class="step-eyebrow">${biHtml('step', 'Step')} 1 / 6</div>
    <div class="step-title">Select Product Category<span class="zh">选择产品类别</span></div>
    <div class="category-grid">
      ${options.map((o) => {
        const l = bi(o.labelKey);
        const sel = state.category === o.key ? 'selected' : '';
        return `<div class="category-option ${sel}" data-cat="${o.key}">
          <div class="category-icon">${o.icon}</div>
          <div>
            <div class="category-label-en">${escapeHtml(l.en)}</div>
            <div class="category-label-zh">${escapeHtml(l.zh)}</div>
          </div>
        </div>`;
      }).join('')}
    </div>
    <div class="nav-buttons">
      <button class="btn btn-primary" id="btnNext">${biBlockHtml('next', 'Next')}</button>
    </div>
  `;
}

/* ---- Step 1: Order Info ---- */
function renderOrderInfoStep() {
  return `
    <div class="step-eyebrow">${biHtml('step', 'Step')} 2 / 6</div>
    <div class="step-title">Order Information<span class="zh">订单信息</span></div>
    <div class="card">
      ${textField('poNumber', 'poNumber', state.poNumber, { required: true, placeholderKey: 'poNumberPlaceholder' })}
      ${textField('factoryCode', 'factoryCode', state.factoryCode, { required: true, placeholderKey: 'factoryCodePlaceholder' })}
      <div class="field-row">
        <div style="flex:1">${dateField('date', 'date', state.date, { required: true })}</div>
        <div style="flex:1">${textField('pointCheckRate', 'pointCheckRate', state.pointCheckRate, { placeholderKey: 'pointCheckRatePlaceholder' })}</div>
      </div>
      ${textField('qaLead', 'qaLead', state.qaLead, { required: true })}
      <div class="field-row">
        <div style="flex:1">${textField('creator', 'creator', state.creator, {})}</div>
        <div style="flex:1">${textField('productTitle', 'productTitle', state.productTitle, {})}</div>
      </div>
      <div class="field">
        <label class="field-label">${biBlockHtml('qaType', 'QA Type')}</label>
        <div class="segmented" id="qaTypeSeg">
          ${segOption('qaType', 'pre_production', 'prePro', state.qaType)}
          ${segOption('qaType', 'production', 'production', state.qaType)}
        </div>
      </div>
    </div>
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="btnBack">${biBlockHtml('back', 'Back')}</button>
      <button class="btn btn-primary" id="btnNext">${biBlockHtml('next', 'Next')}</button>
    </div>
  `;
}

function textField(id, i18nKey, value, opts = {}) {
  const l = bi(i18nKey);
  const ph = opts.placeholderKey ? bi(opts.placeholderKey) : { en: '', zh: '' };
  return `
    <div class="field" data-field="${id}">
      <label class="field-label">${escapeHtml(l.en)} <span class="zh">${escapeHtml(l.zh)}</span>${opts.required ? '<span class="required">*</span>' : ''}</label>
      <input type="text" data-bind="${id}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(ph.en)} / ${escapeHtml(ph.zh)}" />
    </div>
  `;
}
function dateField(id, i18nKey, value, opts = {}) {
  const l = bi(i18nKey);
  return `
    <div class="field" data-field="${id}">
      <label class="field-label">${escapeHtml(l.en)} <span class="zh">${escapeHtml(l.zh)}</span>${opts.required ? '<span class="required">*</span>' : ''}</label>
      <input type="date" data-bind="${id}" value="${escapeHtml(value || '')}" />
    </div>
  `;
}
function segOption(groupName, value, i18nKey, current) {
  const l = bi(i18nKey);
  const sel = current === value ? 'selected' : '';
  return `<div class="segmented-option ${sel}" data-seg="${groupName}" data-val="${value}">
    ${escapeHtml(l.en)}<span class="zh">${escapeHtml(l.zh)}</span>
  </div>`;
}

/* ---- Step 2: Category-specific details ---- */
function renderCategoryDetailsStep() {
  const cd = state.categoryData;
  let body = `
    <div class="card">
      <div class="section-title">${biBlockHtml('materials', 'Fabric / Material(s)')}</div>
      <div class="field">
        <textarea data-bind="materials" placeholder="${escapeHtml(bi('materialsPlaceholder').en)} / ${escapeHtml(bi('materialsPlaceholder').zh)}">${escapeHtml(state.materials)}</textarea>
      </div>
      <div class="section-title" style="margin-top:10px;">${biBlockHtml('printingMethod', 'Printing Method(s)')}</div>
      <div class="field">
        <textarea data-bind="printingMethod" placeholder="${escapeHtml(bi('printingMethodPlaceholder').en)} / ${escapeHtml(bi('printingMethodPlaceholder').zh)}">${escapeHtml(state.printingMethod)}</textarea>
      </div>
    </div>
  `;

  if (state.category === 'apparel') {
    body += renderFitPicker();
    if (cd.fit) body += renderSizeChart();
  }

  body += renderChecklistCard();

  if (state.category === 'other') {
    body += `<div class="card">
      <div class="section-title">${biBlockHtml('customNotes', 'Additional Notes')}</div>
      <div class="field">
        <textarea data-bind="cd.customNotes" placeholder="${escapeHtml(bi('customNotesPlaceholder').en)} / ${escapeHtml(bi('customNotesPlaceholder').zh)}">${escapeHtml(cd.customNotes)}</textarea>
      </div>
    </div>`;
  }

  return `
    <div class="step-eyebrow">${biHtml('step', 'Step')} 3 / 6</div>
    <div class="step-title">Inspection Details<span class="zh">检验详情</span></div>
    ${body}
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="btnBack">${biBlockHtml('back', 'Back')}</button>
      <button class="btn btn-primary" id="btnNext">${biBlockHtml('next', 'Next')}</button>
    </div>
  `;
}

function renderFitPicker() {
  const fits = CONFIG.fits.fits || {};
  const options = Object.keys(fits).map((key) => {
    const f = fits[key];
    const sel = state.categoryData.fit === key ? 'selected' : '';
    return `<option value="${key}" ${sel}>${escapeHtml(f.label_en)} / ${escapeHtml(f.label_zh)}</option>`;
  }).join('');
  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('fitSelect', 'Standard Fit')}</div>
      <div class="field">
        <select id="fitSelect">
          <option value="">${escapeHtml(bi('fitSelectPlaceholder').en)} / ${escapeHtml(bi('fitSelectPlaceholder').zh)}</option>
          ${options}
        </select>
      </div>
    </div>
  `;
}

function renderSizeChart() {
  const fitDef = CONFIG.fits.fits[state.categoryData.fit];
  if (!fitDef) return '';
  const tol = CONFIG.fits.toleranceInches || 0.5;
  const cd = state.categoryData;

  if (!cd.sizeRows.length || cd._fitForRows !== cd.fit) {
    cd.sizeRows = Object.keys(fitDef.sizes).map((size) => ({ size, measured: {} }));
    cd._fitForRows = cd.fit;
  }

  const pointCols = fitDef.points.map((p) => {
    const pl = fitDef.pointLabels[p] || { en: p, zh: '' };
    return `<th>${escapeHtml(pl.en)}<span class="zh">${escapeHtml(pl.zh)}</span></th>`;
  }).join('');

  const rows = cd.sizeRows.map((row, ridx) => {
    const standard = fitDef.sizes[row.size] || {};
    const cells = fitDef.points.map((p) => {
      const std = standard[p];
      const measuredVal = row.measured[p] !== undefined ? row.measured[p] : '';
      const measuredNum = parseFloat(measuredVal);
      const stdNum = parseFloat(std);
      let outOfTol = false;
      if (std && !isNaN(stdNum) && stdNum !== 0 && measuredVal !== '' && !isNaN(measuredNum)) {
        outOfTol = Math.abs(measuredNum - stdNum) > tol;
      }
      return `<td class="${outOfTol ? 'out-of-tol' : ''}">
        <span class="std-val">${bi('standard').en}: ${std ? std + '"' : '-'}</span>
        <input type="number" step="0.01" inputmode="decimal" value="${escapeHtml(measuredVal)}"
          data-size-row="${ridx}" data-size-point="${p}" placeholder="0.0" />
        ${outOfTol ? `<span class="tol-flag">${escapeHtml(bi('outOfTolerance').en)}</span>` : ''}
      </td>`;
    }).join('');
    return `<tr><td class="size-name">${escapeHtml(row.size)}</td>${cells}</tr>`;
  }).join('');

  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('sizeChart', 'Measurement Chart')}</div>
      <div class="section-help">${escapeHtml(bi('sizeChartHelp').en)}<br/>${escapeHtml(bi('sizeChartHelp').zh)}</div>
      <div class="size-table-wrap">
        <table class="size-table">
          <thead><tr><th>${escapeHtml(bi('size').en)}<span class="zh">${escapeHtml(bi('size').zh)}</span></th>${pointCols}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function checklistItem(key, i18nKey) {
  const cd = state.categoryData;
  const entry = cd[key];
  const l = bi(i18nKey);
  return `
    <div class="checklist-row" data-checklist="${key}">
      <div class="checklist-question">${escapeHtml(l.en)}<span class="zh">${escapeHtml(l.zh)}</span></div>
      <div class="segmented">
        ${['pass', 'fail', 'na'].map((s) => {
          const sl = bi(s);
          const sel = entry.status === s ? 'selected status-' + s : '';
          return `<div class="segmented-option ${sel}" data-checklist-status="${key}" data-val="${s}">
            ${escapeHtml(sl.en)}<span class="zh">${escapeHtml(sl.zh)}</span>
          </div>`;
        }).join('')}
      </div>
      <div class="checklist-notes">
        <textarea data-checklist-notes="${key}" placeholder="${escapeHtml(bi('notesPlaceholder').en)} / ${escapeHtml(bi('notesPlaceholder').zh)}">${escapeHtml(entry.notes)}</textarea>
      </div>
    </div>
  `;
}

function renderChecklistCard() {
  const items = [
    ['fabricSection', [['fabricColorMatch', 'fabricColorMatch'], ['fabricWeightMatch', 'fabricWeightMatch']]],
    ['embroiderySection', [['embroideryColorMatch', 'embroideryColorMatch'], ['embroideryDimMatch', 'embroideryDimMatch']]],
    ['printingSection', [['printColorMatch', 'printColorMatch'], ['printDimMatch', 'printDimMatch'], ['washTagMatch', 'washTagMatch']]],
    ['sizingSection', state.category === 'apparel'
      ? [['sleeveDimMatch', 'sleeveDimMatch'], ['generalSizingMatch', 'generalSizingMatch']]
      : [['generalSizingMatch', 'generalSizingMatch']]],
    ['packagingSection', [['packagingCardMatch', 'packagingCardMatch'], ['bagTagsCorrect', 'bagTagsCorrect']]]
  ];
  return items.map(([sectionKey, rows]) => `
    <div class="card">
      <div class="section-title">${biBlockHtml(sectionKey)}</div>
      ${rows.map(([k, lk]) => checklistItem(k, lk)).join('')}
    </div>
  `).join('');
}

/* ---- Step 3: Photos ---- */
function renderPhotosStep() {
  return `
    <div class="step-eyebrow">${biHtml('step', 'Step')} 4 / 6</div>
    <div class="step-title">Photos<span class="zh">照片</span></div>
    <div class="card">
      <div class="section-title">${biBlockHtml('generalPhotos', 'General Photos')}</div>
      <div class="section-help">${escapeHtml(bi('generalPhotosHelp').en)} / ${escapeHtml(bi('generalPhotosHelp').zh)}</div>
      ${photoGrid('general')}
    </div>
    <div class="card">
      <div class="section-title">${biBlockHtml('tagPhotos', 'Tag Photos')}</div>
      <div class="section-help">${escapeHtml(bi('tagPhotosHelp').en)} / ${escapeHtml(bi('tagPhotosHelp').zh)}</div>
      ${photoGrid('tags')}
    </div>
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="btnBack">${biBlockHtml('back', 'Back')}</button>
      <button class="btn btn-primary" id="btnNext">${biBlockHtml('next', 'Next')}</button>
    </div>
  `;
}

function photoGrid(groupKey, issueIdx) {
  const arr = issueIdx !== undefined ? state.issues[issueIdx].photos : state.photos[groupKey];
  const thumbs = arr.map((file, idx) => `
    <div class="photo-thumb">
      <img src="${file._url}" />
      <button class="photo-remove" data-photo-remove="${groupKey}" data-photo-idx="${idx}" data-issue-idx="${issueIdx !== undefined ? issueIdx : ''}">✕</button>
    </div>
  `).join('');
  const inputId = `photoInput_${groupKey}_${issueIdx !== undefined ? issueIdx : 'x'}`;
  return `
    <div class="photo-grid">
      ${thumbs}
      <label class="photo-add" for="${inputId}">
        <span class="plus">+</span>
        <span>${escapeHtml(bi('addPhoto').en)}</span>
        <input type="file" id="${inputId}" accept="image/*" capture="environment" multiple
          data-photo-input="${groupKey}" data-issue-idx="${issueIdx !== undefined ? issueIdx : ''}" />
      </label>
    </div>
  `;
}

/* ---- Step 4: Issues ---- */
function renderIssuesStep() {
  const issuesHtml = state.issues.map((issue, idx) => `
    <div class="issue-card">
      <div class="issue-card-header">
        <div class="issue-number">${bi('issuesSection').en} #${idx + 1}</div>
        <button class="remove-issue-btn" data-remove-issue="${idx}">${escapeHtml(bi('removeIssue').en)} / ${escapeHtml(bi('removeIssue').zh)}</button>
      </div>
      <div class="field">
        <label class="field-label">${biBlockHtml('issueDescription')}</label>
        <textarea data-issue-field="description" data-issue-idx="${idx}" placeholder="${escapeHtml(bi('issueDescriptionPlaceholder').en)} / ${escapeHtml(bi('issueDescriptionPlaceholder').zh)}">${escapeHtml(issue.description)}</textarea>
      </div>
      <div class="field">
        <label class="field-label">${biBlockHtml('severity')}</label>
        <div class="segmented">
          ${['minor', 'major', 'critical'].map((s) => {
            const sl = bi(s);
            const sel = issue.severity === s ? 'selected' : '';
            return `<div class="segmented-option ${sel}" data-issue-severity="${idx}" data-val="${s}">
              ${escapeHtml(sl.en)}<span class="zh">${escapeHtml(sl.zh)}</span>
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="field">
        <label class="field-label">${biBlockHtml('issuePhotos')}</label>
        ${photoGrid('issue', idx)}
      </div>
    </div>
  `).join('');

  return `
    <div class="step-eyebrow">${biHtml('step', 'Step')} 5 / 6</div>
    <div class="step-title">Issues<span class="zh">问题记录</span></div>
    <div class="section-help" style="margin-bottom:14px;">${escapeHtml(bi('issuesHelp').en)}<br/>${escapeHtml(bi('issuesHelp').zh)}</div>
    ${state.issues.length === 0 ? `<div class="no-issues-note">${escapeHtml(bi('noIssues').en)} / ${escapeHtml(bi('noIssues').zh)}</div>` : issuesHtml}
    <button class="add-issue-btn" id="btnAddIssue">${escapeHtml(bi('addIssue').en)} / ${escapeHtml(bi('addIssue').zh)}</button>
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="btnBack">${biBlockHtml('back', 'Back')}</button>
      <button class="btn btn-primary" id="btnNext">${biBlockHtml('next', 'Next')}</button>
    </div>
  `;
}

/* ---- Step 5: Review ---- */
function renderReviewStep() {
  const catLabel = bi(state.category);
  const qaTypeLabel = state.qaType === 'production' ? bi('production') : bi('prePro');
  const totalPhotos = state.photos.general.length + state.photos.tags.length +
    state.issues.reduce((s, i) => s + i.photos.length, 0);

  return `
    <div class="step-eyebrow">${biHtml('step', 'Step')} 6 / 6</div>
    <div class="step-title">${biBlockHtml('reviewTitle', 'Review & Submit')}</div>
    <div class="card">
      <div class="review-block">
        <div class="review-block-title">${bi('poInfo').en} / ${bi('poInfo').zh}</div>
        ${reviewRow('poNumber', state.poNumber)}
        ${reviewRow('factoryCode', state.factoryCode)}
        ${reviewRow('date', state.date)}
        ${reviewRow('pointCheckRate', state.pointCheckRate)}
        ${reviewRow('qaLead', state.qaLead)}
        <div class="review-row"><span class="k">Category / 类别</span><span class="v">${escapeHtml(catLabel.en)} ${escapeHtml(catLabel.zh)}</span></div>
        <div class="review-row"><span class="k">${bi('qaType').en}</span><span class="v">${escapeHtml(qaTypeLabel.en)} ${escapeHtml(qaTypeLabel.zh)}</span></div>
      </div>
      <div class="review-block">
        <div class="review-block-title">${bi('photosSection').en} / ${bi('photosSection').zh}</div>
        <div class="review-row"><span class="k">${bi('generalPhotos').en}</span><span class="v">${state.photos.general.length}</span></div>
        <div class="review-row"><span class="k">${bi('tagPhotos').en}</span><span class="v">${state.photos.tags.length}</span></div>
      </div>
      <div class="review-block">
        <div class="review-block-title">${bi('issuesSection').en} / ${bi('issuesSection').zh}</div>
        <div class="review-row"><span class="k">Total</span><span class="v">${state.issues.length}</span></div>
      </div>
    </div>
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="btnBack">${biBlockHtml('back', 'Back')}</button>
      <button class="btn btn-primary" id="btnSubmit">${biBlockHtml('submit', 'Submit Report')}</button>
    </div>
  `;
}
function reviewRow(key, value) {
  const l = bi(key);
  return `<div class="review-row"><span class="k">${escapeHtml(l.en)}</span><span class="v">${escapeHtml(value || '-')}</span></div>`;
}

/* ---------------- EVENT HANDLERS ---------------- */

function attachStepHandlers(name) {
  const btnBack = document.getElementById('btnBack');
  if (btnBack) btnBack.addEventListener('click', back);
  const btnNext = document.getElementById('btnNext');
  if (btnNext) btnNext.addEventListener('click', next);
  const btnSubmit = document.getElementById('btnSubmit');
  if (btnSubmit) btnSubmit.addEventListener('click', submitReport);

  // text/date/textarea bindings
  document.querySelectorAll('[data-bind]').forEach((el) => {
    el.addEventListener('input', (e) => {
      const path = el.getAttribute('data-bind');
      setStateValue(path, e.target.value);
    });
  });

  if (name === 'category') {
    document.querySelectorAll('.category-option').forEach((el) => {
      el.addEventListener('click', () => {
        state.category = el.getAttribute('data-cat');
        render();
      });
    });
  }

  if (name === 'orderInfo') {
    document.querySelectorAll('[data-seg]').forEach((el) => {
      el.addEventListener('click', () => {
        const group = el.getAttribute('data-seg');
        state[group] = el.getAttribute('data-val');
        render();
      });
    });
  }

  if (name === 'categoryDetails') {
    const fitSelect = document.getElementById('fitSelect');
    if (fitSelect) {
      fitSelect.addEventListener('change', (e) => {
        state.categoryData.fit = e.target.value;
        state.categoryData.sizeRows = [];
        render();
      });
    }
    document.querySelectorAll('[data-size-row]').forEach((el) => {
      el.addEventListener('input', (e) => {
        const ridx = parseInt(el.getAttribute('data-size-row'), 10);
        const point = el.getAttribute('data-size-point');
        state.categoryData.sizeRows[ridx].measured[point] = e.target.value;
        // re-render just to update tolerance flags, but preserve focus is tricky;
        // do a lightweight refresh of the table only
        refreshSizeChartInPlace();
      });
    });
    document.querySelectorAll('[data-checklist-status]').forEach((el) => {
      el.addEventListener('click', () => {
        const key = el.getAttribute('data-checklist-status');
        state.categoryData[key].status = el.getAttribute('data-val');
        render();
      });
    });
    document.querySelectorAll('[data-checklist-notes]').forEach((el) => {
      el.addEventListener('input', (e) => {
        const key = el.getAttribute('data-checklist-notes');
        state.categoryData[key].notes = e.target.value;
      });
    });
  }

  if (name === 'photos') {
    attachPhotoHandlers();
  }

  if (name === 'issues') {
    const addBtn = document.getElementById('btnAddIssue');
    if (addBtn) addBtn.addEventListener('click', () => {
      state.issues.push({ description: '', severity: 'minor', photos: [] });
      render();
    });
    document.querySelectorAll('[data-remove-issue]').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.getAttribute('data-remove-issue'), 10);
        state.issues.splice(idx, 1);
        render();
      });
    });
    document.querySelectorAll('[data-issue-field]').forEach((el) => {
      el.addEventListener('input', (e) => {
        const idx = parseInt(el.getAttribute('data-issue-idx'), 10);
        const field = el.getAttribute('data-issue-field');
        state.issues[idx][field] = e.target.value;
      });
    });
    document.querySelectorAll('[data-issue-severity]').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.getAttribute('data-issue-severity'), 10);
        state.issues[idx].severity = el.getAttribute('data-val');
        render();
      });
    });
    attachPhotoHandlers();
  }
}

function setStateValue(path, value) {
  if (path.startsWith('cd.')) {
    state.categoryData[path.slice(3)] = value;
  } else {
    state[path] = value;
  }
}

function refreshSizeChartInPlace() {
  // Re-render whole categoryDetails step but try to keep scroll position
  const scrollY = window.scrollY;
  render();
  window.scrollTo(0, scrollY);
}

function attachPhotoHandlers() {
  document.querySelectorAll('[data-photo-input]').forEach((el) => {
    el.addEventListener('change', (e) => {
      const group = el.getAttribute('data-photo-input');
      const issueIdxAttr = el.getAttribute('data-issue-idx');
      const files = Array.from(e.target.files || []);
      files.forEach((f) => {
        f._url = URL.createObjectURL(f);
        if (group === 'issue') {
          const idx = parseInt(issueIdxAttr, 10);
          state.issues[idx].photos.push(f);
        } else {
          state.photos[group].push(f);
        }
      });
      render();
    });
  });
  document.querySelectorAll('[data-photo-remove]').forEach((el) => {
    el.addEventListener('click', () => {
      const group = el.getAttribute('data-photo-remove');
      const idx = parseInt(el.getAttribute('data-photo-idx'), 10);
      const issueIdxAttr = el.getAttribute('data-issue-idx');
      if (group === 'issue') {
        const iidx = parseInt(issueIdxAttr, 10);
        state.issues[iidx].photos.splice(idx, 1);
      } else {
        state.photos[group].splice(idx, 1);
      }
      render();
    });
  });
}

/* ---------------- SUBMIT ---------------- */

async function submitReport() {
  const btn = document.getElementById('btnSubmit');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${escapeHtml(bi('submitting').en)}`;

  try {
    const payload = {
      category: state.category,
      poNumber: state.poNumber,
      factoryCode: state.factoryCode,
      date: state.date,
      pointCheckRate: state.pointCheckRate,
      qaLead: state.qaLead,
      creator: state.creator,
      productTitle: state.productTitle,
      qaType: state.qaType,
      materials: state.materials,
      printingMethod: state.printingMethod,
      categoryData: state.categoryData,
      issues: state.issues.map((i) => ({ description: i.description, severity: i.severity }))
    };

    const formData = new FormData();
    formData.append('payload', JSON.stringify(payload));
    state.photos.general.forEach((f) => formData.append('photo_general', f, f.name));
    state.photos.tags.forEach((f) => formData.append('photo_tags', f, f.name));
    state.issues.forEach((issue, idx) => {
      issue.photos.forEach((f) => formData.append(`photo_issue_${idx}`, f, f.name));
    });

    const res = await fetch('/api/submit', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Submit failed');
    }
    const result = await res.json();
    renderSuccessScreen(result);
  } catch (e) {
    console.error(e);
    showToast(bi('submitError').en + ' / ' + bi('submitError').zh, true);
    btn.disabled = false;
    btn.innerHTML = biBlockHtml('submit', 'Submit Report');
  }
}

function renderSuccessScreen(result = {}) {
  const root = document.getElementById('formRoot');
  const testModeNotice = result.testMode ? `
    <div class="test-mode-banner">
      <strong>Test Mode</strong> / 测试模式 — no email was sent because SMTP isn't configured yet.
      The PDF was generated and saved locally so you can review it below.
    </div>
  ` : '';
  const viewLink = result.pdfUrl ? `
    <a class="btn btn-primary" style="max-width:280px;margin:0 auto 12px auto;display:block;text-decoration:none;" href="${result.pdfUrl}" target="_blank" rel="noopener">
      View Generated PDF / 查看生成的报告
    </a>
  ` : '';
  root.innerHTML = `
    <div class="success-screen">
      <div class="success-icon">✓</div>
      <div class="success-title">${escapeHtml(bi('submitSuccess').en)}</div>
      <div class="success-sub">${escapeHtml(bi('submitSuccess').zh)}</div>
      ${testModeNotice}
      ${viewLink}
      <button class="btn btn-secondary" id="btnStartOver" style="max-width:280px;margin:0 auto;">${biBlockHtml('startOver', 'Start New Report')}</button>
    </div>
  `;
  document.getElementById('progressFill').style.width = '100%';
  document.getElementById('btnStartOver').addEventListener('click', resetApp);
}

function resetApp() {
  Object.assign(state, {
    category: null,
    poNumber: '', factoryCode: '', date: todayStr(), pointCheckRate: '', qaLead: '',
    creator: '', productTitle: '', qaType: 'pre_production',
    materials: '', printingMethod: '',
    categoryData: {
      fit: '', sizeRows: [],
      fabricColorMatch: { status: '', notes: '' },
      fabricWeightMatch: { status: '', notes: '' },
      embroideryColorMatch: { status: '', notes: '' },
      embroideryDimMatch: { status: '', notes: '' },
      printColorMatch: { status: '', notes: '' },
      printDimMatch: { status: '', notes: '' },
      washTagMatch: { status: '', notes: '' },
      generalSizingMatch: { status: '', notes: '' },
      sleeveDimMatch: { status: '', notes: '' },
      packagingCardMatch: { status: '', notes: '' },
      bagTagsCorrect: { status: '', notes: '' },
      customNotes: ''
    },
    photos: { general: [], tags: [] },
    issues: []
  });
  goTo(0);
}

/* ---------------- INIT ---------------- */

(async function init() {
  await loadConfig();
  updateProgress();
  render();
})();
