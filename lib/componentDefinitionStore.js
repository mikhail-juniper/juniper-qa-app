/**
 * Component definitions: the reusable SPEC for a sub-component.
 *
 * A "Hang Tag" is two different things that were previously one record:
 *
 *   - the SPEC   - what this product's hang tag is: artwork, dimensions,
 *                  material, notes. Stable across every PO for that SKU.
 *   - the ORDER  - quantity, unit price, supplier, dates, payment.
 *                  Different on every PO.
 *
 * Storing both on `order.accessories[]` meant a reorder re-entered the
 * artwork from scratch, and the Components page filled with near-duplicate
 * rows that were actually the same part ordered repeatedly.
 *
 * Definitions are keyed by SKU + part name, confirmed as the right axis:
 * a hang tag is never shared across SKUs.
 *
 * DELIBERATELY ADDITIVE. The per-PO accessory records keep their own spec
 * fields, and a definition seeds them when a component is first added to a
 * PO. Fully normalising - accessories holding only a reference - would mean
 * touching every place that reads a component, which is a lot of risk on a
 * live system for no extra benefit today.
 */
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const submissionLog = require('./submissionLog');

const DATA_DIR = submissionLog.DATA_DIR;
const STORE_PATH = path.join(DATA_DIR, 'componentDefinitions.json');

/** The spec fields a definition owns. Everything else stays per-PO. */
const SPEC_FIELDS = [
  'designDocUrl', 'imageUrl', 'specifications', 'material',
  'dimensions', 'dimensionsLength', 'dimensionsWidth', 'dimensionsHeight'
];

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  ensureDir();
  if (!fs.existsSync(STORE_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Failed to parse componentDefinitions.json - starting empty:', err.message || err);
    return [];
  }
}

function saveAll(entries) {
  ensureDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(entries, null, 2));
}

/** Match key. Case and spacing vary in practice ("Hang Tag", "hangtag"). */
function keyFor(sku, partName) {
  const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!norm(sku) || !norm(partName)) return null;
  return `${norm(sku)}::${norm(partName)}`;
}

function listDefinitions({ sku } = {}) {
  const all = loadAll();
  if (!sku) return all;
  const want = String(sku).trim().toLowerCase();
  return all.filter((d) => String(d.sku || '').trim().toLowerCase() === want);
}

function findFor(sku, partName) {
  const key = keyFor(sku, partName);
  if (!key) return null;
  return loadAll().find((d) => d.key === key) || null;
}

/**
 * Create or update the definition for a part, from an accessory record.
 *
 * Only non-empty spec values are written: a PO row that never filled in the
 * material must not blank out a material recorded on an earlier PO. That
 * makes the definition accumulate the best-known spec over time rather than
 * being overwritten by whichever PO was saved last.
 */
function upsertFromAccessory(sku, accessory, actor) {
  const key = keyFor(sku, accessory && accessory.partName);
  if (!key) return null;
  const entries = loadAll();
  const now = new Date().toISOString();
  let def = entries.find((d) => d.key === key);
  if (!def) {
    def = {
      id: uuidv4(),
      key,
      sku: String(sku).trim(),
      partName: String(accessory.partName).trim(),
      createdAt: now,
      updatedAt: now,
      createdBy: actor || 'Unknown'
    };
    SPEC_FIELDS.forEach((f) => { def[f] = ''; });
    entries.push(def);
  }
  let changed = false;
  SPEC_FIELDS.forEach((f) => {
    const incoming = accessory[f];
    if (incoming !== null && incoming !== undefined && String(incoming) !== ''
      && String(incoming) !== String(def[f])) {
      def[f] = incoming;
      changed = true;
    }
  });
  if (changed) {
    def.updatedAt = now;
    def.updatedBy = actor || 'Unknown';
  }
  saveAll(entries);
  return def;
}

/**
 * Fill an accessory's empty spec fields from its definition.
 *
 * Empty-only on purpose: if someone has deliberately entered a different
 * dimension on this PO, inheriting must not overwrite it.
 */
function applyToAccessory(sku, accessory) {
  const def = findFor(sku, accessory && accessory.partName);
  if (!def) return { accessory, definitionId: null, inherited: [] };
  const inherited = [];
  SPEC_FIELDS.forEach((f) => {
    const current = accessory[f];
    const isEmpty = current === null || current === undefined || String(current) === '';
    if (isEmpty && def[f] !== null && def[f] !== undefined && String(def[f]) !== '') {
      accessory[f] = def[f];
      inherited.push(f);
    }
  });
  return { accessory, definitionId: def.id, inherited };
}

function updateDefinition(id, patch, actor) {
  const entries = loadAll();
  const def = entries.find((d) => d.id === id);
  if (!def) return null;
  SPEC_FIELDS.forEach((f) => {
    if (Object.prototype.hasOwnProperty.call(patch || {}, f)) def[f] = patch[f];
  });
  def.updatedAt = new Date().toISOString();
  def.updatedBy = actor || 'Unknown';
  saveAll(entries);
  return def;
}

function deleteDefinition(id) {
  const entries = loadAll();
  const next = entries.filter((d) => d.id !== id);
  if (next.length === entries.length) return false;
  saveAll(next);
  return true;
}

module.exports = {
  SPEC_FIELDS, STORE_PATH, keyFor,
  listDefinitions, findFor, upsertFromAccessory, applyToAccessory,
  updateDefinition, deleteDefinition
};
