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

/**
 * Full-size image overlay. Photos open here rather than in a new tab, so a
 * factory checking a reference photo doesn't lose their place in the table.
 * Click anywhere, or press Escape, to close.
 */
function openLightbox(url) {
  let overlay = document.getElementById('supLightbox');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'supLightbox';
    overlay.className = 'lightbox-overlay';
    overlay.innerHTML = '<img alt="" />';
    overlay.addEventListener('click', () => overlay.classList.add('hidden'));
    document.body.appendChild(overlay);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') overlay.classList.add('hidden');
    });
  }
  overlay.querySelector('img').src = url;
  overlay.classList.remove('hidden');
}

/** A thumbnail, or a link when the file is a PDF, or a dash. PDFs still
 *  open in a new tab - a browser renders those better than we can. */
function thumb(url, alt) {
  if (!url) return '<span style="color:var(--jc-muted);">—</span>';
  if (isPdfFile(url)) {
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="font-size:11.5px;">${i18('btnViewFile', 'View')}</a>`;
  }
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt || '')}" class="sup-thumb sup-zoom" ` +
    `data-full="${escapeHtml(url)}" title="${escapeHtml(alt || '')}" />`;
}

/**
 * One PO row. Mirrors the columns the factory is used to seeing in the
 * shared KingDocs sheet, so the move over doesn't change how they read it.
 *
 * Three cells are editable by the factory - the two sample dates and bulk
 * progress. They save on change through the narrow supplier endpoint; the
 * rest of the row is ours and read-only.
 */
/**
 * Every distinct component name across the POs on screen, in the order
 * first seen. Each becomes its own column - matching the old KingDocs
 * sheet, which had a column per part (drawstring bag, cards/tags, ...)
 * rather than a list crammed into one cell.
 */
function componentColumns(orders) {
  const names = [];
  orders.forEach((o) => {
    (o.componentPhotos || []).forEach((c) => {
      const name = (c.partName || '').trim();
      if (name && !names.includes(name)) names.push(name);
    });
  });
  return names;
}

function rowHtml(o, compCols) {
  const mc = o.mainComponent || {};
  const f = o.factoryUpdates || {};
  const dash = '<span style="color:var(--jc-muted);">—</span>';
  const comps = (o.componentPhotos || []).filter((c) => c.partName || c.imageUrl);
  // Log comes back newest-first, so the head is the current status.
  const latest = (o.bulkProgressLog || [])[0] || null;
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
      <td class="sup-notes sup-wrap">${o.productionNotes ? escapeHtml(o.productionNotes) : dash}</td>
      <td class="sup-progress-cell">
        ${latest
          ? `<div class="sup-progress-latest" title="${escapeHtml(latest.by || '')}">${escapeHtml(latest.text)}
              <span class="sup-progress-when">${fmtDate(latest.at)}</span></div>`
          : ''}
        <input type="text" class="sup-edit sup-progress-add" data-order="${escapeHtml(o.id)}"
          placeholder="${escapeHtml(i18t('supAddUpdate', 'Add update...'))}" />
      </td>
      <td class="sup-wrap">${escapeHtml(o.warehouseAddress || '—')}</td>
      ${compCols.map((name) => {
        const hit = comps.find((c) => (c.partName || '').trim() === name);
        if (!hit) return `<td>${dash}</td>`;
        return `<td>${hit.imageUrl ? thumb(hit.imageUrl, name) : `<span class="sup-comp-none">${i18('supNoPhoto', 'No photo')}</span>`}</td>`;
      }).join('')}
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

  // Component columns depend on what's on screen, so they're computed from
  // the filtered set rather than every order the supplier has.
  const compCols = componentColumns(shown);
  host.innerHTML = `
    <div class="om-category-tile">
      <div class="om-table-wrap">
        <table class="om-table sup-table">
          <thead><tr>
            ${[
              i18('supPhoto', 'Photo'),
              i18('fldProductName', 'Product Name'),
              i18('fldSku', 'SKU'),
              i18('thPoNumber', 'PO Number'),
              i18('thStatus', 'Status'),
              i18('supQuantity', 'Quantity'),
              i18('supOrderDate', 'Order Date'),
              i18('fldRequiredManufacturerDelivery', 'Required Manufacturer Delivery Date'),
              i18('supActualShipDate', 'Actual Ship Date'),
              i18('supPreProdSample', 'Pre-Production Sample'),
              i18('supBulkSample', 'Bulk Sample'),
              i18('fldProductionNotes', 'Production Notes'),
              i18('supBulkProgress', 'Bulk Shipment Progress'),
              i18('fldWarehouseAddress', 'Warehouse Address'),
              ...compCols.map((n) => escapeHtml(n)),
              i18('supWashingTag', 'Washing Tag'),
              i18('supPackingList', 'Packing List Number')
            ].map((label) => `<th><span class="sup-th">${label}</span></th>`).join('')}
          </tr></thead>
          <tbody>
            ${shown.map((o) => rowHtml(o, compCols)).join('')}
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
  host.querySelectorAll('.sup-zoom').forEach((img) => {
    img.addEventListener('click', (e) => {
      e.stopPropagation(); // don't also open the PO detail panel
      openLightbox(img.dataset.full);
    });
  });

  /* Progress updates append rather than overwrite, so they post a
   * bulkProgressNote and then clear the box ready for the next one. */
  host.querySelectorAll('.sup-progress-add').forEach((el) => {
    const submit = async () => {
      const text = el.value.trim();
      if (!text) return;
      // Clear immediately: pressing Enter also fires blur, and without this
      // the same update got logged twice.
      el.value = '';
      el.disabled = true;
      try {
        const res = await api(`/api/supplier/orders/${encodeURIComponent(el.dataset.order)}/factory-updates`, {
          method: 'POST', body: JSON.stringify({ bulkProgressNote: text })
        });
        const idx = allOrders.findIndex((o) => o.id === el.dataset.order);
        if (idx > -1 && res.order) allOrders[idx] = res.order;
        showToast(i18t('supUpdateAdded', 'Update added'));
        drawList();
      } catch (err) {
        showToast(err.message, true);
        el.value = text; // put it back so nothing is lost
        el.disabled = false;
      }
    };
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    el.addEventListener('blur', submit);
    el.addEventListener('click', (e) => e.stopPropagation());
  });

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
      value = `<img src="${escapeHtml(url)}" alt="" class="om-table-thumb sup-zoom" data-full="${escapeHtml(url)}" style="cursor:zoom-in;" />`;
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
  const comps = (order.componentPhotos || []).filter((c) => c.partName || c.imageUrl);
  const progressLog = order.bulkProgressLog || [];

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
        <div class="om-detail-row"><span class="om-label">${i18('supOrderDate', 'Order Date')}</span><span class="om-value">${fmtDate(order.orderDate)}</span></div>
        <div class="om-detail-row"><span class="om-label">${i18('fldRequiredManufacturerDelivery', 'Required Manufacturer Delivery Date')}</span><span class="om-value">${fmtDate(order.manufacturerDeliveryDate)}</span></div>
        <div class="om-detail-row"><span class="om-label">${i18('supActualShipDate', 'Actual Ship Date')}</span><span class="om-value">${order.inTransportationAt ? fmtDate(order.inTransportationAt) : '—'}</span></div>
        <div class="om-detail-row"><span class="om-label">${i18('fldStatusLc', 'Status')}</span><span class="om-value">${escapeHtml(order.status || '—')}</span></div>
      </div>
      ${mc.photoReference ? `
        <div style="margin-top:12px;">
          <div class="om-label" style="margin-bottom:6px;">${i18('fldPhotoReference', 'Photo reference')}</div>
          ${isPdfFile(mc.photoReference)
            ? `<a href="${escapeHtml(mc.photoReference)}" target="_blank" rel="noopener">${i18('btnViewFile', 'View file')}</a>`
            : `<img src="${escapeHtml(mc.photoReference)}" alt="" class="sup-zoom" data-full="${escapeHtml(mc.photoReference)}" style="max-width:160px;border-radius:8px;border:1px solid var(--jc-border);cursor:zoom-in;" />`}
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
      <div class="om-section-title">${i18('supSecProduction', 'Production & Samples')}</div>
      <div class="section-help" style="margin-bottom:12px;">${i18('supEditableHint', 'You can fill in the sample dates and bulk progress.')}</div>
      <div class="om-field-grid">
        <div>
          <label>${i18('supPreProdSample', 'Pre-Production Sample')}</label>
          <input type="date" class="sup-panel-edit" data-field="preProductionSampleDate"
            data-order="${escapeHtml(order.id)}" value="${escapeHtml(((order.factoryUpdates || {}).preProductionSampleDate || '').slice(0, 10))}" />
        </div>
        <div>
          <label>${i18('supBulkSample', 'Bulk Sample')}</label>
          <input type="date" class="sup-panel-edit" data-field="bulkSampleDate"
            data-order="${escapeHtml(order.id)}" value="${escapeHtml(((order.factoryUpdates || {}).bulkSampleDate || '').slice(0, 10))}" />
        </div>

      </div>
      <div style="margin-top:14px;">
        <div class="om-label" style="margin-bottom:5px;">${i18('fldProductionNotes', 'Production Notes')}</div>
        <div class="om-value" style="white-space:pre-wrap;line-height:1.5;">${order.productionNotes ? escapeHtml(order.productionNotes) : '—'}</div>
      </div>

      <div style="margin-top:20px;">
        <div class="om-section-title" style="margin-bottom:6px;">${i18('supProgressLog', 'Bulk Shipment Progress')}</div>
        <div class="section-help" style="margin-bottom:10px;">${i18('supAddUpdateHint', 'Each update is saved with the date.')}</div>
        <input type="text" id="supPanelProgressAdd" data-order="${escapeHtml(order.id)}"
          class="sup-panel-edit" placeholder="${escapeHtml(i18t('supAddUpdate', 'Add update...'))}" />
        ${progressLog.length ? `
          <ul class="om-changelog" style="margin-top:12px;">
            ${progressLog.map((e) => `
              <li>
                <strong style="font-weight:500;">${escapeHtml(e.text)}</strong>
                <div class="om-cl-meta">${new Date(e.at).toLocaleString()}${e.by ? ' · ' + escapeHtml(e.by) : ''}</div>
              </li>
            `).join('')}
          </ul>
        ` : `<div class="om-empty" style="padding:14px 0;">${i18('supNoUpdates', 'No updates yet.')}</div>`}
      </div>
    </div>

    <div class="om-panel-card">
      <div class="om-section-title">${i18('supSecComponents', 'Components')}</div>
      ${comps.length ? `<div class="sup-panel-comps">${comps.map((c) => `
        <div class="sup-panel-comp">
          ${c.imageUrl
            ? `<img src="${escapeHtml(c.imageUrl)}" alt="" class="sup-panel-comp-img sup-zoom" data-full="${escapeHtml(c.imageUrl)}" />`
            : `<div class="sup-panel-comp-img sup-panel-comp-empty">${i18('supNoPhoto', 'No photo')}</div>`}
          <div class="sup-panel-comp-name">${escapeHtml(c.partName)}</div>
        </div>
      `).join('')}</div>` : `<div class="om-empty">${i18('supNoDocs', 'None listed.')}</div>`}
    </div>

    <div class="om-panel-card">
      <div class="om-section-title">${i18('supSecWarehousing', 'Warehousing')}</div>
      <div class="om-detail-grid">
        <div class="om-detail-row"><span class="om-label">${i18('fldWarehouseAddress', 'Warehouse Address')}</span><span class="om-value">${escapeHtml(order.warehouseAddress || '—')}</span></div>
        <div class="om-detail-row"><span class="om-label">${i18('supPackingList', 'Packing List Number')}</span><span class="om-value">${escapeHtml(order.packingListNumber || '—')}</span></div>
      </div>
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

  // Photos inside the panel zoom in place, same as in the table.
  panel.querySelectorAll('.sup-zoom').forEach((img) => {
    img.addEventListener('click', () => openLightbox(img.dataset.full));
  });

  /* The three factory fields are editable here as well as in the table, so
   * whichever view they're in works. Saving keeps the in-memory list in
   * step so closing the panel doesn't show a stale row. */
  const panelProgress = document.getElementById('supPanelProgressAdd');
  if (panelProgress) {
    const submit = async () => {
      const text = panelProgress.value.trim();
      if (!text) return;
      // Cleared before posting for the same Enter-then-blur reason.
      panelProgress.value = '';
      panelProgress.disabled = true;
      try {
        await api(`/api/supplier/orders/${encodeURIComponent(panelProgress.dataset.order)}/factory-updates`, {
          method: 'POST', body: JSON.stringify({ bulkProgressNote: text })
        });
        showToast(i18t('supUpdateAdded', 'Update added'));
        // Reopen so the new entry appears in the log, and refresh the table
        // behind it.
        const orderId = panelProgress.dataset.order;
        const data = await api('/api/order-management/orders' + scopeParam);
        allOrders = data.orders || [];
        drawList();
        closePanel();
        openSupplierOrder(orderId);
      } catch (err) {
        showToast(err.message, true);
        panelProgress.value = text;
        panelProgress.disabled = false;
      }
    };
    panelProgress.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    panelProgress.addEventListener('blur', submit);
  }

  // The date fields still overwrite; only progress is append-only.
  panel.querySelectorAll('.sup-panel-edit[data-field]').forEach((el) => {
    el.addEventListener('change', async () => {
      const body = {};
      body[el.dataset.field] = el.value;
      el.disabled = true;
      try {
        const res = await api(`/api/supplier/orders/${encodeURIComponent(el.dataset.order)}/factory-updates`, {
          method: 'POST', body: JSON.stringify(body)
        });
        const idx = allOrders.findIndex((o) => o.id === el.dataset.order);
        if (idx > -1 && res.order) allOrders[idx] = res.order;
        showToast(i18t('supSaved', 'Saved'));
        drawList(); // reflect it in the table behind the panel
      } catch (err) {
        showToast(err.message, true);
      } finally {
        el.disabled = false;
      }
    });
  });
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
