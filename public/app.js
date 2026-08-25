/* Juniper QA/QC Report - frontend wizard (vanilla JS, no build step) */

let CONFIG = { fits: { fits: {}, toleranceInches: 0.5 }, i18n: {}, options: {}, categories: { categories: {} }, aql: null };
let I18N = {};
let OPTIONS = {};

let idCounter = 0;
function genId() { idCounter += 1; return `d${Date.now().toString(36)}${idCounter}`; }

function emptyChecklistEntry() { return { status: '', notes: '', defects: [] }; }
function emptyDefect() { return { id: genId(), description: '', severity: 'minor', unitsAffected: 1, photos: [] }; }

const state = {
  category: null,
  subcategory: null,
  poNumber: '', factoryCode: '', date: todayStr(), qaLead: '',
  creator: '', productTitle: '', qaType: 'pre_production',
  poQuantity: '', inspectionLevel: 'II', majorAql: 2.5, minorAql: 4.0,
  productRisk: 'medium', actualUnitsChecked: '',
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
    sectionPhotos: { fabric: [], embroidery: [], printing: [], washTag: [], packaging: [], sizing: [] }
  },
  photos: { general: [], tags: [] },
  additionalIssues: []
};

let step = 0;
const STEPS = ['category', 'orderInfo', 'inspectionDetails', 'sizing', 'photos', 'issues', 'review'];
const CATEGORY_ORDER = ['apparel', 'plush', 'bags', 'accessories', 'other'];
// Fixed industry-standard AQL values (Major 2.5%, Minor 4.0%) - not user-editable.
// Critical is always zero-tolerance (Ac=0/Re=1), handled directly in the plan functions.
const DEFAULT_MAJOR_AQL = 2.5;
const DEFAULT_MINOR_AQL = 4.0;

const CHECKLIST_KEYS = [
  'fabricColorMatch', 'fabricWeightMatch', 'embroideryColorMatch', 'embroideryDimMatch',
  'printColorMatch', 'printDimMatch', 'washTagMatch', 'generalSizingMatch',
  'packagingCardMatch', 'bagTagsCorrect'
];

