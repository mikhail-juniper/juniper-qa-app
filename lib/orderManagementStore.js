/**
 * Persistent store for the Order Management Hub - the rebuild of the
 * QingFlow "Order Management" workspace, living as a section of this app.
 *
 * A PO record is the parent. Main component + accessory detail live nested
 * on the same record (unlike QingFlow, which split them into separate
 * linked apps joined only by Order Number) so the parent always reflects
 * current status - see the workflow spec's "parent PO stays in sync"
 * decision. Status transitions are manual (also per that spec), so this
 * store just persists whatever a person sets, plus an audit trail of every
 * change for the change-log requirement.
 */
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { DATA_DIR } = require('./submissionLog');
// Keeps the Products/Components directory (catalogStore) in sync any time
// an order introduces a new SKU or part - see catalogStore.syncFromOrder.
// catalogStore has no dependency back on this module, so this is safe.
const catalogStore = require('./catalogStore');

const ORDERS_PATH = path.join(DATA_DIR, 'orderManagement.json');
const ORDER_FILES_DIR = path.join(DATA_DIR, 'order-management-files');

const FILE_CATEGORIES = ['Style picture', 'Design document', 'Packing list', 'Other'];
const PRODUCT_LINES = ['toys', 'clothing', 'other'];

// Mirrors the 5 status pills observed in QingFlow, plus a starting state
// for orders that haven't been approved into production yet.
const STATUSES = [
  'New Request',
  'Order Placed',
  'PP Quality Inspection',
  'In Production',
  'Bulk Quality Inspection',
  'In Transportation',
  'Delivered',
  'Completed'
];

// One-time migration map for orders saved under the old status labels -
// applied on load so existing orders keep a valid, meaningfully-equivalent
// status instead of falling off the tracker entirely.
const LEGACY_STATUS_MAP = {
  'New request': 'New Request',
  'Order placed': 'Order Placed',
  'In production': 'In Production',
  'During quality inspection': 'Bulk Quality Inspection',
  'During transport': 'In Transportation',
  'Confirm receipt of goods': 'Delivered',
  'Completed': 'Completed'
};

const ACCESSORY_STATUSES = STATUSES;

function normalizeAccessory(a) {
  a = a || {};
  return {
    id: a.id || uuidv4(),
    partName: a.partName || '',
    specifications: a.specifications || '',
    dimensions: a.dimensions || '',
    dimensionsLength: a.dimensionsLength || '',
    dimensionsWidth: a.dimensionsWidth || '',
    dimensionsHeight: a.dimensionsHeight || '',
    material: a.material || '',
    quantity: a.quantity || null,
    unitPrice: a.unitPrice || null,
    totalPrice: a.totalPrice || (a.quantity && a.unitPrice ? Math.round(a.quantity * a.unitPrice * 100) / 100 : null),
    shippingCost: a.shippingCost || null,
    expectedDeliveryDate: a.expectedDeliveryDate || null,
    supplierName: a.supplierName || '',
    supplierContact: a.supplierContact || '',
    deliveryAddress: a.deliveryAddress || '',
    waybillNumber: a.waybillNumber || '',
    shipmentQuantity: a.shipmentQuantity || null,
    refundOrderNumber: a.refundOrderNumber || '',
    remark: a.remark || '',
    status: ACCESSORY_STATUSES.includes(a.status) ? a.status : ACCESSORY_STATUSES[0],
    imageUrl: a.imageUrl || '',
    designDocUrl: a.designDocUrl || ''
  };
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ORDER_FILES_DIR, { recursive: true });
}

function loadAll() {
  ensureDir();
  if (!fs.existsSync(ORDERS_PATH)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(ORDERS_PATH, 'utf8'));
    return raw.map(hydrateOrder);
  } catch (err) {
    console.error('Failed to parse order management store - starting fresh. Original error:', err);
    return [];
  }
}

