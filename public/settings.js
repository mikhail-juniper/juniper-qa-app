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

/* ---- View as (shared session only) ----
 * Switches which account type the site renders as, without logging out.
 * A preview tool for building and checking the role-based views: it's not a
 * restriction, since anyone on the shared password can switch back.
 */
function renderViewAsCard(me) {
  const host = document.getElementById('viewAsCard');
  if (!host) return;
  if (!me.canSwitchView) { host.innerHTML = ''; return; } // real accounts can't self-select
  const labels = {
    admin: 'Juniper admin - full access',
    internal: 'Juniper team - orders and QA',
    qa: 'QA/QC - reporting and approvals',
    supplier: 'Supplier - their own POs only'
  };
  const current = (me.user && me.user.role) || 'admin';
  const currentSupplier = (me.user && me.user.supplierName) || '';
  host.innerHTML = `
    <div class="card">
      <div class="section-title">Viewing As</div>
      <div class="section-help" style="margin-bottom:14px;">
        Switch which account type the site renders as. This is for previewing and testing the
        role-based views - it isn't access control, since anyone with the site password can
        switch back. Real restrictions come from per-user accounts below.
      </div>
      <div class="field-row" style="gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <div style="flex:1 1 220px;"><label>Account type</label>
          <select id="viewAsRole">
            ${(me.roles || []).map((r) => `<option value="${r}" ${r === current ? 'selected' : ''}>${labels[r] || r}</option>`).join('')}
          </select>
        </div>
        <div style="flex:1 1 200px;" id="viewAsSupplierWrap">
          <label>Supplier</label>
          <select id="viewAsSupplier">
            <option value="">Select a supplier...</option>
            ${appSuppliers.map((sp) => `<option value="${escapeHtml(sp)}" ${sp === currentSupplier ? 'selected' : ''}>${escapeHtml(sp)}</option>`).join('')}
          </select>
        </div>
        <button type="button" class="btn btn-primary" id="viewAsApply" style="flex:none;width:auto;padding:9px 16px;">Apply</button>
      </div>
    </div>
  `;
  const roleSel = document.getElementById('viewAsRole');
  const supWrap = document.getElementById('viewAsSupplierWrap');
  const syncSupplier = () => { supWrap.style.display = roleSel.value === 'supplier' ? '' : 'none'; };
  roleSel.addEventListener('change', syncSupplier);
  syncSupplier();
  document.getElementById('viewAsApply').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/session/view', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewRole: roleSel.value, viewSupplierName: document.getElementById('viewAsSupplier').value })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Could not switch view');
      // Go to the new role's landing page - it may not be allowed to open
      // Settings at all (only admins are).
      location.href = body.landing || location.pathname;
    } catch (e) { showToast(e.message, true); }
  });
}

/* ---- Users, roles and permissions ----
 * Only rendered for admins. The shared site password still works and grants
 * admin, so this section is reachable on day one without any accounts
 * existing yet.
 */
let appUsers = [];
let appRoles = [];
let appSuppliers = [];

