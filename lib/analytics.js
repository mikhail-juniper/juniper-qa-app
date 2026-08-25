/**
 * Aggregates the submission log into month-by-month stats, either grouped by
 * Creator (vendor dashboard) or by top-level Category (overall dashboard).
 * "Manufactured quantity" and defect-rate figures are only drawn from
 * Production Sample reports (Pre-Production doesn't carry a formal checked
 * quantity), keyed to the report's entered inspection Date.
 */

function monthKey(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function inRange(dateStr, start, end) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  return d >= start && d <= end;
}

/** Summarizes one bucket of already-filtered submission entries. */
function summarize(entries) {
  const poNumbers = new Set();
  let manufacturedQuantity = 0;
  let unitsChecked = 0;
  let unitsRejected = 0;
  let criticalFound = 0, majorFound = 0, minorFound = 0;
  let productionReports = 0;
  let productionPasses = 0;

  entries.forEach((e) => {
    if (e.poNumber) poNumbers.add(String(e.poNumber).trim().toLowerCase());
    criticalFound += e.criticalCount || 0;
    majorFound += e.majorCount || 0;
    minorFound += e.minorCount || 0;
    if (e.qaType === 'production') {
      productionReports += 1;
      if (e.overallResult === 'pass') productionPasses += 1;
      if (e.poQuantity) manufacturedQuantity += e.poQuantity;
      if (e.recap) {
        unitsChecked += e.recap.quantityChecked || 0;
        unitsRejected += e.recap.quantityRejected || 0;
      }
    }
  });

  return {
    posPlaced: poNumbers.size,
    manufacturedQuantity,
    unitsChecked,
    unitsRejected,
    defectiveRate: unitsChecked > 0 ? Math.round((unitsRejected / unitsChecked) * 1000) / 10 : null,
    passRate: productionReports > 0 ? Math.round((productionPasses / productionReports) * 1000) / 10 : null,
    productionReports,
    criticalFound, majorFound, minorFound
  };
}

/** Groups already-scoped entries by calendar month (report Date) within [start, end]. */
function groupByMonth(entries, start, end) {
  const filtered = entries.filter((e) => e.date && inRange(e.date, start, end));
  const byMonth = {};
  filtered.forEach((e) => {
    const mk = monthKey(e.date);
    if (!mk) return;
    if (!byMonth[mk]) byMonth[mk] = [];
    byMonth[mk].push(e);
  });
  return Object.keys(byMonth).sort().map((m) => ({ month: m, ...summarize(byMonth[m]) }));
}

function vendorStats(allEntries, creator, start, end) {
  const filtered = allEntries.filter((e) => e.creator === creator);
  return {
    creator,
    months: groupByMonth(filtered, start, end),
    total: summarize(filtered.filter((e) => e.date && inRange(e.date, start, end)))
  };
}

const TOP_LEVEL_CATEGORIES = ['apparel', 'plush', 'bags', 'accessories', 'other'];

function categoryStats(allEntries, start, end) {
  return TOP_LEVEL_CATEGORIES.map((cat) => {
    const filtered = allEntries.filter((e) => e.category === cat);
    return {
      category: cat,
      months: groupByMonth(filtered, start, end),
      total: summarize(filtered.filter((e) => e.date && inRange(e.date, start, end)))
    };
  });
}

module.exports = { vendorStats, categoryStats, groupByMonth, summarize, TOP_LEVEL_CATEGORIES };
