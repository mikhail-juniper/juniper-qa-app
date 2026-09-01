/**
 * Persistent store of Purchase Order records created via "New Purchase Order".
 * These are the shared source of truth that Pre-Production/Bulk Sampling
 * Reporting and QA/QC Approval both read from and pre-fill against, so QA
 * staff and factory teams don't have to re-key the same order information.
 *
 * A PO belongs to a SKU. Once a "standard fit" (apparel sizing standard) is
 * established for a SKU - normally during QA/QC Approval's Sample Approval
 * step - later POs for that same SKU can look it up and copy it forward,
 * rather than re-selecting it each time.
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./submissionLog');

const PO_PATH = path.join(DATA_DIR, 'purchaseOrders.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  ensureDir();
  if (!fs.existsSync(PO_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(PO_PATH, 'utf8'));
  } catch (err) {
    console.error('Failed to parse purchase order store - starting fresh. Original error:', err);
    return [];
  }
}

function saveAll(entries) {
  ensureDir();
  fs.writeFileSync(PO_PATH, JSON.stringify(entries, null, 2));
}

function createPo(entry) {
  const entries = loadAll();
  entries.push(entry);
  saveAll(entries);
  return entry;
}

function getPoById(id) {
  return loadAll().find((e) => e.id === id) || null;
}

function getPoByNumber(poNumber) {
  if (!poNumber) return null;
  const norm = String(poNumber).trim().toLowerCase();
  return loadAll().find((e) => e.poNumber && String(e.poNumber).trim().toLowerCase() === norm) || null;
}

function getPosBySku(sku) {
  if (!sku) return [];
  const norm = String(sku).trim().toLowerCase();
  return loadAll()
    .filter((e) => e.sku && String(e.sku).trim().toLowerCase() === norm)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/** Most recently-established apparel fit + its size list for a SKU, if any
 *  prior PO for that SKU has had one set (normally via QA/QC Approval). */
function getEstablishedFitForSku(sku) {
  const pos = getPosBySku(sku).filter((p) => p.fitKey);
  return pos.length ? { fitKey: pos[0].fitKey, sizes: pos[0].fitSizes || [] } : null;
}

function updatePo(id, patch) {
  const entries = loadAll();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  entries[idx] = { ...entries[idx], ...patch };
  saveAll(entries);
  return entries[idx];
}

module.exports = {
  createPo, getPoById, getPoByNumber, getPosBySku, getEstablishedFitForSku, updatePo, PO_PATH
};