function renderUsersCard() {
  const host = document.getElementById('usersCard');
  if (!host) return;
  host.innerHTML = `
    <div class="card">
      <div class="section-title">Users &amp; Access</div>
      <div class="section-help" style="margin-bottom:14px;">
        Accounts, roles and permissions. The shared site password still works and grants full access,
        so adding accounts here is additive - nobody gets locked out.
        Supplier accounts only ever see purchase orders they supply a part of.
      </div>
      ${appUsers.length ? `
      <div class="om-table-wrap" style="margin-bottom:14px;">
        <table class="om-table" style="min-width:0;">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Supplier</th><th>Last login</th><th></th></tr></thead>
          <tbody>
            ${appUsers.map((u) => `
              <tr data-user="${escapeHtml(u.id)}">
                <td><input type="text" data-u-field="name" value="${escapeHtml(u.name)}" /></td>
                <td>${escapeHtml(u.email)}</td>
                <td>
                  <select data-u-field="role">
                    ${appRoles.map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}
                  </select>
                </td>
                <td>
                  <select data-u-field="supplierName">
                    <option value="">—</option>
                    ${appSuppliers.map((sp) => `<option value="${escapeHtml(sp)}" ${sp === u.supplierName ? 'selected' : ''}>${escapeHtml(sp)}</option>`).join('')}
                  </select>
                </td>
                <td style="font-size:12px;color:var(--jc-muted);">${u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}</td>
                <td style="white-space:nowrap;">
                  <button type="button" class="om-table-upload-btn" data-u-save="${escapeHtml(u.id)}">Save</button>
                  <button type="button" class="om-table-upload-btn" data-u-pw="${escapeHtml(u.id)}">Password</button>
                  <button type="button" class="om-table-upload-btn" data-u-del="${escapeHtml(u.id)}">Delete</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>` : '<div class="section-help" style="margin-bottom:14px;">No accounts yet.</div>'}

      <div class="field-row" style="gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <div style="flex:1 1 160px;"><label>Name</label><input type="text" id="newUserName" /></div>
        <div style="flex:1 1 180px;"><label>Email</label><input type="email" id="newUserEmail" /></div>
        <div style="flex:0 1 130px;"><label>Role</label>
          <select id="newUserRole">${appRoles.map((r) => `<option value="${r}">${r}</option>`).join('')}</select>
        </div>
        <div style="flex:0 1 170px;"><label>Supplier (supplier role)</label>
          <select id="newUserSupplier"><option value="">—</option>${appSuppliers.map((sp) => `<option value="${escapeHtml(sp)}">${escapeHtml(sp)}</option>`).join('')}</select>
        </div>
        <div style="flex:1 1 150px;"><label>Password</label><input type="text" id="newUserPassword" /></div>
        <button type="button" class="btn btn-primary" id="newUserAdd" style="flex:none;width:auto;padding:9px 16px;">+ Add user</button>
      </div>
    </div>
  `;
  wireUsersCard();
}

function wireUsersCard() {
  const readRow = (id) => {
    const row = document.querySelector(`[data-user="${id}"]`);
    const v = (f) => { const el = row.querySelector(`[data-u-field="${f}"]`); return el ? el.value : undefined; };
    return { name: v('name'), role: v('role'), supplierName: v('supplierName') };
  };
  const call = async (url, opts) => {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Request failed');
    return res.json();
  };
  document.querySelectorAll('[data-u-save]').forEach((b) => b.addEventListener('click', async () => {
    try { await call(`/api/users/${b.dataset.uSave}`, { method: 'PATCH', body: JSON.stringify(readRow(b.dataset.uSave)) });
      showToast('User saved'); await loadUsers(); } catch (e) { showToast(e.message, true); }
  }));
  document.querySelectorAll('[data-u-pw]').forEach((b) => b.addEventListener('click', async () => {
    const pw = prompt('New password for this user:');
    if (!pw) return;
    try { await call(`/api/users/${b.dataset.uPw}`, { method: 'PATCH', body: JSON.stringify({ password: pw }) });
      showToast('Password set'); } catch (e) { showToast(e.message, true); }
  }));
  document.querySelectorAll('[data-u-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this user?')) return;
    try { await call(`/api/users/${b.dataset.uDel}`, { method: 'DELETE' });
      showToast('User deleted'); await loadUsers(); } catch (e) { showToast(e.message, true); }
  }));
  const add = document.getElementById('newUserAdd');
  if (add) add.addEventListener('click', async () => {
    const payload = {
      name: document.getElementById('newUserName').value,
      email: document.getElementById('newUserEmail').value,
      role: document.getElementById('newUserRole').value,
      supplierName: document.getElementById('newUserSupplier').value,
      password: document.getElementById('newUserPassword').value
    };
    if (!payload.email) return showToast('Email is required', true);
    try { await call('/api/users', { method: 'POST', body: JSON.stringify(payload) });
      showToast('User created'); await loadUsers(); } catch (e) { showToast(e.message, true); }
  });
}

async function loadUsers() {
  try {
    const me = await (await fetch('/api/me')).json();
    // Supplier names feed both the view switcher and the user rows, so load
    // them before rendering either.
    const sRes = await fetch('/api/suppliers');
    const sData = sRes.ok ? await sRes.json() : { suppliers: [] };
    appSuppliers = (sData.suppliers || []).map((x) => x.name).filter(Boolean).sort();
    appRoles = me.roles || [];
    renderViewAsCard(me);
    // User administration is admin-only; the view switcher above is not.
    if (!me.permissions || !me.permissions.includes('users:manage')) return;
    const uRes = await fetch('/api/users');
    if (!uRes.ok) return;
    const data = await uRes.json();
    appUsers = data.users || [];
    appRoles = data.roles || appRoles;
    renderUsersCard();
  } catch (e) { /* settings page still works without this section */ }
}

/* ---- Message templates ----
 * Each template carries a hand-written English and Chinese version; the app
 * never translates one into the other, because a mistranslated quantity or
 * delivery date in a PO is a real commercial problem.
 */
let messageTemplates = [];
let templatePlaceholders = [];

function renderTemplatesCard() {
  const host = document.getElementById('tplCard');
  if (!host) return;
  host.innerHTML = `
    <div class="card">
      <div class="section-title">${escapeHtml(bi('secMessageTemplates', 'Message Templates').en)}</div>
      <div class="section-help" style="margin-bottom:14px;">${escapeHtml(bi('helpMessageTemplates', 'Templates used when sending a purchase order to a supplier.').en)}</div>
      <div class="section-help" style="margin-bottom:16px;">
        <strong>${escapeHtml(bi('tplPlaceholders', 'Available placeholders').en)}:</strong>
        ${templatePlaceholders.map((ph) => `<code>{{${escapeHtml(ph)}}}</code>`).join(' ')}
      </div>
      ${messageTemplates.map((t, i) => `
        <div class="card" style="background:#fff;margin-bottom:14px;" data-tpl="${escapeHtml(t.id)}">
          <div class="field">
            <label>${escapeHtml(bi('tplName', 'Template name').en)}</label>
            <input type="text" data-tpl-field="name" value="${escapeHtml(t.name)}" />
          </div>
          <div class="field">
            <label><strong>${escapeHtml(bi('tplEnglish', 'English version').en)}</strong></label>
            <input type="text" data-tpl-field="en.subject" placeholder="${escapeHtml(bi('tplSubject', 'Subject').en)}" value="${escapeHtml(t.en.subject)}" />
            <textarea rows="9" data-tpl-field="en.body" style="width:100%;margin-top:8px;font-family:inherit;font-size:13px;">${escapeHtml(t.en.body)}</textarea>
          </div>
          <div class="field">
            <label><strong>${escapeHtml(bi('tplChinese', 'Chinese version').en)}</strong></label>
            <input type="text" data-tpl-field="zh.subject" placeholder="${escapeHtml(bi('tplSubject', 'Subject').en)}" value="${escapeHtml(t.zh.subject)}" />
            <textarea rows="9" data-tpl-field="zh.body" style="width:100%;margin-top:8px;font-family:inherit;font-size:13px;">${escapeHtml(t.zh.body)}</textarea>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <button type="button" class="btn btn-primary" data-tpl-save="${escapeHtml(t.id)}" style="flex:none;width:auto;padding:9px 16px;">${escapeHtml(bi('saveChanges', 'Save changes').en)}</button>
            <button type="button" class="btn btn-secondary" data-tpl-delete="${escapeHtml(t.id)}" style="flex:none;width:auto;padding:9px 16px;color:var(--jc-fail);">${escapeHtml(bi('btnDelete', 'Delete').en)}</button>
          </div>
        </div>
      `).join('')}
      <button type="button" class="btn btn-secondary" id="tplAdd" style="flex:none;width:auto;padding:9px 16px;">${escapeHtml(bi('btnAddTemplate', '+ Add template').en)}</button>
    </div>
  `;
  wireTemplatesCard();
}

function wireTemplatesCard() {
  const readCard = (id) => {
    const card = document.querySelector(`[data-tpl="${id}"]`);
    const val = (f) => {
      const el = card.querySelector(`[data-tpl-field="${f}"]`);
      return el ? el.value : '';
    };
    return {
      name: val('name'),
      en: { subject: val('en.subject'), body: val('en.body') },
      zh: { subject: val('zh.subject'), body: val('zh.body') }
    };
  };
  document.querySelectorAll('[data-tpl-save]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.tplSave;
      try {
        const res = await fetch(`/api/message-templates/${encodeURIComponent(id)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(readCard(id))
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
        showToast(bi('tplSaved', 'Template saved').en);
        await loadTemplates();
      } catch (e) { showToast(e.message, true); }
    });
  });
  document.querySelectorAll('[data-tpl-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(bi('tplConfirmDelete', 'Delete this template?').en)) return;
      try {
        const res = await fetch(`/api/message-templates/${encodeURIComponent(btn.dataset.tplDelete)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).error || 'Delete failed');
        showToast(bi('tplDeleted', 'Template deleted').en);
        await loadTemplates();
      } catch (e) { showToast(e.message, true); }
    });
  });
  const addBtn = document.getElementById('tplAdd');
  if (addBtn) {
    addBtn.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/message-templates', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'New template', en: { subject: '', body: '' }, zh: { subject: '', body: '' } })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Create failed');
        await loadTemplates();
      } catch (e) { showToast(e.message, true); }
    });
  }
}

async function loadTemplates() {
  try {
    const res = await fetch('/api/message-templates');
    const data = await res.json();
    messageTemplates = data.templates || [];
    templatePlaceholders = data.placeholders || [];
    renderTemplatesCard();
  } catch (e) { /* settings page still works without templates */ }
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

    <div id="viewAsCard"></div>
    <div id="usersCard"></div>
    <div id="tplCard"></div>
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
  loadTemplates();
  loadUsers();
})();
