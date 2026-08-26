/**
 * Builds the single consolidated PDF for the Reports page: everything known
 * about one PO in one document - order info, every QA/QC Approval stage
 * (photos, notes, PD comments with their approval decision), and a summary of
 * every Reporting-side inspection submitted for that PO (with a link to each
 * one's own full report).
 */
const { ReportPDF, BRAND } = require('./pdfBuilder');

const STAGE_TITLES = {
  sampleApproval: { en: 'Sample Approval', zh: '样品审批' },
  preProductionApproval: { en: 'Pre-Production Approval', zh: '产前审批' },
  bulkApproval: { en: 'Bulk Approval', zh: '批量审批' }
};
const APPROVAL_STATUS_LABEL = {
  approved: { en: 'Approved', zh: '已批准' },
  approvedWithComments: { en: 'Approved with Comments', zh: '有条件批准' },
  notApproved: { en: 'Not Approved', zh: '未批准' }
};

function bilingual(en, zh) { return zh ? `${zh} ${en}` : en; }

async function buildConsolidatedReport(po, approval, reportingHistory, i18n, baseUrl) {
  return new Promise((resolve, reject) => {
    const pdf = new ReportPDF(i18n);
    const doc = pdf.doc;
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    pdf.drawHeader({ poNumber: po.poNumber, _reportId: po.id.slice(0, 8).toUpperCase() });

    // --- Order Information ---
    pdf.sectionTitle('poInfo', 'Order Information');
    pdf.keyValueGrid([
      [bilingual('PO Number', '采购订单号'), po.poNumber],
      [bilingual('Product SKU', '产品SKU'), po.sku],
      [bilingual('Category', '类别'), `${po.category || '-'} ${po.subcategory || ''}`],
      [bilingual('Order Date', '订单日期'), po.orderDate || '-'],
      [bilingual('Creator', '创作者'), po.creator || '-'],
      [bilingual('Order Quantity', '订单数量'), po.orderQuantity ? String(po.orderQuantity) : '-'],
      [bilingual('Product Development Lead', '产品开发负责人'), po.productDevelopmentLead || '-'],
      [bilingual('Sizes Included', '包含尺码'), (po.sizesIncluded || []).join(', ') || '-'],
    ], 3);

    // --- QA/QC Approval stages ---
    ['sampleApproval', 'preProductionApproval', 'bulkApproval'].forEach((stageKey) => {
      const stage = approval && approval[stageKey];
      if (!stage || !stage.submitted) return;
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

      // PD comments for this stage
      const comments = stage.pdComments || [];
      if (comments.length) {
        pdf.subheading(bilingual('Product Development Comments', '产品开发团队备注'));
        comments.forEach((c) => {
          doc.font('Bold').fontSize(9).fillColor(BRAND.text).text(c.text, { width: pdf.pageWidth });
          const statusLabel = c.approvalStatus && APPROVAL_STATUS_LABEL[c.approvalStatus];
          doc.font('Regular').fontSize(8).fillColor(BRAND.muted)
            .text(`${c.author} · ${new Date(c.timestamp).toLocaleString()}${statusLabel ? ` · ${statusLabel.zh} ${statusLabel.en}` : ''}`);
          if (c.photos && c.photos.length) pdf.photoGridSync(c.photos.map((u) => ({ path: localPathForUrl(u) })), 4);
          doc.moveDown(0.4);
        });
      }
      doc.moveDown(0.4);
    });

    // --- Reporting-side inspection submissions ---
    if (reportingHistory && reportingHistory.length) {
      pdf.sectionTitle(null, bilingual('Inspection Reports', '检验报告'));
      reportingHistory.forEach((r) => {
        const qaTypeLabel = r.qaType === 'production' ? bilingual('Bulk Sampling Sample', '批量抽样样品') : bilingual('Pre-Production Sample', '产前样品');
        pdf.subheading(`${qaTypeLabel} · ${r.date || ''} · ${r.overallResult === 'pass' ? bilingual('PASS', '合格') : bilingual('FAIL', '不合格')}`);
        if (r.recap) {
          pdf.keyValueGrid([
            [bilingual('Quantity Checked', '检查数量'), String(r.recap.quantityChecked || '-')],
            [bilingual('Quantity Approved', '合格数量'), String(r.recap.quantityApproved || '-')],
            [bilingual('Quantity Rejected', '不合格数量'), String(r.recap.quantityRejected || '-')],
          ], 3);
        }
        if (r.issues && r.issues.length) {
          r.issues.forEach((iss) => {
            doc.font('Regular').fontSize(8.5).fillColor(BRAND.text).text(`• ${iss.description || '-'} (${iss.severity}, ${iss.unitsAffected} units)`, { width: pdf.pageWidth });
          });
        }
        if (r.pdfFilename && baseUrl) {
          doc.fillColor(BRAND.tealDark).font('Bold').fontSize(9)
            .text(bilingual('View Full Inspection Report', '查看完整检验报告'), { link: `${baseUrl}/submissions/${encodeURIComponent(r.pdfFilename)}`, underline: true });
        }
        doc.moveDown(0.5);
      });
    }

    pdf.addFooterPageNumbers();
    pdf.finish();
  });
}

const path = require('path');
const { PHOTO_ARCHIVE_DIR: ISSUE_PHOTO_DIR } = require('./submissionLog');
const { APPROVAL_PHOTO_DIR } = require('./approvalStore');

/** Approval/issue photo URLs are served as /approval-photos/<file> or
 *  /issue-photos/<file> - resolve them back to a local disk path so PDFKit
 *  can embed the actual image bytes instead of needing a network fetch. */
function localPathForUrl(url) {
  if (url.startsWith('/approval-photos/')) return path.join(APPROVAL_PHOTO_DIR, decodeURIComponent(url.replace('/approval-photos/', '')));
  if (url.startsWith('/issue-photos/')) return path.join(ISSUE_PHOTO_DIR, decodeURIComponent(url.replace('/issue-photos/', '')));
  return url;
}

module.exports = { buildConsolidatedReport };
