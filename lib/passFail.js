const { computeAqlPlan, computeActualAqlPlan } = require('./aql');

// Every checklist item across all inspection sections that can carry its own
// logged defects (added inline when marked "Fail").
const CHECKLIST_KEYS = [
  'fabricColorMatch', 'fabricWeightMatch',
  'embroideryColorMatch', 'embroideryDimMatch',
  'printColorMatch', 'printDimMatch',
  'washTagMatch',
  'generalSizingMatch',
  'packagingCardMatch', 'bagTagsCorrect'
];

/** Gathers every logged defect from all checklist sections plus Additional Issues. */
function collectAllDefects(payload) {
  const all = [];
  const cd = payload.categoryData || {};
  CHECKLIST_KEYS.forEach((key) => {
    const item = cd[key];
    if (item && Array.isArray(item.defects)) {
      item.defects.forEach((d) => all.push(d));
    }
  });
  (payload.additionalIssues || []).forEach((d) => all.push(d));
  return all;
}

/**
 * Sums units affected per severity (not just number of log entries) - so one
 * defect entry logged against 20 units counts as 20, not 1.
 */
function sumDefectsBySeverity(defects) {
  const sums = { minor: 0, major: 0, critical: 0 };
  defects.forEach((d) => {
    const n = parseInt(d.unitsAffected, 10);
    const qty = isNaN(n) || n < 1 ? 1 : n;
    if (sums[d.severity] !== undefined) sums[d.severity] += qty;
  });
  return sums;
}

/**
 * Pass/fail logic:
 *  - FAIL if any apparel measurement is outside tolerance (independent of AQL)
 *  - If a lot size is provided, uses proper AQL sampling (ANSI/ASQ Z1.4): sums the
 *    number of units affected by Critical/Major/Minor defects (logged inline on each
 *    checklist section, plus Additional Issues) and compares each total against that
 *    lot size's Accept/Reject numbers for the chosen AQL levels.
 *  - If no lot size is provided (or it doesn't resolve to a valid plan), falls back
 *    to a simple heuristic (3+ minor units affected, or 1+ major/critical) so the
 *    form still works before AQL fields are filled in.
 */
function computeOverallResult(payload, fitsConfig) {
  const reasons = [];

  if (payload.category === 'apparel' && payload.categoryData && payload.categoryData.fit && fitsConfig) {
    const fitDef = fitsConfig.fits[payload.categoryData.fit];
    const tol = fitsConfig.toleranceInches || 0.5;
    if (fitDef) {
      const rows = payload.categoryData.sizeRows || [];
      outer: for (const row of rows) {
        const standard = fitDef.sizes[row.size] || {};
        for (const point of fitDef.points) {
          const measured = row.measured && row.measured[point] !== undefined && row.measured[point] !== ''
            ? parseFloat(row.measured[point]) : null;
          if (isOutOfTolerance(standard[point], measured, tol)) {
            reasons.push('tolerance');
            break outer;
          }
        }
      }
    }
  }

  const allDefects = collectAllDefects(payload);
  const { critical: criticalCount, major: majorCount, minor: minorCount } = sumDefectsBySeverity(allDefects);

  let aql = null;

  if (payload.qaType === 'pre_production') {
    // Pre-production is a small hand-check of a few units (at least one per size) -
    // formal AQL sampling doesn't apply here at all.
    aql = { criticalCount, majorCount, minorCount, isFallback: true, isPreProduction: true };
  } else {
    // Production: pass/fail is driven by what was ACTUALLY inspected (PO Quantity x
    // Actual Spot Check %), not just the theoretical lot-size-derived sample size -
    // checking fewer units than recommended should be reflected in a smaller
    // allowable defect count, and vice versa.
    const actualPlan = payload.actualSpotCheckPercent ? computeActualAqlPlan({
      poQuantity: payload.poQuantity,
      actualSpotCheckPercent: payload.actualSpotCheckPercent,
      majorAql: payload.majorAql || 2.5,
      minorAql: payload.minorAql || 4.0
    }) : null;

    if (actualPlan) {
      if (criticalCount > actualPlan.critical.ac) reasons.push('aqlCritical');
      if (majorCount > actualPlan.major.ac) reasons.push('aqlMajor');
      if (minorCount > actualPlan.minor.ac) reasons.push('aqlMinor');
      aql = { ...actualPlan, criticalCount, majorCount, minorCount, isFallback: false, isActual: true };
    } else {
      // No actual spot check % recorded yet - fall back to the simple heuristic.
      if (minorCount >= 3) reasons.push('minor');
      if (majorCount + criticalCount >= 1) reasons.push('major');
      aql = { criticalCount, majorCount, minorCount, isFallback: true };
    }
  }

  return {
    overall: reasons.length ? 'fail' : 'pass',
    reasons,
    aql
  };
}

/**
 * Determines whether a measured value is out of tolerance against a standard,
 * where the standard can be a plain number (point target, checked against
 * +/- tolerance) or a {min, max} range (as approved for some garments, e.g.
 * jacket width, hat circumference) - checked against [min - tolerance, max + tolerance].
 * Returns false if there isn't enough info to judge (missing/blank/zero standard).
 */
function isOutOfTolerance(standard, measured, toleranceInches) {
  if (standard === undefined || standard === null) return false;
  if (measured === null || measured === undefined || isNaN(measured)) return false;

  if (typeof standard === 'object') {
    const min = parseFloat(standard.min);
    const max = parseFloat(standard.max);
    if (isNaN(min) || isNaN(max)) return false;
    return measured < (min - toleranceInches) || measured > (max + toleranceInches);
  }

  const std = parseFloat(standard);
  if (isNaN(std) || std === 0) return false;
  return Math.abs(measured - std) > toleranceInches;
}

/** Formats a standard value (number or range) for display, e.g. '27"' or '47-48.5"'. */
function formatStandard(standard) {
  if (standard === undefined || standard === null) return '-';
  if (typeof standard === 'object') {
    if (standard.min === undefined || standard.max === undefined) return '-';
    return `${standard.min}-${standard.max}"`;
  }
  const n = parseFloat(standard);
  if (isNaN(n) || n === 0) return '-';
  return `${n}"`;
}

module.exports = { computeOverallResult, isOutOfTolerance, formatStandard, collectAllDefects, sumDefectsBySeverity, CHECKLIST_KEYS };

