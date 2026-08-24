/* Juniper QA/QC Report - frontend wizard (vanilla JS, no build step) */

let CONFIG = { fits: { fits: {}, toleranceInches: 0.5 }, i18n: {}, options: {} };
let I18N = {};
let OPTIONS = {};

function emptyChecklistEntry() { return { status: '', notes: '' }; }

const state = {
  category: null,
  poNumber: '', factoryCode: '', date: todayStr(), pointCheckRate: '', qaLead: '',
  creator: '', productTitle: '', qaType: 'pre_production',
  materials: '', printingMethod: '',
  categoryData: {
    fit: '',
    sizeRows: [],
    fabricColorMatch: emptyChecklistEntry(),
    fabricWeightMatch: emptyChecklistEntry(),
    embroideryColorMatch: emptyChecklistEntry(),
    embroideryDimMatch: emptyChecklistEntry(),
    printColorMatch: emptyChecklistEntry(),
    printDimMatch: emptyChecklistEntry(),
    washTagMatch: emptyChecklistEntry(),
    generalSizingMatch: emptyChecklistEntry(),
    packagingCardMatch: emptyChecklistEntry(),
    bagTagsCorrect: emptyChecklistEntry(),
    customNotes: '',
    sectionPhotos: { fabric: [], embroidery: [], printing: [], washTag: [], sizing: [], packaging: [] }
  },
  photos: { general: [], tags: [] },
  issues: []
};

let step = 0;
const STEPS = ['category', 'orderInfo', 'inspectionDetails', 'sizing', 'photos', 'issues', 'review'];

// Maps each checklist item to the section-photo bucket it requires a photo in when failed.
const CHECKLIST_SECTION_MAP = {
  fabricColorMatch: 'fabric', fabricWeightMatch: 'fabric',
  embroideryColorMatch: 'embroidery', embroideryDimMatch: 'embroidery',
  printColorMatch: 'printing', printDimMatch: 'printing',
  washTagMatch: 'washTag',
  generalSizingMatch: 'sizing',
  packagingCardMatch: 'packaging', bagTagsCorrect: 'packaging'
};

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function bi(key, fallback) {
  const e = I18N[key];
  if (!e) return { en: fallback || key, zh: '' };
  return { en: e.en, zh: e.zh };
}

function biHtml(key, fallback, tag = 'span') {
  const e = bi(key, fallback);
  return `${escapeHtml(e.en)} <${tag} class="zh">${escapeHtml(e.zh)}</${tag}>`;
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

/* ---------------- TOLERANCE HELPERS (mirror lib/passFail.js) ---------------- */

function isOutOfTolerance(standard, measured, tol) {
  if (standard === undefined || standard === null) return false;
  if (measured === null || measured === undefined || isNaN(measured)) return false;
  if (typeof standard === 'object') {
    const min = parseFloat(standard.min);
    const max = parseFloat(standard.max);
    if (isNaN(min) || isNaN(max)) return false;
    return measured < (min - tol) || measured > (max + tol);
  }
  const std = parseFloat(standard);
  if (isNaN(std) || std === 0) return false;
  return Math.abs(measured - std) > tol;
}

function formatStandard(standard) {
  if (standard === undefined || standard === null) return '-';
  if (typeof standard === 'object') {
    if (standard.min === undefined || standard.max === undefined) return '-';
    return `${standard.min}-${standard.max}"`;
  }
  const n = parseFloat(standard);
  if (isNaN(n) || n === 0) return '-';
  return `${n}"`;
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    CONFIG = await res.json();
    I18N = CONFIG.i18n || {};
    OPTIONS = CONFIG.options || {};
  } catch (e) {
    console.error('Failed to load config', e);
    showToast('Failed to load app configuration / 加载配置失败', true);
  }
}

function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  setTimeout(() => { t.className = 'toast hidden'; }, 3800);
}

function updateProgress() {
  const pct = Math.round(((step) / (STEPS.length - 1)) * 100);
  document.getElementById('progressFill').style.width = Math.max(8, pct) + '%';
}

function goTo(newStep) {
  step = newStep;
  updateProgress();
  render();
  window.scrollTo(0, 0);
}

function next() {
  if (!validateStep(step)) return;
  if (step < STEPS.length - 1) goTo(step + 1);
}
function back() {
  if (step > 0) goTo(step - 1);
}

