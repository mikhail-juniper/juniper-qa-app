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

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  ensureDir();
  if (!fs.existsSync(ORDERS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(ORDERS_PATH, 'utf8'));
  } catch (err) {
    console.error('Failed to parse order management store - starting fresh. Original error:', err);
    return [];
  }
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
    productLine: data.productLine === 'clothing' ? 'clothing' : 'toys',
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
      warehouse: (data.mainComponent && data.mainComponent.warehouse) || '',
      sizeDistribution: (data.mainComponent && data.mainComponent.sizeDistribution) || []
    },
    accessories: Array.isArray(data.accessories) ? data.accessories : [],
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
  ['supplier', 'mainComponent', 'costs', 'settlement'].forEach((key) => {
    if (patch[key]) merged[key] = { ...before[key], ...patch[key] };
  });
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
  logChange(entries[idx], actor, 'File added', file.originalName);
  saveAll(entries);
  return entries[idx];
}

module.exports = {
  STATUSES, createOrder, getOrderById, listOrders, updateOrder, setStatus, setSettlement, addFile, ORDERS_PATH
};
