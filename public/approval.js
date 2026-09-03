/* Juniper QA/QC Approval - Sample / Pre-Production / Bulk Approval workflows */

let I18N = {};
let OPTIONS = {};
let CONFIG = {};

const OTHER_FIT_VALUE = '__other_fit__';
const OTHER_VALUE = '__other__';

/** Only the fit standards belonging to the PO's subcategory group (e.g. only
 *  hoodie fits for a hoodie PO) - mirrors the same filtering the Reporting
 *  flow already does, so the dropdown here isn't showing irrelevant options. */
function fitsForPoSubcategory() {
  const allFits = (CONFIG.fits && CONFIG.fits.fits) || {};
  const cats = (CONFIG.categories && CONFIG.categories.categories) || {};
  const catDef = approvalState.po && cats[approvalState.po.category];
  const sub = catDef && (catDef.subcategories || []).find((s) => s.key === approvalState.po.subcategory);
  const group = sub ? sub.fitGroup : null;
  if (!group) return allFits;
  const filtered = {};
  Object.keys(allFits).forEach((key) => { if (allFits[key].group === group) filtered[key] = allFits[key]; });
  return Object.keys(filtered).length ? filtered : allFits;
}

/** Client-side copies of the same tolerance/formatting logic used server-side
 *  (lib/passFail.js) and in the Reporting flow, so the measurement table here
 *  flags out-of-tolerance entries the same way. */
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

const STAGE_LABELS = {
  sample: { titleKey: 'sampleApprovalTitle', apiPath: 'sample' },
  preProduction: { titleKey: 'preProductionApprovalTitle', apiPath: 'preProduction' },
  bulk: { titleKey: 'bulkApprovalTitle', apiPath: 'bulk' }
};

const approvalState = {
  stage: null, // 'sample' | 'preProduction' | 'bulk'
  poNumberInput: '',
  po: null,
  photoSet: null,
  approval: null,
  priorSampleApproval: null,
  reportingHistory: null,
  // working fields
  factoryCode: '', qaLead: '', productRisk: 'medium',
  fit: '', sizeRows: [], customSizeRows: [], customPoints: [], _fitForRows: null, chinaApprovalStatus: '', sampledSize: '',
  dimensions: { height: '', width: '', depth: '', notes: '' }, simpleSizeValue: '',
  photos: {}, // slotKey (or slotKey__SizeName) -> [] of File
  notes: '', notesPhotos: [],
  replyDrafts: {} // { sample: {author, approvalStatus, text}, preProduction: {...}, bulk: {...} }
};

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
function openLightbox(url) {
  const overlay = document.getElementById('lightboxOverlay');
  const img = document.getElementById('lightboxImg');
  img.src = url;
  overlay.classList.remove('hidden');
}

/* ---- Compare mode: pick two photos anywhere on the page, view them large
 * side by side with independent zoom/pan. Toggling the mode changes what a
 * click on any lightbox-eligible photo does, rather than requiring new
 * markup at every one of the many places photos are already rendered. ---- */
let compareMode = false;
let compareSelection = []; // up to 2 image URLs

/* ---- Report Reference selection: pick one photo or sizing-chart row
 * anywhere on the page to attach to a specific reply draft. Only one
 * reply form can be actively selecting at a time (tracked by stage key),
 * and it takes priority over Compare Mode if both are somehow active. ---- */
let referenceSelectStage = null;

function startReferenceSelect(stage) {
  // Starting a reference pick always wins over an in-progress photo
  // compare, since only one "what does a click do right now" mode makes
  // sense at a time.
  compareMode = false;
  compareSelection = [];
  referenceSelectStage = (referenceSelectStage === stage) ? null : stage; // click again to cancel
  render();
}

function pickReferenceTarget(ref) {
  const stage = referenceSelectStage;
  if (!stage) return;
  if (!approvalState.replyDrafts[stage]) approvalState.replyDrafts[stage] = { author: '', approvalStatus: '', text: '', reference: null };
  approvalState.replyDrafts[stage].reference = ref;
  referenceSelectStage = null;
  render();
  const btn = document.querySelector(`[data-start-reference-select="${stage}"]`);
  if (btn) btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function updateCompareToggleButton() {
  const btn = document.getElementById('compareModeToggle');
  const label = document.getElementById('compareToggleLabel');
  if (!btn || !label) return;
  btn.classList.toggle('active', compareMode);
  if (!compareMode) {
    label.textContent = `${bi('comparePhotos', 'Compare Photos').en} / ${bi('comparePhotos', 'Compare Photos').zh}`;
  } else {
    const remaining = 2 - compareSelection.length;
    label.textContent = remaining > 0
      ? `${bi('selectNPhotos', 'Select {n} more photo(s)').en.replace('{n}', remaining)} / ${bi('selectNPhotos', 'Select {n} more photo(s)').zh.replace('{n}', remaining)}`
      : `${bi('exitCompareMode', 'Exit Compare Mode').en} / ${bi('exitCompareMode', 'Exit Compare Mode').zh}`;
  }
}

function applyCompareSelectionHighlights() {
  document.querySelectorAll('.js-lightbox').forEach((el) => {
    el.classList.toggle('compare-selected', compareSelection.includes(el.getAttribute('src')));
  });
}

function toggleCompareSelection(url) {
  const idx = compareSelection.indexOf(url);
  if (idx !== -1) {
    compareSelection.splice(idx, 1);
  } else {
    if (compareSelection.length >= 2) compareSelection.shift(); // drop the oldest, keep the newest 2
    compareSelection.push(url);
  }
  applyCompareSelectionHighlights();
  updateCompareToggleButton();
  if (compareSelection.length === 2) {
    openCompareOverlay(compareSelection[0], compareSelection[1]);
  }
}

function attachLightboxHandlers() {
  document.querySelectorAll('.js-lightbox').forEach((el) => {
    el.addEventListener('click', () => {
      const url = el.getAttribute('src');
      if (referenceSelectStage) {
        const items = getReferenceableItems(referenceSelectStage);
        const match = items.find((it) => it.type === 'photo' && it.targetId === url);
        pickReferenceTarget({ type: 'photo', targetId: url, label: match ? match.label : bi('referencePhotoFallback', 'Photo').en });
        return;
      }
      if (compareMode) toggleCompareSelection(url);
      else openLightbox(url);
    });
    el.classList.toggle('reference-selectable', !!referenceSelectStage);
  });
  document.querySelectorAll('[data-size-cell-target]').forEach((el) => {
    el.classList.toggle('reference-selectable', !!referenceSelectStage);
    if (el._referenceClickWired) return;
    el._referenceClickWired = true;
    el.addEventListener('click', () => {
      if (!referenceSelectStage) return;
      const cellTarget = el.getAttribute('data-size-cell-target');
      const label = el.getAttribute('data-size-cell-label') || cellTarget;
      pickReferenceTarget({ type: 'sizeCell', targetId: cellTarget, label: `${bi('sizeChartRefLabel', 'Size chart').en}: ${label}` });
    });
  });
  applyCompareSelectionHighlights();
  const overlay = document.getElementById('lightboxOverlay');
  if (overlay && !overlay._wired) {
    overlay.addEventListener('click', () => overlay.classList.add('hidden'));
    overlay._wired = true;
  }
}

/* ---- Compare overlay: independent zoom/pan per pane (wheel, +/- buttons,
 * drag, and two-finger pinch), all driven by simple scale/translate state
 * per pane rather than a full gesture library. ---- */
const comparePaneState = [
  { scale: 1, tx: 0, ty: 0 },
  { scale: 1, tx: 0, ty: 0 }
];
const COMPARE_MIN_SCALE = 1;
const COMPARE_MAX_SCALE = 6;

function applyComparePaneTransform(idx) {
  const img = document.querySelector(`[data-compare-img="${idx}"]`);
  if (!img) return;
  const s = comparePaneState[idx];
  img.style.transform = `translate(calc(-50% + ${s.tx}px), calc(-50% + ${s.ty}px)) scale(${s.scale})`;
}

function resetComparePane(idx) {
  comparePaneState[idx] = { scale: 1, tx: 0, ty: 0 };
  applyComparePaneTransform(idx);
}

function setComparePaneScale(idx, newScale) {
  const s = comparePaneState[idx];
  s.scale = Math.min(COMPARE_MAX_SCALE, Math.max(COMPARE_MIN_SCALE, newScale));
  if (s.scale === COMPARE_MIN_SCALE) { s.tx = 0; s.ty = 0; } // back to fully zoomed out - recenter
  applyComparePaneTransform(idx);
}

function openCompareOverlay(urlA, urlB) {
  document.querySelector('[data-compare-img="0"]').src = urlA;
  document.querySelector('[data-compare-img="1"]').src = urlB;
  resetComparePane(0);
  resetComparePane(1);
  document.getElementById('compareOverlay').classList.remove('hidden');
}

function closeCompareOverlay() {
  document.getElementById('compareOverlay').classList.add('hidden');
  compareSelection = [];
  applyCompareSelectionHighlights();
  updateCompareToggleButton();
}

function initCompareFeature() {
  const toggleBtn = document.getElementById('compareModeToggle');
  toggleBtn.addEventListener('click', () => {
    compareMode = !compareMode;
    compareSelection = [];
    applyCompareSelectionHighlights();
    updateCompareToggleButton();
  });
  updateCompareToggleButton();

  document.getElementById('compareCloseBtn').addEventListener('click', closeCompareOverlay);

  [0, 1].forEach((idx) => {
    const viewport = document.querySelector(`[data-compare-pane="${idx}"] .compare-pane-viewport`);
    document.querySelector(`[data-compare-zoom-in="${idx}"]`).addEventListener('click', () => setComparePaneScale(idx, comparePaneState[idx].scale + 0.5));
    document.querySelector(`[data-compare-zoom-out="${idx}"]`).addEventListener('click', () => setComparePaneScale(idx, comparePaneState[idx].scale - 0.5));
    const resetBtn = document.querySelector(`[data-compare-zoom-reset="${idx}"]`);
    resetBtn.textContent = `${bi('resetZoom', 'Reset').en} / ${bi('resetZoom', 'Reset').zh}`;
    resetBtn.addEventListener('click', () => resetComparePane(idx));

    // Mouse wheel zoom
    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      setComparePaneScale(idx, comparePaneState[idx].scale + (e.deltaY < 0 ? 0.3 : -0.3));
    }, { passive: false });

    // Drag to pan (mouse)
    let dragging = false;
    let lastX = 0, lastY = 0;
    viewport.addEventListener('mousedown', (e) => {
      if (comparePaneState[idx].scale <= COMPARE_MIN_SCALE) return;
      dragging = true;
      lastX = e.clientX; lastY = e.clientY;
      viewport.classList.add('dragging');
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      comparePaneState[idx].tx += e.clientX - lastX;
      comparePaneState[idx].ty += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      applyComparePaneTransform(idx);
    });
    window.addEventListener('mouseup', () => { dragging = false; viewport.classList.remove('dragging'); });

    // Touch: single-finger drag to pan, two-finger pinch to zoom
    let touchMode = null; // 'drag' | 'pinch'
    let pinchStartDist = 0;
    let pinchStartScale = 1;
    const touchDist = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    viewport.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1 && comparePaneState[idx].scale > COMPARE_MIN_SCALE) {
        touchMode = 'drag';
        lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        touchMode = 'pinch';
        pinchStartDist = touchDist(e.touches);
        pinchStartScale = comparePaneState[idx].scale;
      }
    }, { passive: true });
    viewport.addEventListener('touchmove', (e) => {
      if (touchMode === 'drag' && e.touches.length === 1) {
        e.preventDefault();
        comparePaneState[idx].tx += e.touches[0].clientX - lastX;
        comparePaneState[idx].ty += e.touches[0].clientY - lastY;
        lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
        applyComparePaneTransform(idx);
      } else if (touchMode === 'pinch' && e.touches.length === 2) {
        e.preventDefault();
        const newDist = touchDist(e.touches);
        setComparePaneScale(idx, pinchStartScale * (newDist / pinchStartDist));
      }
    }, { passive: false });
    viewport.addEventListener('touchend', () => { touchMode = null; });
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

async function loadConfig() {
  const res = await fetch('/api/config');
  CONFIG = await res.json();
  I18N = CONFIG.i18n || {};
  OPTIONS = CONFIG.options || {};
}

/* ---------------- ROUTING / STATE ---------------- */

/** Puts a PO's sizes in Youth XS -> Adult 5XL order (matching
 *  fits.json's universalSizes), regardless of what order they were
 *  originally selected/stored in - fixes display for POs created before
 *  this sort was applied at save time too. */
