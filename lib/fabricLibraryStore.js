/**
 * Persistent store for the Fabric Library (Product Information > Fabric
 * Library) - two simple directories, Fabric Codes and Fabric Types, that
 * mirror catalogStore's auto-sync approach: any fabric code/type entered
 * anywhere else in the app (a PO's Main Component Specifications, or a
 * catalog Product's own fabric fields) gets a record here automatically
 * the first time it's seen, deduped case-insensitively. Entries can also
 * be added directly from this page, same as Suppliers/Products/Components.
 */
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { DATA_DIR } = require('./submissionLog');

const CODES_PATH = path.join(DATA_DIR, 'fabricCodes.json');
const TYPES_PATH = path.join(DATA_DIR, 'fabricTypes.json');

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

function keyFor(value) {
  return String(value || '').trim().toLowerCase();
}

// ---- Fabric Codes ----
function listFabricCodes() {
  return loadAll(CODES_PATH).sort((a, b) => a.value.localeCompare(b.value));
}
function createFabricCode(data) {
  const entries = loadAll(CODES_PATH);
  const now = new Date().toISOString();
  const entry = {
    id: data.id,
    value: data.value || '',
    swatchUrl: data.swatchUrl || '',
    // Full swatch-book fields (imported from the Fabric Swatch Translation
    // workbook, and editable on any entry): the physical fabric photo above
    // is the "actual" swatch; digitalColorUrl is the on-screen color
    // reference next to it.
    materialBlend: data.materialBlend || '',
    companyName: data.companyName || '',
    colorName: data.colorName || '',
    digitalColorUrl: data.digitalColorUrl || '',
    pantone: data.pantone || '',
    hex: data.hex || '',
    cmyk: data.cmyk || '',
    bookCode: data.bookCode || '',
    fabricWeight: data.fabricWeight || '',
    garmentType: data.garmentType || '',
    seedKey: data.seedKey || '',
    notes: data.notes || '',
    createdAt: now,
    updatedAt: now
  };
  entries.push(entry);
  saveAll(CODES_PATH, entries);
  return entry;
}
function updateFabricCode(id, patch) {
  const entries = loadAll(CODES_PATH);
  const idx = entries.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  entries[idx] = { ...entries[idx], ...patch, updatedAt: new Date().toISOString() };
  saveAll(CODES_PATH, entries);
  return entries[idx];
}
function deleteFabricCode(id) {
  const entries = loadAll(CODES_PATH);
  const next = entries.filter((c) => c.id !== id);
  saveAll(CODES_PATH, next);
  return next.length !== entries.length;
}
function ensureFabricCode(value) {
  if (!value || !value.trim()) return null;
  const key = keyFor(value);
  const entries = loadAll(CODES_PATH);
  // A PO may reference a swatch either by its library value ("01 - 100%
  // Cotton") or by its pantone - both count as "already in the library",
  // so neither creates a duplicate bare entry via auto-sync.
  if (entries.some((c) => keyFor(c.value) === key || keyFor(c.pantone) === key)) return null;
  return createFabricCode({ id: uuidv4(), value: value.trim() });
}

// ---- Fabric Types ----
function listFabricTypes() {
  return loadAll(TYPES_PATH).sort((a, b) => a.value.localeCompare(b.value));
}
function createFabricType(data) {
  const entries = loadAll(TYPES_PATH);
  const now = new Date().toISOString();
  const entry = {
    id: data.id,
    value: data.value || '',
    notes: data.notes || '',
    createdAt: now,
    updatedAt: now
  };
  entries.push(entry);
  saveAll(TYPES_PATH, entries);
  return entry;
}
function updateFabricType(id, patch) {
  const entries = loadAll(TYPES_PATH);
  const idx = entries.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  entries[idx] = { ...entries[idx], ...patch, updatedAt: new Date().toISOString() };
  saveAll(TYPES_PATH, entries);
  return entries[idx];
}
function deleteFabricType(id) {
  const entries = loadAll(TYPES_PATH);
  const next = entries.filter((t) => t.id !== id);
  saveAll(TYPES_PATH, next);
  return next.length !== entries.length;
}
function ensureFabricType(value) {
  if (!value || !value.trim()) return null;
  const key = keyFor(value);
  const entries = loadAll(TYPES_PATH);
  if (entries.some((t) => keyFor(t.value) === key)) return null;
  return createFabricType({ id: uuidv4(), value: value.trim() });
}

/** Call with an order (or anything with mainComponent.fabricInfo/component)
 *  after create/update, same idea as catalogStore.syncFromOrder. */
function syncFromOrder(order) {
  if (!order || !order.mainComponent) return;
  ensureFabricCode(order.mainComponent.fabricInfo);
  ensureFabricType(order.mainComponent.component);
}

/** Call with a catalog product after create/update. */
function syncFromProduct(product) {
  if (!product) return;
  ensureFabricCode(product.fabricCode);
  ensureFabricType(product.fabricType);
}

function backfillFromOrders(orders) {
  (orders || []).forEach(syncFromOrder);
}
function backfillFromProducts(products) {
  (products || []).forEach(syncFromProduct);
}

module.exports = {
  listFabricCodes, createFabricCode, updateFabricCode, deleteFabricCode, ensureFabricCode,
  listFabricTypes, createFabricType, updateFabricType, deleteFabricType, ensureFabricType,
  syncFromOrder, syncFromProduct, backfillFromOrders, backfillFromProducts
};