const otherModeFlags = { factoryCode: false, creator: false, qaLead: false };
let priorReports = [];
let priorReportsPoChecked = null;
const OTHER_VALUE = '__other__';

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function bi(key, fallback) {
  const e = I18N[key];
  if (!e) return { en: fallback || key, zh: '' };
  return { en: e.zh, zh: e.en };
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

/* ---------------- AQL HELPERS (mirror lib/aql.js) ---------------- */

const AQL_KEY_PAIRS = [
  [0.065, '0.065'], [0.10, '0.10'], [0.15, '0.15'], [0.25, '0.25'], [0.40, '0.40'],
  [0.65, '0.65'], [1.0, '1.0'], [1.5, '1.5'], [2.5, '2.5'], [4.0, '4.0'], [6.5, '6.5']
];
function resolveAqlKey(aqlValue) {
  const n = parseFloat(aqlValue);
  if (isNaN(n)) return null;
  const found = AQL_KEY_PAIRS.find(([num]) => Math.abs(num - n) < 0.0001);
  return found ? found[1] : null;
}
function getCodeLetter(lotSize, level) {
  if (!CONFIG.aql) return null;
  const n = parseInt(lotSize, 10);
  if (isNaN(n) || n < 2) return null;
  const row = CONFIG.aql.tableA.rows.find((r) => n >= r.lotMin && (r.lotMax === null || n <= r.lotMax));
  return row ? row[level] : null;
}
function getPlan(codeLetter, aqlValue) {
  if (!CONFIG.aql || !codeLetter) return null;
  const order = CONFIG.aql.codeLetterOrder;
  const idx = order.indexOf(codeLetter);
  if (idx === -1) return null;
  const aqlKey = resolveAqlKey(aqlValue);
  if (!aqlKey) return null;
  const cellAt = (i) => {
    const letter = order[i];
    const row = CONFIG.aql.tableB[letter];
    if (!row) return null;
    const plan = row.plans[aqlKey];
    if (!plan) return null;
    return { sampleSize: row.sampleSize, ac: plan[0], re: plan[1], codeLetterUsed: letter };
  };
  const exact = cellAt(idx);
  if (exact) return exact;
  for (let i = idx - 1; i >= 0; i--) { const hit = cellAt(i); if (hit) return hit; }
  for (let i = idx + 1; i < order.length; i++) { const hit = cellAt(i); if (hit) return hit; }
  return null;
}
function computeAqlPlan({ lotSize, inspectionLevel, majorAql, minorAql }) {
  const codeLetter = getCodeLetter(lotSize, inspectionLevel);
  if (!codeLetter) return null;
  const majorPlan = getPlan(codeLetter, majorAql);
  const minorPlan = getPlan(codeLetter, minorAql);
  if (!majorPlan || !minorPlan) return null;
  const sampleSize = Math.max(majorPlan.sampleSize, minorPlan.sampleSize);
  return {
    lotSize: parseInt(lotSize, 10), inspectionLevel, codeLetter, sampleSize, majorAql, minorAql,
    critical: { sampleSize, ac: 0, re: 1, codeLetterUsed: codeLetter },
    major: majorPlan, minor: minorPlan
  };
}

/* ---------------- AQL RECOMMENDATION (mirrors lib/aqlRecommendation.js) ---------------- */

function getUnitCost(category, subcategory) {
  const unitCosts = CONFIG.unitCosts;
  if (!unitCosts) return null;
  if (category === 'other') return unitCosts.otherCategoryFlat;
  const catCosts = unitCosts.categories && unitCosts.categories[category];
  if (!catCosts) return null;
  if (subcategory && catCosts[subcategory] !== undefined) return catCosts[subcategory];
  return catCosts.other !== undefined ? catCosts.other : null;
}
function computeOrderValue(category, subcategory, poQuantity) {
  const qty = parseInt(poQuantity, 10);
  const cost = getUnitCost(category, subcategory);
  if (isNaN(qty) || qty < 1 || cost === null || cost === undefined) return null;
  return qty * cost;
}
function getPoSizeBand(orderValue) {
  const cfg = CONFIG.aqlRecommendation;
  if (orderValue === null || orderValue === undefined || !cfg) return null;
  const band = cfg.poSizeBands.find((b) => orderValue >= b.min && (b.max === null || orderValue < b.max));
  return band ? band.key : null;
}
function getCreatorTier(creatorName) {
  const cfg = CONFIG.creatorTiers;
  if (!cfg) return null;
  if (creatorName && cfg.tiers[creatorName] !== undefined) return cfg.tiers[creatorName];
  return cfg.defaultTier;
}
function getAqlRecommendation() {
  const orderValue = computeOrderValue(state.category, state.subcategory, state.poQuantity);
  if (orderValue === null) return null;
  const poSizeBand = getPoSizeBand(orderValue);
  if (!poSizeBand) return null;
  const tier = getCreatorTier(state.creator);
  if (!tier) return null;
  const cfg = CONFIG.aqlRecommendation;
  const tierTable = cfg && cfg.table[String(tier)];
  const cell = tierTable && tierTable[state.productRisk] && tierTable[state.productRisk][poSizeBand];
  if (!cell) return null;
  return { orderValue, poSizeBand, tier, pointCheck: cell.pointCheck, inspectionLevel: cell.inspectionLevel };
}
function levelNumberToRoman(n) { return n === 1 ? 'I' : n === 2 ? 'II' : 'III'; }
function syncInspectionLevelToRecommendation() {
  // Inspection Level has no UI control anymore - it's always derived silently
  // from the recommendation (Creator Tier + Risk + PO Size), used only to compute
  // the reference thresholds below.
  const rec = getAqlRecommendation();
  if (rec) state.inspectionLevel = levelNumberToRoman(rec.inspectionLevel);
}

function getEffectiveCodeLetterFromCount(actualCount) {
  if (!CONFIG.aql) return null;
  const order = CONFIG.aql.codeLetterOrder;
  let best = null;
  for (const letter of order) {
    const row = CONFIG.aql.tableB[letter];
    if (row.sampleSize <= actualCount) best = letter;
    else break;
  }
  return best;
}
function computeActualAqlPlan() {
  const actualCount = parseInt(state.actualUnitsChecked, 10);
  if (isNaN(actualCount) || actualCount < 2) return null;
  const codeLetter = getEffectiveCodeLetterFromCount(actualCount);
  if (!codeLetter) return null;
  const majorPlan = getPlan(codeLetter, DEFAULT_MAJOR_AQL);
  const minorPlan = getPlan(codeLetter, DEFAULT_MINOR_AQL);
  if (!majorPlan || !minorPlan) return null;
  return {
    actualCount, majorAql: DEFAULT_MAJOR_AQL, minorAql: DEFAULT_MINOR_AQL,
    critical: { sampleSize: actualCount, ac: 0, re: 1, codeLetterUsed: codeLetter },
    major: majorPlan, minor: minorPlan
  };
}

/* ---------------- DEFECT COLLECTION (mirrors lib/passFail.js) ---------------- */

function collectAllDefects() {
  const all = [];
  CHECKLIST_KEYS.forEach((key) => {
    const item = state.categoryData[key];
    if (item && Array.isArray(item.defects)) item.defects.forEach((d) => all.push(d));
  });
  state.additionalIssues.forEach((d) => all.push(d));
  return all;
}
function sumDefectsBySeverity(defects) {
  const sums = { minor: 0, major: 0, critical: 0 };
  defects.forEach((d) => {
    const n = parseInt(d.unitsAffected, 10);
    const qty = isNaN(n) || n < 1 ? 1 : n;
    if (sums[d.severity] !== undefined) sums[d.severity] += qty;
  });
  return sums;
}
function findDefectById(id) {
  for (const key of CHECKLIST_KEYS) {
    const item = state.categoryData[key];
    if (item && item.defects) {
      const found = item.defects.find((d) => d.id === id);
      if (found) return found;
    }
  }
  return state.additionalIssues.find((d) => d.id === id) || null;
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
  if (name === 'inspectionDetails') {
    return [
      ['fabricColorMatch', 'fabricColorMatch'], ['fabricWeightMatch', 'fabricWeightMatch'],
      ['embroideryColorMatch', 'embroideryColorMatch'], ['embroideryDimMatch', 'embroideryDimMatch'],
      ['printColorMatch', 'printColorMatch'], ['printDimMatch', 'printDimMatch'],
      ['washTagMatch', 'washTagMatch'],
      ['packagingCardMatch', 'packagingCardMatch'], ['bagTagsCorrect', 'bagTagsCorrect']
    ];
  }
  if (name === 'sizing' && (state.category !== 'apparel' || state.categoryData.fit === OTHER_FIT_VALUE)) {
    return [['generalSizingMatch', 'generalSizingMatch']];
  }
  return [];
}
function findMissingChecklistStatuses(name) {
  return checklistDefsForStep(name).filter(([key]) => !state.categoryData[key].status);
}
function findChecklistItemsMissingDefects(name) {
  return checklistDefsForStep(name).filter(([key]) => {
    const entry = state.categoryData[key];
    return entry.status === 'fail' && (!entry.defects || entry.defects.length === 0);
  });
}
function findIncompleteDefects(defectList) {
  return defectList.filter((d) => !d.description || !d.description.trim() || !d.photos || d.photos.length === 0);
}
function apparelSizingIncomplete() {
  if (state.category !== 'apparel') return false;
  if (!state.categoryData.fit) return true;
  if (state.categoryData.fit === OTHER_FIT_VALUE) {
    return !state.categoryData.generalSizingMatch.status;
  }
  const rows = state.categoryData.sizeRows || [];
  const hasAnyMeasurement = rows.some((r) => r.measured && Object.values(r.measured).some((v) => v !== '' && v !== undefined));
  return !hasAnyMeasurement;
}
function currentCategoryDef() {
  return (CONFIG.categories && CONFIG.categories.categories) ? CONFIG.categories.categories[state.category] : null;
}
function categoryHasSubcategories() {
  const def = currentCategoryDef();
  return !!(def && def.subcategories && def.subcategories.length);
}

function validateChecklistStepGeneric(name) {
  let ok = true;
  const missingStatus = findMissingChecklistStatuses(name);
  const missingDefects = findChecklistItemsMissingDefects(name);
  missingStatus.forEach(([key]) => markChecklistError(key));
  missingDefects.forEach(([key]) => markChecklistError(key));

  const relevantDefects = checklistDefsForStep(name)
    .filter(([key]) => state.categoryData[key].status === 'fail')
    .flatMap(([key]) => state.categoryData[key].defects || []);
  const incomplete = findIncompleteDefects(relevantDefects);
  incomplete.forEach((d) => markDefectError(d.id));

  if (incomplete.some((d) => !d.photos || d.photos.length === 0)) {
    showToast(bi('photoRequiredForDefect').en + ' / ' + bi('photoRequiredForDefect').zh, true);
    ok = false;
  } else if (incomplete.length) {
    showToast(bi('descriptionRequiredForDefect').en + ' / ' + bi('descriptionRequiredForDefect').zh, true);
    ok = false;
  } else if (missingDefects.length) {
    showToast(bi('defectRequiredForFail').en + ' / ' + bi('defectRequiredForFail').zh, true);
    ok = false;
  } else if (missingStatus.length) {
    showToast(bi('allChecksRequired').en + ' / ' + bi('allChecksRequired').zh, true);
    ok = false;
  }
  return ok;
}

function validateStep(s) {
  clearErrors();
  const name = STEPS[s];
  let ok = true;

  if (name === 'category') {
    if (!state.category) { showToast('Please select a product category / 请选择产品类别', true); ok = false; }
    else if (categoryHasSubcategories() && !state.subcategory) {
      showToast(bi('selectSubcategory').en + ' / ' + bi('selectSubcategory').zh, true);
      ok = false;
    }
  } else if (name === 'orderInfo') {
    const required = ['poNumber', 'factoryCode', 'date', 'qaLead'];
    required.forEach((f) => {
      if (!state[f] || !String(state[f]).trim()) { markError(f); ok = false; }
    });
    if (!state.poQuantity || parseInt(state.poQuantity, 10) < 2) { markError('poQuantity'); ok = false; }
    if (state.qaType === 'production' && !state.actualUnitsChecked) {
      markError('actualUnitsChecked');
      ok = false;
    }
    if (!ok) showToast('Please fill in all required fields / 请填写所有必填项', true);
  } else if (name === 'inspectionDetails') {
    ok = validateChecklistStepGeneric(name);
  } else if (name === 'sizing') {
    if (state.category === 'apparel' && state.categoryData.fit !== OTHER_FIT_VALUE) {
      if (apparelSizingIncomplete()) {
        showToast(bi('selectFitRequired').en + ' / ' + bi('selectFitRequired').zh, true);
        ok = false;
      }
    } else {
      ok = validateChecklistStepGeneric(name);
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
function markDefectError(id) {
  const el = document.querySelector(`[data-defect-card="${id}"]`);
  if (el) el.classList.add('has-error');
}
function clearErrors() {
  document.querySelectorAll('.has-error').forEach((el) => el.classList.remove('has-error'));
}

function getAllValidationProblems() {
  const problems = [];
  if (!state.category) problems.push(bi('selectCategory'));
  else if (categoryHasSubcategories() && !state.subcategory) problems.push(bi('selectSubcategory'));

  ['poNumber', 'factoryCode', 'date', 'qaLead'].forEach((f) => {
    if (!state[f] || !String(state[f]).trim()) problems.push(bi(f));
  });
  if (!state.poQuantity || parseInt(state.poQuantity, 10) < 2) problems.push(bi('poQuantity'));
  if (state.qaType === 'production' && !state.actualUnitsChecked) problems.push(bi('actualSpotCheckRequired'));

  const detailDefs = checklistDefsForStep('inspectionDetails');
  const sizingDefs = (state.category === 'apparel' && state.categoryData.fit !== OTHER_FIT_VALUE) ? [] : checklistDefsForStep('sizing');
  const allDefs = detailDefs.concat(sizingDefs);

  const missingStatus = allDefs.filter(([key]) => !state.categoryData[key].status);
  if (missingStatus.length) problems.push(bi('allChecksRequired'));

  const missingDefects = allDefs.filter(([key]) => {
    const entry = state.categoryData[key];
    return entry.status === 'fail' && (!entry.defects || entry.defects.length === 0);
  });
  if (missingDefects.length) problems.push(bi('defectRequiredForFail'));

  const allLoggedDefects = collectAllDefects();
  const incomplete = findIncompleteDefects(allLoggedDefects);
  if (incomplete.some((d) => !d.photos || d.photos.length === 0)) problems.push(bi('photoRequiredForDefect'));
  else if (incomplete.length) problems.push(bi('descriptionRequiredForDefect'));

  if (state.category === 'apparel' && state.categoryData.fit !== OTHER_FIT_VALUE && apparelSizingIncomplete()) problems.push(bi('selectFitRequired'));

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

  const allDefects = collectAllDefects();
  const { critical: criticalCount, major: majorCount, minor: minorCount } = sumDefectsBySeverity(allDefects);

  let aql;
  if (state.qaType === 'pre_production') {
    aql = { criticalCount, majorCount, minorCount, isFallback: true, isPreProduction: true };
  } else {
    const checked = parseInt(state.actualUnitsChecked, 10);
    if (!isNaN(checked) && checked >= 1) {
      const rejected = Math.min(checked, majorCount + criticalCount);
      const recap = { poSize: parseInt(state.poQuantity, 10) || null, quantityChecked: checked, quantityRejected: rejected, quantityApproved: checked - rejected };
      if (rejected >= checked) reasons.push('allRejected');
      aql = { criticalCount, majorCount, minorCount, isFallback: false, isActual: true, recap };
    } else {
      if (minorCount >= 3) reasons.push('minor');
      if (majorCount + criticalCount >= 1) reasons.push('major');
      aql = { criticalCount, majorCount, minorCount, isFallback: true };
    }
  }

  return { overall: reasons.length ? 'fail' : 'pass', reasons, aql };
}

/* ---------------- PHOTO STORAGE HELPERS ---------------- */

function getPhotoArray(fieldId) {
  if (fieldId === 'general') return state.photos.general;
  if (fieldId === 'tags') return state.photos.tags;
  if (fieldId.startsWith('section:')) return state.categoryData.sectionPhotos[fieldId.split(':')[1]];
  if (fieldId.startsWith('sizerow:')) return state.categoryData.sizeRows[parseInt(fieldId.split(':')[1], 10)].photos;
  if (fieldId.startsWith('defect:')) {
    const d = findDefectById(fieldId.split(':')[1]);
    return d ? d.photos : [];
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
  else if (name === 'issues') html = renderAdditionalIssuesStep();
  else if (name === 'review') html = renderReviewStep();

  root.innerHTML = html;
  attachStepHandlers(name);
}

/* ---- Step 0: Category + Subcategory ---- */
function renderCategoryStep() {
  const cats = (CONFIG.categories && CONFIG.categories.categories) || {};
  const orderedKeys = CATEGORY_ORDER.filter((k) => cats[k]);

  const catCards = orderedKeys.map((key) => {
    const c = cats[key];
    const sel = state.category === key ? 'selected' : '';
    const cardHtml = `<div class="category-option ${sel} ${key === state.category && c.subcategories && c.subcategories.length ? 'has-subcat-open' : ''}" data-cat="${key}">
      <div class="category-icon">${c.icon || '📦'}</div>
      <div>
        <div class="category-label-en">${escapeHtml(c.label_zh)}</div>
        <div class="category-label-zh">${escapeHtml(c.label_en)}</div>
      </div>
    </div>`;

    let inlineSubcatBlock = '';
    if (key === state.category && c.subcategories && c.subcategories.length) {
      const chips = c.subcategories.map((s) => {
        const subSel = state.subcategory === s.key ? 'selected' : '';
        return `<div class="segmented-option ${subSel}" data-subcat="${s.key}" style="flex: 0 0 auto; min-width: 100px;">
          ${escapeHtml(s.label_zh)}<span class="zh">${escapeHtml(s.label_en)}</span>
        </div>`;
      }).join('');
      inlineSubcatBlock = `
        <div class="subcategory-inline">
          <div class="section-photos-label">${biBlockHtml('selectSubcategory', 'Select Type')}</div>
          <div class="segmented" style="flex-wrap:wrap;">${chips}</div>
        </div>
      `;
    }

    return `<div>${cardHtml}${inlineSubcatBlock}</div>`;
  }).join('');

  return `
    <div style="display:flex; justify-content:flex-end; gap:16px; margin-bottom:4px;">
      <a href="analytics.html" class="settings-link" title="Analytics">📊 ${escapeHtml(bi('analyticsLink').en)}</a>
      <a href="settings.html" class="settings-link" title="Settings">⚙️ ${escapeHtml(bi('settingsTitle').en)}</a>
    </div>
    <div class="step-eyebrow">${biHtml('step', 'Step')} 1 / 7</div>
    <div class="step-title">选择产品类别<span class="zh">Select Product Category</span></div>
    <div class="category-grid">${catCards}</div>
    <div class="nav-buttons">
      <button class="btn btn-primary" id="btnNext">${biBlockHtml('next', 'Next')}</button>
    </div>
  `;
}

/** Looks up prior reports for the currently-entered PO Number and refreshes the card. */
async function fetchPriorReports() {
  const po = (state.poNumber || '').trim();
  if (!po || po === priorReportsPoChecked) return;
  priorReportsPoChecked = po;
  try {
    const res = await fetch(`/api/submission-history/${encodeURIComponent(po)}`);
    if (!res.ok) { priorReports = []; return; }
    const data = await res.json();
    priorReports = data.reports || [];
  } catch (e) {
    console.error('Failed to fetch prior reports', e);
    priorReports = [];
  } finally {
    const card = document.getElementById('priorReportCard');
    if (card) card.innerHTML = renderPriorReportCard();
  }
}

function renderPriorReportCard() {
  if (!priorReports.length) return '';
  const latest = priorReports[0];
  const qaTypeLabel = latest.qaType === 'production' ? bi('production') : bi('prePro');
  const resultLabel = latest.overallResult === 'pass' ? bi('resultPass') : bi('resultFail');
  const issuesHtml = (latest.issues && latest.issues.length)
    ? `<ul style="margin:8px 0 0 0; padding-left:18px; font-size:13px;">
        ${latest.issues.map((iss) => {
          const sevLabel = bi(iss.severity);
          return `<li>${escapeHtml(iss.description || '-')} <span style="color:var(--jc-muted); font-size:11.5px;">(${escapeHtml(sevLabel.en)} ${escapeHtml(sevLabel.zh)}${iss.unitsAffected > 1 ? ` · ${iss.unitsAffected} ${escapeHtml(bi('unitsAffected').en)}` : ''})</span></li>`;
        }).join('')}
      </ul>`
    : `<div class="section-help" style="margin-top:6px;">${escapeHtml(bi('noIssues').en)} / ${escapeHtml(bi('noIssues').zh)}</div>`;

  return `
    <div class="card" style="background:var(--jc-mint-light); border-color:var(--jc-teal);">
      <div class="section-title">${biBlockHtml('priorReportFound', 'Previous Report Found')}</div>
      <div class="section-help">
        ${escapeHtml(qaTypeLabel.en)} ${escapeHtml(qaTypeLabel.zh)} · ${escapeHtml(latest.date || '')} ·
        <strong style="color:${latest.overallResult === 'pass' ? 'var(--jc-teal-dark)' : 'var(--jc-fail)'}">${escapeHtml(resultLabel.en)} ${escapeHtml(resultLabel.zh)}</strong>
      </div>
      <div class="section-photos-label" style="margin-top:10px;">${biBlockHtml('priorReportIssues', 'Issues Found')}</div>
      ${issuesHtml}
      <a href="/submissions/${encodeURIComponent(latest.pdfFilename)}" target="_blank" rel="noopener" class="btn btn-secondary" style="display:block; text-decoration:none; text-align:center; margin-top:12px; max-width:260px;">
        ${escapeHtml(bi('downloadFullReport').en)} / ${escapeHtml(bi('downloadFullReport').zh)}
      </a>
      ${priorReports.length > 1 ? `<div class="section-help" style="margin-top:8px;">${priorReports.length - 1} ${escapeHtml(bi('moreEarlierReports').en)} ${escapeHtml(bi('moreEarlierReports').zh)}</div>` : ''}
    </div>
  `;
}

/* ---- Step 1: Order Info (+ AQL setup) ---- */
function renderOrderInfoStep() {
  return `
    <div class="step-eyebrow">${biHtml('step', 'Step')} 2 / 7</div>
    <div class="step-title">订单信息<span class="zh">Order Information</span></div>
    <div class="card">
      ${textField('poNumber', 'poNumber', state.poNumber, { required: true, placeholderKey: 'poNumberPlaceholder' })}
      <div id="priorReportCard">${renderPriorReportCard()}</div>
      ${selectFieldWithOther('factoryCode', 'factoryCode', state.factoryCode, OPTIONS.factoryCodes || [], { required: true })}
      <div class="field-row">
        <div style="flex:1">${dateField('date', 'date', state.date, { required: true })}</div>
      </div>
      ${selectFieldWithOther('qaLead', 'qaLead', state.qaLead, OPTIONS.qaLeads || [], { required: true })}
      <div class="field-row">
        <div style="flex:1">${selectFieldWithOther('creator', 'creator', state.creator, OPTIONS.creators || [], {})}</div>
        <div style="flex:1">${textField('productTitle', 'productTitle', state.productTitle, {})}</div>
      </div>
      <div class="field">
        <label class="field-label">${biBlockHtml('qaType', 'QA Type')}</label>
        <div class="segmented" id="qaTypeSeg">
          ${segOption('qaType', 'pre_production', 'prePro', state.qaType)}
          ${segOption('qaType', 'production', 'production', state.qaType)}
        </div>
      </div>
      ${numberField('poQuantity', 'poQuantity', state.poQuantity, { required: true, placeholderKey: 'poQuantityPlaceholder' })}
      <div class="field">
        <label class="field-label">${biBlockHtml('productRisk', 'Product Complexity/Risk')}</label>
        <div class="segmented">
          ${['high', 'medium', 'low'].map((r) => `<div class="segmented-option ${state.productRisk === r ? 'selected' : ''}" data-seg="productRisk" data-val="${r}">${escapeHtml(bi('risk' + r.charAt(0).toUpperCase() + r.slice(1)).en)}<span class="zh">${escapeHtml(bi('risk' + r.charAt(0).toUpperCase() + r.slice(1)).zh)}</span></div>`).join('')}
        </div>
      </div>
    </div>

    <div id="aqlSection">${renderAqlSection()}</div>

    <div class="nav-buttons">
      <button class="btn btn-secondary" id="btnBack">${biBlockHtml('back', 'Back')}</button>
      <button class="btn btn-primary" id="btnNext">${biBlockHtml('next', 'Next')}</button>
    </div>
  `;
}

/** The whole conditional AQL card - hidden for Pre-Production, full recommendation
 *  + reference + actual-spot-check flow for Production. Re-rendered into
 *  #aqlSection whenever PO Quantity / Risk / Creator / QA Type / AQL settings change,
 *  without a full page re-render (keeps focus/scroll stable while typing). */
function renderAqlSection() {
  if (state.qaType === 'pre_production') return '';

  syncInspectionLevelToRecommendation();
  const rec = getAqlRecommendation();

  let recBlock;
  if (rec) {
    const range = pointCheckRangeToUnits(rec.pointCheck, state.poQuantity);
    recBlock = `
      <div class="aql-preview">
        <div class="aql-preview-row"><span>${escapeHtml(bi('creatorTierLabel').en)} <span class="zh">${escapeHtml(bi('creatorTierLabel').zh)}</span></span><strong>Tier ${rec.tier}</strong></div>
        <div class="aql-preview-row"><span>${escapeHtml(bi('orderValue').en)} <span class="zh">${escapeHtml(bi('orderValue').zh)}</span></span><strong>$${rec.orderValue.toLocaleString()}</strong></div>
        <div class="aql-preview-row"><span>${escapeHtml(bi('recommendedQuantityRange').en)} <span class="zh">${escapeHtml(bi('recommendedQuantityRange').zh)}</span></span><strong>${range ? `${range[0].toLocaleString()} - ${range[1].toLocaleString()}` : '-'} (${escapeHtml(rec.pointCheck)})</strong></div>
      </div>
    `;
  } else {
    recBlock = `<div class="section-help" style="margin-top:8px;">${escapeHtml(bi('needMoreInfoForRecommendation').en)}<br/>${escapeHtml(bi('needMoreInfoForRecommendation').zh)}</div>`;
  }

  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('aqlRecommendationTitle', 'Spot Check Recommendation')}</div>
      ${recBlock}
    </div>

    <div class="card">
      <div class="section-title">${biBlockHtml('actualUnitsChecked', 'Units Checked')}<span class="required">*</span></div>
      <div class="section-help">${escapeHtml(bi('actualUnitsCheckedHelp').en)}<br/>${escapeHtml(bi('actualUnitsCheckedHelp').zh)}</div>
      <div class="field" data-field="actualUnitsChecked">
        <input type="number" min="1" step="1" inputmode="numeric" id="actualUnitsCheckedInput" value="${escapeHtml(state.actualUnitsChecked)}" placeholder="${escapeHtml(bi('actualUnitsCheckedPlaceholder').en)}" />
      </div>
      <div id="unitsCheckedDerived">${renderUnitsCheckedDerived()}</div>
    </div>
  `;
}

/** The part of the Units Checked card that depends on the typed value (percent
 *  display + Found/Accepted table) - refreshed on every keystroke WITHOUT
 *  touching the input element itself, so focus never gets lost mid-typing. */
function renderUnitsCheckedDerived() {
  const computedPercent = (state.actualUnitsChecked && state.poQuantity)
    ? Math.round((parseInt(state.actualUnitsChecked, 10) / parseInt(state.poQuantity, 10)) * 1000) / 10
    : null;
  const result = computeOverallResult();
  const recapTableBlock = (result.aql && result.aql.isActual) ? foundAcceptedTableHtml(result.aql) : `<div class="section-help" style="margin-top:10px;">${escapeHtml(bi('enterActualSpotCheckFirst').en)}<br/>${escapeHtml(bi('enterActualSpotCheckFirst').zh)}</div>`;
  return `
    ${computedPercent !== null ? `<div class="section-help" style="margin-top:6px;">≈ <strong>${computedPercent}%</strong> ${escapeHtml(bi('computedPercentOfPo').en)} <span class="zh">${escapeHtml(bi('computedPercentOfPo').zh)}</span></div>` : ''}
    ${recapTableBlock}
  `;
}

/** Critical/Major/Minor table showing Found vs Accepted (no Accept/Reject thresholds -
 *  Major/Critical finds are simply rejected on a per-unit basis; Minor finds stay
 *  accepted, since minor issues don't make a unit unsaleable). */
function foundAcceptedTableHtml(aql) {
  const row = (labelKey, count, accepted) => `<tr><td>${escapeHtml(bi(labelKey).en)}</td><td>${count}</td><td>${accepted}</td></tr>`;
  return `
    <table class="aql-preview-table" style="margin-top:10px;">
      <thead><tr><th></th><th>${escapeHtml(bi('foundLabel').en)}</th><th>${escapeHtml(bi('acceptedLabel').en)}</th></tr></thead>
      <tbody>
        ${row('aqlCritical', aql.criticalCount, 0)}
        ${row('aqlMajor', aql.majorCount, 0)}
        ${row('aqlMinor', aql.minorCount, aql.minorCount)}
      </tbody>
    </table>
  `;
}

/** Parses a "40-70%" style range against a PO quantity into an actual unit-count range. */
function pointCheckRangeToUnits(pointCheckStr, poQuantity) {
  const qty = parseInt(poQuantity, 10);
  if (isNaN(qty) || qty < 1) return null;
  const match = String(pointCheckStr).match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const lowPct = parseFloat(match[1]);
  const highPct = parseFloat(match[2]);
  return [Math.round(qty * (lowPct / 100)), Math.round(qty * (highPct / 100))];
}

function aqlThresholdTableHtml(plan) {
  return `
    <table class="aql-preview-table">
      <thead><tr><th></th><th>${escapeHtml(bi('aqlAccept').en)}</th><th>${escapeHtml(bi('aqlReject').en)}</th></tr></thead>
      <tbody>
        <tr><td>${escapeHtml(bi('aqlCritical').en)}</td><td>${plan.critical.ac}</td><td>${plan.critical.re}</td></tr>
        <tr><td>${escapeHtml(bi('aqlMajor').en)} (${plan.majorAql})</td><td>${plan.major.ac}</td><td>${plan.major.re}</td></tr>
        <tr><td>${escapeHtml(bi('aqlMinor').en)} (${plan.minorAql})</td><td>${plan.minor.ac}</td><td>${plan.minor.re}</td></tr>
      </tbody>
    </table>
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
function numberField(id, i18nKey, value, opts = {}) {
  const l = bi(i18nKey);
  const ph = opts.placeholderKey ? bi(opts.placeholderKey) : { en: '', zh: '' };
  return `
    <div class="field" data-field="${id}">
      <label class="field-label">${escapeHtml(l.en)} <span class="zh">${escapeHtml(l.zh)}</span>${opts.required ? '<span class="required">*</span>' : ''}</label>
      <input type="number" min="2" step="1" inputmode="numeric" data-bind-live="${id}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(ph.en)} / ${escapeHtml(ph.zh)}" />
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
function selectNumberField(id, i18nKey, value, optionsList) {
  const l = bi(i18nKey);
  const opts_html = optionsList.map((o) => `<option value="${o}" ${parseFloat(value) === o ? 'selected' : ''}>${o}</option>`).join('');
  return `
    <div class="field" data-field="${id}">
      <label class="field-label">${escapeHtml(l.en)} <span class="zh">${escapeHtml(l.zh)}</span></label>
      <select data-bind-live="${id}">${opts_html}</select>
    </div>
  `;
}
function selectFieldWithOther(id, i18nKey, value, optionsList, opts = {}) {
  const l = bi(i18nKey);
  const ph = bi('selectPlaceholder');
  const otherLabel = bi('other');
  const isOther = otherModeFlags[id] || (!!value && !optionsList.includes(value));
  const opts_html = optionsList.map((o) => `<option value="${escapeHtml(o)}" ${!isOther && value === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');
  const otherPh = bi('otherPlaceholder');
  return `
    <div class="field" data-field="${id}">
      <label class="field-label">${escapeHtml(l.en)} <span class="zh">${escapeHtml(l.zh)}</span>${opts.required ? '<span class="required">*</span>' : ''}</label>
      <select data-select-other="${id}">
        <option value="">${escapeHtml(ph.en)} / ${escapeHtml(ph.zh)}</option>
        ${opts_html}
        <option value="${OTHER_VALUE}" ${isOther ? 'selected' : ''}>${escapeHtml(otherLabel.en)} / ${escapeHtml(otherLabel.zh)}</option>
      </select>
      ${isOther ? `<input type="text" data-other-text="${id}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(otherPh.en)} / ${escapeHtml(otherPh.zh)}" style="margin-top:8px;" />` : ''}
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

/* ---- Step 2: Inspection Details ---- */
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
    <div class="step-title">检验详情<span class="zh">Inspection Details</span></div>
    ${body}
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="btnBack">${biBlockHtml('back', 'Back')}</button>
      <button class="btn btn-primary" id="btnNext">${biBlockHtml('next', 'Next')}</button>
    </div>
  `;
}

function checklistItem(key, i18nKey) {
  const entry = state.categoryData[key];
  const l = bi(i18nKey);
  const defectsBlock = entry.status === 'fail' ? `
    <div class="defects-block">
      <div class="defects-label">${biBlockHtml('defectsFound', 'Defects Found')}</div>
      ${(entry.defects || []).map((d) => defectCard(d, key)).join('')}
      <button type="button" class="add-defect-btn" data-add-defect="${key}">${escapeHtml(bi('addDefect').en)} <span class="zh">${escapeHtml(bi('addDefect').zh)}</span></button>
    </div>
  ` : '';
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
      ${defectsBlock}
    </div>
  `;
}

function defectCard(d, ownerKey) {
  const missingDesc = !d.description || !d.description.trim();
  const missingPhoto = !d.photos || d.photos.length === 0;
  return `
    <div class="defect-card" data-defect-card="${d.id}" data-owner="${ownerKey || ''}">
      <div class="field">
        <label class="field-label">${biBlockHtml('defectDescription', 'Defect Description')}${missingDesc ? '<span class="required">*</span>' : ''}</label>
        <textarea data-defect-field="description" data-defect-id="${d.id}" placeholder="${escapeHtml(bi('defectDescriptionPlaceholder').en)} / ${escapeHtml(bi('defectDescriptionPlaceholder').zh)}">${escapeHtml(d.description)}</textarea>
      </div>
      <div class="field-row">
        <div style="flex:1">
          <label class="field-label">${biBlockHtml('severity')}</label>
          <div class="segmented">
            ${['minor', 'major', 'critical'].map((s) => {
              const sl = bi(s);
              const sel = d.severity === s ? 'selected' : '';
              return `<div class="segmented-option ${sel}" data-defect-severity="${d.id}" data-val="${s}">${escapeHtml(sl.en)}<span class="zh">${escapeHtml(sl.zh)}</span></div>`;
            }).join('')}
          </div>
          <div class="severity-definition">${escapeHtml(bi(d.severity + 'Definition').en)}<span class="zh">${escapeHtml(bi(d.severity + 'Definition').zh)}</span></div>
        </div>
      </div>
      <div class="field">
        <label class="field-label">${biBlockHtml('unitsAffected', 'Units Affected')}</label>
        <input type="number" min="1" step="1" inputmode="numeric" value="${escapeHtml(d.unitsAffected)}" data-defect-units="${d.id}" style="max-width:120px;" />
      </div>
      <div class="field">
        <label class="field-label">${biBlockHtml('defectPhotos', 'Defect Photos')}${missingPhoto ? '<span class="required">*</span>' : ''}</label>
        ${photoGrid('defect:' + d.id, true)}
      </div>
      <button type="button" class="remove-defect-btn" data-remove-defect="${d.id}">${escapeHtml(bi('removeIssue').en)} / ${escapeHtml(bi('removeIssue').zh)}</button>
    </div>
  `;
}

function checklistCard(sectionKey, rows, photoSectionKey) {
  return `
    <div class="card">
      <div class="section-title">${biBlockHtml(sectionKey)}</div>
      ${rows.map(([k, lk]) => checklistItem(k, lk)).join('')}
      ${photoSectionKey ? `
        <div class="section-photos-block">
          <div class="section-photos-label">${biBlockHtml('sectionPhotosGeneral', 'Section Photos')}</div>
          <div class="section-help" style="margin-bottom:6px;">${escapeHtml(bi('sectionPhotosHelp').en)} / ${escapeHtml(bi('sectionPhotosHelp').zh)}</div>
          ${photoGrid('section:' + photoSectionKey, true)}
        </div>
      ` : ''}
    </div>
  `;
}

/* ---- Step 3: Sizing ---- */
function fitsForCurrentSubcategory() {
  const allFits = CONFIG.fits.fits || {};
  const def = currentCategoryDef();
  const sub = def && (def.subcategories || []).find((s) => s.key === state.subcategory);
  const group = sub ? sub.fitGroup : null;
  if (!group) return allFits;
  const filtered = {};
  Object.keys(allFits).forEach((key) => { if (allFits[key].group === group) filtered[key] = allFits[key]; });
  return Object.keys(filtered).length ? filtered : allFits;
}

const OTHER_FIT_VALUE = '__other_fit__';

function renderSizingStep() {
  let body = '';
  if (state.category === 'apparel') {
    body += renderFitPicker();
    if (state.categoryData.fit === OTHER_FIT_VALUE) {
      body += checklistCard('sizingSection', [['generalSizingMatch', 'generalSizingMatch']], 'sizing');
    } else if (state.categoryData.fit) {
      body += renderReferenceChart();
      body += renderSizeEntryTable();
    }
  } else {
    body += renderToleranceGuidance();
    body += checklistCard('sizingSection', [['generalSizingMatch', 'generalSizingMatch']], 'sizing');
  }

  return `
    <div class="step-eyebrow">${biHtml('step', 'Step')} 4 / 7</div>
    <div class="step-title">尺寸<span class="zh">Sizing</span></div>
    ${body}
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="btnBack">${biBlockHtml('back', 'Back')}</button>
      <button class="btn btn-primary" id="btnNext">${biBlockHtml('next', 'Next')}</button>
    </div>
  `;
}
function renderFitPicker() {
  const fits = fitsForCurrentSubcategory();
  const options = Object.keys(fits).map((key) => {
    const f = fits[key];
    const sel = state.categoryData.fit === key ? 'selected' : '';
    return `<option value="${key}" ${sel}>${escapeHtml(f.label_zh)} / ${escapeHtml(f.label_en)}</option>`;
  }).join('');
  const otherSel = state.categoryData.fit === OTHER_FIT_VALUE ? 'selected' : '';
  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('fitSelect', 'Standard Fit')}</div>
      <div class="field">
        <select id="fitSelect">
          <option value="">${escapeHtml(bi('fitSelectPlaceholder').en)} / ${escapeHtml(bi('fitSelectPlaceholder').zh)}</option>
          ${options}
          <option value="${OTHER_FIT_VALUE}" ${otherSel}>${escapeHtml(bi('fitOther').en)} / ${escapeHtml(bi('fitOther').zh)}</option>
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
    return `<th>${escapeHtml(pl.zh || pl.en)}<span class="zh">${escapeHtml(pl.en)}</span></th>`;
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
    cd.sizeRows = Object.keys(fitDef.sizes).map((size) => ({ size, measured: {}, photos: [] }));
    cd._fitForRows = cd.fit;
  }

  const cards = cd.sizeRows.map((row, ridx) => {
    const standard = fitDef.sizes[row.size] || {};
    const pointFields = fitDef.points.map((p) => {
      const pl = fitDef.pointLabels[p] || { en: p, zh: '' };
      const std = standard[p];
      const measuredVal = row.measured[p] !== undefined ? row.measured[p] : '';
      const measuredNum = parseFloat(measuredVal);
      const outOfTol = isOutOfTolerance(std, measuredVal === '' ? null : measuredNum, tol);
      return `
        <div class="size-point-field ${outOfTol ? 'out-of-tol' : ''}" id="sizecell_${ridx}_${p}">
          <label class="size-point-label">${escapeHtml(pl.zh || pl.en)} <span class="zh">${escapeHtml(pl.en)}</span></label>
          <span class="std-val">${escapeHtml(bi('standard').en)}: ${escapeHtml(formatStandard(std))}</span>
          <input type="number" step="0.1" inputmode="decimal" value="${escapeHtml(measuredVal)}"
            class="${outOfTol ? 'out-of-tol' : ''}"
            data-size-row="${ridx}" data-size-point="${p}" placeholder="0.0" />
          <span class="tol-flag" style="display:${outOfTol ? 'inline' : 'none'}">${escapeHtml(bi('outOfTolerance').en)}</span>
        </div>
      `;
    }).join('');

    return `
      <div class="size-card">
        <div class="size-card-header">${escapeHtml(row.size)}</div>
        <div class="size-point-grid">${pointFields}</div>
        <div class="size-card-photos">
          <div class="section-photos-label">${biBlockHtml('sizingPhotosForSize', 'Photos for this size')}</div>
          ${photoGrid('sizerow:' + ridx, true)}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('enterMeasurements', 'Enter Measurements')}</div>
      <div class="section-help">${escapeHtml(bi('sizeChartHelp').en)}<br/>${escapeHtml(bi('sizeChartHelp').zh)}</div>
      ${cards}
    </div>
  `;
}
function renderToleranceGuidance() {
  const catDef = currentCategoryDef();
  const key = catDef && catDef.toleranceGuidanceKey;
  if (!key) return '';
  const text = bi(key);
  return `
    <div class="card" style="background:var(--jc-warn-bg); border-color:#F0D9A8;">
      <div class="section-title" style="color:var(--jc-warn);">${biBlockHtml('toleranceReferenceTitle', 'Tolerance Reference')}</div>
      <div class="section-help" style="color:var(--jc-warn);">${escapeHtml(text.en)}<br/>${escapeHtml(text.zh)}</div>
    </div>
  `;
}

function renderSizingPhotosCard() {
  return `
    <div class="card">
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

/* ---- Step 5: Additional Issues (catch-all) ---- */
function renderAdditionalIssuesStep() {
  const issuesHtml = state.additionalIssues.map((issue) => defectCard(issue, null)).join('');

  return `
    <div class="step-eyebrow">${biHtml('step', 'Step')} 6 / 7</div>
    <div class="step-title">${biBlockHtml('additionalIssuesSection', 'Additional Issues')}</div>
    <div class="section-help" style="margin-bottom:14px;">${escapeHtml(bi('additionalIssuesHelp').en)}<br/>${escapeHtml(bi('additionalIssuesHelp').zh)}</div>
    ${state.additionalIssues.length === 0 ? `<div class="no-issues-note">${escapeHtml(bi('noIssues').en)} / ${escapeHtml(bi('noIssues').zh)}</div>` : issuesHtml}
    <button class="add-issue-btn" id="btnAddIssue">${escapeHtml(bi('addDefect').en)} / ${escapeHtml(bi('addDefect').zh)}</button>
    <div id="issuesAqlLive">${renderAqlTallyCard()}</div>
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="btnBack">${biBlockHtml('back', 'Back')}</button>
      <button class="btn btn-primary" id="btnNext">${biBlockHtml('next', 'Next')}</button>
    </div>
  `;
}
function renderAqlTallyCard() {
  const result = computeOverallResult();
  const aql = result.aql;
  if (aql && aql.isPreProduction) {
    return `<div class="section-help" style="margin-top:14px;">${escapeHtml(bi('aqlPreProductionNotice').en)}<br/>${escapeHtml(bi('aqlPreProductionNotice').zh)}</div>`;
  }
  if (!aql || aql.isFallback) {
    return `<div class="section-help" style="margin-top:14px;">${escapeHtml(bi('aqlFallbackNotice').en)}<br/>${escapeHtml(bi('aqlFallbackNotice').zh)}</div>`;
  }
  const recapRows = aql.recap ? `
    <div class="aql-preview" style="margin-top:12px;">
      <div class="aql-preview-row"><span>${escapeHtml(bi('poSize').en)} <span class="zh">${escapeHtml(bi('poSize').zh)}</span></span><strong>${aql.recap.poSize !== null ? aql.recap.poSize : '-'}</strong></div>
      <div class="aql-preview-row"><span>${escapeHtml(bi('quantityChecked').en)} <span class="zh">${escapeHtml(bi('quantityChecked').zh)}</span></span><strong>${aql.recap.quantityChecked}</strong></div>
      <div class="aql-preview-row"><span>${escapeHtml(bi('quantityApproved').en)} <span class="zh">${escapeHtml(bi('quantityApproved').zh)}</span></span><strong>${aql.recap.quantityApproved}</strong></div>
      <div class="aql-preview-row"><span>${escapeHtml(bi('quantityRejected').en)} <span class="zh">${escapeHtml(bi('quantityRejected').zh)}</span></span><strong>${aql.recap.quantityRejected}</strong></div>
    </div>
  ` : '';
  return `
    <div class="card" style="margin-top:14px;">
      <div class="section-title">${biBlockHtml('quantityRecapTitle', 'Recap')}</div>
      ${foundAcceptedTableHtml(aql)}
      ${recapRows}
    </div>
  `;
}

/* ---- Step 6: Review ---- */
function renderReviewStep() {
  const catDef = currentCategoryDef();
  const catLabel = catDef ? { en: catDef.label_zh, zh: catDef.label_en } : bi(state.category);
  let subLabel = null;
  if (catDef && state.subcategory) {
    const sub = (catDef.subcategories || []).find((s) => s.key === state.subcategory);
    if (sub) subLabel = { en: sub.label_zh, zh: sub.label_en };
  }
  const qaTypeLabel = state.qaType === 'production' ? bi('production') : bi('prePro');
  const result = computeOverallResult();
  const reasonKeyMap = {
    tolerance: 'resultReasonTolerance', minor: 'resultReasonMinor', major: 'resultReasonMajor',
    aqlCritical: 'resultReasonAqlCritical', aqlMajor: 'resultReasonAqlMajor', aqlMinor: 'resultReasonAqlMinor'
  };
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
    ${renderAqlTallyCard()}

    <div class="card">
      <div class="review-block">
        <div class="review-block-title">${bi('poInfo').en} / ${bi('poInfo').zh}</div>
        ${reviewRow('poNumber', state.poNumber)}
        ${reviewRow('factoryCode', state.factoryCode)}
        ${reviewRow('date', state.date)}
        ${reviewRow('poQuantity', state.poQuantity)}
        ${reviewRow('qaLead', state.qaLead)}
        ${reviewRow('creator', state.creator)}
        <div class="review-row"><span class="k">类别 / Category</span><span class="v">${escapeHtml(catLabel.en)} ${escapeHtml(catLabel.zh)}</span></div>
        ${subLabel ? `<div class="review-row"><span class="k">类型 / Type</span><span class="v">${escapeHtml(subLabel.en)} ${escapeHtml(subLabel.zh)}</span></div>` : ''}
        <div class="review-row"><span class="k">${bi('qaType').en}</span><span class="v">${escapeHtml(qaTypeLabel.en)} ${escapeHtml(qaTypeLabel.zh)}</span></div>
      </div>
      <div class="review-block">
        <div class="review-block-title">${bi('finalApprovalPhotos').en} / ${bi('finalApprovalPhotos').zh}</div>
        <div class="review-row"><span class="k">${bi('generalPhotos').en}</span><span class="v">${state.photos.general.length}</span></div>
        <div class="review-row"><span class="k">${bi('tagPhotos').en}</span><span class="v">${state.photos.tags.length}</span></div>
      </div>
      <div class="review-block">
        <div class="review-block-title">${bi('additionalIssuesSection').en} / ${bi('additionalIssuesSection').zh}</div>
        <div class="review-row"><span class="k">Total</span><span class="v">${state.additionalIssues.length}</span></div>
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

function attachDataBindLiveHandlers(root = document) {
  root.querySelectorAll('[data-bind-live]').forEach((el) => {
    const evt = (el.tagName === 'SELECT') ? 'change' : 'input';
    el.addEventListener(evt, (e) => {
      state[el.getAttribute('data-bind-live')] = e.target.value;
      refreshAqlSection();
    });
  });
}
function refreshAqlSection() {
  const section = document.getElementById('aqlSection');
  if (!section) return;
  section.innerHTML = renderAqlSection();
  attachDataBindLiveHandlers(section);
  attachUnitsCheckedHandler(section);
}
function attachUnitsCheckedHandler(root = document) {
  const input = root.querySelector('#actualUnitsCheckedInput');
  if (!input) return;
  input.addEventListener('input', (e) => {
    state.actualUnitsChecked = e.target.value;
    const derived = document.getElementById('unitsCheckedDerived');
    if (derived) derived.innerHTML = renderUnitsCheckedDerived();
  });
}

function attachStepHandlers(name) {
  const btnBack = document.getElementById('btnBack');
  if (btnBack) btnBack.addEventListener('click', back);
  const btnNext = document.getElementById('btnNext');
  if (btnNext) btnNext.addEventListener('click', next);
  const btnSubmit = document.getElementById('btnSubmit');
  if (btnSubmit) btnSubmit.addEventListener('click', submitReport);

  document.querySelectorAll('[data-bind]').forEach((el) => {
    const evt = (el.tagName === 'SELECT') ? 'change' : 'input';
    el.addEventListener(evt, (e) => setStateValue(el.getAttribute('data-bind'), e.target.value));
  });

  attachDataBindLiveHandlers(document);
  attachUnitsCheckedHandler(document);

  if (name === 'category') {
    document.querySelectorAll('.category-option').forEach((el) => {
      el.addEventListener('click', () => {
        state.category = el.getAttribute('data-cat');
        state.subcategory = null;
        state.categoryData.fit = '';
        state.categoryData.sizeRows = [];
        render();
      });
    });
    document.querySelectorAll('[data-subcat]').forEach((el) => {
      el.addEventListener('click', () => {
        state.subcategory = el.getAttribute('data-subcat');
        state.categoryData.fit = '';
        state.categoryData.sizeRows = [];
        render();
      });
    });
  }

  if (name === 'orderInfo') {
    const poInput = document.querySelector('[data-bind="poNumber"]');
    if (poInput) {
      poInput.addEventListener('blur', fetchPriorReports);
      if (state.poNumber) fetchPriorReports();
    }
    document.querySelectorAll('[data-seg]').forEach((el) => {
      el.addEventListener('click', () => {
        state[el.getAttribute('data-seg')] = el.getAttribute('data-val');
        render();
      });
    });
    document.querySelectorAll('[data-select-other]').forEach((el) => {
      el.addEventListener('change', (e) => {
        const id = el.getAttribute('data-select-other');
        if (e.target.value === OTHER_VALUE) { otherModeFlags[id] = true; state[id] = ''; }
        else { otherModeFlags[id] = false; state[id] = e.target.value; }
        render();
      });
    });
    document.querySelectorAll('[data-other-text]').forEach((el) => {
      el.addEventListener('input', (e) => { state[el.getAttribute('data-other-text')] = e.target.value; });
    });
  }

  if (name === 'inspectionDetails' || name === 'sizing') {
    document.querySelectorAll('[data-checklist-status]').forEach((el) => {
      el.addEventListener('click', () => {
        const key = el.getAttribute('data-checklist-status');
        const val = el.getAttribute('data-val');
        state.categoryData[key].status = val;
        if (val === 'fail' && state.categoryData[key].defects.length === 0) {
          state.categoryData[key].defects.push(emptyDefect());
        }
        render();
      });
    });
    document.querySelectorAll('[data-checklist-notes]').forEach((el) => {
      el.addEventListener('input', (e) => { state.categoryData[el.getAttribute('data-checklist-notes')].notes = e.target.value; });
    });
    attachDefectHandlers();
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
    document.querySelectorAll('[data-size-row]').forEach((el) => {
      el.addEventListener('input', (e) => {
        const ridx = parseInt(el.getAttribute('data-size-row'), 10);
        const point = el.getAttribute('data-size-point');
        state.categoryData.sizeRows[ridx].measured[point] = e.target.value;
        updateSizeCellInPlace(ridx, point);
      });
    });
  }

  if (name === 'photos') attachPhotoHandlers();

  if (name === 'issues') {
    const addBtn = document.getElementById('btnAddIssue');
    if (addBtn) addBtn.addEventListener('click', () => {
      state.additionalIssues.push(emptyDefect());
      render();
    });
    attachDefectHandlers();
    attachPhotoHandlers();
  }
}

function attachDefectHandlers() {
  document.querySelectorAll('[data-add-defect]').forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.getAttribute('data-add-defect');
      state.categoryData[key].defects.push(emptyDefect());
      render();
    });
  });
  document.querySelectorAll('[data-remove-defect]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-remove-defect');
      CHECKLIST_KEYS.forEach((key) => {
        const item = state.categoryData[key];
        const idx = item.defects.findIndex((d) => d.id === id);
        if (idx > -1) item.defects.splice(idx, 1);
      });
      const aIdx = state.additionalIssues.findIndex((d) => d.id === id);
      if (aIdx > -1) state.additionalIssues.splice(aIdx, 1);
      render();
    });
  });
  document.querySelectorAll('[data-defect-field]').forEach((el) => {
    el.addEventListener('input', (e) => {
      const d = findDefectById(el.getAttribute('data-defect-id'));
      if (d) d[el.getAttribute('data-defect-field')] = e.target.value;
    });
  });
  document.querySelectorAll('[data-defect-severity]').forEach((el) => {
    el.addEventListener('click', () => {
      const d = findDefectById(el.getAttribute('data-defect-severity'));
      if (d) { d.severity = el.getAttribute('data-val'); render(); }
    });
  });
  document.querySelectorAll('[data-defect-units]').forEach((el) => {
    el.addEventListener('input', (e) => {
      const d = findDefectById(el.getAttribute('data-defect-units'));
      if (d) d.unitsAffected = e.target.value;
    });
  });
}

