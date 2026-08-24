const PDFDocument = require('pdfkit');
const path = require('path');

// ---- Brand palette (placeholder - update to match exact Juniper brand kit) ----
const BRAND = {
  green: '#2F5233',      // deep juniper green (header / accents)
  greenLight: '#E8EFE7', // light tint for section backgrounds
  text: '#1F2A24',
  muted: '#6B776E',
  border: '#D4DBD2',
  fail: '#C0392B',
  failBg: '#FBE9E7',
  pass: '#2F5233',
  warn: '#B9770E',
};

const FONT_REGULAR = path.join(__dirname, '..', 'public', 'fonts', 'NotoSansSC-Regular.otf');
const FONT_BOLD = path.join(__dirname, '..', 'public', 'fonts', 'NotoSansSC-Bold.otf');

const PAGE_MARGIN = 40;

function t(i18n, key, fallback = '') {
  const entry = i18n[key];
  if (!entry) return fallback || key;
  return entry;
}

function bi(i18n, key) {
  // Bilingual label: "English 中文"
  const entry = i18n[key];
  if (!entry) return key;
  return `${entry.en} ${entry.zh}`;
}

class ReportPDF {
  constructor(i18n) {
    this.i18n = i18n;
    this.doc = new PDFDocument({ size: 'LETTER', margin: PAGE_MARGIN, bufferPages: true });
    this.doc.registerFont('Regular', FONT_REGULAR);
    this.doc.registerFont('Bold', FONT_BOLD);
    this.doc.font('Regular');
    this.pageWidth = this.doc.page.width - PAGE_MARGIN * 2;
  }

  label(key, fallback) {
    return bi(this.i18n, key) || fallback;
  }

  ensureSpace(height) {
    const bottom = this.doc.page.height - PAGE_MARGIN;
    if (this.doc.y + height > bottom) {
      this.doc.addPage();
    }
  }

  drawHeader(payload) {
    const doc = this.doc;
    const topY = PAGE_MARGIN;

    // Brand bar
    doc.rect(0, 0, doc.page.width, 8).fill(BRAND.green);

    doc.fillColor(BRAND.green).font('Bold').fontSize(20)
      .text('JUNIPER CREATES', PAGE_MARGIN, topY + 10);
    doc.fillColor(BRAND.muted).font('Regular').fontSize(10)
      .text(bi(this.i18n, 'appTitle'), PAGE_MARGIN, topY + 34);

    const rightW = 230;
    const rightX = doc.page.width - PAGE_MARGIN - rightW;
    doc.fillColor(BRAND.muted).fontSize(8)
      .text(`Report ID / 报告编号: ${payload._reportId || ''}`, rightX, topY + 8, { width: rightW, align: 'right' })
      .text(`Generated / 生成时间: ${new Date().toLocaleDateString('en-CA')}`, rightX, topY + 32, { width: rightW, align: 'right' });

    doc.moveTo(PAGE_MARGIN, topY + 54).lineTo(doc.page.width - PAGE_MARGIN, topY + 54)
      .strokeColor(BRAND.border).lineWidth(1).stroke();

    doc.y = topY + 66;
    doc.x = PAGE_MARGIN;
  }

  sectionTitle(key, fallback) {
    this.ensureSpace(40);
    const doc = this.doc;
    doc.moveDown(0.6);
    const y = doc.y;
    doc.rect(PAGE_MARGIN, y, this.pageWidth, 22).fill(BRAND.green);
    doc.fillColor('#FFFFFF').font('Bold').fontSize(11)
      .text(this.label(key, fallback), PAGE_MARGIN + 8, y + 5, { width: this.pageWidth - 16 });
    doc.fillColor(BRAND.text).font('Regular');
    doc.y = y + 30;
    doc.x = PAGE_MARGIN;
  }

  subheading(text) {
    this.ensureSpace(20);
    this.doc.font('Bold').fontSize(10).fillColor(BRAND.text).text(text, { width: this.pageWidth });
    this.doc.font('Regular').moveDown(0.2);
  }

