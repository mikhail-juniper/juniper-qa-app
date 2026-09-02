require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');

const { buildPdf } = require('./lib/pdfBuilder');
const { computeOverallResult, collectAllDefects } = require('./lib/passFail');
const { getRecommendation } = require('./lib/aqlRecommendation');
const submissionLog = require('./lib/submissionLog');
const poStore = require('./lib/poStore');
const orderManagementStore = require('./lib/orderManagementStore');
const sizingChartStore = require('./lib/sizingChartStore');
const supplierStore = require('./lib/supplierStore');
const approvalStore = require('./lib/approvalStore');
const approvalPhotoSets = require('./config/approvalPhotoSets.json');
const asanaClient = require('./lib/asanaClient');
const AdmZip = require('adm-zip');
const ASANA_FIELD_MAP_PATH = path.join(__dirname, 'config', 'asanaFieldMap.json');
function loadAsanaFieldMap() { return loadJson(ASANA_FIELD_MAP_PATH); }

/** Picks the right named photo-slot set for a product: apparel and plush by
 *  top-level category, "book" for Notebook/Sketchbook (an accessories
 *  subcategory), everything else falls back to the default set. */
function resolvePhotoSet(category, subcategory) {
  if (category === 'apparel') return approvalPhotoSets.sets.apparel;
  if (category === 'plush') return approvalPhotoSets.sets.plush;
  if (subcategory === 'notebook') return approvalPhotoSets.sets.book;
  return approvalPhotoSets.sets.default;
}
const analytics = require('./lib/analytics');
let fits = require('./config/fits.json');
const i18n = require('./config/i18n.json');
const categories = require('./config/categories.json');
const aqlTable = require('./config/aql.json');

const OPTIONS_PATH = path.join(__dirname, 'config', 'options.json');
const CREATOR_TIERS_PATH = path.join(__dirname, 'config', 'creatorTiers.json');
const AQL_RECOMMENDATION_PATH = path.join(__dirname, 'config', 'aqlRecommendation.json');
const UNIT_COSTS_PATH = path.join(__dirname, 'config', 'unitCosts.json');
const FITS_PATH = path.join(__dirname, 'config', 'fits.json');
const EDITABLE_OPTION_LISTS = ['creators', 'factoryCodes', 'qaLeads', 'productDevelopmentLeads'];

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function saveJson(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2)); }
function loadOptions() { return loadJson(OPTIONS_PATH); }
function saveOptions(newOptions) { saveJson(OPTIONS_PATH, newOptions); }

/** If someone types a value that isn't already in one of the editable
 *  dropdown lists (Factory Code, QA/QC Lead, Product Development Lead),
 *  save it so it shows up as an option for everyone going forward. Case-
 *  insensitive match to avoid near-duplicates like "chloe" vs "Chloe". */
function addNewOptionIfMissing(listKey, value) {
  const trimmed = value && String(value).trim();
  if (!trimmed) return;
  const options = loadOptions();
  if (!Array.isArray(options[listKey])) return;
  const alreadyExists = options[listKey].some((v) => String(v).trim().toLowerCase() === trimmed.toLowerCase());
  if (alreadyExists) return;
  options[listKey].push(trimmed);
  saveOptions(options);
}

/** Puts a PO's selected sizes in Youth XS -> Adult 5XL order (matching
 *  fits.json's universalSizes) instead of whatever order they were clicked
 *  in on the New Purchase Order form. */
function sortSizesCanonically(sizes) {
  const canonical = (fits && fits.universalSizes) || [];
  return [...(sizes || [])].sort((a, b) => {
    const ia = canonical.indexOf(a);
    const ib = canonical.indexOf(b);
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

const app = express();
// Render (and most hosts) sit behind a proxy that terminates HTTPS and
// forwards requests internally as HTTP - without this, req.protocol would
// incorrectly report "http" even for a real HTTPS visitor, which matters
// for building the correct absolute approval link sent to Asana below.
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

// ---- Storage for uploaded photos (temp, per-submission) ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 60 } // 15MB/photo, 60 photos max per submission
});

// Separate, much larger limit specifically for restoring a downloaded
// backup zip - these accumulate PDFs and photos over time and can be far
// bigger than any single photo upload.
const uploadBackup = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB
});

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Serve generated PDFs so they can be viewed/downloaded - backed by the
// persistent DATA_DIR (see lib/submissionLog.js) so these survive restarts
// once a persistent disk is attached (e.g. on Render's paid tier).
app.use('/submissions', express.static(submissionLog.PDF_ARCHIVE_DIR));
app.use('/issue-photos', express.static(submissionLog.PHOTO_ARCHIVE_DIR));
app.use('/approval-photos', express.static(approvalStore.APPROVAL_PHOTO_DIR));
app.use('/order-management-files', express.static(orderManagementStore.ORDER_FILES_DIR));

// Order Management file uploads (style pictures, design docs, packing lists)
// write straight to disk under DATA_DIR/order-management-files/<orderId>/,
// unlike the QA/QC photo uploads above which buffer in memory first - these
// can include larger design files, so streaming to disk avoids holding them
// all in memory at once.
const uploadOrderFile = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(orderManagementStore.ORDER_FILES_DIR, req.params.id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
  }),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB per file
});

// Serve the fit library + translations + dropdown options + category tree + AQL
// reference table + creator tiers + recommendation table + unit costs to the frontend
// ---- Backup: download everything in DATA_DIR as a zip, and check where
// data is actually being read/written from (helps confirm the persistent
// disk is actually wired up correctly, since a misconfigured DATA_DIR is
// silently invisible otherwise - everything looks fine until a deploy wipes
// it). Do this BEFORE trusting DATA_DIR with real data, and periodically
// as an extra safety net even once it's confirmed working. ----
app.get('/api/backup/status', (req, res) => {
  // Catches both "DATA_DIR isn't set at all" and "DATA_DIR is set but still
  // a relative path" - the second one matters because .env.example ships
  // with DATA_DIR=./data as a documented local-dev default, so someone
  // could have DATA_DIR "set" on Render and still be pointed at a folder
  // that lives inside the app code (wiped on every deploy) rather than an
  // actual persistent disk mount, which is always an absolute path.
  const raw = process.env.DATA_DIR;
  const isUnsetOrRelative = !raw || !path.isAbsolute(raw);
  let diskFree = null;
  try {
    const stat = fs.statfsSync ? fs.statfsSync(submissionLog.DATA_DIR) : null;
    if (stat) diskFree = Math.round((stat.bfree * stat.bsize) / (1024 * 1024));
  } catch (e) { /* statfsSync may not exist on all platforms; not critical */ }
  res.json({
    resolvedDataDir: submissionLog.DATA_DIR,
    usingDefaultLocalFolder: isUnsetOrRelative,
    warning: isUnsetOrRelative
      ? (!raw
          ? 'DATA_DIR is not set - this is using a local folder next to the app code, which Render wipes on every deploy. Set DATA_DIR to your persistent disk\'s mount path (an absolute path, e.g. /var/data) in the Environment tab.'
          : `DATA_DIR is set to "${raw}", which is a relative path - it still resolves to a folder next to the app code, not a persistent disk, so it will be wiped on every deploy. Set it to your disk's absolute mount path instead (e.g. /var/data).`)
      : null,
    freeDiskSpaceMb: diskFree
  });
});