// Backfills any nested objects/arrays a record might be missing because it
// was created before that part of the schema existed (e.g. records made
// before "fulfillment" was added). Without this, older records crash the
// detail panel the moment it tries to read a field that doesn't exist -
// silently, since the panel HTML is built outside any try/catch. Every read
// path goes through loadAll(), so applying this here covers all of them.
function hydrateOrder(e) {
  if (LEGACY_STATUS_MAP[e.status]) e.status = LEGACY_STATUS_MAP[e.status];
  e.supplier = e.supplier || { name: '', contact: '', code: '' };
  e.mainComponent = e.mainComponent || {};
  e.mainComponent.sizeDistribution = e.mainComponent.sizeDistribution || [];
  e.accessories = Array.isArray(e.accessories) ? e.accessories.map(normalizeAccessory) : [];
  e.costs = e.costs || { assemblyFee: 0, laborCosts: 0, transportationFees: 0, otherExpenses: 0 };
  e.settlement = e.settlement || { status: 'Pending', amount: null, paidDate: null, componentPayments: {} };
  e.settlement.componentPayments = e.settlement.componentPayments || {};
  e.fulfillment = e.fulfillment || {};
  e.fulfillment.replacementSizes = e.fulfillment.replacementSizes || [];
  e.files = Array.isArray(e.files) ? e.files : [];
  e.changeLog = Array.isArray(e.changeLog) ? e.changeLog : [];
  // QA/QC fields, merged in from the retired poStore - default older
  // records that predate this merge so consumers never see `undefined`.
  e.category = e.category || null;
  e.subcategory = e.subcategory || null;
  e.creator = e.creator || '';
  e.productDevelopmentLead = e.productDevelopmentLead || '';
  e.sizesIncluded = Array.isArray(e.sizesIncluded) ? e.sizesIncluded : [];
  e.fitKey = e.fitKey || null;
  e.fitSizes = Array.isArray(e.fitSizes) ? e.fitSizes : [];
  e.asanaTaskLink = e.asanaTaskLink || null;
  e.asanaTaskGid = e.asanaTaskGid || null;
  e.productRisk = e.productRisk || null;
  return e;
}

function saveAll(entries) {
  ensureDir();
  fs.writeFileSync(ORDERS_PATH, JSON.stringify(entries, null, 2));
}

function logChange(entry, actor, action, details) {
  if (!Array.isArray(entry.changeLog)) entry.changeLog = [];
  entry.changeLog.unshift({
    timestamp: new Date().toISOString(),
    actor: actor || 'Unknown',
    action,
    details: details || null
  });
}

