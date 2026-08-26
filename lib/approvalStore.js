/**
 * Persistent store for the QA/QC Approval workflow - one record per PO,
 * holding the three stages (Sample Approval, Pre-Production Approval, Bulk
 * Approval), each with its own submitted photos/notes plus a running log of
 * Product Development's review comments (timestamped and attributed).
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./submissionLog');

const APPROVAL_PATH = path.join(DATA_DIR, 'approvals.json');
const APPROVAL_PHOTO_DIR = path.join(DATA_DIR, 'approval-photos');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(APPROVAL_PHOTO_DIR, { recursive: true });
}

function loadAll() {
  ensureDirs();
  if (!fs.existsSync(APPROVAL_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(APPROVAL_PATH, 'utf8'));
  } catch (err) {
    console.error('Failed to parse approval store - starting fresh. Original error:', err);
    return [];
  }
}
function saveAll(entries) {
  ensureDirs();
  fs.writeFileSync(APPROVAL_PATH, JSON.stringify(entries, null, 2));
}

function emptyStage() {
  return { submitted: false, submittedAt: null, data: null, pdComments: [] };
}

function getOrCreateByPoNumber(poNumber, sku) {
  const entries = loadAll();
  let entry = entries.find((e) => e.poNumber && String(e.poNumber).trim().toLowerCase() === String(poNumber).trim().toLowerCase());
  if (!entry) {
    entry = {
      poNumber, sku: sku || null,
      sampleApproval: emptyStage(),
      preProductionApproval: emptyStage(),
      bulkApproval: emptyStage()
    };
    entries.push(entry);
    saveAll(entries);
  }
  return entry;
}

function getByPoNumber(poNumber) {
  if (!poNumber) return null;
  const norm = String(poNumber).trim().toLowerCase();
  return loadAll().find((e) => e.poNumber && String(e.poNumber).trim().toLowerCase() === norm) || null;
}

/** Most recent COMPLETED Sample Approval for any other PO of the same SKU -
 *  used to pre-fill/reference a new PO's Sample Approval so the China QA team
 *  doesn't redo work for PO2, PO3, etc. of the same product. */
function getPriorSampleApprovalForSku(sku, excludePoNumber) {
  if (!sku) return null;
  const norm = String(sku).trim().toLowerCase();
  const candidates = loadAll()
    .filter((e) => e.sku && String(e.sku).trim().toLowerCase() === norm
      && (!excludePoNumber || String(e.poNumber).trim().toLowerCase() !== String(excludePoNumber).trim().toLowerCase())
      && e.sampleApproval && e.sampleApproval.submitted)
    .sort((a, b) => new Date(b.sampleApproval.submittedAt) - new Date(a.sampleApproval.submittedAt));
  return candidates.length ? { poNumber: candidates[0].poNumber, ...candidates[0].sampleApproval } : null;
}

function updateStage(poNumber, sku, stageKey, data) {
  const entries = loadAll();
  let entry = entries.find((e) => e.poNumber && String(e.poNumber).trim().toLowerCase() === String(poNumber).trim().toLowerCase());
  if (!entry) {
    entry = { poNumber, sku: sku || null, sampleApproval: emptyStage(), preProductionApproval: emptyStage(), bulkApproval: emptyStage() };
    entries.push(entry);
  }
  if (sku && !entry.sku) entry.sku = sku;
  entry[stageKey] = { submitted: true, submittedAt: new Date().toISOString(), data, pdComments: (entry[stageKey] && entry[stageKey].pdComments) || [] };
  saveAll(entries);
  return entry;
}

function addPdComment(poNumber, stageKey, comment) {
  const entries = loadAll();
  const entry = entries.find((e) => e.poNumber && String(e.poNumber).trim().toLowerCase() === String(poNumber).trim().toLowerCase());
  if (!entry) return null;
  if (!entry[stageKey]) entry[stageKey] = emptyStage();
  entry[stageKey].pdComments.push({ ...comment, timestamp: new Date().toISOString() });
  saveAll(entries);
  return entry;
}

module.exports = {
  getOrCreateByPoNumber, getByPoNumber, getPriorSampleApprovalForSku, updateStage, addPdComment,
  APPROVAL_PATH, APPROVAL_PHOTO_DIR
};
