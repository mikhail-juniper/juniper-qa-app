/* Juniper QA/QC Approval - placeholder page (full workflow coming in a later phase).
   If reached via a "New Purchase Order" share link (?po=<id>), shows what's on
   file for that PO so the link is useful right away, even before Sample/Pre-
   Production/Bulk Approval are fully built out. */

let I18N = {};
function bi(key, fallback) {
  const e = I18N[key];
  if (!e) return { en: fallback || key, zh: '' };
  return { en: e.zh, zh: e.en };
}
function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

async function init() {
  try {
    const configRes = await fetch('/api/config');
    const config = await configRes.json();
    I18N = config.i18n || {};
  } catch (e) { console.error(e); }

  const root = document.getElementById('approvalRoot');
  const params = new URLSearchParams(location.search);
  const poId = params.get('po');

  const backLink = `<a href="index.html" class="btn btn-secondary" style="display:inline-block;width:auto;padding:10px 18px;margin-bottom:16px;text-decoration:none;">← Home / 首页</a>`;

  if (!poId) {
    root.innerHTML = `
      ${backLink}
      <div class="card">
        <div class="section-title">质检审批 QA/QC Approval</div>
        <div class="section-help">This workflow (Sample Approval, Pre-Production Approval, Bulk Approval) is being built next. Check back soon.<br/>此流程（样品审批、产前审批、批量审批）正在开发中，敬请期待。</div>
      </div>
    `;
    return;
  }

  try {
    const res = await fetch(`/api/purchase-orders/${encodeURIComponent(poId)}`);
    if (!res.ok) throw new Error('not found');
    const { po } = await res.json();
    root.innerHTML = `
      ${backLink}
      <div class="card">
        <div class="section-title">质检审批 QA/QC Approval</div>
        <div class="section-help">The full Sample Approval workflow for this PO is being built next - here's what's on file so far.<br/>此订单的完整样品审批流程正在开发中，以下是目前已记录的信息。</div>
      </div>
      <div class="card">
        <div class="review-row"><span class="k">PO Number</span><span class="v">${escapeHtml(po.poNumber)}</span></div>
        <div class="review-row"><span class="k">SKU</span><span class="v">${escapeHtml(po.sku)}</span></div>
        <div class="review-row"><span class="k">Category</span><span class="v">${escapeHtml(po.category || '-')} ${escapeHtml(po.subcategory || '')}</span></div>
        <div class="review-row"><span class="k">Order Date</span><span class="v">${escapeHtml(po.orderDate || '-')}</span></div>
        <div class="review-row"><span class="k">Creator</span><span class="v">${escapeHtml(po.creator || '-')}</span></div>
        <div class="review-row"><span class="k">Order Quantity</span><span class="v">${escapeHtml(po.orderQuantity || '-')}</span></div>
        <div class="review-row"><span class="k">Product Development Lead</span><span class="v">${escapeHtml(po.productDevelopmentLead || '-')}</span></div>
        ${po.sizesIncluded && po.sizesIncluded.length ? `<div class="review-row"><span class="k">Sizes Included</span><span class="v">${escapeHtml(po.sizesIncluded.join(', '))}</span></div>` : ''}
      </div>
    `;
  } catch (e) {
    root.innerHTML = `${backLink}<div class="card"><div class="section-help">Purchase order not found. / 未找到该采购订单。</div></div>`;
  }
}

init();