  keyValueGrid(pairs, cols = 2) {
    const doc = this.doc;
    const colWidth = this.pageWidth / cols;
    const rowH = 32;
    let col = 0;
    let rowStartY = doc.y;
    this.ensureSpace(rowH);
    rowStartY = doc.y;

    pairs.forEach(([labelText, value], idx) => {
      const cx = PAGE_MARGIN + col * colWidth;
      const cy = rowStartY;
      doc.font('Regular').fontSize(8).fillColor(BRAND.muted)
        .text(labelText, cx, cy, { width: colWidth - 10 });
      doc.font('Bold').fontSize(10.5).fillColor(BRAND.text)
        .text(value && String(value).trim() ? String(value) : '-', cx, cy + 11, { width: colWidth - 10 });
      col++;
      if (col >= cols) {
        col = 0;
        rowStartY += rowH;
        this.ensureSpace(rowH);
        rowStartY = doc.y === rowStartY ? rowStartY : doc.y; // in case addPage changed y
      }
    });
    doc.y = rowStartY + rowH;
    doc.x = PAGE_MARGIN;
    doc.moveDown(0.3);
  }

  checklistRow(labelText, status, notes) {
    this.ensureSpace(22);
    const doc = this.doc;
    const y = doc.y;
    const statusColors = {
      pass: BRAND.pass,
      fail: BRAND.fail,
      na: BRAND.muted,
    };
    const statusLabels = {
      pass: bi(this.i18n, 'pass'),
      fail: bi(this.i18n, 'fail'),
      na: bi(this.i18n, 'na'),
    };
    const badgeW = 95;
    doc.font('Regular').fontSize(9.5).fillColor(BRAND.text)
      .text(labelText, PAGE_MARGIN, y, { width: this.pageWidth - badgeW - 10 });

    const badgeColor = statusColors[status] || BRAND.muted;
    const badgeText = statusLabels[status] || '-';
    doc.roundedRect(PAGE_MARGIN + this.pageWidth - badgeW, y - 2, badgeW, 16, 3)
      .fillAndStroke(status === 'fail' ? BRAND.failBg : BRAND.greenLight, badgeColor);
    doc.fillColor(badgeColor).font('Bold').fontSize(8.5)
      .text(badgeText, PAGE_MARGIN + this.pageWidth - badgeW, y + 1, { width: badgeW, align: 'center' });

    doc.font('Regular').fillColor(BRAND.text);
    let usedH = 18;
    if (notes && notes.trim()) {
      doc.fontSize(8.5).fillColor(BRAND.muted)
        .text(`${bi(this.i18n, 'notes')}: ${notes}`, PAGE_MARGIN, y + 16, { width: this.pageWidth - badgeW - 10 });
      usedH = 16 + doc.heightOfString(`${bi(this.i18n, 'notes')}: ${notes}`, { width: this.pageWidth - badgeW - 10 }) + 4;
    }
    doc.y = y + usedH + 4;
    doc.x = PAGE_MARGIN;
  }

  paragraph(labelText, value) {
    if (!value || !String(value).trim()) return;
    this.ensureSpace(30);
    const doc = this.doc;
    doc.font('Bold').fontSize(9).fillColor(BRAND.muted).text(labelText, { width: this.pageWidth });
    doc.font('Regular').fontSize(10).fillColor(BRAND.text).text(String(value), { width: this.pageWidth });
    doc.moveDown(0.4);
  }

