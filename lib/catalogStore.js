/**
 * Persistent store for Products and Components as real, manually-creatable
 * master data - mirrors supplierStore.js. This sits alongside (not instead
 * of) orderManagementStore's listProducts()/listComponents(), which derive
 * entries live from existing order data so anything entered on a PO still
 * shows up automatically. This store is just for the "+ Add Product" /
 * "+ Add Component" case: something you want in the catalog before any PO
 * references it.
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./submissionLog');

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
    notes: data.notes || '',
    createdAt: now,
    updatedAt: now
  };
  entries.push(entry);
  saveAll(PRODUCTS_PATH, entries);
  return entry;
}
function updateManualProduct(id, patch) {
  const entries = loadAll(PRODUCTS_PATH);
  const idx = entries.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  entries[idx] = { ...entries[idx], ...patch, updatedAt: new Date().toISOString() };
  saveAll(PRODUCTS_PATH, entries);
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

module.exports = {
  listManualProducts, getManualProduct, createManualProduct, updateManualProduct, deleteManualProduct,
  listManualComponents, getManualComponent, createManualComponent, updateManualComponent, deleteManualComponent
};
