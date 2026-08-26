const PDFDocument = require('pdfkit');
const path = require('path');
const { isOutOfTolerance, formatStandard } = require('./passFail');

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
  return `${entry.zh} ${entry.en}`;
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
      .text(`报告编号 / Report ID: ${payload._reportId || ''}`, rightX, topY - 20, { width: rightW, align: 'right' })
      .text(`生成时间 / Generated: ${new Date().toLocaleDateString('en-CA')}`, rightX, topY + 2, { width: rightW, align: 'right' });

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

    const reasonKeyMap = {
      tolerance: 'resultReasonTolerance',
      minor: 'resultReasonMinor',
      major: 'resultReasonMajor',
      aqlCritical: 'resultReasonAqlCritical',
      aqlMajor: 'resultReasonAqlMajor',
      aqlMinor: 'resultReasonAqlMinor'
    };
    const reasonText = (overallResult.reasons || []).map((r) => bi(this.i18n, reasonKeyMap[r])).join('  •  ');
    doc.font('Regular').fontSize(8.5);
    const reasonHeight = reasonText ? doc.heightOfString(reasonText, { width: this.pageWidth - 28 }) : 0;
    const h = reasonText ? Math.max(46, 28 + reasonHeight + 8) : 34;

    this.ensureSpace(h + 4);
    const y = doc.y;
    doc.roundedRect(PAGE_MARGIN, y, this.pageWidth, h, 6).fillAndStroke(bg, color);

    doc.fillColor(color).font('Bold').fontSize(9)
      .text(bi(this.i18n, 'overallResult'), PAGE_MARGIN + 14, y + 8, { width: 160 });
    doc.font('Bold').fontSize(15)
      .text(resultLabel, PAGE_MARGIN + 14, y + 8, { width: this.pageWidth - 28, align: 'right' });

    if (overallResult.reasons && overallResult.reasons.length) {
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
    let col = 0;
    let rowStartY = doc.y;

    // Compute a row height that fits the tallest wrapped label in this row, so long
    // bilingual labels never collide with the value line below them.
    const labelHeightFor = (labelText) => {
      doc.font('Regular').fontSize(8);
      return doc.heightOfString(labelText, { width: colWidth - 10 });
    };
    const rowHeightFor = (rowPairs) => {
      const maxLabelH = Math.max(...rowPairs.map(([l]) => labelHeightFor(l)));
      return Math.max(32, maxLabelH + 20);
    };

    this.ensureSpace(40);
    rowStartY = doc.y;
    let currentRow = [];

    const flushRow = () => {
      if (!currentRow.length) return;
      const rowH = rowHeightFor(currentRow);
      this.ensureSpace(rowH);
      if (doc.y !== rowStartY) rowStartY = doc.y;
      currentRow.forEach(([labelText, value], i) => {
        const cx = PAGE_MARGIN + i * colWidth;
        const cy = rowStartY;
        doc.font('Regular').fontSize(8).fillColor(BRAND.muted)
          .text(labelText, cx, cy, { width: colWidth - 10 });
        const labelH = labelHeightFor(labelText);
        doc.font('Bold').fontSize(10.5).fillColor(BRAND.text)
          .text(value && String(value).trim() ? String(value) : '-', cx, cy + labelH + 3, { width: colWidth - 10 });
      });
      rowStartY += rowH;
      currentRow = [];
    };

    pairs.forEach((pair) => {
      currentRow.push(pair);
      col++;
      if (col >= cols) {
        flushRow();
        col = 0;
      }
    });
    flushRow();

    doc.y = rowStartY;
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
      return pl ? `${pl.zh} ${pl.en}` : c;
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
          .text(formatStandard(std), x + 4, y + 3, { width: colPx[i + 1] - 8 });
        x += colPx[i + 1];
      });
      y += rowH;
    });
    doc.y = y + 10;
    doc.x = PAGE_MARGIN;
  }

  sizeChartTable(fitDef, sizeRows, toleranceInches, filesByField) {
    const doc = this.doc;
    const points = fitDef.points;
    const cols = ['size', ...points];
    const labels = cols.map((c) => {
      if (c === 'size') return bi(this.i18n, 'size');
      const pl = fitDef.pointLabels[c];
      return pl ? `${pl.zh} ${pl.en}` : c;
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
        const outOfTol = isOutOfTolerance(std, measured, toleranceInches);
        const cellX = x;
        if (outOfTol) {
          doc.rect(cellX, y, colPx[i + 1], cellRowH).fill(BRAND.failBg);
        }
        doc.font('Regular').fontSize(7).fillColor(BRAND.muted)
          .text(`${bi(this.i18n, 'standard')}: ${formatStandard(std)}`, cellX + 4, y + 4, { width: colPx[i + 1] - 8 });
        doc.font(outOfTol ? 'Bold' : 'Regular').fontSize(8)
          .fillColor(outOfTol ? BRAND.fail : BRAND.text)
          .text(`${bi(this.i18n, 'measured')}: ${measured !== null && !isNaN(measured) ? measured + '"' : '-'}${outOfTol ? '  !' : ''}`, cellX + 4, y + 15, { width: colPx[i + 1] - 8 });
        x += colPx[i + 1];
      });

      y += cellRowH;

      if (filesByField) {
        const idx = row._origIndex !== undefined ? row._origIndex : sizeRows.indexOf(row);
        const sizePhotos = (filesByField[`photo_sizerow_${idx}`] || []).map((f) => ({ buffer: f.buffer }));
        if (sizePhotos.length) {
          doc.y = y + 4;
          doc.x = PAGE_MARGIN;
          this.photoGridSync(sizePhotos, 4);
          y = doc.y;
        }
      }
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

  aqlSummary(aql, i18n, recommendation, payload) {
    const doc = this.doc;
    this.sectionTitle('quantityRecapTitle', 'Recap');

    if (aql.isPreProduction) {
      doc.font('Regular').fontSize(9).fillColor(BRAND.warn).text(bi(i18n, 'aqlPreProductionNotice'), { width: this.pageWidth });
      doc.moveDown(0.4);
      this.keyValueGrid([
        [bi(i18n, 'poSize'), aql.poSize !== null ? String(aql.poSize) : '-'],
        [bi(i18n, 'quantityChecked'), aql.quantityChecked !== null ? String(aql.quantityChecked) : '-'],
        [bi(i18n, 'aqlCritical'), String(aql.criticalCount)],
        [bi(i18n, 'aqlMajor'), String(aql.majorCount)],
        [bi(i18n, 'aqlMinor'), String(aql.minorCount)],
      ], 3);
      return;
    }

    if (recommendation) {
      const riskLabel = payload && payload.productRisk ? bi(i18n, 'risk' + payload.productRisk.charAt(0).toUpperCase() + payload.productRisk.slice(1)) : '-';
      let rangeStr = '-';
      const match = String(recommendation.pointCheck).match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/);
      if (match && payload && payload.poQuantity) {
        const qty = parseInt(payload.poQuantity, 10);
        const lo = Math.round(qty * (parseFloat(match[1]) / 100));
        const hi = Math.round(qty * (parseFloat(match[2]) / 100));
        rangeStr = `${lo.toLocaleString()} - ${hi.toLocaleString()} (${recommendation.pointCheck})`;
      }
      this.keyValueGrid([
        [bi(i18n, 'productRisk'), riskLabel],
        [bi(i18n, 'orderValue'), `$${recommendation.orderValue.toLocaleString()}`],
        [bi(i18n, 'creatorTierLabel'), `Tier ${recommendation.tier}`],
        [bi(i18n, 'recommendedQuantityRange'), rangeStr],
      ], 3);
    }

    if (aql.isFallback) {
      doc.font('Regular').fontSize(9).fillColor(BRAND.warn).text(bi(i18n, 'aqlFallbackNotice'), { width: this.pageWidth });
      doc.moveDown(0.3);
      this.keyValueGrid([
        [bi(i18n, 'aqlCritical'), String(aql.criticalCount)],
        [bi(i18n, 'aqlMajor'), String(aql.majorCount)],
        [bi(i18n, 'aqlMinor'), String(aql.minorCount)],
      ], 3);
      return;
    }

    // Found vs Accepted table - Critical/Major finds are rejected on a per-unit
    // basis, Minor finds stay accepted (minor issues don't make a unit unsaleable).
    const rows = [
      [bi(i18n, 'aqlCritical'), aql.criticalCount, 0],
      [bi(i18n, 'aqlMajor'), aql.majorCount, 0],
      [bi(i18n, 'aqlMinor'), aql.minorCount, aql.minorCount],
    ];

    const colPx = [this.pageWidth * 0.5, this.pageWidth * 0.25, this.pageWidth * 0.25];
    const headerH = 20;
    this.ensureSpace(headerH + rows.length * 20 + 10);
    let y = doc.y;
    doc.rect(PAGE_MARGIN, y, this.pageWidth, headerH).fill(BRAND.mintLight);
    doc.font('Bold').fontSize(8).fillColor(BRAND.text);
    let x = PAGE_MARGIN;
    ['', bi(i18n, 'foundLabel'), bi(i18n, 'acceptedLabel')].forEach((label, i) => {
      doc.text(label, x + 6, y + 6, { width: colPx[i] - 8, align: i === 0 ? 'left' : 'center' });
      x += colPx[i];
    });
    y += headerH;

    rows.forEach(([label, found, accepted]) => {
      const rowH = 20;
      this.ensureSpace(rowH);
      if (doc.y !== y) y = doc.y;
      doc.rect(PAGE_MARGIN, y, this.pageWidth, rowH).strokeColor(BRAND.border).lineWidth(0.5).stroke();
      x = PAGE_MARGIN;
      doc.font('Regular').fontSize(8.5).fillColor(BRAND.text).text(label, x + 6, y + 5, { width: colPx[0] - 8 });
      x += colPx[0];
      doc.fillColor(BRAND.text).text(String(found), x, y + 5, { width: colPx[1], align: 'center' });
      x += colPx[1];
      doc.text(String(accepted), x, y + 5, { width: colPx[2], align: 'center' });
      y += rowH;
    });

    doc.y = y + 10;
    doc.x = PAGE_MARGIN;

    if (aql.recap) {
      this.keyValueGrid([
        [bi(i18n, 'poSize'), aql.recap.poSize !== null ? String(aql.recap.poSize) : '-'],
        [bi(i18n, 'quantityChecked'), String(aql.recap.quantityChecked)],
        [bi(i18n, 'quantityApproved'), String(aql.recap.quantityApproved)],
        [bi(i18n, 'quantityRejected'), String(aql.recap.quantityRejected)],
      ], 4);
    }
  }

  /** Renders one logged defect: description, severity badge, units affected, and its own photos. */
  defectCard(defect, filesByField) {
    const doc = this.doc;
    const i18n = this.i18n;
    this.ensureSpace(50);
    const y = doc.y;
    const sevColors = { minor: BRAND.warn, major: '#D35400', critical: BRAND.fail };
    const sevLabels = { minor: bi(i18n, 'minor'), major: bi(i18n, 'major'), critical: bi(i18n, 'critical') };
    const badgeW = 70;
    doc.font('Regular').fontSize(9).fillColor(BRAND.text)
      .text(defect.description || '-', PAGE_MARGIN, y, { width: this.pageWidth - badgeW - 10 });
    const sevColor = sevColors[defect.severity] || BRAND.mutedLight;
    doc.roundedRect(PAGE_MARGIN + this.pageWidth - badgeW, y - 2, badgeW, 15, 3).fillAndStroke(BRAND.mintLight, sevColor);
    doc.fillColor(sevColor).font('Bold').fontSize(7.5)
      .text(sevLabels[defect.severity] || '-', PAGE_MARGIN + this.pageWidth - badgeW, y + 1, { width: badgeW, align: 'center' });

    const descH = doc.font('Regular').fontSize(9).heightOfString(defect.description || '-', { width: this.pageWidth - badgeW - 10 });
    const unitsText = `${bi(i18n, 'unitsAffected')}: ${defect.unitsAffected || 1}`;
    doc.font('Regular').fontSize(8).fillColor(BRAND.muted)
      .text(unitsText, PAGE_MARGIN, y + descH + 3, { width: this.pageWidth - badgeW - 10 });
    doc.y = y + descH + 3 + 12;
    doc.x = PAGE_MARGIN;
    doc.fillColor(BRAND.text).font('Regular');

    const photos = (filesByField[`photo_defect_${defect.id}`] || []).map((f) => ({ buffer: f.buffer }));
    if (photos.length) this.photoGridSync(photos, 4);
    doc.moveDown(0.3);
  }

  addFooterPageNumbers() {
    const doc = this.doc;
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.height - 26;
      // Drawing this close to the physical bottom edge sits inside the page's
      // margin, which would otherwise make PDFKit think the content overflows
      // and silently insert a blank extra page. Temporarily zero the bottom
      // margin so the footer can safely render there without side effects.
      const originalBottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fontSize(8).fillColor(BRAND.muted)
        .text(`Juniper Creates - 保密质检报告 QA/QC Report  |  第 ${i + 1} 页，共 ${range.count} 页`,
          PAGE_MARGIN, bottom, { width: this.pageWidth, align: 'center', lineBreak: false });
      doc.page.margins.bottom = originalBottomMargin;
    }
  }

  finish() {
    this.addFooterPageNumbers();
    this.doc.end();
  }
}