  sizeChartTable(fitDef, sizeRows, toleranceInches) {
    const doc = this.doc;
    const points = fitDef.points;
    const cols = ['size', ...points];
    const labels = cols.map((c) => {
      if (c === 'size') return bi(this.i18n, 'size');
      const pl = fitDef.pointLabels[c];
      return pl ? `${pl.en} ${pl.zh}` : c;
    });

    const colWidths = [1.3, ...points.map(() => 1)];
    const totalUnits = colWidths.reduce((a, b) => a + b, 0);
    const colPx = colWidths.map((w) => (w / totalUnits) * this.pageWidth);

    const rowH = 16;
    const headerH = 22;

    this.ensureSpace(headerH + rowH * 2);
    let y = doc.y;
    let x = PAGE_MARGIN;

    // header
    doc.rect(PAGE_MARGIN, y, this.pageWidth, headerH).fill(BRAND.greenLight);
    doc.fillColor(BRAND.text).font('Bold').fontSize(8);
    x = PAGE_MARGIN;
    labels.forEach((lab, i) => {
      doc.text(lab, x + 4, y + 6, { width: colPx[i] - 8 });
      x += colPx[i];
    });
    y += headerH;

    // sub-header row: Standard / Measured for each point column
    doc.font('Regular').fontSize(7).fillColor(BRAND.muted);

    sizeRows.forEach((row) => {
      const standard = fitDef.sizes[row.size] || {};
      const lineHeights = [14];
      // compute row height based on 2 lines (standard/measured) per point cell -> use fixed 26
      const cellRowH = 26;
      this.ensureSpace(cellRowH);
      if (doc.y !== y) y = doc.y; // page break happened
      doc.rect(PAGE_MARGIN, y, this.pageWidth, cellRowH).strokeColor(BRAND.border).lineWidth(0.5).stroke();

      x = PAGE_MARGIN;
      doc.font('Bold').fontSize(9).fillColor(BRAND.text)
        .text(row.size, x + 4, y + 8, { width: colPx[0] - 8 });
      x += colPx[0];

      points.forEach((p, i) => {
        const std = standard[p];
        const measured = row.measured && row.measured[p] !== undefined && row.measured[p] !== '' ? parseFloat(row.measured[p]) : null;
        const stdNum = std !== undefined && std !== null ? parseFloat(std) : null;
        let outOfTol = false;
        if (stdNum !== null && stdNum !== 0 && measured !== null && !isNaN(measured)) {
          outOfTol = Math.abs(measured - stdNum) > toleranceInches;
        }
        const cellX = x;
        if (outOfTol) {
          doc.rect(cellX, y, colPx[i + 1], cellRowH).fill(BRAND.failBg);
        }
        doc.font('Regular').fontSize(7).fillColor(BRAND.muted)
          .text(`${bi(this.i18n, 'standard')}: ${stdNum !== null ? stdNum + '"' : '-'}`, cellX + 4, y + 4, { width: colPx[i + 1] - 8 });
        doc.font(outOfTol ? 'Bold' : 'Regular').fontSize(8)
          .fillColor(outOfTol ? BRAND.fail : BRAND.text)
          .text(`${bi(this.i18n, 'measured')}: ${measured !== null && !isNaN(measured) ? measured + '"' : '-'}${outOfTol ? '  !' : ''}`, cellX + 4, y + 15, { width: colPx[i + 1] - 8 });
        x += colPx[i + 1];
      });

      y += cellRowH;
    });

    doc.y = y + 6;
    doc.x = PAGE_MARGIN;
  }

  async photoGrid(images, columns = 3) {
    if (!images || images.length === 0) return;
    const doc = this.doc;
    const gap = 8;
    const cellW = (this.pageWidth - gap * (columns - 1)) / columns;
    const cellH = cellW * 0.75;

    let col = 0;
    let rowY = doc.y;
    this.ensureSpace(cellH + 20);
    rowY = doc.y;

    for (let idx = 0; idx < images.length; idx++) {
      const img = images[idx];
      const cx = PAGE_MARGIN + col * (cellW + gap);
      try {
        doc.image(img.buffer, cx, rowY, { fit: [cellW, cellH], align: 'center', valign: 'center' });
      } catch (e) {
        doc.rect(cx, rowY, cellW, cellH).strokeColor(BRAND.border).stroke();
        doc.fontSize(7).fillColor(BRAND.muted).text('Image error', cx + 4, rowY + cellH / 2 - 4, { width: cellW - 8 });
      }
      doc.rect(cx, rowY, cellW, cellH).strokeColor(BRAND.border).lineWidth(0.5).stroke();
      if (img.caption) {
        doc.fontSize(7).fillColor(BRAND.muted).text(img.caption, cx, rowY + cellH + 2, { width: cellW });
      }
      col++;
      if (col >= columns) {
        col = 0;
        rowY += cellH + (images[idx].caption ? 16 : 6);
        this.ensureSpace(cellH + 20);
        rowY = doc.y === rowY - (cellH + (images[idx].caption ? 16 : 6)) ? rowY : doc.y;
      }
    }
    doc.y = rowY + cellH + 16;
    doc.x = PAGE_MARGIN;
  }

