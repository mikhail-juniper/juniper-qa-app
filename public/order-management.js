/* Order Management Hub - list + detail view for Purchase Orders, rebuilding
 * the QingFlow "Order Management" workspace as a section of this app.
 * See /order-management-workflow-spec.md for the logic this is based on.
 */

let STATUSES = [];
let ACCESSORY_STATUSES = [];
let FILE_CATEGORIES = [];
let currentView = 'home'; // 'home' | 'category' | 'suppliers' | 'settlement'
let currentTab = 'toys'; // 'clothing' | 'toys' | 'other' (only relevant when currentView === 'category')
let currentStatusFilter = '';
let currentSearch = '';
let currentOrders = [];

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

function statusSlug(status) {
  return String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '—';
  const num = Number(n);
  return isNaN(num) ? '—' : `¥${num.toLocaleString()}`;
}

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString(); } catch (e) { return d; }
}

let currentCategorySubTab = 'orders'; // 'orders' | 'components' | 'accessories', only used when currentView === 'category'

const CATEGORY_META = {
  clothing: { label: 'Apparel', color: '#B9540E' },
  toys: { label: 'Toys', color: 'var(--jc-teal)' },
  other: { label: 'Other', color: '#1F6FA5' }
};

function refreshCurrentView() {
  if (currentView === 'category') return loadOrders();
  if (currentView === 'suppliers') return renderSuppliersShell(document.getElementById('omRoot'));
  if (currentView === 'settlement') return renderSettlementShell(document.getElementById('omRoot'));
  return render();
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

async function loadStatuses() {
  const data = await api('/api/order-management/statuses');
  STATUSES = data.statuses || [];
}

async function loadAccessoryStatuses() {
  const data = await api('/api/order-management/accessory-statuses');
  ACCESSORY_STATUSES = data.statuses || [];
}

async function loadFileCategories() {
  const data = await api('/api/order-management/file-categories');
  FILE_CATEGORIES = data.categories || [];
}

async function loadOrders() {
  const params = new URLSearchParams({ productLine: currentTab });
  if (currentView === 'category' && currentCategorySubTab !== 'accessories' && currentStatusFilter) {
    params.set('status', currentStatusFilter);
  }
  if (currentSearch) params.set('search', currentSearch);
  const data = await api(`/api/order-management/orders?${params.toString()}`);
  currentOrders = data.orders || [];
  renderTable();
}

function render() {
  const root = document.getElementById('omRoot');
  if (currentView === 'home') return renderHome(root);
  if (currentView === 'suppliers') return renderSuppliersShell(root);
  if (currentView === 'products') return renderProductsShell(root);
  if (currentView === 'components') return renderComponentsShell(root);
  if (currentView === 'fabric-library') return renderFabricLibraryShell(root);
  if (currentView === 'settlement') return renderSettlementShell(root);
  return renderCategoryShell(root);
}

// The sidebar now covers all navigation, so the in-page "back to hub" link
// is redundant - kept as no-ops rather than touching every call site.
function backToHubHtml() {
  return '';
}

function bindBackToHub() {
  // no-op
}

// ---- Home / tile dashboard ----

const homeTileState = {
  clothing: { subTab: 'orders', search: '' },
  toys: { subTab: 'orders', search: '' },
  other: { subTab: 'orders', search: '' }
};

async function renderHome(root) {
  root.innerHTML = `<div class="om-empty">Loading...</div>`;
  let counts = { toys: 0, clothing: 0, other: 0, suppliers: 0, settlementPending: 0, newRequests: 0 };
  let newRequests = [];
  try {
    counts = await api('/api/order-management/counts');
    const req = await api('/api/order-management/orders?status=' + encodeURIComponent('New Request'));
    newRequests = req.orders || [];
  } catch (e) { showToast(e.message, true); }

  const categoryTile = (productLine) => {
    const meta = CATEGORY_META[productLine];
    const st = homeTileState[productLine];
    return `
      <div class="om-category-tile" data-tab="${productLine}">
        <div class="om-category-tile-header" style="border-color:${meta.color};">
          <span>${meta.label}</span>
          <button class="btn btn-secondary om-view-all-btn" data-viewall="${productLine}">View all</button>
        </div>
        <div class="om-category-tile-subtabs">
          <div class="om-subtab-btn ${st.subTab === 'orders' ? 'active' : ''}" data-subtab="orders">All Orders <span class="om-subtab-count">${counts[productLine] || 0}</span></div>
          <div class="om-subtab-btn ${st.subTab === 'components' ? 'active' : ''}" data-subtab="components">Main Components <span class="om-subtab-count">${counts[productLine] || 0}</span></div>
          <div class="om-subtab-btn ${st.subTab === 'accessories' ? 'active' : ''}" data-subtab="accessories">Accessories <span class="om-subtab-count">${counts[productLine + 'Accessories'] || 0}</span></div>
        </div>
        <div class="om-tile-toolbar">
          <input type="text" class="om-tile-search" data-search-for="${productLine}" placeholder="Search PO number, supplier, SKU..." value="${escapeHtml(st.search)}" />
        </div>
        <div class="om-tile-table-scroll" id="omTilePreview-${productLine}"><div class="om-empty">Loading...</div></div>
      </div>
    `;
  };

  root.innerHTML = `
    <div class="om-category-tile" style="margin-bottom:24px;">
      <div class="om-category-tile-header" style="border-color:var(--jc-teal);">
        <span>PO Requests</span>
        <span class="om-subtab-count" style="font-size:15px;">${counts.newRequests || 0}</span>
      </div>
      <div style="padding:14px 18px 20px 18px;" id="omPoRequestsHost">
        ${newRequests.length ? `
          <table class="om-table" style="min-width:0;">
            <thead><tr><th>PO Number</th><th>Product line</th><th>Buyer</th><th>Supplier</th><th>Desired entry</th></tr></thead>
            <tbody>
              ${newRequests.slice(0, 10).map((o) => `
                <tr data-id="${escapeHtml(o.id)}">
                  <td><strong>${escapeHtml(o.poNumber)}</strong></td>
                  <td>${escapeHtml(CATEGORY_META[o.productLine] ? CATEGORY_META[o.productLine].label : o.productLine)}</td>
                  <td>${escapeHtml(o.buyer || '—')}</td>
                  <td>${escapeHtml(o.supplier && o.supplier.name || '—')}</td>
                  <td>${fmtDate(o.desiredEntryDate)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          ${newRequests.length > 10 ? `<div class="section-help" style="margin-top:10px;">Showing 10 of ${newRequests.length} - the rest are in the category tiles below, filtered to New Request.</div>` : ''}
        ` : '<div class="om-empty">No new PO requests right now.</div>'}
      </div>
    </div>

    ${categoryTile('clothing')}
    ${categoryTile('toys')}
    ${categoryTile('other')}
  `;

  root.querySelectorAll('.om-category-tile[data-tab]').forEach((tile) => {
    const productLine = tile.dataset.tab;
    tile.querySelectorAll('.om-subtab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        homeTileState[productLine].subTab = btn.dataset.subtab;
        tile.querySelectorAll('.om-subtab-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        loadTilePreview(productLine);
      });
    });
    tile.querySelector('.om-tile-search').addEventListener('input', debounce((e) => {
      homeTileState[productLine].search = e.target.value;
      loadTilePreview(productLine);
    }, 300));
  });
  root.querySelectorAll('.om-view-all-btn').forEach((btn) => {
    btn.addEventListener('click', () => openCategoryFullScreen(btn.dataset.viewall));
  });
  root.querySelectorAll('#omPoRequestsHost tbody tr').forEach((tr) => {
    tr.addEventListener('click', () => openDetailPanel(tr.dataset.id));
  });

  ['clothing', 'toys', 'other'].forEach(loadTilePreview);
}

async function loadTilePreview(productLine) {
  const host = document.getElementById(`omTilePreview-${productLine}`);
  if (!host) return;
  const st = homeTileState[productLine];
  try {
    const params = new URLSearchParams({ productLine });
    if (st.search) params.set('search', st.search);
    const data = await api(`/api/order-management/orders?${params.toString()}`);
    const orders = (data.orders || []).slice(0, 10); // preview only - "View all" shows everything
    if (st.subTab === 'components') renderComponentsTable(host, orders);
    else if (st.subTab === 'accessories') renderAccessoriesTable(host, flattenAccessories(orders));
    else renderOrdersTableFull(host, orders, productLine);
  } catch (e) { showToast(e.message, true); }
}

// "View all" on a home tile: opens the same category + sub-tab as a
// full-screen modal (reusing the panel infrastructure from the PO detail
// view) rather than navigating to a separate page.
function openCategoryFullScreen(productLine) {
  const meta = CATEGORY_META[productLine];
  const st = homeTileState[productLine];
  const panel = document.createElement('div');
  panel.className = 'om-panel';
  panel.innerHTML = `
   <div class="om-panel-inner">
    <div class="om-panel-header">
      <div style="font-size:19px;font-weight:700;">${meta.label}</div>
      <button class="om-panel-close" id="omClosePanel">&times;</button>
    </div>
    <div class="om-subtabs-bar">
      <button class="om-subtab ${st.subTab === 'orders' ? 'active' : ''}" data-subtab="orders">All Orders</button>
      <button class="om-subtab ${st.subTab === 'components' ? 'active' : ''}" data-subtab="components">Main Components</button>
      <button class="om-subtab ${st.subTab === 'accessories' ? 'active' : ''}" data-subtab="accessories">Accessories</button>
    </div>
    <div class="om-toolbar">
      <input class="om-search" id="omFullSearch" type="text" placeholder="Search PO number, supplier, SKU..." value="${escapeHtml(st.search)}" />
    </div>
    <div class="om-table-wrap"><div id="omFullTableHost"><div class="om-empty">Loading...</div></div></div>
   </div>
  `;
  mountPanel(panel);
  bindPanelEscape();
  document.getElementById('omClosePanel').addEventListener('click', closePanel);

  async function loadFull() {
    const host = document.getElementById('omFullTableHost');
    const params = new URLSearchParams({ productLine });
    if (st.search) params.set('search', st.search);
    const data = await api(`/api/order-management/orders?${params.toString()}`);
    const orders = data.orders || [];
    if (st.subTab === 'components') renderComponentsTable(host, orders);
    else if (st.subTab === 'accessories') renderAccessoriesTable(host, flattenAccessories(orders));
    else renderOrdersTableFull(host, orders, productLine);
  }
  panel.querySelectorAll('.om-subtab').forEach((btn) => {
    btn.addEventListener('click', () => {
      st.subTab = btn.dataset.subtab;
      panel.querySelectorAll('.om-subtab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      loadFull().catch((e) => showToast(e.message, true));
    });
  });
  document.getElementById('omFullSearch').addEventListener('input', debounce((e) => {
    st.search = e.target.value;
    loadFull().catch((err) => showToast(err.message, true));
  }, 300));
  loadFull().catch((e) => showToast(e.message, true));
}

// ---- Suppliers view ----

async function renderSuppliersShell(root) {
  root.innerHTML = `
    ${backToHubHtml()}
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <h2 class="om-view-title" style="margin:0;">Suppliers</h2>
      <button class="btn btn-primary" id="omNewSupplierBtn" style="flex:none;width:auto;padding:10px 18px;">+ New supplier</button>
    </div>
    <div id="omSuppliersHost" class="om-table-wrap"><div class="om-empty">Loading...</div></div>

    <div style="display:flex;justify-content:space-between;align-items:center;margin:32px 0 14px 0;">
      <h2 class="om-view-title" style="margin:0;">Warehouses</h2>
      <button class="btn btn-primary" id="omNewWarehouseBtn" style="flex:none;width:auto;padding:10px 18px;">+ New warehouse</button>
    </div>
    <div id="omWarehousesHost" class="om-table-wrap"><div class="om-empty">Loading...</div></div>
  `;
  bindBackToHub();
  document.getElementById('omNewSupplierBtn').addEventListener('click', () => openSupplierForm(null));
  document.getElementById('omNewWarehouseBtn').addEventListener('click', () => openWarehouseForm(null));
  try {
    const data = await api('/api/suppliers');
    renderSuppliersTable(data.suppliers || []);
  } catch (e) { showToast(e.message, true); }
  try {
    const data = await api('/api/warehouses');
    renderWarehousesTable(data.warehouses || []);
  } catch (e) { showToast(e.message, true); }
}

function renderWarehousesTable(warehouses) {
  const host = document.getElementById('omWarehousesHost');
  if (!host) return;
  if (!warehouses.length) {
    host.innerHTML = `<div class="om-empty">No warehouses recorded yet. Click "New warehouse" to add your first one.</div>`;
    return;
  }
  host.innerHTML = `
    <table class="om-table">
      <thead><tr><th>Warehouse name</th><th>Address</th><th>Contact name</th><th>Phone number</th></tr></thead>
      <tbody>
        ${warehouses.map((w) => `
          <tr data-id="${escapeHtml(w.id)}">
            <td><strong>${escapeHtml(w.name)}</strong></td>
            <td>${escapeHtml(w.address || '—')}</td>
            <td>${escapeHtml(w.contactName || '—')}</td>
            <td>${escapeHtml(w.phoneNumber || '—')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  host.querySelectorAll('tbody tr').forEach((tr) => {
    tr.addEventListener('click', async () => {
      try {
        const data = await api(`/api/warehouses/${encodeURIComponent(tr.dataset.id)}`);
        openWarehouseForm(data.warehouse);
      } catch (e) { showToast(e.message, true); }
    });
  });
}

function openWarehouseForm(warehouse) {
  const panel = document.createElement('div');
  panel.className = 'om-panel';
  panel.innerHTML = `
   <div class="om-panel-inner">
    <div class="om-panel-header">
      <div style="font-size:19px;font-weight:700;">${warehouse ? 'Edit warehouse' : 'New warehouse'}</div>
      <button class="om-panel-close" id="whClose">&times;</button>
    </div>
    <div class="om-field-grid">
      <div><label>Warehouse name *</label><input id="whName" type="text" value="${val(warehouse && warehouse.name)}" /></div>
      <div><label>Contact name</label><input id="whContactName" type="text" value="${val(warehouse && warehouse.contactName)}" /></div>
      <div><label>Phone number</label><input id="whPhoneNumber" type="text" value="${val(warehouse && warehouse.phoneNumber)}" /></div>
    </div>
    <div class="om-field-grid" style="margin-top:10px;">
      <div style="grid-column:1/-1;"><label>Address</label><input id="whAddress" type="text" value="${val(warehouse && warehouse.address)}" /></div>
      <div style="grid-column:1/-1;"><label>Notes</label><input id="whNotes" type="text" value="${val(warehouse && warehouse.notes)}" /></div>
    </div>
    <div style="margin-top:22px;display:flex;gap:10px;flex-wrap:wrap;">
      <button class="btn btn-secondary" id="whCancel" style="flex:none;width:auto;padding:10px 18px;">Cancel</button>
      ${warehouse ? `<button class="btn btn-secondary" id="whDelete" style="flex:none;width:auto;padding:10px 18px;color:var(--jc-fail);">Delete</button>` : ''}
      <button class="btn btn-primary" id="whSave" style="flex:none;width:auto;padding:10px 18px;">${warehouse ? 'Save changes' : 'Create warehouse'}</button>
    </div>
   </div>
  `;
  mountPanel(panel);
  bindPanelEscape();
  document.getElementById('whClose').addEventListener('click', closePanel);
  document.getElementById('whCancel').addEventListener('click', closePanel);

  if (warehouse) {
    document.getElementById('whDelete').addEventListener('click', async () => {
      if (!confirm(`Delete "${warehouse.name}"? This can't be undone.`)) return;
      try {
        await api(`/api/warehouses/${encodeURIComponent(warehouse.id)}`, { method: 'DELETE' });
        showToast('Warehouse deleted');
        closePanel();
        refreshCurrentView();
      } catch (e) { showToast(e.message, true); }
    });
  }

  document.getElementById('whSave').addEventListener('click', async () => {
    const name = document.getElementById('whName').value.trim();
    if (!name) return showToast('Warehouse name is required', true);
    const payload = {
      name,
      contactName: document.getElementById('whContactName').value,
      phoneNumber: document.getElementById('whPhoneNumber').value,
      address: document.getElementById('whAddress').value,
      notes: document.getElementById('whNotes').value
    };
    try {
      if (warehouse) {
        await api(`/api/warehouses/${encodeURIComponent(warehouse.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
        showToast('Warehouse updated');
      } else {
        await api('/api/warehouses', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Warehouse created');
      }
      closePanel();
      refreshCurrentView();
    } catch (e) { showToast(e.message, true); }
  });
}

function renderSuppliersTable(suppliers) {
  const host = document.getElementById('omSuppliersHost');
  if (!host) return;
  if (!suppliers.length) {
    host.innerHTML = `<div class="om-empty">No suppliers recorded yet. Click "New supplier" to add your first one.</div>`;
    return;
  }
  host.innerHTML = `
    <table class="om-table">
      <thead>
        <tr>
          <th>Supplier name</th><th>Shipping address</th><th>Additional address</th><th>Vendor code</th><th>Product type</th>
          <th>Company name</th><th>Contact name</th><th>Phone number</th><th>Additional phone</th><th>Business license</th>
        </tr>
      </thead>
      <tbody>
        ${suppliers.map((s) => `
          <tr data-id="${escapeHtml(s.id)}">
            <td><strong>${escapeHtml(s.name)}</strong></td>
            <td>${escapeHtml(s.shippingAddress || '—')}</td>
            <td>${escapeHtml(s.additionalAddress || '—')}</td>
            <td>${escapeHtml(s.vendorCode || '—')}</td>
            <td>${escapeHtml(s.productType || '—')}</td>
            <td>${escapeHtml(s.companyName || '—')}</td>
            <td>${escapeHtml(s.contactName || '—')}</td>
            <td>${escapeHtml(s.phoneNumber || '—')}</td>
            <td>${escapeHtml(s.additionalPhoneNumber || '—')}</td>
            <td>${escapeHtml(s.businessLicense || '—')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  host.querySelectorAll('tbody tr').forEach((tr) => {
    tr.addEventListener('click', async () => {
      try {
        const data = await api(`/api/suppliers/${encodeURIComponent(tr.dataset.id)}`);
        openSupplierForm(data.supplier);
      } catch (e) { showToast(e.message, true); }
    });
  });
}

function openSupplierForm(supplier) {
  const panel = document.createElement('div');
  panel.className = 'om-panel';
  panel.innerHTML = `
   <div class="om-panel-inner">
    <div class="om-panel-header">
      <div style="font-size:19px;font-weight:700;">${supplier ? 'Edit supplier' : 'New supplier'}</div>
      <button class="om-panel-close" id="omSupplierClose">&times;</button>
    </div>
    <div class="om-field-grid">
      <div><label>Supplier name *</label><input id="spName" type="text" value="${val(supplier && supplier.name)}" /></div>
      <div><label>Company name</label><input id="spCompanyName" type="text" value="${val(supplier && supplier.companyName)}" /></div>
      <div><label>Vendor code</label><input id="spVendorCode" type="text" value="${val(supplier && supplier.vendorCode)}" /></div>
      <div><label>Product type</label><input id="spProductType" type="text" placeholder="e.g. Apparel, Bag, Carabiner" value="${val(supplier && supplier.productType)}" /></div>
      <div><label>Contact name</label><input id="spContactName" type="text" value="${val(supplier && supplier.contactName)}" /></div>
      <div><label>Phone number</label><input id="spPhoneNumber" type="text" value="${val(supplier && supplier.phoneNumber)}" /></div>
      <div><label>Additional phone number</label><input id="spAdditionalPhoneNumber" type="text" value="${val(supplier && supplier.additionalPhoneNumber)}" /></div>
      <div><label>WeChat</label><input id="spWechat" type="text" value="${val(supplier && supplier.wechat)}" /></div>
      <div><label>Currency</label>
        <select id="spCurrency">
          <option value="RMB" ${!supplier || supplier.currency === 'RMB' ? 'selected' : ''}>RMB</option>
          <option value="USD" ${supplier && supplier.currency === 'USD' ? 'selected' : ''}>Dollar (USD)</option>
        </select>
      </div>
    </div>
    <div class="om-field-grid" style="margin-top:10px;">
      <div style="grid-column:1/-1;"><label>Mailing address</label><input id="spMailingAddress" type="text" value="${val(supplier && supplier.mailingAddress)}" /></div>
      <div style="grid-column:1/-1;"><label>Shipping address</label><input id="spShippingAddress" type="text" value="${val(supplier && supplier.shippingAddress)}" /></div>
      <div style="grid-column:1/-1;"><label>Additional address</label><input id="spAdditionalAddress" type="text" value="${val(supplier && supplier.additionalAddress)}" /></div>
      <div style="grid-column:1/-1;"><label>Business license</label><input id="spBusinessLicense" type="text" value="${val(supplier && supplier.businessLicense)}" /></div>
      <div style="grid-column:1/-1;"><label>Notes</label><input id="spNotes" type="text" value="${val(supplier && supplier.notes)}" /></div>
    </div>
    <div style="margin-top:22px;display:flex;gap:10px;flex-wrap:wrap;">
      <button class="btn btn-secondary" id="spCancel" style="flex:none;width:auto;padding:10px 18px;">Cancel</button>
      ${supplier ? `<button class="btn btn-secondary" id="spDelete" style="flex:none;width:auto;padding:10px 18px;color:var(--jc-fail);">Delete</button>` : ''}
      <button class="btn btn-primary" id="spSave" style="flex:none;width:auto;padding:10px 18px;">${supplier ? 'Save changes' : 'Create supplier'}</button>
    </div>
   </div>
  `;
  mountPanel(panel);
  bindPanelEscape();
  document.getElementById('omSupplierClose').addEventListener('click', closePanel);
  document.getElementById('spCancel').addEventListener('click', closePanel);

  if (supplier) {
    document.getElementById('spDelete').addEventListener('click', async () => {
      if (!confirm(`Delete "${supplier.name}"? This can't be undone.`)) return;
      try {
        await api(`/api/suppliers/${encodeURIComponent(supplier.id)}`, { method: 'DELETE' });
        showToast('Supplier deleted');
        closePanel();
        refreshCurrentView();
      } catch (e) { showToast(e.message, true); }
    });
  }

  document.getElementById('spSave').addEventListener('click', async () => {
    const name = document.getElementById('spName').value.trim();
    if (!name) return showToast('Supplier name is required', true);
    const payload = {
      name,
      companyName: document.getElementById('spCompanyName').value,
      vendorCode: document.getElementById('spVendorCode').value,
      productType: document.getElementById('spProductType').value,
      contactName: document.getElementById('spContactName').value,
      phoneNumber: document.getElementById('spPhoneNumber').value,
      additionalPhoneNumber: document.getElementById('spAdditionalPhoneNumber').value,
      wechat: document.getElementById('spWechat').value,
      currency: document.getElementById('spCurrency').value,
      mailingAddress: document.getElementById('spMailingAddress').value,
      shippingAddress: document.getElementById('spShippingAddress').value,
      additionalAddress: document.getElementById('spAdditionalAddress').value,
      businessLicense: document.getElementById('spBusinessLicense').value,
      notes: document.getElementById('spNotes').value
    };
    try {
      if (supplier) {
        await api(`/api/suppliers/${encodeURIComponent(supplier.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
        showToast('Supplier updated');
      } else {
        await api('/api/suppliers', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Supplier created');
      }
      closePanel();
      refreshCurrentView();
    } catch (e) { showToast(e.message, true); }
  });
}

// ---- Products / Components catalog views ("Product Information") ----
// Both are derived live from existing order data (like Suppliers already
// is), so anything entered on a new PO shows up here automatically -
// there's nothing separate to keep in sync.

async function renderProductsShell(root) {
  root.innerHTML = `
    ${backToHubHtml()}
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <h2 class="om-view-title" style="margin:0;">Products</h2>
      <button class="btn btn-primary" id="omNewProductBtn" style="flex:none;width:auto;padding:10px 18px;">+ Add product</button>
    </div>
    <div id="omProductsHost"></div>
  `;
  bindBackToHub();
  document.getElementById('omNewProductBtn').addEventListener('click', () => openProductForm(null));
  const host = document.getElementById('omProductsHost');
  host.innerHTML = `<div class="om-empty">Loading...</div>`;
  try {
    // A real directory now (like Suppliers) - every product that's ever
    // been on a PO already has a record here (auto-synced server-side),
    // so this is just one list, not a manual-entries table plus a
    // separate PO-derived table.
    const data = await api('/api/catalog/products');
    const products = data.products || [];
    host.innerHTML = ['clothing', 'toys', 'other']
      .map((line) => productsCategoryBlock(line, products.filter((p) => p.productLine === line)))
      .join('');
    host.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => openProductProfile(tr.dataset.id));
    });
  } catch (e) { showToast(e.message, true); }
}

function productsCategoryBlock(productLine, products) {
  const meta = CATEGORY_META[productLine];
  return `
    <div class="om-category-tile" style="margin-bottom:20px;">
      <div class="om-category-tile-header" style="border-color:${meta.color};"><span>${meta.label} Products (${products.length})</span></div>
      ${products.length ? `
        <div class="om-table-wrap">
          <table class="om-table">
            <thead><tr><th>Name</th><th>SKU</th><th>Unit price</th><th>Supplier</th><th># POs</th></tr></thead>
            <tbody>
              ${products.map((p) => `
                <tr data-id="${escapeHtml(p.id)}">
                  <td><strong>${escapeHtml(p.name)}</strong></td>
                  <td>${escapeHtml(p.sku || '—')}</td>
                  <td>${fmtMoney(p.factoryPrice)}</td>
                  <td>${escapeHtml(p.supplierName || '—')}</td>
                  <td>${p.poCount || 0}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : `<div class="om-empty">No ${meta.label.toLowerCase()} products recorded yet.</div>`}
    </div>
  `;
}

/** Read-first profile for one directory product: its own details plus a
 *  live list of every PO that's used it. Editing happens via the "Edit"
 *  button, which reuses the same create/edit form as "+ Add product". */
async function openProductProfile(id) {
  let product, history;
  try {
    const [productData, historyData] = await Promise.all([
      api(`/api/catalog/products/${encodeURIComponent(id)}`),
      api(`/api/catalog/products/${encodeURIComponent(id)}/history`)
    ]);
    product = productData.product;
    history = historyData.orders || [];
  } catch (e) { return showToast(e.message, true); }

  const isApparel = product.productLine === 'clothing';
  const meta = CATEGORY_META[product.productLine] || {};

  const panel = document.createElement('div');
  panel.className = 'om-panel';
  panel.innerHTML = `
   <div class="om-panel-inner">
    <div class="om-panel-header">
      <div>
        <div style="font-size:19px;font-weight:700;">${escapeHtml(product.name || 'Unnamed product')}</div>
        <div style="color:var(--jc-muted);font-size:13px;">SKU: ${escapeHtml(product.sku || '—')}</div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;">
        <button class="btn btn-secondary" id="omEditProductBtn" style="flex:none;width:auto;padding:7px 14px;font-size:13px;">Edit</button>
        <button class="om-panel-close" id="omClosePanel">&times;</button>
      </div>
    </div>

    <div class="om-panel-card">
    <div class="om-section-title">Product details</div>
    <div class="om-detail-grid">
      <div class="om-detail-row"><span class="om-label">Name</span><span class="om-value">${escapeHtml(product.name || '—')}</span></div>
      <div class="om-detail-row"><span class="om-label">SKU</span><span class="om-value">${escapeHtml(product.sku || '—')}</span></div>
      <div class="om-detail-row"><span class="om-label">Unit Price</span><span class="om-value">${fmtMoney(product.factoryPrice)}</span></div>
      <div class="om-detail-row"><span class="om-label">Product Category</span><span class="om-value">${escapeHtml(meta.label || product.productLine || '—')}</span></div>
      <div class="om-detail-row"><span class="om-label">Dimensions</span><span class="om-value">${escapeHtml(product.dimensions || '—')}</span></div>
      <div class="om-detail-row"><span class="om-label">Weight</span><span class="om-value">${product.weight ? escapeHtml(String(product.weight)) : '—'}</span></div>
      ${isApparel ? `
        <div class="om-detail-row"><span class="om-label">Sizing chart</span><span class="om-value"><a href="sizing-charts.html" target="_blank" rel="noopener">View Sizing Charts →</a></span></div>
        <div class="om-detail-row"><span class="om-label">Fabric Code</span><span class="om-value">${escapeHtml(product.fabricCode || '—')}</span></div>
        <div class="om-detail-row"><span class="om-label">Fabric Type</span><span class="om-value">${escapeHtml(product.fabricType || '—')}</span></div>
        <div class="om-detail-row"><span class="om-label">Washing Tag</span><span class="om-value">${escapeHtml(product.washingTag || '—')}</span></div>
      ` : ''}
    </div>
    </div>

    <div class="om-panel-card">
    <div class="om-section-title">Supplier</div>
    <div class="om-detail-grid">
      <div class="om-detail-row"><span class="om-label">Name</span><span class="om-value">${escapeHtml(product.supplierName || '—')}</span></div>
      <div class="om-detail-row"><span class="om-label">Code</span><span class="om-value">${escapeHtml(product.supplierCode || '—')}</span></div>
      <div class="om-detail-row"><span class="om-label">Contact</span><span class="om-value">${escapeHtml(product.supplierContact || '—')}</span></div>
    </div>
    </div>

    <div class="om-panel-card">
    <div class="om-section-title">Historical POs</div>
    ${history.length ? `
      <div class="om-table-wrap">
        <table class="om-table" style="min-width:0;">
          <thead><tr><th>PO Number</th><th>Order date</th><th>Quantity</th></tr></thead>
          <tbody>
            ${history.map((o) => `
              <tr data-order-id="${escapeHtml(o.id)}">
                <td><strong>${escapeHtml(o.poNumber || '—')}</strong></td>
                <td>${fmtDate(o.orderDate || o.createdAt)}</td>
                <td>${o.orderQuantity != null ? o.orderQuantity : '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : `<div class="om-empty">No POs recorded yet for this product.</div>`}
    </div>
   </div>
  `;

  mountPanel(panel);
  bindPanelEscape();
  document.getElementById('omClosePanel').addEventListener('click', closePanel);
  document.getElementById('omEditProductBtn').addEventListener('click', () => {
    closePanel();
    openProductForm(product);
  });
  panel.querySelectorAll('tbody tr[data-order-id]').forEach((tr) => {
    tr.addEventListener('click', () => {
      closePanel();
      openDetailPanel(tr.dataset.orderId, 'full');
    });
  });
}

function openProductForm(product) {
  const panel = document.createElement('div');
  panel.className = 'om-panel';
  const isApparel = !product || product.productLine === 'clothing';
  panel.innerHTML = `
   <div class="om-panel-inner">
    <div class="om-panel-header">
      <div style="font-size:19px;font-weight:700;">${product ? 'Edit product' : 'New product'}</div>
      <button class="om-panel-close" id="prodClose">&times;</button>
    </div>
    <div class="om-field-grid">
      <div><label>Name *</label><input id="prodName" type="text" value="${val(product && product.name)}" /></div>
      <div><label>SKU</label><input id="prodSku" type="text" value="${val(product && product.sku)}" /></div>
      <div><label>Model number</label><input id="prodModelNumber" type="text" value="${val(product && product.modelNumber)}" /></div>
      <div><label>Product Category</label>
        <select id="prodProductLine">
          <option value="clothing" ${!product || product.productLine === 'clothing' ? 'selected' : ''}>Apparel</option>
          <option value="toys" ${product && product.productLine === 'toys' ? 'selected' : ''}>Toys</option>
          <option value="other" ${product && product.productLine === 'other' ? 'selected' : ''}>Other</option>
        </select>
      </div>
      <div><label>Unit Price (¥)</label><div class="om-money-wrap"><input id="prodFactoryPrice" type="number" step="0.01" value="${val(product && product.factoryPrice)}" /></div></div>
      <div><label>Sales unit price (¥)</label><div class="om-money-wrap"><input id="prodSalesUnitPrice" type="number" step="0.01" value="${val(product && product.salesUnitPrice)}" /></div></div>
      <div><label>Dimensions</label><input id="prodDimensions" type="text" placeholder="e.g. 30 x 20 x 5 cm" value="${val(product && product.dimensions)}" /></div>
      <div><label>Weight</label><input id="prodWeight" type="text" placeholder="e.g. 450g" value="${val(product && product.weight)}" /></div>
    </div>
    <div id="prodApparelFields" class="om-field-grid" style="margin-top:10px;${isApparel ? '' : 'display:none;'}">
      <div><label>Fabric code</label><input id="prodFabricCode" type="text" value="${val(product && product.fabricCode)}" /></div>
      <div><label>Fabric type</label><input id="prodFabricType" type="text" value="${val(product && product.fabricType)}" /></div>
      <div style="grid-column:1/-1;"><label>Washing tag</label><input id="prodWashingTag" type="text" value="${val(product && product.washingTag)}" /></div>
    </div>
    <div class="om-section-title" style="margin-top:20px;">Supplier</div>
    <div class="om-field-grid">
      <div><label>Supplier name</label><input id="prodSupplierName" type="text" list="dlProdSupplierNames" value="${val(product && product.supplierName)}" /></div>
      <div><label>Supplier code</label><input id="prodSupplierCode" type="text" value="${val(product && product.supplierCode)}" /></div>
      <div><label>Supplier contact</label><input id="prodSupplierContact" type="text" value="${val(product && product.supplierContact)}" /></div>
    </div>
    <datalist id="dlProdSupplierNames"></datalist>
    <div class="om-field-grid" style="margin-top:10px;">
      <div style="grid-column:1/-1;"><label>Notes</label><input id="prodNotes" type="text" value="${val(product && product.notes)}" /></div>
    </div>
    <div style="margin-top:22px;display:flex;gap:10px;flex-wrap:wrap;">
      <button class="btn btn-secondary" id="prodCancel" style="flex:none;width:auto;padding:10px 18px;">Cancel</button>
      ${product ? `<button class="btn btn-secondary" id="prodDelete" style="flex:none;width:auto;padding:10px 18px;color:var(--jc-fail);">Delete</button>` : ''}
      <button class="btn btn-primary" id="prodSave" style="flex:none;width:auto;padding:10px 18px;">${product ? 'Save changes' : 'Create product'}</button>
    </div>
   </div>
  `;
  mountPanel(panel);
  bindPanelEscape();
  document.getElementById('prodClose').addEventListener('click', closePanel);
  document.getElementById('prodCancel').addEventListener('click', closePanel);

  api('/api/suppliers').then((data) => {
    const dl = document.getElementById('dlProdSupplierNames');
    if (dl) dl.innerHTML = (data.suppliers || []).map((s) => `<option value="${escapeHtml(s.name)}"></option>`).join('');
  }).catch(() => { /* datalist is a convenience - fine to skip if this fails */ });

  document.getElementById('prodProductLine').addEventListener('change', (e) => {
    document.getElementById('prodApparelFields').style.display = e.target.value === 'clothing' ? '' : 'none';
  });

  if (product) {
    document.getElementById('prodDelete').addEventListener('click', async () => {
      if (!confirm(`Delete "${product.name}"? This can't be undone.`)) return;
      try {
        await api(`/api/catalog/products/${encodeURIComponent(product.id)}`, { method: 'DELETE' });
        showToast('Product deleted');
        closePanel();
        refreshCurrentView();
      } catch (e) { showToast(e.message, true); }
    });
  }

  document.getElementById('prodSave').addEventListener('click', async () => {
    const name = document.getElementById('prodName').value.trim();
    if (!name) return showToast('Product name is required', true);
    const payload = {
      name,
      sku: document.getElementById('prodSku').value,
      modelNumber: document.getElementById('prodModelNumber').value,
      productLine: document.getElementById('prodProductLine').value,
      factoryPrice: document.getElementById('prodFactoryPrice').value || null,
      salesUnitPrice: document.getElementById('prodSalesUnitPrice').value || null,
      dimensions: document.getElementById('prodDimensions').value,
      weight: document.getElementById('prodWeight').value,
      fabricCode: document.getElementById('prodFabricCode').value,
      fabricType: document.getElementById('prodFabricType').value,
      washingTag: document.getElementById('prodWashingTag').value,
      supplierName: document.getElementById('prodSupplierName').value,
      supplierCode: document.getElementById('prodSupplierCode').value,
      supplierContact: document.getElementById('prodSupplierContact').value,
      notes: document.getElementById('prodNotes').value
    };
    try {
      if (product) {
        await api(`/api/catalog/products/${encodeURIComponent(product.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
        showToast('Product updated');
      } else {
        await api('/api/catalog/products', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Product created');
      }
      closePanel();
      refreshCurrentView();
    } catch (e) { showToast(e.message, true); }
  });
}

async function renderComponentsShell(root) {
  root.innerHTML = `
    ${backToHubHtml()}
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <h2 class="om-view-title" style="margin:0;">Components</h2>
      <button class="btn btn-primary" id="omNewComponentBtn" style="flex:none;width:auto;padding:10px 18px;">+ Add component</button>
    </div>
    <div id="omComponentsHost"></div>
  `;
  bindBackToHub();
  document.getElementById('omNewComponentBtn').addEventListener('click', () => openComponentForm(null));
  const host = document.getElementById('omComponentsHost');
  host.innerHTML = `<div class="om-empty">Loading...</div>`;
  try {
    const data = await api('/api/catalog/components');
    const components = data.components || [];
    host.innerHTML = ['clothing', 'toys', 'other']
      .map((line) => componentsCategoryBlock(line, components.filter((c) => c.productLine === line)))
      .join('');
    host.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => openComponentProfile(tr.dataset.id));
    });
  } catch (e) { showToast(e.message, true); }
}

function componentsCategoryBlock(productLine, components) {
  const meta = CATEGORY_META[productLine];
  return `
    <div class="om-category-tile" style="margin-bottom:20px;">
      <div class="om-category-tile-header" style="border-color:${meta.color};"><span>${meta.label} Components (${components.length})</span></div>
      ${components.length ? `
        <div class="om-table-wrap">
          <table class="om-table">
            <thead><tr><th>Part name</th><th>Material</th><th>Supplier</th><th>Unit price</th><th># uses</th></tr></thead>
            <tbody>
              ${components.map((c) => `
                <tr data-id="${escapeHtml(c.id)}">
                  <td><strong>${escapeHtml(c.partName)}</strong></td>
                  <td>${escapeHtml(c.material || '—')}</td>
                  <td>${escapeHtml(c.supplierName || '—')}</td>
                  <td>${fmtMoney(c.unitPrice)}</td>
                  <td>${c.useCount || 0}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : `<div class="om-empty">No ${meta.label.toLowerCase()} components recorded yet.</div>`}
    </div>
  `;
}

/** Read-first profile for one directory component, mirroring
 *  openProductProfile. */
async function openComponentProfile(id) {
  let component, history;
  try {
    const [componentData, historyData] = await Promise.all([
      api(`/api/catalog/components/${encodeURIComponent(id)}`),
      api(`/api/catalog/components/${encodeURIComponent(id)}/history`)
    ]);
    component = componentData.component;
    history = historyData.orders || [];
  } catch (e) { return showToast(e.message, true); }

  const meta = CATEGORY_META[component.productLine] || {};

  const panel = document.createElement('div');
  panel.className = 'om-panel';
  panel.innerHTML = `
   <div class="om-panel-inner">
    <div class="om-panel-header">
      <div>
        <div style="font-size:19px;font-weight:700;">${escapeHtml(component.partName || 'Unnamed component')}</div>
        <div style="color:var(--jc-muted);font-size:13px;">${escapeHtml(meta.label || component.productLine || '')}</div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;">
        <button class="btn btn-secondary" id="omEditComponentBtn" style="flex:none;width:auto;padding:7px 14px;font-size:13px;">Edit</button>
        <button class="om-panel-close" id="omClosePanel">&times;</button>
      </div>
    </div>

    <div class="om-panel-card">
    <div class="om-section-title">Component details</div>
    <div class="om-detail-grid">
      <div class="om-detail-row"><span class="om-label">Part name</span><span class="om-value">${escapeHtml(component.partName || '—')}</span></div>
      <div class="om-detail-row"><span class="om-label">Material</span><span class="om-value">${escapeHtml(component.material || '—')}</span></div>
      <div class="om-detail-row"><span class="om-label">Unit Price</span><span class="om-value">${fmtMoney(component.unitPrice)}</span></div>
      <div class="om-detail-row"><span class="om-label">Product Category</span><span class="om-value">${escapeHtml(meta.label || component.productLine || '—')}</span></div>
    </div>
    </div>

    <div class="om-panel-card">
    <div class="om-section-title">Supplier</div>
    <div class="om-detail-grid">
      <div class="om-detail-row"><span class="om-label">Name</span><span class="om-value">${escapeHtml(component.supplierName || '—')}</span></div>
    </div>
    </div>

    <div class="om-panel-card">
    <div class="om-section-title">Historical POs</div>
    ${history.length ? `
      <div class="om-table-wrap">
        <table class="om-table" style="min-width:0;">
          <thead><tr><th>PO Number</th><th>Order date</th></tr></thead>
          <tbody>
            ${history.map((o) => `
              <tr data-order-id="${escapeHtml(o.id)}">
                <td><strong>${escapeHtml(o.poNumber || '—')}</strong></td>
                <td>${fmtDate(o.orderDate || o.createdAt)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : `<div class="om-empty">No POs recorded yet for this component.</div>`}
    </div>
   </div>
  `;

  mountPanel(panel);
  bindPanelEscape();
  document.getElementById('omClosePanel').addEventListener('click', closePanel);
  document.getElementById('omEditComponentBtn').addEventListener('click', () => {
    closePanel();
    openComponentForm(component);
  });
  panel.querySelectorAll('tbody tr[data-order-id]').forEach((tr) => {
    tr.addEventListener('click', () => {
      closePanel();
      openDetailPanel(tr.dataset.orderId, 'full');
    });
  });
}

function openComponentForm(component) {
  const panel = document.createElement('div');
  panel.className = 'om-panel';
  panel.innerHTML = `
   <div class="om-panel-inner">
    <div class="om-panel-header">
      <div style="font-size:19px;font-weight:700;">${component ? 'Edit component' : 'New component'}</div>
      <button class="om-panel-close" id="compClose">&times;</button>
    </div>
    <div class="om-field-grid">
      <div><label>Part name *</label><input id="compPartName" type="text" value="${val(component && component.partName)}" /></div>
      <div><label>Material</label><input id="compMaterial" type="text" value="${val(component && component.material)}" /></div>
      <div><label>Supplier</label><input id="compSupplierName" type="text" list="dlSupplierNames" value="${val(component && component.supplierName)}" /></div>
      <div><label>Unit price (¥)</label><div class="om-money-wrap"><input id="compUnitPrice" type="number" step="0.01" value="${val(component && component.unitPrice)}" /></div></div>
      <div><label>Product line</label>
        <select id="compProductLine">
          <option value="clothing" ${!component || component.productLine === 'clothing' ? 'selected' : ''}>Apparel</option>
          <option value="toys" ${component && component.productLine === 'toys' ? 'selected' : ''}>Toys</option>
          <option value="other" ${component && component.productLine === 'other' ? 'selected' : ''}>Other</option>
        </select>
      </div>
    </div>
    <div class="om-field-grid" style="margin-top:10px;">
      <div style="grid-column:1/-1;"><label>Notes</label><input id="compNotes" type="text" value="${val(component && component.notes)}" /></div>
    </div>
    <datalist id="dlSupplierNames"></datalist>
    <div style="margin-top:22px;display:flex;gap:10px;flex-wrap:wrap;">
      <button class="btn btn-secondary" id="compCancel" style="flex:none;width:auto;padding:10px 18px;">Cancel</button>
      ${component ? `<button class="btn btn-secondary" id="compDelete" style="flex:none;width:auto;padding:10px 18px;color:var(--jc-fail);">Delete</button>` : ''}
      <button class="btn btn-primary" id="compSave" style="flex:none;width:auto;padding:10px 18px;">${component ? 'Save changes' : 'Create component'}</button>
    </div>
   </div>
  `;
  mountPanel(panel);
  bindPanelEscape();
  document.getElementById('compClose').addEventListener('click', closePanel);
  document.getElementById('compCancel').addEventListener('click', closePanel);

  api('/api/suppliers').then((data) => {
    const dl = document.getElementById('dlSupplierNames');
    if (dl) dl.innerHTML = (data.suppliers || []).map((s) => `<option value="${escapeHtml(s.name)}"></option>`).join('');
  }).catch(() => { /* datalist is a convenience - fine to skip if this fails */ });

  if (component) {
    document.getElementById('compDelete').addEventListener('click', async () => {
      if (!confirm(`Delete "${component.partName}"? This can't be undone.`)) return;
      try {
        await api(`/api/catalog/components/${encodeURIComponent(component.id)}`, { method: 'DELETE' });
        showToast('Component deleted');
        closePanel();
        refreshCurrentView();
      } catch (e) { showToast(e.message, true); }
    });
  }

  document.getElementById('compSave').addEventListener('click', async () => {
    const partName = document.getElementById('compPartName').value.trim();
    if (!partName) return showToast('Part name is required', true);
    const payload = {
      partName,
      material: document.getElementById('compMaterial').value,
      supplierName: document.getElementById('compSupplierName').value,
      unitPrice: document.getElementById('compUnitPrice').value || null,
      productLine: document.getElementById('compProductLine').value,
      notes: document.getElementById('compNotes').value
    };
    try {
      if (component) {
        await api(`/api/catalog/components/${encodeURIComponent(component.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
        showToast('Component updated');
      } else {
        await api('/api/catalog/components', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Component created');
      }
      closePanel();
      refreshCurrentView();
    } catch (e) { showToast(e.message, true); }
  });
}

// ---- Fabric Library: Fabric Codes + Fabric Types, each a simple full
// table (no productLine grouping - fabric isn't specific to one category
// the way Products/Components are). Same auto-sync idea: anything entered
// as a Fabric Code/Type on a PO or a catalog Product shows up here too. ----
async function renderFabricLibraryShell(root) {
  root.innerHTML = `
    ${backToHubHtml()}
    <h2 class="om-view-title">Fabric Library</h2>
    <div class="om-category-tile" style="margin-bottom:20px;">
      <div class="om-category-tile-header" style="border-color:var(--jc-teal);">
        <span>Fabric Codes</span>
        <button class="btn btn-primary om-view-all-btn" id="omNewFabricCodeBtn">+ Add fabric code</button>
      </div>
      <div id="omFabricCodesHost"><div class="om-empty">Loading...</div></div>
    </div>
    <div class="om-category-tile" style="margin-bottom:20px;">
      <div class="om-category-tile-header" style="border-color:var(--jc-teal);">
        <span>Fabric Types</span>
        <button class="btn btn-primary om-view-all-btn" id="omNewFabricTypeBtn">+ Add fabric type</button>
      </div>
      <div id="omFabricTypesHost"><div class="om-empty">Loading...</div></div>
    </div>
  `;
  bindBackToHub();
  document.getElementById('omNewFabricCodeBtn').addEventListener('click', () => openFabricEntryForm('code', null));
  document.getElementById('omNewFabricTypeBtn').addEventListener('click', () => openFabricEntryForm('type', null));

  try {
    const [codesData, typesData] = await Promise.all([
      api('/api/fabric-library/codes'),
      api('/api/fabric-library/types')
    ]);
    renderFabricTable('omFabricCodesHost', 'code', codesData.codes || [], true);
    renderFabricTable('omFabricTypesHost', 'type', typesData.types || [], false);
  } catch (e) { showToast(e.message, true); }
}

function renderFabricTable(hostId, kind, entries, withSwatch) {
  const host = document.getElementById(hostId);
  if (!host) return;
  if (!entries.length) {
    host.innerHTML = `<div class="om-empty">No fabric ${kind === 'code' ? 'codes' : 'types'} recorded yet.</div>`;
    return;
  }
  const hexChip = (hex) => {
    const clean = (hex || '').trim().replace('#', '');
    if (!clean) return '—';
    return `<span style="display:inline-flex;align-items:center;gap:7px;"><span style="width:18px;height:18px;border-radius:4px;border:1px solid var(--jc-border);background:#${escapeHtml(clean)};flex:none;"></span>#${escapeHtml(clean)}</span>`;
  };
  const imgCell = (url) => url ? `<img class="om-table-thumb om-fabric-zoom" style="cursor:zoom-in;" src="${escapeHtml(url)}" alt="" title="Click to view larger" />` : '—';
  host.innerHTML = kind === 'code' ? `
    <div class="om-table-wrap">
      <table class="om-table">
        <thead><tr>
          <th>Fabric Code</th><th>Material Blend</th><th>Type</th><th>Fabric Swatch</th><th>Digital Color Reference</th>
          <th>Pantone Color</th><th>Hex Color</th><th>CMYK Color</th><th>Book Code</th><th>Fabric Weight</th><th>Notes</th>
        </tr></thead>
        <tbody>
          ${entries.map((e) => `
            <tr data-id="${escapeHtml(e.id)}">
              <td><strong>${escapeHtml(e.value)}</strong></td>
              <td>${escapeHtml(e.materialBlend || '—')}</td>
              <td>${escapeHtml(e.garmentType || '—')}</td>
              <td>${imgCell(e.swatchUrl)}</td>
              <td>${e.digitalColorUrl ? imgCell(e.digitalColorUrl) : hexChip(e.hex)}</td>
              <td>${escapeHtml(e.pantone || '—')}</td>
              <td>${hexChip(e.hex)}</td>
              <td style="font-size:12px;white-space:nowrap;">${escapeHtml(e.cmyk || '—')}</td>
              <td>${escapeHtml(e.bookCode || '—')}</td>
              <td>${escapeHtml(e.fabricWeight || '—')}</td>
              <td>${escapeHtml(e.notes || '—')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  ` : `
    <div class="om-table-wrap">
      <table class="om-table">
        <thead><tr><th>Fabric Type</th><th>Notes</th></tr></thead>
        <tbody>
          ${entries.map((e) => `
            <tr data-id="${escapeHtml(e.id)}">
              <td><strong>${escapeHtml(e.value)}</strong></td>
              <td>${escapeHtml(e.notes || '—')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  host.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', () => {
      const entry = entries.find((e) => e.id === tr.dataset.id);
      openFabricEntryForm(kind, entry);
    });
  });
  // Clicking a swatch/color image zooms it in a lightbox instead of
  // opening the row's edit form - stopPropagation keeps the row click
  // from firing too, same pattern as photo thumbnails elsewhere.
  host.querySelectorAll('.om-fabric-zoom').forEach((img) => {
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      openImageLightbox(img.src);
    });
  });
}

function openFabricEntryForm(kind, entry) {
  const isCode = kind === 'code';
  const panel = document.createElement('div');
  panel.className = 'om-panel';
  panel.innerHTML = `
   <div class="om-panel-inner">
    <div class="om-panel-header">
      <div style="font-size:19px;font-weight:700;">${entry ? 'Edit' : 'New'} fabric ${isCode ? 'code' : 'type'}</div>
      <button class="om-panel-close" id="fabClose">&times;</button>
    </div>
    <div class="om-field-grid">
      <div><label>${isCode ? 'Fabric Code' : 'Fabric Type'} *</label><input id="fabValue" type="text" value="${val(entry && entry.value)}" /></div>
      ${isCode ? `
        <div><label>Material Blend</label><input id="fabMaterialBlend" type="text" placeholder="e.g. 65% Polyester, 35% Cotton" value="${val(entry && entry.materialBlend)}" /></div>
        <div><label>Company Name</label><input id="fabCompanyName" type="text" placeholder="e.g. Haishuang" value="${val(entry && entry.companyName)}" /></div>
        <div><label>Color</label><input id="fabColorName" type="text" placeholder="e.g. orange" value="${val(entry && entry.colorName)}" /></div>
        <div><label>Type</label>
          <input id="fabGarmentType" type="text" list="fabGarmentTypeOptions" placeholder="e.g. Hoodie / Sweatshirt" value="${val(entry && entry.garmentType)}" />
          <datalist id="fabGarmentTypeOptions">
            <option value="Hoodie / Sweatshirt"></option>
            <option value="T-Shirt"></option>
          </datalist>
        </div>
        <div>
          <label>Fabric Swatch</label>
          <div style="display:flex;align-items:center;gap:10px;">
            ${entry && entry.swatchUrl
              ? `<img id="fabSwatchPreview" class="om-upload-preview" style="cursor:zoom-in;" src="${escapeHtml(entry.swatchUrl)}" alt="" title="Click to view larger" />`
              : `<div id="fabSwatchPreview" class="om-upload-preview-empty"></div>`}
            <input type="hidden" id="fabSwatchUrl" value="${val(entry && entry.swatchUrl)}" />
            <input type="file" id="fabSwatchFile" accept="image/*" style="display:none;" />
            <button type="button" class="om-table-upload-btn" id="fabSwatchUploadBtn">Upload</button>
          </div>
        </div>
        <div>
          <label>Digital Color Reference</label>
          <div style="display:flex;align-items:center;gap:10px;">
            ${entry && entry.digitalColorUrl
              ? `<img id="fabDigitalPreview" class="om-upload-preview" style="cursor:zoom-in;" src="${escapeHtml(entry.digitalColorUrl)}" alt="" title="Click to view larger" />`
              : `<div id="fabDigitalPreview" class="om-upload-preview-empty"></div>`}
            <input type="hidden" id="fabDigitalUrl" value="${val(entry && entry.digitalColorUrl)}" />
            <input type="file" id="fabDigitalFile" accept="image/*" style="display:none;" />
            <button type="button" class="om-table-upload-btn" id="fabDigitalUploadBtn">Upload</button>
          </div>
        </div>
        <div><label>Pantone Color</label><input id="fabPantone" type="text" placeholder="e.g. 206C" value="${val(entry && entry.pantone)}" /></div>
        <div><label>Hex Color</label><input id="fabHex" type="text" placeholder="e.g. ce0037" value="${val(entry && entry.hex)}" /></div>
        <div><label>CMYK Color</label><input id="fabCmyk" type="text" placeholder="e.g. C: 11% M: 100% Y: 81% K: 3%" value="${val(entry && entry.cmyk)}" /></div>
        <div><label>Book Code</label><input id="fabBookCode" type="text" value="${val(entry && entry.bookCode)}" /></div>
        <div><label>Fabric Weight</label><input id="fabFabricWeight" type="text" placeholder="e.g. 340gsm" value="${val(entry && entry.fabricWeight)}" /></div>
      ` : ''}
      <div style="grid-column:1/-1;"><label>Notes</label><input id="fabNotes" type="text" value="${val(entry && entry.notes)}" /></div>
    </div>
    ${entry ? `
    <div class="om-panel-card" style="margin-top:18px;">
      <div class="om-section-title">Historical POs</div>
      <div id="fabHistoryHost"><div class="om-empty">Loading...</div></div>
    </div>
    ` : ''}
    <div style="margin-top:22px;display:flex;gap:10px;flex-wrap:wrap;">
      <button class="btn btn-secondary" id="fabCancel" style="flex:none;width:auto;padding:10px 18px;">Cancel</button>
      ${entry ? `<button class="btn btn-secondary" id="fabDelete" style="flex:none;width:auto;padding:10px 18px;color:var(--jc-fail);">Delete</button>` : ''}
      <button class="btn btn-primary" id="fabSave" style="flex:none;width:auto;padding:10px 18px;">${entry ? 'Save changes' : 'Create'}</button>
    </div>
   </div>
  `;
  mountPanel(panel);
  bindPanelEscape();
  document.getElementById('fabClose').addEventListener('click', closePanel);
  document.getElementById('fabCancel').addEventListener('click', closePanel);

  // Historical POs that used this material - every PO whose main
  // component's Fabric Code/Type matches this entry, newest first.
  if (entry) {
    (async () => {
      try {
        const data = await api(`/api/fabric-library/${isCode ? 'codes' : 'types'}/${encodeURIComponent(entry.id)}/history`);
        const host = document.getElementById('fabHistoryHost');
        if (!host) return;
        const orders = data.orders || [];
        if (!orders.length) {
          host.innerHTML = `<div class="om-empty">No POs have used this ${isCode ? 'fabric' : 'fabric type'} yet.</div>`;
          return;
        }
        host.innerHTML = `
          <div class="om-table-wrap">
            <table class="om-table" style="min-width:0;">
              <thead><tr><th>PO Number</th><th>Product</th><th>Order date</th><th>Quantity</th></tr></thead>
              <tbody>
                ${orders.map((o) => `
                  <tr data-order-id="${escapeHtml(o.id)}" style="cursor:pointer;">
                    <td><strong>${escapeHtml(o.poNumber || '—')}</strong></td>
                    <td>${escapeHtml(o.productTitle || '—')}</td>
                    <td>${fmtDate(o.orderDate || o.createdAt)}</td>
                    <td>${o.orderQuantity != null ? o.orderQuantity : '—'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `;
        host.querySelectorAll('tr[data-order-id]').forEach((tr) => {
          tr.addEventListener('click', () => {
            closePanel();
            openDetailPanel(tr.dataset.orderId, 'full');
          });
        });
      } catch (e) { /* history is a convenience - the form still works without it */ }
    })();
  }

  if (isCode) {
    const wireSwatchUpload = (btnId, fileId, urlId, previewId) => {
      const uploadBtn = document.getElementById(btnId);
      const fileInput = document.getElementById(fileId);
      uploadBtn.addEventListener('click', () => fileInput.click());
      // Existing preview image zooms in a lightbox, same as photo
      // thumbnails elsewhere on the site.
      const existingPreview = document.getElementById(previewId);
      if (existingPreview && existingPreview.tagName === 'IMG') {
        existingPreview.addEventListener('click', () => openImageLightbox(existingPreview.src));
      }
      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const formData = new FormData();
        formData.append('file', file);
        try {
          const res = await fetch('/api/fabric-library/upload', { method: 'POST', body: formData });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || 'Upload failed');
          document.getElementById(urlId).value = body.file.url;
          const old = document.getElementById(previewId);
          const fresh = document.createElement('img');
          fresh.id = previewId;
          fresh.className = 'om-upload-preview';
          fresh.style.cursor = 'zoom-in';
          fresh.title = 'Click to view larger';
          fresh.src = body.file.url;
          fresh.addEventListener('click', () => openImageLightbox(body.file.url));
          old.parentNode.replaceChild(fresh, old);
          showToast('Image uploaded');
        } catch (err) { showToast(err.message, true); }
      });
    };
    wireSwatchUpload('fabSwatchUploadBtn', 'fabSwatchFile', 'fabSwatchUrl', 'fabSwatchPreview');
    wireSwatchUpload('fabDigitalUploadBtn', 'fabDigitalFile', 'fabDigitalUrl', 'fabDigitalPreview');
  }

  if (entry) {
    document.getElementById('fabDelete').addEventListener('click', async () => {
      if (!confirm(`Delete "${entry.value}"? This can't be undone.`)) return;
      try {
        await api(`/api/fabric-library/${isCode ? 'codes' : 'types'}/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
        showToast('Deleted');
        closePanel();
        refreshCurrentView();
      } catch (e) { showToast(e.message, true); }
    });
  }

  document.getElementById('fabSave').addEventListener('click', async () => {
    const value = document.getElementById('fabValue').value.trim();
    if (!value) return showToast(`${isCode ? 'Fabric code' : 'Fabric type'} is required`, true);
    const payload = { value, notes: document.getElementById('fabNotes').value };
    if (isCode) {
      payload.swatchUrl = document.getElementById('fabSwatchUrl').value;
      payload.digitalColorUrl = document.getElementById('fabDigitalUrl').value;
      payload.materialBlend = document.getElementById('fabMaterialBlend').value;
      payload.companyName = document.getElementById('fabCompanyName').value;
      payload.colorName = document.getElementById('fabColorName').value;
      payload.pantone = document.getElementById('fabPantone').value;
      payload.hex = document.getElementById('fabHex').value.trim().replace('#', '');
      payload.cmyk = document.getElementById('fabCmyk').value;
      payload.bookCode = document.getElementById('fabBookCode').value;
      payload.fabricWeight = document.getElementById('fabFabricWeight').value;
      payload.garmentType = document.getElementById('fabGarmentType').value;
    }
    try {
      const path = `/api/fabric-library/${isCode ? 'codes' : 'types'}${entry ? '/' + encodeURIComponent(entry.id) : ''}`;
      await api(path, { method: entry ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      showToast(entry ? 'Updated' : 'Created');
      closePanel();
      refreshCurrentView();
    } catch (e) { showToast(e.message, true); }
  });
}

// "Accessories" sub-tab: flattened parts/accessories across every order in
// this category, with richer columns matching QingFlow's Accessory
// Confirmation Form.
function renderAccessoriesTable(host, rows) {
  if (!rows.length) {
    host.innerHTML = `<div class="om-empty">No accessories/parts recorded yet.</div>`;
    return;
  }
  host.innerHTML = `
    <table class="om-table">
      <thead>
        <tr>
          <th>Part name</th><th>PO Number</th><th>Specifications</th><th>Material</th><th>Dimensions</th>
          <th>Qty</th><th>Unit price</th><th>Total</th><th>Expected delivery</th>
          <th>Supplier</th><th>Supplier contact</th><th>Waybill #</th><th>Shipment qty</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(({ order, accessory: a }) => `
          <tr data-id="${escapeHtml(order.id)}" data-accessory-id="${escapeHtml(a.id)}">
            <td><strong>${escapeHtml(a.partName || 'Unnamed part')}</strong></td>
            <td>${escapeHtml(order.poNumber)}</td>
            <td>${escapeHtml(a.specifications || '—')}</td>
            <td>${escapeHtml(a.material || '—')}</td>
            <td>${escapeHtml(a.dimensions || '—')}</td>
            <td>${escapeHtml(a.quantity ?? '—')}</td>
            <td>${fmtMoney(a.unitPrice)}</td>
            <td>${fmtMoney(a.totalPrice)}</td>
            <td>${fmtDate(a.expectedDeliveryDate)}</td>
            <td>${escapeHtml(a.supplierName || '—')}</td>
            <td>${escapeHtml(a.supplierContact || '—')}</td>
            <td>${escapeHtml(a.waybillNumber || '—')}</td>
            <td>${escapeHtml(a.shipmentQuantity ?? '—')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  host.querySelectorAll('tbody tr').forEach((tr) => {
    tr.addEventListener('click', () => openAccessoryDetailPanel(tr.dataset.id, tr.dataset.accessoryId));
  });
}

// ---- Settlement view ----

// Manufacturing Cost is a PER-UNIT figure: mirrors
// lib/orderManagementStore.js's computeManufacturingCostPerUnit exactly -
// keep both in sync if this formula ever changes.
function computeManufacturingCostPerUnit(order) {
  const mc = order.mainComponent || {};
  const mainUnitCost = Number(mc.factoryPrice) || 0;
  const subComponentUnitCosts = (order.accessories || []).reduce((sum, a) => sum + (Number(a.unitPrice) || 0), 0);
  return Math.round((mainUnitCost + subComponentUnitCosts) * 10000) / 10000;
}

function computeOrderTotal(order) {
  const mc = order.mainComponent || {};
  const orderQuantity = Number(mc.purchaseQuantity) || 0;
  const manufacturingCostPerUnit = computeManufacturingCostPerUnit(order);
  const subComponentShippingTotal = (order.accessories || []).reduce((sum, a) => sum + (Number(a.shippingCost) || 0), 0);
  const costs = order.costs || {};
  const flatFeesTotal = (Number(costs.assemblyFee) || 0) + (Number(costs.laborCosts) || 0) +
    (Number(costs.transportationFees) || 0) + (Number(costs.otherExpenses) || 0) + subComponentShippingTotal;
  return Math.round((manufacturingCostPerUnit * orderQuantity + flatFeesTotal) * 100) / 100;
}

async function renderSettlementShell(root) {
  root.innerHTML = `${backToHubHtml()}<h2 class="om-view-title">Settlement Statement</h2><div id="omMonthlyHost"></div><div id="omSettlementHost" class="om-table-wrap"><div class="om-empty">Loading...</div></div>`;
  bindBackToHub();
  try {
    const [monthly, toys, clothing, other] = await Promise.all([
      api('/api/order-management/financials/monthly'),
      api('/api/order-management/orders?productLine=toys'),
      api('/api/order-management/orders?productLine=clothing'),
      api('/api/order-management/orders?productLine=other')
    ]);
    renderMonthlyFinancials(monthly.months || []);
    renderSettlementTable([...(toys.orders || []), ...(clothing.orders || []), ...(other.orders || [])]);
  } catch (e) { showToast(e.message, true); }
}

function renderMonthlyFinancials(months) {
  const host = document.getElementById('omMonthlyHost');
  if (!host) return;
  if (!months.length) { host.innerHTML = ''; return; }
  host.innerHTML = `
    <div class="om-monthly-grid">
      ${months.map((m) => `
        <div class="om-month-card">
          <div class="om-month-label">${escapeHtml(m.month)}</div>
          <div class="om-month-total">${fmtMoney(m.total)}</div>
          <div class="om-month-split">
            <span class="om-month-paid">Paid ${fmtMoney(m.paid)}</span>
            <span class="om-month-pending">Pending ${fmtMoney(m.pending)}</span>
          </div>
          <div class="om-month-count">${m.orderCount} order${m.orderCount === 1 ? '' : 's'}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderSettlementTable(orders) {
  const host = document.getElementById('omSettlementHost');
  if (!host) return;
  if (!orders.length) {
    host.innerHTML = `<div class="om-empty">No orders yet.</div>`;
    return;
  }
  host.innerHTML = `
    <table class="om-table">
      <thead><tr><th>PO Number</th><th>Product line</th><th>Supplier</th><th>Total owed</th><th>Settlement</th><th>Paid on</th><th>Action</th></tr></thead>
      <tbody>
        ${orders.map((o) => `
          <tr data-id="${escapeHtml(o.id)}">
            <td><strong>${escapeHtml(o.poNumber)}</strong></td>
            <td>${escapeHtml(CATEGORY_META[o.productLine] ? CATEGORY_META[o.productLine].label : o.productLine)}</td>
            <td>${escapeHtml(o.supplier && o.supplier.name || '—')}</td>
            <td>${fmtMoney(computeOrderTotal(o))}</td>
            <td>${escapeHtml(o.settlement.status)}</td>
            <td>${o.settlement.paidDate ? fmtDate(o.settlement.paidDate) : '—'}</td>
            <td>
              ${o.settlement.status === 'Paid'
                ? `<button class="btn btn-secondary om-settle-btn" data-id="${escapeHtml(o.id)}" data-status="Pending" style="flex:none;width:auto;padding:5px 10px;font-size:12px;">Mark Pending</button>`
                : `<button class="btn btn-primary om-settle-btn" data-id="${escapeHtml(o.id)}" data-status="Paid" style="flex:none;width:auto;padding:5px 10px;font-size:12px;">Mark Paid</button>`}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  host.querySelectorAll('.om-settle-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await api(`/api/order-management/orders/${encodeURIComponent(btn.dataset.id)}/settlement`, {
          method: 'POST',
          body: JSON.stringify({ status: btn.dataset.status })
        });
        showToast('Settlement updated');
        renderSettlementShell(document.getElementById('omRoot'));
      } catch (err) { showToast(err.message, true); }
    });
  });
  host.querySelectorAll('tbody tr').forEach((tr) => {
    tr.addEventListener('click', () => openDetailPanel(tr.dataset.id));
  });
}

// ---- Orders (table + tabs) view, formerly the whole page ----

function renderCategoryShell(root) {
  const meta = CATEGORY_META[currentTab];
  root.innerHTML = `
    ${backToHubHtml()}
    <h2 class="om-view-title">${meta.label}</h2>
    <div class="om-subtabs-bar">
      <button class="om-subtab ${currentCategorySubTab === 'orders' ? 'active' : ''}" data-subtab="orders">All Orders</button>
      <button class="om-subtab ${currentCategorySubTab === 'components' ? 'active' : ''}" data-subtab="components">Main Components</button>
      <button class="om-subtab ${currentCategorySubTab === 'accessories' ? 'active' : ''}" data-subtab="accessories">Accessories</button>
    </div>
    <div class="om-toolbar">
      <input class="om-search" id="omSearch" type="text" placeholder="Search PO number, supplier, SKU..." value="${escapeHtml(currentSearch)}" />
      ${currentCategorySubTab !== 'accessories' ? `
        <select class="om-status-filter" id="omStatusFilter">
          <option value="">All statuses</option>
          ${STATUSES.map((s) => `<option value="${escapeHtml(s)}" ${s === currentStatusFilter ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
        </select>
      ` : ''}
    </div>
    <div class="om-table-wrap"><div id="omTableHost"></div></div>
  `;
  bindBackToHub();

  root.querySelectorAll('.om-subtab').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentCategorySubTab = btn.dataset.subtab;
      render();
      loadOrders();
    });
  });
  document.getElementById('omSearch').addEventListener('input', debounce((e) => {
    currentSearch = e.target.value;
    loadOrders().catch((err) => showToast(err.message, true));
  }, 300));
  const statusFilterEl = document.getElementById('omStatusFilter');
  if (statusFilterEl) {
    statusFilterEl.addEventListener('change', (e) => {
      currentStatusFilter = e.target.value;
      loadOrders().catch((err) => showToast(err.message, true));
    });
  }

  renderTable();
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function renderTable() {
  const host = document.getElementById('omTableHost');
  if (!host) return;
  if (currentView !== 'category') return renderOrdersTableFull(host, currentOrders);
  if (currentCategorySubTab === 'components') return renderComponentsTable(host, currentOrders);
  if (currentCategorySubTab === 'accessories') return renderAccessoriesTable(host, flattenAccessories(currentOrders));
  return renderOrdersTableFull(host, currentOrders);
}

function flattenAccessories(orders) {
  const rows = [];
  orders.forEach((o) => (o.accessories || []).forEach((a) => rows.push({ order: o, accessory: a })));
  return rows;
}

// "All Orders" sub-tab: the full wide table, matching QingFlow's actual
// column breadth (Images 2-3) rather than a trimmed-down summary.
function renderOrdersTableFull(host, orders, productLine) {
  productLine = productLine || currentTab;
  if (!orders.length) {
    host.innerHTML = `<div class="om-empty">No orders yet for ${CATEGORY_META[productLine] ? CATEGORY_META[productLine].label : productLine}.</div>`;
    return;
  }
  const isClothing = productLine === 'clothing';
  host.innerHTML = `
    <table class="om-table">
      <thead>
        <tr>
          <th>PO Number</th><th>Status</th><th>Buyer</th><th>Order date</th><th>Desired entry</th>
          <th>Manufacturer delivery</th><th>Supplier</th><th>Supplier contact</th><th>Supplier code</th>
          <th>Main component</th><th>Main SKU</th><th>Model #</th>
          ${isClothing ? '<th>Wash label</th>' : ''}
          <th>Factory price</th><th>Sales unit price</th><th>Purchase qty</th><th>Total purchase price</th>
          <th>Actual wt</th><th>Transport wt</th>
          <th>Assembly fee</th><th>Labor costs</th><th>Transport fees</th><th>Other expenses</th>
          <th>Warehouse</th><th>Total owed</th><th>Settlement</th>
        </tr>
      </thead>
      <tbody>
        ${orders.map((o) => {
          const mc = o.mainComponent || {};
          const c = o.costs || {};
          return `
          <tr data-id="${escapeHtml(o.id)}">
            <td><strong>${escapeHtml(o.poNumber)}</strong></td>
            <td><span class="om-pill om-pill-${statusSlug(o.status)}">${escapeHtml(o.status)}</span></td>
            <td>${escapeHtml(o.buyer || '—')}</td>
            <td>${fmtDate(o.orderPlacementDate)}</td>
            <td>${fmtDate(o.desiredEntryDate)}</td>
            <td>${fmtDate(o.manufacturerDeliveryDate)}</td>
            <td>${escapeHtml(o.supplier.name || '—')}</td>
            <td>${escapeHtml(o.supplier.contact || '—')}</td>
            <td>${escapeHtml(o.supplier.code || '—')}</td>
            <td>${escapeHtml(mc.name || '—')}</td>
            <td>${escapeHtml(mc.sku || '—')}</td>
            <td>${escapeHtml(mc.modelNumber || '—')}</td>
            ${isClothing ? `<td>${escapeHtml(mc.washLabel || '—')}</td>` : ''}
            <td>${fmtMoney(mc.factoryPrice)}</td>
            <td>${fmtMoney(mc.salesUnitPrice)}</td>
            <td>${escapeHtml(mc.purchaseQuantity ?? '—')}</td>
            <td>${fmtMoney(mc.totalPurchasePrice)}</td>
            <td>${escapeHtml(mc.actualWeight ?? '—')}</td>
            <td>${escapeHtml(mc.transportWeight ?? '—')}</td>
            <td>${fmtMoney(c.assemblyFee)}</td>
            <td>${fmtMoney(c.laborCosts)}</td>
            <td>${fmtMoney(c.transportationFees)}</td>
            <td>${fmtMoney(c.otherExpenses)}</td>
            <td>${escapeHtml(mc.warehouse || '—')}</td>
            <td>${fmtMoney(computeOrderTotal(o))}</td>
            <td>${escapeHtml(o.settlement.status || 'Pending')}</td>
          </tr>
        `;
        }).join('')}
      </tbody>
    </table>
  `;
  host.querySelectorAll('tbody tr').forEach((tr) => {
    tr.addEventListener('click', () => openDetailPanel(tr.dataset.id));
  });
}

// "Main Components" sub-tab: same underlying order records, but the
// column set narrows to component + supplier fields, matching what
// QingFlow's separate "Main Component Supplier Confirmation" app showed.
function renderComponentsTable(host, orders) {
  if (!orders.length) {
    host.innerHTML = `<div class="om-empty">No orders yet.</div>`;
    return;
  }
  host.innerHTML = `
    <table class="om-table">
      <thead>
        <tr>
          <th>PO Number</th><th>Main component</th><th>Main SKU</th><th>Model #</th>
          <th>Supplier</th><th>Supplier contact</th><th>Supplier code</th>
          <th>Factory price</th><th>Purchase qty</th><th>Total purchase price</th>
          <th>Warehouse entry date</th><th>Waybill number</th><th>Qty received</th>
        </tr>
      </thead>
      <tbody>
        ${orders.map((o) => {
          const mc = o.mainComponent || {};
          const f = o.fulfillment || {};
          return `
          <tr data-id="${escapeHtml(o.id)}">
            <td><strong>${escapeHtml(o.poNumber)}</strong></td>
            <td>${escapeHtml(mc.name || '—')}</td>
            <td>${escapeHtml(mc.sku || '—')}</td>
            <td>${escapeHtml(mc.modelNumber || '—')}</td>
            <td>${escapeHtml(o.supplier.name || '—')}</td>
            <td>${escapeHtml(o.supplier.contact || '—')}</td>
            <td>${escapeHtml(o.supplier.code || '—')}</td>
            <td>${fmtMoney(mc.factoryPrice)}</td>
            <td>${escapeHtml(mc.purchaseQuantity ?? '—')}</td>
            <td>${fmtMoney(mc.totalPurchasePrice)}</td>
            <td>${fmtDate(f.warehouseEntryDate)}</td>
            <td>${escapeHtml(f.waybillNumber || '—')}</td>
            <td>${escapeHtml(f.quantityReceived ?? '—')}</td>
          </tr>
        `;
        }).join('')}
      </tbody>
    </table>
  `;
  host.querySelectorAll('tbody tr').forEach((tr) => {
    tr.addEventListener('click', () => openDetailPanel(tr.dataset.id, 'main-component'));
  });
}

function closePanel() {
  document.querySelectorAll('.om-panel-backdrop').forEach((el) => el.remove());
  document.removeEventListener('keydown', handlePanelEscapeKey);
}

function handlePanelEscapeKey(e) {
  if (e.key === 'Escape') closePanel();
}

function bindPanelEscape() {
  document.addEventListener('keydown', handlePanelEscapeKey);
}

function mountPanel(panel) {
  const backdrop = document.createElement('div');
  backdrop.className = 'om-panel-backdrop';
  backdrop.appendChild(panel);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closePanel();
  });
  document.body.appendChild(backdrop);
}

// Click any photo thumbnail (main product photo, component photos) to view
// it larger, without leaving the panel it's on.
function openImageLightbox(url) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:100;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
  overlay.innerHTML = `<img src="${escapeHtml(url)}" alt="" style="max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,0.5);" />`;
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

// Standard dropdown-below-the-field autocomplete, filtered to options that
// START WITH what's typed (so "Sha" only shows "Shanghai...", not anything
// containing "sha" anywhere). Replaces native <datalist>, whose popup
// position and match rules the browser controls, not us.
function attachTypeahead(inputId, getOptions) {
  const input = document.getElementById(inputId);
  if (!input || input.dataset.typeaheadAttached) return;
  input.dataset.typeaheadAttached = '1';
  input.removeAttribute('list');
  input.setAttribute('autocomplete', 'off');

  const wrap = document.createElement('div');
  wrap.className = 'om-typeahead-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const menu = document.createElement('div');
  menu.className = 'om-typeahead-menu';
  wrap.appendChild(menu);

  function renderMenu() {
    const q = input.value.trim().toLowerCase();
    const options = (getOptions() || []).filter(Boolean);
    const filtered = (q ? options.filter((o) => o.toLowerCase().startsWith(q)) : options).slice(0, 200);
    if (!filtered.length) { menu.classList.remove('open'); return; }
    menu.innerHTML = filtered.map((o) => `<div class="om-typeahead-option">${escapeHtml(o)}</div>`).join('');
    menu.classList.add('open');
    menu.querySelectorAll('.om-typeahead-option').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.value = el.textContent;
        menu.classList.remove('open');
        input.dispatchEvent(new Event('change'));
      });
    });
  }
  input.addEventListener('focus', renderMenu);
  input.addEventListener('input', renderMenu);
  input.addEventListener('blur', () => setTimeout(() => menu.classList.remove('open'), 150));
}

async function openDetailPanel(id, scope) {
  scope = scope || 'full';
  let order;
  let supplierNamesShared = []; // populated once the async supplier fetch below resolves; typeahead callbacks read it lazily so timing doesn't matter
  let suppliersShared = []; // full supplier records (for Supplier Contact autofill), same lazy-population deal
  let componentsShared = []; // component library records, for the sub-component Component Name typeahead + autofill
  let componentNamesShared = [];
  let paymentLineItemsState = {};
  try {
    const data = await api(`/api/order-management/orders/${encodeURIComponent(id)}`);
    order = data.order;
    paymentLineItemsState = { ...(order.settlement.componentPayments || {}) };
  } catch (e) {
    return showToast(e.message, true);
  }

  try {
  const panel = document.createElement('div');
  panel.className = 'om-panel';
  panel.innerHTML = `
   <div class="om-panel-inner">
    <div class="om-panel-header">
      <div>
        <div style="font-size:19px;font-weight:700;">${escapeHtml(order.poNumber)}</div>
        <div style="color:var(--jc-muted);font-size:13px;">${escapeHtml(order.mainComponent && order.mainComponent.name || '')}</div>
        ${scope !== 'full' ? `<div style="margin-top:4px;font-size:12px;font-weight:700;color:var(--jc-teal-dark);text-transform:uppercase;">Main component view</div>` : ''}
      </div>
      <div style="display:flex;gap:10px;align-items:center;">
        ${scope !== 'full' ? `<button class="btn btn-secondary" id="omViewFullPo" style="flex:none;width:auto;padding:7px 14px;font-size:13px;">View full PO</button>` : ''}
        <button class="btn btn-primary" id="omSaveOrder" style="flex:none;width:auto;padding:8px 18px;">Save changes</button>
        <button class="om-panel-close" id="omClosePanel">&times;</button>
      </div>
    </div>



    <div class="om-panel-card">
    <div class="om-section-title">Status</div>
    <div class="om-tracker" id="omStatusStepper">
      ${STATUSES.map((s, i) => {
        const currentIdx = STATUSES.indexOf(order.status);
        const state = i < currentIdx ? 'done' : i === currentIdx ? 'current' : 'future';
        return `
        <div class="om-tracker-step om-tracker-${state}" data-status="${escapeHtml(s)}">
          <div class="om-tracker-line"></div>
          <div class="om-tracker-dot">${state === 'done' ? '&#10003;' : i + 1}</div>
          <div class="om-tracker-label">${escapeHtml(s)}</div>
        </div>
      `;
      }).join('')}
    </div>
    </div>

    <div class="om-panel-card">
    <div class="om-section-title">Production Status</div>
    <div class="om-field-grid">
      <div><label>Product Complexity/Risk</label>
        <select id="fProductRisk" class="om-risk-select" data-risk="${escapeHtml(order.productRisk || '')}">
          <option value="" ${!order.productRisk ? 'selected' : ''}>—</option>
          <option value="high" ${order.productRisk === 'high' ? 'selected' : ''}>High</option>
          <option value="medium" ${order.productRisk === 'medium' ? 'selected' : ''}>Medium</option>
          <option value="low" ${order.productRisk === 'low' ? 'selected' : ''}>Low</option>
        </select>
      </div>
      <div><label>Order Status</label>
        <select id="fOrderStatusSelect" class="om-status-select" data-status="${escapeHtml(order.status)}">
          ${STATUSES.map((s) => `<option value="${escapeHtml(s)}" ${s === order.status ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
        </select>
      </div>
    </div>
    </div>

    <div class="om-panel-card">
    <div class="om-section-title">Order Details</div>
    <div id="omCopyFromPoSuggestion" style="display:none;margin-bottom:14px;padding:10px 14px;background:var(--jc-mint-light);border-radius:var(--radius-sm);align-items:center;gap:10px;flex-wrap:wrap;">
      <span id="omCopyFromPoText" style="font-size:13px;color:var(--jc-teal-dark);"></span>
      <button type="button" class="btn btn-primary" id="omCopyFromPoBtn" style="flex:none;width:auto;padding:6px 14px;font-size:12.5px;">Copy details</button>
    </div>
    <div class="om-field-grid">
      <div><label>Product Name</label><input id="fMainName" type="text" value="${val(order.mainComponent.name)}" /></div>
      <div><label>Purchase Order Number</label><input type="text" value="${escapeHtml(order.poNumber)}" disabled /></div>
      <div><label>SKU</label><input id="fMainSku" type="text" value="${val(order.mainComponent.sku)}" /></div>
      <div>
        <label>Photo reference</label>
        <div style="display:flex;align-items:center;gap:10px;">
          ${order.mainComponent.photoReference ? `<img id="fPhotoReferencePreview" class="om-table-thumb" style="width:52px;height:52px;cursor:pointer;" src="${escapeHtml(order.mainComponent.photoReference)}" alt="" title="Click to view larger" />` : `<img id="fPhotoReferencePreview" class="om-table-thumb" style="width:52px;height:52px;display:none;cursor:pointer;" alt="" title="Click to view larger" />`}
          <input type="hidden" id="fPhotoReference" value="${val(order.mainComponent.photoReference)}" />
          <input type="file" id="fPhotoReferenceFile" accept="image/*" style="display:none;" />
          <button type="button" class="om-table-upload-btn" id="fPhotoReferenceUploadBtn">Upload photo</button>
        </div>
      </div>
      <div><label>Supplier Name</label><input id="fSupplierName" type="text" list="dlSupplierNames" value="${val(order.supplier.name)}" /></div>
      <div><label>Supplier Code</label><input id="fSupplierCode" type="text" value="${val(order.supplier.code)}" /></div>
      <div>
        <label>Order placement date</label>
        <input id="fOrderDate" type="date" value="${val(order.orderPlacementDate)}" ${order.orderPlacementDate ? 'disabled title="Set once when the order was placed - not editable afterward"' : ''} />
      </div>
      <div><label>Fulfillment Request Date</label><input id="fFulfillmentRequestDate" type="date" value="${val(order.fulfillmentRequestDate)}" /></div>
      <div><label>Required Warehouse Arrival Date</label><input id="fDesiredEntry" type="date" value="${val(order.desiredEntryDate)}" /></div>
      <div><label>Required Manufacturer Delivery Date</label><input id="fManufDelivery" type="date" value="${val(order.manufacturerDeliveryDate)}" /></div>
      <div><label>Order Quantity</label><input id="fPurchaseQty" type="number" value="${val(order.mainComponent.purchaseQuantity)}" /></div>
      <div><label>Quantity received</label><input id="fFulfillQtyReceived" type="number" value="${val(order.fulfillment.quantityReceived)}" /></div>
      <div><label>Order Management Specialist</label>
        <select id="fBuyer" data-current="${escapeHtml(order.buyer || '')}">
          <option value="${escapeHtml(order.buyer || '')}">${escapeHtml(order.buyer || '— Select —')}</option>
        </select>
        <input type="text" id="fBuyerOther" placeholder="Enter new specialist name" style="margin-top:8px;display:none;" />
      </div>
    </div>
    </div>

    <div class="om-panel-card">
    <div class="om-section-title">Product Development Approval</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <button type="button" class="btn btn-secondary om-copy-link-btn" style="flex:none;width:auto;padding:9px 16px;" data-copy-url="${escapeHtml(`${location.origin}/approval.html?po=${order.id}`)}">Share Link</button>
      <a class="btn btn-primary" style="flex:none;width:auto;padding:9px 16px;text-decoration:none;" href="/approval.html?po=${encodeURIComponent(order.id)}" target="_blank" rel="noopener">Open Link</a>
    </div>
    </div>

    <div class="om-panel-card">
    <div class="om-section-title">QA/QC Reporting</div>
    <div class="section-help" style="margin-bottom:12px;">Share either link with a factory or QA contact - it already knows this PO, so they can jump straight into the report.</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <button type="button" class="btn btn-secondary om-copy-link-btn" style="flex:none;width:auto;padding:9px 16px;" data-copy-url="${escapeHtml(`${location.origin}/reporting.html?mode=pre_production&po=${order.poNumber}`)}">Copy Pre-Production Report Link</button>
      <button type="button" class="btn btn-secondary om-copy-link-btn" style="flex:none;width:auto;padding:9px 16px;" data-copy-url="${escapeHtml(`${location.origin}/reporting.html?mode=production&po=${order.poNumber}`)}">Copy Bulk Sampling Report Link</button>
    </div>
    </div>

    <div id="fClothingOnly" class="om-panel-card">
      <div class="om-section-title">${order.productLine === 'clothing' ? 'Size Distribution' : 'Variant Distribution'}</div>
      <table class="om-table om-table-editable" style="min-width:0;">
        <thead><tr><th>SKU</th><th>${order.productLine === 'clothing' ? 'Size' : 'Variant'}</th><th>Order Qty</th><th>Qty Received</th><th></th></tr></thead>
        <tbody id="omSizeRows"></tbody>
      </table>
      <button type="button" class="btn btn-secondary" id="omAddSizeRow" style="flex:none;width:auto;padding:8px 14px;margin-top:6px;">+ Add ${order.productLine === 'clothing' ? 'size row' : 'variant'}</button>
    </div>

    <div class="om-panel-card">
    <div class="om-section-title">Product Documentation</div>
    <div class="om-field-grid om-field-grid-row">
      ${uploadFieldHtml('fManufacturingDrawing', 'Manufacturing Drawing', order.mainComponent.manufacturingDrawing, true)}
      ${uploadFieldHtml('fWashingTagUrl', 'Washing Tag', order.mainComponent.washingTagUrl, true)}
      ${uploadFieldHtml('fPackagingUrl', 'Packaging', order.mainComponent.packagingUrl, true)}
      ${order.productLine !== 'clothing' ? uploadFieldHtml('fDimensionsUrl', 'Product Dimensions', order.mainComponent.dimensionsUrl, true) : ''}
    </div>
    <div class="om-field-grid om-field-grid-row" style="margin-top:22px;">
      <div><label>Weight (g)</label><input id="fWeightGrams" type="number" step="1" value="${val(order.mainComponent.weightGrams)}" /></div>
      <div><label>Shipping Weight (g)</label><input id="fShippingWeightGrams" type="number" step="1" value="${val(order.mainComponent.shippingWeightGrams)}" /></div>
      <div><label>Volume Weight (g)</label><input id="fVolumeWeightGrams" type="number" step="1" value="${val(order.mainComponent.volumeWeightGrams)}" /></div>
    </div>
    ${order.productLine === 'clothing' ? `
      <div style="margin-top:28px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
          <div style="flex:1;min-width:260px;">
            <label style="margin:0;">Product Dimensions - sizing source of truth for this PO</label>
            <div class="section-help" style="margin-top:4px;">Loading a standard copies it in as an editable starting point - edits here only affect this PO. This becomes what QA/QC checks against for this specific order.</div>
          </div>
          <select id="fDimensionsStandardSelect" style="width:auto;"><option value="">Select a standard to load...</option></select>
        </div>
        <div id="fDimensionsTableWrap" style="margin-top:12px;"></div>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button type="button" class="btn btn-secondary" id="fDimensionsAddSize" style="flex:none;width:auto;padding:7px 14px;font-size:13px;">+ Add size</button>
          <button type="button" class="btn btn-secondary" id="fDimensionsAddPoint" style="flex:none;width:auto;padding:7px 14px;font-size:13px;">+ Add measurement point</button>
        </div>
      </div>
    ` : `
      <div style="margin-top:28px;">
        <label style="margin:0;">Product Dimensions</label>
        <div class="om-field-grid om-field-grid-row" style="margin-top:8px;">
          <div><label>Length (cm)</label><input id="fDimensionsLength" type="number" step="0.1" value="${val(order.mainComponent.dimensionsLength)}" /></div>
          <div><label>Width (cm)</label><input id="fDimensionsWidth" type="number" step="0.1" value="${val(order.mainComponent.dimensionsWidth)}" /></div>
          <div><label>Height (cm)</label><input id="fDimensionsHeight" type="number" step="0.1" value="${val(order.mainComponent.dimensionsHeight)}" /></div>
        </div>
      </div>
    `}
    </div>

    <div class="om-panel-card">
    <div class="om-section-title">Main Component Specifications</div>
    <div class="om-field-grid">
      ${order.productLine === 'clothing' ? `
        <div><label>Fabric Code</label><input id="fFabricInfo" type="text" value="${val(order.mainComponent.fabricInfo)}" /></div>
        <div><label>Fabric Type</label><input id="fComponent" type="text" placeholder="e.g. 100% Cotton" value="${val(order.mainComponent.component)}" /></div>
      ` : ''}
      <div><label>Unit Price (¥)</label><div class="om-money-wrap"><input id="fFactoryPrice" type="number" step="0.01" value="${val(order.mainComponent.factoryPrice)}" /></div></div>
      <div><label>Supplier Address</label><input id="fSupplierAddress" type="text" value="${val(order.supplier.address)}" placeholder="Auto-fills from Supplier Name above" /></div>
    </div>
    </div>

    <div id="omComponentBreakdownSection" class="om-panel-card" style="${scope === 'main-component' ? 'display:none;' : ''}">
      <div class="om-section-title">Sub-Component Breakdown</div>
      <div class="om-table-wrap">
        <table class="om-table om-table-editable">
          <thead>
            <tr>
              <th>Component Name</th><th>Photo</th><th>Length</th><th>Width</th><th>Height</th><th>Quantity</th><th>Supplier</th>
              <th>Price (¥)</th><th>Shipping Cost (¥)</th><th>Supplier Contact</th><th>Delivery Date</th><th>Component Delivery Address</th>
              <th>Manufacturing Drawing</th><th></th>
            </tr>
          </thead>
          <tbody id="omAccessoryRows"></tbody>
        </table>
      </div>
      <button type="button" class="btn btn-secondary" id="omAddAccessoryRow" style="flex:none;width:auto;padding:8px 14px;margin-top:6px;">+ Add accessory / part</button>
    </div>

    <div class="om-panel-card">
    <div class="om-section-title">Warehousing Breakdown</div>
    <div class="om-field-grid">
      <div><label>Warehouse Address</label>
        <select id="fWarehouse" data-current="${escapeHtml(order.mainComponent.warehouse || '')}">
          <option value="${escapeHtml(order.mainComponent.warehouse || '')}">${escapeHtml(order.mainComponent.warehouse || '— Select —')}</option>
        </select>
        <input type="text" id="fWarehouseOther" placeholder="Enter new warehouse name" style="margin-top:8px;display:none;" />
      </div>
      <div><label>Shipping cost (¥)</label><div class="om-money-wrap"><input id="fTransportationFees" type="number" step="0.01" value="${val(order.costs.transportationFees)}" /></div></div>
      <div><label>Packing List Number</label><input id="fFulfillPacking" type="text" value="${val(order.fulfillment.packingListNumber)}" /></div>
      <div><label>Waybill Number</label><input id="fFulfillWaybill" type="text" value="${val(order.fulfillment.waybillNumber)}" /></div>
    </div>
    </div>

    <div class="om-panel-card">
    <div class="om-section-title">Payment</div>
    <div class="om-field-grid">
      <div><label>Additional Assembly Fee (¥)</label><div class="om-money-wrap"><input id="fAssemblyFee" type="number" step="0.01" value="${val(order.costs.assemblyFee)}" /></div></div>
      <div><label>Additional Labor Fee (¥)</label><div class="om-money-wrap"><input id="fLaborCosts" type="number" step="0.01" value="${val(order.costs.laborCosts)}" /></div></div>
      <div><label>Other Expenses (¥)</label><div class="om-money-wrap"><input id="fOtherExpenses" type="number" step="0.01" value="${val(order.costs.otherExpenses)}" /></div></div>
      <div><label>Manufacturing Cost per unit (¥)</label><input id="fManufacturingCostTotal" type="text" value="${fmtMoney(computeManufacturingCostPerUnit(order))}" disabled title="Main component unit price + sum of sub-component unit prices" /></div>
      <div><label>Total PO Cost (¥)</label><input id="fTotalPoCost" type="text" value="${fmtMoney(computeOrderTotal(order))}" disabled title="Manufacturing Cost x Order Quantity, plus shipping and additional fees" /></div>
      <div><label>Total Price per Unit (¥)</label><input id="fTotalPricePerUnit" type="text" value="${order.mainComponent.purchaseQuantity ? fmtMoney(computeOrderTotal(order) / order.mainComponent.purchaseQuantity) : '—'}" disabled title="Total PO cost divided by units ordered" /></div>
    </div>

    <div class="om-section-title" style="margin-top:20px;">Paid Status by Component</div>
    <table class="om-table" style="min-width:0;">
      <thead><tr><th>Component</th><th>Amount (¥)</th><th>Status</th></tr></thead>
      <tbody id="omPaymentLineItems"></tbody>
    </table>
    <div class="om-detail-row" style="margin-top:10px;"><span class="om-label"><strong>Overall Payment Status</strong></span><span class="om-value" id="omOverallPaymentStatus">${escapeHtml(order.settlement.status)}</span></div>
    ${order.settlement.paidDate ? `<div class="om-detail-row"><span class="om-label">Paid in full on</span><span class="om-value">${fmtDate(order.settlement.paidDate)}</span></div>` : ''}
    <div style="margin-top:14px;">
      <button type="button" class="btn btn-primary" id="omCompletePoBtn" style="flex:none;width:auto;padding:9px 18px;" ${(order.status === STATUSES[STATUSES.length - 1] && order.settlement.status === 'Paid') ? '' : 'disabled title="Available once the order has reached its final status and every component is marked Paid"'}>
        ${order.poCompletedAt ? `PO Completed ${fmtDate(order.poCompletedAt)}` : 'Complete PO'}
      </button>
    </div>
    </div>

    <div class="om-panel-card">
    <div class="om-section-title">Change log</div>
    <ul class="om-changelog">
      ${(order.changeLog || []).map((c) => `
        <li>
          <strong>${escapeHtml(c.action)}</strong>${c.details ? ' — ' + escapeHtml(c.details) : ''}
          <div class="om-cl-meta">${escapeHtml(c.actor || 'Unknown')} · ${new Date(c.timestamp).toLocaleString()}</div>
        </li>
      `).join('') || '<li class="om-cl-meta">No changes logged yet.</li>'}
    </ul>
    </div>
   </div>
  `;

  mountPanel(panel);
  bindPanelEscape();

  document.getElementById('omClosePanel').addEventListener('click', closePanel);
  const viewFullPoBtn = document.getElementById('omViewFullPo');
  if (viewFullPoBtn) viewFullPoBtn.addEventListener('click', () => { closePanel(); openDetailPanel(order.id, 'full'); });

  panel.querySelectorAll('.om-copy-link-btn').forEach((btn) => {
    const originalLabel = btn.textContent;
    btn.addEventListener('click', async () => {
      const url = btn.dataset.copyUrl;
      try {
        await navigator.clipboard.writeText(url);
      } catch (e) {
        // Clipboard API can be blocked (e.g. non-HTTPS/no permission) -
        // fall back to a manual copy so the button still does something useful.
        const tempInput = document.createElement('textarea');
        tempInput.value = url;
        document.body.appendChild(tempInput);
        tempInput.select();
        document.execCommand('copy');
        document.body.removeChild(tempInput);
      }
      btn.textContent = 'Link copied';
      btn.disabled = true;
      clearTimeout(btn._copyResetTimer);
      btn._copyResetTimer = setTimeout(() => {
        btn.textContent = originalLabel;
        btn.disabled = false;
      }, 4500);
    });
  });

  panel.querySelectorAll('.om-tracker-step').forEach((btn) => {
    btn.addEventListener('click', () => applyStatusChange(btn.dataset.status));
  });

  document.getElementById('fProductRisk').addEventListener('change', (e) => {
    e.target.setAttribute('data-risk', e.target.value);
  });

  document.getElementById('fPhotoReferenceUploadBtn').addEventListener('click', () => {
    document.getElementById('fPhotoReferenceFile').click();
  });
  document.getElementById('fPhotoReferencePreview').addEventListener('click', () => {
    const src = document.getElementById('fPhotoReferencePreview').src;
    if (src) openImageLightbox(src);
  });
  document.getElementById('fPhotoReferenceFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('category', 'Style picture');
    formData.append('relatedTo', 'main-photo');
    try {
      const res = await fetch(`/api/order-management/orders/${encodeURIComponent(order.id)}/files`, { method: 'POST', body: formData });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Upload failed');
      document.getElementById('fPhotoReference').value = body.file.url;
      const preview = document.getElementById('fPhotoReferencePreview');
      preview.src = body.file.url;
      preview.style.display = 'block';
      showToast('Photo uploaded');
    } catch (err) { showToast(err.message, true); }
  });

  // ---- Always-editable size distribution, accessories ----
  let editSizeRowCount = 0;
  const sizeRowsHost = panel.querySelector('#omSizeRows');
  function addSizeRow(data) {
    sizeRowsHost.insertAdjacentHTML('beforeend',
      `<tr data-size-row="${editSizeRowCount}">
        <td><input type="text" placeholder="SKU" class="om-size-sku" value="${val(data && data.sku)}" /></td>
        <td><input type="text" placeholder="Size" class="om-size-size" value="${val(data && data.size)}" /></td>
        <td><input type="number" placeholder="Order Qty" class="om-size-qty" value="${val(data && data.quantity)}" /></td>
        <td><input type="number" placeholder="Qty Received" class="om-size-qty-received" value="${val(data && data.quantityReceived)}" /></td>
        <td><button type="button" class="om-row-remove" data-remove-size="${editSizeRowCount}">&times;</button></td>
      </tr>`);
    const idx = editSizeRowCount;
    panel.querySelector(`[data-remove-size="${idx}"]`).addEventListener('click', () => {
      panel.querySelector(`[data-size-row="${idx}"]`).remove();
    });
    editSizeRowCount++;
  }
  (order.mainComponent.sizeDistribution || []).forEach(addSizeRow);
  panel.querySelector('#omAddSizeRow').addEventListener('click', () => addSizeRow());

  let editAccessoryRowCount = 0;
  const accessoryRowsHost = panel.querySelector('#omAccessoryRows');

  async function uploadAccessoryFile(row, file, category, urlInputSelector, onDone) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('category', category);
    formData.append('relatedTo', row.dataset.accessoryId || '');
    try {
      const res = await fetch(`/api/order-management/orders/${encodeURIComponent(order.id)}/files`, { method: 'POST', body: formData });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Upload failed');
      row.querySelector(urlInputSelector).value = body.file.url;
      showToast('File uploaded');
      onDone(body.file.url);
    } catch (e) { showToast(e.message, true); }
  }

  function wireAccessoryRowUploads(row) {
    const imageInput = row.querySelector('.om-acc-image-file');
    row.querySelector('.om-acc-image-upload-btn').addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', () => {
      if (!imageInput.files[0]) return;
      uploadAccessoryFile(row, imageInput.files[0], 'Style picture', '.om-acc-image-url', (url) => {
        const cell = row.querySelector('.om-acc-image-cell');
        let img = cell.querySelector('img');
        if (!img) {
          img = document.createElement('img');
          img.className = 'om-table-thumb';
          cell.insertBefore(img, cell.firstChild);
        }
        img.src = url;
      });
    });
    const docInput = row.querySelector('.om-acc-doc-file');
    row.querySelector('.om-acc-doc-upload-btn').addEventListener('click', () => docInput.click());
    docInput.addEventListener('change', () => {
      if (!docInput.files[0]) return;
      uploadAccessoryFile(row, docInput.files[0], 'Design document', '.om-acc-doc-url', (url) => {
        const cell = row.querySelector('.om-acc-doc-cell');
        let link = cell.querySelector('a');
        if (!link) {
          link = document.createElement('a');
          link.target = '_blank';
          link.rel = 'noopener';
          link.style.cssText = 'display:block;font-size:11.5px;margin-bottom:4px;';
          link.textContent = 'View file';
          cell.insertBefore(link, cell.firstChild);
        }
        link.href = url;
      });
    });
  }

  function currentSupplierAddress() {
    const el = document.getElementById('fSupplierAddress');
    return el ? el.value : '';
  }
  function addAccessoryRow(data) {
    accessoryRowsHost.insertAdjacentHTML('beforeend', accessoryRowHtml(editAccessoryRowCount, data, currentSupplierAddress()));
    const idx = editAccessoryRowCount;
    const row = panel.querySelector(`[data-accessory-row="${idx}"]`);
    panel.querySelector(`[data-remove-accessory="${idx}"]`).addEventListener('click', () => { row.remove(); recalcTotals(); });
    wireAccessoryRowUploads(row);
    attachTypeahead(`accSupplier${idx}`, () => supplierNamesShared);
    document.getElementById(`accSupplier${idx}`).addEventListener('change', (e) => {
      const match = suppliersShared.find((s) => s.name.trim().toLowerCase() === e.target.value.trim().toLowerCase());
      if (match && match.contactName) row.querySelector('.om-acc-supplier-contact').value = match.contactName;
    });
    // Component Name pulls from the Components library - picking a known
    // part auto-populates its supplier, unit price, and contact. Typing a
    // new name still works: it becomes a library entry on save via the
    // existing auto-sync, so it'll be in this dropdown next time.
    attachTypeahead(`accName${idx}`, () => componentNamesShared);
    document.getElementById(`accName${idx}`).addEventListener('change', (e) => {
      const match = componentsShared.find((c) => (c.partName || '').trim().toLowerCase() === e.target.value.trim().toLowerCase());
      if (!match) return;
      if (match.supplierName) row.querySelector('.om-acc-supplier').value = match.supplierName;
      if (match.unitPrice !== null && match.unitPrice !== undefined && match.unitPrice !== '') {
        const priceInput = row.querySelector('.om-acc-unit-price');
        if (!priceInput.value) priceInput.value = match.unitPrice;
      }
      if (match.supplierName) {
        const sup = suppliersShared.find((s) => s.name.trim().toLowerCase() === match.supplierName.trim().toLowerCase());
        if (sup && sup.contactName) row.querySelector('.om-acc-supplier-contact').value = sup.contactName;
      }
      recalcTotals();
    });
    editAccessoryRowCount++;
  }
  (order.accessories && order.accessories.length ? order.accessories : [{}]).forEach(addAccessoryRow);
  panel.querySelector('#omAddAccessoryRow').addEventListener('click', () => { addAccessoryRow(); recalcTotals(); });
  // Component Delivery Address defaults from the main component's own
  // Supplier Address (below), not the warehouse - it updates live as that
  // field changes, same pattern the old warehouse-tied version used.
  const supplierAddressInput = document.getElementById('fSupplierAddress');
  if (supplierAddressInput) {
    supplierAddressInput.addEventListener('input', (e) => {
      accessoryRowsHost.querySelectorAll('.om-acc-address-cell').forEach((cell) => { cell.textContent = e.target.value || '—'; });
    });
  }

  // ---- Live cost recalculation: the Manufacturing Cost / Total PO Cost /
  // Total Price per Unit / Product Pricing fields are computed displays,
  // not editable - they need to be recomputed as the user types into any
  // of the fields that feed them, not just after a save-and-reload. ----
  function recalcTotals() {
    const mainUnitCost = Number(document.getElementById('fFactoryPrice').value) || 0;
    const orderQuantity = Number(document.getElementById('fPurchaseQty').value) || 0;

    let subComponentUnitCostSum = 0;
    let subComponentShippingTotal = 0;
    Array.from(accessoryRowsHost.querySelectorAll('[data-accessory-row]')).forEach((row) => {
      subComponentUnitCostSum += Number(row.querySelector('.om-acc-unit-price').value) || 0;
      subComponentShippingTotal += Number(row.querySelector('.om-acc-shipping-cost').value) || 0;
    });

    const manufacturingCostPerUnit = mainUnitCost + subComponentUnitCostSum;
    const flatFees = (Number(document.getElementById('fAssemblyFee').value) || 0) +
      (Number(document.getElementById('fLaborCosts').value) || 0) +
      (Number(document.getElementById('fTransportationFees').value) || 0) +
      (Number(document.getElementById('fOtherExpenses').value) || 0) +
      subComponentShippingTotal;
    const totalPoCost = Math.round((manufacturingCostPerUnit * orderQuantity + flatFees) * 100) / 100;

    document.getElementById('fManufacturingCostTotal').value = fmtMoney(manufacturingCostPerUnit);
    document.getElementById('fTotalPoCost').value = fmtMoney(totalPoCost);
    document.getElementById('fTotalPricePerUnit').value = orderQuantity ? fmtMoney(totalPoCost / orderQuantity) : '—';
    renderPaymentLineItems();
  }
  ['fFactoryPrice', 'fPurchaseQty', 'fAssemblyFee', 'fLaborCosts', 'fTransportationFees', 'fOtherExpenses'].forEach((id) => {
    document.getElementById(id).addEventListener('input', recalcTotals);
  });
  // Delegate accessory-row qty/price/shipping inputs since rows are added/
  // removed dynamically - a listener on the table body catches all of them,
  // current and future, without needing to re-wire on every add/remove.
  accessoryRowsHost.addEventListener('input', (e) => {
    if (e.target.classList.contains('om-acc-qty') || e.target.classList.contains('om-acc-unit-price') || e.target.classList.contains('om-acc-shipping-cost')) recalcTotals();
  });

  // ---- Paid Status by Component: a checkbox per cost line, saved
  // immediately (like the old Mark Paid/Pending toggle) rather than
  // waiting for the master Save, since payment status shouldn't be easy to
  // lose track of. Overall status is derived (all checked -> Paid). ----
  function buildPaymentLineItems() {
    const mainUnitCost = Number(document.getElementById('fFactoryPrice').value) || 0;
    const orderQuantity = Number(document.getElementById('fPurchaseQty').value) || 0;
    const items = [
      { key: 'main', label: 'Main Component', amount: mainUnitCost * orderQuantity }
    ];
    Array.from(accessoryRowsHost.querySelectorAll('[data-accessory-row]')).forEach((row) => {
      const name = row.querySelector('.om-acc-name').value || 'Unnamed component';
      const unitPrice = Number(row.querySelector('.om-acc-unit-price').value) || 0;
      const shipping = Number(row.querySelector('.om-acc-shipping-cost').value) || 0;
      items.push({ key: row.dataset.accessoryId, label: name, amount: unitPrice * orderQuantity + shipping });
    });
    items.push({ key: 'warehousing-shipping', label: 'Warehousing Shipping', amount: Number(document.getElementById('fTransportationFees').value) || 0 });
    items.push({
      key: 'fees', label: 'Additional Fees (Assembly/Labor/Other)',
      amount: (Number(document.getElementById('fAssemblyFee').value) || 0) +
        (Number(document.getElementById('fLaborCosts').value) || 0) +
        (Number(document.getElementById('fOtherExpenses').value) || 0)
    });
    return items;
  }

  function renderPaymentLineItems() {
    const items = buildPaymentLineItems();
    const tbody = document.getElementById('omPaymentLineItems');
    if (!tbody) return;
    tbody.innerHTML = items.map((item) => {
      const paid = !!paymentLineItemsState[item.key];
      return `
      <tr>
        <td>${escapeHtml(item.label)}</td>
        <td>${fmtMoney(item.amount)}</td>
        <td>
          <select data-payment-key="${escapeHtml(item.key)}" class="om-paid-select" data-paid="${paid ? 'paid' : 'pending'}">
            <option value="pending" ${!paid ? 'selected' : ''}>Pending</option>
            <option value="paid" ${paid ? 'selected' : ''}>Paid</option>
          </select>
        </td>
      </tr>
    `;
    }).join('');
    tbody.querySelectorAll('[data-payment-key]').forEach((sel) => {
      sel.addEventListener('change', async (e) => {
        const isPaid = e.target.value === 'paid';
        e.target.setAttribute('data-paid', isPaid ? 'paid' : 'pending');
        paymentLineItemsState[e.target.dataset.paymentKey] = isPaid;
        const allPaid = items.length > 0 && items.every((item) => paymentLineItemsState[item.key]);
        const newStatus = allPaid ? 'Paid' : 'Pending';
        document.getElementById('omOverallPaymentStatus').textContent = newStatus;
        try {
          await api(`/api/order-management/orders/${encodeURIComponent(order.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({
              patch: { settlement: { ...order.settlement, componentPayments: paymentLineItemsState, status: newStatus, paidDate: allPaid ? new Date().toISOString() : null } },
              actor: 'Web user'
            })
          });
          order.settlement.status = newStatus;
          order.settlement.componentPayments = paymentLineItemsState;
          updateCompletePoButtonState();
          refreshCurrentView();
        } catch (err) { showToast(err.message, true); }
      });
    });
  }
  renderPaymentLineItems();

  // ---- Complete PO: a manual confirmation step, available once the
  // status stepper has reached its last stage AND every component above
  // is Paid - both need to independently update this button's enabled
  // state as they change, without a full panel re-render. ----
  function updateCompletePoButtonState() {
    const btn = document.getElementById('omCompletePoBtn');
    if (!btn || order.poCompletedAt) return; // already completed - leave the "PO Completed" label alone
    const eligible = order.status === STATUSES[STATUSES.length - 1] && order.settlement.status === 'Paid';
    btn.disabled = !eligible;
    btn.title = eligible ? '' : 'Available once the order has reached its final status and every component is marked Paid';
  }
  const completePoBtn = document.getElementById('omCompletePoBtn');
  if (completePoBtn) {
    completePoBtn.addEventListener('click', async () => {
      if (order.poCompletedAt) return;
      try {
        await api(`/api/order-management/orders/${encodeURIComponent(order.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ patch: { poCompletedAt: new Date().toISOString() }, actor: 'Web user' })
        });
        order.poCompletedAt = new Date().toISOString();
        completePoBtn.textContent = `PO Completed ${fmtDate(order.poCompletedAt)}`;
        completePoBtn.disabled = true;
        showToast('PO marked complete');
        refreshCurrentView();
      } catch (err) { showToast(err.message, true); }
    });
  }

  // ---- Product Dimensions: this PO's own editable sizing table (apparel
  // only). Selecting a standard copies it in as a starting point; every
  // edit after that only affects this PO, independent of the master
  // standard - it becomes what QA/QC checks against for this order. ----
  let dimensionsTableState = order.mainComponent.dimensionsTable
    ? JSON.parse(JSON.stringify(order.mainComponent.dimensionsTable))
    : null;
  // Canonical size list (Youth XS -> Adult 5XL, same order used everywhere
  // else sizes are picked) - populated once /api/fits resolves below, and
  // used to make the Size column a dropdown instead of free text.
  let universalSizes = [];

  function renderDimensionsTable() {
    const wrap = document.getElementById('fDimensionsTableWrap');
    if (!wrap) return;
    if (!dimensionsTableState) {
      wrap.innerHTML = `<div class="om-empty">No sizing table yet - select a standard above, or add sizes/points manually.</div>`;
      return;
    }
    const t = dimensionsTableState;
    const sizeNames = Object.keys(t.sizes);
    // Current value always included even if it's not in the canonical
    // list (e.g. a standard loaded from fits.json with its own naming),
    // so picking a standard never "loses" a size the dropdown doesn't know.
    const sizeOptionsHtml = (current) => {
      const options = current && !universalSizes.includes(current) ? [current, ...universalSizes] : universalSizes;
      return options.map((s) => `<option value="${escapeHtml(s)}" ${s === current ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('');
    };
    wrap.innerHTML = `
      <div class="om-table-wrap">
        <table class="om-table om-table-editable" style="min-width:0;">
          <thead>
            <tr>
              <th>Size</th>
              ${t.points.map((p) => `
                <th>
                  ${escapeHtml((t.pointLabels[p] && t.pointLabels[p].en) || p)}
                  <button type="button" class="om-row-remove" data-dim-remove-point="${escapeHtml(p)}" title="Remove point">&times;</button>
                </th>
              `).join('')}
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${sizeNames.map((sizeName) => `
              <tr>
                <td><select data-dim-size-rename="${escapeHtml(sizeName)}" style="min-width:110px;">${sizeOptionsHtml(sizeName)}</select></td>
                ${t.points.map((p) => `
                  <td><input type="text" data-dim-cell="${escapeHtml(sizeName)}|${escapeHtml(p)}" value="${escapeHtml(t.sizes[sizeName][p] ?? '')}" style="min-width:70px;" /></td>
                `).join('')}
                <td><button type="button" class="om-row-remove" data-dim-remove-size="${escapeHtml(sizeName)}" title="Remove size">&times;</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    wrap.querySelectorAll('[data-dim-cell]').forEach((el) => {
      el.addEventListener('input', (e) => {
        const [sizeName, p] = el.getAttribute('data-dim-cell').split('|');
        dimensionsTableState.sizes[sizeName][p] = e.target.value;
      });
    });
    wrap.querySelectorAll('[data-dim-size-rename]').forEach((el) => {
      el.addEventListener('change', (e) => {
        const oldName = el.getAttribute('data-dim-size-rename');
        const newName = e.target.value.trim();
        if (!newName || newName === oldName) return;
        if (dimensionsTableState.sizes[newName]) return showToast('That size is already in the table', true);
        dimensionsTableState.sizes[newName] = dimensionsTableState.sizes[oldName];
        delete dimensionsTableState.sizes[oldName];
        renderDimensionsTable();
      });
    });
    wrap.querySelectorAll('[data-dim-remove-size]').forEach((el) => {
      el.addEventListener('click', () => {
        delete dimensionsTableState.sizes[el.getAttribute('data-dim-remove-size')];
        renderDimensionsTable();
      });
    });
    wrap.querySelectorAll('[data-dim-remove-point]').forEach((el) => {
      el.addEventListener('click', () => {
        const p = el.getAttribute('data-dim-remove-point');
        dimensionsTableState.points = dimensionsTableState.points.filter((x) => x !== p);
        delete dimensionsTableState.pointLabels[p];
        Object.values(dimensionsTableState.sizes).forEach((s) => delete s[p]);
        renderDimensionsTable();
      });
    });
  }

  const dimStandardSelect = document.getElementById('fDimensionsStandardSelect');
  if (dimStandardSelect) {
    renderDimensionsTable();
    api('/api/fits').then((fitsData) => {
      const fits = (fitsData && fitsData.fits) || {};
      universalSizes = (fitsData && fitsData.universalSizes) || [];
      dimStandardSelect.innerHTML = `<option value="">Select a standard to load...</option>` +
        Object.keys(fits).sort().map((key) => `<option value="${escapeHtml(key)}">${escapeHtml(fits[key].label_en || key)}</option>`).join('');
      // Re-render now that universalSizes is populated, so any table
      // already on the page (loaded from this PO's saved data) gets the
      // dropdown treatment too, not just tables built after this point.
      renderDimensionsTable();
      dimStandardSelect.addEventListener('change', (e) => {
        const chosen = fits[e.target.value];
        if (!chosen) return;
        dimensionsTableState = {
          standardKey: e.target.value,
          points: [...(chosen.points || [])],
          pointLabels: JSON.parse(JSON.stringify(chosen.pointLabels || {})),
          sizes: JSON.parse(JSON.stringify(chosen.sizes || {}))
        };
        renderDimensionsTable();
      });
    }).catch((e) => showToast(e.message, true));

    document.getElementById('fDimensionsAddSize').addEventListener('click', () => {
      if (!dimensionsTableState) dimensionsTableState = { standardKey: null, points: [], pointLabels: {}, sizes: {} };
      // Pick the first canonical size not already in the table, so the new
      // row shows up as a real, already-valid size selected in the
      // dropdown - never a "New Size" placeholder to type over.
      const nextSize = universalSizes.find((s) => !dimensionsTableState.sizes[s])
        || `New Size ${Object.keys(dimensionsTableState.sizes).length + 1}`;
      dimensionsTableState.sizes[nextSize] = {};
      renderDimensionsTable();
    });
    document.getElementById('fDimensionsAddPoint').addEventListener('click', () => {
      if (!dimensionsTableState) dimensionsTableState = { standardKey: null, points: [], pointLabels: {}, sizes: {} };
      const label = prompt('New measurement point name (e.g. Length, Sleeve):');
      if (!label) return;
      const key = label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_');
      if (dimensionsTableState.points.includes(key)) return showToast('That point already exists', true);
      dimensionsTableState.points.push(key);
      dimensionsTableState.pointLabels[key] = { en: label, zh: '' };
      renderDimensionsTable();
    });
  }

  // ---- Copy from previous PO: auto-detects a match on SKU as you type it,
  // rather than making you know and manually enter a prior PO number.
  // Pulls product identity info forward (not order-specific things like
  // quantities, dates, or status) so PO2 doesn't start from a blank form
  // when it's really the same product as PO1. ----
  let copyFromMatch = null;
  async function checkForCopyFromMatch() {
    const sku = document.getElementById('fMainSku').value.trim();
    const box = document.getElementById('omCopyFromPoSuggestion');
    if (!sku) { box.style.display = 'none'; copyFromMatch = null; return; }
    try {
      const data = await api(`/api/order-management/orders/by-sku/${encodeURIComponent(sku)}`);
      const match = (data.orders || []).find((o) => o.id !== order.id);
      if (!match) { box.style.display = 'none'; copyFromMatch = null; return; }
      copyFromMatch = match;
      document.getElementById('omCopyFromPoText').textContent = `Found a previous PO with this SKU: ${match.poNumber}`;
      box.style.display = 'flex';
    } catch (e) { box.style.display = 'none'; copyFromMatch = null; }
  }
  document.getElementById('fMainSku').addEventListener('change', checkForCopyFromMatch);
  checkForCopyFromMatch();

  document.getElementById('omCopyFromPoBtn').addEventListener('click', async () => {
    if (!copyFromMatch) return;
    try {
      const src = copyFromMatch;

      document.getElementById('fSupplierName').value = src.supplier.name || '';
      document.getElementById('fSupplierCode').value = src.supplier.code || '';
      const supplierAddrEl = document.getElementById('fSupplierAddress');
      if (supplierAddrEl) supplierAddrEl.value = src.supplier.address || '';
      const riskSelect = document.getElementById('fProductRisk');
      riskSelect.value = src.productRisk || '';
      riskSelect.setAttribute('data-risk', src.productRisk || '');
      const fabricInfoEl = document.getElementById('fFabricInfo');
      const componentEl = document.getElementById('fComponent');
      if (fabricInfoEl) fabricInfoEl.value = src.mainComponent.fabricInfo || '';
      if (componentEl) componentEl.value = src.mainComponent.component || '';
      document.getElementById('fManufacturingDrawing').value = src.mainComponent.manufacturingDrawing || '';
      document.getElementById('fFactoryPrice').value = src.mainComponent.factoryPrice || '';
      document.getElementById('fWarehouse').value = src.mainComponent.warehouse || '';

      // Sizing source of truth: copy the whole dimensions table forward
      // too, if the source PO has one - this is the "copy over the sizing"
      // button for PO2+.
      if (src.mainComponent.dimensionsTable) {
        dimensionsTableState = JSON.parse(JSON.stringify(src.mainComponent.dimensionsTable));
        renderDimensionsTable();
      }

      // Size distribution: carry the SKU/size structure forward, not the
      // quantities or receipt status - those are specific to this order.
      sizeRowsHost.innerHTML = '';
      editSizeRowCount = 0;
      (src.mainComponent.sizeDistribution && src.mainComponent.sizeDistribution.length
        ? src.mainComponent.sizeDistribution.map((r) => ({ sku: r.sku, size: r.size }))
        : [{}]
      ).forEach(addSizeRow);

      // Accessories/components: carry the whole part list forward as a
      // starting point (supplier, pricing, etc.) - each row keeps its own
      // "Add"/"Remove" so it's easy to adjust from here.
      accessoryRowsHost.innerHTML = '';
      editAccessoryRowCount = 0;
      (src.accessories && src.accessories.length
        ? src.accessories.map((a) => ({ ...a, id: undefined, imageUrl: '', designDocUrl: '' }))
        : [{}]
      ).forEach(addAccessoryRow);

      showToast(`Copied details from ${src.poNumber}`);
    } catch (e) { showToast(e.message, true); }
  });

  // ---- Order Status dropdown - saves immediately, same as clicking the tracker ----
  function renderStatusTracker(newStatus) {
    const stepper = document.getElementById('omStatusStepper');
    if (!stepper) return;
    const currentIdx = STATUSES.indexOf(newStatus);
    stepper.innerHTML = STATUSES.map((s, i) => {
      const state = i < currentIdx ? 'done' : i === currentIdx ? 'current' : 'future';
      return `
        <div class="om-tracker-step om-tracker-${state}" data-status="${escapeHtml(s)}">
          <div class="om-tracker-line"></div>
          <div class="om-tracker-dot">${state === 'done' ? '&#10003;' : i + 1}</div>
          <div class="om-tracker-label">${escapeHtml(s)}</div>
        </div>
      `;
    }).join('');
    stepper.querySelectorAll('.om-tracker-step').forEach((btn) => {
      btn.addEventListener('click', () => applyStatusChange(btn.dataset.status));
    });
  }

  async function applyStatusChange(newStatusValue) {
    try {
      await api(`/api/order-management/orders/${encodeURIComponent(order.id)}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: newStatusValue })
      });
      order.status = newStatusValue;
      document.getElementById('fOrderStatusSelect').value = newStatusValue;
      document.getElementById('fOrderStatusSelect').setAttribute('data-status', newStatusValue);
      renderStatusTracker(newStatusValue);
      updateCompletePoButtonState();
      showToast('Status updated');
      refreshCurrentView();
    } catch (err) { showToast(err.message, true); }
  }

  document.getElementById('fOrderStatusSelect').addEventListener('change', (e) => {
    applyStatusChange(e.target.value);
  });

  // ---- Reusable "dropdown with ability to add new" fields: populate
  // datalists from real Supplier records (for name -> code autofill) and
  // from values already used on other orders, so anything typed in becomes
  // a future suggestion without needing a separate managed list. ----
  (async () => {
    try {
      const [suppliersData, historyData, optionsData, warehousesData, componentsData, fabricCodesData] = await Promise.all([
        api('/api/suppliers'),
        api('/api/order-management/field-history'),
        api('/api/options'),
        api('/api/warehouses'),
        api('/api/catalog/components'),
        api('/api/fabric-library/codes')
      ]);
      const suppliers = suppliersData.suppliers || [];
      const supplierNames = suppliers.map((s) => s.name);
      supplierNamesShared = supplierNames;
      suppliersShared = suppliers;
      componentsShared = (componentsData && componentsData.components) || [];
      componentNamesShared = componentsShared.map((c) => c.partName).filter(Boolean);
      const fabricCodesLib = (fabricCodesData && fabricCodesData.codes) || [];

      attachTypeahead('fSupplierName', () => supplierNames);
      // Fabric Code suggestions lead with the Fabric Library's reference
      // names ("01 - 100% Cotton") - that's the standard way to fill this
      // in - followed by any historical PO values not already in the
      // library, so older conventions still autocomplete.
      const libraryFabricNames = fabricCodesLib.map((c) => c.value).filter(Boolean);
      const librarySet = new Set(libraryFabricNames.map((v) => v.toLowerCase()));
      const fabricCodeOptions = libraryFabricNames.concat(
        (historyData.fabricCodes || []).filter((v) => v && !librarySet.has(v.toLowerCase()))
      );
      attachTypeahead('fFabricInfo', () => fabricCodeOptions);
      attachTypeahead('fComponent', () => historyData.fabricTypes || []);

      // Picking a library swatch (by reference name or pantone) auto-fills
      // the Fabric Type from its material blend - only when empty, so a
      // hand-typed type is never clobbered.
      const fabricInfoInput = document.getElementById('fFabricInfo');
      const fabricTypeInput = document.getElementById('fComponent');
      if (fabricInfoInput) {
        fabricInfoInput.addEventListener('change', () => {
          const q = fabricInfoInput.value.trim().toLowerCase();
          if (!q) return;
          const match = fabricCodesLib.find((c) =>
            (c.value || '').trim().toLowerCase() === q || (c.pantone || '').trim().toLowerCase() === q);
          if (match && match.materialBlend && fabricTypeInput && !fabricTypeInput.value.trim()) {
            fabricTypeInput.value = match.materialBlend;
          }
        });
      }

      const supplierNameInput = document.getElementById('fSupplierName');
      const supplierCodeInput = document.getElementById('fSupplierCode');
      const supplierAddrInput = document.getElementById('fSupplierAddress');
      supplierNameInput.addEventListener('change', () => {
        const match = suppliers.find((s) => s.name.trim().toLowerCase() === supplierNameInput.value.trim().toLowerCase());
        if (match && match.vendorCode) supplierCodeInput.value = match.vendorCode;
        // Auto-fill from the matched supplier record, but only overwrite
        // if empty - never clobber an address someone already typed/edited
        // by hand for this specific PO.
        if (match && supplierAddrInput && !supplierAddrInput.value.trim()) {
          supplierAddrInput.value = match.shippingAddress || match.mailingAddress || '';
          supplierAddrInput.dispatchEvent(new Event('input'));
        }
      });

      // Order Management Specialist - same list as QA/QC team names, with
      // an "Add other" option (like Creator/PD Lead on the New PO form)
      // since this is an open-ended list a team maintains, not a fixed set.
      const buyerSelect = document.getElementById('fBuyer');
      const buyerOtherInput = document.getElementById('fBuyerOther');
      if (buyerSelect) {
        const qaLeads = optionsData.qaLeads || [];
        const current = buyerSelect.dataset.current || '';
        const names = current && !qaLeads.includes(current) ? [current, ...qaLeads] : qaLeads;
        buyerSelect.innerHTML = `<option value="">— Select —</option>` +
          `<option value="__other__">+ Add new...</option>` +
          names.map((n) => `<option value="${escapeHtml(n)}" ${n === current ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
        buyerSelect.addEventListener('change', (e) => {
          const isOther = e.target.value === '__other__';
          buyerOtherInput.style.display = isOther ? '' : 'none';
          if (isOther) buyerOtherInput.focus();
        });
      }

      // Warehouse Address - real Warehouse records, managed on the
      // Suppliers page's Warehouses section, with an "+ Add new..." option:
      // a typed name becomes a real Warehouse record on save.
      const warehouseSelect = document.getElementById('fWarehouse');
      const warehouseOtherInput = document.getElementById('fWarehouseOther');
      if (warehouseSelect) {
        const warehouses = (warehousesData && warehousesData.warehouses) || [];
        const current = warehouseSelect.dataset.current || '';
        const names = warehouses.map((w) => w.name);
        const allNames = current && !names.includes(current) ? [current, ...names] : names;
        warehouseSelect.innerHTML = `<option value="">— Select —</option>` +
          `<option value="__other__">+ Add new...</option>` +
          allNames.map((n) => `<option value="${escapeHtml(n)}" ${n === current ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
        warehouseSelect.addEventListener('change', (e) => {
          const isOther = e.target.value === '__other__';
          warehouseOtherInput.style.display = isOther ? '' : 'none';
          if (isOther) warehouseOtherInput.focus();
        });
        accessoryRowsHost.querySelectorAll('.om-acc-address-cell').forEach((cell) => { cell.textContent = currentSupplierAddress() || '—'; });
      }
    } catch (e) { /* these are conveniences - fine to skip silently if this fails */ }
  })();

  wireUploadField('fManufacturingDrawing', order.id, 'Design document', true);
  wireUploadField('fWashingTagUrl', order.id, 'Other', true);
  wireUploadField('fPackagingUrl', order.id, 'Other', true);
  if (order.productLine !== 'clothing') wireUploadField('fDimensionsUrl', order.id, 'Other', true);

  // Master "Save changes": everything on the page except status (saves
  // immediately above) and payment status (its own Mark Paid/Pending toggle).
  document.getElementById('omSaveOrder').addEventListener('click', async () => {
    const productLine = order.productLine;
    const buyerSelectEl = document.getElementById('fBuyer');
    const buyerValue = buyerSelectEl.value === '__other__'
      ? document.getElementById('fBuyerOther').value.trim()
      : buyerSelectEl.value;
    const warehouseSelectEl = document.getElementById('fWarehouse');
    const warehouseValue = warehouseSelectEl.value === '__other__'
      ? document.getElementById('fWarehouseOther').value.trim()
      : warehouseSelectEl.value;
    const patch = {
      buyer: buyerValue,
      orderPlacementDate: document.getElementById('fOrderDate').value || null,
      desiredEntryDate: document.getElementById('fDesiredEntry').value || null,
      manufacturerDeliveryDate: document.getElementById('fManufDelivery').value || null,
      fulfillmentRequestDate: document.getElementById('fFulfillmentRequestDate').value || null,
      productRisk: document.getElementById('fProductRisk').value || null,
      supplier: {
        name: document.getElementById('fSupplierName').value,
        contact: order.supplier.contact,
        code: document.getElementById('fSupplierCode').value,
        address: document.getElementById('fSupplierAddress').value
      },
      mainComponent: {
        name: document.getElementById('fMainName').value,
        sku: document.getElementById('fMainSku').value,
        factoryPrice: document.getElementById('fFactoryPrice').value || null,
        purchaseQuantity: document.getElementById('fPurchaseQty').value || null,
        warehouse: warehouseValue,
        photoReference: document.getElementById('fPhotoReference').value,
        manufacturingDrawing: document.getElementById('fManufacturingDrawing').value,
        washingTagUrl: document.getElementById('fWashingTagUrl').value,
        packagingUrl: document.getElementById('fPackagingUrl').value,
        dimensionsUrl: productLine !== 'clothing' ? document.getElementById('fDimensionsUrl').value : '',
        dimensionsTable: productLine === 'clothing' ? dimensionsTableState : null,
        dimensionsLength: productLine !== 'clothing' ? (document.getElementById('fDimensionsLength').value || null) : null,
        dimensionsWidth: productLine !== 'clothing' ? (document.getElementById('fDimensionsWidth').value || null) : null,
        dimensionsHeight: productLine !== 'clothing' ? (document.getElementById('fDimensionsHeight').value || null) : null,
        weightGrams: document.getElementById('fWeightGrams').value || null,
        shippingWeightGrams: document.getElementById('fShippingWeightGrams').value || null,
        volumeWeightGrams: document.getElementById('fVolumeWeightGrams').value || null,
        fabricInfo: productLine === 'clothing' ? document.getElementById('fFabricInfo').value : order.mainComponent.fabricInfo,
        component: productLine === 'clothing' ? document.getElementById('fComponent').value : order.mainComponent.component,
        sizeDistribution: Array.from(sizeRowsHost.querySelectorAll('[data-size-row]')).map((row) => ({
          sku: row.querySelector('.om-size-sku').value,
          size: row.querySelector('.om-size-size').value,
          quantity: row.querySelector('.om-size-qty').value || null,
          quantityReceived: row.querySelector('.om-size-qty-received').value || null
        })).filter((r) => r.sku || r.size || r.quantity || r.quantityReceived)
      },
      accessories: collectAccessoryRows(accessoryRowsHost),
      fulfillment: {
        packingListNumber: document.getElementById('fFulfillPacking').value,
        waybillNumber: document.getElementById('fFulfillWaybill').value,
        quantityReceived: document.getElementById('fFulfillQtyReceived').value || null
      },
      costs: {
        assemblyFee: document.getElementById('fAssemblyFee').value || 0,
        laborCosts: document.getElementById('fLaborCosts').value || 0,
        transportationFees: document.getElementById('fTransportationFees').value || 0,
        otherExpenses: document.getElementById('fOtherExpenses').value || 0
      }
    };
    try {
      await api(`/api/order-management/orders/${encodeURIComponent(order.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ patch, actor: 'Web user' })
      });
      showToast('Changes saved');
      closePanel();
      openDetailPanel(order.id);
      refreshCurrentView();
    } catch (e) { showToast(e.message, true); }
  });
  } catch (e) {
    console.error('Failed to render order detail panel:', e);
    showToast('Something went wrong opening this order. Check the console for details.', true);
  }
}

// Lightweight, mostly-read-only view scoped to a single accessory/sub-PO -
// reachable only from the Accessories sub-tab, since that's the only place
// a bare accessory (rather than a full order) is the thing being clicked.
async function openAccessoryDetailPanel(orderId, accessoryId) {
  let order, accessory;
  try {
    const data = await api(`/api/order-management/orders/${encodeURIComponent(orderId)}`);
    order = data.order;
    accessory = (order.accessories || []).find((a) => a.id === accessoryId);
    if (!accessory) throw new Error('That component could not be found - it may have been removed.');
  } catch (e) {
    return showToast(e.message, true);
  }

  const panel = document.createElement('div');
  panel.className = 'om-panel';
  panel.innerHTML = `
   <div class="om-panel-inner">
    <div class="om-panel-header">
      <div>
        <div style="font-size:19px;font-weight:700;">${escapeHtml(accessory.partName || 'Unnamed part')}</div>
        <div style="color:var(--jc-muted);font-size:13px;">Component of ${escapeHtml(order.poNumber)}</div>
        <div style="margin-top:4px;font-size:12px;font-weight:700;color:var(--jc-teal-dark);text-transform:uppercase;">Component view</div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;">
        <button class="btn btn-secondary" id="omViewFullPoFromAccessory" style="flex:none;width:auto;padding:7px 14px;font-size:13px;">View main PO</button>
        <button class="om-panel-close" id="omClosePanel">&times;</button>
      </div>
    </div>

    <div class="om-section-title">Status</div>
    <div class="om-field-grid">
      <div><label>Status</label>
        <select id="accStatus">
          ${ACCESSORY_STATUSES.map((s) => `<option value="${escapeHtml(s)}" ${s === accessory.status ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
        </select>
      </div>
    </div>

    <div class="om-section-title">Component Details</div>
    ${accessory.imageUrl ? `<img src="${escapeHtml(accessory.imageUrl)}" alt="" style="width:96px;height:96px;object-fit:cover;border-radius:8px;border:1px solid var(--jc-border);margin-bottom:12px;" />` : ''}
    <div class="om-detail-grid">
      <div class="om-detail-row"><span class="om-label">Part name</span><span class="om-value">${escapeHtml(accessory.partName || '—')}</span></div>
      <div class="om-detail-row"><span class="om-label">Dimensions</span><span class="om-value">${escapeHtml(accessory.dimensions || '—')}</span></div>
      <div class="om-detail-row"><span class="om-label">Quantity</span><span class="om-value">${escapeHtml(accessory.quantity ?? '—')}</span></div>
      <div class="om-detail-row"><span class="om-label">Unit price</span><span class="om-value">${fmtMoney(accessory.unitPrice)}</span></div>
      <div class="om-detail-row"><span class="om-label">Total price</span><span class="om-value">${fmtMoney(accessory.totalPrice)}</span></div>
      <div class="om-detail-row"><span class="om-label">Supplier name</span><span class="om-value">${escapeHtml(accessory.supplierName || '—')}</span></div>
      <div class="om-detail-row"><span class="om-label">Supplier contact</span><span class="om-value">${escapeHtml(accessory.supplierContact || '—')}</span></div>
      <div class="om-detail-row"><span class="om-label">Desired delivery date</span><span class="om-value">${fmtDate(accessory.expectedDeliveryDate)}</span></div>
      <div class="om-detail-row"><span class="om-label">Delivery address</span><span class="om-value">${escapeHtml(accessory.deliveryAddress || '—')}</span></div>
      ${accessory.designDocUrl ? `<div class="om-detail-row"><span class="om-label">Design document</span><span class="om-value"><a href="${escapeHtml(accessory.designDocUrl)}" target="_blank" rel="noopener">View file</a></span></div>` : ''}
      <div class="om-detail-row"><span class="om-label">Remark</span><span class="om-value">${escapeHtml(accessory.remark || '—')}</span></div>
    </div>

    <div style="margin-top:24px;padding-top:16px;border-top:1px solid var(--jc-border);display:flex;justify-content:flex-end;">
      <button class="btn btn-primary" id="omSaveAccessoryStatus" style="flex:none;width:auto;padding:10px 24px;">Save status</button>
    </div>
   </div>
  `;

  mountPanel(panel);
  bindPanelEscape();
  document.getElementById('omClosePanel').addEventListener('click', closePanel);
  document.getElementById('omViewFullPoFromAccessory').addEventListener('click', () => {
    closePanel();
    openDetailPanel(order.id, 'full');
  });
  document.getElementById('omSaveAccessoryStatus').addEventListener('click', async () => {
    const newStatus = document.getElementById('accStatus').value;
    const accessories = order.accessories.map((a) => a.id === accessoryId ? { ...a, status: newStatus } : a);
    try {
      await api(`/api/order-management/orders/${encodeURIComponent(order.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ patch: { accessories }, actor: 'Web user' })
      });
      showToast('Status saved');
      closePanel();
      refreshCurrentView();
    } catch (e) { showToast(e.message, true); }
  });
}

async function setSettlement(id, status) {
  try {
    await api(`/api/order-management/orders/${encodeURIComponent(id)}/settlement`, {
      method: 'POST',
      body: JSON.stringify({ status })
    });
    showToast('Settlement updated');
    closePanel();
    refreshCurrentView();
  } catch (e) { showToast(e.message, true); }
}

// Generic upload-type field: label + (thumbnail or file link) + Upload
// button, backed by the same order-management file-upload endpoint used
// elsewhere. Used for the several Product Documentation fields that are
// uploads rather than typed values (Manufacturing Drawing, Washing Tag,
// Packaging, etc).
function uploadFieldHtml(fieldId, label, currentUrl, isImage) {
  let preview;
  if (currentUrl) {
    preview = isImage
      ? `<img id="${fieldId}Preview" class="om-upload-preview" src="${escapeHtml(currentUrl)}" alt="" title="Click to view larger" />`
      : `<a id="${fieldId}Preview" href="${escapeHtml(currentUrl)}" target="_blank" rel="noopener" style="font-size:12px;">View file</a>`;
  } else if (isImage) {
    // Reserved, empty slot rather than nothing - keeps the row's height
    // stable and shows where the thumbnail will land once a file's chosen.
    preview = `<div id="${fieldId}Preview" class="om-upload-preview-empty"></div>`;
  } else {
    preview = `<span id="${fieldId}Preview" style="display:none;"></span>`;
  }
  return `
    <div>
      <label>${escapeHtml(label)}</label>
      <div style="display:flex;align-items:center;gap:10px;">
        ${preview}
        <input type="hidden" id="${fieldId}" value="${escapeHtml(currentUrl || '')}" />
        <input type="file" id="${fieldId}File" style="display:none;" ${isImage ? 'accept="image/*"' : ''} />
        <button type="button" class="om-table-upload-btn" id="${fieldId}UploadBtn">Upload</button>
      </div>
    </div>
  `;
}

// Wires the button/file-input/preview behavior for a field built with
// uploadFieldHtml() above. Call once per field, after it's in the DOM.
function wireUploadField(fieldId, orderId, category, isImage) {
  const uploadBtn = document.getElementById(`${fieldId}UploadBtn`);
  const fileInput = document.getElementById(`${fieldId}File`);
  if (!uploadBtn || !fileInput) return;
  uploadBtn.addEventListener('click', () => fileInput.click());
  if (isImage) {
    const img = document.getElementById(`${fieldId}Preview`);
    if (img && img.tagName === 'IMG') img.addEventListener('click', () => openImageLightbox(img.src));
  }
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('category', category);
    formData.append('relatedTo', fieldId);
    try {
      const res = await fetch(`/api/order-management/orders/${encodeURIComponent(orderId)}/files`, { method: 'POST', body: formData });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Upload failed');
      document.getElementById(fieldId).value = body.file.url;
      const container = document.getElementById(`${fieldId}Preview`).parentNode;
      const old = document.getElementById(`${fieldId}Preview`);
      let fresh;
      if (isImage) {
        fresh = document.createElement('img');
        fresh.id = `${fieldId}Preview`;
        fresh.className = 'om-upload-preview';
        fresh.src = body.file.url;
        fresh.addEventListener('click', () => openImageLightbox(body.file.url));
      } else {
        fresh = document.createElement('a');
        fresh.id = `${fieldId}Preview`;
        fresh.href = body.file.url;
        fresh.target = '_blank';
        fresh.rel = 'noopener';
        fresh.style.fontSize = '12px';
        fresh.textContent = 'View file';
      }
      container.replaceChild(fresh, old);
      showToast('File uploaded');
    } catch (err) { showToast(err.message, true); }
  });
}

function accessoryRowHtml(idx, data, mainAddress) {
  data = data || {};
  const rowId = data.id || `tmp-${Date.now()}-${idx}`;
  return `
    <tr data-accessory-row="${idx}" data-accessory-id="${escapeHtml(rowId)}">
      <td><input type="text" id="accName${idx}" class="om-acc-name" value="${escapeHtml(data.partName || '')}" /></td>
      <td class="om-acc-image-cell">
        ${data.imageUrl ? `<img class="om-table-thumb" src="${escapeHtml(data.imageUrl)}" alt="" />` : ''}
        <input type="hidden" class="om-acc-image-url" value="${escapeHtml(data.imageUrl || '')}" />
        <input type="file" class="om-acc-image-file" accept="image/*" style="display:none;" />
        <button type="button" class="om-table-upload-btn om-acc-image-upload-btn">Upload</button>
      </td>
      <td><input type="number" step="0.01" class="om-acc-length" placeholder="L" value="${escapeHtml(data.dimensionsLength ?? '')}" style="min-width:56px;" /></td>
      <td><input type="number" step="0.01" class="om-acc-width" placeholder="W" value="${escapeHtml(data.dimensionsWidth ?? '')}" style="min-width:56px;" /></td>
      <td><input type="number" step="0.01" class="om-acc-height" placeholder="H" value="${escapeHtml(data.dimensionsHeight ?? '')}" style="min-width:56px;" /></td>
      <td><input type="number" class="om-acc-qty" value="${escapeHtml(data.quantity ?? '')}" /></td>
      <td style="min-width:160px;"><input type="text" id="accSupplier${idx}" class="om-acc-supplier" value="${escapeHtml(data.supplierName || '')}" style="width:100%;" /></td>
      <td><input type="number" step="0.01" class="om-acc-unit-price" value="${escapeHtml(data.unitPrice ?? '')}" /></td>
      <td><input type="number" step="0.01" class="om-acc-shipping-cost" value="${escapeHtml(data.shippingCost ?? '')}" /></td>
      <td><input type="text" class="om-acc-supplier-contact" value="${escapeHtml(data.supplierContact || '')}" /></td>
      <td><input type="date" class="om-acc-expected-delivery" value="${escapeHtml(data.expectedDeliveryDate || '')}" /></td>
      <td class="om-acc-address-cell" style="color:var(--jc-muted);font-size:12.5px;">${escapeHtml(mainAddress || '—')}</td>
      <td class="om-acc-doc-cell">
        ${data.designDocUrl ? `<a href="${escapeHtml(data.designDocUrl)}" target="_blank" rel="noopener" style="display:block;font-size:11.5px;margin-bottom:4px;">View file</a>` : ''}
        <input type="hidden" class="om-acc-doc-url" value="${escapeHtml(data.designDocUrl || '')}" />
        <input type="file" class="om-acc-doc-file" style="display:none;" />
        <button type="button" class="om-table-upload-btn om-acc-doc-upload-btn">Upload</button>
      </td>
      <td><button type="button" class="om-row-remove" data-remove-accessory="${idx}" title="Remove">&times;</button></td>
    </tr>
  `;
}

function val(v) { return v === null || v === undefined ? '' : escapeHtml(v); }


function collectAccessoryRows(container) {
  const scope = container || document;
  return Array.from(scope.querySelectorAll('[data-accessory-row]')).map((row) => ({
    id: row.dataset.accessoryId || undefined,
    partName: row.querySelector('.om-acc-name').value,
    dimensionsLength: row.querySelector('.om-acc-length').value || null,
    dimensionsWidth: row.querySelector('.om-acc-width').value || null,
    dimensionsHeight: row.querySelector('.om-acc-height').value || null,
    quantity: row.querySelector('.om-acc-qty').value || null,
    unitPrice: row.querySelector('.om-acc-unit-price').value || null,
    totalPrice: (row.querySelector('.om-acc-qty').value || 0) * (row.querySelector('.om-acc-unit-price').value || 0) || null,
    shippingCost: row.querySelector('.om-acc-shipping-cost').value || null,
    expectedDeliveryDate: row.querySelector('.om-acc-expected-delivery').value || null,
    supplierName: row.querySelector('.om-acc-supplier').value,
    supplierContact: row.querySelector('.om-acc-supplier-contact').value,
    deliveryAddress: row.querySelector('.om-acc-address-cell') ? row.querySelector('.om-acc-address-cell').textContent : '',
    imageUrl: row.querySelector('.om-acc-image-url').value,
    designDocUrl: row.querySelector('.om-acc-doc-url').value
  })).filter((a) => a.partName || a.supplierName);
}


(async function init() {
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  if (view === 'suppliers' || view === 'settlement' || view === 'products' || view === 'components' || view === 'fabric-library') currentView = view;
  await Promise.all([loadStatuses(), loadAccessoryStatuses(), loadFileCategories()]);
  render();
})();