/* ---------------- VALIDATION ---------------- */

function checklistDefsForStep(name) {
  // Returns [ [stateKey, i18nKey, sectionKey], ... ] relevant to the given step + category.
  if (name === 'inspectionDetails') {
    return [
      ['fabricColorMatch', 'fabricColorMatch', 'fabric'],
      ['fabricWeightMatch', 'fabricWeightMatch', 'fabric'],
      ['embroideryColorMatch', 'embroideryColorMatch', 'embroidery'],
      ['embroideryDimMatch', 'embroideryDimMatch', 'embroidery'],
      ['printColorMatch', 'printColorMatch', 'printing'],
      ['printDimMatch', 'printDimMatch', 'printing'],
      ['washTagMatch', 'washTagMatch', 'washTag'],
      ['packagingCardMatch', 'packagingCardMatch', 'packaging'],
      ['bagTagsCorrect', 'bagTagsCorrect', 'packaging']
    ];
  }
  if (name === 'sizing' && state.category !== 'apparel') {
    return [['generalSizingMatch', 'generalSizingMatch', 'sizing']];
  }
  return [];
}

function findMissingChecklistStatuses(name) {
  return checklistDefsForStep(name).filter(([key]) => !state.categoryData[key].status);
}

function findMissingRequiredPhotos(name) {
  return checklistDefsForStep(name).filter(([key, , sectionKey]) => {
    const entry = state.categoryData[key];
    return entry.status === 'fail' && state.categoryData.sectionPhotos[sectionKey].length === 0;
  });
}

function apparelSizingIncomplete() {
  if (state.category !== 'apparel') return false;
  if (!state.categoryData.fit) return true;
  const rows = state.categoryData.sizeRows || [];
  const hasAnyMeasurement = rows.some((r) => r.measured && Object.values(r.measured).some((v) => v !== '' && v !== undefined));
  return !hasAnyMeasurement;
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
      if (!state[f] || !String(state[f]).trim()) { markError(f); ok = false; }
    });
    if (!ok) showToast('Please fill in all required fields / 请填写所有必填项', true);
  } else if (name === 'inspectionDetails') {
    const missingStatus = findMissingChecklistStatuses(name);
    const missingPhotos = findMissingRequiredPhotos(name);
    missingStatus.forEach(([key]) => markChecklistError(key));
    missingPhotos.forEach(([, , sectionKey]) => markSectionPhotoError(sectionKey));
    if (missingPhotos.length) {
      showToast(bi('photoRequiredForFail').en + ' / ' + bi('photoRequiredForFail').zh, true);
      ok = false;
    } else if (missingStatus.length) {
      showToast(bi('allChecksRequired').en + ' / ' + bi('allChecksRequired').zh, true);
      ok = false;
    }
  } else if (name === 'sizing') {
    if (state.category === 'apparel') {
      if (apparelSizingIncomplete()) {
        showToast(bi('selectFitRequired').en + ' / ' + bi('selectFitRequired').zh, true);
        ok = false;
      }
    } else {
      const missingStatus = findMissingChecklistStatuses(name);
      const missingPhotos = findMissingRequiredPhotos(name);
      missingStatus.forEach(([key]) => markChecklistError(key));
      missingPhotos.forEach(([, , sectionKey]) => markSectionPhotoError(sectionKey));
      if (missingPhotos.length) {
        showToast(bi('photoRequiredForFail').en + ' / ' + bi('photoRequiredForFail').zh, true);
        ok = false;
      } else if (missingStatus.length) {
        showToast(bi('allChecksRequired').en + ' / ' + bi('allChecksRequired').zh, true);
        ok = false;
      }
    }
  }
  return ok;
}

function markError(fieldId) {
  const el = document.querySelector(`[data-field="${fieldId}"]`);
  if (el) el.classList.add('has-error');
}
function markChecklistError(key) {
  const el = document.querySelector(`[data-checklist="${key}"]`);
  if (el) el.classList.add('has-error');
}
function markSectionPhotoError(sectionKey) {
  const el = document.querySelector(`[data-section-photos="${sectionKey}"]`);
  if (el) el.classList.add('has-error');
}
function clearErrors() {
  document.querySelectorAll('.has-error').forEach((el) => el.classList.remove('has-error'));
}