function setStateValue(path, value) {
  if (path.startsWith('cd.')) state.categoryData[path.slice(3)] = value;
  else state[path] = value;
}

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
    el.addEventListener('change', async (e) => {
      const fieldId = el.getAttribute('data-photo-input');
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      const arr = getPhotoArray(fieldId);
      el.value = '';
      showToast(bi('processingPhotos').en + ' / ' + bi('processingPhotos').zh);
      for (const f of files) {
        try {
          const compressed = await compressImage(f);
          compressed._url = URL.createObjectURL(compressed);
          arr.push(compressed);
        } catch (err) {
          console.error('Photo compression failed, storing original', err);
          try { f._url = URL.createObjectURL(f); arr.push(f); }
          catch (e2) { showToast(bi('photoTooLarge').en + ' / ' + bi('photoTooLarge').zh, true); }
        }
      }
      render();
    });
  });
  document.querySelectorAll('[data-photo-remove]').forEach((el) => {
    el.addEventListener('click', () => {
      const fieldId = el.getAttribute('data-photo-remove');
      const idx = parseInt(el.getAttribute('data-photo-idx'), 10);
      const arr = getPhotoArray(fieldId);
      const removed = arr[idx];
      if (removed && removed._url) URL.revokeObjectURL(removed._url);
      arr.splice(idx, 1);
      render();
    });
  });
}

