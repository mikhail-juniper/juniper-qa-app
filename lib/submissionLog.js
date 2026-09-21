/**
 * Persistent log of every submitted QA/QC report - the foundation for:
 *   - "reference the previous report for this PO" on a new submission
 *   - the vendor/category analytics dashboard
 *
 * Stored as a single JSON file. Uses DATA_DIR (an env var pointing at a Render
 * persistent disk's mount path, or a local ./data folder for local dev) so this
 * survives restarts/redeploys - unlike the old default of writing next to the
 * app code, which gets wiped on Render's free tier.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const LOG_PATH = path.join(DATA_DIR, 'submissions.json');
const PDF_ARCHIVE_DIR = path.join(DATA_DIR, 'submissions');
const PHOTO_ARCHIVE_DIR = path.join(DATA_DIR, 'issue-photos');
// Inspection videos can't be embedded in a PDF, so they're archived here
// and linked from the report instead (see VIDEO section in pdfBuilder).
const VIDEO_ARCHIVE_DIR = path.join(DATA_DIR, 'issue-videos');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PDF_ARCHIVE_DIR, { recursive: true });
  fs.mkdirSync(PHOTO_ARCHIVE_DIR, { recursive: true });
  fs.mkdirSync(VIDEO_ARCHIVE_DIR, { recursive: true });
}

/* Backed by SQLite - see lib/jsonRowDb.js. Two reports per PO means ~9,400
 * records at a 4,700-PO history: 8.3 MB and ~59 ms per append on flat JSON.
 * Less urgent than approvals were, but it is an append-only log that only ever
 * grows, so it gets worse forever. */
const { createRowStore } = require('./jsonRowDb');
ensureDirs();
const db = createRowStore({
  dataDir: DATA_DIR,
  file: 'submissions.db',
  table: 'submissions',
  idOf: (e) => e.id,
  columns: {
    po_number: (e) => (e.poNumber ? String(e.poNumber).trim().toLowerCase() : null),
    sku: (e) => (e.sku ? String(e.sku).trim().toLowerCase() : null),
    qa_type: (e) => e.qaType || null
  },
  legacyPath: LOG_PATH
});

function loadLog() {
  return db.all();
}

/** Wholesale replace - restore from backup only. */
function saveLog(entries) {
  db.replaceAll(entries);
}

/** Appends one submission record and returns it. */
function appendSubmission(entry) {
  // One row appended, not the whole log rewritten.
  db.save(entry);
  return entry;
}


/** All prior submissions for the same PO Number (exact match, trimmed/case-insensitive),
 *  most recent first, optionally excluding the current submission's own id. */
function findPriorReportsByPoNumber(poNumber, excludeId) {
  if (!poNumber) return [];
  const norm = String(poNumber).trim().toLowerCase();
  // Narrowed by the po_number index rather than scanning every report.
  return db.findBy('po_number', norm)
    .filter((e) => e.poNumber && String(e.poNumber).trim().toLowerCase() === norm && e.id !== excludeId)
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
}

/** All prior submissions for the same SKU, across every PO of that product
 *  (not just one PO) - most recent first. This is what Pre-Production/Bulk
 *  Sampling Reporting reference now, since the same product often spans
 *  multiple purchase orders (PO2, PO3, ...) and issues found on an earlier
 *  PO are still relevant context. */
function findPriorReportsBySku(sku, excludeId) {
  if (!sku) return [];
  const norm = String(sku).trim().toLowerCase();
  return db.findBy('sku', norm)
    .filter((e) => e.sku && String(e.sku).trim().toLowerCase() === norm && e.id !== excludeId)
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
}

function getAllSubmissions() {
  return loadLog();
}

module.exports = {
  appendSubmission,
  findPriorReportsByPoNumber,
  findPriorReportsBySku,
  getAllSubmissions,
  DATA_DIR,
  LOG_PATH,
  PDF_ARCHIVE_DIR,
  PHOTO_ARCHIVE_DIR,
  VIDEO_ARCHIVE_DIR
};

/* ---- Revised Unit Reports ----
 * Follow-ups confirming that previously-flagged units were repaired. Kept in
 * their own file rather than mixed into the submission log, because they are
 * not inspections and should not be counted as one by analytics. */
const REVISED_PATH = path.join(DATA_DIR, 'revisedReports.json');
const REVISED_PHOTO_DIR = path.join(DATA_DIR, 'revised-photos');

function loadRevised() {
  if (!fs.existsSync(REVISED_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(REVISED_PATH, 'utf8')); }
  catch (err) { console.error('Could not read revisedReports.json:', err.message || err); return []; }
}

function saveRevisedPhoto(poNumber, file) {
  fs.mkdirSync(REVISED_PHOTO_DIR, { recursive: true });
  const safe = String(poNumber).replace(/[^A-Za-z0-9_-]/g, '_');
  const name = `${safe}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${path.extname(file.originalname || '') || '.jpg'}`;
  fs.writeFileSync(path.join(REVISED_PHOTO_DIR, name), file.buffer);
  return `/revised-photos/${encodeURIComponent(name)}`;
}

function appendRevisedReport(entry) {
  const all = loadRevised();
  const record = { id: `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ...entry };
  all.push(record);
  fs.writeFileSync(REVISED_PATH, JSON.stringify(all, null, 2));
  return record;
}

/** All revised reports, or just one PO's when a number is given. */
function findRevisedReports(poNumber) {
  const all = loadRevised();
  return poNumber ? all.filter((r) => r.poNumber === poNumber) : all;
}

module.exports.saveRevisedPhoto = saveRevisedPhoto;
module.exports.appendRevisedReport = appendRevisedReport;
module.exports.findRevisedReports = findRevisedReports;
module.exports.REVISED_PHOTO_DIR = REVISED_PHOTO_DIR;

/** Fold the WAL into the .db before a backup copies it. */
function checkpointDatabase() { db.checkpoint(); }
module.exports.checkpointDatabase = checkpointDatabase;

/* Import from the old flat file - at the bottom of the module by design. */
try {
  db.migrateOnce();
} catch (err) {
  console.error('SUBMISSION LOG MIGRATION FAILED - report history is empty. '
    + 'The JSON file is untouched; fix this before submitting anything.', err);
}
