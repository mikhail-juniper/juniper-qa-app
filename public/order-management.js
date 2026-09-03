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
      <div style="padding:14px 18px;" id="omPoRequestsHost">
        ${newRequests.length ? `
          <table class="om-table" style="min-width:0;">
            <thead><tr><th>PO Number</th><th>Product line</th><th>Buyer</th><th>Supplier</th><th>Desired entry</th></tr></thead>
            <tbody>
              ${newRequests.map((o) => `
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
    const orders = (data.orders || []).slice(0, 8); // preview only - "View all" shows everything
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
  `;
  bindBackToHub();
  document.getElementById('omNewSupplierBtn').addEventListener('click', () => openSupplierForm(null));
  try {
    const data = await api('/api/suppliers');
    renderSuppliersTable(data.suppliers || []);
  } catch (e) { showToast(e.message, true); }
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
    const [clothing, toys, other, manualData] = await Promise.all([
      api('/api/order-management/products?productLine=clothing'),
      api('/api/order-management/products?productLine=toys'),
      api('/api/order-management/products?productLine=other'),
      api('/api/catalog/products')
    ]);
    const manual = manualData.products || [];
    host.innerHTML = [
      productsCategoryBlock('clothing', clothing.products || [], manual.filter((p) => p.productLine === 'clothing')),
      productsCategoryBlock('toys', toys.products || [], manual.filter((p) => p.productLine === 'toys')),
      productsCategoryBlock('other', other.products || [], manual.filter((p) => p.productLine === 'other'))
    ].join('');
    host.querySelectorAll('tbody tr[data-po]').forEach((tr) => {
      tr.addEventListener('click', () => openDetailPanel(tr.dataset.po));
    });
    host.querySelectorAll('tbody tr[data-manual-id]').forEach((tr) => {
      tr.addEventListener('click', async () => {
        try {
          const data = await api(`/api/catalog/products/${encodeURIComponent(tr.dataset.manualId)}`);
          openProductForm(data.product);
        } catch (e) { showToast(e.message, true); }
      });
    });
  } catch (e) { showToast(e.message, true); }
}

function productsCategoryBlock(productLine, products, manualProducts) {
  const meta = CATEGORY_META[productLine];
  const total = products.length + manualProducts.length;
  return `
    <div class="om-category-tile" style="margin-bottom:20px;">
      <div class="om-category-tile-header" style="border-color:${meta.color};"><span>${meta.label} Products (${total})</span></div>
      ${total ? `
        <table class="om-table">
          <thead><tr><th>Name</th><th>SKU</th><th>Model #</th><th>Factory price</th><th>Sales unit price</th><th># POs</th></tr></thead>
          <tbody>
            ${manualProducts.map((p) => `
              <tr data-manual-id="${escapeHtml(p.id)}">
                <td><strong>${escapeHtml(p.name)}</strong></td>
                <td>${escapeHtml(p.sku || '—')}</td>
                <td>${escapeHtml(p.modelNumber || '—')}</td>
                <td>${fmtMoney(p.factoryPrice)}</td>
                <td>${fmtMoney(p.salesUnitPrice)}</td>
                <td>—</td>
              </tr>
            `).join('')}
            ${products.map((p) => `
              <tr data-po="${escapeHtml(p.examplePoId)}">
                <td><strong>${escapeHtml(p.name)}</strong></td>
                <td>${escapeHtml(p.sku || '—')}</td>
                <td>${escapeHtml(p.modelNumber || '—')}</td>
                <td>${fmtMoney(p.factoryPrice)}</td>
                <td>${fmtMoney(p.salesUnitPrice)}</td>
                <td>${p.poCount}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : `<div class="om-empty">No ${meta.label.toLowerCase()} products recorded yet.</div>`}
    </div>
  `;
}

function openProductForm(product) {
  const panel = document.createElement('div');
  panel.className = 'om-panel';
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
      <div><label>Product line</label>
        <select id="prodProductLine">
          <option value="clothing" ${!product || product.productLine === 'clothing' ? 'selected' : ''}>Apparel</option>
          <option value="toys" ${product && product.productLine === 'toys' ? 'selected' : ''}>Toys</option>
          <option value="other" ${product && product.productLine === 'other' ? 'selected' : ''}>Other</option>
        </select>
      </div>
      <div><label>Factory price</label><input id="prodFactoryPrice" type="number" step="0.01" value="${val(product && product.factoryPrice)}" /></div>
      <div><label>Sales unit price</label><input id="prodSalesUnitPrice" type="number" step="0.01" value="${val(product && product.salesUnitPrice)}" /></div>
    </div>
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
    const [clothing, toys, other, manualData] = await Promise.all([
      api('/api/order-management/components?productLine=clothing'),
      api('/api/order-management/components?productLine=toys'),
      api('/api/order-management/components?productLine=other'),
      api('/api/catalog/components')
    ]);
    const manual = manualData.components || [];
    host.innerHTML = [
      componentsCategoryBlock('clothing', clothing.components || [], manual.filter((c) => c.productLine === 'clothing')),
      componentsCategoryBlock('toys', toys.components || [], manual.filter((c) => c.productLine === 'toys')),
      componentsCategoryBlock('other', other.components || [], manual.filter((c) => c.productLine === 'other'))
    ].join('');
    host.querySelectorAll('tbody tr[data-po]').forEach((tr) => {
      tr.addEventListener('click', () => openDetailPanel(tr.dataset.po));
    });
    host.querySelectorAll('tbody tr[data-manual-id]').forEach((tr) => {
      tr.addEventListener('click', async () => {
        try {
          const data = await api(`/api/catalog/components/${encodeURIComponent(tr.dataset.manualId)}`);
          openComponentForm(data.component);
        } catch (e) { showToast(e.message, true); }
      });
    });
  } catch (e) { showToast(e.message, true); }
}

function componentsCategoryBlock(productLine, components, manualComponents) {
  const meta = CATEGORY_META[productLine];
  const total = components.length + manualComponents.length;
  return `
    <div class="om-category-tile" style="margin-bottom:20px;">
      <div class="om-category-tile-header" style="border-color:${meta.color};"><span>${meta.label} Components (${total})</span></div>
      ${total ? `
        <table class="om-table">
          <thead><tr><th>Part name</th><th>Material</th><th>Supplier</th><th>Unit price</th><th># uses</th></tr></thead>
          <tbody>
            ${manualComponents.map((c) => `
              <tr data-manual-id="${escapeHtml(c.id)}">
                <td><strong>${escapeHtml(c.partName)}</strong></td>
                <td>${escapeHtml(c.material || '—')}</td>
                <td>${escapeHtml(c.supplierName || '—')}</td>
                <td>${fmtMoney(c.unitPrice)}</td>
                <td>—</td>
              </tr>
            `).join('')}
            ${components.map((c) => `
              <tr data-po="${escapeHtml(c.examplePoId)}">
                <td><strong>${escapeHtml(c.partName)}</strong></td>
                <td>${escapeHtml(c.material || '—')}</td>
                <td>${escapeHtml(c.supplierName || '—')}</td>
                <td>${fmtMoney(c.unitPrice)}</td>
                <td>${c.useCount}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : `<div class="om-empty">No ${meta.label.toLowerCase()} components recorded yet.</div>`}
    </div>
  `;
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
      <div><label>Unit price</label><input id="compUnitPrice" type="number" step="0.01" value="${val(component && component.unitPrice)}" /></div>
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

function computeOrderTotal(order) {
  const mc = order.mainComponent || {};
  const mainTotal = Number(mc.totalPurchasePrice) ||
    (Number(mc.factoryPrice) || 0) * (Number(mc.purchaseQuantity) || Number(mc.salesVolume) || 0);
  const accessoriesTotal = (order.accessories || []).reduce((sum, a) => sum + (Number(a.totalPrice) || 0), 0);
  const costs = order.costs || {};
  const feesTotal = (Number(costs.assemblyFee) || 0) + (Number(costs.laborCosts) || 0) +
    (Number(costs.transportationFees) || 0) + (Number(costs.otherExpenses) || 0);
  return Math.round((mainTotal + accessoriesTotal + feesTotal) * 100) / 100;
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

async function openDetailPanel(id, scope) {
  scope = scope || 'full';
  let order;
  try {
    const data = await api(`/api/order-management/orders/${encodeURIComponent(id)}`);
    order = data.order;
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
    <div class="om-section-title">Order Details</div>
    <div class="om-field-grid">
      <div><label>Product Name</label><input id="fMainName" type="text" value="${val(order.mainComponent.name)}" /></div>
      <div><label>Purchase Order Number</label><input type="text" value="${escapeHtml(order.poNumber)}" disabled /></div>
      <div><label>SKU</label><input id="fMainSku" type="text" value="${val(order.mainComponent.sku)}" /></div>
      <div><label>Supplier Name</label><input id="fSupplierName" type="text" list="dlSupplierNames" value="${val(order.supplier.name)}" /></div>
      <div><label>Supplier Code</label><input id="fSupplierCode" type="text" value="${val(order.supplier.code)}" /></div>
      <div><label>Order Status</label>
        <select id="fOrderStatusSelect">
          ${STATUSES.map((s) => `<option value="${escapeHtml(s)}" ${s === order.status ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label>Photo reference</label>
        <div style="display:flex;align-items:center;gap:10px;">
          ${order.mainComponent.photoReference ? `<img id="fPhotoReferencePreview" class="om-table-thumb" style="width:52px;height:52px;" src="${escapeHtml(order.mainComponent.photoReference)}" alt="" />` : `<img id="fPhotoReferencePreview" class="om-table-thumb" style="width:52px;height:52px;display:none;" alt="" />`}
          <input type="hidden" id="fPhotoReference" value="${val(order.mainComponent.photoReference)}" />
          <input type="file" id="fPhotoReferenceFile" accept="image/*" style="display:none;" />
          <button type="button" class="om-table-upload-btn" id="fPhotoReferenceUploadBtn">Upload photo</button>
        </div>
      </div>
      <div><label>Required Warehouse Arrival Date</label><input id="fDesiredEntry" type="date" value="${val(order.desiredEntryDate)}" /></div>
      <div><label>Required Manufacturer Delivery Date</label><input id="fManufDelivery" type="date" value="${val(order.manufacturerDeliveryDate)}" /></div>
      <div><label>Order Quantity</label><input id="fPurchaseQty" type="number" value="${val(order.mainComponent.purchaseQuantity)}" /></div>
      <div><label>Quantity received</label><input id="fFulfillQtyReceived" type="number" value="${val(order.fulfillment.quantityReceived)}" /></div>
      <div><label>Buyer</label><input id="fBuyer" type="text" value="${val(order.buyer)}" /></div>
      <div><label>Order placement date</label><input id="fOrderDate" type="date" value="${val(order.orderPlacementDate)}" /></div>
    </div>
    </div>

    <div id="fClothingOnly" class="om-panel-card" style="${order.productLine === 'clothing' ? '' : 'display:none;'}">
      <div class="om-section-title">Size Distribution</div>
      <table class="om-table om-table-editable" style="min-width:0;">
        <thead><tr><th>SKU</th><th>Size</th><th>Order Qty</th><th>Qty Received</th><th></th></tr></thead>
        <tbody id="omSizeRows"></tbody>
      </table>
      <button type="button" class="btn btn-secondary" id="omAddSizeRow" style="flex:none;width:auto;padding:8px 14px;margin-top:6px;">+ Add size row</button>
    </div>

    <div class="om-panel-card">
    <div class="om-section-title">Product Information</div>
    <div class="om-field-grid">
      <div><label>Fabric Code</label><input id="fFabricInfo" type="text" list="dlFabricCodes" value="${val(order.mainComponent.fabricInfo)}" /></div>
      <div><label>Fabric Type</label><input id="fComponent" type="text" list="dlFabricTypes" placeholder="e.g. 100% Cotton" value="${val(order.mainComponent.component)}" /></div>
      <div><label>Washing Label</label><input id="fWashLabel" type="text" list="dlWashLabels" value="${val(order.mainComponent.washLabel)}" /></div>
      <div><label>Manufacturing Drawing</label><input id="fManufacturingDrawing" type="text" list="dlManufacturingDrawings" value="${val(order.mainComponent.manufacturingDrawing)}" /></div>
      <div><label>Product Pricing</label><input type="text" value="${fmtMoney(computeOrderTotal(order))}" disabled /></div>
    </div>
    <datalist id="dlSupplierNames"></datalist>
    <datalist id="dlFabricCodes"></datalist>
    <datalist id="dlFabricTypes"></datalist>
    <datalist id="dlWashLabels"></datalist>
    <datalist id="dlManufacturingDrawings"></datalist>
    </div>

    <div class="om-panel-card">
    <div class="om-section-title">Main Component Specs</div>
    <div class="om-field-grid">
      <div><label>Model number</label><input id="fModelNumber" type="text" value="${val(order.mainComponent.modelNumber)}" /></div>
      <div><label>Dimensions (L*W*H cm)</label><input id="fDimensions" type="text" value="${val(order.mainComponent.dimensions)}" /></div>
      <div><label>Factory price</label><input id="fFactoryPrice" type="number" step="0.01" value="${val(order.mainComponent.factoryPrice)}" /></div>
      <div><label>Sales unit price</label><input id="fSalesUnitPrice" type="number" step="0.01" value="${val(order.mainComponent.salesUnitPrice)}" /></div>
      <div><label>Sales volume</label><input id="fSalesVolume" type="number" value="${val(order.mainComponent.salesVolume)}" /></div>
      <div><label>Total purchase price</label><input id="fTotalPurchasePrice" type="number" step="0.01" value="${val(order.mainComponent.totalPurchasePrice)}" /></div>
      <div><label>Actual weight (kg)</label><input id="fActualWeight" type="number" step="0.01" value="${val(order.mainComponent.actualWeight)}" /></div>
      <div><label>Transport weight (kg)</label><input id="fTransportWeight" type="number" step="0.01" value="${val(order.mainComponent.transportWeight)}" /></div>
    </div>
    <div class="om-field-grid" style="margin-top:10px;">
      <div style="grid-column:1/-1;"><label>Production precautions</label><input id="fProductionPrecautions" type="text" value="${val(order.mainComponent.productionPrecautions)}" /></div>
    </div>
    </div>

    <div id="omComponentBreakdownSection" class="om-panel-card" style="${scope === 'main-component' ? 'display:none;' : ''}">
      <div class="om-section-title">Component Breakdown</div>
      <div class="om-table-wrap">
        <table class="om-table om-table-editable">
          <thead>
            <tr>
              <th>Image</th><th>Part Name</th><th>Dimensions</th><th>Purchase Price</th><th># Parts</th>
              <th>Total Price</th><th>Supplier Name</th><th>Supplier Contact</th><th>Desired Delivery</th>
              <th>Delivery Address</th><th>Design Document</th><th>Status</th><th>Remark</th><th></th>
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
      <div><label>Warehouse Address</label><input id="fWarehouse" type="text" value="${val(order.mainComponent.warehouse)}" /></div>
      <div><label>Shipping cost</label><input id="fTransportationFees" type="number" step="0.01" value="${val(order.costs.transportationFees)}" /></div>
      <div><label>Packing List Number</label><input id="fFulfillPacking" type="text" value="${val(order.fulfillment.packingListNumber)}" /></div>
      <div><label>Waybill Number</label><input id="fFulfillWaybill" type="text" value="${val(order.fulfillment.waybillNumber)}" /></div>
    </div>
    </div>

    <div class="om-panel-card">
    <div class="om-section-title">Payment</div>
    <div class="om-field-grid">
      <div><label>Assembly fee</label><input id="fAssemblyFee" type="number" step="0.01" value="${val(order.costs.assemblyFee)}" /></div>
      <div><label>Labor costs</label><input id="fLaborCosts" type="number" step="0.01" value="${val(order.costs.laborCosts)}" /></div>
      <div><label>Other expenses</label><input id="fOtherExpenses" type="number" step="0.01" value="${val(order.costs.otherExpenses)}" /></div>
      <div><label>Total PO cost</label><input type="text" value="${fmtMoney(computeOrderTotal(order))}" disabled /></div>
    </div>
    <div class="om-detail-row" style="margin-top:8px;"><span class="om-label">Payment Status</span><span class="om-value">${escapeHtml(order.settlement.status)}</span></div>
    ${order.settlement.paidDate ? `<div class="om-detail-row"><span class="om-label">Paid on</span><span class="om-value">${fmtDate(order.settlement.paidDate)}</span></div>` : ''}
    <div class="om-settlement-toggle">
      <button class="btn btn-secondary" id="omMarkPending" style="flex:none;width:auto;padding:8px 14px;">Mark Pending</button>
      <button class="btn btn-primary" id="omMarkPaid" style="flex:none;width:auto;padding:8px 14px;">Mark Paid</button>
    </div>
    </div>

    <div class="om-panel-card">
    <div class="om-section-title">Files</div>
    <div id="omFilesList">
      ${order.files && order.files.length ? order.files.map((f) => `
        <div class="om-file-row" data-file-id="${escapeHtml(f.id)}">
          <a href="${escapeHtml(f.url)}" target="_blank" rel="noopener" class="om-file-link">
            <span class="om-file-category">${escapeHtml(f.category)}</span>
            ${escapeHtml(f.originalName)}
            ${f.relatedTo ? `<span class="om-file-related">for: ${escapeHtml(f.relatedTo)}</span>` : ''}
          </a>
          <button class="om-file-remove" data-remove-file="${escapeHtml(f.id)}" title="Remove">&times;</button>
        </div>
      `).join('') : '<div class="om-cl-meta">No files uploaded yet.</div>'}
    </div>
    <div class="om-file-upload-row">
      <select id="omFileCategory">
        ${FILE_CATEGORIES.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}
      </select>
      <input type="text" id="omFileRelatedTo" placeholder="Related part/accessory (optional)" style="flex:1 1 160px;padding:8px 10px;border-radius:var(--radius-sm);border:1.5px solid var(--jc-border);font-size:12.5px;" />
      <input type="file" id="omFileInput" />
      <button class="btn btn-secondary" id="omFileUploadBtn" style="flex:none;width:auto;padding:8px 14px;">Upload</button>
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

    <div style="margin-top:24px;padding-top:16px;border-top:1px solid var(--jc-border);display:flex;justify-content:flex-end;">
      <button class="btn btn-primary" id="omSaveOrder" style="flex:none;width:auto;padding:10px 24px;">Save changes</button>
    </div>
   </div>
  `;

  mountPanel(panel);
  bindPanelEscape();

  document.getElementById('omClosePanel').addEventListener('click', closePanel);
  const viewFullPoBtn = document.getElementById('omViewFullPo');
  if (viewFullPoBtn) viewFullPoBtn.addEventListener('click', () => { closePanel(); openDetailPanel(order.id, 'full'); });
  panel.querySelectorAll('.om-tracker-step').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/order-management/orders/${encodeURIComponent(order.id)}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: btn.dataset.status })
        });
        showToast('Status updated');
        closePanel();
        refreshCurrentView();
      } catch (e) { showToast(e.message, true); }
    });
  });
  document.getElementById('omMarkPaid').addEventListener('click', () => setSettlement(order.id, 'Paid'));
  document.getElementById('omMarkPending').addEventListener('click', () => setSettlement(order.id, 'Pending'));

  // ---- Files ----
  panel.querySelectorAll('[data-remove-file]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/order-management/orders/${encodeURIComponent(order.id)}/files/${encodeURIComponent(btn.dataset.removeFile)}`, {
          method: 'DELETE'
        });
        showToast('File removed');
        closePanel();
        openDetailPanel(order.id);
        refreshCurrentView();
      } catch (e) { showToast(e.message, true); }
    });
  });
  document.getElementById('omFileUploadBtn').addEventListener('click', async () => {
    const input = document.getElementById('omFileInput');
    const file = input.files[0];
    if (!file) return showToast('Choose a file first', true);
    const category = document.getElementById('omFileCategory').value;
    const relatedTo = document.getElementById('omFileRelatedTo').value;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('category', category);
    formData.append('relatedTo', relatedTo);
    try {
      const res = await fetch(`/api/order-management/orders/${encodeURIComponent(order.id)}/files`, {
        method: 'POST',
        body: formData
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Upload failed');
      }
      showToast('File uploaded');
      closePanel();
      openDetailPanel(order.id);
      refreshCurrentView();
    } catch (e) { showToast(e.message, true); }
  });

  document.getElementById('fPhotoReferenceUploadBtn').addEventListener('click', () => {
    document.getElementById('fPhotoReferenceFile').click();
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

  function addAccessoryRow(data) {
    accessoryRowsHost.insertAdjacentHTML('beforeend', accessoryRowHtml(editAccessoryRowCount, data));
    const idx = editAccessoryRowCount;
    const row = panel.querySelector(`[data-accessory-row="${idx}"]`);
    panel.querySelector(`[data-remove-accessory="${idx}"]`).addEventListener('click', () => { row.remove(); });
    wireAccessoryRowUploads(row);
    editAccessoryRowCount++;
  }
  (order.accessories && order.accessories.length ? order.accessories : [{}]).forEach(addAccessoryRow);
  panel.querySelector('#omAddAccessoryRow').addEventListener('click', () => addAccessoryRow());

  // ---- Order Status dropdown - saves immediately, same as clicking the tracker ----
  document.getElementById('fOrderStatusSelect').addEventListener('change', async (e) => {
    try {
      await api(`/api/order-management/orders/${encodeURIComponent(order.id)}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: e.target.value })
      });
      showToast('Status updated');
      closePanel();
      openDetailPanel(order.id);
      refreshCurrentView();
    } catch (err) { showToast(err.message, true); }
  });

  // ---- Reusable "dropdown with ability to add new" fields: populate
  // datalists from real Supplier records (for name -> code autofill) and
  // from values already used on other orders, so anything typed in becomes
  // a future suggestion without needing a separate managed list. ----
  (async () => {
    try {
      const [suppliersData, historyData] = await Promise.all([
        api('/api/suppliers'),
        api('/api/order-management/field-history')
      ]);
      const suppliers = suppliersData.suppliers || [];
      const fillList = (id, values) => {
        const dl = document.getElementById(id);
        if (dl) dl.innerHTML = values.map((v) => `<option value="${escapeHtml(v)}"></option>`).join('');
      };
      fillList('dlSupplierNames', suppliers.map((s) => s.name));
      fillList('dlFabricCodes', historyData.fabricCodes || []);
      fillList('dlFabricTypes', historyData.fabricTypes || []);
      fillList('dlWashLabels', historyData.washLabels || []);
      fillList('dlManufacturingDrawings', historyData.manufacturingDrawings || []);

      const supplierNameInput = document.getElementById('fSupplierName');
      const supplierCodeInput = document.getElementById('fSupplierCode');
      supplierNameInput.addEventListener('change', () => {
        const match = suppliers.find((s) => s.name.trim().toLowerCase() === supplierNameInput.value.trim().toLowerCase());
        if (match && match.vendorCode) supplierCodeInput.value = match.vendorCode;
      });
    } catch (e) { /* datalists are a convenience - fine to skip silently if this fails */ }
  })();

  // Master "Save changes": everything on the page except status (saves
  // immediately above) and payment status (its own Mark Paid/Pending toggle).
  document.getElementById('omSaveOrder').addEventListener('click', async () => {
    const productLine = order.productLine;
    const patch = {
      buyer: document.getElementById('fBuyer').value,
      orderPlacementDate: document.getElementById('fOrderDate').value || null,
      desiredEntryDate: document.getElementById('fDesiredEntry').value || null,
      manufacturerDeliveryDate: document.getElementById('fManufDelivery').value || null,
      supplier: {
        name: document.getElementById('fSupplierName').value,
        contact: order.supplier.contact,
        code: document.getElementById('fSupplierCode').value
      },
      mainComponent: {
        name: document.getElementById('fMainName').value,
        sku: document.getElementById('fMainSku').value,
        modelNumber: document.getElementById('fModelNumber').value,
        dimensions: document.getElementById('fDimensions').value,
        factoryPrice: document.getElementById('fFactoryPrice').value || null,
        salesUnitPrice: document.getElementById('fSalesUnitPrice').value || null,
        purchaseQuantity: document.getElementById('fPurchaseQty').value || null,
        salesVolume: document.getElementById('fSalesVolume').value || null,
        totalPurchasePrice: document.getElementById('fTotalPurchasePrice').value || null,
        actualWeight: document.getElementById('fActualWeight').value || null,
        transportWeight: document.getElementById('fTransportWeight').value || null,
        warehouse: document.getElementById('fWarehouse').value,
        productionPrecautions: document.getElementById('fProductionPrecautions').value,
        photoReference: document.getElementById('fPhotoReference').value,
        manufacturingDrawing: document.getElementById('fManufacturingDrawing').value,
        fabricInfo: document.getElementById('fFabricInfo').value,
        component: document.getElementById('fComponent').value,
        washLabel: document.getElementById('fWashLabel').value,
        sizeDistribution: productLine === 'clothing' ? Array.from(sizeRowsHost.querySelectorAll('[data-size-row]')).map((row) => ({
          sku: row.querySelector('.om-size-sku').value,
          size: row.querySelector('.om-size-size').value,
          quantity: row.querySelector('.om-size-qty').value || null,
          quantityReceived: row.querySelector('.om-size-qty-received').value || null
        })).filter((r) => r.sku || r.size || r.quantity || r.quantityReceived) : []
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

// ---- New order panel ----

let sizeRowCount = 0;
let accessoryRowCount = 0;

function sizeRowHtml(idx) {
  return `
    <div class="om-repeat-row" data-size-row="${idx}">
      <input type="text" placeholder="SKU name" class="om-size-sku" />
      <input type="text" placeholder="Size (e.g. Adult M)" class="om-size-size" />
      <input type="number" placeholder="Qty" class="om-size-qty" />
      <button type="button" class="om-row-remove" data-remove-size="${idx}">&times;</button>
    </div>
  `;
}

function replacementRowHtml(idx, data) {
  data = data || {};
  return `
    <div class="om-repeat-row" data-replacement-row="${idx}">
      <input type="text" placeholder="SKU name" class="om-repl-sku" value="${escapeHtml(data.sku || '')}" />
      <input type="text" placeholder="Size (e.g. Adult M)" class="om-repl-size" value="${escapeHtml(data.size || '')}" />
      <input type="number" placeholder="Replacement qty" class="om-repl-qty" value="${escapeHtml(data.quantity ?? '')}" />
      <button type="button" class="om-row-remove" data-remove-replacement="${idx}">&times;</button>
    </div>
  `;
}

function collectReplacementRows(container) {
  return Array.from(container.querySelectorAll('[data-replacement-row]')).map((row) => ({
    sku: row.querySelector('.om-repl-sku').value,
    size: row.querySelector('.om-repl-size').value,
    quantity: row.querySelector('.om-repl-qty').value || null
  })).filter((r) => r.sku || r.size || r.quantity);
}

function accessoryRowHtml(idx, data) {
  data = data || {};
  const rowId = data.id || `tmp-${Date.now()}-${idx}`;
  return `
    <tr data-accessory-row="${idx}" data-accessory-id="${escapeHtml(rowId)}">
      <td class="om-acc-image-cell">
        ${data.imageUrl ? `<img class="om-table-thumb" src="${escapeHtml(data.imageUrl)}" alt="" />` : ''}
        <input type="hidden" class="om-acc-image-url" value="${escapeHtml(data.imageUrl || '')}" />
        <input type="file" class="om-acc-image-file" accept="image/*" style="display:none;" />
        <button type="button" class="om-table-upload-btn om-acc-image-upload-btn">Upload</button>
      </td>
      <td><input type="text" class="om-acc-name" value="${escapeHtml(data.partName || '')}" /></td>
      <td><input type="text" class="om-acc-dims" value="${escapeHtml(data.dimensions || '')}" /></td>
      <td><input type="number" step="0.01" class="om-acc-unit-price" value="${escapeHtml(data.unitPrice ?? '')}" /></td>
      <td><input type="number" class="om-acc-qty" value="${escapeHtml(data.quantity ?? '')}" /></td>
      <td><input type="number" step="0.01" class="om-acc-total-price" value="${escapeHtml(data.totalPrice ?? '')}" /></td>
      <td><input type="text" class="om-acc-supplier" list="dlSupplierNames" value="${escapeHtml(data.supplierName || '')}" /></td>
      <td><input type="text" class="om-acc-supplier-contact" value="${escapeHtml(data.supplierContact || '')}" /></td>
      <td><input type="date" class="om-acc-expected-delivery" value="${escapeHtml(data.expectedDeliveryDate || '')}" /></td>
      <td><input type="text" class="om-acc-address" value="${escapeHtml(data.deliveryAddress || '')}" /></td>
      <td class="om-acc-doc-cell">
        ${data.designDocUrl ? `<a href="${escapeHtml(data.designDocUrl)}" target="_blank" rel="noopener" style="display:block;font-size:11.5px;margin-bottom:4px;">View file</a>` : ''}
        <input type="hidden" class="om-acc-doc-url" value="${escapeHtml(data.designDocUrl || '')}" />
        <input type="file" class="om-acc-doc-file" style="display:none;" />
        <button type="button" class="om-table-upload-btn om-acc-doc-upload-btn">Upload</button>
      </td>
      <td>
        <select class="om-acc-status">
          ${ACCESSORY_STATUSES.map((s) => `<option value="${escapeHtml(s)}" ${data.status === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
        </select>
      </td>
      <td><input type="text" class="om-acc-remark" value="${escapeHtml(data.remark || '')}" /></td>
      <td><button type="button" class="om-row-remove" data-remove-accessory="${idx}" title="Remove">&times;</button></td>
    </tr>
  `;
}

function val(v) { return v === null || v === undefined ? '' : escapeHtml(v); }

function openNewOrderPanel(existingOrder) {
  sizeRowCount = 0;
  accessoryRowCount = 0;
  const o = existingOrder || null;
  const mc = (o && o.mainComponent) || {};
  const sup = (o && o.supplier) || {};
  const isEdit = !!o;

  const panel = document.createElement('div');
  panel.className = 'om-panel';
  panel.innerHTML = `
   <div class="om-panel-inner">
    <div class="om-panel-header">
      <div style="font-size:19px;font-weight:700;">${isEdit ? `Edit Purchase Order — ${escapeHtml(o.poNumber)}` : 'New Purchase Order Request'}</div>
      <button class="om-panel-close" id="omClosePanel">&times;</button>
    </div>

    <div class="om-section-title">Order</div>
    <div class="om-field-grid">
      <div><label>Product line</label>
        <select id="fProductLine" ${isEdit ? 'disabled' : ''}>
          <option value="clothing" ${(o ? o.productLine : currentTab) === 'clothing' ? 'selected' : ''}>Apparel</option>
          <option value="toys" ${(o ? o.productLine : currentTab) === 'toys' ? 'selected' : ''}>Toys</option>
          <option value="other" ${(o ? o.productLine : currentTab) === 'other' ? 'selected' : ''}>Other</option>
        </select>
      </div>
      <div><label>PO number *</label><input id="fPoNumber" type="text" placeholder="e.g. JCRP01TSH1-PO1" value="${val(o && o.poNumber)}" ${isEdit ? 'disabled' : ''} /></div>
      <div><label>Buyer / Orderer</label><input id="fBuyer" type="text" value="${val(o && o.buyer)}" /></div>
      <div><label>Order date</label><input id="fOrderDate" type="date" value="${val(o && o.orderPlacementDate)}" /></div>
      <div><label>Desired entry date</label><input id="fDesiredEntry" type="date" value="${val(o && o.desiredEntryDate)}" /></div>
      <div><label>Manufacturer delivery date</label><input id="fManufDelivery" type="date" value="${val(o && o.manufacturerDeliveryDate)}" /></div>
    </div>

    <div class="om-section-title">Supplier</div>
    <div class="om-field-grid">
      <div><label>Supplier name</label><input id="fSupplierName" type="text" value="${val(sup.name)}" /></div>
      <div><label>Supplier contact</label><input id="fSupplierContact" type="text" value="${val(sup.contact)}" /></div>
      <div><label>Supplier code</label><input id="fSupplierCode" type="text" value="${val(sup.code)}" /></div>
    </div>

    <div class="om-section-title">Main component</div>
    <div class="om-field-grid">
      <div><label>Main component name</label><input id="fMainName" type="text" value="${val(mc.name)}" /></div>
      <div><label>Main SKU</label><input id="fMainSku" type="text" value="${val(mc.sku)}" /></div>
      <div><label>Model number</label><input id="fModelNumber" type="text" value="${val(mc.modelNumber)}" /></div>
      <div><label>Dimensions (L*W*H cm)</label><input id="fDimensions" type="text" value="${val(mc.dimensions)}" /></div>
      <div><label>Factory price</label><input id="fFactoryPrice" type="number" step="0.01" value="${val(mc.factoryPrice)}" /></div>
      <div><label>Sales unit price</label><input id="fSalesUnitPrice" type="number" step="0.01" value="${val(mc.salesUnitPrice)}" /></div>
      <div><label>Purchase quantity</label><input id="fPurchaseQty" type="number" value="${val(mc.purchaseQuantity)}" /></div>
      <div><label>Sales volume</label><input id="fSalesVolume" type="number" value="${val(mc.salesVolume)}" /></div>
      <div><label>Total purchase price</label><input id="fTotalPurchasePrice" type="number" step="0.01" value="${val(mc.totalPurchasePrice)}" /></div>
      <div><label>Actual weight (kg)</label><input id="fActualWeight" type="number" step="0.01" value="${val(mc.actualWeight)}" /></div>
      <div><label>Transport weight (kg)</label><input id="fTransportWeight" type="number" step="0.01" value="${val(mc.transportWeight)}" /></div>
      <div><label>Sent to warehouse</label><input id="fWarehouse" type="text" value="${val(mc.warehouse)}" /></div>
    </div>
    <div class="om-field-grid" style="margin-top:10px;">
      <div style="grid-column:1/-1;"><label>Production precautions</label><input id="fProductionPrecautions" type="text" value="${val(mc.productionPrecautions)}" /></div>
    </div>

    <div id="fClothingOnly" style="display:none;">
      <div class="om-section-title">Fabric (clothing only)</div>
      <div class="om-field-grid">
        <div><label>Fabric information</label><input id="fFabricInfo" type="text" value="${val(mc.fabricInfo)}" /></div>
        <div><label>Component / composition</label><input id="fComponent" type="text" value="${val(mc.component)}" /></div>
        <div><label>Wash label</label><input id="fWashLabel" type="text" value="${val(mc.washLabel)}" /></div>
      </div>

      <div class="om-section-title">Size distribution</div>
      <div id="omSizeRows"></div>
      <button type="button" class="btn btn-secondary" id="omAddSizeRow" style="flex:none;width:auto;padding:8px 14px;margin-top:6px;">+ Add size row</button>
    </div>

    <div class="om-section-title">Accessories / parts</div>
    <div id="omAccessoryRows"></div>
    <button type="button" class="btn btn-secondary" id="omAddAccessoryRow" style="flex:none;width:auto;padding:8px 14px;margin-top:6px;">+ Add accessory / part</button>

    <div class="om-section-title">Costs</div>
    <div class="om-field-grid">
      <div><label>Assembly fee</label><input id="fAssemblyFee" type="number" step="0.01" value="${val(o && o.costs && o.costs.assemblyFee)}" /></div>
      <div><label>Labor costs</label><input id="fLaborCosts" type="number" step="0.01" value="${val(o && o.costs && o.costs.laborCosts)}" /></div>
      <div><label>Transportation fees</label><input id="fTransportationFees" type="number" step="0.01" value="${val(o && o.costs && o.costs.transportationFees)}" /></div>
      <div><label>Other expenses</label><input id="fOtherExpenses" type="number" step="0.01" value="${val(o && o.costs && o.costs.otherExpenses)}" /></div>
    </div>

    <div style="margin-top:22px;display:flex;gap:10px;flex-wrap:wrap;">
      <button class="btn btn-secondary" id="omCancelNew" style="flex:none;width:auto;padding:10px 18px;">Cancel</button>
      ${isEdit ? `
        <button class="btn btn-secondary" id="omSaveDraft" style="flex:none;width:auto;padding:10px 18px;">Save &amp; complete later</button>
        ${o.status === 'New Request' ? `<button class="btn btn-primary" id="omSubmitManufacturing" style="flex:none;width:auto;padding:10px 18px;">Submit for manufacturing</button>` : ''}
      ` : `
        <button class="btn btn-primary" id="omSubmitNew" style="flex:none;width:auto;padding:10px 18px;">Create request</button>
      `}
    </div>
   </div>
  `;
  mountPanel(panel);
  bindPanelEscape();

  document.getElementById('omClosePanel').addEventListener('click', closePanel);
  document.getElementById('omCancelNew').addEventListener('click', closePanel);
  if (isEdit) {
    document.getElementById('omSaveDraft').addEventListener('click', () => submitOrderForm(o, false));
    const submitBtn = document.getElementById('omSubmitManufacturing');
    if (submitBtn) submitBtn.addEventListener('click', () => submitOrderForm(o, true));
  } else {
    document.getElementById('omSubmitNew').addEventListener('click', () => submitOrderForm(null, false));
  }

  const productLineSelect = document.getElementById('fProductLine');
  const toggleClothing = () => {
    document.getElementById('fClothingOnly').style.display = productLineSelect.value === 'clothing' ? 'block' : 'none';
  };
  productLineSelect.addEventListener('change', toggleClothing);
  toggleClothing();

  document.getElementById('omAddSizeRow').addEventListener('click', () => {
    document.getElementById('omSizeRows').insertAdjacentHTML('beforeend', sizeRowHtml(sizeRowCount));
    bindRemove(`[data-remove-size="${sizeRowCount}"]`, `[data-size-row="${sizeRowCount}"]`);
    sizeRowCount++;
  });
  document.getElementById('omAddAccessoryRow').addEventListener('click', () => {
    document.getElementById('omAccessoryRows').insertAdjacentHTML('beforeend', accessoryRowHtml(accessoryRowCount));
    bindRemove(`[data-remove-accessory="${accessoryRowCount}"]`, `[data-accessory-row="${accessoryRowCount}"]`);
    accessoryRowCount++;
  });

  // Pre-fill existing rows when editing; otherwise start with one blank
  // accessory row so the form doesn't look empty/broken.
  if (isEdit && mc.sizeDistribution && mc.sizeDistribution.length) {
    mc.sizeDistribution.forEach((row) => {
      document.getElementById('omSizeRows').insertAdjacentHTML('beforeend',
        `<div class="om-repeat-row" data-size-row="${sizeRowCount}">
          <input type="text" placeholder="SKU name" class="om-size-sku" value="${val(row.sku)}" />
          <input type="text" placeholder="Size" class="om-size-size" value="${val(row.size)}" />
          <input type="number" placeholder="Qty" class="om-size-qty" value="${val(row.quantity)}" />
          <button type="button" class="om-row-remove" data-remove-size="${sizeRowCount}">&times;</button>
        </div>`);
      bindRemove(`[data-remove-size="${sizeRowCount}"]`, `[data-size-row="${sizeRowCount}"]`);
      sizeRowCount++;
    });
  }
  if (isEdit && o.accessories && o.accessories.length) {
    o.accessories.forEach((a) => {
      document.getElementById('omAccessoryRows').insertAdjacentHTML('beforeend', accessoryRowHtml(accessoryRowCount, a));
      bindRemove(`[data-remove-accessory="${accessoryRowCount}"]`, `[data-accessory-row="${accessoryRowCount}"]`);
      accessoryRowCount++;
    });
  } else {
    document.getElementById('omAddAccessoryRow').click();
  }
}

function bindRemove(btnSelector, rowSelector) {
  const btn = document.querySelector(btnSelector);
  if (!btn) return;
  btn.addEventListener('click', () => {
    const row = document.querySelector(rowSelector);
    if (row) row.remove();
  });
}

function collectSizeRows() {
  return Array.from(document.querySelectorAll('[data-size-row]')).map((row) => ({
    sku: row.querySelector('.om-size-sku').value,
    size: row.querySelector('.om-size-size').value,
    quantity: row.querySelector('.om-size-qty').value || null
  })).filter((r) => r.sku || r.size || r.quantity);
}

function collectAccessoryRows(container) {
  const scope = container || document;
  return Array.from(scope.querySelectorAll('[data-accessory-row]')).map((row) => ({
    id: row.dataset.accessoryId || undefined,
    partName: row.querySelector('.om-acc-name').value,
    dimensions: row.querySelector('.om-acc-dims').value,
    quantity: row.querySelector('.om-acc-qty').value || null,
    unitPrice: row.querySelector('.om-acc-unit-price').value || null,
    totalPrice: row.querySelector('.om-acc-total-price').value || null,
    expectedDeliveryDate: row.querySelector('.om-acc-expected-delivery').value || null,
    supplierName: row.querySelector('.om-acc-supplier').value,
    supplierContact: row.querySelector('.om-acc-supplier-contact').value,
    deliveryAddress: row.querySelector('.om-acc-address').value,
    status: row.querySelector('.om-acc-status').value,
    remark: row.querySelector('.om-acc-remark').value,
    imageUrl: row.querySelector('.om-acc-image-url').value,
    designDocUrl: row.querySelector('.om-acc-doc-url').value
  })).filter((a) => a.partName || a.supplierName);
}

async function submitOrderForm(existingOrder, submitForManufacturing) {
  const productLine = document.getElementById('fProductLine').value;
  const fields = {
    buyer: document.getElementById('fBuyer').value,
    orderPlacementDate: document.getElementById('fOrderDate').value || null,
    desiredEntryDate: document.getElementById('fDesiredEntry').value || null,
    manufacturerDeliveryDate: document.getElementById('fManufDelivery').value || null,
    supplier: {
      name: document.getElementById('fSupplierName').value,
      contact: document.getElementById('fSupplierContact').value,
      code: document.getElementById('fSupplierCode').value
    },
    mainComponent: {
      name: document.getElementById('fMainName').value,
      sku: document.getElementById('fMainSku').value,
      modelNumber: document.getElementById('fModelNumber').value,
      dimensions: document.getElementById('fDimensions').value,
      factoryPrice: document.getElementById('fFactoryPrice').value || null,
      salesUnitPrice: document.getElementById('fSalesUnitPrice').value || null,
      purchaseQuantity: document.getElementById('fPurchaseQty').value || null,
      salesVolume: document.getElementById('fSalesVolume').value || null,
      totalPurchasePrice: document.getElementById('fTotalPurchasePrice').value || null,
      actualWeight: document.getElementById('fActualWeight').value || null,
      transportWeight: document.getElementById('fTransportWeight').value || null,
      warehouse: document.getElementById('fWarehouse').value,
      productionPrecautions: document.getElementById('fProductionPrecautions').value,
      fabricInfo: productLine === 'clothing' ? document.getElementById('fFabricInfo').value : '',
      component: productLine === 'clothing' ? document.getElementById('fComponent').value : '',
      washLabel: productLine === 'clothing' ? document.getElementById('fWashLabel').value : '',
      sizeDistribution: productLine === 'clothing' ? collectSizeRows() : []
    },
    accessories: collectAccessoryRows(),
    costs: {
      assemblyFee: document.getElementById('fAssemblyFee').value || 0,
      laborCosts: document.getElementById('fLaborCosts').value || 0,
      transportationFees: document.getElementById('fTransportationFees').value || 0,
      otherExpenses: document.getElementById('fOtherExpenses').value || 0
    }
  };

  try {
    if (existingOrder) {
      await api(`/api/order-management/orders/${encodeURIComponent(existingOrder.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ patch: fields, actor: 'Web user' })
      });
      if (submitForManufacturing) {
        await api(`/api/order-management/orders/${encodeURIComponent(existingOrder.id)}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: 'Order Placed' })
        });
      }
      showToast(submitForManufacturing ? 'Submitted for manufacturing' : 'Saved — you can finish this later');
      closePanel();
      openDetailPanel(existingOrder.id);
      refreshCurrentView();
    } else {
      const poNumber = document.getElementById('fPoNumber').value.trim();
      if (!poNumber) return showToast('PO number is required', true);
      const payload = { poNumber, productLine, status: 'New Request', ...fields };
      await api('/api/order-management/orders', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Purchase order request created');
      closePanel();
      currentTab = productLine;
      currentView = 'category';
      currentCategorySubTab = 'orders';
      render();
      loadOrders();
    }
  } catch (e) { showToast(e.message, true); }
}

(async function init() {
  try {
    const params = new URLSearchParams(location.search);
    const view = params.get('view');
    if (view === 'suppliers' || view === 'settlement' || view === 'products' || view === 'components') currentView = view;
    await Promise.all([loadStatuses(), loadAccessoryStatuses(), loadFileCategories()]);
    render();
  } catch (e) {
    showToast(e.message, true);
  }
})();
