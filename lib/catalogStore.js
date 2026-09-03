/**
 * Persistent store for Products and Components as real master data -
 * mirrors supplierStore.js. This is now the single directory: every
 * product/component that appears on any PO gets a record here
 * automatically (see syncFromOrder/backfillFromOrders below), and anyone
 * can also add one by hand before a PO ever references it. Order data
 * itself is never edited by this sync - it only ever creates a catalog
 * record when one doesn't already exist yet for that SKU/part, so a
 * human edit here is never clobbered by a later PO.
 */
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { DATA_DIR } = require('./submissionLog');
// Keeps the Fabric Library in sync any time a catalog product's own
// fabricCode/fabricType fields introduce a new one - fabricLibraryStore
// has no dependency back on this module, so this is safe both ways.
const fabricLibraryStore = require('./fabricLibraryStore');

const PRODUCTS_PATH = path.join(DATA_DIR, 'catalogProducts.json');
const COMPONENTS_PATH = path.join(DATA_DIR, 'catalogComponents.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll(filePath) {
  ensureDir();
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`Failed to parse ${filePath} - starting fresh. Original error:`, err);
    return [];
  }
}

function saveAll(filePath, entries) {
  ensureDir();
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2));
}

// ---- Products ----
function listManualProducts() {
  return loadAll(PRODUCTS_PATH).sort((a, b) => a.name.localeCompare(b.name));
}
function getManualProduct(id) {
  return loadAll(PRODUCTS_PATH).find((p) => p.id === id) || null;
}
function createManualProduct(data) {
  const entries = loadAll(PRODUCTS_PATH);
  const now = new Date().toISOString();
  const entry = {
    id: data.id,
    name: data.name || '',
    sku: data.sku || '',
    modelNumber: data.modelNumber || '',
    productLine: data.productLine || 'clothing',
    factoryPrice: data.factoryPrice || null,
    salesUnitPrice: data.salesUnitPrice || null,
    dimensions: data.dimensions || '',
    weight: data.weight || '',
    // Apparel-only (productLine === 'clothing') fields - kept even if the
    // product line changes later so nothing entered is lost, but the UI
    // only shows them for apparel.
    fabricCode: data.fabricCode || '',
    fabricType: data.fabricType || '',
    washingTag: data.washingTag || '',
    supplierName: data.supplierName || '',
    supplierContact: data.supplierContact || '',
    supplierCode: data.supplierCode || '',
    notes: data.notes || '',
    // True only for records this store created for you automatically from
    // a PO, as opposed to ones someone filled in by hand. Purely
    // informational - editing an auto-created record's fields treats it
    // like any other from that point on.
    autoCreated: !!data.autoCreated,
    createdAt: now,
    updatedAt: now
  };
  entries.push(entry);
  saveAll(PRODUCTS_PATH, entries);
  fabricLibraryStore.syncFromProduct(entry);
  return entry;
}
function updateManualProduct(id, patch) {
  const entries = loadAll(PRODUCTS_PATH);
  const idx = entries.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  entries[idx] = { ...entries[idx], ...patch, updatedAt: new Date().toISOString() };
  saveAll(PRODUCTS_PATH, entries);
  if (patch.fabricCode || patch.fabricType) fabricLibraryStore.syncFromProduct(entries[idx]);
  return entries[idx];
}
function deleteManualProduct(id) {
  const entries = loadAll(PRODUCTS_PATH);
  const next = entries.filter((p) => p.id !== id);
  saveAll(PRODUCTS_PATH, next);
  return next.length !== entries.length;
}

