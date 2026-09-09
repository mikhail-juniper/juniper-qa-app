/**
 * Supplier Order Management page.
 *
 * Purpose-built rather than a filtered version of the internal page: a
 * supplier needs one flat list of the POs they're making and a small,
 * read-only slice of each one. No categories, no sub-component breakdown,
 * no costs beyond their own, no QA internals.
 *
 * The server already scopes /api/order-management/orders to the signed-in
 * supplier, so this page never has to filter by supplier itself - it just
 * renders what it's given. That means a bug here can't leak another
 * supplier's PO.
 *
 * There is no sidebar on this page by design; suppliers have exactly one
 * place to be.
 */

const i18 = (k, f) => (window.JuniperI18n ? window.JuniperI18n.t(k, f) : escapeHtml(f || k));
const i18t = (k, f) => (window.JuniperI18n ? window.JuniperI18n.tText(k, f) : (f || k));

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

function fmtDate(d) {
  if (!d) return '—';
  const date = new Date(d);
  return isNaN(date) ? '—' : date.toLocaleDateString();
}

function statusSlug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function isPdfFile(nameOrUrl) {
  return /\.pdf(\?|#|$)/i.test(String(nameOrUrl || ''));
}

let allOrders = [];
// Set when a Juniper user is previewing a supplier's view. Everything the
// page fetches is scoped as that supplier, but the visitor keeps their own
// session and permissions.
const previewSupplier = new URLSearchParams(location.search).get('preview') || '';
const scopeParam = previewSupplier ? `?asSupplier=${encodeURIComponent(previewSupplier)}` : '';

async function render() {
  const root = document.getElementById('supRoot');
  root.innerHTML = `
    ${previewSupplier ? `
      <div class="section-help" style="margin-bottom:14px;padding:10px 14px;background:#fff6e5;border-radius:8px;color:#9a6700;">
        <strong>Preview</strong> - this is what ${escapeHtml(previewSupplier)} sees. You're still signed in as yourself.
        <a href="/order-management.html" style="margin-left:8px;">Back to Order Management</a>
      </div>` : ''}
    <h2 class="om-view-title">${i18('supYourPos', 'Your Purchase Orders')}</h2>
    <div class="om-tile-toolbar om-filter-toolbar" style="margin-bottom:16px;">
      <select class="om-filter-select" id="supSku">
        <option value="">${escapeHtml(i18t('filterAllSkus', 'All SKUs'))}</option>
      </select>
      <select class="om-filter-select" id="supStatus">
        <option value="">${escapeHtml(i18t('filterAllStatuses', 'All statuses'))}</option>
      </select>
      <input class="om-search om-filter-search" id="supSearch" type="text" autocomplete="off"
        placeholder="${escapeHtml(i18t('supSearchPlaceholder', 'Search PO number, product, SKU...'))}" />
    </div>
    <div id="supListHost"><div class="om-empty">${i18('emptyLoading', 'Loading...')}</div></div>
  `;
  try {
    const me = await api('/api/me');
    const sub = document.getElementById('supplierBrandSub');
    const label = previewSupplier || (me.user && me.user.supplierName);
    if (sub && label) sub.textContent = label;

    const data = await api(`/api/order-management/orders${scopeParam}`);
    allOrders = data.orders || [];
    // Filter options come from this supplier's own orders, so a dropdown
    // never offers a value that returns nothing.
    const fill = (id, values) => {
      const el = document.getElementById(id);
      const first = el.querySelector('option').outerHTML;
      const list = [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
      el.innerHTML = first + list.map((v) =>
        `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    };
    fill('supSku', allOrders.map((o) => o.mainComponent && o.mainComponent.sku));
    fill('supStatus', allOrders.map((o) => o.status));

    drawList();
    let timer = null;
    document.getElementById('supSearch').addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(drawList, 120);
    });
    ['supSku', 'supStatus'].forEach((id) => {
      document.getElementById(id).addEventListener('change', drawList);
    });
  } catch (e) {
    document.getElementById('supListHost').innerHTML =
      `<div class="om-empty">${escapeHtml(e.message)}</div>`;
  }
}

/** A thumbnail, or a link when the file is a PDF, or a dash. */
function thumb(url, alt) {
  if (!url) return '<span style="color:var(--jc-muted);">—</span>';
  if (isPdfFile(url)) {
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="font-size:11.5px;">${i18('btnViewFile', 'View')}</a>`;
  }
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">` +
    `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt || '')}" class="sup-thumb" /></a>`;
}

/**
 * One PO row. Mirrors the columns the factory is used to seeing in the
 * shared KingDocs sheet, so the move over doesn't change how they read it.
 *
 * Three cells are editable by the factory - the two sample dates and bulk
 * progress. They save on change through the narrow supplier endpoint; the
 * rest of the row is ours and read-only.
 */
function rowHtml(o) {
  const mc = o.mainComponent || {};
  const f = o.factoryUpdates || {};
  const dash = '<span style="color:var(--jc-muted);">—</span>';
  const comps = (o.componentPhotos || []).filter((c) => c.partName || c.imageUrl);
  return `
    <tr data-id="${escapeHtml(o.id)}">
      <td>${thumb(mc.photoReference, mc.name)}</td>
      <td><strong>${escapeHtml(mc.name || '—')}</strong></td>
      <td>${escapeHtml(mc.sku || '—')}</td>
      <td><strong>${escapeHtml(o.poNumber || '—')}</strong></td>
      <td><span class="om-pill om-pill-${statusSlug(o.status)}">${escapeHtml(o.status || '—')}</span></td>
      <td>${mc.purchaseQuantity ?? '—'}</td>
      <td>${fmtDate(o.orderDate)}</td>
      <td>${fmtDate(o.manufacturerDeliveryDate)}</td>
      <td>${o.inTransportationAt ? fmtDate(o.inTransportationAt) : dash}</td>
      <td><input type="date" class="sup-edit" data-field="preProductionSampleDate"
        data-order="${escapeHtml(o.id)}" value="${escapeHtml((f.preProductionSampleDate || '').slice(0, 10))}" /></td>
      <td><input type="date" class="sup-edit" data-field="bulkSampleDate"
        data-order="${escapeHtml(o.id)}" value="${escapeHtml((f.bulkSampleDate || '').slice(0, 10))}" /></td>
      <td class="sup-notes">${o.productionNotes ? escapeHtml(o.productionNotes) : dash}</td>
      <td><input type="text" class="sup-edit" data-field="bulkShipmentProgress"
        data-order="${escapeHtml(o.id)}" value="${escapeHtml(f.bulkShipmentProgress || '')}" style="min-width:150px;" /></td>
      <td>${escapeHtml(o.warehouseAddress || '—')}</td>
      <td>${comps.length ? `<div class="sup-comps">${comps.map((c) => `
        <span class="sup-comp">${c.imageUrl ? thumb(c.imageUrl, c.partName) : ''}
        <span class="sup-comp-name">${escapeHtml(c.partName)}</span></span>`).join('')}</div>` : dash}</td>
      <td>${thumb(mc.washingTagUrl, 'Washing tag')}</td>
      <td>${escapeHtml(o.packingListNumber || '—')}</td>
    </tr>
  `;
}

function drawList() {
  const host = document.getElementById('supListHost');
  const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
  const q = String(val('supSearch')).trim().toLowerCase();
  const sku = val('supSku');
  const status = val('supStatus');
  const filtering = !!(q || sku || status);

  const shown = allOrders.filter((o) => {
    const mc = o.mainComponent || {};
    if (sku && mc.sku !== sku) return false;
    if (status && o.status !== status) return false;
    if (!q) return true;
    return [o.poNumber, mc.name, mc.sku]
      .some((v) => v && String(v).toLowerCase().includes(q));
  });
  if (!shown.length) {
    // Distinguish "you have no orders" from "your filters excluded them all".
    host.innerHTML = `<div class="om-empty">${filtering
      ? i18('supNoMatches', 'No purchase orders match those filters.')
      : i18('supNoOrders', 'No purchase orders yet.')}</div>`;
    return;
  }

  host.innerHTML = `
    <div class="om-category-tile">
      <div class="om-table-wrap">
        <table class="om-table sup-table">
          <thead><tr>
            <th>${i18('supPhoto', 'Photo')}</th>
            <th>${i18('fldProductName', 'Product Name')}</th>
            <th>${i18('fldSku', 'SKU')}</th>
            <th>${i18('thPoNumber', 'PO Number')}</th>
            <th>${i18('thStatus', 'Status')}</th>
            <th>${i18('supQuantity', 'Quantity')}</th>
            <th>${i18('supOrderDate', 'Order Date')}</th>
            <th>${i18('fldRequiredManufacturerDelivery', 'Required Manufacturer Delivery Date')}</th>
            <th>${i18('supActualShipDate', 'Actual Ship Date')}</th>
            <th>${i18('supPreProdSample', 'Pre-Production Sample')}</th>
            <th>${i18('supBulkSample', 'Bulk Sample')}</th>
            <th>${i18('fldProductionNotes', 'Production Notes')}</th>
            <th>${i18('supBulkProgress', 'Bulk Shipment Progress')}</th>
            <th>${i18('fldWarehouseAddress', 'Warehouse Address')}</th>
            <th>${i18('supComponents', 'Components')}</th>
            <th>${i18('supWashingTag', 'Washing Tag')}</th>
            <th>${i18('supPackingList', 'Packing List Number')}</th>
          </tr></thead>
          <tbody>
            ${shown.map((o) => rowHtml(o)).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
  host.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      // Editing a cell shouldn't also open the detail panel over the top.
      if (e.target.closest('.sup-edit') || e.target.closest('a')) return;
      openSupplierOrder(tr.dataset.id);
    });
  });

  // The factory's own fields save as soon as they're changed - no separate
  // save button, since a factory updating a date shouldn't have to hunt for
  // one. Only these three keys are accepted by the server.
  host.querySelectorAll('.sup-edit').forEach((el) => {
    el.addEventListener('change', async () => {
      const body = {};
      body[el.dataset.field] = el.value;
      el.disabled = true;
      try {
        const res = await api(`/api/supplier/orders/${encodeURIComponent(el.dataset.order)}/factory-updates`, {
          method: 'POST', body: JSON.stringify(body)
        });
        // Keep the local copy in step so a redraw doesn't revert the value.
        const idx = allOrders.findIndex((o) => o.id === el.dataset.order);
        if (idx > -1 && res.order) allOrders[idx] = res.order;
        showToast(i18t('supSaved', 'Saved'));
      } catch (err) {
        showToast(err.message, true);
      } finally {
        el.disabled = false;
      }
    });
    el.addEventListener('click', (e) => e.stopPropagation());
  });
}

function closePanel() {
  document.querySelectorAll('.om-panel-backdrop').forEach((el) => el.remove());
}

/**
 * Read-only detail for one PO. Deliberately limited to what a factory needs
 * to produce the order: identity, dates, quantity, variant split and the
 * production documents. No pricing breakdown, no QA reports, no other
 * suppliers' components.
 */
async function openSupplierOrder(id) {
  let order;
  try {
    const data = await api(`/api/order-management/orders/${encodeURIComponent(id)}${scopeParam}`);
    order = data.order;
  } catch (e) { return showToast(e.message, true); }

  const mc = order.mainComponent || {};
  const variants = mc.sizeDistribution || [];

  // Every document row is always listed, empty or not, so a supplier can
  // see at a glance which drawings are still outstanding rather than
  // wondering whether a missing row means "none" or "not applicable".
  const fileRow = (labelKey, fallback, url) => {
    let value;
    if (!url) {
      value = `<span style="color:var(--jc-muted);">${i18('supNoFile', 'Not uploaded')}</span>`;
    } else if (isPdfFile(url)) {
      value = `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${i18('btnViewFile', 'View file')}</a>`;
    } else {
      value = `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"><img src="${escapeHtml(url)}" alt="" class="om-table-thumb" style="cursor:pointer;" /></a>`;
    }
    return `<div class="om-detail-row"><span class="om-label">${i18(labelKey, fallback)}</span><span class="om-value">${value}</span></div>`;
  };
  const docs = [
    fileRow('fldManufacturingDrawing', 'Manufacturing Drawing', mc.manufacturingDrawing),
    fileRow('fldWashingTag', 'Washing Tag', mc.washingTagUrl),
    fileRow('fldPackaging', 'Packaging', mc.packagingUrl)
  ].join('');

  const num = (v) => (v === null || v === undefined || v === '' ? '—' : v);
  const measures = `
    <div class="om-detail-row"><span class="om-label">${i18('fldLengthCm', 'Length (cm)')}</span><span class="om-value">${num(mc.dimensionsLength)}</span></div>
    <div class="om-detail-row"><span class="om-label">${i18('fldWidthCm', 'Width (cm)')}</span><span class="om-value">${num(mc.dimensionsWidth)}</span></div>
    <div class="om-detail-row"><span class="om-label">${i18('fldHeightCm', 'Height (cm)')}</span><span class="om-value">${num(mc.dimensionsHeight)}</span></div>
    <div class="om-detail-row"><span class="om-label">${i18('fldWeightG', 'Weight (g)')}</span><span class="om-value">${num(mc.weightGrams)}</span></div>
    <div class="om-detail-row"><span class="om-label">${i18('fldShippingWeightG', 'Shipping Weight (g)')}</span><span class="om-value">${num(mc.shippingWeightGrams)}</span></div>
    <div class="om-detail-row"><span class="om-label">${i18('fldVolumeWeightG', 'Volume Weight (g)')}</span><span class="om-value">${num(mc.volumeWeightGrams)}</span></div>
  `;
  const log = order.supplierLog || [];

  const panel = document.createElement('div');
  panel.className = 'om-panel';
  panel.innerHTML = `
   <div class="om-panel-inner">
    <div class="om-panel-header">
      <div>
        <div style="font-size:19px;font-weight:700;">${escapeHtml(order.poNumber || '')}</div>
        <div style="color:var(--jc-muted);font-size:13px;">${escapeHtml(mc.name || '')}</div>
      </div>
      <button class="om-panel-close" id="supClose">&times;</button>
    </div>

    <div class="om-panel-card">
      <div class="om-section-title">${i18('secOrderDetails', 'Order Details')}</div>
      <div class="om-detail-grid">
        <div class="om-detail-row"><span class="om-label">${i18('fldProductName', 'Product Name')}</span><span class="om-value">${escapeHtml(mc.name || '—')}</span></div>
        <div class="om-detail-row"><span class="om-label">${i18('fldPurchaseOrderNumber', 'Purchase Order Number')}</span><span class="om-value">${escapeHtml(order.poNumber || '—')}</span></div>
        <div class="om-detail-row"><span class="om-label">${i18('fldSku', 'SKU')}</span><span class="om-value">${escapeHtml(mc.sku || '—')}</span></div>
        <div class="om-detail-row"><span class="om-label">${i18('fldOrderQuantity', 'Order Quantity')}</span><span class="om-value">${mc.purchaseQuantity ?? '—'}</span></div>
        <div class="om-detail-row"><span class="om-label">${i18('fldOrderPlacementDate', 'Order placement date')}</span><span class="om-value">${fmtDate(order.orderPlacementDate)}</span></div>
        <div class="om-detail-row"><span class="om-label">${i18('fldRequiredManufacturerDelivery', 'Required Manufacturer Delivery Date')}</span><span class="om-value">${fmtDate(order.manufacturerDeliveryDate)}</span></div>
        <div class="om-detail-row"><span class="om-label">${i18('fldStatusLc', 'Status')}</span><span class="om-value">${escapeHtml(order.status || '—')}</span></div>
      </div>
      ${mc.photoReference ? `
        <div style="margin-top:12px;">
          <div class="om-label" style="margin-bottom:6px;">${i18('fldPhotoReference', 'Photo reference')}</div>
          ${isPdfFile(mc.photoReference)
            ? `<a href="${escapeHtml(mc.photoReference)}" target="_blank" rel="noopener">${i18('btnViewFile', 'View file')}</a>`
            : `<a href="${escapeHtml(mc.photoReference)}" target="_blank" rel="noopener"><img src="${escapeHtml(mc.photoReference)}" alt="" style="max-width:160px;border-radius:8px;border:1px solid var(--jc-border);" /></a>`}
        </div>` : ''}
    </div>

    <div class="om-panel-card">
      <div class="om-section-title">${i18('secVariantDistribution', 'Variant Distribution')}</div>
      ${variants.length ? `
        <div class="om-table-wrap">
          <table class="om-table" style="min-width:0;">
            <thead><tr>
              <th>${i18('thSku', 'SKU')}</th>
              <th>${i18('thVariant', 'Variant')}</th>
              <th>${i18('thOrderQty', 'Order Qty')}</th>
            </tr></thead>
            <tbody>
              ${variants.map((v) => `
                <tr>
                  <td>${escapeHtml(v.sku || mc.sku || '—')}</td>
                  <td>${escapeHtml(v.size || '—')}</td>
                  <td>${v.quantity ?? '—'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : `<div class="om-empty">${i18('supNoVariants', 'No variant breakdown for this order.')}</div>`}
    </div>

    <div class="om-panel-card">
      <div class="om-section-title">${i18('secProductDocumentation', 'Product Documentation')}</div>
      <div class="om-detail-grid">${docs}</div>
      <div class="om-section-title" style="margin-top:18px;">${i18('secWeightsDimensions', 'Weights & Dimensions')}</div>
      <div class="om-detail-grid">${measures}</div>
    </div>

    <div class="om-panel-card">
      <div class="om-section-title">${i18('supActivityLog', 'Activity Log')}</div>
      ${log.length ? `
        <ul class="om-changelog">
          ${log.map((l) => `
            <li>
              <strong>${escapeHtml(l.text)}</strong>
              <div class="om-cl-meta">${new Date(l.at).toLocaleString()}</div>
            </li>
          `).join('')}
        </ul>
      ` : `<div class="om-empty">${i18('supNoLog', 'Nothing recorded yet.')}</div>`}
    </div>
   </div>
  `;
  const backdrop = document.createElement('div');
  backdrop.className = 'om-panel-backdrop';
  backdrop.appendChild(panel);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closePanel(); });
  document.body.appendChild(backdrop);
  document.getElementById('supClose').addEventListener('click', closePanel);
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { closePanel(); document.removeEventListener('keydown', esc); }
  });
}

(async function init() {
  if (window.JuniperI18n) await window.JuniperI18n.loadI18n();
  if (window.JuniperLang) {
    const header = document.querySelector('.app-header');
    window.JuniperLang.mountToggle(header);
    window.JuniperLang.mountLogout(header);
  }
  render();
}());