function sortSizesCanonically(sizes) {
  const canonical = (CONFIG.fits && CONFIG.fits.universalSizes) || [];
  return [...(sizes || [])].sort((a, b) => {
    const ia = canonical.indexOf(a);
    const ib = canonical.indexOf(b);
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

async function loadApprovalForPo(poNumber) {
  const res = await fetch(`/api/approval/${encodeURIComponent(poNumber)}`);
  if (!res.ok) return false;
  const data = await res.json();
  approvalOtherModeFlags.factoryCode = false;
  approvalOtherModeFlags.qaLead = false;
  Object.keys(replyAuthorOtherMode).forEach((k) => { delete replyAuthorOtherMode[k]; });
  approvalState.po = data.po;
  if (approvalState.po && approvalState.po.sizesIncluded) {
    approvalState.po.sizesIncluded = sortSizesCanonically(approvalState.po.sizesIncluded);
  }
  approvalState.photoSet = data.photoSet;
  approvalState.approval = data.approval;
  approvalState.priorSampleApproval = data.priorSampleApproval;
  approvalState.reportingHistory = data.reportingHistory;
  approvalState.stage = determineCurrentStage(data.approval);

  // Pre-fill the Sample-stage setup from what the Order Management
  // specialist already entered on the PO (risk, factory code, sizing) -
  // the OM setup is now where that information gets entered first, so PD
  // approval starts from it instead of blank defaults, and a risk change
  // made in Order Management shows up here too. Only while the sample
  // stage hasn't been submitted yet: after submission, the submitted
  // record is the source of truth for what was actually approved.
  if (!data.approval.sampleApproval.submitted && data.po) {
    approvalState.productRisk = data.po.productRisk || 'medium';
    if (data.po.factoryCode) approvalState.factoryCode = data.po.factoryCode;

    const dt = data.po.dimensionsTable;
    if (data.po.category === 'apparel' && dt && dt.sizes && Object.keys(dt.sizes).length) {
      const knownFits = (CONFIG.fits && CONFIG.fits.fits) || {};
      if (dt.standardKey && knownFits[dt.standardKey]) {
        // The PO's sizing was built from a known standard - load that fit
        // with the PO's own (possibly adjusted) measurements, not the
        // generic template values.
        approvalState.fit = dt.standardKey;
        approvalState.sizeRows = Object.keys(dt.sizes).map((size) => {
          const measured = {};
          Object.entries(dt.sizes[size] || {}).forEach(([point, v]) => {
            if (v !== '' && v !== null && v !== undefined) measured[point] = String(v);
          });
          return { size, measured };
        });
        approvalState._fitForRows = dt.standardKey;
      } else {
        // Fully custom sizing (no known standard behind it) - map into the
        // free-form custom size chart instead.
        approvalState.fit = OTHER_FIT_VALUE;
        approvalState.customSizeRows = Object.keys(dt.sizes).map((size) => ({
          sizeName: size,
          measurements: Object.entries(dt.sizes[size] || {})
            .filter(([, v]) => v !== '' && v !== null && v !== undefined)
            .map(([point, v]) => `${(dt.pointLabels && dt.pointLabels[point] && dt.pointLabels[point].en) || point}: ${v}`)
            .join(', ')
        }));
      }
    } else if (data.po.category !== 'apparel') {
      // Non-apparel: plain L/W/H from the PO's Product Documentation.
      // OM's "Length" maps to approval's "Depth" - same third axis.
      if (data.po.dimensionsHeight != null) approvalState.dimensions.height = String(data.po.dimensionsHeight);
      if (data.po.dimensionsWidth != null) approvalState.dimensions.width = String(data.po.dimensionsWidth);
      if (data.po.dimensionsLength != null) approvalState.dimensions.depth = String(data.po.dimensionsLength);
    }
  }
  return true;
}

/** What the Juniper China team should upload next - the first stage that
 *  hasn't been submitted yet. */
function determineCurrentStage(approval) {
  if (!approval.sampleApproval.submitted) return 'sample';
  if (!approval.preProductionApproval.submitted && !approval.preProductionApproval.skipped) return 'preProduction';
  return 'bulk';
}

async function initFromLink() {
  const params = new URLSearchParams(location.search);
  const poId = params.get('po');
  if (!poId) return false;
  try {
    const res = await fetch(`/api/purchase-orders/${encodeURIComponent(poId)}`);
    if (!res.ok) return false;
    const { po } = await res.json();
    const ok = await loadApprovalForPo(po.poNumber);
    return ok;
  } catch (e) {
    console.error(e);
    return false;
  }
}

/* ---------------- RENDER ---------------- */

function render() {
  const root = document.getElementById('approvalRoot');
  if (!approvalState.po) { root.innerHTML = renderPoEntry(); attachPoEntryHandlers(); return; }
  root.innerHTML = renderApprovalFullPage();
  attachStageHandlers();
  attachLightboxHandlers();
}

function backHomeLink() {
  return ''; // redundant now that the persistent sidebar handles navigation
}

function renderPoEntry() {
  return `
    ${backHomeLink()}
    <div class="step-title">产品开发审批<span class="zh">Product Development Approval</span></div>
    <div class="card">
      <div class="field">
        <label class="field-label">${biBlockHtml('poNumber', 'Purchase Order Number')}</label>
        <input type="text" id="poEntryInput" value="${escapeHtml(approvalState.poNumberInput)}" placeholder="${escapeHtml(bi('poNumberPlaceholder').en)}" />
      </div>
      <button class="btn btn-primary" id="btnPoEntrySubmit" style="margin-top:10px;">${biBlockHtml('next', 'Next')}</button>
    </div>
  `;
}
function attachPoEntryHandlers() {
  const input = document.getElementById('poEntryInput');
  if (input) input.addEventListener('input', (e) => { approvalState.poNumberInput = e.target.value; });
  const btn = document.getElementById('btnPoEntrySubmit');
  if (btn) {
    btn.addEventListener('click', async () => {
      const po = approvalState.poNumberInput.trim();
      if (!po) return;
      btn.disabled = true;
      const ok = await loadApprovalForPo(po);
      if (!ok) {
        showToast(bi('poNotFound').en + ' / ' + bi('poNotFound').zh, true);
        btn.disabled = false;
        return;
      }
      render();
    });
  }
}

/* ---------------- STAGE SCREEN ---------------- */

/** "Juniper China Approval" section - their own self-assessment when they
 *  uploaded photos: Approved / Approved with Comments / Minor Issue / Major
 *  or Critical Issue, plus their notes if any were required or added. Older
 *  data submitted before this field existed defaults to "Approved". */
function renderStageNotesCard(stage, stageData) {
  if (!stageData || !stageData.submitted || !stageData.data) return '';
  const notes = stageData.data.notes;

  if (stage === 'sample') {
    // Golden Sample doesn't carry an approval decision from China - just a
    // record of who submitted it and any notes they added.
    const submitter = stageData.data.qaLead || '-';
    return `
      <div class="defect-card comment-card comment-approved">
        <div class="prior-issue-header">
          <span class="prior-issue-desc" style="font-weight:700;">${escapeHtml(submitter)} ${escapeHtml(bi('submittedVerb').en)}<span class="zh">${escapeHtml(submitter)} ${escapeHtml(bi('submittedVerb').zh)}</span></span>
        </div>
        ${notes && notes.trim() ? `<div class="prior-issue-desc" style="margin-top:4px;">${escapeHtml(notes)}</div>` : ''}
        ${(stageData.data.photos && stageData.data.photos.notesPhotos || []).map((u) => `<img src="${escapeHtml(u)}" class="prior-issue-photo js-lightbox" data-photo-target="${escapeHtml(u)}" />`).join('')}
      </div>
    `;
  }

  const status = stageData.data.chinaApprovalStatus || 'approved';
  const colorClass = approvalStatusColorClass(status);
  return `
    <div class="defect-card comment-card ${colorClass}">
      <div class="prior-issue-header">
        <span class="prior-issue-desc" style="font-weight:700;">${escapeHtml(bi(approvalStatusLabelKey(status)).en)}<span class="zh">${escapeHtml(bi(approvalStatusLabelKey(status)).zh)}</span></span>
      </div>
      ${notes && notes.trim() ? `<div class="prior-issue-desc" style="margin-top:4px;">${escapeHtml(notes)}</div>` : ''}
      ${(stageData.data.photos && stageData.data.photos.notesPhotos || []).map((u) => `<img src="${escapeHtml(u)}" class="prior-issue-photo js-lightbox" data-photo-target="${escapeHtml(u)}" />`).join('')}
    </div>
  `;
}

/** The actual filed QA/QC inspection report(s) for this PO, matching this
 *  stage's qaType (Pre-Production or Bulk - Sample Approval has none). */
/** Builds one linked-report card - date/result, spot check % (Bulk only),
 *  the full issue list, and the download link. Shared by both the
 *  pre-submission upload form (where China should see what was already
 *  found before they submit their own approval) and the post-submission
 *  thread view, so issues show up consistently in either place. */
function renderLinkedReportCard(r, stage) {
  const resultLabel = r.overallResult === 'pass' ? bi('resultPass') : bi('resultFail');
  const hasIssues = r.issues && r.issues.length;
  const reportColorClass = r.overallResult !== 'pass' ? 'comment-major' : (hasIssues ? 'comment-minor' : 'comment-approved');
  // Spot check % only makes sense for Bulk - Pre-Production doesn't use
  // formal AQL sampling, so there's no meaningful percentage to show there.
  const spotCheckPct = (stage === 'bulk' && r.actualUnitsChecked && r.poQuantity)
    ? Math.round((r.actualUnitsChecked / r.poQuantity) * 1000) / 10
    : null;
  const issuesHtml = hasIssues
    ? r.issues.map((iss) => {
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
      }).join('')
    : '';
  return `
    <div class="defect-card comment-card ${reportColorClass}">
      <div class="section-photos-label">${escapeHtml(bi('linkedReportTitle').en)} ${escapeHtml(bi('linkedReportTitle').zh)}</div>
      <div class="section-help">
        ${escapeHtml(r.date || '')} ·
        <strong style="color:${r.overallResult === 'pass' ? 'var(--jc-teal-dark)' : 'var(--jc-fail)'}">${escapeHtml(resultLabel.en)} ${escapeHtml(resultLabel.zh)}</strong>
      </div>
      ${spotCheckPct !== null ? `<div class="section-help">${escapeHtml(bi('spotCheckPercentLabel').en)} ${escapeHtml(bi('spotCheckPercentLabel').zh)}: <strong>${spotCheckPct}%</strong> (${r.actualUnitsChecked} / ${r.poQuantity})</div>` : ''}
      ${issuesHtml}
      <a href="/submissions/${encodeURIComponent(r.pdfFilename)}" target="_blank" rel="noopener" class="btn btn-secondary" style="display:block; text-decoration:none; text-align:center; margin-top:8px; max-width:220px;">${biBlockHtml('downloadFullReport', 'Download Full Report')}</a>
    </div>
  `;
}

function renderLinkedReportForStage(stage) {
  if (stage === 'sample') return ''; // Sample/Golden Approval has no corresponding Reporting-side inspection
  const qaType = stage === 'preProduction' ? 'pre_production' : 'production';
  const currentPoReports = (approvalState.reportingHistory || []).filter((r) => r.poNumber === approvalState.po.poNumber && r.qaType === qaType);
  if (!currentPoReports.length) return '';
  return currentPoReports.map((r) => renderLinkedReportCard(r, stage)).join('');
}

/** One comment/reply card. The very first comment on a stage carries the
 *  formal approval decision; anything after that is a lighter-weight reply
 *  in the same thread (approvalStatus is optional for those). */
function renderCommentCard(c, stage) {
  const stageTitle = commentStageTitle(stage);
  const colorClass = c.approvalStatus ? approvalStatusColorClass(c.approvalStatus) : 'comment-general';
  const badge = c.approvalStatus
    ? `<span class="severity-badge comment-badge-${colorClass}">${escapeHtml(bi(approvalStatusLabelKey(c.approvalStatus)).en)} ${escapeHtml(bi(approvalStatusLabelKey(c.approvalStatus)).zh)}</span>`
    : '';
  const headerText = c.approvalStatus
    ? commentActionSentence(c, stageTitle)
    : `${escapeHtml(c.author)} ${escapeHtml(bi('commentVerbCommented').en)} ${escapeHtml(stageTitle.en)}<span class="zh">${escapeHtml(c.author)} ${escapeHtml(bi('commentVerbCommented').zh)} ${escapeHtml(stageTitle.zh)}</span>`;
  return `
    <div class="defect-card comment-card ${colorClass}">
      <div class="prior-issue-header">
        <span class="prior-issue-desc" style="font-weight:700;">${headerText}</span>
        ${badge}
      </div>
      ${c.text ? `<div class="prior-issue-desc" style="margin-top:4px;">${escapeHtml(c.text)}</div>` : `<div class="prior-issue-desc" style="margin-top:4px; font-style:italic; color:var(--jc-muted);">${escapeHtml(bi('noCommentTextProvided').en)}<span class="zh">${escapeHtml(bi('noCommentTextProvided').zh)}</span></div>`}
      ${c.reference ? renderCommentReferenceAttachment(c.reference) : ''}
      <div class="section-help">${escapeHtml(c.author)} · ${new Date(c.timestamp).toLocaleString()}</div>
      ${(c.photos || []).map((url) => `<img src="${escapeHtml(url)}" class="prior-issue-photo js-lightbox" data-photo-target="${escapeHtml(url)}" />`).join('')}
    </div>
  `;
}

/** A submitted comment's "Report Attachment" - a small labeled thumbnail
 *  for a photo reference, or a text chip for a size-chart reference.
 *  Either way, clicking it jumps to and highlights the live original. */
function renderCommentReferenceAttachment(ref) {
  const label = `📎 ${escapeHtml(bi('reportAttachment', 'Report Attachment').en)} / ${escapeHtml(bi('reportAttachment').zh)}`;
  if (ref.type === 'photo') {
    return `
      <div class="reference-preview" style="margin-top:8px;">
        <img src="${escapeHtml(ref.targetId)}" class="reference-preview-thumb" data-scroll-to-reference='${escapeHtml(JSON.stringify(ref))}' title="${escapeHtml(ref.label)}" />
        <span class="section-help">${label}</span>
      </div>
    `;
  }
  return `<button type="button" class="reference-chip" data-scroll-to-reference='${escapeHtml(JSON.stringify(ref))}' style="display:block;">${label}: ${escapeHtml(ref.label)}</button>`;
}

/** The comment/reply form for a stage. First-ever comment requires an
 *  Approval decision; once a thread exists, it's just Name + Comment (a
 *  reply), matching "after PD submits their approval, a lighter discussion
 *  box appears for back-and-forth." */
const replyAuthorOtherMode = {};

/** Names actually associated with this PO - its Product Development Lead
 *  plus whichever QA/QC Lead(s) have submitted a stage so far - so the
 *  reply name field offers a short, relevant list instead of either a
 *  blank text box or the full global list of every PD lead in the app. */
/** Names actually associated with this PO: its Product Development Lead
 *  (set on the New Purchase Order form) and the QA/QC Lead who submitted
 *  the initial Golden Sample - specifically that stage, not whichever QA
 *  contact later handles Pre-Production or Bulk, which can be a different
 *  person. Offers a short, relevant list for the reply name field instead
 *  of either a blank text box or the full global list of every PD lead. */
function poAssociatedNames() {
  const names = [];
  const add = (n) => { if (n && !names.includes(n)) names.push(n); };
  add(approvalState.po.productDevelopmentLead);
  const sample = approvalState.approval.sampleApproval;
  if (sample && sample.submitted && sample.data) add(sample.data.qaLead);
  return names;
}

/** Everything a comment on this stage could point at: every uploaded
 *  photo, plus (Golden Sample only, since that's the one stage with its
 *  own inline size chart in Approval) every size row. Used to populate
 *  the "Reference" picker in the reply form. */
function getReferenceableItems(stage) {
  const stageKeyMap = { sample: 'sampleApproval', preProduction: 'preProductionApproval', bulk: 'bulkApproval' };
  const stageData = approvalState.approval[stageKeyMap[stage]];
  const items = [];
  if (!stageData || !stageData.submitted || !stageData.data) return items;

  const photos = stageData.data.photos || {};
  Object.keys(photos).forEach((slotKey) => {
    const urls = photos[slotKey] || [];
    const [baseSlot, sizeName] = slotKey.split('__');
    const slotLabel = photoSetLabelFor(baseSlot);
    const niceLabel = sizeName ? `${slotLabel.zh || slotLabel.en} ${slotLabel.en} - ${sizeName}` : `${slotLabel.zh || slotLabel.en} ${slotLabel.en}`;
    urls.forEach((url, idx) => {
      items.push({ type: 'photo', targetId: url, label: urls.length > 1 ? `${niceLabel} #${idx + 1}` : niceLabel });
    });
  });

  if (stage === 'sample' && stageData.data.sizing && Array.isArray(stageData.data.sizing.sizeRows)) {
    stageData.data.sizing.sizeRows.forEach((row) => {
      items.push({ type: 'size', targetId: row.size, label: `${bi('sizeChartRefLabel', 'Size chart').en}: ${row.size}` });
    });
  }
  return items;
}

function renderReplyForm(stage, hasComments) {
  const draft = approvalState.replyDrafts[stage] || { author: '', approvalStatus: '', text: '', reference: null };
  const pdOptions = OPTIONS.productDevelopmentLeads || [];
  const isOther = replyAuthorOtherMode[stage] || (!!draft.author && !pdOptions.includes(draft.author));
  const poNames = poAssociatedNames();
  const isReplyOther = replyAuthorOtherMode[stage] || (!!draft.author && !poNames.includes(draft.author));
  const nameField = !hasComments
    ? `
      <div class="field">
        <label class="field-label">${escapeHtml(bi('productDevelopmentLead').en)} <span class="zh">${escapeHtml(bi('productDevelopmentLead').zh)}</span></label>
        <select data-reply-author-select="${stage}">
          <option value="">${escapeHtml(bi('selectPlaceholder').en)}</option>
          ${pdOptions.map((o) => `<option value="${escapeHtml(o)}" ${!isOther && draft.author === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
          <option value="${OTHER_VALUE}" ${isOther ? 'selected' : ''}>${escapeHtml(bi('other').en)} / ${escapeHtml(bi('other').zh)}</option>
        </select>
        ${isOther ? `<input type="text" data-reply-author="${stage}" value="${escapeHtml(draft.author)}" placeholder="${escapeHtml(bi('otherPlaceholder').en)} / ${escapeHtml(bi('otherPlaceholder').zh)}" style="margin-top:8px;" />` : ''}
      </div>
    `
    : `
      <div class="field">
        <label class="field-label">${biBlockHtml('yourName', 'Your Name')}</label>
        <select data-reply-author-select="${stage}">
          <option value="">${escapeHtml(bi('selectPlaceholder').en)}</option>
          ${poNames.map((o) => `<option value="${escapeHtml(o)}" ${!isReplyOther && draft.author === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
          <option value="${OTHER_VALUE}" ${isReplyOther ? 'selected' : ''}>${escapeHtml(bi('other').en)} / ${escapeHtml(bi('other').zh)}</option>
        </select>
        ${isReplyOther ? `<input type="text" data-reply-author="${stage}" value="${escapeHtml(draft.author)}" placeholder="${escapeHtml(bi('otherPlaceholder').en)} / ${escapeHtml(bi('otherPlaceholder').zh)}" style="margin-top:8px;" />` : ''}
      </div>
    `;
  return `
    <div style="margin-top:14px; padding-top:14px; border-top:1px dashed var(--jc-border);" data-reply-form="${stage}">
      <div class="section-title" style="font-size:15px;">${hasComments ? biBlockHtml('additionalCommentsTitle', 'Additional Comments') : biBlockHtml('pdApprovalSectionTitle', 'Product Development Approval')}</div>
      ${nameField}
      <div class="field">
        <label class="field-label">${biBlockHtml('approvalStatusLabel', 'Approval')}${!hasComments ? '<span class="required">*</span>' : ''}</label>
        <select data-reply-status="${stage}">
          <option value="">${escapeHtml(bi(hasComments ? 'noStatusChange' : 'selectPlaceholder').en)} / ${escapeHtml(bi(hasComments ? 'noStatusChange' : 'selectPlaceholder').zh)}</option>
          <option value="approved" ${draft.approvalStatus === 'approved' ? 'selected' : ''}>${escapeHtml(bi('statusApproved').en)} ${escapeHtml(bi('statusApproved').zh)}</option>
          <option value="approvedWithComments" ${draft.approvalStatus === 'approvedWithComments' ? 'selected' : ''}>${escapeHtml(bi('statusApprovedWithComments').en)} ${escapeHtml(bi('statusApprovedWithComments').zh)}</option>
          <option value="majorCriticalIssue" ${draft.approvalStatus === 'majorCriticalIssue' ? 'selected' : ''}>${escapeHtml(bi('statusMajorCriticalIssue').en)} ${escapeHtml(bi('statusMajorCriticalIssue').zh)}</option>
        </select>
      </div>
      <div class="field">
        <label class="field-label">${biBlockHtml('commentText', 'Comment')}</label>
        <textarea data-reply-text="${stage}" placeholder="${escapeHtml(bi(hasComments ? 'replyPlaceholder' : 'commentPlaceholder').en)}">${escapeHtml(draft.text)}</textarea>
      </div>
      <div class="field">
        <label class="field-label">${biBlockHtml('attachmentsTitle', 'Attachments')}</label>
        ${renderPhotoSlot('_reply_' + stage, 'Photos', '照片', null, true)}
        <button type="button" class="reference-select-btn ${referenceSelectStage === stage ? 'active' : ''}" data-start-reference-select="${stage}" style="margin-top:10px;">
          ${referenceSelectStage === stage
            ? `${escapeHtml(bi('clickToSelectReference', 'Click a photo or sizing row to select').en)} / ${escapeHtml(bi('clickToSelectReference').zh)}`
            : `🔗 ${escapeHtml(bi('reportReference', 'Report Reference').en)} / ${escapeHtml(bi('reportReference').zh)}`}
        </button>
        ${draft.reference ? renderSelectedReferencePreview(draft.reference, stage) : ''}
      </div>
      <button type="button" class="btn btn-primary" data-submit-reply="${stage}" style="margin-top:10px;">${biBlockHtml(hasComments ? 'submitReply' : 'submitApproval', hasComments ? 'Submit Reply' : 'Submit Approval')}</button>
    </div>
  `;
}

/** The reply draft's currently-picked reference, shown right in the reply
 *  form so it's clear something was selected. A photo reference gets an
 *  actual thumbnail (closest to how commenting directly on an image looks
 *  in a doc editor); a size-chart reference is a text chip, since there's
 *  no single image to show. Both are clickable to jump to and highlight
 *  the live original, and both have a small "x" to clear the pick. */
function renderSelectedReferencePreview(ref, stage) {
  const removeBtn = `<button type="button" class="reference-preview-remove" data-clear-reference="${stage}" title="${escapeHtml(bi('remove', 'Remove').en)}">✕</button>`;
  if (ref.type === 'photo') {
    return `
      <div class="reference-preview">
        <img src="${escapeHtml(ref.targetId)}" class="reference-preview-thumb" data-scroll-to-reference='${escapeHtml(JSON.stringify(ref))}' />
        ${removeBtn}
      </div>
    `;
  }
  return `
    <div class="reference-preview">
      <button type="button" class="reference-chip" data-scroll-to-reference='${escapeHtml(JSON.stringify(ref))}'>🔗 ${escapeHtml(ref.label)}</button>
      ${removeBtn}
    </div>
  `;
}

/** Everything for one stage once it's been submitted: notes, linked report
 *  (Pre-Production/Bulk only), the comment thread, and the reply form. */
function renderStageThread(stage, stageData) {
  const comments = stageData.pdComments || [];
  const isActive = stage === latestSubmittedStage();

  // Plain chronological thread - a rejection followed later by a separate
  // approval shows exactly like that (two distinct comments in order,
  // each with its own status badge), rather than the most recent status
  // jumping to the top as if it were the only decision that happened.
  const pdApprovalHtml = comments.length
    ? `
      <div class="section-title" style="font-size:15px; margin-top:14px;">${biBlockHtml('pdApprovalSectionTitle', 'Product Development Approval')}</div>
      ${comments.map((c) => renderCommentCard(c, stage)).join('')}
    `
    : (isActive ? '' : `
      <div class="section-title" style="font-size:15px; margin-top:14px;">${biBlockHtml('pdApprovalSectionTitle', 'Product Development Approval')}</div>
      <div class="section-help">${escapeHtml(bi('noCommentsYet').en)}<br/>${escapeHtml(bi('noCommentsYet').zh)}</div>
    `);

  return `
    <div class="section-help">${new Date(stageData.submittedAt).toLocaleString()}</div>
    ${renderLinkedReportForStage(stage)}
    <div class="section-title" style="font-size:15px; margin-top:14px;">${biBlockHtml(stage === 'sample' ? 'chinaSubmissionSectionTitle' : 'chinaApprovalSectionTitle', stage === 'sample' ? 'Juniper China QA/QC Submission' : 'Juniper China Approval')}</div>
    ${renderStageNotesCard(stage, stageData)}
    ${pdApprovalHtml}
    ${isActive ? renderReplyForm(stage, comments.length > 0) : ''}
  `;
}

/** One block per stage - shown once it's either submitted (read + thread) or
 *  it's the next thing to do (upload form / "not ready" for PD). Stages
 *  further out than that don't render at all yet. */
function renderStageBlock(stage) {
  const stageKeyMap = { sample: 'sampleApproval', preProduction: 'preProductionApproval', bulk: 'bulkApproval' };
  const stageData = approvalState.approval[stageKeyMap[stage]];
  const titleHtml = `<div class="step-title" style="font-size:20px; margin-top:20px; margin-bottom:10px;">${biBlockHtml(STAGE_LABELS[stage].titleKey)}</div>`;

  if (stageData.submitted) {
    return `
      ${titleHtml}
      <div class="card">
        ${renderStageThread(stage, stageData)}
      </div>
    `;
  }
  if (stageData.skipped) {
    return `
      ${titleHtml}
      <div class="card" style="background:var(--jc-mint-light); border-color:var(--jc-teal);">
        <div class="section-title">${biBlockHtml('stageSkippedTitle', 'Skipped')}</div>
        <div class="section-help">${escapeHtml(bi('stageSkippedHelp', 'This stage was intentionally bypassed for this PO.').en)}<br/>${escapeHtml(bi('stageSkippedHelp', 'This stage was intentionally bypassed for this PO.').zh)}</div>
        ${stageData.skippedAt ? `<div class="section-help">${new Date(stageData.skippedAt).toLocaleString()}</div>` : ''}
      </div>
    `;
  }
  if (stage === approvalState.stage) {
    return `${titleHtml}${stage === 'sample' ? renderSampleApprovalForm() : renderPrePorBulkForm()}`;
  }
  return '';
}

/** Combined photo comparison across every stage submitted so far, in one
 *  grid (rows = photo slot, columns = stage) instead of scattered per block. */
function renderCombinedPhotosSection() {
  const approval = approvalState.approval;
  // Always show all 3 columns, even before later stages exist yet, so a
  // single stage's photos aren't stretched oversized across the full width.
  const columns = [
    { label: photoColumnStageLabel('sample'), photos: (approval.sampleApproval.submitted && approval.sampleApproval.data.photos) || {} },
    { label: photoColumnStageLabel('preProduction'), photos: (approval.preProductionApproval.submitted && approval.preProductionApproval.data.photos) || {} },
    { label: photoColumnStageLabel('bulk'), photos: (approval.bulkApproval.submitted && approval.bulkApproval.data.photos) || {} }
  ];
  if (!approval.sampleApproval.submitted) return '';

  const body = renderPhotoComparisonLarge(columns, approvalState.po.category, approvalState.po.sizesIncluded, approval.sampleApproval.data && approval.sampleApproval.data.sampledSize);

  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('approvedSamplePhotosReference', 'Approved Sample Photos')}</div>
      ${body}
    </div>
  `;
}

/** Read-only summary of whatever sizing was recorded during Sample Approval -
 *  shown once at the top of the page, not re-shown per stage. */
/** Renders one stage's sizing record as a readable block - a full
 *  size-by-measurement table for a standard fit, or a simpler display for
 *  the other sizing styles (custom chart, simple value, H/W/L). Returns ''
 *  if there's nothing meaningful to show. */
/** Matches a fit-specific size string (e.g. "Youth M (8/9 yrs)") back to its
 *  position in the canonical Youth XS -> Adult 5XL order, so combined rows
 *  sort correctly regardless of which fit's exact labels are in play. */
function canonicalSizeIndex(sizeStr) {
  const canonical = (CONFIG.fits && CONFIG.fits.universalSizes) || [];
  return canonical.findIndex((c) => sizeStr === c || sizeStr.startsWith(c + ' ') || sizeStr.startsWith(c + '('));
}

/** One combined table for a standard fit: every size as a row, and each
 *  measurement point split into Golden/PP/Bulk sub-columns so all three are
 *  visible side by side. PP/Bulk cells are flagged against the Golden
 *  Sample's own value for that size+point - orange if the gap is getting
 *  close to the tolerance, red if it's actually outside it. */
function renderCombinedFitSizingTable(sample, pp, bulk) {
  const fitKey = (sample && sample.fit) || (pp && pp.fit) || (bulk && bulk.fit);
  const fitDef = fitKey && CONFIG.fits && CONFIG.fits.fits && CONFIG.fits.fits[fitKey];
  if (!fitDef) return '';
  const tol = (CONFIG.fits && CONFIG.fits.toleranceCm) || 1.27;
  // Custom columns (e.g. "Inseam") live on the Golden Sample - that's the
  // one submission that actually defines them - so PP/Bulk don't need
  // their own copy for this table to pick them up correctly.
  const customPoints = (sample && Array.isArray(sample.customPoints)) ? sample.customPoints : [];
  const points = fitDef.points.concat(customPoints.map((cp) => cp.key));
  const labelFor = (p) => {
    const cp = customPoints.find((c) => c.key === p);
    if (cp) { const label = cp.label || bi('untitledColumn').en; return { en: label, zh: label }; }
    return (fitDef.pointLabels && fitDef.pointLabels[p]) || { en: p, zh: '' };
  };

  const rowsBySize = { golden: {}, pp: {}, bulk: {} };
  (sample && sample.sizeRows || []).forEach((r) => { rowsBySize.golden[r.size] = r.measured || {}; });
  (pp && pp.sizeRows || []).forEach((r) => { rowsBySize.pp[r.size] = r.measured || {}; });
  (bulk && bulk.sizeRows || []).forEach((r) => { rowsBySize.bulk[r.size] = r.measured || {}; });

  const allSizes = [...new Set([...Object.keys(rowsBySize.golden), ...Object.keys(rowsBySize.pp), ...Object.keys(rowsBySize.bulk)])]
    .sort((a, b) => canonicalSizeIndex(a) - canonicalSizeIndex(b));
  if (!allSizes.length) return '';

  const headerRow1 = points.map((p) => {
    const pl = labelFor(p);
    const label = `${pl.zh || pl.en} (cm)`;
    const labelEn = `${pl.en} (cm)`;
    return `<th colspan="3" class="size-group-start">${escapeHtml(label)}<span class="zh">${escapeHtml(labelEn)}</span></th>`;
  }).join('');
  const stageSubLabel = (key) => key === 'golden' ? bi('approvedSample', 'Approved Sample') : key === 'pp' ? bi('preProductionSampleLabel', 'Pre-Production Sample') : bi('bulkSampleLabel', 'Bulk Sample');
  const headerRow2 = points.map(() => ['golden', 'pp', 'bulk'].map((k, i) => `<th class="size-subcol ${i === 0 ? 'size-group-start' : ''}">${escapeHtml(stageSubLabel(k).en)}<span class="zh">${escapeHtml(stageSubLabel(k).zh)}</span></th>`).join('')).join('');

  const cellClass = (goldenVal, val) => {
    const g = parseFloat(goldenVal);
    const v = parseFloat(val);
    if (isNaN(g) || isNaN(v)) return '';
    const deviation = Math.abs(v - g);
    if (deviation > tol) return 'sizing-cell-red';
    if (deviation > tol * 0.6) return 'sizing-cell-orange';
    return '';
  };

  const bodyRows = allSizes.map((size) => {
    const cells = points.map((p) => {
      const goldenVal = rowsBySize.golden[size] && rowsBySize.golden[size][p];
      const ppVal = rowsBySize.pp[size] && rowsBySize.pp[size][p];
      const bulkVal = rowsBySize.bulk[size] && rowsBySize.bulk[size][p];
      const fmt = (v) => (v !== undefined && v !== '' && v !== null) ? `${v} cm` : '-';
      const pl = labelFor(p);
      const pointName = pl.zh || pl.en;
      const cellTarget = (stageKey) => `${size}|${p}|${stageKey}`;
      const cellLabel = (stageKey) => `${size} · ${pointName} · ${stageSubLabel(stageKey).zh || stageSubLabel(stageKey).en}`;
      return `
        <td class="size-group-start" data-size-cell-target="${escapeHtml(cellTarget('golden'))}" data-size-cell-label="${escapeHtml(cellLabel('golden'))}">${escapeHtml(fmt(goldenVal))}</td>
        <td class="${cellClass(goldenVal, ppVal)}" data-size-cell-target="${escapeHtml(cellTarget('pp'))}" data-size-cell-label="${escapeHtml(cellLabel('pp'))}">${escapeHtml(fmt(ppVal))}</td>
        <td class="${cellClass(goldenVal, bulkVal)}" data-size-cell-target="${escapeHtml(cellTarget('bulk'))}" data-size-cell-label="${escapeHtml(cellLabel('bulk'))}">${escapeHtml(fmt(bulkVal))}</td>
      `;
    }).join('');
    return `<tr data-size-target="${escapeHtml(size)}"><td class="size-name">${escapeHtml(size)}</td>${cells}</tr>`;
  }).join('');

  return `
    <div class="ref-chart-wrap">
      <table class="ref-chart-table">
        <thead>
          <tr><th rowspan="2">${escapeHtml(bi('size').en)}<span class="zh">${escapeHtml(bi('size').zh)}</span></th>${headerRow1}</tr>
          <tr>${headerRow2}</tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
  `;
}

function renderOneSizingChart(s, titleKey, titleFallback) {
  if (!s) return '';
  let body = '';
  if (s.fit && s.sizeRows && s.sizeRows.length) {
    const fitDef = CONFIG.fits && CONFIG.fits.fits && CONFIG.fits.fits[s.fit];
    const points = fitDef ? fitDef.points : Object.keys(s.sizeRows[0].measured || {});
    const pointCols = points.map((p) => {
      const pl = fitDef && fitDef.pointLabels && fitDef.pointLabels[p];
      return `<th>${pl ? escapeHtml(pl.zh || pl.en) : escapeHtml(p)}${pl ? `<span class="zh">${escapeHtml(pl.en)}</span>` : ''}</th>`;
    }).join('');
    const rows = s.sizeRows.map((row) => {
      const cells = points.map((p) => `<td>${escapeHtml(row.measured && row.measured[p] !== undefined && row.measured[p] !== '' ? `${row.measured[p]} cm` : '-')}</td>`).join('');
      return `<tr><td class="size-name">${escapeHtml(row.size)}</td>${cells}</tr>`;
    }).join('');
    const fitLabel = fitDef ? `${fitDef.label_zh} ${fitDef.label_en}` : s.fit;
    body = `
      <div class="section-help" style="margin-bottom:6px;">${escapeHtml(fitLabel)}</div>
      <div class="ref-chart-wrap">
        <table class="ref-chart-table">
          <thead><tr><th>${escapeHtml(bi('size').en)}<span class="zh">${escapeHtml(bi('size').zh)}</span></th>${pointCols}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  } else if (s.fit) {
    const fitDef = CONFIG.fits && CONFIG.fits.fits && CONFIG.fits.fits[s.fit];
    body = `<div class="section-help">${escapeHtml(fitDef ? `${fitDef.label_zh} ${fitDef.label_en}` : s.fit)}</div>`;
  } else if (s.dimensions && (s.dimensions.height || s.dimensions.width || s.dimensions.depth)) {
    const dim = s.dimensions;
    let content = `${dim.height || '-'} x ${dim.width || '-'} x ${dim.depth || '-'} cm (${bi('dimensionHeight').en}/${bi('dimensionWidth').en}/${bi('dimensionDepth').en})`;
    if (dim.notes && dim.notes.trim()) content += ` — ${dim.notes}`;
    body = `<div class="section-help">${escapeHtml(content)}</div>`;
  } else if (s.simpleSizeValue) {
    body = `<div class="section-help">${escapeHtml(s.simpleSizeValue)}</div>`;
  } else if (s.customSizeRows && s.customSizeRows.length) {
    body = `<div class="section-help">${escapeHtml(s.customSizeRows.map((r) => `${r.sizeName}: ${r.measurements}`).join(' · '))}</div>`;
  }
  if (!body) return '';
  return `
    <div style="margin-top:12px; padding-top:12px; border-top:1px dashed var(--jc-border);">
      <div class="section-photos-label">${escapeHtml(bi(titleKey, titleFallback).en)} ${escapeHtml(bi(titleKey, titleFallback).zh)}</div>
      ${body}
    </div>
  `;
}

/** Sizing Details shows every stage's chart that exists so far. For a
 *  standard fit, all three stages combine into one table (easier to
 *  compare); anything else (custom chart, simple value, H/W/L) stays as
 *  separate stacked sections since it doesn't have the same per-point
 *  structure. Pre-Production/Bulk data comes from the actual filed
 *  Reporting inspection for this PO, since Approval's own PP/Bulk stages
 *  don't capture sizing separately. */
function renderSizingDetailsSummary() {
  const sample = approvalState.approval.sampleApproval;
  const sampleSizing = sample.submitted ? sample.data.sizing : null;

  const history = approvalState.reportingHistory || [];
  const findLatest = (qaType) => history
    .filter((r) => r.poNumber === approvalState.po.poNumber && r.qaType === qaType && r.sizingCarryForward)
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))[0];
  const ppReport = findLatest('pre_production');
  const bulkReport = findLatest('production');
  const ppSizing = ppReport ? ppReport.sizingCarryForward : null;
  const bulkSizing = bulkReport ? bulkReport.sizingCarryForward : null;

  let body;
  if (sampleSizing && sampleSizing.fit && sampleSizing.sizeRows && sampleSizing.sizeRows.length) {
    body = renderCombinedFitSizingTable(sampleSizing, ppSizing, bulkSizing);
  } else {
    body = renderOneSizingChart(sampleSizing, 'sampleApprovalTitle', 'Golden Sample')
      + renderOneSizingChart(ppSizing, 'preProductionApprovalTitle', 'Pre-Production')
      + renderOneSizingChart(bulkSizing, 'bulkApprovalTitle', 'Bulk Production');
  }
  if (!body) return '';
  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('sizingDetailsTitle', 'Sizing Details')}</div>
      ${body}
    </div>
  `;
}

/** The whole continuous page: order info, sizing, combined photos, then a
 *  block per stage (progressively revealed as work completes), then
 *  Previous PO Issues at the very bottom. */
function renderApprovalFullPage() {
  const po = approvalState.po;
  const orderInfoBlock = `
    <div class="card">
      <div class="section-title">${biBlockHtml('poInfo', 'Order Information')}</div>
      <div class="review-row"><span class="k">${escapeHtml(bi('poNumber').en)}<span class="zh">${escapeHtml(bi('poNumber').zh)}</span></span><span class="v">${escapeHtml(po.poNumber)}</span></div>
      <div class="review-row"><span class="k">${escapeHtml(bi('productSku').en)}<span class="zh">${escapeHtml(bi('productSku').zh)}</span></span><span class="v">${escapeHtml(po.sku)}</span></div>
      <div class="review-row"><span class="k">${escapeHtml(bi('poQuantity').en)}<span class="zh">${escapeHtml(bi('poQuantity').zh)}</span></span><span class="v">${escapeHtml(po.orderQuantity)}</span></div>
      <div class="review-row"><span class="k">${escapeHtml(bi('creator').en)}<span class="zh">${escapeHtml(bi('creator').zh)}</span></span><span class="v">${escapeHtml(po.creator || '-')}</span></div>
      <div class="review-row"><span class="k">${escapeHtml(bi('productDevelopmentLead').en)}<span class="zh">${escapeHtml(bi('productDevelopmentLead').zh)}</span></span><span class="v">${escapeHtml(po.productDevelopmentLead || '-')}</span></div>
    </div>
  `;

  const approval = approvalState.approval;
  let stageBlocks = renderStageBlock('sample');
  if (approval.sampleApproval.submitted) {
    stageBlocks += renderStageBlock('preProduction');
    if (approval.preProductionApproval.submitted || approval.preProductionApproval.skipped) {
      stageBlocks += renderStageBlock('bulk');
    }
  }

  return `
    ${backHomeLink()}
    <div class="step-title">产品开发审批<span class="zh">Product Development Approval</span></div>
    ${orderInfoBlock}
    ${renderSizingDetailsSummary()}
    ${renderCombinedPhotosSection()}
    ${stageBlocks}
    <div class="major-divider"></div>
    ${renderPreviousPoIssuesSection()}
  `;
}


function photoSetLabelFor(slotKey) {
  const slot = (approvalState.photoSet || []).find((s) => s.key === slotKey);
  if (slot) return { en: slot.label_en, zh: slot.label_zh };
  if (slotKey === 'notesPhotos') return { en: 'Notes Photos', zh: '备注照片' };
  return { en: slotKey, zh: '' };
}
/** Side-by-side: Approved Sample photo(s) for a slot next to the current
 *  stage's photo(s) for that same slot - per size for apparel, since
 *  Pre-Production/Bulk photos are captured per size there. */
/** columns: array of { label: {en,zh}, photos: {slotKey: [urls]} }, in display
 *  order (Approved Sample first, then each subsequent stage) - 2 columns for
 *  Pre-Production Approval, 3 for Bulk Approval. */
/** Generic (non-per-size) row-per-slot comparison - shared by the plain
 *  fallback case and the "shared across all sizes" apparel details. */
function renderGenericSlotComparison(columns, slotKeys) {
  return slotKeys.map((slotKey) => {
    const label = photoSetLabelFor(slotKey);
    return `
      <div class="photo-compare-row">
        ${columns.map((col) => `
          <div class="photo-compare-col">
            <div class="photo-compare-col-label">${escapeHtml(col.label.en)} ${escapeHtml(col.label.zh)} · ${escapeHtml(label.en)} ${escapeHtml(label.zh)}</div>
            ${(col.photos[slotKey] || []).map((u) => `<div class="photo-compare-col-frame"><img src="${escapeHtml(u)}" class="js-lightbox" data-photo-target="${escapeHtml(u)}" /></div>`).join('') || `<div class="section-help">${escapeHtml(bi('noPhotosYet').en)}<span class="zh">${escapeHtml(bi('noPhotosYet').zh)}</span></div>`}
          </div>
        `).join('')}
      </div>
    `;
  }).join('');
}

function renderPhotoComparisonLarge(columns, category, sizesIncluded, sampledSize) {
  if (category === 'apparel' && sizesIncluded && sizesIncluded.length) {
    const frontBackSlots = (approvalState.photoSet || []).filter((s) => s.key === 'front' || s.key === 'back');
    const perSizeSection = sizesIncluded.map((size) => `
      <div style="margin-top:14px; padding-top:14px; border-top:1px dashed var(--jc-border);">
        <div class="section-photos-label" style="font-size:14px;">${escapeHtml(size)}</div>
        ${frontBackSlots.map((slot) => `
          <div class="photo-compare-row">
            ${columns.map((col, idx) => {
              // Approved Sample only ever samples ONE size (not per-size like
              // Pre-Production/Bulk), so its column only shows anything for
              // that specific size's row - other sizes get a clear note
              // instead of repeating the same photo everywhere.
              if (idx === 0) {
                if (sampledSize && size !== sampledSize) {
                  return `
                    <div class="photo-compare-col">
                      <div class="photo-compare-col-label">${escapeHtml(col.label.en)} ${escapeHtml(col.label.zh)} · ${escapeHtml(slot.label_zh)} ${escapeHtml(slot.label_en)}</div>
                      <div class="section-help">${escapeHtml(bi('notSampledAtThisSize').en)}<br/>${escapeHtml(bi('notSampledAtThisSize').zh)}</div>
                    </div>
                  `;
                }
                const urls = col.photos[slot.key] || [];
                return `
                  <div class="photo-compare-col">
                    <div class="photo-compare-col-label">${escapeHtml(col.label.en)} ${escapeHtml(col.label.zh)} · ${escapeHtml(slot.label_zh)} ${escapeHtml(slot.label_en)}</div>
                    ${urls.length ? urls.map((u) => `<div class="photo-compare-col-frame"><img src="${escapeHtml(u)}" class="js-lightbox" data-photo-target="${escapeHtml(u)}" /></div>`).join('') : `<div class="section-help">${escapeHtml(bi('noPhotosYet').en)}<span class="zh">${escapeHtml(bi('noPhotosYet').zh)}</span></div>`}
                  </div>
                `;
              }
              const urls = col.photos[`${slot.key}__${size}`] || [];
              return `
                <div class="photo-compare-col">
                  <div class="photo-compare-col-label">${escapeHtml(col.label.en)} ${escapeHtml(col.label.zh)} · ${escapeHtml(slot.label_zh)} ${escapeHtml(slot.label_en)}</div>
                  ${urls.length ? urls.map((u) => `<div class="photo-compare-col-frame"><img src="${escapeHtml(u)}" class="js-lightbox" data-photo-target="${escapeHtml(u)}" /></div>`).join('') : `<div class="section-help">${escapeHtml(bi('noPhotosYet').en)}<span class="zh">${escapeHtml(bi('noPhotosYet').zh)}</span></div>`}
                </div>
              `;
            }).join('')}
          </div>
        `).join('')}
      </div>
    `).join('');

    // Stitching, tags, packaging, etc. don't vary by size, so they're
    // compared once here rather than repeated under every size above.
    const sharedSlotKeys = [...new Set(columns.flatMap((c) => Object.keys(c.photos)))].filter((k) => !k.startsWith('front') && !k.startsWith('back') && k !== 'front' && k !== 'back');
    const sharedSection = sharedSlotKeys.length ? `
      <div style="margin-top:14px; padding-top:14px; border-top:1px dashed var(--jc-border);">
        <div class="section-photos-label" style="font-size:14px;">${escapeHtml(bi('sharedApparelDetailsTitle').en)} ${escapeHtml(bi('sharedApparelDetailsTitle').zh)}</div>
        ${renderGenericSlotComparison(columns, sharedSlotKeys)}
      </div>
    ` : '';

    return perSizeSection + sharedSection;
  }

  const allSlots = [...new Set(columns.flatMap((c) => Object.keys(c.photos)))];
  return renderGenericSlotComparison(columns, allSlots);
}

/** Only issues from OTHER POs of the same SKU (not this PO's own reports -
 *  those show in Current Production Notes instead), and only Major/Critical -
 *  Minor issues don't need to be surfaced as a flag to Product Development. */
function renderPreviousPoIssuesSection() {
  const otherPoReports = (approvalState.reportingHistory || []).filter((r) => r.poNumber !== approvalState.po.poNumber);
  const withMajorCritical = otherPoReports
    .map((r) => ({ ...r, issues: (r.issues || []).filter((iss) => iss.severity === 'major' || iss.severity === 'critical') }))
    .filter((r) => r.issues.length);

  let emptyMessage = null;
  if (!otherPoReports.length) emptyMessage = bi('noPreviousPos');
  else if (!withMajorCritical.length) emptyMessage = bi('noIssuesInPreviousPos');

  return `
    <div class="card">
      <div class="section-title" style="font-size:18px;">${biBlockHtml('previousPoIssuesTitle', 'Previous PO Issues')}</div>
      ${emptyMessage ? `<div class="section-help">${escapeHtml(emptyMessage.en)}<br/>${escapeHtml(emptyMessage.zh)}</div>` : withMajorCritical.map((r) => {
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

/* ---- Sample Approval form ---- */
function renderChinaApprovalStatusField() {
  return `
    <div class="field">
      <label class="field-label">${biBlockHtml('approvalStatusLabel', 'Approval')}<span class="required">*</span></label>
      <select id="chinaApprovalStatusSelect">
        <option value="">${escapeHtml(bi('selectPlaceholder').en)}</option>
        <option value="approved" ${approvalState.chinaApprovalStatus === 'approved' ? 'selected' : ''}>${escapeHtml(bi('statusApproved').en)} ${escapeHtml(bi('statusApproved').zh)}</option>
        <option value="approvedWithComments" ${approvalState.chinaApprovalStatus === 'approvedWithComments' ? 'selected' : ''}>${escapeHtml(bi('statusApprovedWithComments').en)} ${escapeHtml(bi('statusApprovedWithComments').zh)}</option>
        <option value="minorIssue" ${approvalState.chinaApprovalStatus === 'minorIssue' ? 'selected' : ''}>${escapeHtml(bi('statusMinorIssue').en)} ${escapeHtml(bi('statusMinorIssue').zh)}</option>
        <option value="majorCriticalIssue" ${approvalState.chinaApprovalStatus === 'majorCriticalIssue' ? 'selected' : ''}>${escapeHtml(bi('statusMajorCriticalIssue').en)} ${escapeHtml(bi('statusMajorCriticalIssue').zh)}</option>
      </select>
    </div>
  `;
}

function renderSampleApprovalForm() {
  const prior = approvalState.priorSampleApproval;
  const priorBlock = prior ? `
    <div class="card" style="background:var(--jc-mint-light); border-color:var(--jc-teal);">
      <div class="section-title">${biBlockHtml('priorSampleApprovalFound', 'Prior Sample Approval Found')}</div>
      <div class="section-help">${escapeHtml(bi('priorSampleApprovalHelp').en)} (${escapeHtml(prior.poNumber)})<br/>${escapeHtml(bi('priorSampleApprovalHelp').zh)}</div>
      <button type="button" class="btn btn-secondary" id="btnUsePriorSample" style="margin-top:10px;">${biBlockHtml('copyFromPrior', 'Copy From Prior PO')}</button>
    </div>
  ` : '';

  const isApparelWithSizes = approvalState.po.category === 'apparel' && approvalState.po.sizesIncluded && approvalState.po.sizesIncluded.length;
  const sampledSizeField = isApparelWithSizes ? `
    <div class="field">
      <label class="field-label">${biBlockHtml('sampledSizeLabel', 'Size Sampled')}<span class="required">*</span></label>
      <select id="approvalSampledSize">
        <option value="">${escapeHtml(bi('selectPlaceholder').en)}</option>
        ${approvalState.po.sizesIncluded.map((s) => `<option value="${escapeHtml(s)}" ${approvalState.sampledSize === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
      </select>
      <div class="section-help">${escapeHtml(bi('sampledSizeHelp').en)}<br/>${escapeHtml(bi('sampledSizeHelp').zh)}</div>
    </div>
  ` : '';

  const photoSlots = (approvalState.photoSet || []).map((slot) => renderPhotoSlot(slot.key, slot.label_en, slot.label_zh)).join('');

  return `
    ${priorBlock}
    <div class="card">
      <div class="section-title">${biBlockHtml('sampleDetailsTitle', 'Sample Details')}</div>
      ${selectField3WithOther('factoryCode', 'factoryCode', approvalState.factoryCode, OPTIONS.factoryCodes || [])}
      ${selectField3WithOther('qaLead', 'qaLead', approvalState.qaLead, OPTIONS.qaLeads || [])}
      <div class="field">
        <label class="field-label">${biBlockHtml('productRisk', 'Product Complexity/Risk')}</label>
        <div class="segmented">
          ${['high', 'medium', 'low'].map((r) => `<div class="segmented-option ${approvalState.productRisk === r ? 'selected' : ''}" data-approval-risk="${r}">${escapeHtml(bi('risk' + r.charAt(0).toUpperCase() + r.slice(1)).en)}<span class="zh">${escapeHtml(bi('risk' + r.charAt(0).toUpperCase() + r.slice(1)).zh)}</span></div>`).join('')}
        </div>
      </div>
      ${sampledSizeField}
    </div>

    ${renderSizingSection()}

    <div class="card">
      <div class="section-title">${biBlockHtml('approvedSamplePhotos', 'Approved Sample Photos')}</div>
      ${photoSlots}
    </div>

    <div class="card">
      <div class="section-title">${biBlockHtml('chinaSubmissionSectionTitle', 'Juniper China QA/QC Submission')}</div>
      <div class="field">
        <label class="field-label">${biBlockHtml('notesSection', 'Notes')} <span class="section-help">(${escapeHtml(bi('optional').en)})</span></label>
        <textarea id="approvalNotes" placeholder="${escapeHtml(bi('notesPlaceholder').en)} / ${escapeHtml(bi('notesPlaceholder').zh)}">${escapeHtml(approvalState.notes)}</textarea>
      </div>
      ${renderPhotoSlot('_notes', 'Notes Photos', '备注照片', null, true)}
    </div>

    <button class="btn btn-primary" id="btnSubmitStage" style="margin-top:10px;">${biBlockHtml('submitPhotos', 'Submit Photos')}</button>
  `;
}

function renderSizingSection() {
  if (approvalState.po.category !== 'apparel') {
    return `
      <div class="card">
        <div class="section-title">${biBlockHtml('sizingTitle', 'Sizing')}</div>
        ${renderApprovalDimensionsFields()}
      </div>
    `;
  }

  const fits = fitsForPoSubcategory();
  const options = Object.keys(fits).map((k) => `<option value="${k}" ${approvalState.fit === k ? 'selected' : ''}>${escapeHtml(fits[k].label_zh)} ${escapeHtml(fits[k].label_en)}</option>`).join('');
  const otherSel = approvalState.fit === OTHER_FIT_VALUE ? 'selected' : '';

  const pickerCard = `
    <div class="card">
      <div class="section-title">${biBlockHtml('sizingTitle', 'Sizing')}</div>
      <div class="field">
        <label class="field-label">${biBlockHtml('fitSelect', 'Standard Fit')}</label>
        <select id="approvalFitSelect">
          <option value="">${escapeHtml(bi('fitSelectPlaceholder').en)}</option>
          ${options}
          <option value="${OTHER_FIT_VALUE}" ${otherSel}>${escapeHtml(bi('fitOther').en)} ${escapeHtml(bi('fitOther').zh)}</option>
        </select>
      </div>
    </div>
  `;

  if (approvalState.fit === OTHER_FIT_VALUE) {
    return pickerCard + renderApprovalCustomSizeChart();
  }
  if (approvalState.fit && fits[approvalState.fit]) {
    return pickerCard + renderApprovalSizeEntryTable(fits[approvalState.fit]);
  }
  return pickerCard;
}

/** Non-apparel (plush, bags, accessories, etc.) sizing - three plain
 *  dimensions rather than a fit-based chart. */
function renderApprovalDimensionsFields() {
  const dims = approvalState.dimensions;
  const field = (key, i18nKey, fallback) => `
    <div class="field" style="flex:1;">
      <label class="field-label">${biBlockHtml(i18nKey, fallback)}</label>
      <input type="number" step="0.1" inputmode="decimal" data-approval-dimension="${key}" value="${escapeHtml(dims[key])}" placeholder="0.0" />
    </div>
  `;
  return `
    <div class="field-row">
      ${field('height', 'dimensionHeight', 'Height (cm)')}
      ${field('width', 'dimensionWidth', 'Width (cm)')}
      ${field('depth', 'dimensionDepth', 'Depth (cm)')}
    </div>
    <div class="field">
      <label class="field-label">${biBlockHtml('dimensionsNotes', 'Additional Notes')} <span class="section-help">(${escapeHtml(bi('optional').en)})</span></label>
      <textarea data-approval-dimension="notes" placeholder="${escapeHtml(bi('dimensionsNotesPlaceholder').en)}">${escapeHtml(dims.notes || '')}</textarea>
    </div>
  `;
}

/** Editable measurement entry, one card per size (scoped to the PO's
 *  included sizes if set), with a photo slot per size and tolerance
 *  flagging - the same capability the Reporting flow has, so the approved
 *  sample's actual measurements get captured here as the baseline. */
function renderApprovalSizeEntryTable(fitDef) {
  const sizesIncluded = (approvalState.po.sizesIncluded && approvalState.po.sizesIncluded.length) ? approvalState.po.sizesIncluded : null;

  if (!approvalState.sizeRows.length || approvalState._fitForRows !== approvalState.fit) {
    const availableSizes = Object.keys(fitDef.sizes).filter((s) => !sizesIncluded || sizesIncluded.some((canonical) => s === canonical || s.startsWith(canonical + ' ') || s.startsWith(canonical + '(')));
    approvalState.sizeRows = availableSizes.map((size) => {
      const standard = fitDef.sizes[size] || {};
      const measured = {};
      fitDef.points.forEach((p) => {
        const std = standard[p];
        if (std && typeof std === 'object') measured[p] = String(Math.round(((std.min + std.max) / 2) * 10) / 10);
        else if (typeof std === 'number') measured[p] = String(std);
      });
      return { size, measured };
    });
    approvalState._fitForRows = approvalState.fit;
    // A custom column ("Inseam", etc.) is specific to this product/fit
    // combination, so a fit change starts fresh rather than carrying over
    // a column that may not even apply to the new fit.
    approvalState.customPoints = [];
  }

  const cards = approvalState.sizeRows.map((row, ridx) => {
    const standard = fitDef.sizes[row.size] || {};
    const pointFields = fitDef.points.map((p) => {
      const pl = fitDef.pointLabels[p] || { en: p, zh: '' };
      const std = standard[p];
      const measuredVal = row.measured[p] !== undefined ? row.measured[p] : '';
      // No out-of-tolerance flagging here - this is the initial Golden
      // Sample setup, where editing away from the generic fit template is
      // the whole point (establishing THIS product's actual approved
      // values), not a deviation from anything yet. Tolerance comparisons
      // start once Pre-Production/Bulk get measured against this sample.
      return `
        <div class="size-point-field">
          <label class="size-point-label">${escapeHtml(pl.zh || pl.en)} <span class="zh">${escapeHtml(pl.en)}</span></label>
          <span class="std-val">${escapeHtml(bi('standard').en)}<span class="zh">${escapeHtml(bi('standard').zh)}</span>: ${escapeHtml(formatStandard(std))}</span>
          <input type="number" step="0.1" inputmode="decimal" value="${escapeHtml(measuredVal)}"
            data-approval-size-row="${ridx}" data-approval-size-point="${p}" placeholder="0.0" />
        </div>
      `;
    }).join('');

    // Custom columns (e.g. "Inseam") added via "+ Add Additional Column"
    // below - no generic standard to show since these are product-specific
    // and only exist because this PO's Golden Sample defines them.
    const customFields = approvalState.customPoints.map((cp) => {
      const measuredVal = row.measured[cp.key] !== undefined ? row.measured[cp.key] : '';
      return `
        <div class="size-point-field">
          <label class="size-point-label">${escapeHtml(cp.label || bi('untitledColumn').en)}</label>
          <input type="number" step="0.1" inputmode="decimal" value="${escapeHtml(measuredVal)}"
            data-approval-size-row="${ridx}" data-approval-size-point="${cp.key}" placeholder="0.0" />
        </div>
      `;
    }).join('');

    return `
      <div class="size-card">
        <div class="size-card-header">${escapeHtml(row.size)}</div>
        <div class="size-point-grid">${pointFields}${customFields}</div>
      </div>
    `;
  }).join('');

  const customColumnRows = approvalState.customPoints.map((cp, cidx) => `
    <div class="custom-column-row" data-custom-column-row="${cidx}">
      <input type="text" value="${escapeHtml(cp.label)}" placeholder="${escapeHtml(bi('columnNamePlaceholder', 'e.g. Inseam / 内长').en)}"
        data-custom-column-label="${cidx}" />
      <button type="button" class="btn-icon-remove" data-custom-column-remove="${cidx}" title="${escapeHtml(bi('remove', 'Remove').en)}">✕</button>
    </div>
  `).join('');

  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('approvedSizeChartTitle', 'Approved Size Chart')}</div>
      <div class="section-help">${escapeHtml(bi('approvedSizeChartHelp').en)}<br/>${escapeHtml(bi('approvedSizeChartHelp').zh)}</div>
      ${cards}
      <div class="custom-columns-editor" style="margin-top:14px;">
        <div class="section-photos-label">${biBlockHtml('additionalColumnsTitle', 'Additional Columns')}</div>
        ${customColumnRows}
        <button type="button" class="add-column-btn" id="btnAddSizeColumn">${escapeHtml(bi('addAdditionalColumn', '+ Add Additional Column').en)} <span class="zh">${escapeHtml(bi('addAdditionalColumn').zh)}</span></button>
      </div>
      <div class="size-card-photos" style="margin-top:14px;">
        <div class="section-photos-label">${biBlockHtml('sizingPhotosOverall', 'Photos')}</div>
        ${renderPhotoSlot('sizechart', 'Photo', '照片')}
      </div>
    </div>
  `;
}

function isSimplifiedCustomSizing(subcategory) {
  return subcategory === 'hat' || subcategory === 'socks';
}

/** For a custom ("Other") fit: freeform size rows, pre-seeded from the PO's
 *  included sizes if that's been set, otherwise added manually. Hat and
 *  Socks get a single simple field instead of a full per-size chart, since a
 *  detailed multi-point chart doesn't really apply to those. */
function renderApprovalCustomSizeChart() {
  if (isSimplifiedCustomSizing(approvalState.po.subcategory)) {
    return `
      <div class="card">
        <div class="section-title">${biBlockHtml('customSizeChartTitle', 'Custom Size Chart')}</div>
        <div class="field">
          <label class="field-label">${biBlockHtml('simpleSizeLabel', 'Size / Measurement')}</label>
          <input type="text" id="approvalSimpleSize" value="${escapeHtml(approvalState.simpleSizeValue)}" placeholder="${escapeHtml(bi('simpleSizePlaceholder').en)}" />
        </div>
        <div class="section-photos-block">
          <div class="section-photos-label">${biBlockHtml('sizingPhotosForSize', 'Photos for this size')}</div>
          ${renderPhotoSlot('customsizecheck', 'Photo', '照片', 'simple')}
        </div>
      </div>
    `;
  }

  if (!approvalState.customSizeRows.length && approvalState.po.sizesIncluded && approvalState.po.sizesIncluded.length) {
    approvalState.customSizeRows = approvalState.po.sizesIncluded.map((size) => ({ sizeName: size, measurements: '' }));
  }
  const rows = approvalState.customSizeRows.map((row, ridx) => `
    <div class="size-card">
      <div class="field">
        <label class="field-label">${biBlockHtml('customSizeName', 'Size Name')}</label>
        <input type="text" data-approval-custom-size-name="${ridx}" value="${escapeHtml(row.sizeName)}" placeholder="${escapeHtml(bi('customSizeNamePlaceholder').en)}" />
      </div>
      <div class="field">
        <label class="field-label">${biBlockHtml('customSizeMeasurements', 'Measurements')}</label>
        <textarea data-approval-custom-size-measurements="${ridx}" placeholder="${escapeHtml(bi('customSizeMeasurementsPlaceholder').en)}">${escapeHtml(row.measurements)}</textarea>
      </div>
      <div class="size-card-photos">
        <div class="section-photos-label">${biBlockHtml('sizingPhotosForSize', 'Photos for this size')}</div>
        ${renderPhotoSlot('customsizecheck', 'Photo', '照片', row.sizeName || String(ridx))}
      </div>
      <button type="button" class="remove-defect-btn" data-approval-remove-custom-size="${ridx}">${escapeHtml(bi('removeIssue').en)} ${escapeHtml(bi('removeIssue').zh)}</button>
    </div>
  `).join('');

  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('customSizeChartTitle', 'Custom Size Chart')}</div>
      ${rows}
      <button type="button" class="add-defect-btn" id="btnApprovalAddCustomSize">${escapeHtml(bi('addCustomSize').en)} <span class="zh">${escapeHtml(bi('addCustomSize').zh)}</span></button>
    </div>
  `;
}

function photoKey(slot, size) { return size ? `${slot}__${size}` : slot; }
function renderPhotoSlot(slotKey, labelEn, labelZh, size, mini) {
  const key = photoKey(slotKey, size);
  const files = approvalState.photos[key] || [];
  const thumbs = files.map((f, idx) => `
    <div class="photo-thumb">
      <img src="${f._url}" />
      <button class="photo-remove" data-approval-photo-remove="${key}" data-idx="${idx}">✕</button>
    </div>
  `).join('');
  const inputId = `approvalPhoto_${key.replace(/[^a-zA-Z0-9]/g, '_')}`;
  return `
    <div class="section-photos-block">
      <div class="section-photos-label">${escapeHtml(labelEn)} <span class="zh">${escapeHtml(labelZh)}</span></div>
      <div class="photo-grid ${mini ? 'mini' : 'compact'}">
        ${thumbs}
        <label class="photo-add" for="${inputId}">
          <span class="plus">+</span>
          <span>${escapeHtml(bi('addPhoto').en)}</span>
          <input type="file" id="${inputId}" accept="image/*" multiple data-approval-photo-input="${key}" />
        </label>
      </div>
    </div>
  `;
}
function selectField3(id, i18nKey, value, optionsList) {
  const l = bi(i18nKey);
  return `
    <div class="field">
      <label class="field-label">${escapeHtml(l.en)} <span class="zh">${escapeHtml(l.zh)}</span></label>
      <select id="approval_${id}">
        <option value="">${escapeHtml(bi('selectPlaceholder').en)}</option>
        ${optionsList.map((o) => `<option value="${escapeHtml(o)}" ${value === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
      </select>
    </div>
  `;
}

/** Like selectField3, but a free-text input with an autocomplete list
 *  instead of a closed dropdown - lets someone pick an existing value OR
 *  type a brand-new one (which the server then saves as a new option for
 *  everyone going forward). */
const approvalOtherModeFlags = { factoryCode: false, qaLead: false };

/** Same idea as selectField3, but with an "Other" option that reveals a
 *  text field to type something new - matches the same pattern used
 *  elsewhere in this app (a plain input+datalist looked broken/unstyled
 *  here, so back to a real dropdown). */
function selectField3WithOther(id, i18nKey, value, optionsList) {
  const l = bi(i18nKey);
  const isOther = approvalOtherModeFlags[id] || (!!value && !optionsList.includes(value));
  const otherLabel = bi('other');
  const otherPh = bi('otherPlaceholder');
  return `
    <div class="field">
      <label class="field-label">${escapeHtml(l.en)} <span class="zh">${escapeHtml(l.zh)}</span></label>
      <select data-approval-select-other="${id}">
        <option value="">${escapeHtml(bi('selectPlaceholder').en)}</option>
        ${optionsList.map((o) => `<option value="${escapeHtml(o)}" ${!isOther && value === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
        <option value="${OTHER_VALUE}" ${isOther ? 'selected' : ''}>${escapeHtml(otherLabel.en)} / ${escapeHtml(otherLabel.zh)}</option>
      </select>
      ${isOther ? `<input type="text" data-approval-other-text="${id}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(otherPh.en)} / ${escapeHtml(otherPh.zh)}" style="margin-top:8px;" />` : ''}
    </div>
  `;
}

/* ---- Pre-Production / Bulk Approval form ---- */
function renderPrePorBulkForm() {
  const reportBlock = renderReportingReferenceBlock();

  let photoSlotsHtml;
  let sharedSlotsHtml = '';
  if (approvalState.po.category === 'apparel' && approvalState.po.sizesIncluded && approvalState.po.sizesIncluded.length) {
    const frontBack = (approvalState.photoSet || []).filter((s) => s.key === 'front' || s.key === 'back');
    const sharedSlots = (approvalState.photoSet || []).filter((s) => s.key !== 'front' && s.key !== 'back');
    photoSlotsHtml = approvalState.po.sizesIncluded.map((size) => `
      <div style="margin-top:12px; padding-top:12px; border-top:1px dashed var(--jc-border);">
        <div class="section-photos-label" style="font-size:14px;">${escapeHtml(size)}</div>
        ${frontBack.map((slot) => renderPhotoSlot(slot.key, slot.label_en, slot.label_zh, size)).join('')}
      </div>
    `).join('');
    // Stitching, tags, packaging, etc. don't vary by size, so they're one
    // shared set of uploads rather than repeated for every size.
    if (sharedSlots.length) {
      sharedSlotsHtml = `
        <div class="card">
          <div class="section-title">${biBlockHtml('sharedApparelDetailsTitle', 'Other Details (all sizes)')}</div>
          ${sharedSlots.map((slot) => renderPhotoSlot(slot.key, slot.label_en, slot.label_zh)).join('')}
        </div>
      `;
    }
  } else {
    photoSlotsHtml = (approvalState.photoSet || []).map((slot) => renderPhotoSlot(slot.key, slot.label_en, slot.label_zh)).join('');
  }

  return `
    ${reportBlock}
    <div class="card">
      <div class="section-title">${biBlockHtml(approvalState.stage === 'preProduction' ? 'preProductionApprovalPhotos' : 'bulkApprovalPhotos', 'Approval Photos')}</div>
      ${photoSlotsHtml}
    </div>
    ${sharedSlotsHtml}
    <div class="card">
      <div class="section-title">${biBlockHtml('chinaApprovalSectionTitle', 'Juniper China Approval')}</div>
      ${renderChinaApprovalStatusField()}
      <div class="field" data-field="approvalNotes">
        <label class="field-label">${biBlockHtml('notesSection', 'Notes')}</label>
        <textarea id="approvalNotes" placeholder="${escapeHtml(bi('notesPlaceholder').en)} / ${escapeHtml(bi('notesPlaceholder').zh)}">${escapeHtml(approvalState.notes)}</textarea>
      </div>
      ${renderPhotoSlot('_notes', 'Notes Photos', '备注照片', null, true)}
    </div>
    <button class="btn btn-primary" id="btnSubmitStage" style="margin-top:10px;">${biBlockHtml('submitPhotos', 'Submit Photos')}</button>
    ${approvalState.stage === 'preProduction' ? `
      <button type="button" class="btn btn-secondary" id="btnSkipPreProduction" style="margin-top:10px; width:auto; display:inline-block; padding:10px 18px;">${biBlockHtml('skipPreProduction', 'Skip Pre-Production')}</button>
    ` : ''}
  `;
}

function renderReportingReferenceBlock() {
  const history = approvalState.reportingHistory || [];
  const matching = history.filter((h) => h.poNumber === approvalState.po.poNumber && h.qaType === (approvalState.stage === 'preProduction' ? 'pre_production' : 'production'));
  if (!matching.length) return '';
  return matching.map((r) => renderLinkedReportCard(r, approvalState.stage)).join('');
}

/* ---- Submitted stage: show data read-back + PD comments ---- */
function buildSizingPayload() {
  if (approvalState.po.category !== 'apparel') return { dimensions: approvalState.dimensions };
  if (approvalState.fit === OTHER_FIT_VALUE) {
    if (isSimplifiedCustomSizing(approvalState.po.subcategory)) return { fit: OTHER_FIT_VALUE, simpleSizeValue: approvalState.simpleSizeValue };
    return { fit: OTHER_FIT_VALUE, customSizeRows: approvalState.customSizeRows };
  }
  return { fit: approvalState.fit, sizeRows: approvalState.sizeRows, customPoints: approvalState.customPoints };
}

function commentActionSentence(c, stageTitle) {
  const author = escapeHtml(c.author);
  let verbKey;
  if (c.approvalStatus === 'approved') verbKey = 'commentVerbApproved';
  else if (c.approvalStatus === 'approvedWithComments') verbKey = 'commentVerbApprovedWithComments';
  else if (c.approvalStatus === 'minorIssue') verbKey = 'commentVerbMinorIssue';
  else if (c.approvalStatus === 'majorCriticalIssue') verbKey = 'commentVerbMajorIssue';
  else verbKey = 'commentVerbCommented';
  const verb = bi(verbKey);
  const imagesWord = bi('imagesWord', 'Images');
  return `${author} ${escapeHtml(verb.en)} ${escapeHtml(stageTitle.en)} ${escapeHtml(imagesWord.en)}<span class="zh">${author} ${escapeHtml(verb.zh)} ${escapeHtml(stageTitle.zh)} ${escapeHtml(imagesWord.zh)}</span>`;
}

/** Which stage's comment thread should currently accept new comments - the
 *  most recently submitted one. Once a later stage is submitted, earlier
 *  stages' threads become read-only archives. */
function latestSubmittedStage() {
  const approval = approvalState.approval;
  if (approval.bulkApproval.submitted) return 'bulk';
  if (approval.preProductionApproval.submitted) return 'preProduction';
  if (approval.sampleApproval.submitted) return 'sample';
  return null;
}

function commentStageTitle(stage) {
  const s = stage || approvalState.stage;
  if (s === 'sample') return bi('commentStageTitleSample', 'Sample Approval');
  if (s === 'preProduction') return bi('commentStageTitlePreProduction', 'PP Sample Approval');
  return bi('commentStageTitleBulk', 'Bulk Sample Approval');
}

function photoColumnStageLabel(stage) {
  if (stage === 'sample') return bi('approvedSample', 'Approved Sample');
  if (stage === 'preProduction') return bi('preProductionSampleLabel', 'Pre-Production Sample');
  return bi('bulkSampleLabel', 'Bulk Sample');
}

/* ---------------- HANDLERS ---------------- */

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

function attachStageHandlers() {
  // "Reference" chip on a comment - jumps to and briefly highlights the
  // photo or size-chart row it points at, wherever it lives on the page.
  document.querySelectorAll('[data-scroll-to-reference]').forEach((el) => {
    el.addEventListener('click', () => {
      let ref;
      try { ref = JSON.parse(el.getAttribute('data-scroll-to-reference')); } catch { return; }
      const selector = ref.type === 'photo' ? `[data-photo-target="${CSS.escape(ref.targetId)}"]`
        : ref.type === 'sizeCell' ? `[data-size-cell-target="${CSS.escape(ref.targetId)}"]`
        : `[data-size-target="${CSS.escape(ref.targetId)}"]`; // old row-level references, kept for anything saved before this change
      const target = document.querySelector(selector);
      if (!target) { showToast(bi('referenceTargetMissing', "Can't find that anymore - it may have been replaced since this comment was written.").en, true); return; }
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // A photo inside one of the bordered comparison frames sits under a
      // parent with overflow:hidden - an outline on the <img> itself would
      // be clipped away by that parent, invisibly. An element's own
      // overflow never clips its own outline, only an ancestor's, so
      // highlight the frame instead whenever one wraps the actual target.
      const highlightTarget = target.closest('.photo-compare-col-frame, .photo-gallery-large-frame') || target;
      highlightTarget.classList.add('reference-highlight');
      setTimeout(() => highlightTarget.classList.remove('reference-highlight'), 2500);
    });
  });
  document.querySelectorAll('[data-approval-risk]').forEach((el) => {
    el.addEventListener('click', () => { approvalState.productRisk = el.getAttribute('data-approval-risk'); render(); });
  });
  document.querySelectorAll('[data-start-reference-select]').forEach((el) => {
    el.addEventListener('click', () => startReferenceSelect(el.getAttribute('data-start-reference-select')));
  });
  document.querySelectorAll('[data-clear-reference]').forEach((el) => {
    el.addEventListener('click', () => {
      const stage = el.getAttribute('data-clear-reference');
      if (approvalState.replyDrafts[stage]) approvalState.replyDrafts[stage].reference = null;
      render();
    });
  });
  document.querySelectorAll('[data-approval-select-other]').forEach((el) => {
    el.addEventListener('change', (e) => {
      const id = el.getAttribute('data-approval-select-other');
      const target = id === 'factoryCode' ? 'factoryCode' : 'qaLead';
      if (e.target.value === OTHER_VALUE) { approvalOtherModeFlags[id] = true; approvalState[target] = ''; }
      else { approvalOtherModeFlags[id] = false; approvalState[target] = e.target.value; }
      render();
    });
  });
  document.querySelectorAll('[data-approval-other-text]').forEach((el) => {
    el.addEventListener('input', (e) => {
      const id = el.getAttribute('data-approval-other-text');
      const target = id === 'factoryCode' ? 'factoryCode' : 'qaLead';
      approvalState[target] = e.target.value;
    });
  });
  const fitSelect = document.getElementById('approvalFitSelect');
  if (fitSelect) {
    fitSelect.addEventListener('change', (e) => {
      approvalState.fit = e.target.value;
      approvalState.sizeRows = [];
      approvalState._fitForRows = null;
      approvalState.customSizeRows = [];
      render();
    });
  }
  document.querySelectorAll('[data-approval-dimension]').forEach((el) => {
    el.addEventListener('input', (e) => { approvalState.dimensions[el.getAttribute('data-approval-dimension')] = e.target.value; });
  });
  const simpleSizeInput = document.getElementById('approvalSimpleSize');
  if (simpleSizeInput) simpleSizeInput.addEventListener('input', (e) => { approvalState.simpleSizeValue = e.target.value; });
  const notes = document.getElementById('approvalNotes');
  if (notes) notes.addEventListener('input', (e) => { approvalState.notes = e.target.value; });
  const chinaApprovalStatusSelect = document.getElementById('chinaApprovalStatusSelect');
  if (chinaApprovalStatusSelect) chinaApprovalStatusSelect.addEventListener('change', (e) => { approvalState.chinaApprovalStatus = e.target.value; });
  const sampledSizeSelect = document.getElementById('approvalSampledSize');
  if (sampledSizeSelect) sampledSizeSelect.addEventListener('change', (e) => { approvalState.sampledSize = e.target.value; });

  // Standard-fit measurement inputs
  document.querySelectorAll('[data-approval-size-row]').forEach((el) => {
    el.addEventListener('input', (e) => {
      const ridx = parseInt(el.getAttribute('data-approval-size-row'), 10);
      const point = el.getAttribute('data-approval-size-point');
      approvalState.sizeRows[ridx].measured[point] = e.target.value;
    });
  });

  // Additional (custom) sizing columns - e.g. "Inseam" - add/remove/rename
  const btnAddSizeColumn = document.getElementById('btnAddSizeColumn');
  if (btnAddSizeColumn) {
    btnAddSizeColumn.addEventListener('click', () => {
      const key = `custom_${Date.now()}_${approvalState.customPoints.length}`;
      approvalState.customPoints.push({ key, label: '' });
      approvalState.sizeRows.forEach((row) => { row.measured[key] = ''; });
      render();
    });
  }
  document.querySelectorAll('[data-custom-column-remove]').forEach((el) => {
    el.addEventListener('click', () => {
      const cidx = parseInt(el.getAttribute('data-custom-column-remove'), 10);
      const removed = approvalState.customPoints[cidx];
      approvalState.customPoints.splice(cidx, 1);
      if (removed) approvalState.sizeRows.forEach((row) => { delete row.measured[removed.key]; });
      render();
    });
  });
  document.querySelectorAll('[data-custom-column-label]').forEach((el) => {
    el.addEventListener('input', (e) => {
      const cidx = parseInt(el.getAttribute('data-custom-column-label'), 10);
      if (approvalState.customPoints[cidx]) approvalState.customPoints[cidx].label = e.target.value;
    });
  });

  // Custom ("Other" fit) size rows
  document.querySelectorAll('[data-approval-custom-size-name]').forEach((el) => {
    el.addEventListener('input', (e) => {
      const ridx = parseInt(el.getAttribute('data-approval-custom-size-name'), 10);
      approvalState.customSizeRows[ridx].sizeName = e.target.value;
    });
  });
  document.querySelectorAll('[data-approval-custom-size-measurements]').forEach((el) => {
    el.addEventListener('input', (e) => {
      const ridx = parseInt(el.getAttribute('data-approval-custom-size-measurements'), 10);
      approvalState.customSizeRows[ridx].measurements = e.target.value;
    });
  });
  document.querySelectorAll('[data-approval-remove-custom-size]').forEach((el) => {
    el.addEventListener('click', () => {
      const ridx = parseInt(el.getAttribute('data-approval-remove-custom-size'), 10);
      approvalState.customSizeRows.splice(ridx, 1);
      render();
    });
  });
  const btnAddCustomSize = document.getElementById('btnApprovalAddCustomSize');
  if (btnAddCustomSize) {
    btnAddCustomSize.addEventListener('click', () => {
      approvalState.customSizeRows.push({ sizeName: '', measurements: '' });
      render();
    });
  }

  const btnUsePrior = document.getElementById('btnUsePriorSample');
  if (btnUsePrior) {
    btnUsePrior.addEventListener('click', async () => {
      const prior = approvalState.priorSampleApproval.data;
      approvalState.factoryCode = prior.factoryCode || '';
      approvalState.qaLead = prior.qaLead || '';
      approvalState.productRisk = prior.productRisk || 'medium';
      // Only carry the sampled size forward if it's actually one of this PO's
      // sizes too - a different PO could have a different size range.
      if (prior.sampledSize && approvalState.po.sizesIncluded && approvalState.po.sizesIncluded.includes(prior.sampledSize)) {
        approvalState.sampledSize = prior.sampledSize;
      }
      if (prior.sizing) {
        approvalState.fit = prior.sizing.fit || '';
        approvalState.sizeRows = prior.sizing.sizeRows ? JSON.parse(JSON.stringify(prior.sizing.sizeRows)) : [];
        approvalState.customSizeRows = prior.sizing.customSizeRows ? JSON.parse(JSON.stringify(prior.sizing.customSizeRows)) : [];
        approvalState._fitForRows = approvalState.sizeRows.length ? approvalState.fit : null;
        if (prior.sizing.dimensions) approvalState.dimensions = { ...prior.sizing.dimensions };
      }

      // Also copy the Approved Sample Photos themselves (only these - not any
      // other stage's photos) by fetching each one back as a file so it flows
      // through the normal upload path when this stage gets submitted.
      btnUsePrior.disabled = true;
      showToast(bi('processingPhotos').en);
      const priorPhotos = prior.photos || {};
      for (const slotKey of Object.keys(priorPhotos)) {
        for (const url of priorPhotos[slotKey]) {
          try {
            const res = await fetch(url);
            const blob = await res.blob();
            blob.name = `${slotKey}.jpg`;
            blob._url = URL.createObjectURL(blob);
            if (!approvalState.photos[slotKey]) approvalState.photos[slotKey] = [];
            approvalState.photos[slotKey].push(blob);
          } catch (e) { console.error('Failed to copy photo', url, e); }
        }
      }

      showToast(bi('copiedFromPrior').en + ' / ' + bi('copiedFromPrior').zh);
      render();
    });
  }

  attachApprovalPhotoHandlers();

  const btnSubmit = document.getElementById('btnSubmitStage');
  if (btnSubmit) btnSubmit.addEventListener('click', submitStage);

  const btnSkipPP = document.getElementById('btnSkipPreProduction');
  if (btnSkipPP) btnSkipPP.addEventListener('click', skipPreProduction);

  // Per-stage reply/comment forms - multiple can be on screen at once now.
  document.querySelectorAll('[data-reply-author]').forEach((el) => {
    const handler = (e) => {
      const stage = el.getAttribute('data-reply-author');
      if (!approvalState.replyDrafts[stage]) approvalState.replyDrafts[stage] = { author: '', approvalStatus: '', text: '', reference: null };
      approvalState.replyDrafts[stage].author = e.target.value;
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  });
  document.querySelectorAll('[data-reply-author-select]').forEach((el) => {
    el.addEventListener('change', (e) => {
      const stage = el.getAttribute('data-reply-author-select');
      if (!approvalState.replyDrafts[stage]) approvalState.replyDrafts[stage] = { author: '', approvalStatus: '', text: '', reference: null };
      if (e.target.value === OTHER_VALUE) { replyAuthorOtherMode[stage] = true; approvalState.replyDrafts[stage].author = ''; }
      else { replyAuthorOtherMode[stage] = false; approvalState.replyDrafts[stage].author = e.target.value; }
      render();
    });
  });
  document.querySelectorAll('[data-reply-status]').forEach((el) => {
    el.addEventListener('change', (e) => {
      const stage = el.getAttribute('data-reply-status');
      if (!approvalState.replyDrafts[stage]) approvalState.replyDrafts[stage] = { author: '', approvalStatus: '', text: '', reference: null };
      approvalState.replyDrafts[stage].approvalStatus = e.target.value;
    });
  });
  document.querySelectorAll('[data-reply-text]').forEach((el) => {
    el.addEventListener('input', (e) => {
      const stage = el.getAttribute('data-reply-text');
      if (!approvalState.replyDrafts[stage]) approvalState.replyDrafts[stage] = { author: '', approvalStatus: '', text: '', reference: null };
      approvalState.replyDrafts[stage].text = e.target.value;
    });
  });
  document.querySelectorAll('[data-submit-reply]').forEach((el) => {
    el.addEventListener('click', () => submitReply(el.getAttribute('data-submit-reply')));
  });
}

function attachApprovalPhotoHandlers() {
  document.querySelectorAll('[data-approval-photo-input]').forEach((el) => {
    el.addEventListener('change', async (e) => {
      const key = el.getAttribute('data-approval-photo-input');
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      el.value = '';
      if (!approvalState.photos[key]) approvalState.photos[key] = [];
      showToast(bi('processingPhotos').en);
      for (const f of files) {
        try {
          const compressed = await compressImage(f);
          compressed._url = URL.createObjectURL(compressed);
          approvalState.photos[key].push(compressed);
        } catch (err) { console.error(err); }
      }
      render();
    });
  });
  document.querySelectorAll('[data-approval-photo-remove]').forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.getAttribute('data-approval-photo-remove');
      const idx = parseInt(el.getAttribute('data-idx'), 10);
      const removed = approvalState.photos[key].splice(idx, 1)[0];
      if (removed && removed._url) URL.revokeObjectURL(removed._url);
      render();
    });
  });
}

/** Deliberately bypass Pre-Production Approval, e.g. for a repeat PO of an
 *  already-established product going straight from Golden Sample to Bulk. */
async function skipPreProduction() {
  if (!confirm(`${bi('confirmSkipPreProduction', 'Skip Pre-Production Approval for this PO? This moves straight to Bulk Approval.').en}\n${bi('confirmSkipPreProduction', 'Skip Pre-Production Approval for this PO? This moves straight to Bulk Approval.').zh}`)) return;
  const btn = document.getElementById('btnSkipPreProduction');
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>...`; }
  try {
    const res = await fetch(`/api/approval/${encodeURIComponent(approvalState.po.poNumber)}/preProduction/skip`, { method: 'POST' });
    if (!res.ok) throw new Error('Request failed');
    const result = await res.json();
    approvalState.approval = result.approval;
    approvalState.stage = determineCurrentStage(result.approval);
    render();
  } catch (err) {
    console.error(err);
    showToast(bi('submitError').en + ' / ' + bi('submitError').zh, true);
    if (btn) { btn.disabled = false; btn.innerHTML = biBlockHtml('skipPreProduction', 'Skip Pre-Production'); }
  }
}

async function submitStage() {
  if (approvalState.stage !== 'sample') {
    if (!approvalState.chinaApprovalStatus) {
      showToast(bi('chinaApprovalStatusRequired').en + ' / ' + bi('chinaApprovalStatusRequired').zh, true);
      return;
    }
    if (approvalState.chinaApprovalStatus !== 'approved' && (!approvalState.notes || !approvalState.notes.trim())) {
      showToast(bi('chinaNotesRequiredForIssue').en + ' / ' + bi('chinaNotesRequiredForIssue').zh, true);
      return;
    }
  }
  if (approvalState.stage === 'sample' && approvalState.po.category === 'apparel' && approvalState.po.sizesIncluded && approvalState.po.sizesIncluded.length && !approvalState.sampledSize) {
    showToast(bi('sampledSizeRequired').en + ' / ' + bi('sampledSizeRequired').zh, true);
    return;
  }
  const btn = document.getElementById('btnSubmitStage');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>...`;
  try {
    const data = {
      factoryCode: approvalState.factoryCode,
      qaLead: approvalState.qaLead,
      productRisk: approvalState.productRisk,
      sizing: buildSizingPayload(),
      notes: approvalState.notes,
      chinaApprovalStatus: approvalState.stage === 'sample' ? '' : approvalState.chinaApprovalStatus,
      sampledSize: approvalState.stage === 'sample' ? approvalState.sampledSize : undefined
    };
    const formData = new FormData();
    formData.append('data', JSON.stringify(data));
    Object.keys(approvalState.photos).forEach((key) => {
      const slotKey = key === '_notes' ? 'notesPhotos' : key;
      approvalState.photos[key].forEach((f) => formData.append(`photo_${slotKey}`, f, f.name));
    });

    const res = await fetch(`/api/approval/${encodeURIComponent(approvalState.po.poNumber)}/${STAGE_LABELS[approvalState.stage].apiPath}`, {
      method: 'POST', body: formData
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed');
    approvalState.approval = result.approval;
    approvalState.photos = {};
    showToast(bi('stageSubmitted').en + ' / ' + bi('stageSubmitted').zh);
    render();
  } catch (e) {
    console.error(e);
    showToast(bi('submitError').en, true);
    btn.disabled = false;
    btn.innerHTML = biBlockHtml('submitPhotos', 'Submit Photos');
  }
}

async function submitReply(stage) {
  const draft = approvalState.replyDrafts[stage] || {};
  const stageKeyMap = { sample: 'sampleApproval', preProduction: 'preProductionApproval', bulk: 'bulkApproval' };
  const isFirstComment = !(approvalState.approval[stageKeyMap[stage]].pdComments || []).length;

  if (!draft.author || (isFirstComment && !draft.approvalStatus)) {
    showToast(bi('commentRequiredFields').en + ' / ' + bi('commentRequiredFields').zh, true);
    return;
  }
  const btn = document.querySelector(`[data-submit-reply="${stage}"]`);
  btn.disabled = true;
  try {
    const formData = new FormData();
    formData.append('text', draft.text || '');
    formData.append('author', draft.author);
    formData.append('approvalStatus', draft.approvalStatus || '');
    if (draft.reference) formData.append('reference', JSON.stringify(draft.reference));
    (approvalState.photos['_reply_' + stage] || []).forEach((f) => formData.append('photo', f, f.name));

    const res = await fetch(`/api/approval/${encodeURIComponent(approvalState.po.poNumber)}/${STAGE_LABELS[stage].apiPath}/comment`, {
      method: 'POST', body: formData
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed');
    approvalState.approval = result.approval;
    approvalState.replyDrafts[stage] = { author: '', approvalStatus: '', text: '', reference: null };
    approvalState.photos['_reply_' + stage] = [];
    showToast(bi('commentAdded').en + ' / ' + bi('commentAdded').zh);
    render();
  } catch (e) {
    console.error(e);
    showToast(bi('submitError').en, true);
  } finally {
    btn.disabled = false;
  }
}

(async function init() {
  await loadConfig();
  initCompareFeature();
  const cameFromLink = await initFromLink();
  render();
})();