/** Full validation across the whole report - used to gate the final Submit button. */
function getAllValidationProblems() {
  const problems = [];
  if (!state.category) problems.push(bi('selectCategory'));
  ['poNumber', 'factoryCode', 'date', 'qaLead'].forEach((f) => {
    if (!state[f] || !String(state[f]).trim()) problems.push(bi(f));
  });

  const detailDefs = checklistDefsForStep('inspectionDetails');
  const sizingDefs = state.category === 'apparel' ? [] : checklistDefsForStep('sizing');
  const allDefs = detailDefs.concat(sizingDefs);

  const missingStatus = allDefs.filter(([key]) => !state.categoryData[key].status);
  if (missingStatus.length) problems.push(bi('allChecksRequired'));

  const missingPhotos = allDefs.filter(([key, , sectionKey]) => {
    const entry = state.categoryData[key];
    return entry.status === 'fail' && state.categoryData.sectionPhotos[sectionKey].length === 0;
  });
  if (missingPhotos.length) problems.push(bi('photoRequiredForFail'));

  if (state.category === 'apparel' && apparelSizingIncomplete()) {
    problems.push(bi('selectFitRequired'));
  }

  return problems;
}

/* ---------------- PASS / FAIL LOGIC (mirrors lib/passFail.js) ---------------- */

function computeOverallResult() {
  const reasons = [];
  const cd = state.categoryData;
  const tol = CONFIG.fits.toleranceInches || 0.5;

  if (state.category === 'apparel' && cd.fit && CONFIG.fits.fits[cd.fit]) {
    const fitDef = CONFIG.fits.fits[cd.fit];
    outer:
    for (const row of (cd.sizeRows || [])) {
      const standard = fitDef.sizes[row.size] || {};
      for (const point of fitDef.points) {
        const measured = row.measured && row.measured[point] !== undefined && row.measured[point] !== ''
          ? parseFloat(row.measured[point]) : null;
        if (isOutOfTolerance(standard[point], measured, tol)) { reasons.push('tolerance'); break outer; }
      }
    }
  }

  const minorCount = state.issues.filter((i) => i.severity === 'minor').length;
  const majorCriticalCount = state.issues.filter((i) => i.severity === 'major' || i.severity === 'critical').length;
  if (minorCount >= 3) reasons.push('minor');
  if (majorCriticalCount >= 1) reasons.push('major');

  return { overall: reasons.length ? 'fail' : 'pass', reasons };
}

/* ---------------- PHOTO STORAGE HELPERS ---------------- */
// fieldId scheme: "general" | "tags" | "section:fabric" | "issue:0"

function getPhotoArray(fieldId) {
  if (fieldId === 'general') return state.photos.general;
  if (fieldId === 'tags') return state.photos.tags;
  if (fieldId.startsWith('section:')) {
    const key = fieldId.split(':')[1];
    return state.categoryData.sectionPhotos[key];
  }
  if (fieldId.startsWith('issue:')) {
    const idx = parseInt(fieldId.split(':')[1], 10);
    return state.issues[idx].photos;
  }
  return [];
}

/* ---------------- RENDER ---------------- */