  addFooterPageNumbers() {
    const doc = this.doc;
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.height - 26;
      doc.fontSize(8).fillColor(BRAND.muted)
        .text(`Juniper Creates - Confidential QA/QC Report  |  Page ${i + 1} of ${range.count}`,
          PAGE_MARGIN, bottom, { width: this.pageWidth, align: 'center' });
    }
  }

  finish() {
    this.addFooterPageNumbers();
    this.doc.end();
  }
}

function commonChecklist(pdf, payload, sectionData, i18n) {
  pdf.sectionTitle('otherChecksSection', 'General QA Checks');

  const rows = [
    ['fabricColorMatch', sectionData.fabricColorMatch],
    ['fabricWeightMatch', sectionData.fabricWeightMatch],
    ['embroideryColorMatch', sectionData.embroideryColorMatch],
    ['embroideryDimMatch', sectionData.embroideryDimMatch],
    ['printColorMatch', sectionData.printColorMatch],
    ['printDimMatch', sectionData.printDimMatch],
    ['washTagMatch', sectionData.washTagMatch],
    ['generalSizingMatch', sectionData.generalSizingMatch],
    ['packagingCardMatch', sectionData.packagingCardMatch],
    ['bagTagsCorrect', sectionData.bagTagsCorrect],
  ];
  if (payload.category === 'apparel') {
    rows.splice(8, 0, ['sleeveDimMatch', sectionData.sleeveDimMatch]);
  }

  rows.forEach(([key, entry]) => {
    if (!entry) return;
    pdf.checklistRow(bi(i18n, key), entry.status || 'na', entry.notes);
  });
}

