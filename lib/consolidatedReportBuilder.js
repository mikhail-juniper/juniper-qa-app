/**
 * Builds the single consolidated PDF for the Reports page: everything known
 * about one PO, laid out as ONE continuous document rather than links out to
 * separate PDFs. Order Information + Performance, then Sample Approval
 * (info/notes/pictures), then Pre-Production Approval (pictures/approval/
 * notes) immediately followed by the FULL Pre-Production inspection
 * report(s), then the same pattern for Bulk. The "full report" sections are
 * the actual stored per-inspection PDFs, merged in page-for-page via pdf-lib
 * so their detailed checklist/sizing content doesn't need to be re-derived -
 * just reused as-is.
 */
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { ReportPDF, BRAND } = require('./pdfBuilder');
const submissionLog = require('./submissionLog');
const { APPROVAL_PHOTO_DIR } = require('./approvalStore');

const STAGE_TITLES = {
  sampleApproval: { en: 'Sample Approval', zh: '样品审批' },
  preProductionApproval: { en: 'Pre-Production Approval', zh: '产前审批' },
  bulkApproval: { en: 'Bulk Approval', zh: '批量审批' }
};
const APPROVAL_STATUS_LABEL = {
  minorIssue: { en: 'Minor Issue', zh: '轻微问题' },
  majorCriticalIssue: { en: 'Major or Critical Issue', zh: '严重或致命问题' },
  approved: { en: 'Approved', zh: '已批准' }
};

function bilingual(en, zh) { return zh ? `${zh} ${en}` : en; }

/** Approval photo URLs are served as /approval-photos/<file> - resolve back
 *  to a local disk path so PDFKit can embed the actual bytes. */
function localPathForUrl(url) {
  if (url.startsWith('/approval-photos/')) return path.join(APPROVAL_PHOTO_DIR, decodeURIComponent(url.replace('/approval-photos/', '')));
  return url;
}

/** Runs `drawFn(pdf, doc)` against a fresh ReportPDF instance and resolves
 *  with the finished PDF as a Buffer. */
function buildSectionPdf(i18n, drawFn) {
  return new Promise((resolve, reject) => {
    const pdf = new ReportPDF(i18n);
    const doc = pdf.doc;
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    drawFn(pdf, doc);
    pdf.finish();
  });
}

function drawApprovalStageSection(pdf, doc, stageKey, stage) {
  const title = STAGE_TITLES[stageKey];
  pdf.sectionTitle(null, `${title.zh} ${title.en}`);
  doc.font('Regular').fontSize(8).fillColor(BRAND.muted).text(new Date(stage.submittedAt).toLocaleString());
  doc.moveDown(0.3);

  const d = stage.data || {};
  const infoRows = [];
  if (d.factoryCode) infoRows.push([bilingual('Factory Code', '工厂代码'), d.factoryCode]);
  if (d.qaLead) infoRows.push([bilingual('QA/QC Lead', 'QA/QC 负责人'), d.qaLead]);
  if (d.productRisk) infoRows.push([bilingual('Product Risk', '产品风险'), d.productRisk]);
  if (d.sizing && d.sizing.fit) infoRows.push([bilingual('Sizing Standard', '尺寸标准'), d.sizing.fit]);
  if (infoRows.length) pdf.keyValueGrid(infoRows, 3);

  if (d.notes) pdf.paragraph(bilingual('Notes', '备注'), d.notes);

  const photos = d.photos || {};
  Object.keys(photos).forEach((slotKey) => {
    const urls = photos[slotKey] || [];
    if (!urls.length || slotKey === 'notesPhotos') return;
    pdf.subheading(slotKey);
    pdf.photoGridSync(urls.map((u) => ({ path: localPathForUrl(u) })), 4);
  });
  if (photos.notesPhotos && photos.notesPhotos.length) {
    pdf.subheading(bilingual('Notes Photos', '备注照片'));
    pdf.photoGridSync(photos.notesPhotos.map((u) => ({ path: localPathForUrl(u) })), 4);
  }

  const comments = stage.pdComments || [];
  if (comments.length) {
    pdf.subheading(bilingual('Product Development Comments', '产品开发团队备注'));
    comments.forEach((c) => {
      doc.font('Bold').fontSize(9).fillColor(BRAND.text).text(c.text || bilingual('(no comment text)', '（无文字备注）'), { width: pdf.pageWidth });
      const statusLabel = c.approvalStatus && APPROVAL_STATUS_LABEL[c.approvalStatus];
      doc.font('Regular').fontSize(8).fillColor(BRAND.muted)
        .text(`${c.author} · ${new Date(c.timestamp).toLocaleString()}${statusLabel ? ` · ${statusLabel.zh} ${statusLabel.en}` : ''}`);
      if (c.photos && c.photos.length) pdf.photoGridSync(c.photos.map((u) => ({ path: localPathForUrl(u) })), 4);
      doc.moveDown(0.4);
    });
  }
}

