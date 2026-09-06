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

async function render() {
  const root = document.getElementById('supRoot');
  root.innerHTML = `
    <h2 class="om-view-title">${i18('supYourPos', 'Your Purchase Orders')}</h2>
    <input class="om-search om-directory-search" id="supSearch" type="text" autocomplete="off"
      placeholder="${escapeHtml(i18t('supSearchPlaceholder', 'Search PO number, product, SKU...'))}" />
    <div id="supListHost"><div class="om-empty">${i18('emptyLoading', 'Loading...')}</div></div>
  `;
  try {
    const me = await api('/api/me');
    const sub = document.getElementById('supplierBrandSub');
    if (sub && me.user && me.user.supplierName) sub.textContent = me.user.supplierName;

    const data = await api('/api/order-management/orders');
    allOrders = data.orders || [];
    drawList('');
    const search = document.getElementById('supSearch');
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => drawList(search.value), 120);
    });
  } catch (e) {
    document.getElementById('supListHost').innerHTML =
      `<div class="om-empty">${escapeHtml(e.message)}</div>`;
  }
}

function drawList(query) {
  const host = document.getElementById('supListHost');
  const q = String(query || '').trim().toLowerCase();
  const shown = allOrders.filter((o) => {
    if (!q) return true;
    return [o.poNumber, o.mainComponent && o.mainComponent.name, o.mainComponent && o.mainComponent.sku]
      .some((v) => v && String(v).toLowerCase().includes(q));
  });
  if (!shown.length) {
    host.innerHTML = `<div class="om-empty">${i18('supNoOrders', 'No purchase orders yet.')}</div>`;
    return;
  }
  host.innerHTML = `
    <div class="om-category-tile">
      <div class="om-table-wrap">
        <table class="om-table">
          <thead><tr>
            <th>${i18('thPoNumber', 'PO Number')}</th>
            <th>${i18('fldProductName', 'Product Name')}</th>
            <th>${i18('fldSku', 'SKU')}</th>
            <th>${i18('thStatus', 'Status')}</th>
            <th>${i18('fldRequiredManufacturerDelivery', 'Required Manufacturer Delivery Date')}</th>
            <th>${i18('fldOrderQuantity', 'Order Quantity')}</th>
          </tr></thead>
          <tbody>
            ${shown.map((o) => `
              <tr data-id="${escapeHtml(o.id)}">
                <td><strong>${escapeHtml(o.poNumber || '—')}</strong></td>
                <td>${escapeHtml((o.mainComponent && o.mainComponent.name) || '—')}</td>
                <td>${escapeHtml((o.mainComponent && o.mainComponent.sku) || '—')}</td>
                <td><span class="om-pill om-pill-${statusSlug(o.status)}">${escapeHtml(o.status || '—')}</span></td>
                <td>${fmtDate(o.manufacturerDeliveryDate)}</td>
                <td>${(o.mainComponent && o.mainComponent.purchaseQuantity) ?? '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
  host.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', () => openSupplierOrder(tr.dataset.id));
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
    const data = await api(`/api/order-management/orders/${encodeURIComponent(id)}`);
    order = data.order;
  } catch (e) { return showToast(e.message, true); }

  const mc = order.mainComponent || {};
  const variants = mc.sizeDistribution || [];

  const fileRow = (labelKey, fallback, url) => {
    if (!url) return '';
    const link = isPdfFile(url)
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${i18('btnViewFile', 'View file')}</a>`
      : `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"><img src="${escapeHtml(url)}" alt="" class="om-table-thumb" style="cursor:pointer;" /></a>`;
    return `<div class="om-detail-row"><span class="om-label">${i18(labelKey, fallback)}</span><span class="om-value">${link}</span></div>`;
  };
  const docs = [
    fileRow('fldManufacturingDrawing', 'Manufacturing Drawing', mc.manufacturingDrawing),
    fileRow('fldWashingTag', 'Washing Tag', mc.washingTagUrl),
    fileRow('fldPackaging', 'Packaging', mc.packagingUrl),
    fileRow('fldProductDimensions', 'Product Dimensions', mc.dimensionsUrl)
  ].filter(Boolean).join('');

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
      ${docs ? `<div class="om-detail-grid">${docs}</div>`
        : `<div class="om-empty">${i18('supNoDocs', 'No documents attached yet.')}</div>`}
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
  }
  render();
}());
