/**
 * Persistent store for Warehouses - split out from Suppliers so Order
 * Management's "Warehouse Address" field can be a dropdown of real,
 * reusable warehouse records instead of free text typed fresh each time.
 */
const fs = require('fs');
const path = require('path');
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

function deleteWarehouse(id) {
  const entries = loadAll();
  const next = entries.filter((w) => w.id !== id);
  saveAll(next);
  return next.length !== entries.length;
}

module.exports = { listWarehouses, getWarehouse, createWarehouse, updateWarehouse, deleteWarehouse };