function createOrder(data, actor) {
  const entries = loadAll();
  const now = new Date().toISOString();
  const entry = {
    id: data.id,
    poNumber: data.poNumber || '',
    productLine: PRODUCT_LINES.includes(data.productLine) ? data.productLine : 'toys',
    status: data.status || 'New Request',
    buyer: data.buyer || '',
    orderPlacementDate: data.orderPlacementDate || null,
    desiredEntryDate: data.desiredEntryDate || null,
    manufacturerDeliveryDate: data.manufacturerDeliveryDate || null,
    supplier: {
      name: (data.supplier && data.supplier.name) || '',
      contact: (data.supplier && data.supplier.contact) || '',
      code: (data.supplier && data.supplier.code) || ''
    },
    mainComponent: {
      name: (data.mainComponent && data.mainComponent.name) || '',
      sku: (data.mainComponent && data.mainComponent.sku) || '',
      modelNumber: (data.mainComponent && data.mainComponent.modelNumber) || '',
      factoryPrice: (data.mainComponent && data.mainComponent.factoryPrice) || null,
      salesUnitPrice: (data.mainComponent && data.mainComponent.salesUnitPrice) || null,
      salesVolume: (data.mainComponent && data.mainComponent.salesVolume) || null,
      purchaseQuantity: (data.mainComponent && data.mainComponent.purchaseQuantity) || null,
      totalPurchasePrice: (data.mainComponent && data.mainComponent.totalPurchasePrice) || null,
      actualWeight: (data.mainComponent && data.mainComponent.actualWeight) || null,
      transportWeight: (data.mainComponent && data.mainComponent.transportWeight) || null,
      dimensions: (data.mainComponent && data.mainComponent.dimensions) || '',
      fabricInfo: (data.mainComponent && data.mainComponent.fabricInfo) || '',
      component: (data.mainComponent && data.mainComponent.component) || '',
      washLabel: (data.mainComponent && data.mainComponent.washLabel) || '',
      productionPrecautions: (data.mainComponent && data.mainComponent.productionPrecautions) || '',
      manufacturingDrawing: (data.mainComponent && data.mainComponent.manufacturingDrawing) || '',
      washingTagUrl: (data.mainComponent && data.mainComponent.washingTagUrl) || '',
      packagingUrl: (data.mainComponent && data.mainComponent.packagingUrl) || '',
      dimensionsUrl: (data.mainComponent && data.mainComponent.dimensionsUrl) || '',
      // Apparel-only: this PO's own editable copy of a sizing standard
      // (points/sizes/measurements) - the source of truth for this PO's
      // sizing + QA process, independent of the master standard in
      // fits.json once copied in, so it can be adjusted per-order.
      dimensionsTable: (data.mainComponent && data.mainComponent.dimensionsTable) || null,
      weightGrams: (data.mainComponent && data.mainComponent.weightGrams) || null,
      shippingWeightGrams: (data.mainComponent && data.mainComponent.shippingWeightGrams) || null,
      volumeWeightGrams: (data.mainComponent && data.mainComponent.volumeWeightGrams) || null,
      photoReference: (data.mainComponent && data.mainComponent.photoReference) || '',
      warehouse: (data.mainComponent && data.mainComponent.warehouse) || '',
      sizeDistribution: (data.mainComponent && data.mainComponent.sizeDistribution) || []
    },
    accessories: Array.isArray(data.accessories) ? data.accessories.map(normalizeAccessory) : [],
    fulfillment: {
      packingListNumber: (data.fulfillment && data.fulfillment.packingListNumber) || '',
      waybillNumber: (data.fulfillment && data.fulfillment.waybillNumber) || '',
      warehouseEntryDate: (data.fulfillment && data.fulfillment.warehouseEntryDate) || null,
      warehouseOverdue: (data.fulfillment && data.fulfillment.warehouseOverdue) || '',
      quantityReceived: (data.fulfillment && data.fulfillment.quantityReceived) || null,
      allAccessoriesReceived: (data.fulfillment && data.fulfillment.allAccessoriesReceived) || '',
      exceptionHandlingResults: (data.fulfillment && data.fulfillment.exceptionHandlingResults) || '',
      returnTrackingNumber: (data.fulfillment && data.fulfillment.returnTrackingNumber) || '',
      replacementSizes: (data.fulfillment && data.fulfillment.replacementSizes) || []
    },
    costs: {
      assemblyFee: (data.costs && data.costs.assemblyFee) || 0,
      laborCosts: (data.costs && data.costs.laborCosts) || 0,
      transportationFees: (data.costs && data.costs.transportationFees) || 0,
      otherExpenses: (data.costs && data.costs.otherExpenses) || 0
    },
    settlement: {
      status: 'Pending',
      amount: (data.settlement && data.settlement.amount) || null,
      paidDate: null,
      componentPayments: {}
    },
    files: [],
    changeLog: [],
    // ---- QA/QC fields (merged in from the retired poStore) ----
    // These live top-level, flat, matching what QA/QC reporting/approval/
    // consolidated-report code already expects, rather than nested under
    // mainComponent - keeps the translation layer for that code minimal.
    category: data.category || null, // finer than productLine: apparel/plush/bags/accessories/other
    subcategory: data.subcategory || null,
    creator: data.creator || '',
    productDevelopmentLead: data.productDevelopmentLead || '',
    sizesIncluded: Array.isArray(data.sizesIncluded) ? data.sizesIncluded : [],
    fitKey: data.fitKey || null,
    fitSizes: Array.isArray(data.fitSizes) ? data.fitSizes : [],
    asanaTaskLink: data.asanaTaskLink || null,
    asanaTaskGid: data.asanaTaskGid || null,
    productRisk: data.productRisk || null,
    createdAt: now,
    updatedAt: now
  };
  logChange(entry, actor, 'Created', `New ${entry.productLine} PO request`);
  entries.push(entry);
  saveAll(entries);
  catalogStore.syncFromOrder(entry);
  return entry;
}

function getOrderById(id) {
  return loadAll().find((e) => e.id === id) || null;
}

function getOrderByPoNumber(poNumber, productLine) {
  if (!poNumber) return null;
  const norm = String(poNumber).trim().toLowerCase();
  return loadAll().find((e) =>
    e.poNumber && String(e.poNumber).trim().toLowerCase() === norm &&
    (!productLine || e.productLine === productLine)
  ) || null;
}

function getOrdersBySku(sku) {
  if (!sku) return [];
  const norm = String(sku).trim().toLowerCase();
  return loadAll()
    .filter((e) => e.mainComponent && e.mainComponent.sku && String(e.mainComponent.sku).trim().toLowerCase() === norm)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/** Historical POs for a catalog product - matches by SKU when the
 *  product has one (the reliable key), falling back to an exact name
 *  match for older/manually-entered products that don't. */
function getOrdersForProduct(sku, name) {
  if (sku) return getOrdersBySku(sku);
  if (!name) return [];
  const norm = String(name).trim().toLowerCase();
  return loadAll()
    .filter((e) => e.mainComponent && e.mainComponent.name && String(e.mainComponent.name).trim().toLowerCase() === norm)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/** Historical POs that used a given component/accessory - matched by part
 *  name, narrowed by supplier when one is given (mirrors how
 *  catalogStore keys components: partName + supplierName together). */
function getOrdersForComponent(partName, supplierName) {
  if (!partName) return [];
  const normPart = String(partName).trim().toLowerCase();
  const normSupplier = supplierName ? String(supplierName).trim().toLowerCase() : null;
  return loadAll()
    .filter((e) => (e.accessories || []).some((a) =>
      a.partName && String(a.partName).trim().toLowerCase() === normPart &&
      (!normSupplier || (a.supplierName && String(a.supplierName).trim().toLowerCase() === normSupplier))
    ))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/** Most recently-established apparel fit + its size list for a SKU, if any
 *  prior order for that SKU has had one set (normally via QA/QC Approval). */
function getEstablishedFitForSku(sku) {
  const orders = getOrdersBySku(sku).filter((o) => o.fitKey);
  return orders.length ? { fitKey: orders[0].fitKey, sizes: orders[0].fitSizes || [] } : null;
}

/** Flat, poStore-shaped view of an order for QA/QC reporting/approval/PDF
 *  code that was written against poStore's flat schema (sku, category,
 *  etc. at the top level) - keeps that code from needing to know or care
 *  that this data now actually lives on a nested Order Management record. */
function toQaShape(order) {
  if (!order) return null;
  return {
    id: order.id,
    poNumber: order.poNumber,
    sku: order.mainComponent.sku,
    category: order.category,
    subcategory: order.subcategory,
    orderDate: order.orderPlacementDate,
    creator: order.creator,
    orderQuantity: order.mainComponent.purchaseQuantity,
    productTitle: order.mainComponent.name,
    productDevelopmentLead: order.productDevelopmentLead,
    sizesIncluded: order.sizesIncluded,
    fitKey: order.fitKey,
    fitSizes: order.fitSizes,
    asanaTaskLink: order.asanaTaskLink,
    asanaTaskGid: order.asanaTaskGid,
    productRisk: order.productRisk,
    createdAt: order.createdAt
  };
}

function listSuppliers(productLine) {
  const entries = loadAll().filter((e) => !productLine || e.productLine === productLine);
  const byKey = new Map();
  entries.forEach((e) => {
    const name = e.supplier && e.supplier.name;
    if (!name) return;
    const key = name.trim().toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, {
        name: e.supplier.name,
        contact: e.supplier.contact || '',
        code: e.supplier.code || '',
        productLines: new Set(),
        orderCount: 0
      });
    }
    const rec = byKey.get(key);
    rec.orderCount += 1;
    rec.productLines.add(e.productLine);
    // Prefer the most recently-seen contact/code in case it changed.
    if (e.supplier.contact) rec.contact = e.supplier.contact;
    if (e.supplier.code) rec.code = e.supplier.code;
  });
  return Array.from(byKey.values())
    .map((r) => ({ ...r, productLines: Array.from(r.productLines) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Manufacturing Cost is a PER-UNIT figure: the main component's own unit
// price plus every sub-component's per-unit price. Quantities only enter
// the picture once, at the Total PO Cost step below - not here.
function computeManufacturingCostPerUnit(order) {
  const mc = order.mainComponent || {};
  const mainUnitCost = Number(mc.factoryPrice) || 0;
  const subComponentUnitCosts = (order.accessories || []).reduce((sum, a) => sum + (Number(a.unitPrice) || 0), 0);
  return Math.round((mainUnitCost + subComponentUnitCosts) * 10000) / 10000;
}

// Total PO Cost = Manufacturing Cost x Order Quantity, plus every flat
// (not-per-unit) additional cost: each sub-component's own shipping cost
// (to the main factory), the warehousing shipping cost (to the warehouse),
// and the additional assembly/labor/other fees.
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

function computeTotalPricePerUnit(order) {
  const mc = order.mainComponent || {};
  const orderQuantity = Number(mc.purchaseQuantity) || 0;
  if (!orderQuantity) return null;
  return Math.round((computeOrderTotal(order) / orderQuantity) * 10000) / 10000;
}

function monthKeyFor(order) {
  const d = order.orderPlacementDate || order.desiredEntryDate || order.createdAt;
  if (!d) return 'Undated';
  const date = new Date(d);
  if (isNaN(date)) return 'Undated';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function getMonthlyFinancials() {
  const entries = loadAll();
  const byMonth = new Map();
  entries.forEach((e) => {
    const key = monthKeyFor(e);
    if (!byMonth.has(key)) byMonth.set(key, { month: key, total: 0, paid: 0, pending: 0, orderCount: 0 });
    const total = computeOrderTotal(e);
    const bucket = byMonth.get(key);
    bucket.total += total;
    bucket.orderCount += 1;
    if (e.settlement && e.settlement.status === 'Paid') bucket.paid += total;
    else bucket.pending += total;
  });
  return Array.from(byMonth.values())
    .map((b) => ({ ...b, total: round2(b.total), paid: round2(b.paid), pending: round2(b.pending) }))
    .sort((a, b) => (a.month < b.month ? 1 : -1)); // most recent first; "Undated" sorts oddly but rare
}

function round2(n) { return Math.round(n * 100) / 100; }

function getCounts() {
  const entries = loadAll();
  const accessoryCount = (line) => entries
    .filter((e) => e.productLine === line)
    .reduce((sum, e) => sum + (e.accessories ? e.accessories.length : 0), 0);
  return {
    toys: entries.filter((e) => e.productLine === 'toys').length,
    clothing: entries.filter((e) => e.productLine === 'clothing').length,
    other: entries.filter((e) => e.productLine === 'other').length,
    toysAccessories: accessoryCount('toys'),
    clothingAccessories: accessoryCount('clothing'),
    otherAccessories: accessoryCount('other'),
    suppliers: listSuppliers().length,
    settlementPending: entries.filter((e) => e.settlement && e.settlement.status === 'Pending').length,
    newRequests: entries.filter((e) => e.status === 'New Request').length
  };
}

function listOrders({ productLine, status, search } = {}) {
  let entries = loadAll();
  if (productLine) entries = entries.filter((e) => e.productLine === productLine);
  if (status) entries = entries.filter((e) => e.status === status);
  if (search) {
    const norm = String(search).trim().toLowerCase();
    entries = entries.filter((e) =>
      (e.poNumber || '').toLowerCase().includes(norm) ||
      (e.supplier && (e.supplier.name || '').toLowerCase().includes(norm)) ||
      (e.mainComponent && (e.mainComponent.name || '').toLowerCase().includes(norm)) ||
      (e.mainComponent && (e.mainComponent.sku || '').toLowerCase().includes(norm))
    );
  }
  return entries.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function updateOrder(id, patch, actor, actionLabel) {
  const entries = loadAll();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  const before = entries[idx];
  const merged = { ...before, ...patch, updatedAt: new Date().toISOString() };
  // Deep-merge the known nested objects rather than clobbering them.
  ['supplier', 'mainComponent', 'costs', 'settlement', 'fulfillment'].forEach((key) => {
    if (patch[key]) merged[key] = { ...before[key], ...patch[key] };
  });
  if (patch.accessories) merged.accessories = patch.accessories.map(normalizeAccessory);
  logChange(merged, actor, actionLabel || 'Updated', summarizeChange(before, patch));
  entries[idx] = merged;
  saveAll(entries);
  // Only worth re-syncing when the fields that could introduce a new
  // product/part actually changed - avoids a wasted disk read+scan on
  // every unrelated update (status changes, settlement, etc.).
  if (patch.mainComponent || patch.accessories || patch.productLine || patch.supplier) {
    catalogStore.syncFromOrder(merged);
  }
  return merged;
}

function summarizeChange(before, patch) {
  if (patch.status && patch.status !== before.status) {
    return `Status: "${before.status}" → "${patch.status}"`;
  }
  if (patch.settlement && patch.settlement.status) {
    return `Settlement: "${before.settlement.status}" → "${patch.settlement.status}"`;
  }
  if (patch.accessories) {
    return `Accessories/parts updated (${patch.accessories.length} item${patch.accessories.length === 1 ? '' : 's'})`;
  }
  if (patch.fulfillment) {
    return 'Fulfillment/tracking details updated';
  }
  return null;
}

function setStatus(id, status, actor) {
  return updateOrder(id, { status }, actor, 'Status change');
}

function setSettlement(id, settlementStatus, actor) {
  const patch = { settlement: { status: settlementStatus } };
  if (settlementStatus === 'Paid') patch.settlement.paidDate = new Date().toISOString();
  return updateOrder(id, patch, actor, 'Settlement change');
}

function addFile(id, file, actor) {
  const entries = loadAll();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  if (!Array.isArray(entries[idx].files)) entries[idx].files = [];
  entries[idx].files.push(file);
  entries[idx].updatedAt = new Date().toISOString();
  logChange(entries[idx], actor, 'File added', `${file.category}: ${file.originalName}`);
  saveAll(entries);
  return entries[idx];
}

function removeFile(id, fileId, actor) {
  const entries = loadAll();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  const file = (entries[idx].files || []).find((f) => f.id === fileId);
  entries[idx].files = (entries[idx].files || []).filter((f) => f.id !== fileId);
  entries[idx].updatedAt = new Date().toISOString();
  if (file) {
    logChange(entries[idx], actor, 'File removed', `${file.category}: ${file.originalName}`);
    const diskPath = path.join(ORDER_FILES_DIR, id, file.storedName);
    fs.unlink(diskPath, () => {}); // best-effort; don't fail the request if this errors
  }
  saveAll(entries);
  return entries[idx];
}

function listProducts(productLine) {
  const entries = loadAll().filter((e) => !productLine || e.productLine === productLine);
  const byKey = new Map();
  entries.forEach((e) => {
    const mc = e.mainComponent || {};
    if (!mc.name && !mc.sku) return;
    const key = (mc.sku || mc.name).trim().toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, {
        name: mc.name || '(unnamed)',
        sku: mc.sku || '',
        modelNumber: mc.modelNumber || '',
        productLine: e.productLine,
        factoryPrice: mc.factoryPrice,
        salesUnitPrice: mc.salesUnitPrice,
        poCount: 0,
        examplePoId: e.id
      });
    }
    byKey.get(key).poCount += 1;
  });
  return Array.from(byKey.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function listComponents(productLine) {
  const entries = loadAll().filter((e) => !productLine || e.productLine === productLine);
  const byKey = new Map();
  entries.forEach((e) => {
    (e.accessories || []).forEach((a) => {
      if (!a.partName) return;
      const key = `${a.partName}::${a.supplierName || ''}`.trim().toLowerCase();
      if (!byKey.has(key)) {
        byKey.set(key, {
          partName: a.partName,
          material: a.material || '',
          supplierName: a.supplierName || '',
          unitPrice: a.unitPrice,
          productLine: e.productLine,
          useCount: 0,
          examplePoId: e.id,
          exampleAccessoryId: a.id
        });
      }
      byKey.get(key).useCount += 1;
    });
  });
  return Array.from(byKey.values()).sort((a, b) => a.partName.localeCompare(b.partName));
}

function getFieldHistory() {
  const entries = loadAll();
  const collect = (getter) => {
    const set = new Set();
    entries.forEach((e) => {
      const v = getter(e);
      if (v && String(v).trim()) set.add(String(v).trim());
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  };
  return {
    supplierNames: collect((e) => e.supplier && e.supplier.name),
    fabricCodes: collect((e) => e.mainComponent && e.mainComponent.fabricInfo),
    fabricTypes: collect((e) => e.mainComponent && e.mainComponent.component),
    washLabels: collect((e) => e.mainComponent && e.mainComponent.washLabel),
    manufacturingDrawings: collect((e) => e.mainComponent && e.mainComponent.manufacturingDrawing)
  };
}

module.exports = {
  STATUSES, ACCESSORY_STATUSES, FILE_CATEGORIES, PRODUCT_LINES, ORDER_FILES_DIR, createOrder, getOrderById, getOrderByPoNumber,
  getOrdersBySku, getEstablishedFitForSku, toQaShape,
  listOrders, updateOrder, setStatus, setSettlement, addFile, removeFile, listSuppliers, listProducts,
  listComponents, getCounts, computeOrderTotal, computeManufacturingCostPerUnit, computeTotalPricePerUnit,
  getMonthlyFinancials, getFieldHistory, ORDERS_PATH, getOrdersForProduct, getOrdersForComponent
};
