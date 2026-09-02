/* Order Management Hub - list + detail view for Purchase Orders, rebuilding
 * the QingFlow "Order Management" workspace as a section of this app.
 * See /order-management-workflow-spec.md for the logic this is based on.
 */

let STATUSES = [];
let currentTab = 'toys'; // 'toys' | 'clothing'
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

async function loadOrders() {
  const params = new URLSearchParams({ productLine: currentTab });
  if (currentStatusFilter) params.set('status', currentStatusFilter);
  if (currentSearch) params.set('search', currentSearch);
  const data = await api(`/api/order-management/orders?${params.toString()}`);
  currentOrders = data.orders || [];
  renderTable();
}

function render() {
  const root = document.getElementById('omRoot');
  root.innerHTML = `
    <div class="om-toolbar">
      <div class="om-tabs">
        <button class="om-tab ${currentTab === 'toys' ? 'active' : ''}" data-tab="toys">Toys</button>
        <button class="om-tab ${currentTab === 'clothing' ? 'active' : ''}" data-tab="clothing">Clothing</button>
      </div>
      <input class="om-search" id="omSearch" type="text" placeholder="Search PO number, supplier, SKU..." value="${escapeHtml(currentSearch)}" />
      <select class="om-status-filter" id="omStatusFilter">
        <option value="">All statuses</option>
        ${STATUSES.map((s) => `<option value="${escapeHtml(s)}" ${s === currentStatusFilter ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
      </select>
    </div>
    <div class="om-table-wrap"><div id="omTableHost"></div></div>
    <button class="btn btn-primary om-fab" id="omNewBtn" style="width:auto;padding:12px 20px;border-radius:999px;">+ New Purchase Order Request</button>
  `;

  document.querySelectorAll('.om-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentTab = btn.dataset.tab;
      loadOrders().catch((e) => showToast(e.message, true));
      render();
    });
  });
  document.getElementById('omSearch').addEventListener('input', debounce((e) => {
    currentSearch = e.target.value;
    loadOrders().catch((err) => showToast(err.message, true));
  }, 300));
  document.getElementById('omStatusFilter').addEventListener('change', (e) => {
    currentStatusFilter = e.target.value;
    loadOrders().catch((err) => showToast(err.message, true));
  });
  document.getElementById('omNewBtn').addEventListener('click', openNewOrderPanel);

  renderTable();
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function renderTable() {
  const host = document.getElementById('omTableHost');
  if (!host) return;
  if (!currentOrders.length) {
    host.innerHTML = `<div class="om-empty">No orders yet for ${currentTab}. Click "New Purchase Order Request" to add one.</div>`;
    return;
  }
  host.innerHTML = `
    <table class="om-table">
      <thead>
        <tr>
          <th>PO Number</th><th>Status</th><th>Main Component</th><th>Supplier</th>
          <th>Buyer</th><th>Desired Entry</th><th>Settlement</th>
        </tr>
      </thead>
      <tbody>
        ${currentOrders.map((o) => `
          <tr data-id="${escapeHtml(o.id)}">
            <td><strong>${escapeHtml(o.poNumber)}</strong></td>
            <td><span class="om-pill om-pill-${statusSlug(o.status)}">${escapeHtml(o.status)}</span></td>
            <td>${escapeHtml(o.mainComponent && o.mainComponent.name || '—')}</td>
            <td>${escapeHtml(o.supplier && o.supplier.name || '—')}</td>
            <td>${escapeHtml(o.buyer || '—')}</td>
            <td>${fmtDate(o.desiredEntryDate)}</td>
            <td>${escapeHtml(o.settlement && o.settlement.status || 'Pending')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  host.querySelectorAll('tbody tr').forEach((tr) => {
    tr.addEventListener('click', () => openDetailPanel(tr.dataset.id));
  });
}

// ---- Detail panel ----

function closePanel() {
  document.querySelectorAll('.om-overlay, .om-panel').forEach((el) => el.remove());
}

async function openDetailPanel(id) {
  let order;
  try {
    const data = await api(`/api/order-management/orders/${encodeURIComponent(id)}`);
    order = data.order;
  } catch (e) {
    return showToast(e.message, true);
  }

  const overlay = document.createElement('div');
  overlay.className = 'om-overlay';
  overlay.addEventListener('click', closePanel);

  const panel = document.createElement('div');
  panel.className = 'om-panel';
  panel.innerHTML = `
    <div class="om-panel-header">
      <div>
        <div style="font-size:19px;font-weight:700;">${escapeHtml(order.poNumber)}</div>
        <div style="color:var(--jc-muted);font-size:13px;">${escapeHtml(order.mainComponent && order.mainComponent.name || '')}</div>
      </div>
      <button class="om-panel-close" id="omClosePanel">&times;</button>
    </div>

    <div class="om-section-title">Status</div>
    <div class="om-status-stepper" id="omStatusStepper">
      ${STATUSES.map((s) => `<button class="om-status-step ${s === order.status ? 'current' : ''}" data-status="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}
    </div>

    <div class="om-section-title">Order details</div>
    <div class="om-detail-row"><span class="om-label">Buyer</span><span class="om-value">${escapeHtml(order.buyer || '—')}</span></div>
    <div class="om-detail-row"><span class="om-label">Order placement date</span><span class="om-value">${fmtDate(order.orderPlacementDate)}</span></div>
    <div class="om-detail-row"><span class="om-label">Desired entry date</span><span class="om-value">${fmtDate(order.desiredEntryDate)}</span></div>
    <div class="om-detail-row"><span class="om-label">Manufacturer delivery date</span><span class="om-value">${fmtDate(order.manufacturerDeliveryDate)}</span></div>

    <div class="om-section-title">Supplier</div>
    <div class="om-detail-row"><span class="om-label">Name</span><span class="om-value">${escapeHtml(order.supplier.name || '—')}</span></div>
    <div class="om-detail-row"><span class="om-label">Contact</span><span class="om-value">${escapeHtml(order.supplier.contact || '—')}</span></div>
    <div class="om-detail-row"><span class="om-label">Code</span><span class="om-value">${escapeHtml(order.supplier.code || '—')}</span></div>

    <div class="om-section-title">Main component</div>
    <div class="om-detail-row"><span class="om-label">SKU</span><span class="om-value">${escapeHtml(order.mainComponent.sku || '—')}</span></div>
    <div class="om-detail-row"><span class="om-label">Model number</span><span class="om-value">${escapeHtml(order.mainComponent.modelNumber || '—')}</span></div>
    <div class="om-detail-row"><span class="om-label">Factory price</span><span class="om-value">${fmtMoney(order.mainComponent.factoryPrice)}</span></div>
    <div class="om-detail-row"><span class="om-label">Sales unit price</span><span class="om-value">${fmtMoney(order.mainComponent.salesUnitPrice)}</span></div>
    <div class="om-detail-row"><span class="om-label">Sales volume</span><span class="om-value">${escapeHtml(order.mainComponent.salesVolume ?? '—')}</span></div>
    <div class="om-detail-row"><span class="om-label">Dimensions</span><span class="om-value">${escapeHtml(order.mainComponent.dimensions || '—')}</span></div>

    ${order.accessories && order.accessories.length ? `
      <div class="om-section-title">Accessories / parts (${order.accessories.length})</div>
      ${order.accessories.map((a) => `
        <div class="om-accessory-row">
          <strong>${escapeHtml(a.partName || 'Unnamed part')}</strong><br/>
          Qty: ${escapeHtml(a.quantity ?? '—')} &middot; Unit price: ${fmtMoney(a.unitPrice)} &middot; Total: ${fmtMoney(a.totalPrice)}<br/>
          Supplier: ${escapeHtml(a.supplierName || '—')}
        </div>
      `).join('')}
    ` : ''}

    <div class="om-section-title">Costs</div>
    <div class="om-detail-row"><span class="om-label">Assembly fee</span><span class="om-value">${fmtMoney(order.costs.assemblyFee)}</span></div>
    <div class="om-detail-row"><span class="om-label">Labor costs</span><span class="om-value">${fmtMoney(order.costs.laborCosts)}</span></div>
    <div class="om-detail-row"><span class="om-label">Transportation fees</span><span class="om-value">${fmtMoney(order.costs.transportationFees)}</span></div>
    <div class="om-detail-row"><span class="om-label">Other expenses</span><span class="om-value">${fmtMoney(order.costs.otherExpenses)}</span></div>

    <div class="om-section-title">Settlement</div>
    <div class="om-detail-row"><span class="om-label">Status</span><span class="om-value">${escapeHtml(order.settlement.status)}</span></div>
    ${order.settlement.paidDate ? `<div class="om-detail-row"><span class="om-label">Paid on</span><span class="om-value">${fmtDate(order.settlement.paidDate)}</span></div>` : ''}
    <div class="om-settlement-toggle">
      <button class="btn btn-secondary" id="omMarkPending" style="width:auto;padding:8px 14px;">Mark Pending</button>
      <button class="btn btn-primary" id="omMarkPaid" style="width:auto;padding:8px 14px;">Mark Paid</button>
    </div>

    <div class="om-section-title">Change log</div>
    <ul class="om-changelog">
      ${(order.changeLog || []).map((c) => `
        <li>
          <strong>${escapeHtml(c.action)}</strong>${c.details ? ' — ' + escapeHtml(c.details) : ''}
          <div class="om-cl-meta">${escapeHtml(c.actor || 'Unknown')} · ${new Date(c.timestamp).toLocaleString()}</div>
        </li>
      `).join('') || '<li class="om-cl-meta">No changes logged yet.</li>'}
    </ul>
  `;

  document.body.appendChild(overlay);
  document.body.appendChild(panel);

  document.getElementById('omClosePanel').addEventListener('click', closePanel);
  panel.querySelectorAll('.om-status-step').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/order-management/orders/${encodeURIComponent(order.id)}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: btn.dataset.status })
        });
        showToast('Status updated');
        closePanel();
        loadOrders();
      } catch (e) { showToast(e.message, true); }
    });
  });
  document.getElementById('omMarkPaid').addEventListener('click', () => setSettlement(order.id, 'Paid'));
  document.getElementById('omMarkPending').addEventListener('click', () => setSettlement(order.id, 'Pending'));
}

