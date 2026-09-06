/**
 * Users page (admin only).
 *
 * Accounts, roles and what each role can actually do. Previously a card
 * buried in Settings; it earns its own page now that there are four roles,
 * supplier scoping, and several sign-in methods feeding the same records.
 *
 * The server enforces everything shown here - this page can only ask.
 */

const i18 = (k, f) => (window.JuniperI18n ? window.JuniperI18n.t(k, f) : escapeHtml(f || k));
const i18t = (k, f) => (window.JuniperI18n ? window.JuniperI18n.tText(k, f) : (f || k));

const ROLE_LABELS = {
  admin: 'Juniper Admin',
  internal: 'Juniper Team',
  qa: 'QA/QC',
  supplier: 'Supplier'
};

/** Plain-language summary of each role, so whoever assigns one can see the
 *  consequence without cross-referencing the code. */
const ROLE_SUMMARY = {
  admin: 'Everything, including this page and Settings.',
  internal: 'Orders, QA/QC, products and finances. No Settings, no user management.',
  qa: 'QA/QC reporting and approvals only.',
  supplier: 'Only the purchase orders they supply a part of, read-only.'
};

function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.style.background = isError ? 'var(--jc-fail)' : 'var(--jc-teal-dark)';
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add('hidden'), 3200);
}

async function api(path, opts) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

let users = [];
let roles = [];
let suppliers = [];
let permissionsByRole = {};
let googleDomains = [];

function render() {
  const root = document.getElementById('usersRoot');
  root.innerHTML = `
    <h2 class="om-view-title">${i18('navUsers', 'Users')}</h2>
    <div class="section-help" style="margin-bottom:10px;">
      ${i18('usersHelp', 'Accounts and what each one can do. The shared site password still works and grants full access, so accounts here are additive.')}
    </div>
    ${googleDomains.length ? `
      <div class="section-help" style="margin-bottom:18px;padding:10px 14px;background:#eef6f3;border-radius:8px;">
        ${i18('usersAutoProvision', 'Anyone signing in with an approved Google domain is added automatically as Juniper Team.')}
        <strong>${googleDomains.map((d) => escapeHtml(d)).join(', ')}</strong>
      </div>` : ''}

    <div class="om-category-tile" style="margin-bottom:20px;">
      <div class="om-category-tile-header"><span>${i18('usersAccounts', 'Accounts')}</span></div>
      <div id="usersTableHost" style="padding:0 4px 4px 4px;"></div>
    </div>

    <div class="om-panel-card" style="margin-bottom:20px;">
      <div class="om-section-title">${i18('usersAddNew', 'Add a user')}</div>
      <div class="om-field-grid">
        <div><label>${i18('fldNameReq', 'Name')}</label><input type="text" id="nuName" /></div>
        <div><label>${i18('usersEmail', 'Email')}</label><input type="email" id="nuEmail" /></div>
        <div><label>${i18('usersRole', 'Role')}</label>
          <select id="nuRole">${roles.map((r) => `<option value="${r}">${ROLE_LABELS[r] || r}</option>`).join('')}</select>
        </div>
        <div id="nuSupplierWrap" style="display:none;"><label>${i18('fldSupplierLc', 'Supplier')}</label>
          <select id="nuSupplier"><option value="">${i18t('btnSelect', '— Select —')}</option>
            ${suppliers.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}</select>
        </div>
        <div><label>${i18('usersPassword', 'Password')}</label><input type="text" id="nuPassword" placeholder="${i18t('usersPasswordHint', 'Optional if they sign in with Google')}" /></div>
      </div>
      <button type="button" class="btn btn-primary" id="nuAdd" style="flex:none;width:auto;margin-top:12px;">${i18('usersAddBtn', '+ Add user')}</button>
    </div>

    <div class="om-panel-card">
      <div class="om-section-title">${i18('usersWhatRolesDo', 'What each role can do')}</div>
      <div class="om-table-wrap">
        <table class="om-table" style="min-width:0;">
          <thead><tr><th>${i18('usersRole', 'Role')}</th><th>${i18('usersAccess', 'Access')}</th><th>${i18('usersPermissions', 'Permissions')}</th></tr></thead>
          <tbody>
            ${roles.map((r) => `
              <tr>
                <td><strong>${ROLE_LABELS[r] || r}</strong></td>
                <td>${escapeHtml(ROLE_SUMMARY[r] || '')}</td>
                <td style="font-size:11.5px;color:var(--jc-muted);">${(permissionsByRole[r] || []).join(', ') || '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
  renderTable();
  wireAddForm();
}

function renderTable() {
  const host = document.getElementById('usersTableHost');
  if (!host) return;
  if (!users.length) {
    host.innerHTML = `<div class="om-empty">${i18('usersNone', 'No accounts yet. The shared site password is still in use.')}</div>`;
    return;
  }
  host.innerHTML = `
    <div class="om-table-wrap">
      <table class="om-table">
        <thead><tr>
          <th>${i18('fldNameReq', 'Name')}</th>
          <th>${i18('usersEmail', 'Email')}</th>
          <th>${i18('usersRole', 'Role')}</th>
          <th>${i18('fldSupplierLc', 'Supplier')}</th>
          <th>${i18('usersSignIn', 'Sign-in')}</th>
          <th>${i18('usersActive', 'Active')}</th>
          <th>${i18('usersLastLogin', 'Last login')}</th>
          <th></th>
        </tr></thead>
        <tbody>
          ${users.map((u) => `
            <tr data-user="${escapeHtml(u.id)}">
              <td><input type="text" data-f="name" value="${escapeHtml(u.name)}" style="min-width:120px;" /></td>
              <td>${escapeHtml(u.email)}</td>
              <td>
                <select data-f="role">
                  ${roles.map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${ROLE_LABELS[r] || r}</option>`).join('')}
                </select>
              </td>
              <td>
                <select data-f="supplierName" ${u.role === 'supplier' ? '' : 'disabled title="Only used by supplier accounts"'}>
                  <option value="">—</option>
                  ${suppliers.map((s) => `<option value="${escapeHtml(s)}" ${s === u.supplierName ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
                </select>
              </td>
              <td style="font-size:11.5px;color:var(--jc-muted);white-space:nowrap;">
                ${[u.hasPassword ? i18t('usersPwLabel', 'Password') : null, u.googleSub ? 'Google' : null, u.wechatOpenId ? 'WeChat' : null]
                  .filter(Boolean).join(' · ') || i18t('usersNoMethod', 'None yet')}
              </td>
              <td><input type="checkbox" data-f="active" ${u.active ? 'checked' : ''} style="width:auto;" /></td>
              <td style="font-size:11.5px;color:var(--jc-muted);white-space:nowrap;">${u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : i18t('usersNever', 'never')}</td>
              <td style="white-space:nowrap;">
                <button type="button" class="om-table-upload-btn" data-save="${escapeHtml(u.id)}">${i18('btnSaveChanges', 'Save')}</button>
                <button type="button" class="om-table-upload-btn" data-pw="${escapeHtml(u.id)}">${i18('usersSetPassword', 'Password')}</button>
                <button type="button" class="om-table-upload-btn" data-del="${escapeHtml(u.id)}">${i18('btnDelete', 'Delete')}</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  wireTable();
}

function wireTable() {
  const readRow = (id) => {
    const row = document.querySelector(`[data-user="${id}"]`);
    const el = (f) => row.querySelector(`[data-f="${f}"]`);
    return {
      name: el('name').value,
      role: el('role').value,
      supplierName: el('supplierName').value,
      active: el('active').checked
    };
  };
  // Supplier picker only applies to supplier accounts - enable it live so
  // switching a role doesn't need a save-and-reload first.
  document.querySelectorAll('[data-f="role"]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const row = sel.closest('[data-user]');
      const sup = row.querySelector('[data-f="supplierName"]');
      sup.disabled = sel.value !== 'supplier';
      if (sel.value !== 'supplier') sup.value = '';
    });
  });
  document.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/api/users/${encodeURIComponent(b.dataset.save)}`, { method: 'PATCH', body: JSON.stringify(readRow(b.dataset.save)) });
      showToast(i18t('usersSaved', 'User saved'));
      await load();
    } catch (e) { showToast(e.message, true); }
  }));
  document.querySelectorAll('[data-pw]').forEach((b) => b.addEventListener('click', async () => {
    const pw = prompt(i18t('usersNewPasswordPrompt', 'New password for this user:'));
    if (!pw) return;
    try {
      await api(`/api/users/${encodeURIComponent(b.dataset.pw)}`, { method: 'PATCH', body: JSON.stringify({ password: pw }) });
      showToast(i18t('usersPasswordSet', 'Password set'));
      await load();
    } catch (e) { showToast(e.message, true); }
  }));
  document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const row = users.find((u) => u.id === b.dataset.del);
    if (!confirm(i18t('usersConfirmDelete', 'Delete this account?') + `\n\n${row ? row.email : ''}`)) return;
    try {
      await api(`/api/users/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
      showToast(i18t('usersDeleted', 'User deleted'));
      await load();
    } catch (e) { showToast(e.message, true); }
  }));
}