// ---- Components ----
function listManualComponents() {
  return loadAll(COMPONENTS_PATH).sort((a, b) => a.partName.localeCompare(b.partName));
}
function getManualComponent(id) {
  return loadAll(COMPONENTS_PATH).find((c) => c.id === id) || null;
}
function createManualComponent(data) {
  const entries = loadAll(COMPONENTS_PATH);
  const now = new Date().toISOString();
  const entry = {
    id: data.id,
    partName: data.partName || '',
    material: data.material || '',
    supplierName: data.supplierName || '',
    unitPrice: data.unitPrice || null,
    productLine: data.productLine || 'clothing',
    notes: data.notes || '',
    autoCreated: !!data.autoCreated,
    createdAt: now,
    updatedAt: now
  };
  entries.push(entry);
  saveAll(COMPONENTS_PATH, entries);
  return entry;
}
function updateManualComponent(id, patch) {
  const entries = loadAll(COMPONENTS_PATH);
  const idx = entries.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  entries[idx] = { ...entries[idx], ...patch, updatedAt: new Date().toISOString() };
  saveAll(COMPONENTS_PATH, entries);
  return entries[idx];
}
function deleteManualComponent(id) {
  const entries = loadAll(COMPONENTS_PATH);
  const next = entries.filter((c) => c.id !== id);
  saveAll(COMPONENTS_PATH, next);
  return next.length !== entries.length;
}

// ---- Auto-sync from order data ----
// Every PO carries a main product (mainComponent) and a list of
// accessories/components. Rather than making the directory a live,
// re-derived view of that order data (the old approach - which is what
// tied "Products"/"Components" to a specific example PO instead of being
// a real, editable directory), we upsert a real catalog record here the
// first time we see a given SKU/part. After that the catalog record is
// the source of truth for its own fields; POs referencing it just show up
// in its "historical POs" list (see orderManagementStore.getOrdersBySku/
// getOrdersForComponent), they never overwrite it.
function keyFor(value) {
  return String(value || '').trim().toLowerCase();
}

function ensureProductFromOrder(order) {
  const mc = (order && order.mainComponent) || {};
  if (!mc.name && !mc.sku) return null;
  const key = keyFor(mc.sku || mc.name);
  const entries = loadAll(PRODUCTS_PATH);
  if (entries.some((p) => keyFor(p.sku || p.name) === key)) return null;
  const supplier = order.supplier || {};
  return createManualProduct({
    id: uuidv4(),
    name: mc.name || '(unnamed)',
    sku: mc.sku || '',
    modelNumber: mc.modelNumber || '',
    productLine: order.productLine || 'other',
    factoryPrice: mc.factoryPrice,
    salesUnitPrice: mc.salesUnitPrice,
    dimensions: mc.dimensions || '',
    weight: mc.weightGrams || mc.actualWeight || '',
    fabricCode: mc.fabricInfo || '',
    fabricType: mc.component || '',
    washingTag: mc.washLabel || '',
    supplierName: supplier.name || '',
    supplierContact: supplier.contact || '',
    supplierCode: supplier.code || '',
    autoCreated: true
  });
}

function ensureComponentFromAccessory(accessory, productLine) {
  if (!accessory || !accessory.partName) return null;
  const key = `${keyFor(accessory.partName)}::${keyFor(accessory.supplierName)}`;
  const entries = loadAll(COMPONENTS_PATH);
  if (entries.some((c) => `${keyFor(c.partName)}::${keyFor(c.supplierName)}` === key)) return null;
  return createManualComponent({
    id: uuidv4(),
    partName: accessory.partName,
    material: accessory.material || '',
    supplierName: accessory.supplierName || '',
    unitPrice: accessory.unitPrice,
    productLine: productLine || 'other',
    autoCreated: true
  });
}

/** Call after creating/updating a single order so any new product/part on
 *  it gets a catalog record immediately, going forward. */
function syncFromOrder(order) {
  if (!order) return;
  ensureProductFromOrder(order);
  (order.accessories || []).forEach((a) => ensureComponentFromAccessory(a, order.productLine));
}

/** One-time (repeatable/idempotent) backfill over every existing order -
 *  covers everything already on record before this directory existed.
 *  Cheap to call on every directory-list request since it's a no-op past
 *  the first run for any given SKU/part. */
function backfillFromOrders(orders) {
  (orders || []).forEach(syncFromOrder);
}

module.exports = {
  listManualProducts, getManualProduct, createManualProduct, updateManualProduct, deleteManualProduct,
  listManualComponents, getManualComponent, createManualComponent, updateManualComponent, deleteManualComponent,
  syncFromOrder, backfillFromOrders
};