app.get('/api/backup/download', (req, res) => {
  const dir = submissionLog.DATA_DIR;
  const filename = `juniper-qa-backup-${new Date().toISOString().slice(0, 10)}.zip`;
  res.attachment(filename);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('Backup zip failed:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to build backup', detail: String(err.message || err) });
  });
  archive.pipe(res);
  if (fs.existsSync(dir)) archive.directory(dir, false);
  archive.finalize();
});

/** Restores POs (and their approvals, submission history, and referenced
 *  photos/PDFs) from a previously downloaded backup zip - merging into the
 *  current data rather than replacing it wholesale. Any PO in the backup
 *  that isn't already in the live data gets added. For a PO that already
 *  exists, "mode" decides what happens: 'override' replaces the live
 *  record (and its approvals/submissions) with the backup's version;
 *  'ignore' (the default, and the safer choice) leaves the live version
 *  untouched. Photo/PDF files are copied for any added-or-overridden PO;
 *  the shared JSON files are only rewritten once, at the end, so a bad
 *  entry partway through the zip can't leave the data half-updated. */
app.post('/api/backup/upload', uploadBackup.single('backup'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No backup file provided' });
    const mode = req.body.mode === 'override' ? 'override' : 'ignore';

    let zip;
    try {
      zip = new AdmZip(req.file.buffer);
    } catch (err) {
      return res.status(400).json({ error: 'That file does not look like a valid zip archive' });
    }
    const entries = zip.getEntries();

    const readJsonEntry = (name) => {
      const entry = entries.find((e) => e.entryName === name);
      if (!entry) return null;
      try { return JSON.parse(entry.getData().toString('utf8')); } catch { return null; }
    };
    const backupPOs = readJsonEntry('purchaseOrders.json');
    if (!Array.isArray(backupPOs)) {
      return res.status(400).json({ error: "This doesn't look like a Juniper QA backup - purchaseOrders.json is missing or invalid." });
    }
    const backupApprovals = readJsonEntry('approvals.json') || [];
    const backupSubmissions = readJsonEntry('submissions.json') || [];

    const dataDir = submissionLog.DATA_DIR;
    const poPath = path.join(dataDir, 'purchaseOrders.json');
    const approvalsPath = path.join(dataDir, 'approvals.json');
    const submissionsPath = path.join(dataDir, 'submissions.json');
    const livePOs = fs.existsSync(poPath) ? JSON.parse(fs.readFileSync(poPath, 'utf8')) : [];
    const liveApprovals = fs.existsSync(approvalsPath) ? JSON.parse(fs.readFileSync(approvalsPath, 'utf8')) : [];
    const liveSubmissions = fs.existsSync(submissionsPath) ? JSON.parse(fs.readFileSync(submissionsPath, 'utf8')) : [];

    const norm = (s) => String(s || '').trim().toLowerCase();
    const affected = new Set(); // PO numbers being added or overridden - their approvals/submissions/files come along too
    let added = 0, overridden = 0, skipped = 0;

    backupPOs.forEach((po) => {
      const key = norm(po.poNumber);
      const existingIdx = livePOs.findIndex((p) => norm(p.poNumber) === key);
      if (existingIdx === -1) {
        livePOs.push(po);
        added++;
        affected.add(key);
      } else if (mode === 'override') {
        livePOs[existingIdx] = po;
        overridden++;
        affected.add(key);
      } else {
        skipped++;
      }
    });

    backupApprovals.forEach((a) => {
      if (!affected.has(norm(a.poNumber))) return;
      const idx = liveApprovals.findIndex((x) => norm(x.poNumber) === norm(a.poNumber));
      if (idx === -1) liveApprovals.push(a); else liveApprovals[idx] = a;
    });

    backupSubmissions.forEach((s) => {
      if (!affected.has(norm(s.poNumber))) return;
      const idx = liveSubmissions.findIndex((x) => x.submissionId === s.submissionId);
      if (idx === -1) liveSubmissions.push(s); else liveSubmissions[idx] = s;
    });

    // Copy every file from the backup's photo/PDF folders - filenames
    // already carry a random ID (see saveApprovalPhotos, etc.), so
    // collisions with unrelated, already-current files are effectively
    // impossible. Simpler and safer than trying to filter by PO number
    // against a filename convention that could drift over time.
    const extractDir = (zipFolder, diskDir) => {
      const inZip = entries.filter((e) => !e.isDirectory && e.entryName.startsWith(zipFolder + '/'));
      if (!inZip.length) return;
      fs.mkdirSync(diskDir, { recursive: true });
      inZip.forEach((e) => {
        const filename = e.entryName.slice(zipFolder.length + 1);
        if (!filename || filename.includes('/')) return;
        fs.writeFileSync(path.join(diskDir, filename), e.getData());
      });
    };
    extractDir('approval-photos', approvalStore.APPROVAL_PHOTO_DIR);
    extractDir('submissions', submissionLog.PDF_ARCHIVE_DIR);
    extractDir('issue-photos', submissionLog.PHOTO_ARCHIVE_DIR);

    fs.writeFileSync(poPath, JSON.stringify(livePOs, null, 2));
    fs.writeFileSync(approvalsPath, JSON.stringify(liveApprovals, null, 2));
    fs.writeFileSync(submissionsPath, JSON.stringify(liveSubmissions, null, 2));

    res.json({ ok: true, added, overridden, skipped, mode });
  } catch (err) {
    console.error('Backup upload failed:', err);
    res.status(500).json({ error: 'Failed to process backup upload', detail: String(err.message || err) });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    fits,
    i18n,
    options: loadOptions(),
    categories,
    aql: aqlTable,
    creatorTiers: loadJson(CREATOR_TIERS_PATH),
    aqlRecommendation: loadJson(AQL_RECOMMENDATION_PATH),
    unitCosts: loadJson(UNIT_COSTS_PATH)
  });
});