async function buildPdf(payload, filesByField, fitsConfig, i18n) {
  return new Promise((resolve, reject) => {
    try {
      const pdf = new ReportPDF(i18n);
      const doc = pdf.doc;
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      payload._reportId = Date.now().toString(36).toUpperCase();

      pdf.drawHeader(payload);

      // --- Order info ---
      pdf.sectionTitle('poInfo', 'Order Information');
      const categoryLabel = payload.category === 'apparel' ? bi(i18n, 'apparel')
        : payload.category === 'plush' ? bi(i18n, 'plush')
        : bi(i18n, 'other');
      const qaTypeLabel = payload.qaType === 'production' ? bi(i18n, 'production') : bi(i18n, 'prePro');

      pdf.keyValueGrid([
        [bi(i18n, 'poNumber'), payload.poNumber],
        [bi(i18n, 'factoryCode'), payload.factoryCode],
        [bi(i18n, 'date'), payload.date],
        [bi(i18n, 'pointCheckRate'), payload.pointCheckRate],
        [bi(i18n, 'qaLead'), payload.qaLead],
        ['Product Category / 产品类别', categoryLabel],
        [bi(i18n, 'qaType'), qaTypeLabel],
        [bi(i18n, 'creator'), payload.creator],
        [bi(i18n, 'productTitle'), payload.productTitle],
      ], 3);

      pdf.paragraph(bi(i18n, 'materials'), payload.materials);
      pdf.paragraph(bi(i18n, 'printingMethod'), payload.printingMethod);

      // --- Category specific ---
      const cd = payload.categoryData || {};

      if (payload.category === 'apparel') {
        if (cd.fit && fitsConfig.fits[cd.fit]) {
          const fitDef = fitsConfig.fits[cd.fit];
          pdf.sectionTitle('sizeChart', 'Measurement Chart');
          pdf.subheading(`${fitDef.label_en} ${fitDef.label_zh}`);
          const sizeRows = (cd.sizeRows || []).filter(r => r.size);
          if (sizeRows.length) {
            pdf.sizeChartTable(fitDef, sizeRows, fitsConfig.toleranceInches || 0.5);
          }
        }
        commonChecklist(pdf, payload, cd, i18n);
      } else if (payload.category === 'plush') {
        commonChecklist(pdf, payload, cd, i18n);
      } else {
        commonChecklist(pdf, payload, cd, i18n);
        pdf.paragraph(bi(i18n, 'customNotes'), cd.customNotes);
      }

      // --- Photos ---
      pdf.sectionTitle('photosSection', 'Photos');
      const generalPhotos = (filesByField['photo_general'] || []).map((f, i) => ({ buffer: f.buffer, caption: `General ${i + 1}` }));
      const tagPhotos = (filesByField['photo_tags'] || []).map((f, i) => ({ buffer: f.buffer, caption: `Tag ${i + 1}` }));

      if (generalPhotos.length) {
        pdf.subheading(bi(i18n, 'generalPhotos'));
      }

      // photoGrid is not actually async-blocking (pdfkit is sync for image draw) - call then continue
      const drawGridSync = (images, cols) => {
        // reimplement synchronously to avoid promise/pdf stream ordering issues
        if (!images.length) return;
        const gap = 8;
        const columns = cols;
        const cellW = (pdf.pageWidth - gap * (columns - 1)) / columns;
        const cellH = cellW * 0.75;
        let col = 0;
        pdf.ensureSpace(cellH + 20);
        let rowY = doc.y;
        images.forEach((img, idx) => {
          const cx = PAGE_MARGIN + col * (cellW + gap);
          try {
            doc.image(img.buffer, cx, rowY, { fit: [cellW, cellH], align: 'center', valign: 'center' });
          } catch (e) {
            doc.rect(cx, rowY, cellW, cellH).strokeColor(BRAND.border).stroke();
          }
          doc.rect(cx, rowY, cellW, cellH).strokeColor(BRAND.border).lineWidth(0.5).stroke();
          col++;
          if (col >= columns) {
            col = 0;
            rowY += cellH + gap;
            if (idx < images.length - 1) {
              pdf.ensureSpace(cellH + 20);
              rowY = doc.y > rowY - cellH - gap ? doc.y : rowY;
            }
          }
        });
        const usedRows = Math.ceil(images.length / columns);
        doc.y = rowY + (col > 0 ? cellH + gap : 0) + 4;
        doc.x = PAGE_MARGIN;
      };

      drawGridSync(generalPhotos, 3);

      if (tagPhotos.length) {
        pdf.subheading(bi(i18n, 'tagPhotos'));
        drawGridSync(tagPhotos, 3);
      }

      // --- Issues ---
      pdf.sectionTitle('issuesSection', 'Issues');
      const issues = payload.issues || [];
      if (!issues.length) {
        doc.font('Regular').fontSize(10).fillColor(BRAND.pass).text(bi(i18n, 'noIssues'));
        doc.moveDown(0.5);
      } else {
        issues.forEach((issue, idx) => {
          pdf.ensureSpace(50);
          const y = doc.y;
          const sevColors = { minor: BRAND.warn, major: '#D35400', critical: BRAND.fail };
          const sevLabels = { minor: bi(i18n, 'minor'), major: bi(i18n, 'major'), critical: bi(i18n, 'critical') };
          doc.font('Bold').fontSize(10).fillColor(BRAND.text)
            .text(`${idx + 1}. ${issue.description || ''}`, PAGE_MARGIN, y, { width: pdf.pageWidth - 90 });
          const sevColor = sevColors[issue.severity] || BRAND.muted;
          doc.roundedRect(PAGE_MARGIN + pdf.pageWidth - 80, y - 2, 80, 16, 3).fillAndStroke(BRAND.greenLight, sevColor);
          doc.fillColor(sevColor).font('Bold').fontSize(8)
            .text(sevLabels[issue.severity] || '-', PAGE_MARGIN + pdf.pageWidth - 80, y + 1, { width: 80, align: 'center' });
          doc.font('Regular').fillColor(BRAND.text);
          doc.y = y + 18;
          doc.x = PAGE_MARGIN;

          const issuePhotos = (filesByField[`photo_issue_${idx}`] || []).map(f => ({ buffer: f.buffer }));
          if (issuePhotos.length) {
            drawGridSync(issuePhotos, 4);
          }
          doc.moveDown(0.3);
        });
      }

      pdf.finish();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildPdf };
