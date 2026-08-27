/* Juniper QA/QC Approval - Sample / Pre-Production / Bulk Approval workflows */

let I18N = {};
let OPTIONS = {};
let CONFIG = {};

const OTHER_FIT_VALUE = '__other_fit__';

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

const STAGE_LABELS = {
  sample: { titleKey: 'sampleApprovalTitle', apiPath: 'sample' },
  preProduction: { titleKey: 'preProductionApprovalTitle', apiPath: 'preProduction' },
  bulk: { titleKey: 'bulkApprovalTitle', apiPath: 'bulk' }
};

const approvalState = {
  stage: null, // 'sample' | 'preProduction' | 'bulk'
  pdView: false, // true only when reached via the persistent ?po= share link - gates the upload form so PD never sees it, even before anything's been submitted
  poNumberInput: '',
  po: null,
  photoSet: null,
  approval: null,
  priorSampleApproval: null,
  reportingHistory: null,
  // working fields
  factoryCode: '', qaLead: '', productRisk: 'medium',
  fit: '', generalSizingNotes: '', sizeRows: [], customSizeRows: [], _fitForRows: null,
  photos: {}, // slotKey (or slotKey__SizeName) -> [] of File
  notes: '', notesPhotos: [],
  commentText: '', commentAuthor: '', commentPhotos: [], approvalStatus: ''
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

async function loadApprovalForPo(poNumber) {
  const res = await fetch(`/api/approval/${encodeURIComponent(poNumber)}`);
  if (!res.ok) return false;
  const data = await res.json();
  approvalState.po = data.po;
  approvalState.photoSet = data.photoSet;
  approvalState.approval = data.approval;
  approvalState.priorSampleApproval = data.priorSampleApproval;
  approvalState.reportingHistory = data.reportingHistory;
  approvalState.stage = approvalState.pdView ? determinePdStage(data.approval) : determineCurrentStage(data.approval);
  return true;
}

/** The PO is really just one continuous approval process - this picks up
 *  wherever it was left off: the first stage that hasn't been submitted yet,
 *  or Bulk (the last stage) if everything's already done, so there's always
 *  exactly one obvious "current" screen to show. */
/** What the Juniper China team should upload next - the first stage that
 *  hasn't been submitted yet. */
function determineCurrentStage(approval) {
  if (!approval.sampleApproval.submitted) return 'sample';
  if (!approval.preProductionApproval.submitted) return 'preProduction';
  return 'bulk';
}

/** What Product Development should be looking at right now - the most
 *  recently submitted stage, since that's what's actually ready for their
 *  review. This is deliberately different from determineCurrentStage: once
 *  Sample is submitted but Pre-Production hasn't started yet, China's "next
 *  stage" is Pre-Production (nothing to review there yet), while PD's
 *  "current stage" is still Sample (submitted, awaiting their comment). */
function determinePdStage(approval) {
  if (approval.bulkApproval.submitted) return 'bulk';
  if (approval.preProductionApproval.submitted) return 'preProduction';
  if (approval.sampleApproval.submitted) return 'sample';
  return 'sample';
}

async function initFromLink() {
  const params = new URLSearchParams(location.search);
  const poId = params.get('po');
  if (!poId) return false;
  try {
    const res = await fetch(`/api/purchase-orders/${encodeURIComponent(poId)}`);
    if (!res.ok) return false;
    const { po } = await res.json();
    approvalState.pdView = true;
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
  root.innerHTML = renderStageScreen();
  attachStageHandlers();
  attachLightboxHandlers();
}

function backHomeLink() {
  return `<a href="index.html" class="btn btn-secondary" style="display:inline-block;width:auto;padding:10px 18px;margin-bottom:16px;text-decoration:none;">← ${biBlockHtml('goHome', 'Go Home')}</a>`;
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

function currentStageData() {
  const key = STAGE_LABELS[approvalState.stage].apiPath === 'sample' ? 'sampleApproval'
    : STAGE_LABELS[approvalState.stage].apiPath === 'preProduction' ? 'preProductionApproval' : 'bulkApproval';
  return approvalState.approval ? approvalState.approval[key] : null;
}

/** Small "already done" summary cards for every stage before the current one,
 *  so it reads as one continuous process rather than three separate flows. */
function renderCompletedPriorStagesSummary() {
  const order = ['sample', 'preProduction', 'bulk'];
  const currentIdx = order.indexOf(approvalState.stage);
  if (currentIdx <= 0) return '';
  const stageKeyMap = { sample: 'sampleApproval', preProduction: 'preProductionApproval', bulk: 'bulkApproval' };
  const priorStages = order.slice(0, currentIdx).filter((s) => approvalState.approval[stageKeyMap[s]].submitted);
  if (!priorStages.length) return '';
  return priorStages.map((s) => {
    const stage = approvalState.approval[stageKeyMap[s]];
    return `
      <div class="card" style="background:var(--jc-mint-light); border-color:var(--jc-teal);">
        <div class="section-title" style="font-size:14px;">✓ ${biBlockHtml(STAGE_LABELS[s].titleKey)}</div>
        <div class="section-help">${escapeHtml(bi('completedOn').en)} ${new Date(stage.submittedAt).toLocaleDateString()}</div>
      </div>
    `;
  }).join('');
}

/* ---- Large, aligned photo displays for review (click to enlarge) ---- */
function photoSetLabelFor(slotKey) {
  const slot = (approvalState.photoSet || []).find((s) => s.key === slotKey);
  if (slot) return { en: slot.label_en, zh: slot.label_zh };
  if (slotKey === 'notesPhotos') return { en: 'Notes Photos', zh: '备注照片' };
  return { en: slotKey, zh: '' };
}
function renderPhotoGalleryLarge(photosMap) {
  const slots = Object.keys(photosMap || {}).filter((k) => (photosMap[k] || []).length);
  if (!slots.length) return `<div class="section-help">${escapeHtml(bi('noPhotosYet').en)}<br/>${escapeHtml(bi('noPhotosYet').zh)}</div>`;
  const tiles = slots.flatMap((slotKey) => {
    const label = photoSetLabelFor(slotKey);
    return photosMap[slotKey].map((url) => `
      <div class="photo-tile">
        <img src="${escapeHtml(url)}" class="js-lightbox" />
        <div class="photo-tile-caption">${escapeHtml(label.zh)} ${escapeHtml(label.en)}</div>
      </div>
    `);
  });
  return `<div class="photo-gallery-large">${tiles.join('')}</div>`;
}

/** Side-by-side: Approved Sample photo(s) for a slot next to the current
 *  stage's photo(s) for that same slot - per size for apparel, since
 *  Pre-Production/Bulk photos are captured per size there. */
/** columns: array of { label: {en,zh}, photos: {slotKey: [urls]} }, in display
 *  order (Approved Sample first, then each subsequent stage) - 2 columns for
 *  Pre-Production Approval, 3 for Bulk Approval. */
function renderPhotoComparisonLarge(columns, category, sizesIncluded) {
  if (category === 'apparel' && sizesIncluded && sizesIncluded.length) {
    const frontBackSlots = (approvalState.photoSet || []).filter((s) => s.key === 'front' || s.key === 'back');
    return sizesIncluded.map((size) => `
      <div style="margin-top:14px; padding-top:14px; border-top:1px dashed var(--jc-border);">
        <div class="section-photos-label" style="font-size:14px;">${escapeHtml(size)}</div>
        ${frontBackSlots.map((slot) => `
          <div class="photo-compare-row">
            ${columns.map((col, idx) => {
              // Approved Sample photos aren't captured per-size, every later
              // stage's photos are (photo_front__SizeName).
              const urls = idx === 0 ? (col.photos[slot.key] || []) : (col.photos[`${slot.key}__${size}`] || []);
              return `
                <div class="photo-compare-col">
                  <div class="photo-compare-col-label">${escapeHtml(col.label.en)} ${escapeHtml(col.label.zh)} · ${escapeHtml(slot.label_zh)} ${escapeHtml(slot.label_en)}</div>
                  ${urls.length ? urls.map((u) => `<img src="${escapeHtml(u)}" class="js-lightbox" />`).join('') : `<div class="section-help">${escapeHtml(bi('noPhotosYet').en)}</div>`}
                </div>
              `;
            }).join('')}
          </div>
        `).join('')}
      </div>
    `).join('');
  }

  const allSlots = [...new Set(columns.flatMap((c) => Object.keys(c.photos)))];
  return allSlots.map((slotKey) => {
    const label = photoSetLabelFor(slotKey);
    return `
      <div class="photo-compare-row">
        ${columns.map((col) => `
          <div class="photo-compare-col">
            <div class="photo-compare-col-label">${escapeHtml(col.label.en)} ${escapeHtml(col.label.zh)} · ${escapeHtml(label.en)} ${escapeHtml(label.zh)}</div>
            ${(col.photos[slotKey] || []).map((u) => `<img src="${escapeHtml(u)}" class="js-lightbox" />`).join('') || `<div class="section-help">${escapeHtml(bi('noPhotosYet').en)}</div>`}
          </div>
        `).join('')}
      </div>
    `;
  }).join('');
}

/** Collects the free-text "notes" field from every stage that's been
 *  submitted so far, so PD can see what the China QA team wrote at each
 *  point without digging through each stage separately. */
function renderCurrentProductionNotes() {
  const stages = [
    { key: 'sampleApproval', labelKey: 'sampleApprovalTitle' },
    { key: 'preProductionApproval', labelKey: 'preProductionApprovalTitle' },
    { key: 'bulkApproval', labelKey: 'bulkApprovalTitle' }
  ];
  const withNotes = stages
    .map((s) => ({ ...s, stage: approvalState.approval[s.key] }))
    .filter((s) => s.stage && s.stage.submitted && s.stage.data && s.stage.data.notes && s.stage.data.notes.trim());

  // The actual QA/QC inspection report(s) filed for THIS specific PO (not
  // other POs of the same SKU - that's what Previous PO Issues is for).
  const currentPoReports = (approvalState.reportingHistory || []).filter((r) => r.poNumber === approvalState.po.poNumber);

  const stageNotesHtml = withNotes.map((s) => `
    <div class="defect-card">
      <div class="section-photos-label">${escapeHtml(bi(s.labelKey).en)} ${escapeHtml(bi(s.labelKey).zh)}</div>
      <div class="prior-issue-desc">${escapeHtml(s.stage.data.notes)}</div>
      ${(s.stage.data.photos && s.stage.data.photos.notesPhotos || []).map((u) => `<img src="${escapeHtml(u)}" class="prior-issue-photo js-lightbox" />`).join('')}
    </div>
  `).join('');

  const reportsHtml = currentPoReports.map((r) => {
    const qaTypeLabel = r.qaType === 'production' ? bi('production') : bi('prePro');
    const resultLabel = r.overallResult === 'pass' ? bi('resultPass') : bi('resultFail');
    const issuesHtml = (r.issues && r.issues.length)
      ? r.issues.map((iss) => {
          const sevLabel = bi(iss.severity);
          return `
            <div class="prior-issue-card">
              <div class="prior-issue-header">
                <span class="prior-issue-desc">${escapeHtml(iss.description || '-')}</span>
                <span class="severity-badge severity-${escapeHtml(iss.severity)}">${escapeHtml(sevLabel.en)} ${escapeHtml(sevLabel.zh)}</span>
              </div>
              <div class="section-help">${escapeHtml(bi('unitsAffected').en)}: ${iss.unitsAffected}</div>
              ${iss.photoUrl ? `<img src="${escapeHtml(iss.photoUrl)}" class="prior-issue-photo js-lightbox" />` : ''}
            </div>
          `;
        }).join('')
      : '';
    return `
      <div class="defect-card">
        <div class="section-photos-label">${escapeHtml(bi('linkedReportTitle').en)} ${escapeHtml(bi('linkedReportTitle').zh)} - ${escapeHtml(qaTypeLabel.en)} ${escapeHtml(qaTypeLabel.zh)}</div>
        <div class="section-help">
          ${escapeHtml(r.date || '')} ·
          <strong style="color:${r.overallResult === 'pass' ? 'var(--jc-teal-dark)' : 'var(--jc-fail)'}">${escapeHtml(resultLabel.en)} ${escapeHtml(resultLabel.zh)}</strong>
        </div>
        ${issuesHtml}
        <a href="/submissions/${encodeURIComponent(r.pdfFilename)}" target="_blank" rel="noopener" class="btn btn-secondary" style="display:block; text-decoration:none; text-align:center; margin-top:8px; max-width:220px;">${escapeHtml(bi('downloadFullReport').en)}</a>
      </div>
    `;
  }).join('');

  const body = stageNotesHtml + reportsHtml;

  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('currentProductionNotesTitle', 'Current Production Notes')}</div>
      ${body || `<div class="section-help">${escapeHtml(bi('noNotesYet').en)}<br/>${escapeHtml(bi('noNotesYet').zh)}</div>`}
    </div>
  `;
}

/** Only issues from OTHER POs of the same SKU (not this PO's own reports -
 *  those show in Current Production Notes instead), and only Major/Critical -
 *  Minor issues don't need to be surfaced as a flag to Product Development. */
function renderPreviousPoIssuesSection() {
  const otherPoReports = (approvalState.reportingHistory || []).filter((r) => r.poNumber !== approvalState.po.poNumber);
  const withMajorCritical = otherPoReports
    .map((r) => ({ ...r, issues: (r.issues || []).filter((iss) => iss.severity === 'major' || iss.severity === 'critical') }))
    .filter((r) => r.issues.length);

  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('previousPoIssuesTitle', 'Previous PO Issues')}</div>
      ${!withMajorCritical.length ? `<div class="section-help">${escapeHtml(bi('noIssues').en)}<br/>${escapeHtml(bi('noIssues').zh)}</div>` : withMajorCritical.map((r) => {
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
                  <div class="section-help">${escapeHtml(bi('unitsAffected').en)}: ${iss.unitsAffected}</div>
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
            <a href="/submissions/${encodeURIComponent(r.pdfFilename)}" target="_blank" rel="noopener" class="btn btn-secondary" style="display:block; text-decoration:none; text-align:center; margin-top:8px; max-width:220px;">${escapeHtml(bi('downloadFullReport').en)}</a>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderStageScreen() {
  const stageData = currentStageData();
  const po = approvalState.po;

  const orderInfoBlock = `
    <div class="card">
      <div class="section-title">${biBlockHtml('poInfo', 'Order Information')}</div>
      <div class="review-row"><span class="k">${escapeHtml(bi('poNumber').en)}</span><span class="v">${escapeHtml(po.poNumber)}</span></div>
      <div class="review-row"><span class="k">${escapeHtml(bi('productSku').en)}</span><span class="v">${escapeHtml(po.sku)}</span></div>
      <div class="review-row"><span class="k">${escapeHtml(bi('poQuantity').en)}</span><span class="v">${escapeHtml(po.orderQuantity)}</span></div>
      <div class="review-row"><span class="k">${escapeHtml(bi('creator').en)}</span><span class="v">${escapeHtml(po.creator || '-')}</span></div>
      <div class="review-row"><span class="k">${escapeHtml(bi('productDevelopmentLead').en)}</span><span class="v">${escapeHtml(po.productDevelopmentLead || '-')}</span></div>
    </div>
  `;

  let body;
  if (stageData && stageData.submitted) {
    body = renderSubmittedStage(stageData);
  } else if (approvalState.pdView) {
    body = `<div class="card"><div class="section-help">${escapeHtml(bi('notReadyForReview').en)}<br/>${escapeHtml(bi('notReadyForReview').zh)}</div></div>`;
  } else if (approvalState.stage === 'sample') {
    body = renderSampleApprovalForm();
  } else {
    body = renderPrePorBulkForm();
  }

  return `
    ${backHomeLink()}
    <div class="step-title">${biBlockHtml(STAGE_LABELS[approvalState.stage].titleKey)}</div>
    ${orderInfoBlock}
    ${renderCompletedPriorStagesSummary()}
    ${body}
  `;
}

/* ---- Sample Approval form ---- */
function renderSampleApprovalForm() {
  const prior = approvalState.priorSampleApproval;
  const priorBlock = prior ? `
    <div class="card" style="background:var(--jc-mint-light); border-color:var(--jc-teal);">
      <div class="section-title">${biBlockHtml('priorSampleApprovalFound', 'Prior Sample Approval Found')}</div>
      <div class="section-help">${escapeHtml(bi('priorSampleApprovalHelp').en)} (${escapeHtml(prior.poNumber)})<br/>${escapeHtml(bi('priorSampleApprovalHelp').zh)}</div>
      <button type="button" class="btn btn-secondary" id="btnUsePriorSample" style="margin-top:10px;">${biBlockHtml('copyFromPrior', 'Copy From Prior PO')}</button>
    </div>
  ` : '';

  const photoSlots = (approvalState.photoSet || []).map((slot) => renderPhotoSlot(slot.key, slot.label_en, slot.label_zh)).join('');

  return `
    ${priorBlock}
    <div class="card">
      <div class="section-title">${biBlockHtml('sampleDetailsTitle', 'Sample Details')}</div>
      ${selectField3('factoryCode', 'factoryCode', approvalState.factoryCode, OPTIONS.factoryCodes || [])}
      ${selectField3('qaLead', 'qaLead', approvalState.qaLead, OPTIONS.qaLeads || [])}
      <div class="field">
        <label class="field-label">${biBlockHtml('productRisk', 'Product Complexity/Risk')}</label>
        <div class="segmented">
          ${['high', 'medium', 'low'].map((r) => `<div class="segmented-option ${approvalState.productRisk === r ? 'selected' : ''}" data-approval-risk="${r}">${escapeHtml(bi('risk' + r.charAt(0).toUpperCase() + r.slice(1)).en)}<span class="zh">${escapeHtml(bi('risk' + r.charAt(0).toUpperCase() + r.slice(1)).zh)}</span></div>`).join('')}
        </div>
      </div>
    </div>

    ${renderSizingSection()}

    <div class="card">
      <div class="section-title">${biBlockHtml('approvedSamplePhotos', 'Approved Sample Photos')}</div>
      ${photoSlots}
    </div>

    <div class="card">
      <div class="section-title">${biBlockHtml('notesSection', 'Notes')}</div>
      <textarea id="approvalNotes" placeholder="${escapeHtml(bi('notesPlaceholder').en)} / ${escapeHtml(bi('notesPlaceholder').zh)}">${escapeHtml(approvalState.notes)}</textarea>
      ${renderPhotoSlot('_notes', 'Notes Photos', '备注照片')}
    </div>

    <button class="btn btn-primary" id="btnSubmitStage" style="margin-top:10px;">${biBlockHtml('submitPhotos', 'Submit Photos')}</button>
  `;
}

function renderSizingSection() {
  if (approvalState.po.category !== 'apparel') {
    return `
      <div class="card">
        <div class="section-title">${biBlockHtml('sizingTitle', 'Sizing')}</div>
        ${renderGeneralSizingNotes()}
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
    return pickerCard + renderApprovalReferenceChart(fits[approvalState.fit]) + renderApprovalSizeEntryTable(fits[approvalState.fit]);
  }
  return pickerCard;
}

/** Read-only reference chart of the standard's defined values, scoped to the
 *  sizes actually included in this PO if that's been set. */
function renderApprovalReferenceChart(fitDef) {
  const sizesIncluded = (approvalState.po.sizesIncluded && approvalState.po.sizesIncluded.length) ? approvalState.po.sizesIncluded : null;
  const sizeNames = Object.keys(fitDef.sizes).filter((s) => !sizesIncluded || sizesIncluded.some((canonical) => s === canonical || s.startsWith(canonical + ' ') || s.startsWith(canonical + '(')));
  const pointCols = fitDef.points.map((p) => {
    const pl = fitDef.pointLabels[p] || { en: p, zh: '' };
    return `<th>${escapeHtml(pl.zh || pl.en)}<span class="zh">${escapeHtml(pl.en)}</span></th>`;
  }).join('');
  const rows = sizeNames.map((sizeName) => {
    const std = fitDef.sizes[sizeName];
    const cells = fitDef.points.map((p) => `<td>${escapeHtml(formatStandard(std[p]))}</td>`).join('');
    return `<tr><td class="size-name">${escapeHtml(sizeName)}</td>${cells}</tr>`;
  }).join('');
  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('referenceChart', 'Approved Reference Chart')}</div>
      <div class="ref-chart-wrap">
        <table class="ref-chart-table">
          <thead><tr><th>${escapeHtml(bi('size').en)}<span class="zh">${escapeHtml(bi('size').zh)}</span></th>${pointCols}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

/** Editable measurement entry, one card per size (scoped to the PO's
 *  included sizes if set), with a photo slot per size and tolerance
 *  flagging - the same capability the Reporting flow has, so the approved
 *  sample's actual measurements get captured here as the baseline. */
function renderApprovalSizeEntryTable(fitDef) {
  const tol = (CONFIG.fits && CONFIG.fits.toleranceInches) || 0.5;
  const sizesIncluded = (approvalState.po.sizesIncluded && approvalState.po.sizesIncluded.length) ? approvalState.po.sizesIncluded : null;

  if (!approvalState.sizeRows.length || approvalState._fitForRows !== approvalState.fit) {
    const availableSizes = Object.keys(fitDef.sizes).filter((s) => !sizesIncluded || sizesIncluded.some((canonical) => s === canonical || s.startsWith(canonical + ' ') || s.startsWith(canonical + '(')));
    approvalState.sizeRows = availableSizes.map((size) => ({ size, measured: {} }));
    approvalState._fitForRows = approvalState.fit;
  }

  const cards = approvalState.sizeRows.map((row, ridx) => {
    const standard = fitDef.sizes[row.size] || {};
    const pointFields = fitDef.points.map((p) => {
      const pl = fitDef.pointLabels[p] || { en: p, zh: '' };
      const std = standard[p];
      const measuredVal = row.measured[p] !== undefined ? row.measured[p] : '';
      const measuredNum = parseFloat(measuredVal);
      const outOfTol = isOutOfTolerance(std, measuredVal === '' ? null : measuredNum, tol);
      return `
        <div class="size-point-field ${outOfTol ? 'out-of-tol' : ''}">
          <label class="size-point-label">${escapeHtml(pl.zh || pl.en)} <span class="zh">${escapeHtml(pl.en)}</span></label>
          <span class="std-val">${escapeHtml(bi('standard').en)}: ${escapeHtml(formatStandard(std))}</span>
          <input type="number" step="0.1" inputmode="decimal" value="${escapeHtml(measuredVal)}"
            class="${outOfTol ? 'out-of-tol' : ''}"
            data-approval-size-row="${ridx}" data-approval-size-point="${p}" placeholder="0.0" />
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
          ${renderPhotoSlot('sizecheck', 'Photo', '照片', row.size)}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('enterMeasurements', 'Enter Measurements')}</div>
      ${cards}
    </div>
  `;
}

/** For a custom ("Other") fit: freeform size rows, pre-seeded from the PO's
 *  included sizes if that's been set, otherwise added manually. */
function renderApprovalCustomSizeChart() {
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

function renderGeneralSizingNotes() {
  return `
    <div class="field">
      <label class="field-label">${biBlockHtml('customSizeMeasurements', 'Measurements')}</label>
      <textarea id="approvalGeneralSizing" placeholder="${escapeHtml(bi('customSizeMeasurementsPlaceholder').en)}">${escapeHtml(approvalState.generalSizingNotes)}</textarea>
    </div>
  `;
}

function photoKey(slot, size) { return size ? `${slot}__${size}` : slot; }
function renderPhotoSlot(slotKey, labelEn, labelZh, size) {
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
      <div class="photo-grid compact">
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

/* ---- Pre-Production / Bulk Approval form ---- */
function renderPrePorBulkForm() {
  const sample = approvalState.approval.sampleApproval;
  const preProduction = approvalState.approval.preProductionApproval;
  const isBulkStage = approvalState.stage === 'bulk';

  let referenceBlock;
  if (!sample || !sample.submitted) {
    referenceBlock = `<div class="card"><div class="section-help">${escapeHtml(bi('noSampleApprovalYet').en)}<br/>${escapeHtml(bi('noSampleApprovalYet').zh)}</div></div>`;
  } else if (isBulkStage && preProduction && preProduction.submitted) {
    // Bulk: show both prior sets side by side for reference while uploading.
    const columns = [
      { label: bi('approvedSample', 'Approved Sample'), photos: sample.data.photos || {} },
      { label: bi('preProductionApprovalTitle', 'Pre-Production Approval'), photos: preProduction.data.photos || {} }
    ];
    referenceBlock = `
      <div class="card">
        <div class="section-title">${biBlockHtml('priorApprovalsReference', 'Prior Approvals Reference')}</div>
        ${renderPhotoComparisonLarge(columns, approvalState.po.category, approvalState.po.sizesIncluded)}
      </div>
    `;
  } else {
    referenceBlock = `
      <div class="card">
        <div class="section-title">${biBlockHtml('sampleApprovalReference', 'Sample Approval Reference')}</div>
        ${renderPhotoGalleryLarge(sample.data.photos || {})}
      </div>
    `;
  }

  const reportBlock = renderReportingReferenceBlock();

  let photoSlotsHtml;
  if (approvalState.po.category === 'apparel' && approvalState.po.sizesIncluded && approvalState.po.sizesIncluded.length) {
    const frontBack = (approvalState.photoSet || []).filter((s) => s.key === 'front' || s.key === 'back');
    photoSlotsHtml = approvalState.po.sizesIncluded.map((size) => `
      <div style="margin-top:12px; padding-top:12px; border-top:1px dashed var(--jc-border);">
        <div class="section-photos-label" style="font-size:14px;">${escapeHtml(size)}</div>
        ${frontBack.map((slot) => renderPhotoSlot(slot.key, slot.label_en, slot.label_zh, size)).join('')}
      </div>
    `).join('');
  } else {
    photoSlotsHtml = (approvalState.photoSet || []).map((slot) => renderPhotoSlot(slot.key, slot.label_en, slot.label_zh)).join('');
  }

  return `
    ${referenceBlock}
    ${reportBlock}
    <div class="card">
      <div class="section-title">${biBlockHtml(approvalState.stage === 'preProduction' ? 'preProductionApprovalPhotos' : 'bulkApprovalPhotos', 'Approval Photos')}</div>
      ${photoSlotsHtml}
    </div>
    <div class="card">
      <div class="section-title">${biBlockHtml('notesSection', 'Notes')} <span class="section-help">(${escapeHtml(bi('optional').en)})</span></div>
      <textarea id="approvalNotes" placeholder="${escapeHtml(bi('notesPlaceholder').en)} / ${escapeHtml(bi('notesPlaceholder').zh)}">${escapeHtml(approvalState.notes)}</textarea>
      ${renderPhotoSlot('_notes', 'Notes Photos', '备注照片')}
    </div>
    <button class="btn btn-primary" id="btnSubmitStage" style="margin-top:10px;">${biBlockHtml('submitPhotos', 'Submit Photos')}</button>
  `;
}

function renderReportingReferenceBlock() {
  const history = approvalState.reportingHistory || [];
  const matching = history.filter((h) => h.poNumber === approvalState.po.poNumber && h.qaType === (approvalState.stage === 'preProduction' ? 'pre_production' : 'production'));
  if (!matching.length) return '';
  const latest = matching[0];
  const resultLabel = latest.overallResult === 'pass' ? bi('resultPass') : bi('resultFail');
  return `
    <div class="card">
      <div class="section-title">${biBlockHtml('linkedReportTitle', 'Linked Inspection Report')}</div>
      <div class="section-help">${escapeHtml(latest.date || '')} · <strong style="color:${latest.overallResult === 'pass' ? 'var(--jc-teal-dark)' : 'var(--jc-fail)'}">${escapeHtml(resultLabel.en)} ${escapeHtml(resultLabel.zh)}</strong></div>
      <a href="/submissions/${encodeURIComponent(latest.pdfFilename)}" target="_blank" rel="noopener" class="btn btn-secondary" style="display:block; text-decoration:none; text-align:center; margin-top:10px; max-width:260px;">${escapeHtml(bi('downloadFullReport').en)}</a>
    </div>
  `;
}

/* ---- Submitted stage: show data read-back + PD comments ---- */
function updateApprovalSizeCellInPlace(ridx, point) {
  const fits = fitsForPoSubcategory();
  const fitDef = fits[approvalState.fit];
  if (!fitDef) return;
  const tol = (CONFIG.fits && CONFIG.fits.toleranceInches) || 0.5;
  const row = approvalState.sizeRows[ridx];
  const standard = fitDef.sizes[row.size] || {};
  const measuredVal = row.measured[point] !== undefined ? row.measured[point] : '';
  const measuredNum = parseFloat(measuredVal);
  const outOfTol = isOutOfTolerance(standard[point], measuredVal === '' ? null : measuredNum, tol);
  const input = document.querySelector(`[data-approval-size-row="${ridx}"][data-approval-size-point="${point}"]`);
  if (!input) return;
  const cell = input.closest('.size-point-field');
  const flag = cell ? cell.querySelector('.tol-flag') : null;
  if (cell) cell.classList.toggle('out-of-tol', outOfTol);
  input.classList.toggle('out-of-tol', outOfTol);
  if (flag) flag.style.display = outOfTol ? 'inline' : 'none';
}

function buildSizingPayload() {
  if (approvalState.po.category !== 'apparel') return { notes: approvalState.generalSizingNotes };
  if (approvalState.fit === OTHER_FIT_VALUE) return { fit: OTHER_FIT_VALUE, customSizeRows: approvalState.customSizeRows };
  return { fit: approvalState.fit, sizeRows: approvalState.sizeRows };
}

function commentStageTitle() {
  if (approvalState.stage === 'sample') return bi('commentStageTitleSample', 'Sample Approval');
  if (approvalState.stage === 'preProduction') return bi('commentStageTitlePreProduction', 'PP Sample Approval');
  return bi('commentStageTitleBulk', 'Bulk Sample Approval');
}

function renderSubmittedStage(stageData) {
  const sample = approvalState.approval.sampleApproval;
  const preProduction = approvalState.approval.preProductionApproval;
  const samplePhotos = (sample && sample.data && sample.data.photos) || {};
  const isSampleStage = approvalState.stage === 'sample';
  const isBulkStage = approvalState.stage === 'bulk';

  let comparisonColumns = [{ label: bi('approvedSample', 'Approved Sample'), photos: samplePhotos }];
  if (isBulkStage) {
    comparisonColumns.push({ label: bi('preProductionApprovalTitle', 'Pre-Production Approval'), photos: (preProduction && preProduction.data && preProduction.data.photos) || {} });
  }
  if (!isSampleStage) {
    comparisonColumns.push({ label: bi('thisStage', 'This Stage'), photos: stageData.data.photos });
  }

  const referenceBlock = `
    <div class="card">
      <div class="section-title">${biBlockHtml('approvedSamplePhotosReference', 'Approved Sample Photos')}</div>
      ${isSampleStage
        ? renderPhotoGalleryLarge(samplePhotos)
        : renderPhotoComparisonLarge(comparisonColumns, approvalState.po.category, approvalState.po.sizesIncluded)}
    </div>
  `;

  const stageTitle = commentStageTitle();
  const comments = stageData.pdComments || [];
  const commentsHtml = comments.length ? comments.map((c) => `
    <div class="defect-card comment-card ${approvalStatusColorClass(c.approvalStatus)}">
      <div class="prior-issue-header">
        <span class="prior-issue-desc" style="font-weight:700;">${escapeHtml(stageTitle.en)} ${escapeHtml(stageTitle.zh)}</span>
        <span class="severity-badge comment-badge-${approvalStatusColorClass(c.approvalStatus)}">${escapeHtml(bi(approvalStatusLabelKey(c.approvalStatus)).en)} ${escapeHtml(bi(approvalStatusLabelKey(c.approvalStatus)).zh)}</span>
      </div>
      ${c.text ? `<div class="prior-issue-desc" style="margin-top:4px;">${escapeHtml(c.text)}</div>` : `<div class="prior-issue-desc" style="margin-top:4px; font-style:italic; color:var(--jc-muted);">${escapeHtml(bi('noCommentTextProvided').en)}</div>`}
      <div class="section-help">${escapeHtml(c.author)} · ${new Date(c.timestamp).toLocaleString()}</div>
      ${(c.photos || []).map((url) => `<img src="${escapeHtml(url)}" class="prior-issue-photo js-lightbox" />`).join('')}
    </div>
  `).join('') : `<div class="section-help">${escapeHtml(bi('noCommentsYet').en)}<br/>${escapeHtml(bi('noCommentsYet').zh)}</div>`;

  return `
    <div class="card" style="background:var(--jc-mint-light); border-color:var(--jc-teal);">
      <div class="section-title">${biBlockHtml('stageSubmittedTitle', 'Submitted')}</div>
      <div class="section-help">${new Date(stageData.submittedAt).toLocaleString()}</div>
    </div>
    ${referenceBlock}
    ${renderCurrentProductionNotes()}
    <div class="card">
      <div class="section-title">${biBlockHtml('pdCommentsTitle', 'Product Development Comments')}</div>
      ${commentsHtml}
      <div style="margin-top:14px; padding-top:14px; border-top:1px dashed var(--jc-border);">
        <div class="section-help" style="font-weight:700; color:var(--jc-teal-dark); margin-bottom:8px;">${escapeHtml(stageTitle.en)} ${escapeHtml(stageTitle.zh)}</div>
        ${selectField3('commentAuthor', 'productDevelopmentLead', approvalState.commentAuthor, OPTIONS.productDevelopmentLeads || [])}
        <div class="field">
          <label class="field-label">${biBlockHtml('approvalStatusLabel', 'Approval')}</label>
          <select id="approvalStatusSelect">
            <option value="">${escapeHtml(bi('selectPlaceholder').en)}</option>
            <option value="minorIssue" ${approvalState.approvalStatus === 'minorIssue' ? 'selected' : ''}>${escapeHtml(bi('statusMinorIssue').en)} ${escapeHtml(bi('statusMinorIssue').zh)}</option>
            <option value="majorCriticalIssue" ${approvalState.approvalStatus === 'majorCriticalIssue' ? 'selected' : ''}>${escapeHtml(bi('statusMajorCriticalIssue').en)} ${escapeHtml(bi('statusMajorCriticalIssue').zh)}</option>
            <option value="approved" ${approvalState.approvalStatus === 'approved' ? 'selected' : ''}>${escapeHtml(bi('statusApproved').en)} ${escapeHtml(bi('statusApproved').zh)}</option>
            <option value="approvedWithComments" ${approvalState.approvalStatus === 'approvedWithComments' ? 'selected' : ''}>${escapeHtml(bi('statusApprovedWithComments').en)} ${escapeHtml(bi('statusApprovedWithComments').zh)}</option>
          </select>
        </div>
        <div class="field">
          <label class="field-label">${biBlockHtml('commentText', 'Comment')}</label>
          <textarea id="pdCommentText" placeholder="${escapeHtml(bi('commentPlaceholder').en)}">${escapeHtml(approvalState.commentText)}</textarea>
        </div>
        ${renderPhotoSlot('_comment', 'Photos', '照片')}
        <button class="btn btn-primary" id="btnSubmitComment" style="margin-top:10px;">${biBlockHtml('submitApproval', 'Submit Approval')}</button>
      </div>
    </div>
    <div class="major-divider"></div>
    ${renderPreviousPoIssuesSection()}
  `;
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
  document.querySelectorAll('[data-approval-risk]').forEach((el) => {
    el.addEventListener('click', () => { approvalState.productRisk = el.getAttribute('data-approval-risk'); render(); });
  });
  const factoryCodeSelect = document.getElementById('approval_factoryCode');
  if (factoryCodeSelect) factoryCodeSelect.addEventListener('change', (e) => { approvalState.factoryCode = e.target.value; });
  const qaLeadSelect = document.getElementById('approval_qaLead');
  if (qaLeadSelect) qaLeadSelect.addEventListener('change', (e) => { approvalState.qaLead = e.target.value; });
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
  const generalSizing = document.getElementById('approvalGeneralSizing');
  if (generalSizing) generalSizing.addEventListener('input', (e) => { approvalState.generalSizingNotes = e.target.value; });
  const notes = document.getElementById('approvalNotes');
  if (notes) notes.addEventListener('input', (e) => { approvalState.notes = e.target.value; });

  // Standard-fit measurement inputs
  document.querySelectorAll('[data-approval-size-row]').forEach((el) => {
    el.addEventListener('input', (e) => {
      const ridx = parseInt(el.getAttribute('data-approval-size-row'), 10);
      const point = el.getAttribute('data-approval-size-point');
      approvalState.sizeRows[ridx].measured[point] = e.target.value;
      updateApprovalSizeCellInPlace(ridx, point);
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
      if (prior.sizing) {
        approvalState.fit = prior.sizing.fit || '';
        approvalState.generalSizingNotes = prior.sizing.notes || '';
        approvalState.sizeRows = prior.sizing.sizeRows ? JSON.parse(JSON.stringify(prior.sizing.sizeRows)) : [];
        approvalState.customSizeRows = prior.sizing.customSizeRows ? JSON.parse(JSON.stringify(prior.sizing.customSizeRows)) : [];
        approvalState._fitForRows = approvalState.sizeRows.length ? approvalState.fit : null;
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

  const commentAuthorSelect = document.getElementById('approval_commentAuthor');
  if (commentAuthorSelect) commentAuthorSelect.addEventListener('change', (e) => { approvalState.commentAuthor = e.target.value; });
  const approvalStatusSelect = document.getElementById('approvalStatusSelect');
  if (approvalStatusSelect) approvalStatusSelect.addEventListener('change', (e) => { approvalState.approvalStatus = e.target.value; });
  const commentText = document.getElementById('pdCommentText');
  if (commentText) commentText.addEventListener('input', (e) => { approvalState.commentText = e.target.value; });
  const btnSubmitComment = document.getElementById('btnSubmitComment');
  if (btnSubmitComment) btnSubmitComment.addEventListener('click', submitComment);
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

async function submitStage() {
  const btn = document.getElementById('btnSubmitStage');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>...`;
  try {
    const data = {
      factoryCode: approvalState.factoryCode,
      qaLead: approvalState.qaLead,
      productRisk: approvalState.productRisk,
      sizing: buildSizingPayload(),
      notes: approvalState.notes
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

async function submitComment() {
  if (!approvalState.commentAuthor || !approvalState.approvalStatus) {
    showToast(bi('commentRequiredFields').en + ' / ' + bi('commentRequiredFields').zh, true);
    return;
  }
  const btn = document.getElementById('btnSubmitComment');
  btn.disabled = true;
  try {
    const formData = new FormData();
    formData.append('text', approvalState.commentText);
    formData.append('author', approvalState.commentAuthor);
    formData.append('approvalStatus', approvalState.approvalStatus);
    (approvalState.photos['_comment'] || []).forEach((f) => formData.append('photo', f, f.name));

    const res = await fetch(`/api/approval/${encodeURIComponent(approvalState.po.poNumber)}/${STAGE_LABELS[approvalState.stage].apiPath}/comment`, {
      method: 'POST', body: formData
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed');
    approvalState.approval = result.approval;
    approvalState.commentText = '';
    approvalState.approvalStatus = '';
    approvalState.photos = {};
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
  const cameFromLink = await initFromLink();
  render();
})();
