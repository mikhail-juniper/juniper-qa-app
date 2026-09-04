/**
 * Persistent store for Warehouses - split out from Suppliers so Order
 * Management's "Warehouse Address" field can be a dropdown of real,
 * reusable warehouse records instead of free text typed fresh each time.
 */
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { DATA_DIR } = require('./submissionLog');

const WAREHOUSES_PATH = path.join(DATA_DIR, 'warehouses.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  ensureDir();
  if (!fs.existsSync(WAREHOUSES_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(WAREHOUSES_PATH, 'utf8'));
  } catch (err) {
    console.error('Failed to parse warehouse store - starting fresh. Original error:', err);
    return [];
  }
}

function saveAll(entries) {
  ensureDir();
  fs.writeFileSync(WAREHOUSES_PATH, JSON.stringify(entries, null, 2));
}

function listWarehouses() {
  return loadAll().sort((a, b) => a.name.localeCompare(b.name));
}

function getWarehouse(id) {
  return loadAll().find((w) => w.id === id) || null;
}

function createWarehouse(data) {
  const entries = loadAll();
  const now = new Date().toISOString();
  const entry = {
    id: data.id,
    name: data.name || '',
    address: data.address || '',
    contactName: data.contactName || '',
    phoneNumber: data.phoneNumber || '',
    notes: data.notes || '',
    createdAt: now,
    updatedAt: now
  };
  entries.push(entry);
  saveAll(entries);
  return entry;
}

function updateWarehouse(id, patch) {
  const entries = loadAll();
  const idx = entries.findIndex((w) => w.id === id);
  if (idx === -1) return null;
  entries[idx] = { ...entries[idx], ...patch, updatedAt: new Date().toISOString() };
  saveAll(entries);
  return entries[idx];
}

/** Create a bare Warehouse record for a name typed via "+ Add new..." on an
 *  order's Warehouse Address dropdown, if no warehouse with that name
 *  already exists (case-insensitive). Contact/address details can be
 *  filled in later on the Suppliers page's Warehouses section. */
function ensureWarehouseByName(name) {
  if (!name || !String(name).trim()) return null;
  const trimmed = String(name).trim();
  const entries = loadAll();
  if (entries.some((w) => (w.name || '').trim().toLowerCase() === trimmed.toLowerCase())) return null;
  return createWarehouse({ id: uuidv4(), name: trimmed });
}

function deleteWarehouse(id) {  const entries = loadAll();
  const next = entries.filter((w) => w.id !== id);
  saveAll(next);
  return next.length !== entries.length;
}

module.exports = { listWarehouses, getWarehouse, createWarehouse, updateWarehouse, deleteWarehouse, ensureWarehouseByName };
