/* Juniper QA/QC Report - frontend wizard (vanilla JS, no build step) */

let CONFIG = { fits: { fits: {}, toleranceCm: 1.27 }, i18n: {}, options: {}, categories: { categories: {} }, aql: null };
let I18N = {};
let OPTIONS = {};

// 'chooser' (pick New PO / Pre-Production / Bulk Sampling) -> 'newPO' (create a
// PO record) or 'wizard' (the existing step-based inspection report flow).
let appMode = 'chooser';

const newPoState = {
  category: null, subcategory: null,
  poNumber: '', sku: '', orderDate: todayStr(), creator: '', productTitle: '', orderQuantity: '', productDevelopmentLead: '',
  fulfillmentRequestDate: '',
  sizesIncluded: [],
  sizesPreFilled: false,
  establishedFit: null, // { fitKey, sizes } - looked up once SKU is entered, if this SKU already has one on file
  skuChecked: null,
  pdLeadOtherMode: false,
  creatorOtherMode: false,
  asanaTaskLink: '',
  productRisk: 'medium',
  // Pulled from Asana by the Sync button rather than typed here.
  sourcer: '',
  fulfillmentChannel: '',
  warehouse: ''
};

let idCounter = 0;
function genId() { idCounter += 1; return `d${Date.now().toString(36)}${idCounter}`; }

function emptyChecklistEntry() { return { status: '', notes: '', defects: [] }; }
function emptyDefect() { return { id: genId(), description: '', severity: 'minor', unitsAffected: 1, photos: [] }; }