async function setSettlement(id, status) {
  try {
    await api(`/api/order-management/orders/${encodeURIComponent(id)}/settlement`, {
      method: 'POST',
      body: JSON.stringify({ status })
    });
    showToast('Settlement updated');
    closePanel();
    loadOrders();
  } catch (e) { showToast(e.message, true); }
}

// ---- New order panel ----

function openNewOrderPanel() {
  const overlay = document.createElement('div');
  overlay.className = 'om-overlay';
  overlay.addEventListener('click', closePanel);

  const panel = document.createElement('div');
  panel.className = 'om-panel';
  panel.innerHTML = `
    <div class="om-panel-header">
      <div style="font-size:19px;font-weight:700;">New Purchase Order Request</div>
      <button class="om-panel-close" id="omClosePanel">&times;</button>
    </div>
    <div class="om-field-grid">
      <div><label>Product line</label>
        <select id="fProductLine">
          <option value="toys" ${currentTab === 'toys' ? 'selected' : ''}>Toys</option>
          <option value="clothing" ${currentTab === 'clothing' ? 'selected' : ''}>Clothing</option>
        </select>
      </div>
      <div><label>PO number *</label><input id="fPoNumber" type="text" placeholder="e.g. JCRP01TSH1-PO1" /></div>
      <div><label>Buyer</label><input id="fBuyer" type="text" /></div>
      <div><label>Desired entry date</label><input id="fDesiredEntry" type="date" /></div>
      <div><label>Manufacturer delivery date</label><input id="fManufDelivery" type="date" /></div>
      <div><label>Supplier name</label><input id="fSupplierName" type="text" /></div>
      <div><label>Supplier contact</label><input id="fSupplierContact" type="text" /></div>
      <div><label>Supplier code</label><input id="fSupplierCode" type="text" /></div>
      <div><label>Main component name</label><input id="fMainName" type="text" /></div>
      <div><label>Main SKU</label><input id="fMainSku" type="text" /></div>
      <div><label>Factory price</label><input id="fFactoryPrice" type="number" step="0.01" /></div>
      <div><label>Sales volume</label><input id="fSalesVolume" type="number" /></div>
    </div>
    <div style="margin-top:20px;display:flex;gap:10px;">
      <button class="btn btn-secondary" id="omCancelNew" style="width:auto;padding:10px 18px;">Cancel</button>
      <button class="btn btn-primary" id="omSubmitNew" style="width:auto;padding:10px 18px;">Create request</button>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.appendChild(panel);
  document.getElementById('omClosePanel').addEventListener('click', closePanel);
  document.getElementById('omCancelNew').addEventListener('click', closePanel);
  document.getElementById('omSubmitNew').addEventListener('click', submitNewOrder);
}

async function submitNewOrder() {
  const poNumber = document.getElementById('fPoNumber').value.trim();
  if (!poNumber) return showToast('PO number is required', true);
  const payload = {
    poNumber,
    productLine: document.getElementById('fProductLine').value,
    status: 'New request',
    buyer: document.getElementById('fBuyer').value,
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
      factoryPrice: document.getElementById('fFactoryPrice').value || null,
      salesVolume: document.getElementById('fSalesVolume').value || null
    }
  };
  try {
    await api('/api/order-management/orders', { method: 'POST', body: JSON.stringify(payload) });
    showToast('Purchase order request created');
    closePanel();
    currentTab = payload.productLine;
    render();
    loadOrders();
  } catch (e) { showToast(e.message, true); }
}

(async function init() {
  try {
    await loadStatuses();
    render();
    await loadOrders();
  } catch (e) {
    showToast(e.message, true);
  }
})();
