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
const { DATA_DIR } = require('./submissionLog');

const ORDERS_PATH = path.join(DATA_DIR, 'orderManagement.json');
const ORDER_FILES_DIR = path.join(DATA_DIR, 'order-management-files');

const FILE_CATEGORIES = ['Style picture', 'Design document', 'Packing list', 'Other'];
const PRODUCT_LINES = ['toys', 'clothing', 'other'];

// Mirrors the 5 status pills observed in QingFlow, plus a starting state
// for orders that haven't been approved into production yet.
const STATUSES = [
  'New request',
  'Order placed',
  'In production',
  'During quality inspection',
  'During transport',
  'Confirm receipt of goods',
  'Completed'
];

function normalizeAccessory(a) {
  a = a || {};
  return {
    partName: a.partName || '',
    specifications: a.specifications || '',
    dimensions: a.dimensions || '',
    material: a.material || '',
    quantity: a.quantity || null,
    unitPrice: a.unitPrice || null,
    totalPrice: a.totalPrice || null,
    expectedDeliveryDate: a.expectedDeliveryDate || null,
    supplierName: a.supplierName || '',
    supplierContact: a.supplierContact || '',
    deliveryAddress: a.deliveryAddress || '',
    waybillNumber: a.waybillNumber || '',
    shipmentQuantity: a.shipmentQuantity || null,
    refundOrderNumber: a.refundOrderNumber || '',
    remark: a.remark || ''
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
  e.supplier = e.supplier || { name: '', contact: '', code: '' };
  e.mainComponent = e.mainComponent || {};
  e.mainComponent.sizeDistribution = e.mainComponent.sizeDistribution || [];
  e.accessories = Array.isArray(e.accessories) ? e.accessories.map(normalizeAccessory) : [];
  e.costs = e.costs || { assemblyFee: 0, laborCosts: 0, transportationFees: 0, otherExpenses: 0 };
  e.settlement = e.settlement || { status: 'Pending', amount: null, paidDate: null };
  e.fulfillment = e.fulfillment || {};
  e.fulfillment.replacementSizes = e.fulfillment.replacementSizes || [];
  e.files = Array.isArray(e.files) ? e.files : [];
  e.changeLog = Array.isArray(e.changeLog) ? e.changeLog : [];
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
    status: data.status || 'New request',
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
      paidDate: null
    },
    files: [],
    changeLog: [],
    createdAt: now,
    updatedAt: now
  };
  logChange(entry, actor, 'Created', `New ${entry.productLine} PO request`);
  entries.push(entry);
  saveAll(entries);
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
    newRequests: entries.filter((e) => e.status === 'New request').length
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
          examplePoId: e.id
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
  STATUSES, FILE_CATEGORIES, PRODUCT_LINES, ORDER_FILES_DIR, createOrder, getOrderById, getOrderByPoNumber,
  listOrders, updateOrder, setStatus, setSettlement, addFile, removeFile, listSuppliers, listProducts,
  listComponents, getCounts, computeOrderTotal, getMonthlyFinancials, getFieldHistory, ORDERS_PATH
};