// ---- Settings: creator tiers (name -> 1/2/3) ----
app.get('/api/creator-tiers', (req, res) => res.json(loadJson(CREATOR_TIERS_PATH)));
app.post('/api/creator-tiers', (req, res) => {
  try {
    const current = loadJson(CREATOR_TIERS_PATH);
    const body = req.body || {};
    if (body.tiers && typeof body.tiers === 'object') {
      const cleaned = {};
      Object.entries(body.tiers).forEach(([name, tier]) => {
        const n = String(name).trim();
        const t = parseInt(tier, 10);
        if (n && [1, 2, 3].includes(t)) cleaned[n] = t;
      });
      current.tiers = cleaned;
    }
    if (body.defaultTier && [1, 2, 3].includes(parseInt(body.defaultTier, 10))) {
      current.defaultTier = parseInt(body.defaultTier, 10);
    }
    saveJson(CREATOR_TIERS_PATH, current);
    res.json({ ok: true, creatorTiers: current });
  } catch (err) {
    console.error('Failed to save creator tiers:', err);
    res.status(500).json({ error: 'Failed to save creator tiers', detail: String(err.message || err) });
  }
});

// ---- Settings: AQL recommendation table (Tier x Risk x PO Size) ----
app.get('/api/aql-recommendation', (req, res) => res.json(loadJson(AQL_RECOMMENDATION_PATH)));
app.post('/api/aql-recommendation', (req, res) => {
  try {
    const current = loadJson(AQL_RECOMMENDATION_PATH);
    const body = req.body || {};
    if (body.table && typeof body.table === 'object') {
      ['1', '2', '3'].forEach((tier) => {
        if (!body.table[tier]) return;
        ['high', 'medium', 'low'].forEach((risk) => {
          if (!body.table[tier][risk]) return;
          ['>20k', '5-20k', '<5k'].forEach((band) => {
            const cell = body.table[tier][risk][band];
            if (cell && cell.pointCheck && [1, 2, 3].includes(parseInt(cell.inspectionLevel, 10))) {
              current.table[tier][risk][band] = {
                pointCheck: String(cell.pointCheck).trim(),
                inspectionLevel: parseInt(cell.inspectionLevel, 10)
              };
            }
          });
        });
      });
    }
    saveJson(AQL_RECOMMENDATION_PATH, current);
    res.json({ ok: true, aqlRecommendation: current });
  } catch (err) {
    console.error('Failed to save AQL recommendation table:', err);
    res.status(500).json({ error: 'Failed to save AQL recommendation table', detail: String(err.message || err) });
  }
});

// ---- Settings: unit costs (category/subcategory -> $) ----
app.get('/api/unit-costs', (req, res) => res.json(loadJson(UNIT_COSTS_PATH)));
app.post('/api/unit-costs', (req, res) => {
  try {
    const current = loadJson(UNIT_COSTS_PATH);
    const body = req.body || {};
    if (body.categories && typeof body.categories === 'object') {
      Object.entries(body.categories).forEach(([cat, subs]) => {
        if (!current.categories[cat] || typeof subs !== 'object') return;
        Object.entries(subs).forEach(([sub, cost]) => {
          const n = parseFloat(cost);
          if (!isNaN(n) && n >= 0) current.categories[cat][sub] = n;
        });
      });
    }
    if (body.otherCategoryFlat !== undefined) {
      const n = parseFloat(body.otherCategoryFlat);
      if (!isNaN(n) && n >= 0) current.otherCategoryFlat = n;
    }
    saveJson(UNIT_COSTS_PATH, current);
    res.json({ ok: true, unitCosts: current });
  } catch (err) {
    console.error('Failed to save unit costs:', err);
    res.status(500).json({ error: 'Failed to save unit costs', detail: String(err.message || err) });
  }
});

// ---- Settings: apparel sizing charts (fits.json) ----
app.get('/api/fits', (req, res) => res.json(fits));
app.post('/api/fits', (req, res) => {
  try {
    const body = req.body || {};
    if (!body.fits || typeof body.fits !== 'object') {
      return res.status(400).json({ error: 'fits object is required' });
    }
    const current = loadJson(FITS_PATH);
    const cleanedFits = {};
    Object.entries(body.fits).forEach(([key, fit]) => {
      if (!key || !fit || typeof fit !== 'object') return;
      const points = Array.isArray(fit.points) ? fit.points.filter((p) => typeof p === 'string' && p) : [];
      const pointLabels = {};
      points.forEach((p) => {
        const pl = (fit.pointLabels && fit.pointLabels[p]) || {};
        pointLabels[p] = { en: String(pl.en || p), zh: String(pl.zh || '') };
      });
      const sizes = {};
      if (fit.sizes && typeof fit.sizes === 'object') {
        Object.entries(fit.sizes).forEach(([sizeName, values]) => {
          if (!sizeName || !values || typeof values !== 'object') return;
          const cleanValues = {};
          points.forEach((p) => {
            const v = values[p];
            if (v === undefined || v === null || v === '') return;
            if (typeof v === 'object' && v.min !== undefined && v.max !== undefined) {
              const min = parseFloat(v.min), max = parseFloat(v.max);
              if (!isNaN(min) && !isNaN(max)) cleanValues[p] = { min, max };
            } else {
              const n = parseFloat(v);
              if (!isNaN(n)) cleanValues[p] = n;
            }
          });
          sizes[sizeName] = cleanValues;
        });
      }
      cleanedFits[key] = {
        label_en: String(fit.label_en || key),
        label_zh: String(fit.label_zh || ''),
        group: String(fit.group || 'other'),
        points,
        pointLabels,
        sizes
      };
    });
    current.fits = cleanedFits;
    saveJson(FITS_PATH, current);
    fits = current; // update the in-memory copy so this takes effect without a restart
    res.json({ ok: true, fits: current });
  } catch (err) {
    console.error('Failed to save fits:', err);
    res.status(500).json({ error: 'Failed to save fits', detail: String(err.message || err) });
  }
});

// ---- Settings: read/update the editable dropdown option lists ----
// (creators, factoryCodes, qaLeads - pointCheckRates is a fixed scale, not editable here)
app.get('/api/options', (req, res) => {
  res.json(loadOptions());
});

app.post('/api/options', (req, res) => {
  try {
    const current = loadOptions();
    const body = req.body || {};
    EDITABLE_OPTION_LISTS.forEach((key) => {
      if (Array.isArray(body[key])) {
        const cleaned = body[key]
          .map((v) => String(v).trim())
          .filter((v) => v.length > 0);
        // de-dupe while preserving order
        current[key] = [...new Set(cleaned)];
      }
    });
    saveOptions(current);
    res.json({ ok: true, options: current });
  } catch (err) {
    console.error('Failed to save options:', err);
    res.status(500).json({ error: 'Failed to save options', detail: String(err.message || err) });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ---- Submission endpoint ----
// Accepts multipart form-data:
//   payload: JSON string (see public/app.js buildSubmissionPayload)
//   files: all photos, each with a fieldname that maps back to the payload
app.post('/api/submit', upload.any(), async (req, res) => {
  try {
    if (!req.body.payload) {
      return res.status(400).json({ error: 'Missing payload' });
    }
    const payload = JSON.parse(req.body.payload);
    addNewOptionIfMissing('qaLeads', payload.qaLead);
    const files = req.files || [];

    // Group files by their logical field name (set client-side)
    const filesByField = {};
    for (const f of files) {
      if (!filesByField[f.fieldname]) filesByField[f.fieldname] = [];
      filesByField[f.fieldname].push(f);
    }

    const submissionId = uuidv4();
    // Pull this PO's own established Golden Sample sizing (if any) so the
    // pass/fail tolerance check compares against the actual approved
    // measurements for this product, not just the generic fit template.
    const approvalRecord = approvalStore.getByPoNumber(payload.poNumber);
    const establishedSizing = (approvalRecord && approvalRecord.sampleApproval && approvalRecord.sampleApproval.submitted)
      ? approvalRecord.sampleApproval.data.sizing
      : null;
    const overallResult = computeOverallResult(payload, fits, establishedSizing);
    const recommendation = getRecommendation(
      { category: payload.category, subcategory: payload.subcategory, poQuantity: payload.poQuantity, creator: payload.creator, risk: payload.productRisk },
      { unitCosts: loadJson(UNIT_COSTS_PATH), aqlRecConfig: loadJson(AQL_RECOMMENDATION_PATH), creatorTiersConfig: loadJson(CREATOR_TIERS_PATH) }
    );
    const pdfBuffer = await buildPdf(payload, filesByField, fits, i18n, overallResult, categories, recommendation, establishedSizing);

    const fileSafePo = (payload.poNumber || 'QA-Report').replace(/[^a-z0-9\-_]+/gi, '_');
    const pdfFilename = `${fileSafePo}_QA_Report_${submissionId.slice(0, 8)}.pdf`;

    // Persist a copy so it can be viewed/downloaded, and referenced later by the
    // report-history and analytics features - now always on, backed by the
    // persistent DATA_DIR rather than the old test-mode-only local folder.
    fs.mkdirSync(submissionLog.PDF_ARCHIVE_DIR, { recursive: true });
    fs.writeFileSync(path.join(submissionLog.PDF_ARCHIVE_DIR, pdfFilename), pdfBuffer);
    const pdfUrl = `/submissions/${encodeURIComponent(pdfFilename)}`;

    // Log this submission for the "reference the previous report" feature and
    // the analytics dashboard. Each defect's first photo is saved separately
    // (in addition to living in the PDF) so the prior-report card can show it
    // inline without needing to open the full PDF.
    fs.mkdirSync(submissionLog.PHOTO_ARCHIVE_DIR, { recursive: true });
    const issuesWithPhotos = collectAllDefects(payload).map((d) => {
      let photoUrl = null;
      const photoFiles = filesByField[`photo_defect_${d.id}`];
      if (photoFiles && photoFiles.length) {
        const photoFilename = `${submissionId}_${d.id}.jpg`;
        fs.writeFileSync(path.join(submissionLog.PHOTO_ARCHIVE_DIR, photoFilename), photoFiles[0].buffer);
        photoUrl = `/issue-photos/${encodeURIComponent(photoFilename)}`;
      }
      return {
        description: d.description || '', severity: d.severity,
        unitsAffected: parseInt(d.unitsAffected, 10) || 1, photoUrl
      };
    });

    submissionLog.appendSubmission({
      id: submissionId,
      poNumber: payload.poNumber || null,
      sku: payload.sku || (poStore.getPoByNumber(payload.poNumber) || {}).sku || null,
      category: payload.category || null,
      subcategory: payload.subcategory || null,
      creator: payload.creator || null,
      factoryCode: payload.factoryCode || null,
      qaLead: payload.qaLead || null,
      productTitle: payload.productTitle || null,
      productRisk: payload.productRisk || null,
      materials: payload.materials || null,
      printingMethod: payload.printingMethod || null,
      qaType: payload.qaType || null,
      date: payload.date || null,
      submittedAt: new Date().toISOString(),
      poQuantity: payload.poQuantity ? parseInt(payload.poQuantity, 10) : null,
      actualUnitsChecked: payload.actualUnitsChecked ? parseInt(payload.actualUnitsChecked, 10) : null,
      overallResult: overallResult.overall,
      reasons: overallResult.reasons,
      recap: (overallResult.aql && overallResult.aql.recap) ? overallResult.aql.recap : null,
      criticalCount: overallResult.aql ? overallResult.aql.criticalCount : 0,
      majorCount: overallResult.aql ? overallResult.aql.majorCount : 0,
      minorCount: overallResult.aql ? overallResult.aql.minorCount : 0,
      pdfFilename,
      issues: issuesWithPhotos,
      // Sizing detail carried forward for pre-filling a later report on the same
      // PO - text/numbers only, since photos are physical evidence tied to a
      // specific inspection and shouldn't be silently reused.
      sizingCarryForward: {
        fit: (payload.categoryData && payload.categoryData.fit) || null,
        sizeRows: (payload.categoryData && payload.categoryData.sizeRows) || [],
        customSizeRows: (payload.categoryData && payload.categoryData.customSizeRows) || [],
        simpleSizeValue: (payload.categoryData && payload.categoryData.simpleSizeValue) || null,
        dimensions: (payload.categoryData && payload.categoryData.dimensions) || null
      }
    });

    res.json({ ok: true, submissionId, filename: pdfFilename, pdfUrl, overallResult });
  } catch (err) {
    console.error('Submission failed:', err);
    res.status(500).json({ error: 'Failed to process submission', detail: String(err.message || err) });
  }
});

// ---- Report history: reference prior reports for the same PO or the same SKU ----
app.get('/api/submission-history/:poNumber', (req, res) => {
  try {
    const prior = submissionLog.findPriorReportsByPoNumber(req.params.poNumber, req.query.excludeId);
    res.json({ reports: prior });
  } catch (err) {
    console.error('Failed to look up submission history:', err);
    res.status(500).json({ error: 'Failed to look up submission history', detail: String(err.message || err) });
  }
});
app.get('/api/submission-history-by-sku/:sku', (req, res) => {
  try {
    const prior = submissionLog.findPriorReportsBySku(req.params.sku, req.query.excludeId);
    res.json({ reports: prior });
  } catch (err) {
    console.error('Failed to look up submission history by SKU:', err);
    res.status(500).json({ error: 'Failed to look up submission history by SKU', detail: String(err.message || err) });
  }
});

// ---- Analytics: vendor dashboard and overall category breakdown ----
function parseDateRange(query) {
  const end = query.end ? new Date(query.end) : new Date();
  const start = query.start ? new Date(query.start) : new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000);
  return { start, end };
}

app.get('/api/analytics/vendor', (req, res) => {
  try {
    if (!req.query.creator) return res.status(400).json({ error: 'creator query param is required' });
    const { start, end } = parseDateRange(req.query);
    const all = submissionLog.getAllSubmissions();
    res.json(analytics.vendorStats(all, req.query.creator, start, end));
  } catch (err) {
    console.error('Failed to compute vendor analytics:', err);
    res.status(500).json({ error: 'Failed to compute vendor analytics', detail: String(err.message || err) });
  }
});

app.get('/api/analytics/factory', (req, res) => {
  try {
    if (!req.query.factoryCode) return res.status(400).json({ error: 'factoryCode query param is required' });
    const { start, end } = parseDateRange(req.query);
    const all = submissionLog.getAllSubmissions();
    res.json(analytics.factoryStats(all, req.query.factoryCode, start, end));
  } catch (err) {
    console.error('Failed to compute factory analytics:', err);
    res.status(500).json({ error: 'Failed to compute factory analytics', detail: String(err.message || err) });
  }
});

app.get('/api/analytics/category', (req, res) => {
  try {
    const { start, end } = parseDateRange(req.query);
    const all = submissionLog.getAllSubmissions();
    res.json({ categories: analytics.categoryStats(all, start, end) });
  } catch (err) {
    console.error('Failed to compute category analytics:', err);
    res.status(500).json({ error: 'Failed to compute category analytics', detail: String(err.message || err) });
  }
});

// ---- Purchase Orders: created via "New Purchase Order", the shared source of
// truth that Pre-Production/Bulk Sampling Reporting and QA/QC Approval both
// pre-fill against. ----
/** Pulls the task GID out of any Asana task URL (the numeric ID after
 *  "/task/"), so the Asana integration can call the API directly with it
 *  regardless of which exact URL format someone pastes in. */
function extractAsanaTaskGid(link) {
  if (!link) return null;
  const match = String(link).match(/\/task\/(\d+)/);
  return match ? match[1] : null;
}

app.post('/api/purchase-orders', (req, res) => {
  try {
    const body = req.body || {};
    if (!body.poNumber || !body.sku) {
      return res.status(400).json({ error: 'poNumber and sku are required' });
    }
    if (poStore.getPoByNumber(body.poNumber)) {
      return res.status(409).json({ error: 'A PO with this number already exists' });
    }
    addNewOptionIfMissing('productDevelopmentLeads', body.productDevelopmentLead);
    addNewOptionIfMissing('creators', body.creator);
    const id = uuidv4();

    // If this SKU already has an established apparel fit from a prior PO,
    // carry it forward automatically.
    const established = body.category === 'apparel' ? poStore.getEstablishedFitForSku(body.sku) : null;

    const entry = poStore.createPo({
      id,
      poNumber: body.poNumber,
      sku: body.sku,
      category: body.category || null,
      subcategory: body.subcategory || null,
      orderDate: body.orderDate || null,
      creator: body.creator || null,
      orderQuantity: body.orderQuantity ? parseInt(body.orderQuantity, 10) : null,
      productTitle: body.productTitle || null,
      productDevelopmentLead: body.productDevelopmentLead || null,
      sizesIncluded: sortSizesCanonically(Array.isArray(body.sizesIncluded) ? body.sizesIncluded : []),
      fitKey: established ? established.fitKey : null,
      fitSizes: established ? established.sizes : [],
      asanaTaskLink: body.asanaTaskLink || null,
      asanaTaskGid: extractAsanaTaskGid(body.asanaTaskLink),
      createdAt: new Date().toISOString()
    });
    res.json({ ok: true, po: entry, approvalUrl: `/approval.html?po=${encodeURIComponent(id)}` });

    // Best-effort Asana sync: drop this PO's approval page link directly
    // onto the task's QA/QC Drive Link field, so anyone on the task can
    // click straight through without hunting for the right PO in this app.
    if (entry.asanaTaskGid) {
      const fieldMap = loadAsanaFieldMap();
      if (fieldMap.qaqcDriveLinkFieldGid) {
        const approvalLink = `${req.protocol}://${req.get('host')}/approval.html?po=${encodeURIComponent(id)}`;
        asanaClient.setTextCustomField(entry.asanaTaskGid, fieldMap.qaqcDriveLinkFieldGid, approvalLink);
      }
    }
  } catch (err) {
    console.error('Failed to create purchase order:', err);
    res.status(500).json({ error: 'Failed to create purchase order', detail: String(err.message || err) });
  }
});

app.get('/api/purchase-orders/:id', (req, res) => {
  const po = poStore.getPoById(req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  res.json({ po });
});

app.get('/api/purchase-orders', (req, res) => {
  if (req.query.poNumber) {
    const po = poStore.getPoByNumber(req.query.poNumber);
    return res.json({ pos: po ? [po] : [] });
  }
  if (req.query.sku) {
    return res.json({ pos: poStore.getPosBySku(req.query.sku) });
  }
  res.status(400).json({ error: 'poNumber or sku query param is required' });
});

app.get('/api/sku-established-fit/:sku', (req, res) => {
  res.json({ fit: poStore.getEstablishedFitForSku(req.params.sku) });
});

// ---- Order Management Hub ----
// Rebuild of the QingFlow "Order Management" workspace. See
// /docs/order-management-workflow-spec.md for the reverse-engineered
// QingFlow logic this is based on, and the design decisions that diverge
// from it (parent stays in sync, status is manually advanced).

app.get('/api/order-management/statuses', (req, res) => {
  res.json({ statuses: orderManagementStore.STATUSES });
});

app.get('/api/order-management/orders', (req, res) => {
  const { productLine, status, search } = req.query;
  res.json({ orders: orderManagementStore.listOrders({ productLine, status, search }) });
});

app.get('/api/order-management/orders/:id', (req, res) => {
  const order = orderManagementStore.getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ order });
});

app.post('/api/order-management/orders', (req, res) => {
  try {
    const body = req.body || {};
    if (!body.poNumber) return res.status(400).json({ error: 'poNumber is required' });
    const existing = orderManagementStore.getOrderByPoNumber(body.poNumber, body.productLine);
    if (existing) {
      return res.status(409).json({
        error: `A ${body.productLine || ''} PO numbered "${body.poNumber}" already exists. Open it from the list to edit instead of creating a duplicate.`,
        existingId: existing.id
      });
    }
    const entry = orderManagementStore.createOrder({ ...body, id: uuidv4() }, body.actor || req.get('X-Actor'));
    res.json({ ok: true, order: entry });
  } catch (err) {
    console.error('Failed to create order:', err);
    res.status(500).json({ error: 'Failed to create order', detail: String(err.message || err) });
  }
});

app.patch('/api/order-management/orders/:id', (req, res) => {
  const body = req.body || {};
  const actor = body.actor || req.get('X-Actor');
  const updated = orderManagementStore.updateOrder(req.params.id, body.patch || {}, actor);
  if (!updated) return res.status(404).json({ error: 'Order not found' });
  res.json({ ok: true, order: updated });
});

app.post('/api/order-management/orders/:id/status', (req, res) => {
  const body = req.body || {};
  if (!body.status) return res.status(400).json({ error: 'status is required' });
  const updated = orderManagementStore.setStatus(req.params.id, body.status, body.actor || req.get('X-Actor'));
  if (!updated) return res.status(404).json({ error: 'Order not found' });
  res.json({ ok: true, order: updated });
});

app.post('/api/order-management/orders/:id/settlement', (req, res) => {
  const body = req.body || {};
  if (!body.status) return res.status(400).json({ error: 'status is required' });
  const updated = orderManagementStore.setSettlement(req.params.id, body.status, body.actor || req.get('X-Actor'));
  if (!updated) return res.status(404).json({ error: 'Order not found' });
  res.json({ ok: true, order: updated });
});

app.get('/api/order-management/suppliers', (req, res) => {
  res.json({ suppliers: orderManagementStore.listSuppliers(req.query.productLine) });
});

app.get('/api/order-management/products', (req, res) => {
  res.json({ products: orderManagementStore.listProducts(req.query.productLine) });
});

app.get('/api/order-management/components', (req, res) => {
  res.json({ components: orderManagementStore.listComponents(req.query.productLine) });
});

// ---- Sizing charts ----
app.get('/api/sizing-charts', (req, res) => {
  res.json({ charts: sizingChartStore.listCharts() });
});
app.get('/api/sizing-charts/:id', (req, res) => {
  const chart = sizingChartStore.getChart(req.params.id);
  if (!chart) return res.status(404).json({ error: 'Sizing chart not found' });
  res.json({ chart });
});
app.post('/api/sizing-charts', (req, res) => {
  const body = req.body || {};
  if (!body.name) return res.status(400).json({ error: 'name is required' });
  const chart = sizingChartStore.createChart({ ...body, id: uuidv4() });
  res.json({ ok: true, chart });
});
app.patch('/api/sizing-charts/:id', (req, res) => {
  const updated = sizingChartStore.updateChart(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Sizing chart not found' });
  res.json({ ok: true, chart: updated });
});
app.delete('/api/sizing-charts/:id', (req, res) => {
  const ok = sizingChartStore.deleteChart(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Sizing chart not found' });
  res.json({ ok: true });
});

// ---- Suppliers (real master data, per Product Information) ----
app.get('/api/suppliers', (req, res) => {
  res.json({ suppliers: supplierStore.listSuppliers() });
});
app.get('/api/suppliers/:id', (req, res) => {
  const supplier = supplierStore.getSupplier(req.params.id);
  if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
  res.json({ supplier });
});
app.post('/api/suppliers', (req, res) => {
  const body = req.body || {};
  if (!body.name) return res.status(400).json({ error: 'name is required' });
  const supplier = supplierStore.createSupplier({ ...body, id: uuidv4() });
  res.json({ ok: true, supplier });
});
app.patch('/api/suppliers/:id', (req, res) => {
  const updated = supplierStore.updateSupplier(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Supplier not found' });
  res.json({ ok: true, supplier: updated });
});
app.delete('/api/suppliers/:id', (req, res) => {
  const ok = supplierStore.deleteSupplier(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Supplier not found' });
  res.json({ ok: true });
});

app.get('/api/order-management/counts', (req, res) => {
  res.json(orderManagementStore.getCounts());
});

app.get('/api/order-management/financials/monthly', (req, res) => {
  res.json({ months: orderManagementStore.getMonthlyFinancials() });
});

app.get('/api/order-management/file-categories', (req, res) => {
  res.json({ categories: orderManagementStore.FILE_CATEGORIES });
});

app.post('/api/order-management/orders/:id/files', uploadOrderFile.single('file'), (req, res) => {
  try {
    if (!orderManagementStore.getOrderById(req.params.id)) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const category = orderManagementStore.FILE_CATEGORIES.includes(req.body.category)
      ? req.body.category : 'Other';
    const file = {
      id: uuidv4(),
      category,
      originalName: req.file.originalname,
      storedName: req.file.filename,
      size: req.file.size,
      relatedTo: (req.body.relatedTo || '').trim() || null,
      url: `/order-management-files/${encodeURIComponent(req.params.id)}/${encodeURIComponent(req.file.filename)}`,
      uploadedAt: new Date().toISOString(),
      uploadedBy: req.body.actor || req.get('X-Actor') || 'Unknown'
    };
    const updated = orderManagementStore.addFile(req.params.id, file, file.uploadedBy);
    res.json({ ok: true, order: updated, file });
  } catch (err) {
    console.error('Failed to upload order file:', err);
    res.status(500).json({ error: 'Failed to upload file', detail: String(err.message || err) });
  }
});

app.delete('/api/order-management/orders/:id/files/:fileId', (req, res) => {
  const updated = orderManagementStore.removeFile(req.params.id, req.params.fileId, req.get('X-Actor'));
  if (!updated) return res.status(404).json({ error: 'Order not found' });
  res.json({ ok: true, order: updated });
});

// ---- QA/QC Approval workflow ----
const STAGE_KEY_MAP = { sample: 'sampleApproval', preProduction: 'preProductionApproval', bulk: 'bulkApproval' };

function saveApprovalPhotos(files, prefix) {
  fs.mkdirSync(approvalStore.APPROVAL_PHOTO_DIR, { recursive: true });
  const urls = [];
  (files || []).forEach((f, i) => {
    const filename = `${prefix}_${i}_${uuidv4().slice(0, 8)}.jpg`;
    fs.writeFileSync(path.join(approvalStore.APPROVAL_PHOTO_DIR, filename), f.buffer);
    urls.push(`/approval-photos/${encodeURIComponent(filename)}`);
  });
  return urls;
}

app.get('/api/approval/:poNumber', (req, res) => {
  try {
    const po = poStore.getPoByNumber(req.params.poNumber);
    if (!po) return res.status(404).json({ error: 'Purchase order not found - has it been created via New Purchase Order?' });

    const photoSet = resolvePhotoSet(po.category, po.subcategory);
    const approval = approvalStore.getOrCreateByPoNumber(po.poNumber, po.sku);
    const priorSampleApproval = approvalStore.getPriorSampleApprovalForSku(po.sku, po.poNumber);
    const reportingHistory = submissionLog.findPriorReportsBySku(po.sku);

    res.json({ po, photoSet, approval, priorSampleApproval, reportingHistory });
  } catch (err) {
    console.error('Failed to load approval record:', err);
    res.status(500).json({ error: 'Failed to load approval record', detail: String(err.message || err) });
  }
});

app.post('/api/approval/:poNumber/:stage', upload.any(), (req, res) => {
  try {
    const stageKey = STAGE_KEY_MAP[req.params.stage];
    if (!stageKey) return res.status(400).json({ error: 'Unknown approval stage' });
    const po = poStore.getPoByNumber(req.params.poNumber);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });

    const data = JSON.parse((req.body && req.body.data) || '{}');
    if (req.params.stage === 'sample') {
      addNewOptionIfMissing('factoryCodes', data.factoryCode);
      addNewOptionIfMissing('qaLeads', data.qaLead);
    }
    const filesByField = {};
    (req.files || []).forEach((f) => {
      if (!filesByField[f.fieldname]) filesByField[f.fieldname] = [];
      filesByField[f.fieldname].push(f);
    });

    // Photos come in per named slot (e.g. photo_front, photo_back) or, for
    // per-size apparel Pre-Production/Bulk Approval, per slot+size
    // (photo_front__Adult_M). Save each and build a slot -> URLs map.
    const photos = {};
    Object.keys(filesByField).forEach((field) => {
      if (!field.startsWith('photo_')) return;
      const slotKey = field.slice('photo_'.length);
      photos[slotKey] = saveApprovalPhotos(filesByField[field], `${po.poNumber}_${req.params.stage}_${slotKey}`);
    });

    const entry = approvalStore.updateStage(po.poNumber, po.sku, stageKey, { ...data, photos });

    // If this Sample Approval established an apparel sizing standard, write it
    // back onto the PO record so future POs of the same SKU can find and copy
    // it forward automatically (see poStore.getEstablishedFitForSku). Records
    // only the sizes actually submitted here, not the fit's entire generic
    // range - a Sample covering 3 sizes shouldn't make a future PO of the
    // same SKU default to all 12 of the fit's possible sizes.
    if (req.params.stage === 'sample' && po.category === 'apparel' && data.sizing && data.sizing.fit) {
      const fitDef = fits.fits[data.sizing.fit];
      if (fitDef) {
        const submittedSizes = (data.sizing.sizeRows || []).map((r) => r.size).filter(Boolean);
        poStore.updatePo(po.id, { fitKey: data.sizing.fit, fitSizes: submittedSizes });
      }
    }

    res.json({ ok: true, approval: entry });

    // Best-effort Asana sync: mark this stage "Waiting for Product Dev" the
    // moment China's photos land, so PD sees it needs their attention
    // without having to check this app. Never blocks or fails the response
    // above - fired after responding, errors are just logged.
    if (po.asanaTaskGid) {
      const fieldMap = loadAsanaFieldMap();
      const stageMap = fieldMap[req.params.stage];
      const optionGid = stageMap && stageMap.statusOptions && stageMap.statusOptions.submitted;
      if (stageMap && stageMap.fieldGid && optionGid) {
        asanaClient.setEnumCustomField(po.asanaTaskGid, stageMap.fieldGid, optionGid);
      }
    }
  } catch (err) {
    console.error('Failed to save approval stage:', err);
    res.status(500).json({ error: 'Failed to save approval stage', detail: String(err.message || err) });
  }
});

/** Deliberately bypass Pre-Production Approval - for repeat POs of an
 *  already-established product, where the team typically goes straight
 *  from Golden Sample to Bulk. Only Pre-Production can be skipped; Sample
 *  and Bulk are always required. */
app.post('/api/approval/:poNumber/:stage/skip', (req, res) => {
  try {
    if (req.params.stage !== 'preProduction') {
      return res.status(400).json({ error: 'Only the Pre-Production stage can be skipped' });
    }
    const po = poStore.getPoByNumber(req.params.poNumber);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    const entry = approvalStore.skipStage(po.poNumber, 'preProductionApproval');
    res.json({ ok: true, approval: entry });

    // Best-effort Asana sync: mark this stage Not Applicable, matching the
    // deliberate "skip" decision made here.
    if (po.asanaTaskGid) {
      const fieldMap = loadAsanaFieldMap();
      const stageMap = fieldMap.preProduction;
      const optionGid = stageMap && stageMap.statusOptions && stageMap.statusOptions.notApplicable;
      if (stageMap && stageMap.fieldGid && optionGid) {
        asanaClient.setEnumCustomField(po.asanaTaskGid, stageMap.fieldGid, optionGid);
      }
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to skip stage' });
  }
});

app.post('/api/approval/:poNumber/:stage/comment', upload.any(), (req, res) => {
  try {
    const stageKey = STAGE_KEY_MAP[req.params.stage];
    if (!stageKey) return res.status(400).json({ error: 'Unknown approval stage' });
    const text = ((req.body && req.body.text) || '').trim();
    const author = ((req.body && req.body.author) || '').trim();
    const approvalStatus = ((req.body && req.body.approvalStatus) || '').trim();
    // A comment can optionally point at one specific photo or size row from
    // this stage's own submission, so a reply can say "see this" instead of
    // describing it in words - see the "reference" picker in the reply form.
    let reference = null;
    if (req.body && req.body.reference) {
      try { reference = JSON.parse(req.body.reference); } catch { reference = null; }
    }
    if (!author) return res.status(400).json({ error: 'author is required' });
    // Only the formal first decision uses the Product Development Lead
    // dropdown - replies are free text for either team, so don't add those.
    if (approvalStatus) addNewOptionIfMissing('productDevelopmentLeads', author);

    const photos = saveApprovalPhotos(req.files, `${req.params.poNumber}_${req.params.stage}_comment`);
    const entry = approvalStore.addPdComment(req.params.poNumber, stageKey, { text, author, approvalStatus, photos, reference });
    if (!entry) return res.status(404).json({ error: 'Purchase order not found' });
    res.json({ ok: true, approval: entry });

    // Best-effort Asana sync: a formal decision (Approved, Approved with
    // Comments, Minor Issue, Major/Critical) moves this stage's field to
    // match. Free-text replies with no status attached don't touch Asana.
    if (approvalStatus) {
      const po = poStore.getPoByNumber(req.params.poNumber);
      if (po && po.asanaTaskGid) {
        const fieldMap = loadAsanaFieldMap();
        const stageMap = fieldMap[req.params.stage];
        const optionGid = stageMap && stageMap.statusOptions && stageMap.statusOptions[approvalStatus];
        if (stageMap && stageMap.fieldGid && optionGid) {
          asanaClient.setEnumCustomField(po.asanaTaskGid, stageMap.fieldGid, optionGid);
        }

        // Once Bulk is fully approved, the PO's journey is done - attach
        // the final consolidated report (every stage, every inspection)
        // directly to the Asana task so it's on record there too, without
        // anyone needing to come back to this app to find it.
        if (req.params.stage === 'bulk' && approvalStatus === 'approved') {
          (async () => {
            try {
              const fullApproval = approvalStore.getByPoNumber(po.poNumber);
              const reportingHistory = submissionLog.findPriorReportsByPoNumber(po.poNumber);
              const buffer = await buildConsolidatedReport(po, fullApproval, reportingHistory, i18n);
              await asanaClient.attachFileToTask(po.asanaTaskGid, buffer, `${po.poNumber}_Consolidated_Report.pdf`, 'application/pdf');
            } catch (err) {
              console.error(`Failed to attach consolidated report to Asana task for ${po.poNumber}:`, err.message || err);
            }
          })();
        }
      }
    }
  } catch (err) {
    console.error('Failed to save PD comment:', err);
    res.status(500).json({ error: 'Failed to save PD comment', detail: String(err.message || err) });
  }
});

// ---- Reports: consolidated PDF combining PO info, every QA/QC Approval
// stage, and every Reporting-side inspection for that PO ----
const { buildConsolidatedReport } = require('./lib/consolidatedReportBuilder');

app.get('/api/reports/by-sku/:sku', (req, res) => {
  try {
    res.json({ pos: poStore.getPosBySku(req.params.sku) });
  } catch (err) {
    console.error('Failed to look up POs by SKU:', err);
    res.status(500).json({ error: 'Failed to look up POs by SKU', detail: String(err.message || err) });
  }
});

app.get('/api/consolidated-report/:poNumber', async (req, res) => {
  try {
    const po = poStore.getPoByNumber(req.params.poNumber);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    const approval = approvalStore.getByPoNumber(po.poNumber);
    const reportingHistory = submissionLog.findPriorReportsByPoNumber(po.poNumber);

    const buffer = await buildConsolidatedReport(po, approval, reportingHistory, i18n);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${po.poNumber}_Consolidated_Report.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('Failed to build consolidated report:', err);
    res.status(500).json({ error: 'Failed to build consolidated report', detail: String(err.message || err) });
  }
});

// ---- One-time migration: Factory Codes -> Suppliers ----
// Factory Codes used to be a flat editable list in Settings. They now live
// as bare Supplier records instead (name only, other fields blank - fill
// them in from the Suppliers page as time allows). Runs on every startup
// but is idempotent: only creates a supplier for a factory code that isn't
// already present as a supplier name, so re-running is harmless.
function migrateFactoryCodesToSuppliers() {
  try {
    const options = loadOptions();
    const factoryCodes = options.factoryCodes || [];
    if (!factoryCodes.length) return;
    const existingNames = new Set(supplierStore.listSuppliers().map((s) => s.name.trim().toLowerCase()));
    let migrated = 0;
    factoryCodes.forEach((code) => {
      const trimmed = String(code).trim();
      if (!trimmed || existingNames.has(trimmed.toLowerCase())) return;
      supplierStore.createSupplier({ id: uuidv4(), name: trimmed });
      existingNames.add(trimmed.toLowerCase());
      migrated += 1;
    });
    if (migrated) console.log(`Migrated ${migrated} factory code(s) into Suppliers as bare records.`);
  } catch (err) {
    console.error('Factory code -> Supplier migration failed:', err);
  }
}
migrateFactoryCodesToSuppliers();

// ---- Scheduled weekly backup ----
// Same zip contents as the manual "Download Backup" button, but written to
// disk automatically so a backup exists even if nobody remembers to click
// download. Excludes its own folder from the archive so weekly backups
// don't nest inside each other and balloon in size over time.
const SCHEDULED_BACKUP_DIR = path.join(submissionLog.DATA_DIR, 'scheduled-backups');
const BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SCHEDULED_BACKUPS = 8; // ~2 months of weekly snapshots

function listScheduledBackups() {
  if (!fs.existsSync(SCHEDULED_BACKUP_DIR)) return [];
  return fs.readdirSync(SCHEDULED_BACKUP_DIR)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const stat = fs.statSync(path.join(SCHEDULED_BACKUP_DIR, f));
      return { filename: f, createdAt: stat.mtime.toISOString(), sizeBytes: stat.size };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function pruneScheduledBackups() {
  const backups = listScheduledBackups();
  backups.slice(MAX_SCHEDULED_BACKUPS).forEach((b) => {
    try { fs.unlinkSync(path.join(SCHEDULED_BACKUP_DIR, b.filename)); } catch (e) { /* best-effort */ }
  });
}

async function runScheduledBackupIfDue() {
  try {
    const existing = listScheduledBackups();
    const last = existing[0];
    if (last && (Date.now() - new Date(last.createdAt).getTime()) < BACKUP_INTERVAL_MS) return;
    fs.mkdirSync(SCHEDULED_BACKUP_DIR, { recursive: true });
    const filename = `weekly-backup-${new Date().toISOString().slice(0, 10)}.zip`;
    const destPath = path.join(SCHEDULED_BACKUP_DIR, filename);
    const output = fs.createWriteStream(destPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.glob('**/*', { cwd: submissionLog.DATA_DIR, ignore: ['scheduled-backups/**'] });
      archive.finalize();
    });
    pruneScheduledBackups();
    console.log(`Scheduled backup created: ${filename}`);
  } catch (err) {
    console.error('Scheduled backup failed:', err);
  }
}
runScheduledBackupIfDue();
setInterval(runScheduledBackupIfDue, 24 * 60 * 60 * 1000); // check daily, only acts once 7 days have passed

app.get('/api/backup/scheduled', (req, res) => {
  res.json({ backups: listScheduledBackups() });
});
app.get('/api/backup/scheduled/:filename', (req, res) => {
  const filePath = path.join(SCHEDULED_BACKUP_DIR, req.params.filename);
  if (!filePath.startsWith(SCHEDULED_BACKUP_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  res.download(filePath);
});

app.listen(PORT, () => {
  console.log(`Juniper QA/QC app listening on port ${PORT}`);
});