function wireAddForm() {
  const roleSel = document.getElementById('nuRole');
  const supWrap = document.getElementById('nuSupplierWrap');
  const sync = () => { supWrap.style.display = roleSel.value === 'supplier' ? '' : 'none'; };
  roleSel.addEventListener('change', sync);
  sync();
  document.getElementById('nuAdd').addEventListener('click', async () => {
    const payload = {
      name: document.getElementById('nuName').value,
      email: document.getElementById('nuEmail').value,
      role: roleSel.value,
      supplierName: roleSel.value === 'supplier' ? document.getElementById('nuSupplier').value : '',
      password: document.getElementById('nuPassword').value
    };
    if (!payload.email) return showToast(i18t('usersEmailRequired', 'Email is required'), true);
    if (payload.role === 'supplier' && !payload.supplierName) {
      // Without a supplier the account would scope to nothing and look broken.
      return showToast(i18t('usersSupplierRequired', 'Pick which supplier this account belongs to'), true);
    }
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify(payload) });
      showToast(i18t('usersCreated', 'User created'));
      await load();
    } catch (e) { showToast(e.message, true); }
  });
}

async function load() {
  try {
    const [uData, sData, meData] = await Promise.all([
      api('/api/users'),
      api('/api/suppliers'),
      api('/api/me')
    ]);
    users = uData.users || [];
    roles = uData.roles || [];
    suppliers = (sData.suppliers || []).map((s) => s.name).filter(Boolean).sort();
    permissionsByRole = meData.rolePermissions || {};
    googleDomains = meData.googleDomains || [];
    render();
  } catch (e) {
    document.getElementById('usersRoot').innerHTML =
      `<div class="om-empty">${escapeHtml(e.message)}</div>`;
  }
}

(async function init() {
  if (window.JuniperI18n) await window.JuniperI18n.loadI18n();
  load();
}());
