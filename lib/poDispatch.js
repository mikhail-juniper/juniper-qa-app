/**
 * Sending a purchase order out to the factories that actually make it.
 *
 * A single PO is usually split across several suppliers: the main component
 * from one factory, each accessory/sub-component from others. So "send the
 * PO" is really "send each supplier the part of the PO that concerns them".
 * This module works out those slices, builds the message for each, and
 * records what was sent.
 *
 * On actually delivering the message - what's here and what isn't:
 *   - Email: this app has no SMTP configured, so nothing is sent from the
 *     server. It returns a fully-composed subject and body that the UI opens
 *     in the user's own mail client. When SMTP is added later, only
 *     `deliver()` needs to change; everything else already works.
 *   - WeChat: personal WeChat has no send API at all (only WeChat Work /
 *     企业微信 does, and that needs a registered corporate app). So WeChat
 *     is "copy the message, paste it to the contact" - the message and the
 *     recipient's WeChat ID are prepared for exactly that.
 * Either way the dispatch is logged, so the record of what a factory was
 * told doesn't depend on which channel was used.
 */
const supplierStore = require('./supplierStore');

function money(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return isNaN(n) ? String(v) : `¥${n.toLocaleString('en-US')}`;
}

function dateOnly(v) {
  return v ? String(v).slice(0, 10) : '—';
}

/** Find the supplier record behind a name, so dispatch can pick up the
 *  contact details on file rather than asking for them every time. */
function findSupplierByName(name) {
  if (!name) return null;
  const wanted = String(name).trim().toLowerCase();
  return supplierStore.listSuppliers()
    .find((s) => String(s.name || '').trim().toLowerCase() === wanted) || null;
}

/**
 * Every dispatchable slice of one PO: the main component plus each
 * sub-component, each paired with whatever contact details are on file for
 * its supplier. `key` identifies the slice for logging ('main', or the
 * accessory id).
 */
function buildTargets(order) {
  if (!order) return [];
  const targets = [];

  const mainSupplierName = (order.supplier && order.supplier.name) || '';
  const mainSupplier = findSupplierByName(mainSupplierName);
  targets.push({
    key: 'main',
    kind: 'main',
    componentName: (order.mainComponent && order.mainComponent.name) || order.poNumber,
    sku: (order.mainComponent && order.mainComponent.sku) || '',
    quantity: (order.mainComponent && order.mainComponent.purchaseQuantity) ?? null,
    unitPrice: (order.mainComponent && order.mainComponent.factoryPrice) ?? null,
    deliveryDate: order.manufacturerDeliveryDate || order.desiredEntryDate || null,
    supplierName: mainSupplierName,
    supplierId: mainSupplier ? mainSupplier.id : null,
    contactName: (mainSupplier && mainSupplier.contactName) || (order.supplier && order.supplier.contact) || '',
    email: (mainSupplier && mainSupplier.email) || '',
    wechat: (mainSupplier && mainSupplier.wechat) || '',
    address: (order.supplier && order.supplier.address) || (mainSupplier && mainSupplier.shippingAddress) || ''
  });

  (order.accessories || []).forEach((a) => {
    const sup = findSupplierByName(a.supplierName);
    targets.push({
      key: a.id,
      kind: 'accessory',
      componentName: a.partName || 'Component',
      sku: '',
      quantity: a.quantity ?? null,
      unitPrice: a.unitPrice ?? null,
      deliveryDate: a.expectedDeliveryDate || null,
      supplierName: a.supplierName || '',
      supplierId: sup ? sup.id : null,
      contactName: (sup && sup.contactName) || a.supplierContact || '',
      email: (sup && sup.email) || '',
      wechat: (sup && sup.wechat) || '',
      address: a.deliveryAddress || (sup && sup.shippingAddress) || ''
    });
  });

  // Attach the last dispatch (if any) so the UI can show what's already
  // been sent rather than risking duplicate orders to a factory.
  const log = order.dispatchLog || [];
  targets.forEach((t) => {
    const sent = log.filter((d) => d.targetKey === t.key)
      .sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))[0];
    t.lastSentAt = sent ? sent.sentAt : null;
    t.lastChannel = sent ? sent.channel : null;
  });
  return targets;
}

/**
 * The message a supplier receives for their slice of the PO. Bilingual on
 * purpose: these go to Chinese factories, and the English is there so the
 * Juniper side can read what was sent.
 */
function buildMessage(order, target) {
  const lines = [];
  const po = order.poNumber || '';
  lines.push(`采购订单 Purchase Order: ${po}`);
  lines.push('');
  if (target.contactName) lines.push(`${target.contactName} 您好 / Hello ${target.contactName},`);
  else lines.push('您好 / Hello,');
  lines.push('');
  lines.push('请确认以下采购订单内容。 / Please confirm the following purchase order details.');
  lines.push('');
  lines.push(`产品 / Item:        ${target.componentName}`);
  if (target.sku) lines.push(`SKU:                ${target.sku}`);
  lines.push(`数量 / Quantity:     ${target.quantity ?? '—'}`);
  lines.push(`单价 / Unit price:   ${money(target.unitPrice)}`);
  if (target.quantity && target.unitPrice) {
    lines.push(`总额 / Total:        ${money(Number(target.quantity) * Number(target.unitPrice))}`);
  }
  lines.push(`交货日期 / Delivery: ${dateOnly(target.deliveryDate)}`);
  if (target.address) lines.push(`收货地址 / Ship to:  ${target.address}`);
  lines.push('');
  lines.push('如有任何问题请回复此消息。 / Please reply to this message with any questions.');
  lines.push('');
  lines.push('Juniper Creates');

  return {
    subject: `采购订单 / Purchase Order ${po} - ${target.componentName}`,
    body: lines.join('\n')
  };
}

/**
 * The value bag a message template renders against. Keys here are the
 * {{placeholders}} template authors can use - keep in step with
 * messageTemplateStore.PLACEHOLDERS.
 */
function templateValues(order, target, portalLink) {
  const total = (target.quantity && target.unitPrice)
    ? money(Number(target.quantity) * Number(target.unitPrice))
    : '—';
  return {
    poNumber: order.poNumber || '',
    componentName: target.componentName || '',
    sku: target.sku || '—',
    quantity: target.quantity ?? '—',
    unitPrice: money(target.unitPrice),
    total,
    deliveryDate: dateOnly(target.deliveryDate),
    address: target.address || '—',
    contactName: target.contactName || '',
    supplierName: target.supplierName || '',
    // Their own access link, so the message doubles as the way in.
    portalLink: portalLink || ''
  };
}

/**
 * Record that a dispatch happened. Returns the log entry. Deliberately
 * separate from composing the message: the log should reflect what was
 * actually sent, including via channels this server can't drive itself.
 */
function buildLogEntry(target, channel, recipient, actor) {
  return {
    targetKey: target.key,
    componentName: target.componentName,
    supplierName: target.supplierName,
    channel,                 // 'email' | 'wechat'
    recipient,               // the address/ID it went to
    sentAt: new Date().toISOString(),
    sentBy: actor || 'Web user'
  };
}

/**
 * Placeholder for real server-side delivery. Returns notSent so callers
 * treat this as "compose locally" until SMTP (or WeChat Work) is wired up.
 * Keeping the seam here means the UI and logging never have to change.
 */
async function deliver() {
  return { delivered: false, reason: 'no-server-transport' };
}

module.exports = { buildTargets, buildMessage, buildLogEntry, deliver, findSupplierByName, templateValues };
