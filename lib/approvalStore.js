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

/* Backed by SQLite. This was the worst of the remaining flat-file stores:
 * 44.1 MB and 562 ms per edit at a 4,700-PO history, because each PO carries
 * three approval stages with comment threads. Every posted comment rewrote the
 * whole file and blocked every other request while it did.
 *
 * The record shape is unchanged - one row per PO, the full object in `data`. */
const { createRowStore } = require('./jsonRowDb');
ensureDirs();
const db = createRowStore({
  dataDir: DATA_DIR,
  file: 'approvals.db',
  table: 'approvals',
  idOf: (e) => String(e.poNumber || '').trim().toLowerCase(),
  columns: {
    po_number: (e) => String(e.poNumber || '').trim().toLowerCase(),
    sku: (e) => (e.sku ? String(e.sku).trim().toLowerCase() : null)
  },
  legacyPath: APPROVAL_PATH
});

function loadAll() {
  return db.all();
}

/** Kept for the wholesale paths (restore from backup). Normal edits use saveOne. */
function saveAll(entries) {
  db.replaceAll(entries);
}

/** Write one approval record instead of the whole store. */
function saveOne(entry) {
  db.save(entry);
  return entry;
}

function emptyStage() {
  return { submitted: false, submittedAt: null, data: null, pdComments: [], skipped: false, skippedAt: null };
}

function getOrCreateByPoNumber(poNumber, sku) {
  // One row, not the whole store.
  let entry = db.get(String(poNumber).trim().toLowerCase());
  if (!entry) {
    entry = {
      poNumber, sku: sku || null,
      sampleApproval: emptyStage(),
      preProductionApproval: emptyStage(),
      bulkApproval: emptyStage()
    };
    saveOne(entry);
  }
  return entry;
}

function getByPoNumber(poNumber) {
  if (!poNumber) return null;
  const norm = String(poNumber).trim().toLowerCase();
  return db.get(norm);
}

/** Most recent COMPLETED Sample Approval for any other PO of the same SKU -
 *  used to pre-fill/reference a new PO's Sample Approval so the China QA team
 *  doesn't redo work for PO2, PO3, etc. of the same product. */
function getPriorSampleApprovalForSku(sku, excludePoNumber) {
  if (!sku) return null;
  const norm = String(sku).trim().toLowerCase();
  // Narrowed by the sku index rather than scanning every approval.
  const candidates = db.findBy('sku', norm)
    .filter((e) => e.sku && String(e.sku).trim().toLowerCase() === norm
      && (!excludePoNumber || String(e.poNumber).trim().toLowerCase() !== String(excludePoNumber).trim().toLowerCase())
      && e.sampleApproval && e.sampleApproval.submitted)
    .sort((a, b) => new Date(b.sampleApproval.submittedAt) - new Date(a.sampleApproval.submittedAt));
  return candidates.length ? { poNumber: candidates[0].poNumber, ...candidates[0].sampleApproval } : null;
}

function updateStage(poNumber, sku, stageKey, data) {
  // One row, not the whole store.
  let entry = db.get(String(poNumber).trim().toLowerCase());
  if (!entry) {
    entry = { poNumber, sku: sku || null, sampleApproval: emptyStage(), preProductionApproval: emptyStage(), bulkApproval: emptyStage() };
  }
  if (sku && !entry.sku) entry.sku = sku;
  entry[stageKey] = { submitted: true, submittedAt: new Date().toISOString(), data, pdComments: (entry[stageKey] && entry[stageKey].pdComments) || [], skipped: false, skippedAt: null };
  saveOne(entry);
  return entry;
}

/** Marks a stage as deliberately bypassed rather than pending - used for
 *  Pre-Production Approval on repeat POs of an already-established product,
 *  where the team typically goes straight from Golden Sample to Bulk. Kept
 *  as a distinct state from "not yet submitted" so it's clear this was an
 *  intentional decision, not something overlooked. */
function skipStage(poNumber, stageKey) {
  // One row, not the whole store.
  let entry = db.get(String(poNumber).trim().toLowerCase());
  if (!entry) {
    entry = { poNumber, sku: null, sampleApproval: emptyStage(), preProductionApproval: emptyStage(), bulkApproval: emptyStage() };
    entries.push(entry);
  }
  entry[stageKey] = { submitted: false, submittedAt: null, data: null, pdComments: [], skipped: true, skippedAt: new Date().toISOString() };
  saveOne(entry);
  return entry;
}

function addPdComment(poNumber, stageKey, comment) {
  const entry = db.get(String(poNumber).trim().toLowerCase());
  if (!entry) return null;
  if (!entry[stageKey]) entry[stageKey] = emptyStage();
  entry[stageKey].pdComments.push({ ...comment, timestamp: new Date().toISOString() });
  saveOne(entry);
  return entry;
}


/**
 * The PD approval state of one stage, expressed with the same vocabulary the
 * Asana "Sample / PP / Bulk Approval" fields use so the two read alike:
 *
 *   notStarted           nothing submitted for this stage yet
 *   waitingOnProductDev  submitted, but PD hasn't given a decision
 *   approved             PD approved it outright
 *   approvedWithIssues   PD approved but flagged issues (incl. minor issues)
 *   notApproved          PD rejected it (major/critical issues)
 *   notApplicable        the stage was explicitly skipped
 *
 * The decision comes from the most recent PD comment that carries one - a
 * later plain reply in the same thread shouldn't erase the verdict.
 */
function pdApprovalStatusForStage(stage) {
  if (!stage) return 'notStarted';
  if (stage.skipped) return 'notApplicable';
  if (!stage.submitted) return 'notStarted';
  const decided = (stage.pdComments || [])
    .filter((c) => c && c.approvalStatus)
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))[0];
  if (!decided) return 'waitingOnProductDev';
  switch (decided.approvalStatus) {
    case 'approved': return 'approved';
    case 'approvedWithComments':
    case 'minorIssue': return 'approvedWithIssues';
    case 'majorCriticalIssue': return 'notApproved';
    default: return 'waitingOnProductDev';
  }
}

/** All three stages' PD approval statuses for one PO. */
function pdApprovalStatuses(poNumber) {
  const entry = getByPoNumber(poNumber);
  return {
    sample: pdApprovalStatusForStage(entry && entry.sampleApproval),
    preProduction: pdApprovalStatusForStage(entry && entry.preProductionApproval),
    bulk: pdApprovalStatusForStage(entry && entry.bulkApproval)
  };
}

/** True when a status means PD has signed off enough for production to move
 *  on. "Approved with issues flagged" still counts as approval. */
function isPdApproved(status) {
  return status === 'approved' || status === 'approvedWithIssues';
}

/** Fold the WAL into the .db before a backup copies it. */
function checkpointDatabase() { db.checkpoint(); }

module.exports = {
  checkpointDatabase,
  pdApprovalStatusForStage, pdApprovalStatuses, isPdApproved,
  getOrCreateByPoNumber, getByPoNumber, getPriorSampleApprovalForSku, updateStage, addPdComment, skipStage,
  APPROVAL_PATH, APPROVAL_PHOTO_DIR
};

/* Import from the old flat file, at the bottom of the module so the functions
 * above are defined. See the note in lib/jsonRowDb.js on why this is not done
 * at require time. */
try {
  db.migrateOnce();
} catch (err) {
  console.error('APPROVAL STORE MIGRATION FAILED - the app is running against an empty '
    + 'approval database. The JSON file is untouched; fix this before saving anything.', err);
}
