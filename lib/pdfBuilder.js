const PDFDocument = require('pdfkit');
const path = require('path');

// ---- Juniper brand palette (pulled from the official pricing deck template) ----
const BRAND = {
  teal: '#2AAC8D',
  tealDark: '#1F8570',
  mint: '#ACF7E2',
  mintLight: '#EAFBF6',
  text: '#1A1A1A',
  text2: '#262626',
  muted: '#666666',
  mutedLight: '#999999',
  border: '#D9D9D9',
  bg: '#F8F8F8',
  fail: '#C0392B',
  failBg: '#FBEAE8',
  warn: '#B9770E',
  warnBg: '#FCF1DF',
};

const FONT_REGULAR = path.join(__dirname, '..', 'public', 'fonts', 'NotoSansSC-Regular.otf');
const FONT_BOLD = path.join(__dirname, '..', 'public', 'fonts', 'NotoSansSC-Bold.otf');
const FONT_BRAND = path.join(__dirname, '..', 'public', 'fonts', 'LexendDeca-Bold.ttf');
const LOGO_PATH = path.join(__dirname, '..', 'public', 'assets', 'juniper-mark-white.png');

const PAGE_MARGIN = 40;

function bi(i18n, key) {
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
    this.doc.registerFont('Brand', FONT_BRAND);
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

    doc.rect(0, 0, doc.page.width, 64).fill(BRAND.teal);

    try {
      doc.image(LOGO_PATH, PAGE_MARGIN, 14, { width: 36, height: 36 });
    } catch (e) { /* logo optional */ }

    doc.fillColor('#FFFFFF').font('Brand').fontSize(17)
      .text('JUNIPER CREATES', PAGE_MARGIN + 46, topY - 22);
    doc.fillColor(BRAND.mint).font('Regular').fontSize(9.5)
      .text(bi(this.i18n, 'appTitle'), PAGE_MARGIN + 46, topY + 0);

    const rightW = 230;
    const rightX = doc.page.width - PAGE_MARGIN - rightW;
    doc.fillColor('#FFFFFF').fontSize(8)
      .text(`Report ID / 报告编号: ${payload._reportId || ''}`, rightX, topY - 20, { width: rightW, align: 'right' })
      .text(`Generated / 生成时间: ${new Date().toLocaleDateString('en-CA')}`, rightX, topY + 2, { width: rightW, align: 'right' });

    doc.y = 64 + 20;
    doc.x = PAGE_MARGIN;
  }

  drawResultBanner(overallResult) {
    if (!overallResult) return;
    const doc = this.doc;
    const isPass = overallResult.overall === 'pass';
    const color = isPass ? BRAND.tealDark : BRAND.fail;
    const bg = isPass ? BRAND.mintLight : BRAND.failBg;
    const resultLabel = isPass ? bi(this.i18n, 'resultPass') : bi(this.i18n, 'resultFail');

    this.ensureSpace(50);
    const y = doc.y;
    const h = overallResult.reasons && overallResult.reasons.length ? 46 : 34;
    doc.roundedRect(PAGE_MARGIN, y, this.pageWidth, h, 6).fillAndStroke(bg, color);

    doc.fillColor(color).font('Bold').fontSize(9)
      .text(bi(this.i18n, 'overallResult'), PAGE_MARGIN + 14, y + 8, { width: 160 });
    doc.font('Bold').fontSize(15)
      .text(resultLabel, PAGE_MARGIN + 14, y + 8, { width: this.pageWidth - 28, align: 'right' });

    if (overallResult.reasons && overallResult.reasons.length) {
      const reasonKeyMap = {
        tolerance: 'resultReasonTolerance',
        minor: 'resultReasonMinor',
        major: 'resultReasonMajor'
      };
      const reasonText = overallResult.reasons.map((r) => bi(this.i18n, reasonKeyMap[r])).join('  •  ');
      doc.font('Regular').fontSize(8.5).fillColor(color)
        .text(reasonText, PAGE_MARGIN + 14, y + 28, { width: this.pageWidth - 28 });
    }

    doc.y = y + h + 14;
    doc.x = PAGE_MARGIN;
    doc.fillColor(BRAND.text);
  }

  sectionTitle(key, fallback) {
    this.ensureSpace(40);
    const doc = this.doc;
    doc.moveDown(0.6);
    const y = doc.y;
    doc.rect(PAGE_MARGIN, y, this.pageWidth, 22).fill(BRAND.teal);
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

    pairs.forEach(([labelText, value]) => {
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
        rowStartY = doc.y === rowStartY ? rowStartY : doc.y;
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
    const statusColors = { pass: BRAND.tealDark, fail: BRAND.fail, na: BRAND.mutedLight };
    const statusLabels = {
      pass: bi(this.i18n, 'pass'),
      fail: bi(this.i18n, 'fail'),
      na: bi(this.i18n, 'na'),
    };
    const badgeW = 95;
    doc.font('Regular').fontSize(9.5).fillColor(BRAND.text)
      .text(labelText, PAGE_MARGIN, y, { width: this.pageWidth - badgeW - 10 });

    const badgeColor = statusColors[status] || BRAND.mutedLight;
    const badgeText = statusLabels[status] || '-';
    doc.roundedRect(PAGE_MARGIN + this.pageWidth - badgeW, y - 2, badgeW, 16, 3)
      .fillAndStroke(status === 'fail' ? BRAND.failBg : BRAND.mintLight, badgeColor);
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

  referenceChartTable(fitDef) {
    const doc = this.doc;
    const points = fitDef.points;
    const cols = ['size', ...points];
    const labels = cols.map((c) => {
      if (c === 'size') return bi(this.i18n, 'size');
      const pl = fitDef.pointLabels[c];
      return pl ? `${pl.en} ${pl.zh}` : c;
    });
    const colWidths = [1.2, ...points.map(() => 1)];
    const totalUnits = colWidths.reduce((a, b) => a + b, 0);
    const colPx = colWidths.map((w) => (w / totalUnits) * this.pageWidth);
    const rowH = 15;
    const headerH = 18;

    this.ensureSpace(headerH + rowH * 2);
    let y = doc.y;
    doc.rect(PAGE_MARGIN, y, this.pageWidth, headerH).fill(BRAND.mint);
    doc.fillColor(BRAND.tealDark).font('Bold').fontSize(7.5);
    let x = PAGE_MARGIN;
    labels.forEach((lab, i) => { doc.text(lab, x + 4, y + 4, { width: colPx[i] - 8 }); x += colPx[i]; });
    y += headerH;

    Object.keys(fitDef.sizes).forEach((sizeName) => {
      this.ensureSpace(rowH);
      if (doc.y !== y) y = doc.y;
      const standard = fitDef.sizes[sizeName];
      doc.rect(PAGE_MARGIN, y, this.pageWidth, rowH).strokeColor(BRAND.border).lineWidth(0.5).stroke();
      x = PAGE_MARGIN;
      doc.font('Bold').fontSize(8).fillColor(BRAND.text).text(sizeName, x + 4, y + 3, { width: colPx[0] - 8 });
      x += colPx[0];
      points.forEach((p, i) => {
        const std = standard[p];
        doc.font('Regular').fontSize(8).fillColor(BRAND.muted)
          .text(std !== undefined && std !== null && std !== 0 ? `${std}"` : '-', x + 4, y + 3, { width: colPx[i + 1] - 8 });
        x += colPx[i + 1];
      });
      y += rowH;
    });
    doc.y = y + 10;
    doc.x = PAGE_MARGIN;
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

    const headerH = 22;

    this.ensureSpace(headerH + 30);
    let y = doc.y;
    let x = PAGE_MARGIN;

    doc.rect(PAGE_MARGIN, y, this.pageWidth, headerH).fill(BRAND.mintLight);
    doc.fillColor(BRAND.text).font('Bold').fontSize(8);
    x = PAGE_MARGIN;
    labels.forEach((lab, i) => {
      doc.text(lab, x + 4, y + 6, { width: colPx[i] - 8 });
      x += colPx[i];
    });
    y += headerH;

    doc.font('Regular').fontSize(7).fillColor(BRAND.muted);

    sizeRows.forEach((row) => {
      const standard = fitDef.sizes[row.size] || {};
      const cellRowH = 26;
      this.ensureSpace(cellRowH);
      if (doc.y !== y) y = doc.y;
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
          .text(`${bi(this.i18n, 'standard')}: ${stdNum !== null && stdNum !== 0 ? stdNum + '"' : '-'}`, cellX + 4, y + 4, { width: colPx[i + 1] - 8 });
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

  photoGridSync(images, columns = 3) {
    if (!images || images.length === 0) return;
    const doc = this.doc;
    const gap = 8;
    const cellW = (this.pageWidth - gap * (columns - 1)) / columns;
    const cellH = cellW * 0.75;
    let col = 0;
    this.ensureSpace(cellH + 20);
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
          this.ensureSpace(cellH + 20);
          rowY = doc.y > rowY - cellH - gap ? doc.y : rowY;
        }
      }
    });
    doc.y = rowY + (col > 0 ? cellH + gap : 0) + 4;
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

function checklistSection(pdf, sectionTitleKey, rows, filesByField, sectionPhotoField, i18n) {
  pdf.sectionTitle(sectionTitleKey);
  rows.forEach(([key, entry]) => {
    if (!entry) return;
    pdf.checklistRow(bi(i18n, key), entry.status || 'na', entry.notes);
  });
  const photos = (filesByField[sectionPhotoField] || []).map((f) => ({ buffer: f.buffer }));
  if (photos.length) {
    pdf.subheading(bi(i18n, 'sectionPhotos'));
    pdf.photoGridSync(photos, 4);
  }
}

async function buildPdf(payload, filesByField, fitsConfig, i18n, overallResult) {
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
      pdf.drawResultBanner(overallResult);

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

      const cd = payload.categoryData || {};

      // --- Apparel: reference + measured size chart ---
      if (payload.category === 'apparel' && cd.fit && fitsConfig.fits[cd.fit]) {
        const fitDef = fitsConfig.fits[cd.fit];
        pdf.sectionTitle('referenceChart', 'Approved Reference Chart');
        pdf.subheading(`${fitDef.label_en} ${fitDef.label_zh}`);
        pdf.referenceChartTable(fitDef);

        const sizeRows = (cd.sizeRows || []).filter((r) => r.size);
        if (sizeRows.length) {
          pdf.sectionTitle('sizeChart', 'Measurement Chart');
          pdf.sizeChartTable(fitDef, sizeRows, fitsConfig.toleranceInches || 0.5);
        }
      }

      // --- Checklist sections, each with their own photos ---
      checklistSection(pdf, 'fabricSection', [
        ['fabricColorMatch', cd.fabricColorMatch],
        ['fabricWeightMatch', cd.fabricWeightMatch],
      ], filesByField, 'photo_section_fabric', i18n);

      checklistSection(pdf, 'embroiderySection', [
        ['embroideryColorMatch', cd.embroideryColorMatch],
        ['embroideryDimMatch', cd.embroideryDimMatch],
      ], filesByField, 'photo_section_embroidery', i18n);

      checklistSection(pdf, 'printingSection', [
        ['printColorMatch', cd.printColorMatch],
        ['printDimMatch', cd.printDimMatch],
      ], filesByField, 'photo_section_printing', i18n);

      checklistSection(pdf, 'washTagSection', [
        ['washTagMatch', cd.washTagMatch],
      ], filesByField, 'photo_section_washtag', i18n);

      const sizingRows = [['generalSizingMatch', cd.generalSizingMatch]];
      if (payload.category === 'apparel') sizingRows.unshift(['sleeveDimMatch', cd.sleeveDimMatch]);
      checklistSection(pdf, 'sizingSection', sizingRows, filesByField, 'photo_section_sizing', i18n);

      checklistSection(pdf, 'packagingSection', [
        ['packagingCardMatch', cd.packagingCardMatch],
        ['bagTagsCorrect', cd.bagTagsCorrect],
      ], filesByField, 'photo_section_packaging', i18n);

      if (payload.category === 'other') {
        pdf.paragraph(bi(i18n, 'customNotes'), cd.customNotes);
      }

      // --- Final approval photos ---
      pdf.sectionTitle('finalApprovalPhotos', 'Final Approval Photos');
      const generalPhotos = (filesByField['photo_general'] || []).map((f) => ({ buffer: f.buffer }));
      const tagPhotos = (filesByField['photo_tags'] || []).map((f) => ({ buffer: f.buffer }));
      if (generalPhotos.length) {
        pdf.subheading(bi(i18n, 'generalPhotos'));
        pdf.photoGridSync(generalPhotos, 3);
      }
      if (tagPhotos.length) {
        pdf.subheading(bi(i18n, 'tagPhotos'));
        pdf.photoGridSync(tagPhotos, 3);
      }

      // --- Issues ---
      pdf.sectionTitle('issuesSection', 'Issues');
      const issues = payload.issues || [];
      if (!issues.length) {
        doc.font('Regular').fontSize(10).fillColor(BRAND.tealDark).text(bi(i18n, 'noIssues'));
        doc.moveDown(0.5);
      } else {
        issues.forEach((issue, idx) => {
          pdf.ensureSpace(50);
          const y = doc.y;
          const sevColors = { minor: BRAND.warn, major: '#D35400', critical: BRAND.fail };
          const sevLabels = { minor: bi(i18n, 'minor'), major: bi(i18n, 'major'), critical: bi(i18n, 'critical') };
          doc.font('Bold').fontSize(10).fillColor(BRAND.text)
            .text(`${idx + 1}. ${issue.description || ''}`, PAGE_MARGIN, y, { width: pdf.pageWidth - 90 });
          const sevColor = sevColors[issue.severity] || BRAND.mutedLight;
          doc.roundedRect(PAGE_MARGIN + pdf.pageWidth - 80, y - 2, 80, 16, 3).fillAndStroke(BRAND.mintLight, sevColor);
          doc.fillColor(sevColor).font('Bold').fontSize(8)
            .text(sevLabels[issue.severity] || '-', PAGE_MARGIN + pdf.pageWidth - 80, y + 1, { width: 80, align: 'center' });
          doc.font('Regular').fillColor(BRAND.text);
          doc.y = y + 18;
          doc.x = PAGE_MARGIN;

          const issuePhotos = (filesByField[`photo_issue_${idx}`] || []).map((f) => ({ buffer: f.buffer }));
          if (issuePhotos.length) {
            pdf.photoGridSync(issuePhotos, 4);
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
