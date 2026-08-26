/* Juniper QA/QC Approval - Sample / Pre-Production / Bulk Approval workflows */

let I18N = {};
let OPTIONS = {};
let CONFIG = {};

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
  fit: '', generalSizingNotes: '',
  photos: {}, // slotKey (or slotKey__SizeName) -> [] of File
  notes: '', notesPhotos: [],
  commentText: '', commentAuthor: '', commentPhotos: []
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
  return true;
}

async function initFromLink() {
  const params = new URLSearchParams(location.search);
  const poId = params.get('po');
  if (!poId) return false;
  try {
    const res = await fetch(`/api/purchase-orders/${encodeURIComponent(poId)}`);
    if (!res.ok) return false;
    const { po } = await res.json();
    approvalState.stage = 'sample';
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
  if (!approvalState.stage) { root.innerHTML = renderChooser(); attachChooserHandlers(); return; }
  if (!approvalState.po) { root.innerHTML = renderPoEntry(); attachPoEntryHandlers(); return; }
  root.innerHTML = renderStageScreen();
  attachStageHandlers();
}

function backHomeLink() {
  return `<a href="index.html" class="btn btn-secondary" style="display:inline-block;width:auto;padding:10px 18px;margin-bottom:16px;text-decoration:none;">← ${biBlockHtml('goHome', 'Go Home')}</a>`;
}

function renderChooser() {
  return `
    ${backHomeLink()}
    <div class="step-title">质检审批 QA/QC Approval</div>
    <div class="home-nav-card" data-stage="sample">
      <div class="home-nav-icon">📸</div>
      <div class="home-nav-text">
        <div class="home-nav-title">${biBlockHtml('sampleApprovalTitle', 'Sample Approval')}</div>
      </div>
    </div>
    <div class="home-nav-card" data-stage="preProduction">
      <div class="home-nav-icon">🔍</div>
      <div class="home-nav-text">
        <div class="home-nav-title">${biBlockHtml('preProductionApprovalTitle', 'Pre-Production Approval')}</div>
      </div>
    </div>
    <div class="home-nav-card" data-stage="bulk">
      <div class="home-nav-icon">📦</div>
      <div class="home-nav-text">
        <div class="home-nav-title">${biBlockHtml('bulkApprovalTitle', 'Bulk Approval')}</div>
      </div>
    </div>
  `;
}
function attachChooserHandlers() {
  document.querySelectorAll('[data-stage]').forEach((el) => {
    el.addEventListener('click', () => {
      approvalState.stage = el.getAttribute('data-stage');
      render();
    });
  });
}

function renderPoEntry() {
  return `
    ${backHomeLink()}
    <div class="step-title">${biBlockHtml(STAGE_LABELS[approvalState.stage].titleKey)}</div>
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
  } else if (approvalState.stage === 'sample') {
    body = renderSampleApprovalForm();
  } else {
    body = renderPrePorBulkForm();
  }

  return `
    ${backHomeLink()}
    <div class="step-title">${biBlockHtml(STAGE_LABELS[approvalState.stage].titleKey)}</div>
    ${orderInfoBlock}
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

    <div class="card">
      <div class="section-title">${biBlockHtml('sizingTitle', 'Sizing')}</div>
      ${approvalState.po.category === 'apparel' ? renderApparelFitPicker() : renderGeneralSizingNotes()}
    </div>

    <div class="card">
      <div class="section-title">${biBlockHtml('approvedSamplePhotos', 'Approved Sample Photos')}</div>
      ${photoSlots}
    </div>

    <div class="card">
      <div class="section-title">${biBlockHtml('notesSection', 'Notes')}</div>
      <textarea id="approvalNotes" placeholder="${escapeHtml(bi('notesPlaceholder').en)} / ${escapeHtml(bi('notesPlaceholder').zh)}">${escapeHtml(approvalState.notes)}</textarea>
      ${renderPhotoSlot('_notes', 'Notes Photos', '备注照片')}
    </div>

    <button class="btn btn-primary" id="btnSubmitStage" style="margin-top:10px;">${biBlockHtml('submit', 'Submit')}</button>
  `;
}

function renderApparelFitPicker() {
  const fits = (CONFIG.fits && CONFIG.fits.fits) || {};
  const options = Object.keys(fits).map((k) => `<option value="${k}" ${approvalState.fit === k ? 'selected' : ''}>${escapeHtml(fits[k].label_zh)} ${escapeHtml(fits[k].label_en)}</option>`).join('');
  return `
    <div class="field">
      <label class="field-label">${biBlockHtml('fitSelect', 'Standard Fit')}</label>
      <select id="approvalFitSelect">
        <option value="">${escapeHtml(bi('fitSelectPlaceholder').en)}</option>
        ${options}
      </select>
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
  const prior = approvalState.approval.sampleApproval;
  const referenceBlock = prior && prior.submitted ? `
    <div class="card">
      <div class="section-title">${biBlockHtml('sampleApprovalReference', 'Sample Approval Reference')}</div>
      ${Object.keys(prior.data.photos || {}).map((slot) => `
        <div class="section-photos-block">
          <div class="section-photos-label">${escapeHtml(slot)}</div>
          <div class="photo-grid compact">
            ${(prior.data.photos[slot] || []).map((url) => `<div class="photo-thumb"><img src="${url}" /></div>`).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  ` : `<div class="card"><div class="section-help">${escapeHtml(bi('noSampleApprovalYet').en)}<br/>${escapeHtml(bi('noSampleApprovalYet').zh)}</div></div>`;

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
    <button class="btn btn-primary" id="btnSubmitStage" style="margin-top:10px;">${biBlockHtml('submit', 'Submit')}</button>
  `;
}

function renderReportingReferenceBlock() {
  const history = approvalState.reportingHistory || [];
  const matching = history.filter((h) => h.qaType === (approvalState.stage === 'preProduction' ? 'pre_production' : 'production'));
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
function renderSubmittedStage(stageData) {
  const comments = stageData.pdComments || [];
  const commentsHtml = comments.length ? comments.map((c) => `
    <div class="defect-card">
      <div class="prior-issue-header">
        <span class="prior-issue-desc">${escapeHtml(c.text)}</span>
      </div>
      <div class="section-help">${escapeHtml(c.author)} · ${new Date(c.timestamp).toLocaleString()}</div>
      ${(c.photos || []).map((url) => `<img src="${url}" class="prior-issue-photo" />`).join('')}
    </div>
  `).join('') : `<div class="section-help">${escapeHtml(bi('noCommentsYet').en)}<br/>${escapeHtml(bi('noCommentsYet').zh)}</div>`;

  return `
    <div class="card" style="background:var(--jc-mint-light); border-color:var(--jc-teal);">
      <div class="section-title">${biBlockHtml('stageSubmittedTitle', 'Submitted')}</div>
      <div class="section-help">${new Date(stageData.submittedAt).toLocaleString()}</div>
    </div>
    <div class="card">
      <div class="section-title">${biBlockHtml('pdCommentsTitle', 'Product Development Comments')}</div>
      ${commentsHtml}
      <div style="margin-top:14px; padding-top:14px; border-top:1px dashed var(--jc-border);">
        ${selectField3('commentAuthor', 'productDevelopmentLead', approvalState.commentAuthor, OPTIONS.productDevelopmentLeads || [])}
        <div class="field">
          <label class="field-label">${biBlockHtml('commentText', 'Comment')}</label>
          <textarea id="pdCommentText" placeholder="${escapeHtml(bi('commentPlaceholder').en)}">${escapeHtml(approvalState.commentText)}</textarea>
        </div>
        ${renderPhotoSlot('_comment', 'Photos', '照片')}
        <button class="btn btn-secondary" id="btnSubmitComment" style="margin-top:10px;">${biBlockHtml('addComment', 'Add Comment')}</button>
      </div>
    </div>
  `;
}

/* ---------------- HANDLERS ---------------- */

function attachStageHandlers() {
  document.querySelectorAll('[data-approval-risk]').forEach((el) => {
    el.addEventListener('click', () => { approvalState.productRisk = el.getAttribute('data-approval-risk'); render(); });
  });
  const factoryCodeSelect = document.getElementById('approval_factoryCode');
  if (factoryCodeSelect) factoryCodeSelect.addEventListener('change', (e) => { approvalState.factoryCode = e.target.value; });
  const qaLeadSelect = document.getElementById('approval_qaLead');
  if (qaLeadSelect) qaLeadSelect.addEventListener('change', (e) => { approvalState.qaLead = e.target.value; });
  const fitSelect = document.getElementById('approvalFitSelect');
  if (fitSelect) fitSelect.addEventListener('change', (e) => { approvalState.fit = e.target.value; });
  const generalSizing = document.getElementById('approvalGeneralSizing');
  if (generalSizing) generalSizing.addEventListener('input', (e) => { approvalState.generalSizingNotes = e.target.value; });
  const notes = document.getElementById('approvalNotes');
  if (notes) notes.addEventListener('input', (e) => { approvalState.notes = e.target.value; });

  const btnUsePrior = document.getElementById('btnUsePriorSample');
  if (btnUsePrior) {
    btnUsePrior.addEventListener('click', () => {
      const prior = approvalState.priorSampleApproval.data;
      approvalState.factoryCode = prior.factoryCode || '';
      approvalState.qaLead = prior.qaLead || '';
      approvalState.productRisk = prior.productRisk || 'medium';
      if (prior.sizing) approvalState.fit = prior.sizing.fit || '';
      showToast(bi('copiedFromPrior').en + ' / ' + bi('copiedFromPrior').zh);
      render();
    });
  }

  attachApprovalPhotoHandlers();

  const btnSubmit = document.getElementById('btnSubmitStage');
  if (btnSubmit) btnSubmit.addEventListener('click', submitStage);

  const commentAuthorSelect = document.getElementById('approval_commentAuthor');
  if (commentAuthorSelect) commentAuthorSelect.addEventListener('change', (e) => { approvalState.commentAuthor = e.target.value; });
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
      sizing: approvalState.po.category === 'apparel' ? { fit: approvalState.fit } : { notes: approvalState.generalSizingNotes },
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
    btn.innerHTML = biBlockHtml('submit', 'Submit');
  }
}

async function submitComment() {
  if (!approvalState.commentText.trim() || !approvalState.commentAuthor) {
    showToast(bi('commentRequiredFields').en + ' / ' + bi('commentRequiredFields').zh, true);
    return;
  }
  const btn = document.getElementById('btnSubmitComment');
  btn.disabled = true;
  try {
    const formData = new FormData();
    formData.append('text', approvalState.commentText);
    formData.append('author', approvalState.commentAuthor);
    (approvalState.photos['_comment'] || []).forEach((f) => formData.append('photo', f, f.name));

    const res = await fetch(`/api/approval/${encodeURIComponent(approvalState.po.poNumber)}/${STAGE_LABELS[approvalState.stage].apiPath}/comment`, {
      method: 'POST', body: formData
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed');
    approvalState.approval = result.approval;
    approvalState.commentText = '';
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
