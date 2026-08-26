require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');

const { buildPdf } = require('./lib/pdfBuilder');
const { computeOverallResult, collectAllDefects } = require('./lib/passFail');
const { getRecommendation } = require('./lib/aqlRecommendation');
const submissionLog = require('./lib/submissionLog');
const poStore = require('./lib/poStore');
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
const EDITABLE_OPTION_LISTS = ['creators', 'factoryCodes', 'qaLeads'];

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function saveJson(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2)); }
function loadOptions() { return loadJson(OPTIONS_PATH); }
function saveOptions(newOptions) { saveJson(OPTIONS_PATH, newOptions); }

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Storage for uploaded photos (temp, per-submission) ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 60 } // 15MB/photo, 60 photos max per submission
});

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Serve generated PDFs so they can be viewed/downloaded - backed by the
// persistent DATA_DIR (see lib/submissionLog.js) so these survive restarts
// once a persistent disk is attached (e.g. on Render's paid tier).
app.use('/submissions', express.static(submissionLog.PDF_ARCHIVE_DIR));
app.use('/issue-photos', express.static(submissionLog.PHOTO_ARCHIVE_DIR));

// Serve the fit library + translations + dropdown options + category tree + AQL
// reference table + creator tiers + recommendation table + unit costs to the frontend
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
    const files = req.files || [];

    // Group files by their logical field name (set client-side)
    const filesByField = {};
    for (const f of files) {
      if (!filesByField[f.fieldname]) filesByField[f.fieldname] = [];
      filesByField[f.fieldname].push(f);
    }

    const submissionId = uuidv4();
    const overallResult = computeOverallResult(payload, fits);
    const recommendation = getRecommendation(
      { category: payload.category, subcategory: payload.subcategory, poQuantity: payload.poQuantity, creator: payload.creator, risk: payload.productRisk },
      { unitCosts: loadJson(UNIT_COSTS_PATH), aqlRecConfig: loadJson(AQL_RECOMMENDATION_PATH), creatorTiersConfig: loadJson(CREATOR_TIERS_PATH) }
    );
    const pdfBuffer = await buildPdf(payload, filesByField, fits, i18n, overallResult, categories, recommendation);

    const fileSafePo = (payload.poNumber || 'QA-Report').replace(/[^a-z0-9\-_]+/gi, '_');
    const pdfFilename = `${fileSafePo}_QA_Report_${submissionId.slice(0, 8)}.pdf`;

    const smtpConfigured = !!process.env.SMTP_HOST;
    let emailSent = false;

    // Build email
    const recipients = (process.env.REPORT_RECIPIENTS || 'mikhail@junipercreates.com')
      .split(',').map(s => s.trim()).filter(Boolean);

    const attachments = [{ filename: pdfFilename, content: pdfBuffer, contentType: 'application/pdf' }];

    if (process.env.ATTACH_FULL_RES_PHOTOS === 'true') {
      files.forEach((f, idx) => {
        attachments.push({
          filename: `photo_${idx + 1}_${f.originalname || 'image.jpg'}`,
          content: f.buffer,
          contentType: f.mimetype
        });
      });
    }

    if (smtpConfigured) {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        } : undefined
      });

      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: recipients.join(','),
        subject: `QA/QC Report - ${payload.poNumber || 'Unknown PO'} (${payload.category || ''}) - ${overallResult.overall.toUpperCase()}`,
        text: `New QA/QC report submitted for PO ${payload.poNumber || 'N/A'}.\nCategory: ${payload.category}\nQA Lead: ${payload.qaLead || 'N/A'}\n\nSee attached PDF report.`,
        attachments
      });
      emailSent = true;
    } else {
      console.warn('SMTP_HOST not configured - running in local test mode. The PDF will be saved and viewable, but no email will be sent.');
    }

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
        customSizeRows: (payload.categoryData && payload.categoryData.customSizeRows) || []
      }
    });

    res.json({ ok: true, submissionId, filename: pdfFilename, pdfUrl, emailSent, testMode: !smtpConfigured, overallResult });
  } catch (err) {
    console.error('Submission failed:', err);
    res.status(500).json({ error: 'Failed to process submission', detail: String(err.message || err) });
  }
});

// ---- Report history: reference a prior report for the same PO Number ----
app.get('/api/submission-history/:poNumber', (req, res) => {
  try {
    const prior = submissionLog.findPriorReportsByPoNumber(req.params.poNumber, req.query.excludeId);
    res.json({ reports: prior });
  } catch (err) {
    console.error('Failed to look up submission history:', err);
    res.status(500).json({ error: 'Failed to look up submission history', detail: String(err.message || err) });
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
app.post('/api/purchase-orders', (req, res) => {
  try {
    const body = req.body || {};
    if (!body.poNumber || !body.sku) {
      return res.status(400).json({ error: 'poNumber and sku are required' });
    }
    if (poStore.getPoByNumber(body.poNumber)) {
      return res.status(409).json({ error: 'A PO with this number already exists' });
    }
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
      productDevelopmentLead: body.productDevelopmentLead || null,
      sizesIncluded: Array.isArray(body.sizesIncluded) ? body.sizesIncluded : [],
      fitKey: established ? established.fitKey : null,
      fitSizes: established ? established.sizes : [],
      createdAt: new Date().toISOString()
    });
    res.json({ ok: true, po: entry, approvalUrl: `/approval.html?po=${encodeURIComponent(id)}` });
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

app.listen(PORT, () => {
  console.log(`Juniper QA/QC app listening on port ${PORT}`);
  if (!process.env.SMTP_HOST) {
    console.warn('WARNING: SMTP_HOST is not set. Emails will not be sent until configured in .env');
  }
});
