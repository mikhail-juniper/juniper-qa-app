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

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PDF_ARCHIVE_DIR, { recursive: true });
  fs.mkdirSync(PHOTO_ARCHIVE_DIR, { recursive: true });
}

function loadLog() {
  ensureDirs();
  if (!fs.existsSync(LOG_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  } catch (err) {
    console.error('Failed to parse submission log - starting fresh. Original error:', err);
    return [];
  }
}

function saveLog(entries) {
  ensureDirs();
  fs.writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2));
}

/** Appends one submission record and returns it. */
function appendSubmission(entry) {
  const entries = loadLog();
  entries.push(entry);
  saveLog(entries);
  return entry;
}

/** All prior submissions for the same PO Number (exact match, trimmed/case-insensitive),
 *  most recent first, optionally excluding the current submission's own id. */
function findPriorReportsByPoNumber(poNumber, excludeId) {
  if (!poNumber) return [];
  const norm = String(poNumber).trim().toLowerCase();
  return loadLog()
    .filter((e) => e.poNumber && String(e.poNumber).trim().toLowerCase() === norm && e.id !== excludeId)
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
}

function getAllSubmissions() {
  return loadLog();
}

module.exports = {
  appendSubmission,
  findPriorReportsByPoNumber,
  getAllSubmissions,
  DATA_DIR,
  LOG_PATH,
  PDF_ARCHIVE_DIR,
  PHOTO_ARCHIVE_DIR
};