function compressImage(file, maxDim = 1600, quality = 0.8) {
  return new Promise((resolve, reject) => {
    if (!file.type || !file.type.startsWith('image/')) { resolve(file); return; }
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
          else { width = Math.round(width * (maxDim / height)); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(objectUrl);
          if (!blob) { reject(new Error('canvas produced no blob')); return; }
          blob.name = (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg';
          resolve(blob);
        }, 'image/jpeg', quality);
      } catch (err) { URL.revokeObjectURL(objectUrl); reject(err); }
    };
    img.onerror = (err) => { URL.revokeObjectURL(objectUrl); reject(err); };
    img.src = objectUrl;
  });
}

/* ---------------- SUBMIT ---------------- */

function serializeDefect(d) {
  return { id: d.id, description: d.description, severity: d.severity, unitsAffected: d.unitsAffected };
}

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
    const cd = state.categoryData;
    const payload = {
      category: state.category,
      subcategory: state.subcategory,
      poNumber: state.poNumber,
      factoryCode: state.factoryCode,
      date: state.date,
      qaLead: state.qaLead,
      creator: state.creator,
      productTitle: state.productTitle,
      qaType: state.qaType,
      poQuantity: state.poQuantity,
      productRisk: state.productRisk,
      actualUnitsChecked: state.actualUnitsChecked,
      inspectionLevel: state.inspectionLevel,
      majorAql: state.majorAql,
      minorAql: state.minorAql,
      materials: state.materials,
      printingMethod: state.printingMethod,
      categoryData: {
        fit: cd.fit,
        sizeRows: (cd.sizeRows || []).map((row) => ({ size: row.size, measured: row.measured })),
        ...Object.fromEntries(CHECKLIST_KEYS.map((key) => [key, {
          status: cd[key].status, notes: cd[key].notes,
          defects: (cd[key].defects || []).map(serializeDefect)
        }])),
        customNotes: cd.customNotes
      },
      additionalIssues: state.additionalIssues.map(serializeDefect)
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

    collectAllDefects().forEach((d) => {
      (d.photos || []).forEach((f) => formData.append(`photo_defect_${d.id}`, f, f.name));
    });
    (state.categoryData.sizeRows || []).forEach((row, ridx) => {
      (row.photos || []).forEach((f) => formData.append(`photo_sizerow_${ridx}`, f, f.name));
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
  otherModeFlags.factoryCode = false;
  otherModeFlags.creator = false;
  otherModeFlags.qaLead = false;
  priorReports = [];
  priorReportsPoChecked = null;
  Object.assign(state, {
    category: null, subcategory: null,
    poNumber: '', factoryCode: '', date: todayStr(), qaLead: '',
    creator: '', productTitle: '', qaType: 'pre_production',
    poQuantity: '', inspectionLevel: 'II', majorAql: 2.5, minorAql: 4.0,
    productRisk: 'medium', actualUnitsChecked: '',
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
      sectionPhotos: { fabric: [], embroidery: [], printing: [], washTag: [], packaging: [], sizing: [] }
    },
    photos: { general: [], tags: [] },
    additionalIssues: []
  });
  goTo(0);
}

/* ---------------- INIT ---------------- */

(async function init() {
  await loadConfig();
  updateProgress();
  render();
})();