async function buildConsolidatedReport(po, approval, reportingHistory, i18n) {
  const preProdReports = (reportingHistory || []).filter((r) => r.qaType === 'pre_production');
  const bulkReports = (reportingHistory || []).filter((r) => r.qaType === 'production');

  // --- Cover: Order Information + Performance ---
  const coverBuffer = await buildSectionPdf(i18n, (pdf, doc) => {
    pdf.drawHeader({ poNumber: po.poNumber, _reportId: po.id.slice(0, 8).toUpperCase() });
    pdf.sectionTitle('poInfo', 'Order Information');
    pdf.keyValueGrid([
      [bilingual('PO Number', '采购订单号'), po.poNumber],
      [bilingual('Product SKU', '产品SKU'), po.sku],
      [bilingual('Category', '类别'), `${po.category || '-'} ${po.subcategory || ''}`],
      [bilingual('Product Title', '产品名称'), po.productTitle || '-'],
      [bilingual('Order Date', '订单日期'), po.orderDate || '-'],
      [bilingual('Creator', '创作者'), po.creator || '-'],
      [bilingual('Order Quantity', '订单数量'), po.orderQuantity ? String(po.orderQuantity) : '-'],
      [bilingual('Product Development Lead', '产品开发负责人'), po.productDevelopmentLead || '-'],
      [bilingual('Sizes Included', '包含尺码'), (po.sizesIncluded || []).join(', ') || '-'],
    ], 3);

    const withRecap = (reportingHistory || []).filter((r) => r.recap);
    if (withRecap.length) {
      pdf.sectionTitle(null, bilingual('Performance', '生产表现'));
      withRecap.forEach((r) => {
        const qaTypeLabel = r.qaType === 'production' ? bilingual('Bulk Sampling Sample', '批量抽样样品') : bilingual('Pre-Production Sample', '产前样品');
        pdf.subheading(`${qaTypeLabel} · ${r.date || ''}`);
        pdf.keyValueGrid([
          [bilingual('PO Size', '订单总数'), String(r.recap.poSize || po.orderQuantity || '-')],
          [bilingual('Quantity Checked', '检查数量'), String(r.recap.quantityChecked || '-')],
          [bilingual('Quantity Approved', '合格数量'), String(r.recap.quantityApproved || '-')],
          [bilingual('Quantity Rejected', '不合格数量'), String(r.recap.quantityRejected || '-')],
        ], 4);
      });
    }
  });

  const buffers = [coverBuffer];

  // --- Sample Approval ---
  if (approval && approval.sampleApproval && approval.sampleApproval.submitted) {
    buffers.push(await buildSectionPdf(i18n, (pdf, doc) => drawApprovalStageSection(pdf, doc, 'sampleApproval', approval.sampleApproval)));
  }

  // --- Pre-Production Approval, then the full Pre-Production inspection report(s) ---
  if (approval && approval.preProductionApproval && approval.preProductionApproval.submitted) {
    buffers.push(await buildSectionPdf(i18n, (pdf, doc) => drawApprovalStageSection(pdf, doc, 'preProductionApproval', approval.preProductionApproval)));
  }
  preProdReports.forEach((r) => {
    if (!r.pdfFilename) return;
    const filePath = path.join(submissionLog.PDF_ARCHIVE_DIR, r.pdfFilename);
    if (fs.existsSync(filePath)) buffers.push(fs.readFileSync(filePath));
  });

  // --- Bulk Approval, then the full Bulk/Production inspection report(s) ---
  if (approval && approval.bulkApproval && approval.bulkApproval.submitted) {
    buffers.push(await buildSectionPdf(i18n, (pdf, doc) => drawApprovalStageSection(pdf, doc, 'bulkApproval', approval.bulkApproval)));
  }
  bulkReports.forEach((r) => {
    if (!r.pdfFilename) return;
    const filePath = path.join(submissionLog.PDF_ARCHIVE_DIR, r.pdfFilename);
    if (fs.existsSync(filePath)) buffers.push(fs.readFileSync(filePath));
  });

  // --- Merge everything into one final PDF ---
  const finalDoc = await PDFDocument.create();
  for (const buf of buffers) {
    try {
      const srcDoc = await PDFDocument.load(buf);
      const pages = await finalDoc.copyPages(srcDoc, srcDoc.getPageIndices());
      pages.forEach((p) => finalDoc.addPage(p));
    } catch (err) {
      console.error('Failed to merge a section into the consolidated report - skipping it:', err);
    }
  }
  const finalBytes = await finalDoc.save();
  return Buffer.from(finalBytes);
}

module.exports = { buildConsolidatedReport };