function render() {
  const root = document.getElementById('formRoot');
  const name = STEPS[step];
  let html = '';
  if (name === 'category') html = renderCategoryStep();
  else if (name === 'orderInfo') html = renderOrderInfoStep();
  else if (name === 'inspectionDetails') html = renderInspectionDetailsStep();
  else if (name === 'sizing') html = renderSizingStep();
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
    <div class="step-eyebrow">${biHtml('step', 'Step')} 1 / 7</div>
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
    <div class="step-eyebrow">${biHtml('step', 'Step')} 2 / 7</div>
    <div class="step-title">Order Information<span class="zh">订单信息</span></div>
    <div class="card">
      ${textField('poNumber', 'poNumber', state.poNumber, { required: true, placeholderKey: 'poNumberPlaceholder' })}
      ${selectField('factoryCode', 'factoryCode', state.factoryCode, OPTIONS.factoryCodes || [], { required: true })}
      <div class="field-row">
        <div style="flex:1">${dateField('date', 'date', state.date, { required: true })}</div>
        <div style="flex:1">${selectField('pointCheckRate', 'pointCheckRate', state.pointCheckRate, OPTIONS.pointCheckRates || [], {})}</div>
      </div>
      ${selectField('qaLead', 'qaLead', state.qaLead, OPTIONS.qaLeads || [], { required: true })}
      <div class="field-row">
        <div style="flex:1">${selectField('creator', 'creator', state.creator, OPTIONS.creators || [], {})}</div>
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
function selectField(id, i18nKey, value, optionsList, opts = {}) {
  const l = bi(i18nKey);
  const ph = bi('selectPlaceholder');
  const opts_html = optionsList.map((o) => `<option value="${escapeHtml(o)}" ${value === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');
  return `
    <div class="field" data-field="${id}">
      <label class="field-label">${escapeHtml(l.en)} <span class="zh">${escapeHtml(l.zh)}</span>${opts.required ? '<span class="required">*</span>' : ''}</label>
      <select data-bind="${id}">
        <option value="">${escapeHtml(ph.en)} / ${escapeHtml(ph.zh)}</option>
        ${opts_html}
      </select>
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

/* ---- Step 2: Inspection Details (fabric/embroidery/printing/washTag/packaging) ---- */
function renderInspectionDetailsStep() {
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

  body += checklistCard('fabricSection', [['fabricColorMatch', 'fabricColorMatch'], ['fabricWeightMatch', 'fabricWeightMatch']], 'fabric');
  body += checklistCard('embroiderySection', [['embroideryColorMatch', 'embroideryColorMatch'], ['embroideryDimMatch', 'embroideryDimMatch']], 'embroidery');
  body += checklistCard('printingSection', [['printColorMatch', 'printColorMatch'], ['printDimMatch', 'printDimMatch']], 'printing');
  body += checklistCard('washTagSection', [['washTagMatch', 'washTagMatch']], 'washTag');
  body += checklistCard('packagingSection', [['packagingCardMatch', 'packagingCardMatch'], ['bagTagsCorrect', 'bagTagsCorrect']], 'packaging');

  if (state.category === 'other') {
    body += `<div class="card">
      <div class="section-title">${biBlockHtml('customNotes', 'Additional Notes')}</div>
      <div class="field">
        <textarea data-bind="cd.customNotes" placeholder="${escapeHtml(bi('customNotesPlaceholder').en)} / ${escapeHtml(bi('customNotesPlaceholder').zh)}">${escapeHtml(cd.customNotes)}</textarea>
      </div>
    </div>`;
  }

  return `
    <div class="step-eyebrow">${biHtml('step', 'Step')} 3 / 7</div>
    <div class="step-title">Inspection Details<span class="zh">检验详情</span></div>
    ${body}
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="btnBack">${biBlockHtml('back', 'Back')}</button>
      <button class="btn btn-primary" id="btnNext">${biBlockHtml('next', 'Next')}</button>
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

function checklistCard(sectionKey, rows, photoSectionKey) {
  const anyFailNoPhoto = rows.some(([k]) => state.categoryData[k].status === 'fail') && state.categoryData.sectionPhotos[photoSectionKey].length === 0;
  return `
    <div class="card">
      <div class="section-title">${biBlockHtml(sectionKey)}</div>
      ${rows.map(([k, lk]) => checklistItem(k, lk)).join('')}
      <div class="section-photos-block" data-section-photos="${photoSectionKey}">
        <div class="section-photos-label">${biBlockHtml('sectionPhotos', 'Section Photos')}${anyFailNoPhoto ? ' <span class="required">*</span>' : ''}</div>
        <div class="section-help" style="margin-bottom:6px;">${escapeHtml(bi('sectionPhotosHelp').en)} / ${escapeHtml(bi('sectionPhotosHelp').zh)}</div>
        ${photoGrid('section:' + photoSectionKey, true)}
      </div>
    </div>
  `;
}

/* ---- Step 3: Sizing ---- */
function renderSizingStep() {
  let body = '';
  if (state.category === 'apparel') {
    body += renderFitPicker();
    if (state.categoryData.fit) {
      body += renderReferenceChart();
      body += renderSizeEntryTable();
      body += renderSizingPhotosCard();
    }
  } else {
    body += checklistCard('sizingSection', [['generalSizingMatch', 'generalSizingMatch']], 'sizing');
  }

  return `
    <div class="step-eyebrow">${biHtml('step', 'Step')} 4 / 7</div>
    <div class="step-title">Sizing<span class="zh">尺寸</span></div>
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

function renderReferenceChart() {
  const fitDef = CONFIG.fits.fits[state.categoryData.fit];
  if (!fitDef) return '';
  const pointCols = fitDef.points.map((p) => {
    const pl = fitDef.pointLabels[p] || { en: p, zh: '' };
    return `<th>${escapeHtml(pl.en)}<span class="zh">${escapeHtml(pl.zh)}</span></th>`;
  }).join('');
  const rows = Object.keys(fitDef.sizes).map((sizeName) => {
    const std = fitDef.sizes[sizeName];
    const cells = fitDef.points.map((p) => `<td>${escapeHtml(formatStandard(std[p]))}</td>`).join('');
    return `<tr><td class="size-name">${escapeHtml(sizeName)}</td>${cells}</tr>`;
  }).join('');

  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('referenceChart', 'Approved Reference Chart')}</div>
      <div class="section-help">${escapeHtml(bi('referenceChartHelp').en)}<br/>${escapeHtml(bi('referenceChartHelp').zh)}</div>
      <div class="ref-chart-wrap">
        <table class="ref-chart-table">
          <thead><tr><th>${escapeHtml(bi('size').en)}<span class="zh">${escapeHtml(bi('size').zh)}</span></th>${pointCols}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderSizeEntryTable() {
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
      const outOfTol = isOutOfTolerance(std, measuredVal === '' ? null : measuredNum, tol);
      return `
        <td class="${outOfTol ? 'out-of-tol' : ''}" id="sizecell_${ridx}_${p}">
          <span class="std-val">${escapeHtml(bi('standard').en)}: ${escapeHtml(formatStandard(std))}</span>
          <input type="number" step="0.1" inputmode="decimal" value="${escapeHtml(measuredVal)}"
            class="${outOfTol ? 'out-of-tol' : ''}"
            data-size-row="${ridx}" data-size-point="${p}" placeholder="0.0" />
          <span class="tol-flag" style="display:${outOfTol ? 'inline' : 'none'}">${escapeHtml(bi('outOfTolerance').en)}</span>
        </td>
      `;
    }).join('');
    return `<tr>
      <td class="size-name">${escapeHtml(row.size)}</td>
      ${cells}
    </tr>`;
  }).join('');

  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('enterMeasurements', 'Enter Measurements')}</div>
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