function checklistSection(pdf, sectionTitleKey, rows, filesByField, i18n, photoSectionKey) {
  pdf.sectionTitle(sectionTitleKey);
  rows.forEach(([key, entry]) => {
    if (!entry) return;
    pdf.checklistRow(bi(i18n, key), entry.status || 'na', entry.notes);
    if (entry.status === 'fail' && Array.isArray(entry.defects) && entry.defects.length) {
      entry.defects.forEach((d) => pdf.defectCard(d, filesByField));
    }
  });
  if (photoSectionKey) {
    const generalPhotos = (filesByField[`photo_section_${photoSectionKey}`] || []).map((f) => ({ buffer: f.buffer }));
    if (generalPhotos.length) {
      pdf.subheading(bi(i18n, 'sectionPhotosGeneral'));
      pdf.photoGridSync(generalPhotos, 4);
    }
  }
}

async function buildPdf(payload, filesByField, fitsConfig, i18n, overallResult, categoriesConfig, recommendation) {
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
      let categoryLabel = bi(i18n, payload.category) || payload.category;
      let subcategoryLabel = '';
      if (categoriesConfig && categoriesConfig.categories[payload.category]) {
        const catDef = categoriesConfig.categories[payload.category];
        categoryLabel = `${catDef.label_zh} ${catDef.label_en}`;
        if (payload.subcategory) {
          const subDef = (catDef.subcategories || []).find((s) => s.key === payload.subcategory);
          if (subDef) subcategoryLabel = `${subDef.label_zh} ${subDef.label_en}`;
        }
      }
      const qaTypeLabel = payload.qaType === 'production' ? bi(i18n, 'production') : bi(i18n, 'prePro');

      pdf.keyValueGrid([
        [bi(i18n, 'poNumber'), payload.poNumber],
        [bi(i18n, 'factoryCode'), payload.factoryCode],
        [bi(i18n, 'date'), payload.date],
        ['Category / 类别', categoryLabel],
        ['Type / 类型', subcategoryLabel],
        [bi(i18n, 'qaType'), qaTypeLabel],
        [bi(i18n, 'poSize'), payload.poQuantity ? String(payload.poQuantity) : '-'],
        [bi(i18n, 'qaLead'), payload.qaLead],
        [bi(i18n, 'creator'), payload.creator],
        [bi(i18n, 'productTitle'), payload.productTitle],
      ], 3);

      pdf.paragraph(bi(i18n, 'materials'), payload.materials);
      pdf.paragraph(bi(i18n, 'printingMethod'), payload.printingMethod);

      // --- AQL sampling summary ---
      if (overallResult && overallResult.aql) {
        pdf.aqlSummary(overallResult.aql, i18n, recommendation, payload);
      }

      const cd = payload.categoryData || {};
      const OTHER_FIT_VALUE = '__other_fit__';

      // --- Apparel: reference + measured size chart (standard fits only) ---
      if (payload.category === 'apparel' && cd.fit && cd.fit !== OTHER_FIT_VALUE && fitsConfig.fits[cd.fit]) {
        const fitDef = fitsConfig.fits[cd.fit];
        pdf.sectionTitle('referenceChart', 'Approved Reference Chart');
        pdf.subheading(`${fitDef.label_zh} ${fitDef.label_en}`);
        pdf.referenceChartTable(fitDef);

        const sizeRows = (cd.sizeRows || []).map((r, idx) => ({ ...r, _origIndex: idx })).filter((r) => r.size);
        if (sizeRows.length) {
          pdf.sectionTitle('sizeChart', 'Measurement Chart');
          pdf.sizeChartTable(fitDef, sizeRows, fitsConfig.toleranceInches || 0.5, filesByField);
        }
      }

      // --- Apparel: custom size chart ("Other / Custom Sizing") ---
      if (payload.category === 'apparel' && cd.fit === OTHER_FIT_VALUE) {
        const customRows = (cd.customSizeRows || []).map((r, idx) => ({ ...r, _origIndex: idx })).filter((r) => r.sizeName || r.measurements);
        if (customRows.length) {
          pdf.sectionTitle('customSizeChartTitle', 'Custom Size Chart');
          customRows.forEach((row) => {
            pdf.subheading(row.sizeName || '-');
            doc.font('Regular').fontSize(9).fillColor(BRAND.text).text(row.measurements || '-', { width: pdf.pageWidth });
            doc.moveDown(0.3);
            const rowPhotos = (filesByField[`photo_customsizerow_${row._origIndex}`] || []).map((f) => ({ buffer: f.buffer }));
            if (rowPhotos.length) pdf.photoGridSync(rowPhotos, 4);
            doc.moveDown(0.3);
          });
        }
        const chartPhotos = (filesByField['photo_chart'] || []).map((f) => ({ buffer: f.buffer }));
        if (chartPhotos.length) {
          pdf.sectionTitle('chartPhotoTitle', 'Reference Chart Photo');
          pdf.photoGridSync(chartPhotos, 4);
        }
      }

      // --- Checklist sections, each with their own general photos + logged defects ---
      checklistSection(pdf, 'fabricSection', [
        ['fabricColorMatch', cd.fabricColorMatch],
        ['fabricWeightMatch', cd.fabricWeightMatch],
      ], filesByField, i18n, 'fabric');

      checklistSection(pdf, 'embroiderySection', [
        ['embroideryColorMatch', cd.embroideryColorMatch],
        ['embroideryDimMatch', cd.embroideryDimMatch],
      ], filesByField, i18n, 'embroidery');

      checklistSection(pdf, 'printingSection', [
        ['printColorMatch', cd.printColorMatch],
        ['printDimMatch', cd.printDimMatch],
      ], filesByField, i18n, 'printing');

      checklistSection(pdf, 'washTagSection', [
        ['washTagMatch', cd.washTagMatch],
      ], filesByField, i18n, 'washtag');

      const sizingRows = [['generalSizingMatch', cd.generalSizingMatch]];
      if (payload.category === 'apparel' && cd.fit && cd.fit !== OTHER_FIT_VALUE) {
        // Standard apparel sizing is already fully captured by the reference +
        // measurement charts above, so skip the checklist and just show the
        // dedicated photos.
        const sizingPhotos = (filesByField['photo_section_sizing'] || []).map((f) => ({ buffer: f.buffer }));
        if (sizingPhotos.length) {
          pdf.sectionTitle('sizingSection');
          pdf.subheading(bi(i18n, 'sectionPhotos'));
          pdf.photoGridSync(sizingPhotos, 4);
        }
      } else {
        // Non-apparel, and apparel with "Other / Custom Sizing" (no automatic
        // tolerance check exists for it, so the manual Pass/Fail + defect log
        // is the actual QC record, alongside the custom chart above).
        checklistSection(pdf, 'sizingSection', sizingRows, filesByField, i18n, 'sizing');
      }

      checklistSection(pdf, 'packagingSection', [
        ['packagingCardMatch', cd.packagingCardMatch],
        ['bagTagsCorrect', cd.bagTagsCorrect],
      ], filesByField, i18n, 'packaging');

      if (payload.category === 'other') {
        pdf.paragraph(bi(i18n, 'customNotes'), cd.customNotes);
      }

      // --- Additional Issues (catch-all, separate from per-section logged defects) ---
      pdf.sectionTitle('additionalIssuesSection', 'Additional Issues');
      const additionalIssues = payload.additionalIssues || [];
      if (!additionalIssues.length) {
        doc.font('Regular').fontSize(10).fillColor(BRAND.tealDark).text(bi(i18n, 'noIssues'));
        doc.moveDown(0.5);
      } else {
        additionalIssues.forEach((issue) => pdf.defectCard(issue, filesByField));
      }

      // --- Final recap, restated at the end of the report for a quick bottom line ---
      if (overallResult && overallResult.aql && overallResult.aql.recap) {
        const recap = overallResult.aql.recap;
        pdf.sectionTitle('quantityRecapTitle', 'Recap');
        pdf.keyValueGrid([
          [bi(i18n, 'poSize'), recap.poSize !== null ? String(recap.poSize) : '-'],
          [bi(i18n, 'quantityChecked'), String(recap.quantityChecked)],
          [bi(i18n, 'quantityApproved'), String(recap.quantityApproved)],
          [bi(i18n, 'quantityRejected'), String(recap.quantityRejected)],
        ], 4);
      }

      pdf.finish();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildPdf };
