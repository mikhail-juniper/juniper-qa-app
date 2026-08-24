require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');

const { buildPdf } = require('./lib/pdfBuilder');
const { computeOverallResult } = require('./lib/passFail');
const fits = require('./config/fits.json');
const i18n = require('./config/i18n.json');
const options = require('./config/options.json');

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

// Serve the fit library + translations + dropdown options to the frontend
app.get('/api/config', (req, res) => {
  res.json({ fits, i18n, options });
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
    const pdfBuffer = await buildPdf(payload, filesByField, fits, i18n, overallResult);

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