function renderSizingPhotosCard() {
  return `
    <div class="card" data-section-photos="sizing">
      <div class="section-title">${biBlockHtml('sizingPhotos', 'Sizing Photos')}</div>
      <div class="section-help">${escapeHtml(bi('sectionPhotosHelp').en)} / ${escapeHtml(bi('sectionPhotosHelp').zh)}</div>
      ${photoGrid('section:sizing', true)}
    </div>
  `;
}

/* ---- Step 4: Final Approval Photos ---- */
function renderPhotosStep() {
  return `
    <div class="step-eyebrow">${biHtml('step', 'Step')} 5 / 7</div>
    <div class="step-title">${biBlockHtml('finalApprovalPhotos', 'Final Approval Photos')}</div>
    <div class="section-help" style="margin-bottom:14px;">${escapeHtml(bi('finalApprovalHelp').en)}<br/>${escapeHtml(bi('finalApprovalHelp').zh)}</div>
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

function photoGrid(fieldId, compact) {
  const arr = getPhotoArray(fieldId);
  const thumbs = arr.map((file, idx) => `
    <div class="photo-thumb">
      <img src="${file._url}" />
      <button class="photo-remove" data-photo-remove="${fieldId}" data-photo-idx="${idx}">✕</button>
    </div>
  `).join('');
  const inputId = `photoInput_${fieldId.replace(/[:]/g, '_')}`;
  return `
    <div class="photo-grid ${compact ? 'compact' : ''}">
      ${thumbs}
      <label class="photo-add" for="${inputId}">
        <span class="plus">+</span>
        <span>${escapeHtml(bi('addPhoto').en)}</span>
        <input type="file" id="${inputId}" accept="image/*" capture="environment" multiple
          data-photo-input="${fieldId}" />
      </label>
    </div>
  `;
}

/* ---- Step 5: Issues ---- */
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
        ${photoGrid('issue:' + idx)}
      </div>
    </div>
  `).join('');

  return `
    <div class="step-eyebrow">${biHtml('step', 'Step')} 6 / 7</div>
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

/* ---- Step 6: Review ---- */
function renderReviewStep() {
  const catLabel = bi(state.category);
  const qaTypeLabel = state.qaType === 'production' ? bi('production') : bi('prePro');
  const result = computeOverallResult();
  const reasonKeyMap = { tolerance: 'resultReasonTolerance', minor: 'resultReasonMinor', major: 'resultReasonMajor' };
  const resultLabel = result.overall === 'pass' ? bi('resultPass') : bi('resultFail');
  const problems = getAllValidationProblems();

  const problemsBlock = problems.length ? `
    <div class="card" style="border-color:var(--jc-fail);">
      <div class="section-title" style="color:var(--jc-fail);">${biBlockHtml('reviewIssuesTitle', 'Before you submit')}</div>
      <ul style="margin:6px 0 0 0; padding-left:18px; font-size:13px; color:var(--jc-fail);">
        ${problems.map((p) => `<li>${escapeHtml(p.en)} ${escapeHtml(p.zh)}</li>`).join('')}
      </ul>
    </div>
  ` : '';

  return `
    <div class="step-eyebrow">${biHtml('step', 'Step')} 7 / 7</div>
    <div class="step-title">${biBlockHtml('reviewTitle', 'Review & Submit')}</div>

    <div class="result-banner ${result.overall === 'fail' ? 'fail' : ''}">
      <div class="result-banner-title">${escapeHtml(bi('overallResult').en)} / ${escapeHtml(bi('overallResult').zh)}</div>
      <div class="result-banner-value">${escapeHtml(resultLabel.en)} ${escapeHtml(resultLabel.zh)}</div>
      ${result.reasons.length ? `<div class="result-banner-reasons">${result.reasons.map((r) => escapeHtml(bi(reasonKeyMap[r]).en) + ' ' + escapeHtml(bi(reasonKeyMap[r]).zh)).join('<br/>')}</div>`
        : `<div class="result-banner-reasons">${escapeHtml(bi('noIssuesReason').en)} ${escapeHtml(bi('noIssuesReason').zh)}</div>`}
    </div>

    ${problemsBlock}

    <div class="card">
      <div class="review-block">
        <div class="review-block-title">${bi('poInfo').en} / ${bi('poInfo').zh}</div>
        ${reviewRow('poNumber', state.poNumber)}
        ${reviewRow('factoryCode', state.factoryCode)}
        ${reviewRow('date', state.date)}
        ${reviewRow('pointCheckRate', state.pointCheckRate)}
        ${reviewRow('qaLead', state.qaLead)}
        ${reviewRow('creator', state.creator)}
        <div class="review-row"><span class="k">Category / 类别</span><span class="v">${escapeHtml(catLabel.en)} ${escapeHtml(catLabel.zh)}</span></div>
        <div class="review-row"><span class="k">${bi('qaType').en}</span><span class="v">${escapeHtml(qaTypeLabel.en)} ${escapeHtml(qaTypeLabel.zh)}</span></div>
      </div>
      <div class="review-block">
        <div class="review-block-title">${bi('finalApprovalPhotos').en} / ${bi('finalApprovalPhotos').zh}</div>
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
      <button class="btn btn-primary" id="btnSubmit" ${problems.length ? 'disabled' : ''}>${biBlockHtml('submit', 'Submit Report')}</button>
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

  document.querySelectorAll('[data-bind]').forEach((el) => {
    const evt = (el.tagName === 'SELECT') ? 'change' : 'input';
    el.addEventListener(evt, (e) => {
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

  if (name === 'inspectionDetails' || name === 'sizing') {
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
    attachPhotoHandlers();
  }

  if (name === 'sizing') {
    const fitSelect = document.getElementById('fitSelect');
    if (fitSelect) {
      fitSelect.addEventListener('change', (e) => {
        state.categoryData.fit = e.target.value;
        state.categoryData.sizeRows = [];
        render();
      });
    }
    // Targeted, in-place updates for size inputs so the page never jumps/scrolls.
    document.querySelectorAll('[data-size-row]').forEach((el) => {
      el.addEventListener('input', (e) => {
        const ridx = parseInt(el.getAttribute('data-size-row'), 10);
        const point = el.getAttribute('data-size-point');
        state.categoryData.sizeRows[ridx].measured[point] = e.target.value;
        updateSizeCellInPlace(ridx, point);
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

/** Updates a single size-chart cell's tolerance styling without re-rendering the page. */
function updateSizeCellInPlace(ridx, point) {
  const fitDef = CONFIG.fits.fits[state.categoryData.fit];
  if (!fitDef) return;
  const tol = CONFIG.fits.toleranceInches || 0.5;
  const row = state.categoryData.sizeRows[ridx];
  const standard = fitDef.sizes[row.size] || {};
  const measuredVal = row.measured[point] !== undefined ? row.measured[point] : '';
  const measuredNum = parseFloat(measuredVal);
  const outOfTol = isOutOfTolerance(standard[point], measuredVal === '' ? null : measuredNum, tol);

  const cell = document.getElementById(`sizecell_${ridx}_${point}`);
  if (!cell) return;
  const input = cell.querySelector('input');
  const flag = cell.querySelector('.tol-flag');
  cell.classList.toggle('out-of-tol', outOfTol);
  if (input) input.classList.toggle('out-of-tol', outOfTol);
  if (flag) flag.style.display = outOfTol ? 'inline' : 'none';
}

function attachPhotoHandlers() {
  document.querySelectorAll('[data-photo-input]').forEach((el) => {
    el.addEventListener('change', (e) => {
      const fieldId = el.getAttribute('data-photo-input');
      const files = Array.from(e.target.files || []);
      const arr = getPhotoArray(fieldId);
      files.forEach((f) => {
        f._url = URL.createObjectURL(f);
        arr.push(f);
      });
      render();
    });
  });
  document.querySelectorAll('[data-photo-remove]').forEach((el) => {
    el.addEventListener('click', () => {
      const fieldId = el.getAttribute('data-photo-remove');
      const idx = parseInt(el.getAttribute('data-photo-idx'), 10);
      const arr = getPhotoArray(fieldId);
      arr.splice(idx, 1);
      render();
    });
  });
}

/* ---------------- SUBMIT ---------------- */

async function submitReport() {
  const problems = getAllValidationProblems();
  if (problems.length) {
    showToast(bi('validationIncomplete').en + ' / ' + bi('validationIncomplete').zh, true);
    return;
  }

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
      categoryData: {
        fit: state.categoryData.fit,
        sizeRows: state.categoryData.sizeRows,
        fabricColorMatch: state.categoryData.fabricColorMatch,
        fabricWeightMatch: state.categoryData.fabricWeightMatch,
        embroideryColorMatch: state.categoryData.embroideryColorMatch,
        embroideryDimMatch: state.categoryData.embroideryDimMatch,
        printColorMatch: state.categoryData.printColorMatch,
        printDimMatch: state.categoryData.printDimMatch,
        washTagMatch: state.categoryData.washTagMatch,
        generalSizingMatch: state.categoryData.generalSizingMatch,
        packagingCardMatch: state.categoryData.packagingCardMatch,
        bagTagsCorrect: state.categoryData.bagTagsCorrect,
        customNotes: state.categoryData.customNotes
      },
      issues: state.issues.map((i) => ({ description: i.description, severity: i.severity }))
    };

    const formData = new FormData();
    formData.append('payload', JSON.stringify(payload));
    state.photos.general.forEach((f) => formData.append('photo_general', f, f.name));
    state.photos.tags.forEach((f) => formData.append('photo_tags', f, f.name));
    Object.keys(state.categoryData.sectionPhotos).forEach((sectionKey) => {
      state.categoryData.sectionPhotos[sectionKey].forEach((f) => {
        formData.append(`photo_section_${sectionKey === 'washTag' ? 'washtag' : sectionKey}`, f, f.name);
      });
    });
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
      fabricColorMatch: emptyChecklistEntry(),
      fabricWeightMatch: emptyChecklistEntry(),
      embroideryColorMatch: emptyChecklistEntry(),
      embroideryDimMatch: emptyChecklistEntry(),
      printColorMatch: emptyChecklistEntry(),
      printDimMatch: emptyChecklistEntry(),
      washTagMatch: emptyChecklistEntry(),
      generalSizingMatch: emptyChecklistEntry(),
      packagingCardMatch: emptyChecklistEntry(),
      bagTagsCorrect: emptyChecklistEntry(),
      customNotes: '',
      sectionPhotos: { fabric: [], embroidery: [], printing: [], washTag: [], sizing: [], packaging: [] }
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
