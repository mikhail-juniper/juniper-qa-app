#!/usr/bin/env node
/**
 * Build verification.
 *
 * This session shipped changes in many small batches, and a single missed file
 * produces exactly the symptoms that are hardest to diagnose: a feature's
 * button exists but its endpoint 500s, or the UI is a version behind the logic
 * it depends on. Rather than guess, each file is checked for a marker string
 * that only exists in its current version.
 *
 * Run from the project root:  node scripts/verify-build.js
 */
const fs = require('fs');
const path = require('path');

const CHECKS = [
  // --- storage ---
  ['lib/orderDb.js', 'CREATE TABLE IF NOT EXISTS orders', 'Orders SQLite store'],
  ['lib/jsonRowDb.js', 'createRowStore', 'Reusable SQLite row store'],
  ['lib/orderManagementStore.js', 'orderDb.saveOne', 'Orders on SQLite'],
  ['lib/orderManagementStore.js', 'qualifyPartName', 'Product - Part naming'],
  ['lib/orderManagementStore.js', 'setQaReportSetup', 'Setup Report Link storage'],
  ['lib/orderManagementStore.js', 'qaSubmitted', 'Completed-report gate data'],
  ['lib/approvalStore.js', "file: 'approvals.db'", 'Approvals on SQLite'],
  ['lib/submissionLog.js', "file: 'submissions.db'", 'Submission log on SQLite'],
  ['lib/submissionLog.js', 'appendRevisedReport', 'Revised Unit Reports'],
  ['lib/componentDefinitionStore.js', "file: 'componentDefinitions.db'", 'Definitions on SQLite'],
  ['lib/qaDraftStore.js', 'sweepOldDrafts', 'Draft photos + saved state'],

  // --- scoring ---
  ['lib/passFail.js', 'thresholdMinor', 'Rate thresholds (server)'],
  ['lib/passFail.js', 'resolution: \'repaired\'', 'Dispositions applied server-side'],
  ['lib/analytics.js', 'summarizeBoth', 'Analytics initial/final split'],
  ['lib/analytics.js', 'paperGoods', 'Paper Goods in analytics'],
  ['config/aql.json', 'failThresholds', 'Fail thresholds config'],

  // --- report app ---
  ['public/app.js', 'rateFailures', 'Rate thresholds (client)'],
  ['public/app.js', 'renderDispositionStep', 'Disposition step'],
  ['public/app.js', 'btnSaveDraft', 'Save button'],
  ['public/app.js', 'uploadDraftPhoto', 'Photos upload as taken'],
  ['public/app.js', 'renderCompletedReportGate', 'One report per link'],
  ['public/app.js', 'renderRevisedUnitReport', 'Revised Unit Report'],
  ['public/app.js', 'stepApplies', 'Skips sizing where it does not apply'],
  // The review screen must not demand dimensions for a step the product skips.
  ['public/app.js', "state.category !== 'apparel' && stepApplies('sizing')", 'Review skips dimensions for plush'],
  ['public/app.js', 'groups.find((g) => g.category === state.category)', 'Question fallback for retired subcategories'],
  ['public/app.js', 'displaySizeName', 'Age brackets stripped'],

  // --- order management ---
  ['public/order-management.js', 'openQaSetupDialog', 'Setup Report Link dialog'],
  ['public/order-management.js', 'askForSourceLink', 'Drive link on upload'],
  ['public/order-management.js', 'revisedReportsHtml', 'Revised reports listed'],
  ['public/order-management.js', 'om-acc-image-relink-btn', 'Relink sub-component photo'],

  // --- server ---
  ['server.js', '/api/qa/draft/:draftId/state', 'Save and resume endpoints'],
  ['server.js', '/api/submit-revised', 'Revised report endpoint'],
  ['server.js', 'dispositionSummary', 'Disposition recorded on submissions'],
  ['server.js', 'storeAsPreviewOnly', 'Preview-only file storage'],
  ['server.js', 'Category mismatch', 'Category consistency check'],
  ['server.js', 'checkpointDatabase', 'Backup checkpoints SQLite'],

  // --- config / content ---
  ['config/reportQuestions.json', 'guidance_zh', 'Bilingual question bank'],
  ['config/conditionalChecks.json', 'byCategory', 'Conditional checks'],
  ['config/tolerances.json', 'sizingCm', 'Three-column tolerances'],
  ['config/categories.json', 'paperGoods', 'Paper Goods category'],
  ['config/i18n.json', 'dispositionTitle', 'Disposition strings'],
  ['config/i18n.json', 'draftSaved', 'Save/resume strings'],

  // --- pdf ---
  ['lib/pdfBuilder.js', 'dispositionSection', 'PDF shows resolutions'],
  ['lib/pdfBuilder.js', 'inspectionSections', 'PDF renders the new steps'],
  ['lib/consolidatedReportBuilder.js', 'Revised Unit Reports', 'Merged PDF includes revisions']
];

const root = process.cwd();
let missingFiles = 0;
let stale = 0;
const staleFiles = new Set();

console.log('Checking the deployed files against what this build expects.\n');

for (const [file, marker, label] of CHECKS) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    console.log(`  MISSING FILE  ${file.padEnd(38)} ${label}`);
    missingFiles += 1;
    continue;
  }
  const body = fs.readFileSync(full, 'utf8');
  if (!body.includes(marker)) {
    console.log(`  OUT OF DATE   ${file.padEnd(38)} ${label}`);
    stale += 1;
    staleFiles.add(file);
  }
}

// better-sqlite3 is a native module; without it every store call throws at
// require time and the app will not start at all.
try {
  require('better-sqlite3');
} catch (err) {
  console.log('\n  better-sqlite3 is not installed or not built for this Node version.');
  console.log('  Run: npm install');
  missingFiles += 1;
}

console.log();
if (!missingFiles && !stale) {
  console.log('All checks passed - every file is the current version.');
} else {
  console.log(`${stale} file(s) out of date, ${missingFiles} missing.`);
  if (staleFiles.size) {
    console.log('\nRe-copy these and restart:');
    [...staleFiles].sort().forEach((f) => console.log('  ' + f));
  }
  process.exitCode = 1;
}