const state = {
  category: null,
  subcategory: null,
  sku: '', poSizesIncluded: [], pdNotes: [], approvalSizingData: null,
  approvalReferencePhotos: { sample: {}, preProduction: {} }, productionNotesData: null,
  poNumber: '', factoryCode: '', date: todayStr(), qaLead: '',
  creator: '', productTitle: '', qaType: 'pre_production',
  poQuantity: '', inspectionLevel: 'II', majorAql: 2.5, minorAql: 4.0,
  productRisk: 'medium', actualUnitsChecked: '', preProductionUnitsChecked: '',
  autoFilledForPo: null, _productRiskTouched: false,
  materials: '', printingMethod: '',
  /* Step 5 answers keyed by question id from config/reportQuestions.json,
   * plus the conditional/custom questions from the PO's report-link setup.
   * Created lazily by answerFor() so a question added to the config later
   * doesn't need a migration. */
  answers: {},
  poDimensions: null,
  productWeightG: '',
  poWeightG: null,
  poDimensionsTable: null,
  /* Identifies this report's photo folder on the server. Photos upload as
   * they are taken, so the report holds references rather than File objects -
   * which is what makes save-and-resume possible at all. */
  draftId: null,
  /* Set when this PO+stage already has a submitted report. The link then shows
   * the completed state rather than silently starting a second report against
   * a PO that has already been signed off. */
  completedReport: null,
  /* 'revised' when confirming previously-flagged units were repaired. */
  reportMode: 'full',
  revisedIssues: [],
  manualSizingOptIn: false,
  /* What happens to each defect's units - see renderDispositionStep. */
  dispositions: {},
  /* Step 6 entries keyed by the Step 6 question id they were logged under.
   * Everything here is minor by definition - see renderAdditionalIssuesStep. */
  sectionIssues: {},
  /* Sections the inspector explicitly marked "No Defects". Separate from an
   * empty sectionIssues list, which just means untouched. */
  sectionCleared: {},
  qaSetup: null,
  categoryData: {
    fit: '',
    sizeRows: [],
    customSizeRows: [],
    chartPhotos: [], simpleSizeValue: '', simpleSizePhotos: [], dimensions: { height: '', width: '', depth: '', notes: '' },
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
// Sizing sits at Step 4 and Inspection Details at Step 5 (swapped Sept 2026):
// the inspector measures first, then judges the piece against what they found.
const STEPS = ['poLookup', 'orderInfo', 'productionNotes', 'sizing', 'inspectionDetails', 'issues', 'disposition', 'review'];

/* Derived rather than hardcoded. Every step used to carry its own "Step 4 / 7"
 * string, so inserting a step meant editing nine of them and the numbering
 * quietly drifted when one was missed. */
function stepLabel() {
  return `${biHtml('step', 'Step')} ${step + 1} / ${STEPS.length}`;
}
// Display order for the category pickers. Any category key missing from this
// list is filtered OUT of both pickers entirely (see the .filter calls in
// renderNewPoScreen / the category step), so a new category in
// config/categories.json must be added here too or it silently won't appear.
const CATEGORY_ORDER = ['apparel', 'plush', 'bags', 'accessories', 'paperGoods', 'other'];
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

/* One active language at a time, chosen with the header toggle (see
 * i18n-shared.js). The returned shape is unchanged so every existing
 * biHtml/biBlockHtml call site still works - the secondary slot is just
 * always empty now, which makes those helpers render a single language. */
/** Category/subcategory labels live in config as label_en/label_zh pairs
 *  rather than in the i18n table, so they need their own language pick. */
function catLabel(def) {
  if (!def) return '';
  const lang = (window.JuniperLang && window.JuniperLang.get()) || 'zh';
  return (lang === 'en' ? (def.label_en || def.label_zh) : (def.label_zh || def.label_en)) || '';
}

function bi(key, fallback) {
  const e = I18N[key];
  if (!e) return { en: fallback || key, zh: '' };
  const lang = (window.JuniperLang && window.JuniperLang.get()) || 'zh';
  const primary = lang === 'en' ? (e.en || e.zh) : (e.zh || e.en);
  return { en: primary || fallback || key, zh: '' };
}
function biHtml(key, fallback, tag = 'span') {
  const e = bi(key, fallback);
  // With one active language the secondary slot is empty - emit nothing at
  // all rather than an empty .zh element, which would still take up its
  // display:block line and leave a gap under every label.
  if (!e.zh) return escapeHtml(e.en);
  return `${escapeHtml(e.en)} <${tag} class="zh">${escapeHtml(e.zh)}</${tag}>`;
}
function biBlockHtml(key, fallback) {
  const e = bi(key, fallback);
  if (!e.zh) return escapeHtml(e.en);
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
    return `${standard.min}-${standard.max} cm`;
  }
  const n = parseFloat(standard);
  if (isNaN(n) || n === 0) return '-';
  return `${n} cm`;
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
  /* Mirrors lib/aqlRecommendation.js, including its failure reasons. It
   * previously returned null on any missing input, so the Spot Check
   * Recommendation card just disappeared with no explanation - which made
   * an incomplete PO indistinguishable from a broken feature. */
  const fail = (reason) => ({ unavailable: true, reason });
  const cfg = CONFIG.aqlRecommendation;
  if (!cfg || !cfg.table || !cfg.poSizeBands) return fail('missingConfig');
  if (!CONFIG.creatorTiers) return fail('missingCreatorTiers');

  const qty = parseInt(state.poQuantity, 10);
  if (isNaN(qty) || qty < 1) return fail('missingQuantity');

  const cost = getUnitCost(state.category, state.subcategory);
  if (cost === null || cost === undefined) return fail('missingUnitCost');

  const orderValue = qty * cost;
  const poSizeBand = getPoSizeBand(orderValue);
  if (!poSizeBand) return fail('noSizeBand');
  const tier = getCreatorTier(state.creator);
  if (!tier) return fail('noCreatorTier');
  const tierTable = cfg.table[String(tier)];
  const cell = tierTable && tierTable[state.productRisk] && tierTable[state.productRisk][poSizeBand];
  if (!cell) return fail('noTableEntry');
  return { orderValue, poSizeBand, tier, pointCheck: cell.pointCheck, inspectionLevel: cell.inspectionLevel };
}

/** Plain-language explanation for a recommendation that can't be produced. */
function aqlUnavailableMessage(reason) {
  const map = {
    missingQuantity: 'aqlNoQuantity',
    missingUnitCost: 'aqlNoUnitCost',
    missingConfig: 'aqlNoConfig',
    missingCreatorTiers: 'aqlNoConfig',
    noCreatorTier: 'aqlNoConfig',
    noSizeBand: 'aqlNoConfig',
    noTableEntry: 'aqlNoConfig'
  };
  return bi(map[reason] || 'aqlNoConfig');
}
function levelNumberToRoman(n) { return n === 1 ? 'I' : n === 2 ? 'II' : 'III'; }
function syncInspectionLevelToRecommendation() {
  // Inspection Level has no UI control anymore - it's always derived silently
  // from the recommendation (Creator Tier + Risk + PO Size), used only to compute
  // the reference thresholds below.
  const rec = getAqlRecommendation();
  if (rec && !rec.unavailable) state.inspectionLevel = levelNumberToRoman(rec.inspectionLevel);
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

/* Severity is derived from where an issue was recorded, not chosen by the
 * inspector: a Step 5 question answered Fail is MAJOR, and everything logged
 * in Step 6 is MINOR. Nothing is recorded as critical any more. */
function collectAllDefects() {
  const all = [];

  // Step 5: one major defect per failed question, sized by units affected.
  questionsForStep(5).concat(additionalReviewQuestions()).forEach((q) => {
    const a = state.answers[q.id];
    if (!a || a.status !== 'fail') return;
    all.push({
      id: q.id,
      description: q.title,
      severity: 'major',
      unitsAffected: parseInt(a.unitsAffected, 10) || 1,
      photos: a.media || []
    });
  });

  // Sizing: each measurement outside tolerance is a major issue in its own
  // right, so it lands in the tally and on the PDF rather than only tipping
  // the overall verdict.
  if (state.category !== 'apparel') {
    ['height', 'width', 'depth'].forEach((k) => {
      if (!dimensionOutOfTolerance(k)) return;
      all.push({
        id: `dimension_${k}`,
        description: `${bi('dimension' + k.charAt(0).toUpperCase() + k.slice(1)).en}: ${state.categoryData.dimensions[k]} cm (${bi('approvedLabel', 'Approved').en} ${approvedDimension(k)} \u00b1${sizingToleranceCm()} cm)`,
        severity: 'major',
        unitsAffected: 1,
        photos: []
      });
    });
  }
  if (weightOutOfTolerance()) {
    all.push({
      id: 'product_weight',
      description: `${bi('productWeightLabel', 'Product weight').en}: ${state.productWeightG} g (${bi('approvedLabel', 'Approved').en} ${approvedWeightG()} \u00b1${weightToleranceG()} g)`,
      severity: 'major',
      unitsAffected: 1,
      photos: []
    });
  }

  // Step 6: everything logged per section, always minor.
  allSectionIssues().forEach((d) => all.push(d));

  // Legacy: the fixed checklist keys still used by the Sizing step's
  // custom-sizing flow, plus any older in-progress report.
  CHECKLIST_KEYS.forEach((key) => {
    const item = state.categoryData[key];
    if (item && Array.isArray(item.defects)) item.defects.forEach((d) => all.push(d));
  });
  (state.additionalIssues || []).forEach((d) => all.push(d));
  /* Apply the disposition decisions last: repaired and rejected units drop
   * out of the count entirely, which is what lets a report move from fail to
   * pass on the strength of what was done about the defects. Entries that
   * reach zero are removed so they don't show as "0 units affected". */
  return all.map(applyDisposition).filter((d) => (parseInt(d.unitsAffected, 10) || 0) > 0);
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

/**
 * Two different things get called a "defect count", and conflating them was
 * producing nonsense like "10 minor issues" from a sample of 5 units.
 *
 *   entries  - how many distinct issues were logged (2)
 *   units    - the sum of units-affected across those issues (5 + 5 = 10)
 *   defectiveUnits - how many actual units are bad
 *
 * The third can't be derived by adding: if issue A affected 5 units and issue
 * B affected 5 units out of 5 checked, those are the same 5 units, not 10.
 * Nothing in the form records which unit each issue was found on, so the
 * honest answer is a bound rather than a figure - it can never exceed the
 * number of units actually inspected. That bound is what the rates and the
 * whole-PO assumption are based on, because a rate over 100% is meaningless.
 */
/**
 * Whether a report fails, by rate rather than by AQL accept/reject numbers.
 *
 * Thresholds live in config/aql.json (`failThresholds`) and are expressed as a
 * percentage of the units actually INSPECTED: exceeding fails, equalling
 * passes. 5 bad units out of 100 checked is 5% minor, over the 4% line, so it
 * fails - and because the rate is what matters, the same 5% would fail whether
 * 100 or 1,000 units had been checked.
 *
 * Rates use defectiveUnits, which is bounded by units checked. Two issues each
 * affecting the same 5 units is 5 bad units, not 10, so a report cannot show a
 * defect rate above 100%.
 *
 * CRITICAL is computed, never chosen. QA staff should not have to classify
 * severity, so a defect is escalated to critical when every inspected unit is
 * affected - which is also the point at which the batch, not the units, is the
 * problem.
 */
function failThresholds() {
  const t = (CONFIG.aql && CONFIG.aql.failThresholds) || {};
  return {
    criticalPct: t.criticalPct !== undefined ? t.criticalPct : 0,
    majorPct: t.majorPct !== undefined ? t.majorPct : 1.5,
    minorPct: t.minorPct !== undefined ? t.minorPct : 4
  };
}

function rateFailures(counts, unitsChecked) {
  const out = { rates: { critical: 0, major: 0, minor: 0 }, reasons: [], isCritical: false };
  if (!unitsChecked || unitsChecked < 1) return out;
  const th = failThresholds();
  const pct = (n) => (n / unitsChecked) * 100;

  // Every inspected unit affected -> this is a batch problem, not a unit one.
  out.isCritical = counts.totalDefectiveUnits >= unitsChecked;
  out.rates.critical = out.isCritical ? 100 : 0;
  out.rates.major = pct(counts.major.defectiveUnits);
  out.rates.minor = pct(counts.minor.defectiveUnits);

  if (out.rates.critical > th.criticalPct) out.reasons.push('thresholdCritical');
  if (out.rates.major > th.majorPct) out.reasons.push('thresholdMajor');
  if (out.rates.minor > th.minorPct) out.reasons.push('thresholdMinor');
  return out;
}

function countDefects(defects, unitsChecked) {
  const out = {
    critical: { entries: 0, units: 0 },
    major: { entries: 0, units: 0 },
    minor: { entries: 0, units: 0 }
  };
  defects.forEach((d) => {
    const bucket = out[d.severity];
    if (!bucket) return;
    const n = parseInt(d.unitsAffected, 10);
    bucket.entries += 1;
    bucket.units += isNaN(n) || n < 1 ? 1 : n;
  });
  const cap = (v) => (unitsChecked ? Math.min(v, unitsChecked) : v);
  ['critical', 'major', 'minor'].forEach((k) => { out[k].defectiveUnits = cap(out[k].units); });
  // Across all severities: still bounded by what was inspected.
  out.totalDefectiveUnits = cap(out.critical.units + out.major.units + out.minor.units);
  out.unitsChecked = unitsChecked || null;
  return out;
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
function openLightbox(url) {
  const overlay = document.getElementById('lightboxOverlay');
  if (!overlay) return;
  document.getElementById('lightboxImg').src = url;
  overlay.classList.remove('hidden');
}
function attachLightboxHandlers() {
  document.querySelectorAll('.js-lightbox').forEach((el) => {
    el.addEventListener('click', () => openLightbox(el.getAttribute('src')));
  });
  const overlay = document.getElementById('lightboxOverlay');
  if (overlay && !overlay._wired) {
    overlay.addEventListener('click', () => overlay.classList.add('hidden'));
    overlay._wired = true;
  }
}
function updateProgress() {
  const pct = Math.round(((step) / (STEPS.length - 1)) * 100);
  document.getElementById('progressFill').style.width = Math.max(8, pct) + '%';
}
function updateProgressForMode() {
  const fill = document.getElementById('progressFill');
  if (!fill) return;
  fill.style.width = appMode === 'chooser' ? '0%' : '8%';
}
function goTo(newStep) {
  step = newStep;
  updateProgress();
  render();
  window.scrollTo(0, 0);
}
/* Saved on every step change as well as on demand. An inspector on a factory
 * floor should lose at most the step they are on, not the whole report. */
function next() {
  if (!validateStep(step)) return;
  if (step < STEPS.length - 1) {
    goTo(step + 1);
    // Quietly, so a dropped phone loses at most the step in progress.
    if (state.poNumber) saveDraft(true);
  }
}
function back() {
  if (step > 0) goTo(step - 1);
}

/* ---------------- VALIDATION ---------------- */

function checklistDefsForStep(name) {
  /* Step 5 no longer uses the fixed checklist keys - it renders from
   * config/reportQuestions.json and validates via inspectionStepProblems().
   * Returning the old list here left nine keys nobody could ever answer, which
   * blocked submission outright. The keys still exist in state for the Sizing
   * step's custom-sizing flow, which is why they aren't deleted. */
  if (name === 'inspectionDetails') return [];
  if (name === 'sizing' && state.category === 'apparel'
    && !state.poDimensionsTable && !state.manualSizingOptIn && !state.categoryData.fit) {
    // Nothing has been measured against - make the choice explicit rather
    // than letting an unmeasured report slide through.
    showToast(bi('noSizingTableToast', 'Add the sizing table on the PO, or choose Enter manually.').en, true);
    return false;
  }
  if (name === 'sizing' && state.category === 'apparel' && state.categoryData.fit === OTHER_FIT_VALUE) {
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
    const required = ['poNumber', 'date', 'qaLead'];
    required.forEach((f) => {
      if (!state[f] || !String(state[f]).trim()) { markError(f); ok = false; }
    });
    if (!state.poQuantity || parseInt(state.poQuantity, 10) < 2) { markError('poQuantity'); ok = false; }
    if (state.qaType === 'production' && !state.actualUnitsChecked) {
      markError('actualUnitsChecked');
      ok = false;
    }
    if (!ok) showToast('Please fill in all required fields / 请填写所有必填项', true);
  } else if (name === 'disposition') {
    const problems = dispositionProblems();
    if (problems.length) {
      ok = false;
      problems.forEach((pb) => {
        const card = document.querySelector(`[data-disposition="${pb.id}"]`);
        if (card) card.classList.add('has-error');
      });
      const first = problems[0];
      const msg = first.why === 'choice'
        ? bi('dispositionRequired', 'Choose what happens to each set of defective units.')
        : first.why === 'qty'
          ? bi('unitsFixedRange', 'Enter a number between 1 and the units flagged.')
          : bi('photoRequiredForDefect');
      showToast(msg.en + ' / ' + msg.zh, true);
      const card = document.querySelector(`[data-disposition="${first.id}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } else if (name === 'issues') {
    /* An empty section is a valid "found nothing" - only entries that were
     * actually started get validated. */
    const problems = sectionIssueProblems();
    if (problems.length) {
      ok = false;
      problems.forEach((pb) => {
        const card = pb.why === 'unanswered'
          ? document.querySelector(`[data-clean-section="${pb.id}"]`)
          : document.querySelector(`[data-section-issue="${pb.id}"]`);
        const target = pb.why === 'unanswered' ? (card && card.closest('.card')) : card;
        if (target) target.classList.add('has-error');
      });
      const first = problems[0];
      const msg = first.why === 'unanswered'
        ? bi('sectionsUnanswered', 'Every section needs either No Defects or at least one defect logged.')
        : first.why === 'description'
          ? bi('descriptionRequiredForDefect')
          : first.why === 'units'
            ? bi('unitsRequiredOnFail', 'A failed question needs the number of units affected.')
            : bi('photoRequiredForDefect');
      showToast(msg.en + ' / ' + msg.zh, true);
      const focus = first.why === 'unanswered'
        ? document.querySelector(`[data-clean-section="${first.id}"]`)
        : document.querySelector(`[data-section-issue="${first.id}"]`);
      if (focus) focus.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } else if (name === 'inspectionDetails') {
    /* Step 5 is config-driven now, so it validates against the question bank
     * rather than the old fixed checklist keys. */
    const problems = inspectionStepProblems();
    if (problems.length) {
      ok = false;
      problems.forEach((pb) => {
        const row = document.querySelector(`[data-question="${pb.id}"]`);
        if (row) row.classList.add('has-error');
      });
      const first = problems[0];
      const msg = first.why === 'status'
        ? bi('answerAllQuestions', 'Please answer every question.')
        : first.why === 'units'
          ? bi('unitsRequiredOnFail', 'A failed question needs the number of units affected.')
          : bi('evidenceRequired', 'A photo or video is required for this question.');
      showToast(msg.en + ' / ' + msg.zh, true);
      const row = document.querySelector(`[data-question="${first.id}"]`);
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } else if (name === 'sizing') {
    if (state.category === 'apparel' && state.categoryData.fit !== OTHER_FIT_VALUE) {
      if (apparelSizingIncomplete()) {
        showToast(bi('selectFitRequired').en + ' / ' + bi('selectFitRequired').zh, true);
        ok = false;
      }
    } else if (state.category === 'apparel' && state.categoryData.fit === OTHER_FIT_VALUE) {
      ok = validateChecklistStepGeneric(name);

      const sizingEntry = state.categoryData.generalSizingMatch;
      if (!sizingEntry.notes || !sizingEntry.notes.trim()) {
        markChecklistError('generalSizingMatch');
        showToast(bi('sizingNotesRequired').en + ' / ' + bi('sizingNotesRequired').zh, true);
        ok = false;
      }

      if (isSimplifiedCustomSizing(state.subcategory)) {
        if (!state.categoryData.simpleSizeValue || !state.categoryData.simpleSizeValue.trim()) {
          markError('simpleSizeInput');
          showToast(bi('simpleSizeRequired').en + ' / ' + bi('simpleSizeRequired').zh, true);
          ok = false;
        }
      } else {
        // Every size row needs its measurements written out - that's the
        // only record of what was actually measured.
        const rows = state.categoryData.customSizeRows || [];
        const emptyRows = rows.filter((r) => !r.measurements || !r.measurements.trim());
        if (!rows.length) {
          showToast(bi('customSizeRowRequired').en + ' / ' + bi('customSizeRowRequired').zh, true);
          ok = false;
        } else if (emptyRows.length) {
          rows.forEach((r, idx) => {
            if (!r.measurements || !r.measurements.trim()) markError(`customSizeMeasurements-${idx}`);
          });
          showToast(bi('customSizeMeasurementsRequired').en + ' / ' + bi('customSizeMeasurementsRequired').zh, true);
          ok = false;
        }
      }
    } else {
      // Non-apparel: Height/Width/Length are the sizing record now.
      const dims = state.categoryData.dimensions;
      const missing = ['height', 'width', 'depth'].filter((k) => !dims[k] || !String(dims[k]).trim());
      if (weightToleranceG() !== null && !String(state.productWeightG || '').trim()) {
        markError('productWeightInput');
        showToast(bi('productWeightRequired', 'Please record the product weight.').en, true);
        ok = false;
      }
      if (missing.length) {
        missing.forEach((k) => markError(k));
        showToast(bi('dimensionsRequired').en + ' / ' + bi('dimensionsRequired').zh, true);
        ok = false;
        /* Out of tolerance deliberately does NOT block. Entering the
         * measurement IS logging it, exactly as an apparel size row works:
         * the field goes red, the inspector carries on, and the report records
         * it as a major issue. Blocking here just made them delete the real
         * number to get past the step. */
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

  ['poNumber', 'date', 'qaLead'].forEach((f) => {
    if (!state[f] || !String(state[f]).trim()) problems.push(bi(f));
  });
  if (!state.poQuantity || parseInt(state.poQuantity, 10) < 2) problems.push(bi('poQuantity'));
  if (state.qaType === 'production' && !state.actualUnitsChecked) problems.push(bi('actualSpotCheckRequired'));

  const detailDefs = checklistDefsForStep('inspectionDetails');
  const sizingDefs = (state.category === 'apparel' && state.categoryData.fit !== OTHER_FIT_VALUE) ? [] : checklistDefsForStep('sizing');
  const allDefs = detailDefs.concat(sizingDefs);

  const missingStatus = allDefs.filter(([key]) => !state.categoryData[key].status);
  if (missingStatus.length) problems.push(bi('allChecksRequired'));

  // Step 5 and Step 6, which validate against the question bank rather than
  // the fixed keys above.
  const q = inspectionStepProblems();
  if (q.some((x) => x.why === 'status')) problems.push(bi('answerAllQuestions', 'Please answer every question.'));
  if (q.some((x) => x.why === 'units')) problems.push(bi('unitsRequiredOnFail', 'A failed question needs the number of units affected.'));
  if (q.some((x) => x.why === 'media')) problems.push(bi('evidenceRequired', 'A photo or video is required for this question.'));
  const si = sectionIssueProblems();
  if (si.some((x) => x.why === 'description')) problems.push(bi('descriptionRequiredForDefect'));
  if (si.some((x) => x.why === 'units')) problems.push(bi('unitsRequiredOnFail', 'A failed question needs the number of units affected.'));
  if (si.some((x) => x.why === 'media')) problems.push(bi('photoRequiredForDefect'));

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

  if (state.category === 'apparel' && state.categoryData.fit === OTHER_FIT_VALUE) {
    const sizingEntry = state.categoryData.generalSizingMatch;
    if (!sizingEntry.notes || !sizingEntry.notes.trim()) problems.push(bi('sizingNotesRequired'));
    if (isSimplifiedCustomSizing(state.subcategory)) {
      if (!state.categoryData.simpleSizeValue || !state.categoryData.simpleSizeValue.trim()) problems.push(bi('simpleSizeRequired'));
    } else {
      const rows = state.categoryData.customSizeRows || [];
      if (!rows.length || rows.some((r) => !r.measurements || !r.measurements.trim())) problems.push(bi('customSizeMeasurementsRequired'));
    }
  }
  if (state.category !== 'apparel') {
    const dims = state.categoryData.dimensions;
    if (!dims.height || !dims.width || !dims.depth) problems.push(bi('dimensionsRequired'));
    // Out of tolerance is a finding, not an incomplete field, so it isn't
    // listed here as something to fix before submitting.
  }

  return problems;
}

/* ---------------- PASS / FAIL LOGIC (mirrors lib/passFail.js) ---------------- */

function computeOverallResult() {
  const reasons = [];
  const cd = state.categoryData;
  const tol = CONFIG.fits.toleranceCm || 1.27;

  // Non-apparel: the recorded dimensions are the sizing check, so a box
  // outside tolerance fails the report just as a garment would.
  if (state.category !== 'apparel' && anyDimensionOutOfTolerance()) reasons.push('tolerance');
  if (weightOutOfTolerance()) reasons.push('tolerance');

  if (state.category === 'apparel' && cd.fit && CONFIG.fits.fits[cd.fit]) {
    const fitDef = CONFIG.fits.fits[cd.fit];
    const allPoints = fitDef.points.concat(getCustomPointsForCurrentFit().map((cp) => cp.key));
    outer:
    for (const row of (cd.sizeRows || [])) {
      for (const point of allPoints) {
        const standard = establishedStandardFor(row.size, point, fitDef);
        const measured = row.measured && row.measured[point] !== undefined && row.measured[point] !== ''
          ? parseFloat(row.measured[point]) : null;
        if (isOutOfTolerance(standard, measured, tol)) { reasons.push('tolerance'); break outer; }
      }
    }
  }

  const allDefects = collectAllDefects();
  const { critical: criticalCount, major: majorCount, minor: minorCount } = sumDefectsBySeverity(allDefects);

  let aql;
  if (state.qaType === 'pre_production') {
    const preQty = parseInt(state.preProductionUnitsChecked, 10);
    const checked = isNaN(preQty) || preQty < 1 ? null : preQty;
    const counts = countDefects(allDefects, checked);

    /* Pre-production used to build this object and push no fail reason at
     * all, so a sample report passed no matter what was found. A first-article
     * check with defects is precisely the thing that should not pass. */
    /* Rate thresholds replace the old ad-hoc rules here. AQL still sizes the
     * sample and sets the inspection level; the verdict is now the rate. */
    const rated = rateFailures(counts, checked);
    rated.reasons.forEach((r) => reasons.push(r));

    aql = {
      criticalCount, majorCount, minorCount, counts,
      rates: rated.rates, isCritical: rated.isCritical, thresholds: failThresholds(),
      isFallback: true, isPreProduction: true,
      quantityChecked: checked,
      poSize: parseInt(state.poQuantity, 10) || null
    };
  } else {
    const checked = parseInt(state.actualUnitsChecked, 10);
    if (!isNaN(checked) && checked >= 1) {
      const counts = countDefects(allDefects, checked);
      const rejected = Math.min(checked, majorCount + criticalCount);
      const recap = { poSize: parseInt(state.poQuantity, 10) || null, quantityChecked: checked, quantityRejected: rejected, quantityApproved: checked - rejected };
      const rated = rateFailures(counts, checked);
      rated.reasons.forEach((r) => reasons.push(r));
      aql = {
        criticalCount, majorCount, minorCount, counts,
        rates: rated.rates, isCritical: rated.isCritical, thresholds: failThresholds(),
        isFallback: false, isActual: true, recap
      };
    } else {
      if (minorCount >= 3) reasons.push('minor');
      if (majorCount + criticalCount >= 1) reasons.push('major');
      aql = { criticalCount, majorCount, minorCount, isFallback: true };
    }
  }

  /* De-duplicated because a report can trip more than one threshold at once -
   * a 100%-affected batch is both critical and, say, 100% minor. */
  return { overall: reasons.length ? 'fail' : 'pass', reasons: [...new Set(reasons)], aql };
}

/* ---------------- PHOTO STORAGE HELPERS ---------------- */

function getPhotoArray(fieldId) {
  if (fieldId === 'general') return state.photos.general;
  if (fieldId === 'tags') return state.photos.tags;
  if (fieldId.startsWith('section:')) return state.categoryData.sectionPhotos[fieldId.split(':')[1]];
  if (fieldId.startsWith('sizerow:')) return state.categoryData.sizeRows[parseInt(fieldId.split(':')[1], 10)].photos;
  if (fieldId.startsWith('customsizerow:')) return state.categoryData.customSizeRows[parseInt(fieldId.split(':')[1], 10)].photos;
  if (fieldId === 'chartphotos') return state.categoryData.chartPhotos;
  if (fieldId === 'simplesize') return state.categoryData.simpleSizePhotos;
  if (fieldId.startsWith('disp:')) return dispositionPhotoArray(fieldId.slice(5));
  if (fieldId.startsWith('revised:')) return revisedPhotoArray(parseInt(fieldId.slice(8), 10));
  if (fieldId.startsWith('q:')) return answerFor(fieldId.slice(2)).media;
  if (fieldId.startsWith('issue:')) {
    const i = findSectionIssueById(fieldId.slice(6));
    return i ? i.media : [];
  }
  if (fieldId.startsWith('defect:')) {
    const d = findDefectById(fieldId.split(':')[1]);
    return d ? d.photos : [];
  }
  return [];
}

/* ---------------- RENDER ---------------- */

function render() {
  const root = document.getElementById('formRoot');
  if (appMode === 'chooser') {
    root.innerHTML = renderChooserScreen();
    attachChooserHandlers();
    updateProgressForMode();
    return;
  }
  if (appMode === 'newPO') {
    root.innerHTML = renderNewPoScreen();
    attachNewPoHandlers();
    updateProgressForMode();
    return;
  }
  const name = STEPS[step];
  let html = '';
  /* These two short-circuit the wizard entirely: the gate when this stage has
   * already been reported on, and the revised flow when the inspector chose to
   * confirm repairs rather than start another report. */
  if (state.reportMode === 'revised') {
    root.innerHTML = renderRevisedUnitReport();
    attachRevisedHandlers();
    attachPhotoHandlers();
    attachLightboxHandlers();
    return;
  }
  if (state.completedReport && state.reportMode === 'gate') {
    root.innerHTML = renderCompletedReportGate();
    attachGateHandlers();
    return;
  }

  if (name === 'poLookup') html = renderPoLookupStep();
  else if (name === 'orderInfo') html = renderOrderInfoStep();
  else if (name === 'productionNotes') html = renderProductionNotesStep();
  else if (name === 'inspectionDetails') html = renderInspectionDetailsStep();
  else if (name === 'sizing') html = renderSizingStep();
  else if (name === 'issues') html = renderAdditionalIssuesStep();
  else if (name === 'disposition') html = renderDispositionStep();
  else if (name === 'review') html = renderReviewStep();

  root.innerHTML = html;
  attachStepHandlers(name);
  attachLightboxHandlers();
}

/* ---- Step 0: Category + Subcategory ---- */
/* ---- Chooser: New Purchase Order / Pre-Production / Bulk Sampling Reporting ---- */
function renderChooserScreen() {
  return `
    <div class="step-title">${biBlockHtml('qaQcReportingTitle', 'QA/QC Reporting')}</div>
    <div class="section-help" style="margin-bottom:16px;">${escapeHtml(bi('chooserHelp').en)}<br/>${escapeHtml(bi('chooserHelp').zh)}</div>

    <div class="home-nav-card" data-chooser="pre_production">
      <div class="home-nav-icon">🔍</div>
      <div class="home-nav-text">
        <div class="home-nav-title">${biBlockHtml('chooserPreProd', 'Pre-Production Sample Reporting')}</div>
        <div class="home-nav-desc">${biBlockHtml('chooserPreProdDesc', 'Inspect a small hand-checked sample before the full run')}</div>
      </div>
    </div>
    <div class="home-nav-card" data-chooser="production">
      <div class="home-nav-icon">📦</div>
      <div class="home-nav-text">
        <div class="home-nav-title">${biBlockHtml('chooserBulk', 'Bulk Sampling Reporting')}</div>
        <div class="home-nav-desc">${biBlockHtml('chooserBulkDesc', 'Inspect a spot-checked sample of the full production run')}</div>
      </div>
    </div>
  `;
}
function attachChooserHandlers() {
  document.querySelectorAll('[data-chooser]').forEach((el) => {
    el.addEventListener('click', () => {
      const choice = el.getAttribute('data-chooser');
      if (choice === 'newPO') {
        appMode = 'newPO';
        render();
      } else {
        state.qaType = choice;
        appMode = 'wizard';
        goTo(0);
      }
    });
  });
}

/**
 * Variant SKUs follow the parent, with the final digit as the size index:
 * JTST03HOO1 is the smallest size, JTST03HOO2 the next, and so on. So the
 * parent's trailing number is replaced by the row's position.
 *
 * Returns '' when the parent SKU doesn't end in a digit, rather than
 * guessing at a format we don't recognise.
 */
function variantSkuFor(parentSku, index) {
  const sku = String(parentSku || '').trim();
  const m = sku.match(/^(.*?)(\d+)$/);
  if (!m) return '';
  return `${m[1]}${index + 1}`;
}

/** Fill in any variant SKU the user hasn't typed themselves. Existing
 *  values are left alone - a manual override should stick. */
function autoFillVariantSkus() {
  newPoState.sizesIncluded.forEach((row, i) => {
    if (!row.sku || row.autoSku) {
      const next = variantSkuFor(newPoState.sku, i);
      if (next) { row.sku = next; row.autoSku = true; }
    }
  });
}

function renderNewPoSizesBlock() {
  // Keep generated SKUs in step with the parent SKU and row order.
  autoFillVariantSkus();
  const isApparel = newPoState.category === 'apparel';
  if (!newPoState.category) return '';
  const universalSizes = (CONFIG.fits && CONFIG.fits.universalSizes) || [];
  const addedLabels = newPoState.sizesIncluded.map((x) => x.label);
  const preFilledNote = newPoState.sizesPreFilled
    ? `<div class="section-help" style="color:var(--jc-teal-dark); margin-top:6px;">${escapeHtml(bi('sizesPreFilledNote', 'Pre-filled from a previous order for this SKU - adjust quantities as needed.').en)}<br/>${escapeHtml(bi('sizesPreFilledNote').zh)}</div>`
    : '';

  const rowsHtml = newPoState.sizesIncluded.map((row, i) => `
    <div class="field-row" style="margin-top:8px; align-items:center;">
      ${isApparel
        ? `<span style="flex:1;font-weight:600;">${escapeHtml(row.label)}</span>`
        : `<input type="text" data-po-variant-label="${i}" placeholder="Variant name" value="${escapeHtml(row.label)}" style="flex:1;" />`}
      <input type="text" data-po-variant-sku="${i}" placeholder="Variant SKU (blank = parent SKU)" value="${escapeHtml(row.sku || '')}" style="flex:1;" />
      <input type="number" min="0" data-po-variant-qty="${i}" placeholder="Order Quantity" value="${row.quantity === null || row.quantity === undefined ? '' : row.quantity}" style="width:120px;" />
      <button type="button" class="settings-remove" data-po-variant-remove="${i}">✕</button>
    </div>
  `).join('');

  return `
    <div class="card">
      <div class="section-title">${isApparel ? biBlockHtml('sizesInPo', 'Size Distribution') : 'Variant Distribution'}</div>
      <div class="section-help">${isApparel ? (escapeHtml(bi('sizesInPoHelp').en) + '<br/>' + escapeHtml(bi('sizesInPoHelp').zh)) : 'Optional - break this PO into variants (colorways, styles, etc.) with a quantity each. Skip this if the PO is just one thing.'}</div>
      <div class="section-help">Each variant can carry its own SKU - leave it blank to use this PO's parent SKU.</div>
      ${preFilledNote}
      ${isApparel ? `
        <div class="segmented" style="flex-wrap:wrap; margin-top:8px;">
          ${universalSizes.map((s) => `<div class="segmented-option ${addedLabels.includes(s) ? 'selected' : ''}" data-po-size-toggle="${escapeHtml(s)}" style="flex:0 0 auto; min-width:90px;">${escapeHtml(s)}</div>`).join('')}
        </div>
      ` : ''}
      ${rowsHtml ? `<div style="margin-top:10px;">${rowsHtml}</div>` : ''}
      ${!isApparel ? `<button type="button" class="btn btn-secondary" id="btnAddPoVariant" style="margin-top:10px;">+ Add variant</button>` : ''}
    </div>
  `;
}

/* ---- New Purchase Order ---- */
function renderNewPoScreen() {
  const cats = (CONFIG.categories && CONFIG.categories.categories) || {};
  const catOptions = CATEGORY_ORDER.filter((k) => cats[k]).map((k) => `<option value="${k}" ${newPoState.category === k ? 'selected' : ''}>${escapeHtml(catLabel(cats[k]))}</option>`).join('');
  const catDef = newPoState.category ? cats[newPoState.category] : null;
  const subOptions = (catDef && catDef.subcategories || []).map((s) => `<option value="${s.key}" ${newPoState.subcategory === s.key ? 'selected' : ''}>${escapeHtml(catLabel(s))}</option>`).join('');

  return `
    <div class="step-title">🆕 ${biBlockHtml('chooserNewPO', 'New Purchase Order')}</div>
    <div class="card">
      <div class="field">
        <label class="field-label">${biBlockHtml('selectCategory', 'Product Category')}</label>
        <select id="newPoCategory">
          <option value="">${escapeHtml(bi('selectPlaceholder').en)}</option>
          ${catOptions}
        </select>
      </div>
      ${catDef && catDef.subcategories && catDef.subcategories.length ? `
        <div class="field">
          <label class="field-label">${biBlockHtml('selectSubcategory', 'Type')}</label>
          <select id="newPoSubcategory">
            <option value="">${escapeHtml(bi('selectPlaceholder').en)}</option>
            ${subOptions}
          </select>
        </div>
      ` : ''}
    </div>

    <div class="card">
      ${textField2('newPoNumber', 'poNumber', newPoState.poNumber, { required: true, placeholderKey: 'poNumberPlaceholder' })}
      <div class="section-help" style="margin-top:-4px;">${escapeHtml(bi('syncFromAsanaHelp', 'Enter the PO number, then sync to pull details from Asana.').en)}</div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:8px 0 14px 0;">
        <button type="button" class="btn btn-secondary" id="btnSyncAsana" style="flex:none;width:auto;padding:9px 16px;">${escapeHtml(bi('syncFromAsana', 'Sync from Asana').en)}</button>
        <span id="asanaSyncStatus" class="section-help" style="margin:0;"></span>
      </div>
      ${textField2('newPoSku', 'productSku', newPoState.sku, { required: true, placeholderKey: 'productSkuPlaceholder' })}
      <div class="field-row">
        <div style="flex:1">${dateField2('newPoOrderDate', 'orderDateLabel', newPoState.orderDate, { required: true })}</div>
        <div style="flex:1">${textField2('newPoQuantity', 'poQuantity', newPoState.orderQuantity, { required: true, placeholderKey: 'poQuantityPlaceholder', numeric: true })}</div>
      </div>
      <div class="field-row">
        <div style="flex:1">${dateField2('newPoFulfillmentRequestDate', 'fulfillmentRequestDate', newPoState.fulfillmentRequestDate, {})}</div>
      </div>
      ${newPoSelectFieldWithOther('newPoCreator', 'creator', newPoState.creator, OPTIONS.creators || [], newPoState.creatorOtherMode)}
      ${textField2('newPoProductTitle', 'productTitle', newPoState.productTitle, {})}
      ${newPoSelectFieldWithOther('newPoPdLead', 'productDevelopmentLead', newPoState.productDevelopmentLead, OPTIONS.productDevelopmentLeads || [], newPoState.pdLeadOtherMode)}
      ${textField2('newPoAsanaLink', 'asanaTaskLink', newPoState.asanaTaskLink, { placeholderKey: 'asanaTaskLinkPlaceholder' })}
    </div>

    <div id="newPoSizesBlock">${renderNewPoSizesBlock()}</div>

    <div class="nav-buttons">
      <button class="btn btn-primary" id="btnNewPoSubmit">${biBlockHtml('createPo', 'Create Purchase Order')}</button>
    </div>
  `;
}

function textField2(id, i18nKey, value, opts = {}) {
  const l = bi(i18nKey);
  const ph = opts.placeholderKey ? bi(opts.placeholderKey) : { en: '', zh: '' };
  return `
    <div class="field" data-field="${id}">
      <label class="field-label">${escapeHtml(l.en)} <span class="zh">${escapeHtml(l.zh)}</span>${opts.required ? '<span class="required">*</span>' : ''}</label>
      <input type="${opts.numeric ? 'number' : 'text'}" id="${id}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(ph.en)}" />
    </div>
  `;
}
function dateField2(id, i18nKey, value, opts = {}) {
  const l = bi(i18nKey);
  return `
    <div class="field" data-field="${id}">
      <label class="field-label">${escapeHtml(l.en)} <span class="zh">${escapeHtml(l.zh)}</span>${opts.required ? '<span class="required">*</span>' : ''}</label>
      <input type="date" id="${id}" value="${escapeHtml(value || '')}" />
    </div>
  `;
}
function selectFieldPlain(id, i18nKey, value, optionsList) {
  const l = bi(i18nKey);
  const ph = bi('selectPlaceholder');
  return `
    <div class="field" data-field="${id}">
      <label class="field-label">${escapeHtml(l.en)} <span class="zh">${escapeHtml(l.zh)}</span></label>
      <select id="${id}">
        <option value="">${escapeHtml(ph.en)}</option>
        ${optionsList.map((o) => `<option value="${escapeHtml(o)}" ${value === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
      </select>
    </div>
  `;
}

/** Same idea as selectFieldWithOther (dropdown + "Other" reveals a text
 *  field to type something new), but for the New Purchase Order screen,
 *  which keeps its own state object separate from the main wizard. */
function newPoSelectFieldWithOther(id, i18nKey, value, optionsList, otherModeOn) {
  const l = bi(i18nKey);
  const ph = bi('selectPlaceholder');
  const otherLabel = bi('other');
  const otherPh = bi('otherPlaceholder');
  const isOther = otherModeOn || (!!value && !optionsList.includes(value));
  const optsHtml = optionsList.map((o) => `<option value="${escapeHtml(o)}" ${!isOther && value === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');
  return `
    <div class="field" data-field="${id}">
      <label class="field-label">${escapeHtml(l.en)} <span class="zh">${escapeHtml(l.zh)}</span></label>
      <select data-newpo-select-other="${id}">
        <option value="">${escapeHtml(ph.en)}</option>
        <option value="${OTHER_VALUE}" ${isOther ? 'selected' : ''}>${escapeHtml(otherLabel.en)}</option>
        ${optsHtml}
      </select>
      ${isOther ? `<input type="text" data-newpo-other-text="${id}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(otherPh.en)}" style="margin-top:8px;" />` : ''}
    </div>
  `;
}

function sizeMatchesCanonical(fitSizeKey, canonicalSize) {
  return fitSizeKey === canonicalSize || fitSizeKey.startsWith(canonicalSize + ' ') || fitSizeKey.startsWith(canonicalSize + '(');
}

/** Puts a PO's sizes in Youth XS -> Adult 5XL order (matching
 *  fits.json's universalSizes), regardless of what order they were
 *  originally selected/stored in - fixes display for POs created before
 *  this sort was applied at save time too. */
function sortSizesCanonically(sizes) {
  const canonical = (CONFIG.fits && CONFIG.fits.universalSizes) || [];
  const keyOf = (item) => (typeof item === 'string' ? item : item.size);
  return [...(sizes || [])].sort((a, b) => {
    const ia = canonical.indexOf(keyOf(a));
    const ib = canonical.indexOf(keyOf(b));
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

function attachNewPoSizeHandlers() {
  document.querySelectorAll('[data-po-size-toggle]').forEach((el) => {
    el.addEventListener('click', () => {
      const s = el.getAttribute('data-po-size-toggle');
      const idx = newPoState.sizesIncluded.findIndex((x) => x.label === s);
      if (idx > -1) newPoState.sizesIncluded.splice(idx, 1);
      else newPoState.sizesIncluded.push({ label: s, quantity: null });
      newPoState.sizesPreFilled = false;
      render();
    });
  });
  document.querySelectorAll('[data-po-variant-qty]').forEach((el) => {
    el.addEventListener('input', (e) => {
      const i = parseInt(el.getAttribute('data-po-variant-qty'), 10);
      const n = parseInt(e.target.value, 10);
      newPoState.sizesIncluded[i].quantity = isNaN(n) ? null : n;
    });
  });
  document.querySelectorAll('[data-po-variant-sku]').forEach((el) => {
    el.addEventListener('input', (e) => {
      const i = parseInt(el.getAttribute('data-po-variant-sku'), 10);
      newPoState.sizesIncluded[i].sku = e.target.value;
      // Typed by hand - stop regenerating it.
      newPoState.sizesIncluded[i].autoSku = false;
    });
  });
  document.querySelectorAll('[data-po-variant-label]').forEach((el) => {
    el.addEventListener('input', (e) => {
      const i = parseInt(el.getAttribute('data-po-variant-label'), 10);
      newPoState.sizesIncluded[i].label = e.target.value;
    });
  });
  document.querySelectorAll('[data-po-variant-remove]').forEach((el) => {
    el.addEventListener('click', () => {
      const i = parseInt(el.getAttribute('data-po-variant-remove'), 10);
      newPoState.sizesIncluded.splice(i, 1);
      render();
    });
  });
  const btnAddVariant = document.getElementById('btnAddPoVariant');
  if (btnAddVariant) {
    btnAddVariant.addEventListener('click', () => {
      newPoState.sizesIncluded.push({ label: '', quantity: null });
      render();
    });
  }
}

async function checkSkuEstablishedFit() {
  const sku = newPoState.sku.trim();
  if (!sku || sku === newPoState.skuChecked) return;
  try {
    const res = await fetch(`/api/sku-established-fit/${encodeURIComponent(sku)}`);
    const data = await res.json();
    newPoState.establishedFit = data.fit;
    // Convenience: pre-check whichever universal sizes match this SKU's
    // previously-established fit, if nothing's been manually selected yet.
    if (data.fit && !newPoState.sizesIncluded.length) {
      const universalSizes = (CONFIG.fits && CONFIG.fits.universalSizes) || [];
      newPoState.sizesIncluded = universalSizes
        .filter((canonical) => (data.fit.sizes || []).some((fitSize) => sizeMatchesCanonical(fitSize, canonical)))
        .map((label) => ({ label, quantity: null }));
      newPoState.sizesPreFilled = newPoState.sizesIncluded.length > 0;
    }
  } catch (e) {
    console.error('Failed to check established fit', e);
    newPoState.establishedFit = null;
  } finally {
    newPoState.skuChecked = sku;
    // Targeted update instead of a full render() - a full re-render here
    // would destroy whatever field the user has already moved on to and
    // focused (this runs on SKU blur, so they're very likely already
    // interacting with the next field, like PO Quantity, when it resolves).
    const container = document.getElementById('newPoSizesBlock');
    if (container) {
      container.innerHTML = renderNewPoSizesBlock();
      attachNewPoSizeHandlers();
    }
  }
}

function attachNewPoHandlers() {
  const bindText = (id, field, numeric) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', (e) => { newPoState[field] = e.target.value; });
  };
  bindText('newPoNumber', 'poNumber');
  bindText('newPoOrderDate', 'orderDate');
  bindText('newPoFulfillmentRequestDate', 'fulfillmentRequestDate');
  bindText('newPoQuantity', 'orderQuantity');
  bindText('newPoProductTitle', 'productTitle');
  bindText('newPoAsanaLink', 'asanaTaskLink');

  // ---- "Sync from Asana": one lookup by PO number fills in everything
  // Asana owns, so the requester only types the PO number. Values already
  // typed here are overwritten deliberately - Asana is the source of truth
  // for these particular fields. ----
  const syncBtn = document.getElementById('btnSyncAsana');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      const poNumber = (newPoState.poNumber || '').trim();
      const statusEl = document.getElementById('asanaSyncStatus');
      const say = (msg, isError) => {
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.style.color = isError ? 'var(--jc-fail)' : 'var(--jc-muted)';
      };
      if (!poNumber) return say(bi('syncNeedPoNumber', 'Enter a PO number first').en, true);
      syncBtn.disabled = true;
      say(bi('syncingFromAsana', 'Syncing...').en);
      try {
        const res = await fetch('/api/asana/pull-po', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ poNumber })
        });
        const body = await res.json();
        if (!res.ok || !body.ok) {
          return say(body.error || bi('syncNotFound', 'No matching PO found in Asana').en, true);
        }
        const f = body.fields || {};
        const filled = [];
        const setIf = (key, value, label) => {
          if (value === null || value === undefined || value === '') return;
          newPoState[key] = value;
          filled.push(label);
        };
        // Taken from the Asana task name, which is "PONUMBER - Product Title".
        /* Report what the handoff will bring across. Counts only - the
         * files themselves are fetched on submit, once there's a PO to
         * attach them to. */
        if (body.handoff && body.handoff.willImport) {
          filled.push(`${body.handoff.willImport} handoff file(s)`);
        }
        setIf('productTitle', f.productTitle, 'Product title');
        setIf('sku', f.sku, 'SKU');
        setIf('orderQuantity', f.orderQuantity, 'Quantity');
        setIf('creator', f.creator, 'Creator');
        setIf('productDevelopmentLead', f.productDevelopmentLead, 'PD');
        setIf('sourcer', f.sourcer, 'Sourcer');
        setIf('fulfillmentRequestDate', f.fulfillmentRequestDate, 'Fulfil date');
        setIf('fulfillmentChannel', f.fulfillmentChannel, 'Channel');
        if (f.warehouse && f.warehouse.warehouseName) {
          newPoState.warehouse = f.warehouse.warehouseName;
          filled.push('Warehouse');
        }
        if (body.taskGid && !newPoState.asanaTaskLink) {
          newPoState.asanaTaskLink = `https://app.asana.com/0/0/${body.taskGid}`;
          filled.push('Asana link');
        }
        // A creator or PD that Asana knows but this app doesn't would leave
        // the dropdown blank, so switch those to free-text "other" mode.
        if (newPoState.creator && !(OPTIONS.creators || []).includes(newPoState.creator)) newPoState.creatorOtherMode = true;
        if (newPoState.productDevelopmentLead && !(OPTIONS.productDevelopmentLeads || []).includes(newPoState.productDevelopmentLead)) newPoState.pdLeadOtherMode = true;
        render();
        const el = document.getElementById('asanaSyncStatus');
        if (el) {
          el.textContent = filled.length
            ? `${bi('syncPulled', 'Pulled from Asana').en}: ${filled.join(', ')}`
            : bi('syncPulled', 'Pulled from Asana').en;
          el.style.color = 'var(--jc-teal-dark)';
        }
      } catch (err) {
        say(err.message || String(err), true);
      } finally {
        const b2 = document.getElementById('btnSyncAsana');
        if (b2) b2.disabled = false;
      }
    });
  }

  const pdLeadSelect = document.querySelector('[data-newpo-select-other="newPoPdLead"]');
  if (pdLeadSelect) {
    pdLeadSelect.addEventListener('change', (e) => {
      if (e.target.value === OTHER_VALUE) { newPoState.pdLeadOtherMode = true; newPoState.productDevelopmentLead = ''; }
      else { newPoState.pdLeadOtherMode = false; newPoState.productDevelopmentLead = e.target.value; }
      render();
    });
  }
  const pdLeadOtherInput = document.querySelector('[data-newpo-other-text="newPoPdLead"]');
  if (pdLeadOtherInput) pdLeadOtherInput.addEventListener('input', (e) => { newPoState.productDevelopmentLead = e.target.value; });

  const skuInput = document.getElementById('newPoSku');
  if (skuInput) {
    skuInput.addEventListener('input', (e) => { newPoState.sku = e.target.value; });
    skuInput.addEventListener('blur', checkSkuEstablishedFit);
  }
  const creatorSelect = document.querySelector('[data-newpo-select-other="newPoCreator"]');
  if (creatorSelect) {
    creatorSelect.addEventListener('change', (e) => {
      if (e.target.value === OTHER_VALUE) { newPoState.creatorOtherMode = true; newPoState.creator = ''; }
      else { newPoState.creatorOtherMode = false; newPoState.creator = e.target.value; }
      render();
    });
  }
  const creatorOtherInput = document.querySelector('[data-newpo-other-text="newPoCreator"]');
  if (creatorOtherInput) creatorOtherInput.addEventListener('input', (e) => { newPoState.creator = e.target.value; });

  const catSelect = document.getElementById('newPoCategory');
  if (catSelect) {
    catSelect.addEventListener('change', (e) => {
      newPoState.category = e.target.value || null;
      newPoState.subcategory = null;
      render();
    });
  }
  const subSelect = document.getElementById('newPoSubcategory');
  if (subSelect) subSelect.addEventListener('change', (e) => { newPoState.subcategory = e.target.value || null; });

  document.querySelectorAll('[data-newpo-seg]').forEach((el) => {
    el.addEventListener('click', () => {
      const field = el.getAttribute('data-newpo-seg');
      newPoState[field] = el.getAttribute('data-val');
      render();
    });
  });

  attachNewPoSizeHandlers();

  const btnSubmit = document.getElementById('btnNewPoSubmit');
  if (btnSubmit) btnSubmit.addEventListener('click', submitNewPo);
}

async function submitNewPo() {
  const missing = [];
  if (!newPoState.category) missing.push('Product Category');
  if (!newPoState.poNumber.trim()) missing.push('PO Number');
  if (!newPoState.sku.trim()) missing.push('Product SKU');
  if (!newPoState.orderDate) missing.push('Order Date');
  if (!newPoState.orderQuantity) missing.push('Order Quantity');
  if (!newPoState.productDevelopmentLead.trim()) missing.push('Product Development Lead');
  if (newPoState.category === 'apparel' && !newPoState.sizesIncluded.length) missing.push('At least one size');
  if (missing.length) {
    showToast('Please fill in: ' + missing.join(', '), true);
    return;
  }

  // Size quantities must add up to the PO quantity. Catching this here
  // rather than downstream avoids a PO whose variant split silently
  // disagrees with the quantity the factory is told to make.
  const rows = newPoState.sizesIncluded.filter((x) => x.label);
  if (rows.length) {
    const sized = rows.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);
    const total = Number(newPoState.orderQuantity) || 0;
    if (sized !== total) {
      const diff = sized - total;
      showToast(
        `Size quantities total ${sized.toLocaleString()}, but the PO quantity is ${total.toLocaleString()} ` +
        `(${diff > 0 ? diff.toLocaleString() + ' too many' : Math.abs(diff).toLocaleString() + ' short'}).`,
        true
      );
      return;
    }
  }

  const btn = document.getElementById('btnNewPoSubmit');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>...`;
  try {
    const res = await fetch('/api/purchase-orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        poNumber: newPoState.poNumber, sku: newPoState.sku, category: newPoState.category, subcategory: newPoState.subcategory,
        orderDate: newPoState.orderDate, creator: newPoState.creator, productTitle: newPoState.productTitle, orderQuantity: newPoState.orderQuantity,
        productDevelopmentLead: newPoState.productDevelopmentLead,
        fulfillmentRequestDate: newPoState.fulfillmentRequestDate || null,
        sizesIncluded: newPoState.sizesIncluded.map((x) => x.label).filter(Boolean),
        sizeDistribution: newPoState.sizesIncluded.filter((x) => x.label).map((x) => ({ size: x.label, quantity: x.quantity, sku: (x.sku || '').trim() || null })),
        asanaTaskLink: newPoState.asanaTaskLink,
        // Pulled from Asana by the Sync button - carried through so the
        // order record keeps them without anyone retyping.
        sourcer: newPoState.sourcer || null,
        fulfillmentChannel: newPoState.fulfillmentChannel || null,
        warehouse: newPoState.warehouse || null
      })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Failed to create purchase order', true);
      btn.disabled = false;
      btn.innerHTML = biBlockHtml('createPo', 'Create Purchase Order');
      return;
    }
    renderNewPoSuccess(data);
  } catch (e) {
    console.error(e);
    showToast('Failed to create purchase order', true);
    btn.disabled = false;
    btn.innerHTML = biBlockHtml('createPo', 'Create Purchase Order');
  }
}

function renderNewPoSuccess(data) {
  const root = document.getElementById('formRoot');
  const fullUrl = `${location.origin}${data.approvalUrl}`;
  root.innerHTML = `
    <div class="success-screen">
      <div class="success-icon">✓</div>
      <div class="success-title">${escapeHtml(bi('poCreated').en)}</div>
      <div class="success-sub">${escapeHtml(bi('poCreated').zh)}</div>
      <div class="card" style="text-align:left; margin-top:16px;">
        <div class="section-title">${biBlockHtml('shareLinkTitle', 'Share this link for QA/QC Approval')}</div>
        <input type="text" readonly value="${escapeHtml(fullUrl)}" id="approvalLinkInput" style="margin-top:8px;" onclick="this.select()" />
        <button class="btn btn-secondary" id="btnCopyLink" style="margin-top:8px;">${escapeHtml(bi('copyLink').en)}</button>
      </div>
      <button class="btn btn-secondary" id="btnPoStartOver" style="max-width:280px; margin:16px auto 0 auto;">${biBlockHtml('submitAnotherPo', 'Submit Another PO')}</button>
      <a href="index.html" class="btn btn-secondary" style="max-width:280px; margin:10px auto 0 auto; text-decoration:none; display:block; text-align:center;">${biBlockHtml('goHome', 'Go Home')}</a>
    </div>
  `;
  document.getElementById('btnCopyLink').addEventListener('click', () => {
    navigator.clipboard.writeText(fullUrl).then(() => showToast(bi('linkCopied').en + ' / ' + bi('linkCopied').zh));
  });
  document.getElementById('btnPoStartOver').addEventListener('click', () => {
    Object.assign(newPoState, {
      category: null, subcategory: null, poNumber: '', sku: '', orderDate: todayStr(), creator: '', productTitle: '',
      orderQuantity: '', productDevelopmentLead: '', fulfillmentRequestDate: '', sizesIncluded: [], sizesPreFilled: false, establishedFit: null, skuChecked: null, pdLeadOtherMode: false, creatorOtherMode: false, asanaTaskLink: ''
    });
    appMode = 'newPO';
    render();
  });
}

/* ---- PO Lookup: replaces the old Category step. Category, order info, and
 * sizing standard now all come from the PO record + QA/QC Approval data. ---- */
function renderPoLookupStep() {
  return `
    <div class="step-eyebrow">${stepLabel()}</div>
    <div class="step-title">${biBlockHtml(stageTitleKeyForQaType(), 'Pre-Production Sample Reporting')}</div>
    <div class="card">
      <div class="field">
        <label class="field-label">${biBlockHtml('poNumber', 'Purchase Order Number')}<span class="required">*</span></label>
        <input type="text" id="poLookupInput" value="${escapeHtml(state.poNumber)}" placeholder="${escapeHtml(bi('poNumberPlaceholder').en)}" />
      </div>
      <button class="btn btn-primary" id="btnPoLookupSubmit" style="margin-top:10px;">${biBlockHtml('next', 'Next')}</button>
    </div>
  `;
}
function stageTitleKeyForQaType() {
  return state.qaType === 'production' ? 'chooserBulk' : 'chooserPreProd';
}
async function submitPoLookup() {
  const po = document.getElementById('poLookupInput').value.trim();
  if (!po) return;
  const btn = document.getElementById('btnPoLookupSubmit');
  btn.disabled = true;
  try {
    const poRes = await fetch(`/api/purchase-orders?poNumber=${encodeURIComponent(po)}`);
    const poData = await poRes.json();
    if (!poData.pos || !poData.pos.length) {
      showToast(bi('poNotFound').en + ' / ' + bi('poNotFound').zh, true);
      btn.disabled = false;
      return;
    }
    const record = poData.pos[0];
    state.poNumber = record.poNumber;
    state.sku = record.sku;
    state.category = record.category;
    state.subcategory = record.subcategory;
    state.creator = record.creator || '';
    state.productTitle = record.productTitle || '';
    state.poQuantity = record.orderQuantity ? String(record.orderQuantity) : '';
    state.poSizesIncluded = sortSizesCanonically(record.sizesIncluded || []);
    if (record.productRisk) state.productRisk = record.productRisk;

    /* The PO's own Product Dimensions are the approved sizing for non-apparel.
     * Previously the report only read sizing from the Golden Sample approval,
     * so a PO whose dimensions were filled in afterwards (or whose approval
     * never recorded sizing) showed no reference at all - and the tolerance
     * check silently had nothing to compare against. The approval still wins
     * when it has sizing; this is the fallback.
     *
     * Order Management calls the front-to-back axis Length; the report calls it
     * Depth. Same measurement, so it maps straight across. */
    const poDims = {
      height: record.dimensionsHeight,
      width: record.dimensionsWidth,
      depth: record.dimensionsLength
    };
    state.poWeightG = record.weightGrams || null;

    /* Apparel sizing comes from the PO's Product Dimensions table, which is
     * the sizing source of truth for the order. The report used to take the
     * fit only from the Golden Sample approval, so a PO whose approval hadn't
     * recorded sizing opened on an empty "Select a fit..." and QA was asked to
     * choose - which meant they could pick a different standard than the one
     * the order was placed against. */
    if (record.fitKey) state.categoryData.fit = record.fitKey;
    state.poDimensionsTable = record.dimensionsTable || null;
    if (state.poDimensionsTable && state.poDimensionsTable.standardKey && !record.fitKey) {
      state.categoryData.fit = state.poDimensionsTable.standardKey;
    }
    if (['height', 'width', 'depth'].some((k) => poDims[k] !== null && poDims[k] !== undefined && String(poDims[k]).trim())) {
      state.poDimensions = poDims;
      if (!state.approvalSizingData) state.approvalSizingData = { dimensions: poDims };
    }
    // Whichever stage this report is for. Null when Setup Report Link was
    // never run, which means no additional questions - the safe default.
    const setupStage = state.qaType === 'production' ? 'bulk' : 'preProduction';
    state.qaSetup = (record.qaSetup && record.qaSetup[setupStage]) || null;

    // Pull Factory Code / Product Risk / sizing standard from QA/QC Approval's
    // Sample Approval, if it's been completed for this PO. Also gather
    // reference photos + notes for the Production Notes step.
    try {
      const approvalRes = await fetch(`/api/approval/${encodeURIComponent(po)}`);
      if (approvalRes.ok) {
        const approvalData = await approvalRes.json();
        const sample = approvalData.approval && approvalData.approval.sampleApproval;
        const preProd = approvalData.approval && approvalData.approval.preProductionApproval;
        if (sample && sample.submitted) {
          state.factoryCode = sample.data.factoryCode || '';
          state.productRisk = sample.data.productRisk || 'medium';
          if (sample.data.sizing) {
            // Keep the PO's dimensions if the approval recorded none of its own.
            const poDims = state.poDimensions;
            const hasOwnDims = sample.data.sizing.dimensions
              && ['height', 'width', 'depth'].some((k) => String(sample.data.sizing.dimensions[k] || '').trim());
            state.approvalSizingData = (!hasOwnDims && poDims)
              ? { ...sample.data.sizing, dimensions: poDims }
              : sample.data.sizing;
            if (state.category === 'apparel') state.categoryData.fit = sample.data.sizing.fit || '';
          }
        }
        // Collect every PD comment across all three stages for the Notes section.
        const allComments = [];
        ['sampleApproval', 'preProductionApproval', 'bulkApproval'].forEach((key) => {
          const stage = approvalData.approval && approvalData.approval[key];
          if (stage && stage.pdComments) {
            stage.pdComments.forEach((c) => allComments.push({ ...c, stage: key }));
          }
        });
        allComments.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        state.pdNotes = allComments;

        // Reference photos for Step 3 - Approved Sample, and Pre-Production once it exists.
        state.approvalReferencePhotos = {
          sample: (sample && sample.submitted && sample.data.photos) || {},
          preProduction: (preProd && preProd.submitted && preProd.data.photos) || {}
        };

        // Per-stage notes (the free-text field entered when that stage was
        // submitted, separate from PD's comments) plus a link to the
        // Pre-Production inspection report, if one has been filed.
        const history = approvalData.reportingHistory || [];
        const preProdReport = history.find((h) => h.qaType === 'pre_production' && h.poNumber === state.poNumber);
        state.productionNotesData = {
          sample: {
            reportNotes: (sample && sample.submitted && sample.data.notes) || '',
            pdComments: (sample && sample.pdComments) || []
          },
          preProduction: {
            reportNotes: (preProd && preProd.submitted && preProd.data.notes) || '',
            pdComments: (preProd && preProd.pdComments) || [],
            linkedReport: preProdReport || null
          }
        };
      }
    } catch (e) { console.error('Failed to load approval data for pre-fill', e); }

    /* Resume last, so a saved draft wins over the PO/approval pre-fill above.
     * Anything the inspector already typed or corrected should survive - the
     * pre-fill is only a starting point. */
    /* If this stage has already been reported on, the link shows the completed
     * state instead of starting another report. Checked before the draft
     * resume, because a submitted report supersedes any leftover draft. */
    const stageKey = state.qaType === 'production' ? 'bulk' : 'preProduction';
    const submitted = (record.qaSubmitted || {})[stageKey];
    if (submitted) {
      state.completedReport = submitted;
      state.reportMode = 'gate';
      render();
      return;
    }

    const resumed = await tryResumeDraft();
    if (resumed) { render(); return; }

    goTo(1);
  } catch (e) {
    console.error(e);
    showToast(bi('poNotFound').en + ' / ' + bi('poNotFound').zh, true);
    btn.disabled = false;
  }
}

/* ---- Step 3: Production Notes (reference images, notes from every approval
 * stage, and every issue found on previous POs of this SKU) ---- */
function renderReferencePhotosSection() {
  const sample = state.approvalReferencePhotos.sample || {};
  const preProd = state.approvalReferencePhotos.preProduction || {};
  const hasSample = Object.values(sample).some((arr) => arr && arr.length);
  const hasPreProd = Object.values(preProd).some((arr) => arr && arr.length);
  if (!hasSample && !hasPreProd) return '';

  const gallery = (photosMap, titleKey, fallback) => {
    const slots = Object.keys(photosMap).filter((k) => (photosMap[k] || []).length);
    if (!slots.length) return '';
    const tiles = slots.flatMap((slotKey) => photosMap[slotKey].map((url) => `
      <div class="photo-tile">
        <div class="photo-gallery-large-frame"><img src="${escapeHtml(url)}" class="js-lightbox" /></div>
        <div class="photo-tile-caption">${escapeHtml(slotKey)}</div>
      </div>
    `)).join('');
    return `
      <div class="section-photos-block" style="margin-top:10px;">
        <div class="section-title" style="font-size:14px;">${biBlockHtml(titleKey, fallback)}</div>
        <div class="photo-gallery-large">${tiles}</div>
      </div>
    `;
  };

  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('referenceImagesTitle', 'Reference Images')}</div>
      ${gallery(sample, 'sampleApprovalTitle', 'Sample Approval')}
      ${gallery(preProd, 'preProductionApprovalTitle', 'Pre-Production Approval')}
    </div>
  `;
}

function renderProductionNotesSection() {
  const data = state.productionNotesData;
  if (!data) return '';

  const stageBlock = (stageData, titleKey, fallback) => {
    const hasReportNotes = stageData.reportNotes && stageData.reportNotes.trim();
    const hasComments = stageData.pdComments && stageData.pdComments.length;
    if (!hasReportNotes && !hasComments && !stageData.linkedReport) return '';
    return `
      <div style="margin-top:12px; padding-top:12px; border-top:1px dashed var(--jc-border);">
        <div class="section-photos-label">${biBlockHtml(titleKey, fallback)}</div>
        ${hasReportNotes ? `<div class="prior-issue-desc" style="margin-top:6px;">${escapeHtml(stageData.reportNotes)}</div>` : ''}
        ${hasComments ? stageData.pdComments.map((c) => `
          <div class="defect-card comment-card ${approvalStatusColorClass(c.approvalStatus)}" style="margin-top:8px;">
            ${c.text ? `<div class="prior-issue-desc">${escapeHtml(c.text)}</div>` : `<div class="prior-issue-desc" style="font-style:italic; color:var(--jc-muted);">${escapeHtml(bi('noCommentTextProvided').en)}<span class="zh">${escapeHtml(bi('noCommentTextProvided').zh)}</span></div>`}
            <div class="section-help">${escapeHtml(c.author)} · ${new Date(c.timestamp).toLocaleDateString()}</div>
          </div>
        `).join('') : ''}
        ${stageData.linkedReport ? `
          <a href="/submissions/${encodeURIComponent(stageData.linkedReport.pdfFilename)}" target="_blank" rel="noopener" class="btn btn-secondary" style="display:block; text-decoration:none; text-align:center; margin-top:8px; max-width:240px;">${biBlockHtml('downloadFullReport', 'Download Full Report')}</a>
        ` : ''}
      </div>
    `;
  };

  const body = stageBlock(data.sample, 'sampleApprovalTitle', 'Approved Sample Notes') + stageBlock(data.preProduction, 'preProductionApprovalTitle', 'Pre-Production Sample Notes');
  if (!body.trim()) return '';

  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('productionNotesTitle', 'Production Notes')}</div>
      ${body}
    </div>
  `;
}

/** Issues flagged in THIS PO's own Pre-Production sample report - part of
 *  the main section, distinct from Production Notes (which is free-text
 *  notes/comments only) and from Previous PO References (other POs). */
function renderProductionIssuesSection() {
  const ownPreProdReports = priorReports.filter((r) => r.poNumber === state.poNumber && r.qaType === 'pre_production');
  if (!ownPreProdReports.length) return '';
  const withIssues = ownPreProdReports.filter((r) => r.issues && r.issues.length);
  if (!withIssues.length) return '';

  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('productionIssuesTitle', 'Production Issues')}</div>
      ${withIssues.map((r) => r.issues.map((iss) => {
        const sevLabel = bi(iss.severity);
        return `
          <div class="prior-issue-card">
            <div class="prior-issue-header">
              <span class="prior-issue-desc">${escapeHtml(iss.description || '-')}</span>
              <span class="severity-badge severity-${escapeHtml(iss.severity)}">${escapeHtml(sevLabel.en)} ${escapeHtml(sevLabel.zh)}</span>
            </div>
            <div class="section-help">${escapeHtml(bi('unitsAffected').en)}<span class="zh">${escapeHtml(bi('unitsAffected').zh)}</span>: ${iss.unitsAffected}</div>
            ${iss.photoUrl ? `<img src="${escapeHtml(iss.photoUrl)}" class="prior-issue-photo js-lightbox" />` : ''}
          </div>
        `;
      }).join('')).join('')}
    </div>
  `;
}

/** Every issue from OTHER POs of the same SKU - this PO's own issues live in
 *  Production Issues above, not here. Rendered with a large header and a
 *  visible divider so it reads as clearly a different section.
 *
 *  This used to filter to major/critical only. Since severity became derived
 *  (Step 5 fail = major, Step 6 = minor), that quietly meant no Step 6 issue
 *  ever carried forward - so "loose threads on 5 units last time" never
 *  reached the inspector looking at the repeat order, which is exactly the
 *  thing worth knowing. */
function renderPreviousPoReferencesSection() {
  const otherPoReports = priorReports.filter((r) => r.poNumber !== state.poNumber);
  const withMajorCritical = otherPoReports
    .map((r) => ({ ...r, issues: r.issues || [] }))
    .filter((r) => r.issues.length);
  if (!withMajorCritical.length) return '';

  return `
    <div class="major-divider"></div>
    <div class="step-title" style="font-size:20px; margin-bottom:10px;">${biBlockHtml('previousPoReferencesTitle', 'Previous PO References')}</div>
    <div class="card">
      <div class="section-title">${biBlockHtml('previousProductionIssuesTitle', 'Previous Production Issues')}</div>
      ${withMajorCritical.map((r) => {
        const qaTypeLabel = r.qaType === 'production' ? bi('production') : bi('prePro');
        const resultLabel = r.overallResult === 'pass' ? bi('resultPass') : bi('resultFail');
        const issuesHtml = r.issues.map((iss) => {
              const sevLabel = bi(iss.severity);
              return `
                <div class="prior-issue-card">
                  <div class="prior-issue-header">
                    <span class="prior-issue-desc">${escapeHtml(iss.description || '-')}</span>
                    <span class="severity-badge severity-${escapeHtml(iss.severity)}">${escapeHtml(sevLabel.en)} ${escapeHtml(sevLabel.zh)}</span>
                  </div>
                  <div class="section-help">${escapeHtml(bi('unitsAffected').en)}<span class="zh">${escapeHtml(bi('unitsAffected').zh)}</span>: ${iss.unitsAffected}</div>
                  ${iss.photoUrl ? `<img src="${escapeHtml(iss.photoUrl)}" class="prior-issue-photo js-lightbox" />` : ''}
                </div>
              `;
            }).join('');
        return `
          <div style="margin-top:12px; padding-top:12px; border-top:1px dashed var(--jc-border);">
            <div class="section-help">
              ${escapeHtml(r.poNumber || '')} · ${escapeHtml(qaTypeLabel.en)} ${escapeHtml(qaTypeLabel.zh)} · ${escapeHtml(r.date || '')} ·
              <strong style="color:${r.overallResult === 'pass' ? 'var(--jc-teal-dark)' : 'var(--jc-fail)'}">${escapeHtml(resultLabel.en)} ${escapeHtml(resultLabel.zh)}</strong>
            </div>
            ${issuesHtml}
            <a href="/submissions/${encodeURIComponent(r.pdfFilename)}" target="_blank" rel="noopener" class="btn btn-secondary" style="display:block; text-decoration:none; text-align:center; margin-top:8px; max-width:220px;">${biBlockHtml('downloadFullReport', 'Download Full Report')}</a>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderProductionNotesStep() {
  return `
    <div class="step-eyebrow">${stepLabel()}</div>
    <div class="step-title">${biBlockHtml('productionNotesStepTitle', 'Production Notes & References')}</div>
    <div id="referencePhotosArea">${renderReferencePhotosSection()}</div>
    ${renderProductionNotesSection()}
    ${renderProductionIssuesSection()}
    ${renderPreviousPoReferencesSection()}
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="btnBack">${biBlockHtml('back', 'Back')}</button>
      <button class="btn btn-secondary" id="btnSaveDraft">${biBlockHtml('saveAndClose', 'Save')}</button>
      <button class="btn btn-primary" id="btnNext">${biBlockHtml('next', 'Next')}</button>
    </div>
  `;
}

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
      <a href="analytics.html" class="settings-link" title="Analytics">📊 ${biBlockHtml('analyticsLink', 'Analytics')}</a>
      <a href="settings.html" class="settings-link" title="Settings">⚙️ ${biBlockHtml('settingsTitle', 'Settings')}</a>
    </div>
    <div class="step-eyebrow">${stepLabel()}</div>
    <div class="step-title">选择产品类别<span class="zh">Select Product Category</span></div>
    <div class="category-grid">${catCards}</div>
    <div class="nav-buttons">
      <button class="btn btn-primary" id="btnNext">${biBlockHtml('next', 'Next')}</button>
    </div>
  `;
}

/** Looks up prior reports for the currently-entered PO Number and refreshes the card. */
async function fetchPriorReports() {
  const sku = (state.sku || '').trim();
  if (!sku || sku === priorReportsPoChecked) return;
  priorReportsPoChecked = sku;
  try {
    const res = await fetch(`/api/submission-history-by-sku/${encodeURIComponent(sku)}`);
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

/** If QA Type is Production and a prior report exists for this PO, fills in
 *  order-info fields and sizing details that are still at their default/empty
 *  state (never overwrites something the user already typed). Photos are never
 *  carried over - only text/numbers, since photos are physical evidence tied to
 *  a specific inspection. Returns true if anything was actually filled in. */
function tryAutoFillFromPrior() {
  if (state.qaType !== 'production') return false;
  if (!priorReports.length) return false;
  if (state.autoFilledForPo === state.poNumber) return false;

  const source = priorReports[0];
  let changed = false;
  const fill = (field, value) => {
    if (!value) return;
    if (state[field]) return;
    state[field] = value;
    changed = true;
  };
  fill('factoryCode', source.factoryCode);
  fill('qaLead', source.qaLead);
  fill('creator', source.creator);
  fill('productTitle', source.productTitle);
  fill('poQuantity', source.poQuantity ? String(source.poQuantity) : '');
  fill('materials', source.materials);
  fill('printingMethod', source.printingMethod);
  if (source.productRisk && !state._productRiskTouched) { state.productRisk = source.productRisk; changed = true; }

  const carry = source.sizingCarryForward;
  if (carry && state.category === 'apparel') {
    if (!state.categoryData.fit && carry.fit) {
      state.categoryData.fit = carry.fit;
      changed = true;
    }
    if ((!state.categoryData.sizeRows || !state.categoryData.sizeRows.length) && carry.sizeRows && carry.sizeRows.length) {
      state.categoryData.sizeRows = carry.sizeRows.map((r) => ({ size: r.size, measured: r.measured || {}, photos: [] }));
      changed = true;
    }
    if ((!state.categoryData.customSizeRows || !state.categoryData.customSizeRows.length) && carry.customSizeRows && carry.customSizeRows.length) {
      state.categoryData.customSizeRows = carry.customSizeRows.map((r) => ({ sizeName: r.sizeName, measurements: r.measurements, photos: [] }));
      changed = true;
    }
  }

  if (changed) state.autoFilledForPo = state.poNumber;
  return changed;
}

function renderPriorReportCard() {
  if (!priorReports.length) return '';
  const latest = priorReports[0];
  const qaTypeLabel = latest.qaType === 'production' ? bi('production') : bi('prePro');
  const resultLabel = latest.overallResult === 'pass' ? bi('resultPass') : bi('resultFail');
  const issuesHtml = (latest.issues && latest.issues.length)
    ? latest.issues.map((iss) => {
        const sevLabel = bi(iss.severity);
        return `
          <div class="prior-issue-card">
            <div class="prior-issue-header">
              <span class="prior-issue-desc">${escapeHtml(iss.description || '-')}</span>
              <span class="severity-badge severity-${escapeHtml(iss.severity)}">${escapeHtml(sevLabel.en)} ${escapeHtml(sevLabel.zh)}</span>
            </div>
            <div class="section-help">${escapeHtml(bi('unitsAffected').en)}<span class="zh">${escapeHtml(bi('unitsAffected').zh)}</span>: ${iss.unitsAffected}</div>
            ${iss.photoUrl ? `<img src="${escapeHtml(iss.photoUrl)}" class="prior-issue-photo" />` : ''}
          </div>
        `;
      }).join('')
    : `<div class="section-help" style="margin-top:6px;">${escapeHtml(bi('noIssues').en)}</div>`;

  return `
    <div class="card" style="background:var(--jc-mint-light); border-color:var(--jc-teal);">
      <div class="section-title">${biBlockHtml('priorReportFound', 'Previous Report Found')}</div>
      <div class="section-help">
        ${escapeHtml(qaTypeLabel.en)} ${escapeHtml(qaTypeLabel.zh)} · ${escapeHtml(latest.date || '')} ·
        <strong style="color:${latest.overallResult === 'pass' ? 'var(--jc-teal-dark)' : 'var(--jc-fail)'}">${escapeHtml(resultLabel.en)} ${escapeHtml(resultLabel.zh)}</strong>
      </div>
      <div class="section-photos-label" style="margin-top:12px;">${biBlockHtml('priorReportIssues', 'Issues Found')}</div>
      ${issuesHtml}
      <a href="/submissions/${encodeURIComponent(latest.pdfFilename)}" target="_blank" rel="noopener" class="btn btn-secondary" style="display:block; text-decoration:none; text-align:center; margin-top:12px; max-width:260px;">
        ${escapeHtml(bi('downloadFullReport').en)}
      </a>
      ${priorReports.length > 1 ? `<div class="section-help" style="margin-top:8px;">${priorReports.length - 1} ${escapeHtml(bi('moreEarlierReports').en)} ${escapeHtml(bi('moreEarlierReports').zh)}</div>` : ''}
    </div>
  `;
}

/* ---- Step 1: Order Info (+ AQL setup) ---- */

/** Creator/PO Quantity render as read-only prefilled rows when the purchase
 *  order actually supplied them, and fall back to their editable controls
 *  when it didn't - see the comment in renderOrderInfoStep. */
function creatorIsPrefilled() {
  return !!(state.creator && String(state.creator).trim());
}
function poQuantityIsPrefilled() {
  // Mirrors the step's own validation (required, >= 2) so a quantity that
  // would fail validation stays editable rather than locking the user out.
  const n = parseInt(state.poQuantity, 10);
  return !isNaN(n) && n >= 2;
}
/** Thousands separators so a locked-in 5000 reads as 5,000 - it's display
 *  only now that the field isn't an editable number input. */
function formatQty(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? String(v || '') : n.toLocaleString('en-US');
}
/** Translated label for a risk key, for the read-only risk row. */
function riskLabel(risk) {
  const key = 'risk' + String(risk || 'medium').charAt(0).toUpperCase() + String(risk || 'medium').slice(1);
  return bi(key, risk || 'medium').en;
}

function renderOrderInfoStep() {
  const catDef = currentCategoryDef();
  const catLabel = catDef ? { en: catDef.label_zh, zh: catDef.label_en } : { en: '', zh: '' };
  const subDef = catDef && state.subcategory ? (catDef.subcategories || []).find((s) => s.key === state.subcategory) : null;
  const subLabel = subDef ? { en: subDef.label_zh, zh: subDef.label_en } : null;

  return `
    <div class="step-eyebrow">${stepLabel()}</div>
    <div class="step-title">订单信息<span class="zh">Order Information</span></div>
    <div class="card">
      ${state.autoFilledForPo || state.factoryCode || state.productRisk !== 'medium' ? `<div class="section-help" style="margin-bottom:10px; color:var(--jc-teal-dark);">${escapeHtml(bi('prefilledFromPoNotice').en)}<br/>${escapeHtml(bi('prefilledFromPoNotice').zh)}</div>` : ''}
      <div class="review-row"><span class="k">类别 / Category</span><span class="v">${escapeHtml(catLabel.en)} ${escapeHtml(catLabel.zh)}</span></div>
      ${subLabel ? `<div class="review-row"><span class="k">类型 / Type</span><span class="v">${escapeHtml(subLabel.en)} ${escapeHtml(subLabel.zh)}</span></div>` : ''}
      <div class="review-row"><span class="k">${escapeHtml(bi('poNumber').en)}</span><span class="v">${escapeHtml(state.poNumber)}</span></div>
      <div class="review-row"><span class="k">${escapeHtml(bi('productSku').en)}</span><span class="v">${escapeHtml(state.sku)}</span></div>
      ${state.productTitle ? `<div class="review-row"><span class="k">${escapeHtml(bi('productTitle').en)}</span><span class="v">${escapeHtml(state.productTitle)}</span></div>` : ''}
      <!-- Supplier/factory code removed: it belongs to the purchase order,
           and asking QA to re-enter it here invited it drifting out of step
           with the PO. It's still carried on the report via the PO. -->
      <!-- Creator, PO Quantity and Product Complexity/Risk all come from the
           purchase order, so they read as prefilled review rows rather than
           inputs - same treatment as Category/SKU/Title above. Change them on
           the PO, not here, so the report can't drift out of step with it.

           Each one falls back to its original editable control if the PO
           didn't supply a usable value, so a PO with a missing creator or
           quantity can still be completed instead of dead-ending. PO Quantity
           is validated as required and >= 2, so without that fallback a blank
           one would be an unfixable error. -->
      ${creatorIsPrefilled()
        ? `<div class="review-row"><span class="k">${escapeHtml(bi('creator').en)}</span><span class="v">${escapeHtml(state.creator)}</span></div>`
        : ''}
      ${poQuantityIsPrefilled()
        ? `<div class="review-row"><span class="k">${escapeHtml(bi('poQuantity').en)}</span><span class="v">${escapeHtml(formatQty(state.poQuantity))}</span></div>`
        : ''}
      <div class="review-row"><span class="k">${escapeHtml(bi('productRisk', 'Product Complexity/Risk').en)}</span><span class="v">${escapeHtml(riskLabel(state.productRisk))}</span></div>

      <!-- Everything below this line is editable. Keeping the fallback inputs
           down here with the date - rather than inline where their read-only
           row would have gone - means the card always reads as one block of
           prefilled rows followed by one block of inputs, instead of an input
           sandwiched between two grey rows. -->
      ${creatorIsPrefilled() ? '' : `<div class="field-row"><div style="flex:1">${selectFieldWithOther('creator', 'creator', state.creator, OPTIONS.creators || [], {})}</div></div>`}
      ${poQuantityIsPrefilled() ? '' : numberField('poQuantity', 'poQuantity', state.poQuantity, { required: true, placeholderKey: 'poQuantityPlaceholder' })}

      <!-- Date stays editable (the inspection date is genuinely a property of
           this inspection, not of the PO) but sits last so the block reads as
           a run of prefilled rows followed by the one thing QA sets here. -->
      <div class="field-row">
        <div style="flex:1">${dateField('date', 'date', state.date, { required: true })}</div>
      </div>
    </div>

    <div class="card">
      <div class="section-title">${biBlockHtml('freshEntrySection', 'For This Inspection')}</div>
      ${selectFieldWithOther('qaLead', 'qaLead', state.qaLead, OPTIONS.qaLeads || [], { required: true })}
    </div>

    <div id="aqlSection">${renderAqlSection()}</div>

    <div class="nav-buttons">
      <button class="btn btn-secondary" id="btnBack">${biBlockHtml('back', 'Back')}</button>
      <button class="btn btn-secondary" id="btnSaveDraft">${biBlockHtml('saveAndClose', 'Save')}</button>
      <button class="btn btn-primary" id="btnNext">${biBlockHtml('next', 'Next')}</button>
    </div>
  `;
}

function approvalStatusLabelKey(status) {
  if (status === 'minorIssue') return 'statusMinorIssue';
  if (status === 'majorCriticalIssue') return 'statusMajorCriticalIssue';
  if (status === 'approved') return 'statusApproved';
  if (status === 'approvedWithComments') return 'statusApprovedWithComments';
  return 'statusGeneral';
}
function approvalStatusColorClass(status) {
  if (status === 'minorIssue') return 'comment-minor';
  if (status === 'majorCriticalIssue') return 'comment-major';
  if (status === 'approved') return 'comment-approved';
  if (status === 'approvedWithComments') return 'comment-approved';
  return 'comment-general';
}

function renderPdNotesSection() {
  if (!state.pdNotes || !state.pdNotes.length) return '';
  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('pdNotesTitle', 'Notes from Product Development')}</div>
      ${state.pdNotes.map((n) => `
        <div class="defect-card comment-card ${approvalStatusColorClass(n.approvalStatus)}">
          <div class="prior-issue-header">
            ${n.text ? `<span class="prior-issue-desc">${escapeHtml(n.text)}</span>` : `<span class="prior-issue-desc" style="font-style:italic; color:var(--jc-muted);">${escapeHtml(bi('noCommentTextProvided').en)}<span class="zh">${escapeHtml(bi('noCommentTextProvided').zh)}</span></span>`}
            <span class="severity-badge comment-badge-${approvalStatusColorClass(n.approvalStatus)}">${escapeHtml(bi(approvalStatusLabelKey(n.approvalStatus)).en)} ${escapeHtml(bi(approvalStatusLabelKey(n.approvalStatus)).zh)}</span>
          </div>
          <div class="section-help">${escapeHtml(n.author)} · ${new Date(n.timestamp).toLocaleDateString()}</div>
          ${(n.photos || []).map((url) => `<img src="${escapeHtml(url)}" class="prior-issue-photo" />`).join('')}
        </div>
      `).join('')}
    </div>
  `;
}

function renderAqlSection() {
  if (state.qaType === 'pre_production') {
    return `
      <div class="card">
        <div class="section-title">${biBlockHtml('quantityCheckedTitle', 'Quantity Checked')}</div>
        <div class="section-help">${escapeHtml(bi('preProductionQuantityHelp').en)}<br/>${escapeHtml(bi('preProductionQuantityHelp').zh)}</div>
        <div class="field">
          <input type="number" min="1" step="1" inputmode="numeric" id="preProductionUnitsCheckedInput" value="${escapeHtml(state.preProductionUnitsChecked)}" placeholder="${escapeHtml(bi('actualUnitsCheckedPlaceholder').en)}" />
        </div>
      </div>
    `;
  }

  syncInspectionLevelToRecommendation();
  const rec = getAqlRecommendation();

  let recBlock;
  if (rec && !rec.unavailable) {
    const range = pointCheckRangeToUnits(rec.pointCheck, state.poQuantity);
    recBlock = `
      <div class="aql-preview">
        <div class="aql-preview-row"><span>${escapeHtml(bi('creatorTierLabel').en)} <span class="zh">${escapeHtml(bi('creatorTierLabel').zh)}</span></span><strong>Tier ${rec.tier}</strong></div>
        <div class="aql-preview-row"><span>${escapeHtml(bi('orderValue').en)} <span class="zh">${escapeHtml(bi('orderValue').zh)}</span></span><strong>$${rec.orderValue.toLocaleString()}</strong></div>
        <div class="aql-preview-row"><span>${escapeHtml(bi('recommendedQuantityRange').en)} <span class="zh">${escapeHtml(bi('recommendedQuantityRange').zh)}</span></span><strong>${range ? `${range[0].toLocaleString()} - ${range[1].toLocaleString()}` : '-'} (${escapeHtml(rec.pointCheck)})</strong></div>
      </div>
    `;
  } else {
    // Say WHICH input is missing rather than a generic "need more info" -
    // otherwise there's no way to know whether to fix the PO or report a bug.
    const msg = aqlUnavailableMessage(rec && rec.reason);
    recBlock = `<div class="section-help" style="margin-top:8px;">${escapeHtml(msg.en)}<br/>${escapeHtml(msg.zh)}</div>`;
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
  return `
    ${computedPercent !== null ? `<div class="section-help" style="margin-top:6px;">≈ <strong>${computedPercent}%</strong> ${escapeHtml(bi('computedPercentOfPo').en)} <span class="zh">${escapeHtml(bi('computedPercentOfPo').zh)}</span></div>` : ''}
  `;
}

/** Critical/Major/Minor table showing Found vs Accepted (no Accept/Reject thresholds -
 *  Major/Critical finds are simply rejected on a per-unit basis; Minor finds stay
 *  accepted, since minor issues don't make a unit unsaleable). */
/* How many units were actually looked at. Bulk reports record it explicitly;
 * a pre-production report checks the sample it was sent. */
function unitsCheckedForRecap() {
  const n = parseInt(state.qaType === 'production' ? state.actualUnitsChecked : state.preProductionUnitsChecked, 10);
  return isNaN(n) || n < 1 ? null : n;
}

/**
 * Scale a defect count found in the sample up to the whole PO.
 *
 * Finding 10 bad units in a 100-unit sample of a 1,000-unit PO means 10% of
 * what was checked, so the working assumption is 10% of the PO - about 100
 * units. It's an estimate from a sample, not a count, which is why the recap
 * labels it an assumption and shows the percentage it came from.
 */
function extrapolate(foundUnits, checked, poQuantity) {
  if (!checked || !poQuantity || foundUnits === null || foundUnits === undefined) return null;
  const pct = (foundUnits / checked) * 100;
  return {
    found: foundUnits,
    pct,
    // Never claim more affected units than the PO contains, which a small
    // sample with a high defect rate could otherwise produce after rounding.
    assumed: Math.min(poQuantity, Math.round((foundUnits / checked) * poQuantity))
  };
}

function fmtPct(pct) {
  if (pct === null || pct === undefined || isNaN(pct)) return '-';
  return (pct >= 10 || pct === 0 ? Math.round(pct) : Math.round(pct * 10) / 10) + '%';
}

function foundAcceptedTableHtml(aql) {
  const checked = unitsCheckedForRecap();
  const poQty = parseInt(state.poQuantity, 10) || null;

  const counts = (aql && aql.counts) || countDefects(collectAllDefects(), checked);

  const row = (labelKey, sev, accepted) => {
    const c = counts[sev] || { entries: 0, units: 0, defectiveUnits: 0 };
    /* Rates are based on defectiveUnits, not the raw sum. Two issues each
     * affecting all 5 checked units is 5 bad units out of 5, not 10 out of 5 -
     * and a 200% defect rate would extrapolate to nonsense. */
    const ex = extrapolate(c.defectiveUnits, checked, poQty);
    return `
      <tr>
        <td>${escapeHtml(bi(labelKey).en)}</td>
        <td>${c.entries}</td>
        <td>${c.defectiveUnits}${c.units > c.defectiveUnits
            ? ` <span class="recap-pct">${escapeHtml(bi('ofUnitsLogged', 'from {n} logged').en.replace('{n}', String(c.units)))}</span>`
            : ''}${ex ? ` <span class="recap-pct">${escapeHtml(fmtPct(ex.pct))}</span>` : ''}</td>
        <td>${ex ? `${ex.assumed} <span class="recap-pct">${escapeHtml(fmtPct(ex.pct))}</span>` : '-'}</td>
        <td>${accepted}</td>
      </tr>
    `;
  };

  return `
    <table class="aql-preview-table" style="margin-top:10px;">
      <thead>
        <tr>
          <th></th>
          <th>${escapeHtml(bi('issuesLoggedLabel', 'Issues').en)}</th>
          <th>${escapeHtml(bi('unitsAffectedHeader', 'Units affected').en)}</th>
          <th>${escapeHtml(bi('totalPoAssumption', 'Total PO assumption').en)}</th>
          <th>${escapeHtml(bi('acceptedLabel').en)}</th>
        </tr>
      </thead>
      <tbody>
        ${row('aqlCritical', 'critical', 0)}
        ${row('aqlMajor', 'major', 0)}
        ${row('aqlMinor', 'minor', counts.minor.defectiveUnits)}
      </tbody>
    </table>
    ${checked && poQty ? `
      <div class="section-help" style="margin-top:8px;">
        ${escapeHtml(bi('recapBasisNote', 'Assumption scales what was found in the sample across the whole PO.').en)}
        ${checked} / ${poQty} ${escapeHtml(bi('recapChecked', 'checked').en)} (${escapeHtml(fmtPct((checked / poQty) * 100))}).
      </div>
    ` : `
      <div class="section-help" style="margin-top:8px;">
        ${escapeHtml(bi('recapNeedsCounts', 'Enter the PO quantity and the units checked to see the whole-PO assumption.').en)}
      </div>
    `}
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
      <input type="text" data-bind="${id}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(ph.en)}" />
    </div>
  `;
}
function numberField(id, i18nKey, value, opts = {}) {
  const l = bi(i18nKey);
  const ph = opts.placeholderKey ? bi(opts.placeholderKey) : { en: '', zh: '' };
  return `
    <div class="field" data-field="${id}">
      <label class="field-label">${escapeHtml(l.en)} <span class="zh">${escapeHtml(l.zh)}</span>${opts.required ? '<span class="required">*</span>' : ''}</label>
      <input type="number" min="2" step="1" inputmode="numeric" data-bind-live="${id}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(ph.en)}" />
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
        <option value="">${escapeHtml(ph.en)}</option>
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
        <option value="">${escapeHtml(ph.en)}</option>
        ${opts_html}
        <option value="${OTHER_VALUE}" ${isOther ? 'selected' : ''}>${escapeHtml(otherLabel.en)}</option>
      </select>
      ${isOther ? `<input type="text" data-other-text="${id}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(otherPh.en)}" style="margin-top:8px;" />` : ''}
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
/* ============================================================
 * Step 5: Inspection Details (config-driven)
 * ============================================================
 * Questions come from config/reportQuestions.json, chosen by the product's
 * subcategory (falling back to its category), so a plush report asks plush
 * questions and a poster report asks poster ones.
 *
 * Every question is Pass / Fail / N-A. A Fail always needs the quantity
 * affected and a photo or video - severity is no longer chosen by the
 * inspector, it's derived from the step: a Step 5 fail is MAJOR.
 *
 * Anything Chloe ticked in Setup Report Link is appended as an Additional
 * Review section at the bottom. */

/** The question group matching this product. Subcategory wins; a group with an
 *  empty subcategory list covers its whole category (Bags, Other). */
function questionGroupForProduct() {
  const groups = ((CONFIG.reportQuestions || {}).groups) || {};
  const bySub = Object.values(groups).find((g) =>
    g.category === state.category && (g.subcategories || []).includes(state.subcategory));
  if (bySub) return bySub;
  return Object.values(groups).find((g) =>
    g.category === state.category && !(g.subcategories || []).length) || null;
}

/** Questions with section/title/guidance already resolved to the header
 *  language. Falls back to English if a translation is blank, so a question
 *  added to the config without Chinese still renders rather than vanishing. */
function questionsForStep(stepNumber) {
  const g = questionGroupForProduct();
  const raw = (g && g.steps && g.steps[String(stepNumber)]) || [];
  const en = currentLangIsEn();
  const pick = (e, zh) => (en ? (e || zh) : (zh || e)) || '';
  return raw.map((q) => ({
    ...q,
    section: pick(q.section, q.section_zh),
    title: pick(q.title, q.title_zh),
    guidance: pick(q.guidance, q.guidance_zh)
  }));
}

/** Lazily created so a question added to the config later needs no migration. */
function answerFor(id) {
  if (!state.answers[id]) state.answers[id] = { status: '', unitsAffected: '', media: [] };
  return state.answers[id];
}

/** The extra questions Chloe ticked at PO setup, flattened into one list.
 *  Conditional checks are Pass/Fail with no N-A - a trigger is only ticked
 *  when the feature is actually present, so "not applicable" can't arise. */
function additionalReviewQuestions() {
  const setup = state.qaSetup;
  if (!setup) return [];
  const defs = (((CONFIG.conditionalChecks || {}).byCategory) || {})[state.category] || [];
  const out = [];
  (setup.checks || []).forEach((triggerKey) => {
    const trigger = defs.find((t) => t.key === triggerKey);
    if (!trigger) return;
    trigger.questions.forEach((q) => out.push({
      id: `cond.${triggerKey}.${q.key}`,
      section: currentLangIsEn() ? trigger.label_en : (trigger.label_zh || trigger.label_en),
      title: currentLangIsEn() ? q.text_en : (q.text_zh || q.text_en),
      guidance: '',
      answer: 'passFail',
      media: q.media
    }));
  });
  (setup.custom || []).forEach((c) => out.push({
    id: `custom.${c.id}`,
    section: bi('sectionCustomQuestions', 'Custom questions').en,
    title: c.text,
    guidance: '',
    answer: 'passFail',
    // A custom question can demand a photo, a video, or neither - in which
    // case a fail still needs evidence like every other question.
    media: c.requireVideo ? 'video_always' : (c.requirePhoto ? 'photo_always' : 'on_fail')
  }));
  return out;
}

function currentLangIsEn() {
  return ((window.JuniperLang && window.JuniperLang.get && window.JuniperLang.get()) || 'zh') === 'en';
}

/** What evidence this question needs right now, given its answer. */
function mediaRequirementFor(q, status) {
  if (q.media === 'photo_always') return { required: true, label: bi('mediaPhotoRequired', 'Photo required').en };
  if (q.media === 'video_always') return { required: true, label: bi('mediaVideoRequired', 'Video required').en };
  if (q.media === 'on_fail' && status === 'fail') {
    return { required: true, label: bi('mediaOnFailRequired', 'Photo or video of the defect required').en };
  }
  return { required: false, label: '' };
}

/** The Golden Sample photo this question should be judged against.
 *
 *  Pulled from the PD approval rather than the artwork file on the PO: the
 *  approval photo is the physical item someone signed off, which is what the
 *  factory is actually expected to reproduce. Returns null when PD hasn't
 *  submitted a sample approval, or hasn't filled that slot. */
function referencePhotoFor(q) {
  if (!q.reference) return null;
  const sample = (state.approvalReferencePhotos && state.approvalReferencePhotos.sample) || {};
  const urls = sample[q.reference];
  return urls && urls.length ? urls[0] : null;
}

function renderQuestionCard(q) {
  const a = answerFor(q.id);
  const options = q.answer === 'passFail' ? ['pass', 'fail'] : ['pass', 'fail', 'na'];
  const media = mediaRequirementFor(q, a.status);
  const showMedia = media.required || (a.media && a.media.length);

  return `
    <div class="checklist-row q-row ${a.status === 'fail' ? 'q-row-fail' : ''}" data-question="${escapeHtml(q.id)}">
      <div class="checklist-question">${escapeHtml(q.title)}</div>
      ${q.guidance ? `<div class="q-guidance">${escapeHtml(q.guidance)}</div>` : ''}
      ${(() => {
        const ref = referencePhotoFor(q);
        if (!ref) return '';
        return `
          <div class="q-reference">
            <div class="q-reference-label">${escapeHtml(bi('approvedReferenceLabel', 'Approved sample').en)}</div>
            <div class="q-reference-frame"><img src="${escapeHtml(ref)}" class="js-lightbox" alt="" /></div>
          </div>
        `;
      })()}
      <div class="segmented">
        ${options.map((s) => {
          const sl = bi(s);
          const sel = a.status === s ? 'selected status-' + s : '';
          return `<div class="segmented-option ${sel}" data-q-status="${escapeHtml(q.id)}" data-val="${s}">${escapeHtml(sl.en)}</div>`;
        }).join('')}
      </div>
      ${a.status === 'fail' ? `
        <div class="q-fail-block">
          <label class="field-label">${escapeHtml(bi('unitsAffectedLabel', 'How many units failed?').en)}<span class="required">*</span></label>
          <input type="number" min="1" class="input" data-q-units="${escapeHtml(q.id)}"
            value="${escapeHtml(String(a.unitsAffected || ''))}"
            placeholder="${escapeHtml(bi('unitsAffectedPlaceholder', 'e.g. 3').en)}" />
        </div>
      ` : ''}
      ${showMedia ? `
        <div class="q-media-block">
          <div class="section-photos-label">
            ${escapeHtml(bi('evidenceLabel', 'Evidence').en)}
            ${media.required ? `<span class="required">*</span> <span class="q-media-hint">${escapeHtml(media.label)}</span>` : ''}
          </div>
          ${photoGrid('q:' + q.id, true)}
        </div>
      ` : ''}
    </div>
  `;
}

/** Groups consecutive questions under their section heading. */
function renderQuestionSections(questions) {
  const sections = [];
  questions.forEach((q) => {
    const last = sections[sections.length - 1];
    if (last && last.name === q.section) last.items.push(q);
    else sections.push({ name: q.section, items: [q] });
  });
  return sections.map((sec) => `
    <div class="card">
      <div class="section-title">${escapeHtml(sec.name)}</div>
      ${sec.items.map(renderQuestionCard).join('')}
    </div>
  `).join('');
}

function renderInspectionDetailsStep() {
  const questions = questionsForStep(5);
  const extras = additionalReviewQuestions();

  let body = '';
  if (!questions.length) {
    body += `<div class="card"><div class="section-help">${escapeHtml(bi('noQuestionsForProduct', 'No inspection questions are configured for this product type yet.').en)}</div></div>`;
  } else {
    body += renderQuestionSections(questions);
  }

  if (extras.length) {
    body += `
      <div class="step-subhead">${escapeHtml(bi('titleAdditionalReview', 'Additional Review').en)}</div>
      <div class="section-help" style="margin:-6px 0 10px;">${escapeHtml(bi('helpAdditionalReview', 'Set up for this PO because the product includes these features.').en)}</div>
      ${renderQuestionSections(extras)}
    `;
  }

  return `
    <div class="step-eyebrow">${stepLabel()}</div>
    <div class="step-title">检验详情<span class="zh">Inspection Details</span></div>
    ${body}
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="btnBack">${biBlockHtml('back', 'Back')}</button>
      <button class="btn btn-secondary" id="btnSaveDraft">${biBlockHtml('saveAndClose', 'Save')}</button>
      <button class="btn btn-primary" id="btnNext">${biBlockHtml('next', 'Next')}</button>
    </div>
  `;
}

/** Every question answered; a fail needs a quantity; required evidence present. */
function inspectionStepProblems() {
  const all = questionsForStep(5).concat(additionalReviewQuestions());
  const problems = [];
  all.forEach((q) => {
    const a = answerFor(q.id);
    if (!a.status) { problems.push({ id: q.id, why: 'status' }); return; }
    if (a.status === 'fail' && !(parseInt(a.unitsAffected, 10) > 0)) problems.push({ id: q.id, why: 'units' });
    if (mediaRequirementFor(q, a.status).required && !(a.media && a.media.length)) {
      problems.push({ id: q.id, why: 'media' });
    }
  });
  return problems;
}

function attachInspectionHandlers() {
  document.querySelectorAll('[data-q-status]').forEach((el) => {
    el.addEventListener('click', () => {
      const a = answerFor(el.dataset.qStatus);
      a.status = el.dataset.val;
      // Clearing a fail's quantity keeps a stale number from being submitted
      // if the inspector changes their mind back to pass.
      if (a.status !== 'fail') a.unitsAffected = '';
      render();
    });
  });
  document.querySelectorAll('[data-q-units]').forEach((el) => {
    el.addEventListener('input', () => { answerFor(el.dataset.qUnits).unitsAffected = el.value; });
  });
}

/* Restored: still used by the Sizing step's custom-sizing checklist and by
 * the Step 6 additional-issues list. Step 5 no longer uses these - it renders
 * from config/reportQuestions.json instead. */
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
        <textarea data-checklist-notes="${key}" placeholder="${escapeHtml(bi('notesPlaceholder').en)}">${escapeHtml(entry.notes)}</textarea>
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
        <textarea data-defect-field="description" data-defect-id="${d.id}" placeholder="${escapeHtml(bi('defectDescriptionPlaceholder').en)}">${escapeHtml(d.description)}</textarea>
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
      <button type="button" class="remove-defect-btn" data-remove-defect="${d.id}">${escapeHtml(bi('removeIssue').en)}</button>
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
          <div class="section-help" style="margin-bottom:6px;">${escapeHtml(bi('sectionPhotosHelp').en)}</div>
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

function renderApprovalSizingReferenceTile() {
  if (!state.approvalSizingData) return '';
  const d = state.approvalSizingData;
  let content = '';
  if (d.fit) {
    const fitDef = CONFIG.fits && CONFIG.fits.fits && CONFIG.fits.fits[d.fit];
    content = fitDef ? `${fitDef.label_zh} ${fitDef.label_en}` : d.fit;
  } else if (d.dimensions && (d.dimensions.height || d.dimensions.width || d.dimensions.depth)) {
    const dim = d.dimensions;
    content = `${dim.height || '-'} x ${dim.width || '-'} x ${dim.depth || '-'} cm (${bi('dimensionHeight').en}/${bi('dimensionWidth').en}/${bi('dimensionDepth').en})`;
    if (dim.notes && dim.notes.trim()) content += ` — ${dim.notes}`;
  } else if (d.simpleSizeValue) {
    content = d.simpleSizeValue;
  } else if (d.notes) {
    content = d.notes;
  }
  if (!content) return '';
  return `
    <div class="card" style="background:var(--jc-mint-light); border-color:var(--jc-teal);">
      <div class="section-title">${biBlockHtml('approvalSizingReferenceTitle', 'Sizing (from QA/QC Approval)')}</div>
      <div class="section-help" style="color:var(--jc-text);">${escapeHtml(content)}</div>
    </div>
  `;
}

/** Shown when the PO carries no Product Dimensions table for an apparel order. */
function renderMissingSizingWarning() {
  return `
    <div class="card" style="background:var(--jc-warn-bg); border-color:#F0D9A8;">
      <div class="section-title" style="color:var(--jc-warn);">${escapeHtml(bi('noSizingTableTitle', 'No sizing reference on this PO').en)}</div>
      <div class="section-help" style="color:var(--jc-warn);">
        ${escapeHtml(bi('noSizingTableBody', 'No Golden Sample sizing table reference has been entered for this purchase order, so there is nothing to measure against. The right fix is to add it under Product Dimensions in Order Management - it then flows through to every report on this PO.').en)}
      </div>
      <div class="section-help" style="color:var(--jc-warn); margin-top:8px;">
        ${escapeHtml(bi('noSizingTableFallback', 'If the inspection cannot wait, you can enter a chart by hand for this report only. It will not be saved back to the PO.').en)}
      </div>
      <button type="button" class="btn btn-secondary" id="btnEnterSizingManually" style="width:auto;padding:9px 16px;margin-top:12px;">
        ${escapeHtml(bi('btnEnterSizingManually', 'Enter manually').en)}
      </button>
    </div>
  `;
}

/** Reminder that what follows is a one-off, not the PO's approved chart. */
function renderManualSizingNotice() {
  return `
    <div class="card" style="background:var(--jc-warn-bg); border-color:#F0D9A8; padding:12px 16px;">
      <div class="section-help" style="color:var(--jc-warn); margin:0;">
        ${escapeHtml(bi('manualSizingNotice', 'Entered by hand for this report only - the PO has no sizing table. Add one in Order Management so future reports do not need this.').en)}
      </div>
    </div>
  `;
}

/* ---- Completed report gate ----
 * A report link is now one report. Once submitted, reopening the link lands
 * here rather than starting a fresh wizard - the previous behaviour let anyone
 * quietly file a second report against the same stage. */
function renderCompletedReportGate() {
  const r = state.completedReport || {};
  const resultLabel = r.result === 'pass' ? bi('resultPass').en : bi('resultFail').en;
  const when = r.submittedAt ? new Date(r.submittedAt).toLocaleDateString() : '';
  return `
    <div class="step-title">${escapeHtml(bi('reportAlreadySubmitted', 'This report is complete').en)}</div>
    <div class="card">
      <div class="review-row"><span class="k">${escapeHtml(bi('poNumberLabel', 'Purchase Order Number').en)}</span><span class="v">${escapeHtml(state.poNumber || '')}</span></div>
      <div class="review-row"><span class="k">${escapeHtml(bi('overallResultLabel', 'Overall Result').en)}</span><span class="v">${escapeHtml(resultLabel)}</span></div>
      ${when ? `<div class="review-row"><span class="k">${escapeHtml(bi('submittedOn', 'Submitted').en)}</span><span class="v">${escapeHtml(when)}</span></div>` : ''}
    </div>
    <div class="card">
      <div class="section-help">${escapeHtml(bi('completedGateHelp', 'Open the finished report, confirm that flagged units have since been repaired, or start a separate additional report.').en)}</div>
      <div style="display:flex; flex-direction:column; gap:10px; margin-top:12px;">
        ${r.pdfUrl ? `<a class="btn btn-primary" href="${escapeHtml(r.pdfUrl)}" target="_blank" rel="noopener" style="text-decoration:none; text-align:center;">${escapeHtml(bi('btnViewReport', 'View Report').en)}</a>` : ''}
        <button type="button" class="btn btn-secondary" id="btnRevisedReport">${escapeHtml(bi('btnRevisedUnitReport', 'Add Revised Unit Report').en)}</button>
        <button type="button" class="btn btn-secondary" id="btnAdditionalReport">${escapeHtml(bi('btnAdditionalReport', 'Add Additional Report').en)}</button>
      </div>
    </div>
  `;
}

/* ---- Revised Unit Report ----
 * A lightweight follow-up: one tile per issue the original report flagged, and
 * the inspector records how many of those units have since been repaired, with
 * a photo. Deliberately not a second full report - nothing else is re-checked. */
function renderRevisedUnitReport() {
  if (!state.revisedIssues.length) {
    return `
      <div class="step-title">${escapeHtml(bi('btnRevisedUnitReport', 'Add Revised Unit Report').en)}</div>
      <div class="card"><div class="section-help">${escapeHtml(bi('noFlaggedUnits', 'The original report flagged no defective units, so there is nothing to confirm here.').en)}</div></div>
      <div class="nav-buttons"><button class="btn btn-secondary" id="btnBackToGate">${escapeHtml(bi('back', 'Back').en)}</button></div>
    `;
  }
  const tiles = state.revisedIssues.map((iss, idx) => {
    const done = iss.confirmed;
    return `
      <div class="card ${done ? 'revised-done' : ''}" data-revised-idx="${idx}">
        <div class="section-title">${escapeHtml(iss.description || bi('issueLabel', 'Issue').en)}</div>
        <div class="review-row"><span class="k">${escapeHtml(bi('severityLabel', 'Severity').en)}</span><span class="v">${escapeHtml(bi('aql' + (iss.severity || 'minor').charAt(0).toUpperCase() + (iss.severity || 'minor').slice(1)).en)}</span></div>
        <div class="review-row"><span class="k">${escapeHtml(bi('unitsFlaggedLabel', 'Units flagged').en)}</span><span class="v">${iss.unitsAffected}</span></div>
        ${(iss.photos || []).length ? `<div class="q-reference"><div class="q-reference-label">${escapeHtml(bi('originalEvidence', 'From the original report').en)}</div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">${iss.photos.map((u) => `<div class="q-reference-frame"><img src="${escapeHtml(u)}" class="js-lightbox" alt="" /></div>`).join('')}</div></div>` : ''}
        ${done ? `
          <div class="no-issues-note">${escapeHtml(bi('unitsConfirmedFixed', 'Confirmed repaired').en)}: ${iss.unitsFixed} / ${iss.unitsAffected}</div>
          <button type="button" class="section-clean-btn is-on" data-revised-undo="${idx}">${escapeHtml(bi('undo', 'Undo').en)}</button>
        ` : `
          <div class="field">
            <label class="field-label">${escapeHtml(bi('unitsFixedLabel', 'How many of these units have been repaired?').en)}<span class="required">*</span></label>
            <input type="number" min="1" max="${iss.unitsAffected}" class="input" data-revised-qty="${idx}" value="${escapeHtml(String(iss.unitsFixed || ''))}" />
          </div>
          <div class="q-media-block">
            <div class="section-photos-label">${escapeHtml(bi('evidenceLabel', 'Evidence').en)}<span class="required">*</span>
              <span class="q-media-hint">${escapeHtml(bi('mediaOnFailRequired', 'Photo or video of the defect required').en)}</span></div>
            ${photoGrid('revised:' + idx, true)}
          </div>
          <button type="button" class="btn btn-secondary" data-revised-confirm="${idx}" style="width:auto;padding:9px 16px;margin-top:10px;">
            ${escapeHtml(bi('btnConfirmFixed', 'Confirm repaired').en)}
          </button>
        `}
      </div>
    `;
  }).join('');

  const allDone = state.revisedIssues.every((i) => i.confirmed);
  return `
    <div class="step-title">${escapeHtml(bi('btnRevisedUnitReport', 'Add Revised Unit Report').en)}</div>
    <div class="section-help" style="margin-bottom:12px;">${escapeHtml(bi('revisedReportHelp', 'Confirm how many of the units flagged in the original report have been repaired. Every tile must be confirmed before this can be submitted.').en)}</div>
    ${tiles}
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="btnBackToGate">${escapeHtml(bi('back', 'Back').en)}</button>
      <button class="btn btn-primary" id="btnSubmitRevised" ${allDone ? '' : 'disabled'}>${escapeHtml(bi('btnSubmitRevised', 'Submit revised report').en)}</button>
    </div>
  `;
}

/* ============================================================
 * Disposition step: what happens to the defective units
 * ============================================================
 * Sits between Additional Issues and Review, and only appears when something
 * was actually flagged - a clean report goes straight to Review.
 *
 * For each issue the inspector chooses one of three outcomes. This is the
 * point of the step: it lets simple problems be fixed on the spot at the
 * factory instead of shipping units back, and it decides what the final
 * numbers are.
 *
 *   repaired  - fixed on site. Those units are good now, so they stop counting
 *               as defects. Requires a count (never more than were flagged)
 *               and a photo.
 *   factory   - the factory will fix them. They still count, and a Revised
 *               Unit Report is needed afterwards to confirm the repair.
 *   rejected  - not shipped. Excluded from the final quantity, so they stop
 *               counting too.
 *
 * Because repaired and rejected units leave the count, a report can legitimately
 * move from fail to pass here - which is exactly the intent for a batch whose
 * only problem was a handful of units that got pulled.
 */
const DISPOSITION_CHOICES = ['repaired', 'factory', 'rejected'];

function dispositionFor(id) {
  if (!state.dispositions[id]) {
    state.dispositions[id] = { choice: '', unitsRepaired: '', photos: [] };
  }
  return state.dispositions[id];
}

/** Every defect the inspector needs to decide about. */
function dispositionTargets() {
  return collectRawDefects().map((d) => ({
    id: d.id,
    description: d.description,
    severity: d.severity,
    unitsAffected: parseInt(d.unitsAffected, 10) || 1
  }));
}

/** Shared step chrome, so a new step doesn't have to restate it. */
function stepHeaderHtml(title) {
  return `<div class="step-eyebrow">${stepLabel()}</div>\n<div class="step-title">${escapeHtml(title)}</div>`;
}

function navButtonsHtml() {
  return `
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="btnBack">${biBlockHtml('back', 'Back')}</button>
      <button class="btn btn-secondary" id="btnSaveDraft">${biBlockHtml('saveAndClose', 'Save')}</button>
      <button class="btn btn-primary" id="btnNext">${biBlockHtml('next', 'Next')}</button>
    </div>
  `;
}

/* Defects as recorded, BEFORE any disposition is applied. The disposition step
 * needs the original numbers to ask about; collectAllDefects() below returns
 * what actually counts once those decisions are made. */
function collectRawDefects() {
  const all = [];
  questionsForStep(5).concat(additionalReviewQuestions()).forEach((q) => {
    const a = state.answers[q.id];
    if (!a || a.status !== 'fail') return;
    all.push({ id: q.id, description: q.title, severity: 'major',
      unitsAffected: parseInt(a.unitsAffected, 10) || 1, photos: a.media || [] });
  });
  allSectionIssues().forEach((d) => all.push(d));
  return all;
}

/**
 * Reduce a defect by whatever the inspector resolved.
 *
 * Repaired-on-site and rejected units stop being defects: the first because
 * they are now good, the second because they are not shipped. Factory-fix
 * units stay, and are what the Revised Unit Report later clears.
 */
function applyDisposition(defect) {
  const d = state.dispositions[defect.id];
  if (!d || !d.choice) return defect;
  const flagged = parseInt(defect.unitsAffected, 10) || 1;
  if (d.choice === 'rejected') return { ...defect, unitsAffected: 0, resolution: 'rejected' };
  if (d.choice === 'repaired') {
    const fixed = Math.min(flagged, parseInt(d.unitsRepaired, 10) || 0);
    return { ...defect, unitsAffected: Math.max(0, flagged - fixed), unitsRepaired: fixed, resolution: 'repaired' };
  }
  return { ...defect, resolution: 'factory' };
}

function renderDispositionStep() {
  const targets = dispositionTargets();

  if (!targets.length) {
    return `
      ${stepHeaderHtml(bi('dispositionTitle', 'Defective Units').en)}
      <div class="card">
        <div class="section-help">${escapeHtml(bi('noDefectsToResolve', 'No defects were flagged, so there is nothing to resolve. Continue to review and submit.').en)}</div>
      </div>
      ${navButtonsHtml()}
    `;
  }

  const tiles = targets.map((t) => {
    const d = dispositionFor(t.id);
    return `
      <div class="card" data-disposition="${escapeHtml(t.id)}">
        <div class="section-title">${escapeHtml(t.description || bi('issueLabel', 'Issue').en)}</div>
        <div class="review-row">
          <span class="k">${escapeHtml(bi('unitsFlaggedLabel', 'Units flagged').en)}</span>
          <span class="v">${t.unitsAffected}</span>
        </div>
        <div class="segmented" style="margin-top:10px;">
          ${DISPOSITION_CHOICES.map((c) => `
            <div class="segmented-option ${d.choice === c ? 'selected' : ''}"
              data-disposition-choice="${escapeHtml(t.id)}" data-val="${c}">
              ${escapeHtml(bi('disposition_' + c).en)}
            </div>
          `).join('')}
        </div>
        ${d.choice ? `<div class="q-guidance">${escapeHtml(bi('dispositionHelp_' + d.choice).en)}</div>` : ''}
        ${d.choice === 'repaired' ? `
          <div class="q-fail-block">
            <label class="field-label">${escapeHtml(bi('unitsRepairedLabel', 'How many were repaired on site?').en)}<span class="required">*</span></label>
            <input type="number" min="1" max="${t.unitsAffected}" class="input"
              data-disposition-qty="${escapeHtml(t.id)}" value="${escapeHtml(String(d.unitsRepaired || ''))}" />
          </div>
          <div class="q-media-block">
            <div class="section-photos-label">${escapeHtml(bi('evidenceLabel', 'Evidence').en)}<span class="required">*</span>
              <span class="q-media-hint">${escapeHtml(bi('repairEvidenceHint', 'Photo of the repaired units').en)}</span></div>
            ${photoGrid('disp:' + t.id, true)}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  return `
    ${stepHeaderHtml(bi('dispositionTitle', 'Defective Units').en)}
    <div class="section-help" style="margin-bottom:12px;">
      ${escapeHtml(bi('dispositionHelp', 'Decide what happens to each set of defective units. Repaired and rejected units come out of the final counts; units the factory will fix stay in and need a follow-up report.').en)}
    </div>
    ${tiles}
    ${navButtonsHtml()}
  `;
}

/** Every disposition answered, with a count and photo where repairs were claimed. */
function dispositionProblems() {
  const problems = [];
  dispositionTargets().forEach((t) => {
    const d = state.dispositions[t.id] || {};
    if (!d.choice) { problems.push({ id: t.id, why: 'choice' }); return; }
    if (d.choice !== 'repaired') return;
    const n = parseInt(d.unitsRepaired, 10);
    // Cannot repair more units than were flagged in the first place.
    if (!(n > 0) || n > t.unitsAffected) problems.push({ id: t.id, why: 'qty' });
    else if (!(d.photos || []).length) problems.push({ id: t.id, why: 'photo' });
  });
  return problems;
}

function attachDispositionHandlers() {
  document.querySelectorAll('[data-disposition-choice]').forEach((el) => {
    el.addEventListener('click', () => {
      const d = dispositionFor(el.dataset.dispositionChoice);
      d.choice = el.dataset.val;
      // A claim of on-site repair is meaningless once the choice changes.
      if (d.choice !== 'repaired') { d.unitsRepaired = ''; d.photos = []; }
      render();
    });
  });
  document.querySelectorAll('[data-disposition-qty]').forEach((el) => {
    el.addEventListener('input', () => {
      dispositionFor(el.dataset.dispositionQty).unitsRepaired = el.value;
    });
  });
}

/** Photo arrays for on-site repair evidence. */
function dispositionPhotoArray(id) {
  return dispositionFor(id).photos;
}

function renderSizingStep() {
  let body = '';
  body += renderApprovalSizingReferenceTile();
  if (state.category === 'apparel') {
    /* No sizing table on the PO and nobody has opted into entering one by
     * hand: say so plainly rather than quietly showing an empty fit picker.
     * A missing table means the PO itself is incomplete, and QA measuring
     * against a generic template instead of the order's own approved chart is
     * exactly the silent mismatch this whole chain exists to prevent. */
    if (!state.poDimensionsTable && !state.manualSizingOptIn && !state.categoryData.fit) {
      body += renderMissingSizingWarning();
      return sizingStepShell(body);
    }
    if (state.manualSizingOptIn && !state.poDimensionsTable) body += renderManualSizingNotice();
    body += renderFitPicker();
    if (state.categoryData.fit === OTHER_FIT_VALUE) {
      body += renderCustomSizeChart();
      body += checklistCard('sizingSection', [['generalSizingMatch', 'generalSizingMatch']], 'sizing');
    } else if (state.categoryData.fit) {
      body += renderReferenceChart();
      body += renderSizeEntryTable();
    }
  } else {
    body += renderToleranceGuidance();
    body += renderDimensionsFields();
  }
  // Only rendered where the category has a weight tolerance set, which today
  // means plush only.
  body += renderWeightField();

  return sizingStepShell(body);
}

/** Shared wrapper so the early return above renders the same chrome. */
function sizingStepShell(body) {
  return `
    <div class="step-eyebrow">${stepLabel()}</div>
    <div class="step-title">尺寸<span class="zh">Sizing</span></div>
    ${body}
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="btnBack">${biBlockHtml('back', 'Back')}</button>
      <button class="btn btn-secondary" id="btnSaveDraft">${biBlockHtml('saveAndClose', 'Save')}</button>
      <button class="btn btn-primary" id="btnNext">${biBlockHtml('next', 'Next')}</button>
    </div>
  `;
}
/** For apparel's "Other / Custom Sizing" option: a fillable chart with freeform
 *  size rows (name + measurement notes + a photo per size), plus a general photo
 *  slot for snapping a paper reference chart if that's faster than typing it out. */
function isSimplifiedCustomSizing(subcategory) {
  return subcategory === 'hat' || subcategory === 'socks';
}

/** The sizing tolerance for this product's category, from Settings. */
function sizingToleranceCm() {
  const cats = (CONFIG.tolerances && CONFIG.tolerances.categories) || {};
  const t = cats[state.category];
  const n = t ? parseFloat(t.sizingCm) : NaN;
  return isNaN(n) ? null : n;
}

/** The approved dimension for one axis, taken from the Golden Sample sizing
 *  carried over on the PO. Null when nothing was approved to compare against. */
function approvedDimension(key) {
  const d = state.approvalSizingData && state.approvalSizingData.dimensions;
  if (!d) return null;
  const n = parseFloat(d[key]);
  return isNaN(n) ? null : n;
}

/**
 * Whether a measured dimension is outside tolerance.
 *
 * Non-apparel sizing was previously recorded but never scored, which is why an
 * out-of-tolerance box passed silently while an out-of-tolerance garment
 * failed. It now uses the same rule as apparel size rows, against the
 * per-category tolerance in Settings rather than the apparel figure.
 */
function dimensionOutOfTolerance(key) {
  const tol = sizingToleranceCm();
  const std = approvedDimension(key);
  if (tol === null || std === null) return false; // nothing to compare against
  const raw = state.categoryData.dimensions[key];
  if (raw === '' || raw === null || raw === undefined) return false; // empty is a separate error
  const measured = parseFloat(raw);
  if (isNaN(measured)) return false;
  return Math.abs(measured - std) > tol;
}

function anyDimensionOutOfTolerance() {
  return ['height', 'width', 'depth'].some(dimensionOutOfTolerance);
}

/** Repaint one measurement's out-of-tolerance flag in place.
 *
 *  A full render() on every keystroke would tear the input out of the DOM and
 *  drop focus mid-number, so only the affected field's wrapper and its
 *  "Approved: ..." line are touched. */
function refreshToleranceFlag(key) {
  const isWeight = key === 'weight';
  const input = isWeight
    ? document.getElementById('productWeightInput')
    : document.querySelector(`[data-dimension="${key}"]`);
  if (!input) return;
  const bad = isWeight ? weightOutOfTolerance() : dimensionOutOfTolerance(key);

  const field = input.closest('.field');
  if (field) field.classList.toggle('has-error', bad);

  const standard = document.querySelector(`[data-dim-standard="${key}"]`);
  if (!standard) return;
  standard.classList.toggle('dim-standard-fail', bad);
  const flag = standard.querySelector('[data-dim-flag]');
  if (flag) flag.textContent = bad ? ` \u2014 ${bi('outOfToleranceShort', 'out of tolerance').en}` : '';
}

/** Weight tolerance for this category, from Settings. Only plush has one, so
 *  this returns null everywhere else and the weight field isn't rendered. */
function weightToleranceG() {
  const cats = (CONFIG.tolerances && CONFIG.tolerances.categories) || {};
  const t = cats[state.category];
  const n = t ? parseFloat(t.weightG) : NaN;
  return isNaN(n) ? null : n;
}

/** Approved finished weight from the PO's Product Documentation. */
function approvedWeightG() {
  const n = parseFloat(state.poWeightG);
  return isNaN(n) ? null : n;
}

function weightOutOfTolerance() {
  const tol = weightToleranceG();
  const std = approvedWeightG();
  if (tol === null || std === null) return false;
  const raw = state.productWeightG;
  if (raw === '' || raw === null || raw === undefined) return false;
  const measured = parseFloat(raw);
  if (isNaN(measured)) return false;
  return Math.abs(measured - std) > tol;
}

/** Weighed on the Sizing step, and only where a weight tolerance is set. */
function renderWeightField() {
  const tol = weightToleranceG();
  if (tol === null) return '';
  const std = approvedWeightG();
  const bad = weightOutOfTolerance();
  return `
    <div class="card">
      <div class="section-title">${escapeHtml(bi('productWeightLabel', 'Product weight').en)}</div>
      <div class="section-help">${escapeHtml(bi('productWeightHelp', 'Weigh a finished unit on a calibrated scale and record the weight in grams.').en)}</div>
      <div class="field ${bad ? 'has-error' : ''}" style="max-width:280px;margin-top:8px;">
        <label class="field-label">${escapeHtml(bi('productWeightG', 'Weight (g)').en)}<span class="required">*</span></label>
        <input type="number" step="1" inputmode="decimal" id="productWeightInput"
          value="${escapeHtml(String(state.productWeightG || ''))}" placeholder="0" />
        ${std !== null ? `
          <div class="dim-standard ${bad ? 'dim-standard-fail' : ''}" data-dim-standard="weight">
            ${escapeHtml(bi('approvedLabel', 'Approved').en)}: ${std} \u00b1${tol} g
            <span data-dim-flag>${bad ? ` \u2014 ${escapeHtml(bi('outOfToleranceShort', 'out of tolerance').en)}` : ''}</span>
          </div>
        ` : `<div class="dim-standard">${escapeHtml(bi('noApprovedWeight', 'No approved weight on the PO to compare against.').en)}</div>`}
      </div>
    </div>
  `;
}

function renderDimensionsFields() {
  const dims = state.categoryData.dimensions;
  const tol = sizingToleranceCm();

  const field = (key, i18nKey, fallback) => {
    const std = approvedDimension(key);
    const bad = dimensionOutOfTolerance(key);
    return `
      <div class="field ${bad ? 'has-error' : ''}" style="flex:1;">
        <label class="field-label">${biBlockHtml(i18nKey, fallback)}<span class="required">*</span></label>
        <input type="number" step="0.1" inputmode="decimal" data-dimension="${key}" value="${escapeHtml(dims[key])}" placeholder="0.0" />
        ${std !== null ? `
          <div class="dim-standard ${bad ? 'dim-standard-fail' : ''}" data-dim-standard="${key}">
            ${escapeHtml(bi('approvedLabel', 'Approved').en)}: ${std}${tol !== null ? ` \u00b1${tol}` : ''} cm
            <span data-dim-flag>${bad ? ` \u2014 ${escapeHtml(bi('outOfToleranceShort', 'out of tolerance').en)}` : ''}</span>
          </div>
        ` : ''}
      </div>
    `;
  };

  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('sizingTitle', 'Sizing')}</div>
      <!-- No tolerance line here on purpose: the Tolerance Reference card
           above already states it, and each field below repeats the figure it
           is measured against. A third copy was just noise. -->
      <div class="field-row">
        ${field('height', 'dimensionHeight', 'Height (cm)')}
        ${field('width', 'dimensionWidth', 'Width (cm)')}
        ${field('depth', 'dimensionDepth', 'Depth (cm)')}
      </div>
      <div class="field">
        <label class="field-label">${biBlockHtml('dimensionsNotes', 'Additional Notes')} <span class="section-help">(${escapeHtml(bi('optional').en)})</span></label>
        <textarea data-dimension="notes" placeholder="${escapeHtml(bi('dimensionsNotesPlaceholder').en)}">${escapeHtml(dims.notes || '')}</textarea>
      </div>
    </div>
  `;
}

function renderCustomSizeChart() {
  if (isSimplifiedCustomSizing(state.subcategory)) {
    return `
      <div class="card">
        <div class="section-title">${biBlockHtml('customSizeChartTitle', 'Custom Size Chart')}</div>
        <div class="field">
          <label class="field-label">${biBlockHtml('simpleSizeLabel', 'Size / Measurement')}</label>
          <input type="text" id="simpleSizeInput" value="${escapeHtml(state.categoryData.simpleSizeValue || '')}" placeholder="${escapeHtml(bi('simpleSizePlaceholder').en)}" />
        </div>
        <div class="section-photos-block">
          <div class="section-photos-label">${biBlockHtml('sizingPhotosForSize', 'Photos for this size')}</div>
          ${photoGrid('simplesize', true, true)}
        </div>
      </div>
    `;
  }

  if (!state.categoryData.customSizeRows.length && state.poSizesIncluded && state.poSizesIncluded.length) {
    state.categoryData.customSizeRows = state.poSizesIncluded.map((size) => ({ sizeName: size, measurements: '', photos: [] }));
  }
  const rows = state.categoryData.customSizeRows.map((row, ridx) => `
    <div class="size-card">
      <div class="field">
        <label class="field-label">${biBlockHtml('customSizeName', 'Size Name')}</label>
        <input type="text" data-custom-size-name="${ridx}" value="${escapeHtml(row.sizeName)}" placeholder="${escapeHtml(bi('customSizeNamePlaceholder').en)}" />
      </div>
      <div class="field" data-field="customSizeMeasurements-${ridx}">
        <label class="field-label">${biBlockHtml('customSizeMeasurements', 'Measurements')}<span class="required">*</span></label>
        <textarea data-custom-size-measurements="${ridx}" placeholder="${escapeHtml(bi('customSizeMeasurementsPlaceholder').en)}">${escapeHtml(row.measurements)}</textarea>
      </div>
      <div class="size-card-photos">
        <div class="section-photos-label">${biBlockHtml('sizingPhotosForSize', 'Photos for this size')}</div>
        ${photoGrid('customsizerow:' + ridx, true, true)}
      </div>
      <button type="button" class="remove-defect-btn" data-remove-custom-size="${ridx}">${escapeHtml(bi('removeIssue').en)}</button>
    </div>
  `).join('');

  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('customSizeChartTitle', 'Custom Size Chart')}</div>
      <div class="section-help">${escapeHtml(bi('customSizeChartHelp').en)}<br/>${escapeHtml(bi('customSizeChartHelp').zh)}</div>
      ${rows}
      <button type="button" class="add-defect-btn" id="btnAddCustomSize">${escapeHtml(bi('addCustomSize').en)} <span class="zh">${escapeHtml(bi('addCustomSize').zh)}</span></button>
    </div>
    <!-- The "Reference Chart Photo" upload was removed deliberately: a
         photographed paper chart let sizes be recorded without entering
         the actual measurements, which is what this section exists for.
         Every size must now be filled in explicitly. -->
  `;
}

/** The PO decided the fit; QA measures against it rather than re-choosing. */
function fitIsLockedByPo() {
  return !!(state.poDimensionsTable || (state.categoryData.fit && state.autoFilledForPo));
}

function renderFitPicker() {
  if (fitIsLockedByPo() && state.categoryData.fit) {
    const fitDef = (CONFIG.fits.fits || {})[state.categoryData.fit];
    const label = fitDef
      ? (currentLangIsEn() ? fitDef.label_en : (fitDef.label_zh || fitDef.label_en))
      : state.categoryData.fit;
    return `
      <div class="card">
        <div class="section-title">${biBlockHtml('standardFit', 'Standard Fit')}</div>
        <div class="review-row" style="border-bottom:0;">
          <span class="k">${escapeHtml(bi('fromPurchaseOrder', 'From the purchase order').en)}</span>
          <span class="v">${escapeHtml(label)}</span>
        </div>
      </div>
    `;
  }
  return renderFitPickerEditable();
}

function renderFitPickerEditable() {
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
          <option value="">${escapeHtml(bi('fitSelectPlaceholder').en)}</option>
          ${options}
          <option value="${OTHER_FIT_VALUE}" ${otherSel}>${escapeHtml(bi('fitOther').en)}</option>
        </select>
      </div>
    </div>
  `;
}
/** The PO's own established Golden Sample measurement for a size+point, if
 *  one exists - this is what Pre-Production/Bulk should actually be
 *  compared against, since the Golden Sample may have been edited away
 *  from the generic fit template for this specific product. Falls back to
 *  the generic template's standard when no Golden Sample value exists yet
 *  (e.g. Pre-Production being filed before Sample Approval, if that ever
 *  happens) or for a size the Golden Sample didn't cover. */
/** "Youth S" and "Youth S (6/7 yrs)" are the same size with different
 *  spellings, so names are compared with the bracketed note stripped. */
function normalizeSizeKey(v) {
  return String(v || '').replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Size names are stored with an age hint on youth sizes ("Youth M (8/9 yrs)")
 *  because that's how fits.json seeds them, and fits.json is disk-seeded so the
 *  stored keys can't be renamed without a migration. Strip the bracketed note
 *  for display instead - the key itself is untouched, so matching, storage and
 *  every already-submitted report keep working. */
function displaySizeName(name) {
  return String(name || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim() || String(name || '');
}

function establishedStandardFor(sizeName, point, fitDef) {
  /* The PO's own Product Dimensions table wins: it is the sizing source of
   * truth for this order, and it's what the factory was given. The Golden
   * Sample approval refines it below, and the generic standard is the last
   * resort. */
  const po = state.poDimensionsTable;
  if (po && po.sizes) {
    const row = po.sizes[sizeName]
      || po.sizes[Object.keys(po.sizes).find((k) => normalizeSizeKey(k) === normalizeSizeKey(sizeName)) || ''];
    if (row && row[point] !== undefined && row[point] !== '') return row[point];
  }

  const sizing = state.approvalSizingData;
  if (sizing && sizing.fit === state.categoryData.fit && sizing.sizeRows) {
    const row = sizing.sizeRows.find((r) => r.size === sizeName);
    if (row && row.measured && row.measured[point] !== undefined && row.measured[point] !== '') {
      return row.measured[point];
    }
  }
  const generic = fitDef.sizes[sizeName];
  return generic ? generic[point] : undefined;
}

/** Additional columns (e.g. "Inseam") added on this PO's own Golden Sample -
 *  product-specific, so they only exist once a Sample Approval with them
 *  has actually been submitted for the currently selected fit. */
function getCustomPointsForCurrentFit() {
  const sizing = state.approvalSizingData;
  if (sizing && sizing.fit === state.categoryData.fit && Array.isArray(sizing.customPoints)) {
    return sizing.customPoints;
  }
  return [];
}

/** Label for either a standard fit measurement point or a custom column -
 *  custom columns only have a single freeform label (not bilingual), so
 *  the same text is used for both slots. */
function pointLabelFor(p, fitDef, customPoints) {
  const cp = customPoints.find((c) => c.key === p);
  if (cp) { const label = cp.label || bi('untitledColumn').en; return { en: label, zh: label }; }
  return fitDef.pointLabels[p] || { en: p, zh: '' };
}

function renderReferenceChart() {
  const fitDef = CONFIG.fits.fits[state.categoryData.fit];
  if (!fitDef) return '';
  const customPoints = getCustomPointsForCurrentFit();
  const allPoints = fitDef.points.concat(customPoints.map((cp) => cp.key));
  const pointCols = allPoints.map((p) => {
    const pl = pointLabelFor(p, fitDef, customPoints);
    return `<th>${escapeHtml(pl.zh || pl.en)}<span class="zh">${escapeHtml(pl.en)}</span></th>`;
  }).join('');
  const sizeNames = (state.poSizesIncluded && state.poSizesIncluded.length)
    ? Object.keys(fitDef.sizes).filter((s) => state.poSizesIncluded.some((canonical) => sizeMatchesCanonical(s, canonical)))
    : Object.keys(fitDef.sizes);
  const rows = sizeNames.map((sizeName) => {
    const cells = allPoints.map((p) => `<td>${escapeHtml(formatStandard(establishedStandardFor(sizeName, p, fitDef)))}</td>`).join('');
    return `<tr><td class="size-name">${escapeHtml(displaySizeName(sizeName))}</td>${cells}</tr>`;
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
  const tol = CONFIG.fits.toleranceCm || 1.27;
  const cd = state.categoryData;
  const customPoints = getCustomPointsForCurrentFit();
  const allPoints = fitDef.points.concat(customPoints.map((cp) => cp.key));

  if (!cd.sizeRows.length || cd._fitForRows !== cd.fit) {
    const availableSizes = (state.poSizesIncluded && state.poSizesIncluded.length)
      ? Object.keys(fitDef.sizes).filter((s) => state.poSizesIncluded.some((canonical) => sizeMatchesCanonical(s, canonical)))
      : Object.keys(fitDef.sizes);
    cd.sizeRows = availableSizes.map((size) => ({ size, measured: {}, photos: [] }));
    cd._fitForRows = cd.fit;
  }

  const cards = cd.sizeRows.map((row, ridx) => {
    const pointFields = allPoints.map((p) => {
      const pl = pointLabelFor(p, fitDef, customPoints);
      const std = establishedStandardFor(row.size, p, fitDef);
      const measuredVal = row.measured[p] !== undefined ? row.measured[p] : '';
      const measuredNum = parseFloat(measuredVal);
      const outOfTol = isOutOfTolerance(std, measuredVal === '' ? null : measuredNum, tol);
      return `
        <div class="size-point-field ${outOfTol ? 'out-of-tol' : ''}" id="sizecell_${ridx}_${p}">
          <label class="size-point-label">${escapeHtml(pl.zh || pl.en)} <span class="zh">${escapeHtml(pl.en)}</span></label>
          <span class="std-val">${escapeHtml(bi('standard').en)}<span class="zh">${escapeHtml(bi('standard').zh)}</span>: ${escapeHtml(formatStandard(std))}</span>
          <input type="number" step="0.1" inputmode="decimal" value="${escapeHtml(measuredVal)}"
            class="${outOfTol ? 'out-of-tol' : ''}"
            data-size-row="${ridx}" data-size-point="${p}" placeholder="0.0" />
          <span class="tol-flag" style="display:${outOfTol ? 'inline' : 'none'}">${escapeHtml(bi('outOfTolerance').en)}<span class="zh">${escapeHtml(bi('outOfTolerance').zh)}</span></span>
        </div>
      `;
    }).join('');

    return `
      <div class="size-card">
        <div class="size-card-header">${escapeHtml(displaySizeName(row.size))}</div>
        <div class="size-point-grid">${pointFields}</div>
        <!-- Per-size photo slots removed: the sizing step is a table of
             measurements, and a photo per size made it long enough that the
             numbers got lost. Evidence lives on the Step 5 questions and the
             Step 6 defect entries, where it's tied to an actual finding. -->
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
  if (!currentCategoryDef()) return '';

  // Per-category tolerances, editable in Settings > Tolerances.
  const cats = (CONFIG.tolerances && CONFIG.tolerances.categories) || {};
  const t = cats[state.category];
  if (!t) return '';

  const num = (v) => {
    const n = parseFloat(v);
    return v === null || v === undefined || v === '' || isNaN(n) ? null : n;
  };
  const lines = [
    ['toleranceRefSizing', 'Measurements: \u00b1{v} cm of the approved sample.', num(t.sizingCm)],
    ['toleranceRefPrint', 'Print / embroidery size and placement: \u00b1{v} cm.', num(t.printCm)],
    ['toleranceRefWeight', 'Finished weight: \u00b1{v} g.', num(t.weightG)]
  ]
    // A blank tolerance in Settings means none applies to this category, so
    // that line is left out rather than shown as an empty figure.
    .filter(([, , v]) => v !== null)
    .map(([key, fallback, v]) => escapeHtml(bi(key, fallback).en.replace('{v}', String(v))));

  if (!lines.length) return '';

  return `
    <div class="card" style="background:var(--jc-warn-bg); border-color:#F0D9A8;">
      <div class="section-title" style="color:var(--jc-warn);">${biBlockHtml('toleranceReferenceTitle', 'Tolerance Reference')}</div>
      <div class="section-help" style="color:var(--jc-warn);">${lines.join('<br/>')}</div>
    </div>
  `;
}

function renderSizingPhotosCard() {
  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('sizingPhotos', 'Sizing Photos')}</div>
      <div class="section-help">${escapeHtml(bi('sectionPhotosHelp').en)}</div>
      ${photoGrid('section:sizing', true)}
    </div>
  `;
}

/* ---- Step 4: Final Approval Photos ---- */
function renderPhotosStep() {
  return `
    <div class="step-eyebrow">${stepLabel()}</div>
    <div class="step-title">${biBlockHtml('finalApprovalPhotos', 'Final Approval Photos')}</div>
    <div class="section-help" style="margin-bottom:14px;">${escapeHtml(bi('finalApprovalHelp').en)}<br/>${escapeHtml(bi('finalApprovalHelp').zh)}</div>
    <div class="card">
      <div class="section-title">${biBlockHtml('generalPhotos', 'General Photos')}</div>
      <div class="section-help">${escapeHtml(bi('generalPhotosHelp').en)}</div>
      ${photoGrid('general')}
    </div>
    <div class="card">
      <div class="section-title">${biBlockHtml('tagPhotos', 'Tag Photos')}</div>
      <div class="section-help">${escapeHtml(bi('tagPhotosHelp').en)}</div>
      ${photoGrid('tags')}
    </div>
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="btnBack">${biBlockHtml('back', 'Back')}</button>
      <button class="btn btn-secondary" id="btnSaveDraft">${biBlockHtml('saveAndClose', 'Save')}</button>
      <button class="btn btn-primary" id="btnNext">${biBlockHtml('next', 'Next')}</button>
    </div>
  `;
}
function photoGrid(fieldId, compact, mini) {
  const arr = getPhotoArray(fieldId);
  const thumbs = arr.map((file, idx) => {
    // Videos get a labeled, playable tile rather than an <img>, which
    // would just render broken for a video blob.
    const isVideo = (file.type || '').startsWith('video/') || /\.(mp4|mov|m4v|webm|avi|mkv|3gp)$/i.test(file.name || '');
    return `
    <div class="photo-thumb">
      ${/* Served from the draft folder now, not a blob URL - the file is
            already on the server by the time this renders. */ ''}
      ${isVideo
        ? `<video src="${escapeHtml(file.url || '')}" class="photo-video" muted playsinline preload="metadata"></video><span class="photo-video-badge">&#9654; Video</span>`
        : `<img src="${escapeHtml(file.url || '')}" />`}
      <button class="photo-remove" data-photo-remove="${fieldId}" data-photo-idx="${idx}">✕</button>
    </div>
  `;
  }).join('');
  const inputId = `photoInput_${fieldId.replace(/[:]/g, '_')}`;
  return `
    <div class="photo-grid ${mini ? 'mini' : (compact ? 'compact' : '')}">
      ${thumbs}
      <label class="photo-add" for="${inputId}">
        <span class="plus">+</span>
        <span>${escapeHtml(bi('addPhotoOrVideo').en)}</span>
        <input type="file" id="${inputId}" accept="image/*,video/*" multiple
          data-photo-input="${fieldId}" />
      </label>
    </div>
  `;
}

/* ---- Step 5: Additional Issues (catch-all) ---- */
/* ============================================================
 * Step 6: Additional Issues (config-driven, minor only)
 * ============================================================
 * One section per Step 6 question in config/reportQuestions.json, each an
 * "add defect" prompt rather than a pass/fail. Nothing has to be added - a
 * clean inspection leaves every section empty.
 *
 * Everything logged here counts as MINOR. Severity is derived from the step
 * now, so there's no minor/major selector: Step 5 fails are the major ones,
 * and these are the scattered per-unit issues found while checking. */
function sectionIssuesFor(id) {
  if (!state.sectionIssues[id]) state.sectionIssues[id] = [];
  return state.sectionIssues[id];
}

function emptySectionIssue() {
  return { id: genId(), description: '', unitsAffected: 1, media: [] };
}

/** Every Step 6 entry across all sections, flattened, shaped like the defects
 *  the AQL tally and PDF already understand. */
function allSectionIssues() {
  const out = [];
  Object.keys(state.sectionIssues || {}).forEach((sectionId) => {
    (state.sectionIssues[sectionId] || []).forEach((issue) => {
      out.push({
        ...issue,
        sectionId,
        severity: 'minor',   // always - see the note above
        photos: issue.media  // the tally and PDF both look for `photos`
      });
    });
  });
  return out;
}

function renderSectionIssueCard(issue, sectionId) {
  return `
    <div class="defect-card" data-section-issue="${escapeHtml(issue.id)}" data-section-id="${escapeHtml(sectionId)}">
      <div class="field">
        <label class="field-label">${escapeHtml(bi('issueDescription', 'What did you find?').en)}<span class="required">*</span></label>
        <textarea data-issue-desc="${escapeHtml(issue.id)}" rows="2"
          placeholder="${escapeHtml(bi('issueDescriptionPlaceholder', 'Describe the issue and where on the product it is').en)}">${escapeHtml(issue.description || '')}</textarea>
      </div>
      <div class="field">
        <label class="field-label">${escapeHtml(bi('unitsAffectedLabel', 'How many units failed?').en)}<span class="required">*</span></label>
        <input type="number" min="1" class="input" data-issue-units="${escapeHtml(issue.id)}"
          value="${escapeHtml(String(issue.unitsAffected || ''))}" />
      </div>
      <div class="q-media-block">
        <div class="section-photos-label">
          ${escapeHtml(bi('evidenceLabel', 'Evidence').en)}<span class="required">*</span>
          <span class="q-media-hint">${escapeHtml(bi('mediaOnFailRequired', 'Photo or video of the defect required').en)}</span>
        </div>
        ${photoGrid('issue:' + issue.id, true)}
      </div>
      <button type="button" class="remove-defect-btn" data-remove-issue="${escapeHtml(issue.id)}">${escapeHtml(bi('removeIssue').en)}</button>
    </div>
  `;
}

function renderAdditionalIssuesStep() {
  const questions = questionsForStep(6);

  const sections = questions.map((q) => {
    const issues = sectionIssuesFor(q.id);
    const cleared = !!state.sectionCleared[q.id];
    return `
      <div class="card">
        <div class="section-title">${escapeHtml(q.title)}</div>
        ${q.guidance ? `<div class="q-guidance">${escapeHtml(q.guidance)}</div>` : ''}
        ${issues.length
          ? issues.map((i) => renderSectionIssueCard(i, q.id)).join('')
          : `<div class="no-issues-note" style="margin:6px 0;">${cleared
              ? escapeHtml(bi('sectionMarkedClean', 'Marked as no defects.').en)
              : escapeHtml(bi('noIssuesInSection', 'No issues logged here.').en)}</div>`}
        <!-- Two buttons, not one. A single "Add Defect" let a section be
             skipped and an untouched section looked identical to one that had
             been checked and found clean. Now every section has to be answered
             one way or the other. -->
        <div class="section-answer-row">
          <button type="button" class="section-clean-btn ${cleared ? 'is-on' : ''}"
            data-clean-section="${escapeHtml(q.id)}" ${issues.length ? 'disabled' : ''}
            title="${issues.length ? escapeHtml(bi('removeIssuesFirst', 'Remove the logged issues first.').en) : ''}">
            ${cleared ? '\u2713 ' : ''}${escapeHtml(bi('btnNoDefects', 'No Defects').en)}
          </button>
          <button type="button" class="add-defect-btn" data-add-section-issue="${escapeHtml(q.id)}">
            ${escapeHtml(bi('addDefect').en)}
          </button>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="step-eyebrow">${stepLabel()}</div>
    <div class="step-title">${biBlockHtml('additionalIssuesSection', 'Additional Issues')}</div>
    <div class="section-help" style="margin-bottom:14px;">
      ${escapeHtml(bi('additionalIssuesHelpMinor', 'Minor issues found on individual units while checking. Add one entry per distinct issue, with the number of units affected. Leave a section empty if you found nothing.').en)}
    </div>
    ${sections || `<div class="card"><div class="section-help">${escapeHtml(bi('noQuestionsForProduct', 'No inspection questions are configured for this product type yet.').en)}</div></div>`}
    <div id="issuesAqlLive">${renderAqlTallyCard()}</div>
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="btnBack">${biBlockHtml('back', 'Back')}</button>
      <button class="btn btn-secondary" id="btnSaveDraft">${biBlockHtml('saveAndClose', 'Save')}</button>
      <button class="btn btn-primary" id="btnNext">${biBlockHtml('next', 'Next')}</button>
    </div>
  `;
}

/** Only entries that exist are validated - an empty section is a valid
 *  "nothing found", which is the normal case. */
/** Sections neither marked clean nor given an entry. */
function unansweredSections() {
  return questionsForStep(6).filter((q) => {
    const issues = state.sectionIssues[q.id] || [];
    return !issues.length && !state.sectionCleared[q.id];
  });
}

function sectionIssueProblems() {
  const problems = [];
  unansweredSections().forEach((q) => problems.push({ id: q.id, why: 'unanswered', sectionId: q.id }));
  allSectionIssues().forEach((i) => {
    if (!i.description || !i.description.trim()) problems.push({ id: i.id, why: 'description' });
    else if (!(parseInt(i.unitsAffected, 10) > 0)) problems.push({ id: i.id, why: 'units' });
    else if (!i.media || !i.media.length) problems.push({ id: i.id, why: 'media' });
  });
  return problems;
}

function findSectionIssueById(id) {
  for (const sectionId of Object.keys(state.sectionIssues || {})) {
    const hit = (state.sectionIssues[sectionId] || []).find((i) => i.id === id);
    if (hit) return hit;
  }
  return null;
}

function attachSectionIssueHandlers() {
  document.querySelectorAll('[data-clean-section]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.cleanSection;
      // Toggle, so a mis-click can be undone without reloading.
      state.sectionCleared[id] = !state.sectionCleared[id];
      render();
    });
  });
  document.querySelectorAll('[data-add-section-issue]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // Logging an issue contradicts "no defects", so clear the flag.
      state.sectionCleared[btn.dataset.addSectionIssue] = false;
      sectionIssuesFor(btn.dataset.addSectionIssue).push(emptySectionIssue());
      render();
      const cards = document.querySelectorAll('[data-section-issue]');
      const last = cards[cards.length - 1];
      if (last) last.querySelector('textarea').focus();
    });
  });
  document.querySelectorAll('[data-remove-issue]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.removeIssue;
      Object.keys(state.sectionIssues).forEach((k) => {
        state.sectionIssues[k] = state.sectionIssues[k].filter((i) => i.id !== id);
      });
      render();
    });
  });
  document.querySelectorAll('[data-issue-desc]').forEach((el) => {
    el.addEventListener('input', () => {
      const i = findSectionIssueById(el.dataset.issueDesc);
      if (i) i.description = el.value;
    });
  });
  document.querySelectorAll('[data-issue-units]').forEach((el) => {
    el.addEventListener('input', () => {
      const i = findSectionIssueById(el.dataset.issueUnits);
      if (i) i.unitsAffected = el.value;
    });
  });
}

function renderAqlTallyCard() {
  const result = computeOverallResult();
  const aql = result.aql;
  if (aql && aql.isPreProduction) {
    return `
      <div class="card" style="margin-top:14px;">
        <div class="section-title">${biBlockHtml('quantityRecapTitle', 'Recap')}</div>
        <div class="section-help">${escapeHtml(bi('aqlPreProductionNotice').en)}<br/>${escapeHtml(bi('aqlPreProductionNotice').zh)}</div>
        <div class="aql-preview" style="margin-top:12px;">
          <div class="aql-preview-row"><span>${escapeHtml(bi('poSize').en)} <span class="zh">${escapeHtml(bi('poSize').zh)}</span></span><strong>${aql.poSize !== null ? aql.poSize : '-'}</strong></div>
          <div class="aql-preview-row"><span>${escapeHtml(bi('quantityChecked').en)} <span class="zh">${escapeHtml(bi('quantityChecked').zh)}</span></span><strong>${aql.quantityChecked !== null ? aql.quantityChecked : '-'}</strong></div>
        </div>
        <table class="aql-preview-table" style="margin-top:10px;">
          <thead><tr><th></th><th>${escapeHtml(bi('foundLabel').en)}</th></tr></thead>
          <tbody>
            <tr><td>${escapeHtml(bi('aqlCritical').en)}</td><td>${aql.criticalCount}</td></tr>
            <tr><td>${escapeHtml(bi('aqlMajor').en)}</td><td>${aql.majorCount}</td></tr>
            <tr><td>${escapeHtml(bi('aqlMinor').en)}</td><td>${aql.minorCount}</td></tr>
          </tbody>
        </table>
      </div>
    `;
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
    aqlCritical: 'resultReasonAqlCritical', aqlMajor: 'resultReasonAqlMajor', aqlMinor: 'resultReasonAqlMinor',
    // Was missing, so this reason rendered blank on the review banner.
    /* 'allRejected' was retired when the rate thresholds replaced it - a
     * fully-defective batch now reports as thresholdCritical. Kept in the map
     * so a report submitted under the old rules still renders its reason
     * rather than showing a blank line. */
    allRejected: 'resultReasonAllRejected',
    thresholdCritical: 'resultReasonThresholdCritical',
    thresholdMajor: 'resultReasonThresholdMajor',
    thresholdMinor: 'resultReasonThresholdMinor'
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
    <div class="step-eyebrow">${stepLabel()}</div>
    <div class="step-title">${biBlockHtml('reviewTitle', 'Review & Submit')}</div>

    <div class="result-banner ${result.overall === 'fail' ? 'fail' : ''}">
      <div class="result-banner-title">${escapeHtml(bi('overallResult').en)}</div>
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
        ${reviewRow('date', state.date)}
        ${reviewRow('poQuantity', state.poQuantity)}
        ${reviewRow('qaLead', state.qaLead)}
        ${reviewRow('creator', state.creator)}
        <div class="review-row"><span class="k">类别 / Category</span><span class="v">${escapeHtml(catLabel.en)} ${escapeHtml(catLabel.zh)}</span></div>
        ${subLabel ? `<div class="review-row"><span class="k">类型 / Type</span><span class="v">${escapeHtml(subLabel.en)} ${escapeHtml(subLabel.zh)}</span></div>` : ''}
        <div class="review-row"><span class="k">${bi('qaType').en}</span><span class="v">${escapeHtml(qaTypeLabel.en)} ${escapeHtml(qaTypeLabel.zh)}</span></div>
      </div>
      <div class="review-block">
        <div class="review-block-title">${bi('additionalIssuesSection').en} / ${bi('additionalIssuesSection').zh}</div>
        <div class="review-row"><span class="k">Total</span><span class="v">${state.additionalIssues.length}</span></div>
      </div>
    </div>
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="btnBack">${biBlockHtml('back', 'Back')}</button>
      <button class="btn btn-secondary" id="btnSaveDraft">${biBlockHtml('saveAndClose', 'Save')}</button>
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
  if (input) {
    input.addEventListener('input', (e) => {
      state.actualUnitsChecked = e.target.value;
      const derived = document.getElementById('unitsCheckedDerived');
      if (derived) derived.innerHTML = renderUnitsCheckedDerived();
    });
  }
  const preProdInput = root.querySelector('#preProductionUnitsCheckedInput');
  if (preProdInput) {
    preProdInput.addEventListener('input', (e) => {
      state.preProductionUnitsChecked = e.target.value;
    });
  }
}

function attachStepHandlers(name) {
  const btnBack = document.getElementById('btnBack');
  if (btnBack) btnBack.addEventListener('click', back);
  const btnNext = document.getElementById('btnNext');
  if (btnNext) btnNext.addEventListener('click', next);
  const btnSubmit = document.getElementById('btnSubmit');
  if (btnSubmit) btnSubmit.addEventListener('click', submitReport);
  const btnSaveDraft = document.getElementById('btnSaveDraft');
  if (btnSaveDraft) btnSaveDraft.addEventListener('click', () => saveDraft(false));

  document.querySelectorAll('[data-bind]').forEach((el) => {
    const evt = (el.tagName === 'SELECT') ? 'change' : 'input';
    el.addEventListener(evt, (e) => setStateValue(el.getAttribute('data-bind'), e.target.value));
  });

  if (name === 'inspectionDetails') attachInspectionHandlers();
  if (name === 'disposition') { attachDispositionHandlers(); attachPhotoHandlers(); }

  const manualSizingBtn = document.getElementById('btnEnterSizingManually');
  if (manualSizingBtn) {
    manualSizingBtn.addEventListener('click', () => { state.manualSizingOptIn = true; render(); });
  }

  const weightInput = document.getElementById('productWeightInput');
  if (weightInput) {
    weightInput.addEventListener('input', () => {
      state.productWeightG = weightInput.value;
      refreshToleranceFlag('weight');
    });
  }

  attachDataBindLiveHandlers(document);
  attachUnitsCheckedHandler(document);

  if (name === 'poLookup') {
    const input = document.getElementById('poLookupInput');
    if (input) input.addEventListener('input', (e) => { state.poNumber = e.target.value; });
    const btn = document.getElementById('btnPoLookupSubmit');
    if (btn) btn.addEventListener('click', submitPoLookup);
  }

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
    if (state.sku) fetchPriorReports();
    document.querySelectorAll('[data-seg]').forEach((el) => {
      el.addEventListener('click', () => {
        const field = el.getAttribute('data-seg');
        state[field] = el.getAttribute('data-val');
        if (field === 'productRisk') state._productRiskTouched = true;
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
        } else if (val !== 'fail') {
          // Clear out any defects logged while this was marked Fail - otherwise
          // they stay behind invisibly (the defects UI only shows when status is
          // Fail) but still count against validation, causing an inexplicable
          // "photo required" error even though nothing appears to be logged.
          state.categoryData[key].defects = [];
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
        state.categoryData.customSizeRows = [];
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
    const simpleSizeInput = document.getElementById('simpleSizeInput');
    if (simpleSizeInput) simpleSizeInput.addEventListener('input', (e) => { state.categoryData.simpleSizeValue = e.target.value; });
    document.querySelectorAll('[data-dimension]').forEach((el) => {
      el.addEventListener('input', (e) => {
        const key = el.getAttribute('data-dimension');
        state.categoryData.dimensions[key] = e.target.value;
        // Flag as they type rather than waiting for blur or Next.
        if (key !== 'notes') refreshToleranceFlag(key);
      });
    });
    const btnAddCustomSize = document.getElementById('btnAddCustomSize');
    if (btnAddCustomSize) {
      btnAddCustomSize.addEventListener('click', () => {
        state.categoryData.customSizeRows.push({ sizeName: '', measurements: '', photos: [] });
        render();
      });
    }
    document.querySelectorAll('[data-custom-size-name]').forEach((el) => {
      el.addEventListener('input', (e) => {
        state.categoryData.customSizeRows[parseInt(el.getAttribute('data-custom-size-name'), 10)].sizeName = e.target.value;
      });
    });
    document.querySelectorAll('[data-custom-size-measurements]').forEach((el) => {
      el.addEventListener('input', (e) => {
        state.categoryData.customSizeRows[parseInt(el.getAttribute('data-custom-size-measurements'), 10)].measurements = e.target.value;
      });
    });
    document.querySelectorAll('[data-remove-custom-size]').forEach((el) => {
      el.addEventListener('click', () => {
        state.categoryData.customSizeRows.splice(parseInt(el.getAttribute('data-remove-custom-size'), 10), 1);
        render();
      });
    });
  }

  if (name === 'photos') attachPhotoHandlers();

  if (name === 'issues') {
    // Step 6 is per-section now; attachDefectHandlers is still called for the
    // legacy defect cards the Sizing step's custom-sizing flow can create.
    attachSectionIssueHandlers();
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
  const tol = CONFIG.fits.toleranceCm || 1.27;
  const row = state.categoryData.sizeRows[ridx];
  const standard = establishedStandardFor(row.size, point, fitDef);
  const measuredVal = row.measured[point] !== undefined ? row.measured[point] : '';
  const measuredNum = parseFloat(measuredVal);
  const outOfTol = isOutOfTolerance(standard, measuredVal === '' ? null : measuredNum, tol);
  const cell = document.getElementById(`sizecell_${ridx}_${point}`);
  if (!cell) return;
  const input = cell.querySelector('input');
  const flag = cell.querySelector('.tol-flag');
  cell.classList.toggle('out-of-tol', outOfTol);
  if (input) input.classList.toggle('out-of-tol', outOfTol);
  if (flag) flag.style.display = outOfTol ? 'inline' : 'none';
}

/** Send one photo to this report's draft folder and return its reference.
 *  Called as the photo is taken, not at submit. */
async function uploadDraftPhoto(file) {
  ensureDraftId();
  const fd = new FormData();
  fd.append('photo', file, file.name || 'photo.jpg');
  const res = await fetch(`/api/qa/draft/${encodeURIComponent(state.draftId)}/photo`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error('upload failed: ' + res.status);
  const body = await res.json();
  return body.photo;
}

/**
 * Derived from the PO and stage rather than random.
 *
 * A random id per page load would mean reopening the same report link started
 * a fresh empty draft every time, which defeats the entire point - and would
 * leave the previous draft's photos orphaned on disk. Ids are validated
 * server-side against a character whitelist, hence the sanitising here.
 */
function draftIdFor(poNumber, qaType) {
  const clean = String(poNumber || 'nopo').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  const stage = qaType === 'production' ? 'bulk' : 'prepro';
  return `po-${clean}-${stage}`;
}

function ensureDraftId() {
  if (!state.draftId) state.draftId = draftIdFor(state.poNumber, state.qaType);
  return state.draftId;
}


/* ---- Save and resume ----
 * Photos became server-side references in the previous change, which is what
 * makes this possible: the entire report state is now plain JSON. */
const DRAFT_SAVE_KEYS = [
  'qaType', 'poNumber', 'sku', 'productTitle', 'category', 'subcategory', 'creator',
  'date', 'poQuantity', 'productRisk', 'qaLead', 'preProductionUnitsChecked',
  'actualUnitsChecked', 'inspectionLevel', 'majorAql', 'minorAql', 'materials',
  'printingMethod', 'productionNotes', 'categoryData', 'answers', 'sectionIssues',
  'sectionCleared', 'additionalIssues', 'photos', 'dispositions', 'productWeightG', 'manualSizingOptIn',
  'draftId', 'qaSetup', 'poDimensions', 'poDimensionsTable', 'poWeightG', 'step'
];

function draftSnapshot() {
  const out = {};
  DRAFT_SAVE_KEYS.forEach((k) => { if (k !== 'step') out[k] = state[k]; });
  out.step = step;
  return out;
}

let lastSavedAt = null;

async function saveDraft(quiet) {
  ensureDraftId();
  try {
    const res = await fetch(`/api/qa/draft/${encodeURIComponent(state.draftId)}/state`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draftSnapshot())
    });
    if (!res.ok) throw new Error('save failed');
    lastSavedAt = new Date();
    if (!quiet) showToast(bi('draftSaved', 'Progress saved. You can close this and come back to it.').en);
    return true;
  } catch (err) {
    console.error('Draft save failed', err);
    showToast(bi('draftSaveFailed', 'Could not save your progress - check your connection.').en, true);
    return false;
  }
}

/** Called once the PO is known, before the first render of step 2. */
async function tryResumeDraft() {
  const id = draftIdFor(state.poNumber, state.qaType);
  try {
    const res = await fetch(`/api/qa/draft/${encodeURIComponent(id)}/state`);
    if (!res.ok) return false;
    const body = await res.json();
    if (!body.draft || !body.draft.data) return false;
    const saved = body.draft.data;
    // Only restore keys we know about, so a stale draft from an older build
    // can't reintroduce fields that no longer exist.
    DRAFT_SAVE_KEYS.forEach((k) => {
      if (k === 'step') return;
      if (saved[k] !== undefined) state[k] = saved[k];
    });
    state.draftId = id;
    if (typeof saved.step === 'number') step = saved.step;
    showToast(bi('draftResumed', 'Picked up where you left off.').en);
    return true;
  } catch (err) {
    console.error('Could not load draft', err);
    return false;
  }
}

async function discardDraft() {
  if (!state.draftId) return;
  try {
    await fetch(`/api/qa/draft/${encodeURIComponent(state.draftId)}`, { method: 'DELETE' });
  } catch (err) { /* a leftover draft is swept after 30 days anyway */ }
}

/** Photo arrays for the revised report's per-issue evidence. */
function revisedPhotoArray(idx) {
  const iss = state.revisedIssues[idx];
  if (!iss) return [];
  if (!iss.newPhotos) iss.newPhotos = [];
  return iss.newPhotos;
}

function attachGateHandlers() {
  const a = document.getElementById('btnAdditionalReport');
  if (a) a.addEventListener('click', () => {
    // A genuinely separate report - the gate is dismissed and the wizard runs
    // as normal, saving as its own submission.
    state.reportMode = 'full';
    state.completedReport = null;
    goTo(1);
  });
  const r = document.getElementById('btnRevisedReport');
  if (r) r.addEventListener('click', () => startRevisedReport());
}

async function startRevisedReport() {
  try {
    const res = await fetch(`/api/submission-history/${encodeURIComponent(state.poNumber)}`);
    const data = res.ok ? await res.json() : { reports: [] };
    const mine = (data.reports || []).find((x) => x.submissionId === (state.completedReport || {}).submissionId)
      || (data.reports || [])[0];
    state.revisedIssues = ((mine && mine.issues) || []).map((iss) => ({
      description: iss.description || '',
      severity: iss.severity || 'minor',
      unitsAffected: parseInt(iss.unitsAffected, 10) || 1,
      photos: iss.photos || [],
      unitsFixed: '', newPhotos: [], confirmed: false
    }));
  } catch (err) {
    console.error('Could not load the original report issues', err);
    state.revisedIssues = [];
  }
  state.reportMode = 'revised';
  render();
}

function attachRevisedHandlers() {
  const back = document.getElementById('btnBackToGate');
  if (back) back.addEventListener('click', () => { state.reportMode = 'gate'; render(); });

  document.querySelectorAll('[data-revised-qty]').forEach((el) => {
    el.addEventListener('input', () => {
      const iss = state.revisedIssues[parseInt(el.dataset.revisedQty, 10)];
      if (iss) iss.unitsFixed = el.value;
    });
  });

  document.querySelectorAll('[data-revised-confirm]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.revisedConfirm, 10);
      const iss = state.revisedIssues[idx];
      const n = parseInt(iss.unitsFixed, 10);
      // Cannot repair more units than were flagged in the first place.
      if (!(n > 0) || n > iss.unitsAffected) {
        showToast(bi('unitsFixedRange', 'Enter a number between 1 and the units flagged.').en
          .replace('{max}', String(iss.unitsAffected)), true);
        return;
      }
      if (!(iss.newPhotos || []).length) {
        showToast(bi('photoRequiredForDefect').en, true);
        return;
      }
      iss.confirmed = true;
      render();
    });
  });

  document.querySelectorAll('[data-revised-undo]').forEach((el) => {
    el.addEventListener('click', () => {
      const iss = state.revisedIssues[parseInt(el.dataset.revisedUndo, 10)];
      if (iss) iss.confirmed = false;
      render();
    });
  });

  const submit = document.getElementById('btnSubmitRevised');
  if (submit) submit.addEventListener('click', submitRevisedReport);
}

async function submitRevisedReport() {
  const btn = document.getElementById('btnSubmitRevised');
  if (btn) { btn.disabled = true; btn.textContent = bi('savingEllipsis', 'Saving...').en; }
  try {
    const payload = {
      poNumber: state.poNumber,
      sku: state.sku,
      qaType: state.qaType,
      originalSubmissionId: (state.completedReport || {}).submissionId || null,
      qaLead: state.qaLead || '',
      submittedAt: new Date().toISOString(),
      issues: state.revisedIssues.map((iss) => ({
        description: iss.description,
        severity: iss.severity,
        unitsAffected: iss.unitsAffected,
        unitsFixed: parseInt(iss.unitsFixed, 10) || 0,
        photos: (iss.newPhotos || []).map((f) => ({ id: f.id, name: f.name, type: f.type }))
      })),
      draftId: state.draftId
    };
    const res = await fetch('/api/submit-revised', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('submit failed');
    showToast(bi('revisedSubmitted', 'Revised unit report submitted.').en);
    state.reportMode = 'gate';
    render();
  } catch (err) {
    console.error('Revised report submit failed', err);
    showToast(bi('revisedSubmitFailed', 'Could not submit the revised report.').en, true);
    if (btn) { btn.disabled = false; btn.textContent = bi('btnSubmitRevised', 'Submit revised report').en; }
  }
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
        let toSend = f;
        try {
          toSend = await compressImage(f);
        } catch (err) {
          // Not an image (a video), or the canvas gave up. Send the original.
          console.error('Photo compression failed, uploading original', err);
        }
        try {
          const ref = await uploadDraftPhoto(toSend);
          arr.push(ref);
        } catch (err) {
          console.error('Photo upload failed', err);
          showToast(bi('photoUploadFailed', 'Could not upload that photo - check your connection and try again.').en, true);
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
      arr.splice(idx, 1);
      render();
      // Fire and forget - the report is already correct without it, and a
      // failed cleanup is a stray file rather than a broken report.
      if (removed && removed.id && state.draftId) {
        fetch(`/api/qa/draft/${encodeURIComponent(state.draftId)}/photo/${encodeURIComponent(removed.id)}`,
          { method: 'DELETE' }).catch(() => {});
      }
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


/* ---- Payload builders for the config-driven steps ---- */

/** Step 5 grouped exactly as rendered: section name, then each question with
 *  the answer given. Titles are baked in - see the note in submitReport. */
function buildInspectionSectionsForPayload() {
  const all = questionsForStep(5).concat(additionalReviewQuestions());
  const sections = [];
  all.forEach((q) => {
    const a = state.answers[q.id] || {};
    const last = sections[sections.length - 1];
    const row = {
      id: q.id,
      title: q.title,
      status: a.status || 'na',
      unitsAffected: a.status === 'fail' ? (parseInt(a.unitsAffected, 10) || 0) : 0,
      photoCount: (a.media || []).length
    };
    if (last && last.name === q.section) last.questions.push(row);
    else sections.push({ name: q.section, questions: [row] });
  });
  return sections;
}

/** Step 6, one block per section, empty ones included so the report shows
 *  what was checked and found clean rather than silently omitting it. */
function buildIssueSectionsForPayload() {
  return questionsForStep(6).map((q) => ({
    id: q.id,
    name: q.title,
    issues: (state.sectionIssues[q.id] || []).map((i) => ({
      id: i.id,
      description: i.description,
      unitsAffected: parseInt(i.unitsAffected, 10) || 0,
      severity: 'minor'
    }))
  }));
}

/** The sample-to-PO extrapolation, computed here so the PDF prints the same
 *  numbers the inspector signed off on rather than recalculating. */
function buildRecapForPayload() {
  const checked = unitsCheckedForRecap();
  const poQty = parseInt(state.poQuantity, 10) || null;
  const sums = sumDefectsBySeverity(collectAllDefects());
  const out = { unitsChecked: checked, poQuantity: poQty, severities: {} };
  ['critical', 'major', 'minor'].forEach((sev) => {
    out.severities[sev] = extrapolate(sums[sev], checked, poQty) || { found: sums[sev], pct: null, assumed: null };
  });
  return out;
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
      preProductionUnitsChecked: state.preProductionUnitsChecked,
      inspectionLevel: state.inspectionLevel,
      majorAql: state.majorAql,
      minorAql: state.minorAql,
      materials: state.materials,
      printingMethod: state.printingMethod,
      categoryData: {
        fit: cd.fit,
        sizeRows: (cd.sizeRows || []).map((row) => ({ size: row.size, measured: row.measured })),
        customSizeRows: (cd.customSizeRows || []).map((row) => ({ sizeName: row.sizeName, measurements: row.measurements })),
        simpleSizeValue: cd.simpleSizeValue || '',
        dimensions: cd.dimensions || { height: '', width: '', depth: '' },
        ...Object.fromEntries(CHECKLIST_KEYS.map((key) => [key, {
          status: cd[key].status, notes: cd[key].notes,
          defects: (cd[key].defects || []).map(serializeDefect)
        }])),
        customNotes: cd.customNotes
      },
      additionalIssues: state.additionalIssues.map(serializeDefect),
      /* The new config-driven steps, sent as the inspector actually saw them
       * rather than as bare ids. The report is an audit document, so it has to
       * still read correctly years later even if the question bank has moved
       * on - resolving titles at render time from the live config would
       * silently rewrite history. */
      inspection: {
        sections: buildInspectionSectionsForPayload(),
        issueSections: buildIssueSectionsForPayload(),
        recap: buildRecapForPayload(),
        /* What was decided about each defect, so the PDF can show the issue
         * alongside its resolution rather than just the original finding. */
        dispositions: dispositionTargets().map((t) => {
          const d = state.dispositions[t.id] || {};
          return {
            id: t.id, description: t.description, severity: t.severity,
            unitsFlagged: t.unitsAffected,
            choice: d.choice || '',
            unitsRepaired: d.choice === 'repaired' ? (parseInt(d.unitsRepaired, 10) || 0) : 0
          };
        })
      }
    };

    /* Photos are already on the server, in this report's draft folder, so the
     * submission sends references rather than re-uploading megabytes the
     * server just received. photoRefs maps the same field names the PDF
     * builder already expects onto the draft photo ids. */
    const photoRefs = {};
    const ref = (field, arr) => {
      (arr || []).forEach((f) => {
        if (!f || !f.id) return;
        (photoRefs[field] = photoRefs[field] || []).push({ id: f.id, name: f.name, type: f.type });
      });
    };

    ref('photo_general', state.photos.general);
    ref('photo_tags', state.photos.tags);
    Object.keys(state.categoryData.sectionPhotos).forEach((sectionKey) => {
      ref(`photo_section_${sectionKey === 'washTag' ? 'washtag' : sectionKey}`,
        state.categoryData.sectionPhotos[sectionKey]);
    });
    questionsForStep(5).concat(additionalReviewQuestions()).forEach((q) => {
      const a = state.answers[q.id];
      if (a) ref(`photo_q_${q.id}`, a.media);
    });
    allSectionIssues().forEach((d) => ref(`photo_defect_${d.id}`, d.photos));
    Object.keys(state.dispositions || {}).forEach((k) => ref(`photo_disposition_${k}`, state.dispositions[k].photos));
    (state.categoryData.sizeRows || []).forEach((row, ridx) => ref(`photo_sizerow_${ridx}`, row.photos));
    (state.categoryData.customSizeRows || []).forEach((row, ridx) => ref(`photo_customsizerow_${ridx}`, row.photos));
    ref('photo_chart', state.categoryData.chartPhotos);
    ref('photo_simplesize', state.categoryData.simpleSizePhotos);
    // Legacy fixed-checklist defects, for reports started before the rework.
    CHECKLIST_KEYS.forEach((key) => {
      const item = state.categoryData[key];
      (item && item.defects ? item.defects : []).forEach((d) => ref(`photo_defect_${d.id}`, d.photos));
    });

    payload.draftId = state.draftId;
    payload.photoRefs = photoRefs;

    const formData = new FormData();
    formData.append('payload', JSON.stringify(payload));

    const res = await fetch('/api/submit', { method: 'POST', body: formData });
    if (res.ok) {
      // The submission has its own copies now, so the draft is dead weight.
      discardDraft();
    }
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
    sku: '', poSizesIncluded: [], pdNotes: [], approvalSizingData: null,
  approvalReferencePhotos: { sample: {}, preProduction: {} }, productionNotesData: null,
    poNumber: '', factoryCode: '', date: todayStr(), qaLead: '',
    creator: '', productTitle: '', qaType: 'pre_production',
    poQuantity: '', inspectionLevel: 'II', majorAql: 2.5, minorAql: 4.0,
    productRisk: 'medium', actualUnitsChecked: '', preProductionUnitsChecked: '',
    autoFilledForPo: null, _productRiskTouched: false,
    materials: '', printingMethod: '',
    categoryData: {
      fit: '', sizeRows: [], customSizeRows: [], chartPhotos: [], simpleSizeValue: '', simpleSizePhotos: [], dimensions: { height: '', width: '', depth: '', notes: '' },
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
  appMode = 'chooser';
  render();
}

/* ---------------- INIT ---------------- */

(async function init() {
  await loadConfig();

  // Switch language in place instead of reloading. render() rebuilds the
  // current screen entirely from `state`/`step`/`appMode`, and every label
  // goes through bi()/catLabel() which read the live language at call time,
  // so a plain re-render is all that's needed. Reloading here used to discard
  // the in-progress report and bounce the user back to step 1.
  if (window.JuniperLang && window.JuniperLang.onChange) {
    window.JuniperLang.onChange(() => { render(); });
  }

  const params = new URLSearchParams(location.search);
  if (params.get('mode') === 'newPO') {
    appMode = 'newPO';
  } else if ((params.get('mode') === 'pre_production' || params.get('mode') === 'production') && params.get('po')) {
    // Deep link from an Order Management PO's QA/QC section - skip the
    // chooser and the manual PO-number entry, go straight into the report
    // wizard with this PO already looked up, reusing the same lookup path
    // typing a PO number and hitting Next would take.
    state.qaType = params.get('mode');
    appMode = 'wizard';
    goTo(0);
    render();
    const poInput = document.getElementById('poLookupInput');
    if (poInput) {
      poInput.value = params.get('po');
      await submitPoLookup();
    }
  }
  updateProgressForMode();
  render();
})();
