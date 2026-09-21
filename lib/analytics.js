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
/* Fail thresholds, so the "final" figures can be recomputed after repairs.
 * Same source the report itself uses - see failThresholds in config/aql.json. */
const aqlTable = require('../config/aql.json');
const TH = (() => {
  const t = (aqlTable && aqlTable.failThresholds) || {};
  return {
    criticalPct: t.criticalPct !== undefined ? t.criticalPct : 0,
    majorPct: t.majorPct !== undefined ? t.majorPct : 1.5,
    minorPct: t.minorPct !== undefined ? t.minorPct : 4
  };
})();

/**
 * Units later confirmed repaired for one PO and stage, split by severity.
 *
 * Revised Unit Reports are follow-ups, not inspections, so they never appear as
 * their own row in these stats. What they do is change what the ORIGINAL report
 * means once the repairs landed - which is why the summary below reports two
 * sets of numbers rather than one.
 */
function repairedBySeverity(revisedReports, poNumber, qaType) {
  const out = { critical: 0, major: 0, minor: 0 };
  (revisedReports || []).forEach((r) => {
    if (String(r.poNumber) !== String(poNumber)) return;
    if (qaType && r.qaType && r.qaType !== qaType) return;
    (r.issues || []).forEach((iss) => {
      const sev = out[iss.severity] !== undefined ? iss.severity : 'minor';
      out[sev] += parseInt(iss.unitsFixed, 10) || 0;
    });
  });
  return out;
}

/** Does a report pass on these counts? Mirrors rateFailures in public/app.js. */
function passesThresholds(counts, unitsChecked) {
  if (!unitsChecked || unitsChecked < 1) return null;
  const total = counts.critical + counts.major + counts.minor;
  const pct = (n) => (n / unitsChecked) * 100;
  if (total >= unitsChecked) return false;                 // critical: whole batch
  if (pct(counts.major) > TH.majorPct) return false;
  if (pct(counts.minor) > TH.minorPct) return false;
  return true;
}

function summarize(entries) {
  const poNumbers = new Set();
  let manufacturedQuantity = 0;
  let unitsChecked = 0;
  let unitsRejected = 0;
  let criticalFound = 0, majorFound = 0, minorFound = 0;
  let unitsRepairedOnSite = 0, unitsFactoryToFix = 0;
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
      if (e.recap) unitsChecked += e.recap.quantityChecked || 0;
      /* Prefer what the inspector actually decided over the AQL estimate.
       * Older reports have no dispositionSummary, so they fall back to the
       * recap figure and keep reading as they always did. */
      if (e.dispositionSummary) {
        unitsRejected += e.dispositionSummary.rejected || 0;
        unitsRepairedOnSite += e.dispositionSummary.repairedOnSite || 0;
        unitsFactoryToFix += e.dispositionSummary.factoryToFix || 0;
      } else if (e.recap) {
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
    criticalFound, majorFound, minorFound,
    unitsRepairedOnSite, unitsFactoryToFix
  };
}

/**
 * Both views of the same set of reports.
 *
 *   initial - the report as submitted. "Did the factory get it right first
 *             time." Untouched by later repairs, which is the point.
 *   final   - after Revised Unit Reports confirmed repairs. "What ended up
 *             being acceptable."
 *
 * Splitting them matters because a single number could not answer both, and
 * folding repairs into the original figures would have quietly erased the
 * factory's first-pass performance - exactly the thing these stats exist to
 * measure.
 */
function summarizeBoth(entries, revisedReports) {
  const initial = summarize(entries);

  const adjusted = entries.map((e) => {
    if (e.qaType !== 'production') return e;
    const fixed = repairedBySeverity(revisedReports, e.poNumber, e.qaType);
    const counts = {
      critical: Math.max(0, (e.criticalCount || 0) - fixed.critical),
      major: Math.max(0, (e.majorCount || 0) - fixed.major),
      minor: Math.max(0, (e.minorCount || 0) - fixed.minor)
    };
    const checked = (e.recap && e.recap.quantityChecked) || e.actualUnitsChecked || 0;
    const passed = passesThresholds(counts, checked);
    return {
      ...e,
      criticalCount: counts.critical,
      majorCount: counts.major,
      minorCount: counts.minor,
      // Only override the verdict when there is enough to recompute it.
      overallResult: passed === null ? e.overallResult : (passed ? 'pass' : 'fail')
    };
  });

  return { initial, final: summarize(adjusted) };
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

function vendorStats(allEntries, creator, start, end, revisedReports) {
  const filtered = allEntries.filter((e) => e.creator === creator);
  const scoped = filtered.filter((e) => e.date && inRange(e.date, start, end));
  const both = summarizeBoth(scoped, revisedReports);
  return {
    creator,
    months: groupByMonth(filtered, start, end),
    // `total` stays as the initial figures so existing callers are unaffected.
    total: both.initial,
    totals: both
  };
}

function factoryStats(allEntries, factoryCode, start, end, revisedReports) {
  const filtered = allEntries.filter((e) => e.factoryCode === factoryCode);
  const scoped = filtered.filter((e) => e.date && inRange(e.date, start, end));
  const both = summarizeBoth(scoped, revisedReports);
  return {
    factoryCode,
    months: groupByMonth(filtered, start, end),
    total: both.initial,
    totals: both
  };
}

/* Kept in step with config/categories.json - Paper Goods was added there and
 * never here, so it was silently absent from category analytics. */
const TOP_LEVEL_CATEGORIES = ['apparel', 'plush', 'bags', 'accessories', 'paperGoods', 'other'];

function categoryStats(allEntries, start, end, revisedReports) {
  return TOP_LEVEL_CATEGORIES.map((cat) => {
    const filtered = allEntries.filter((e) => e.category === cat);
    const scoped = filtered.filter((e) => e.date && inRange(e.date, start, end));
    const both = summarizeBoth(scoped, revisedReports);
    return {
      category: cat,
      months: groupByMonth(filtered, start, end),
      total: both.initial,
      totals: both
    };
  });
}

module.exports = { vendorStats, factoryStats, categoryStats, groupByMonth, summarize, summarizeBoth, TOP_LEVEL_CATEGORIES };
