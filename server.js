require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');

const { buildPdf } = require('./lib/pdfBuilder');
const { computeOverallResult } = require('./lib/passFail');
const { getRecommendation } = require('./lib/aqlRecommendation');
const fits = require('./config/fits.json');
const i18n = require('./config/i18n.json');
const categories = require('./config/categories.json');
const aqlTable = require('./config/aql.json');

const OPTIONS_PATH = path.join(__dirname, 'config', 'options.json');
const CREATOR_TIERS_PATH = path.join(__dirname, 'config', 'creatorTiers.json');
const AQL_RECOMMENDATION_PATH = path.join(__dirname, 'config', 'aqlRecommendation.json');
const UNIT_COSTS_PATH = path.join(__dirname, 'config', 'unitCosts.json');
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
// Serve generated PDFs so they can be viewed/downloaded right after submitting.
// This is primarily for local testing - see README for notes on disabling
// or locking this down before a real production deployment.
app.use('/submissions', express.static(path.join(__dirname, 'submissions')));

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

    // Persist a local copy so it can be viewed/downloaded.
    // - Always on when SMTP isn't configured, so local testing has a way to see the result.
    // - Otherwise controlled by SAVE_LOCAL_COPY (useful as a backup / audit trail in production).
    let pdfUrl = null;
    if (!smtpConfigured || process.env.SAVE_LOCAL_COPY === 'true') {
      const outDir = path.join(__dirname, 'submissions');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, pdfFilename), pdfBuffer);
      pdfUrl = `/submissions/${encodeURIComponent(pdfFilename)}`;
    }

    res.json({ ok: true, submissionId, filename: pdfFilename, pdfUrl, emailSent, testMode: !smtpConfigured, overallResult });
  } catch (err) {
    console.error('Submission failed:', err);
    res.status(500).json({ error: 'Failed to process submission', detail: String(err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Juniper QA/QC app listening on port ${PORT}`);
  if (!process.env.SMTP_HOST) {
    console.warn('WARNING: SMTP_HOST is not set. Emails will not be sent until configured in .env');
  }
});
