const { computeAqlPlan } = require('./aql');

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
 * Recaps how many of the actually-inspected units end up approved vs rejected.
 * A unit with only minor defects is still saleable/approved (per AQL classification -
 * minor issues don't sink the unit). A unit with a major or critical defect is
 * rejected. Since defects are logged as counts rather than tracked per physical
 * unit, a unit with both a major AND a critical defect could be counted in both
 * tallies - this is a reasonable estimate given the data available, not an exact
 * unit-by-unit ledger.
 */
function computeQuantityRecap(quantityChecked, majorCount, criticalCount, poQuantity) {
  const checked = parseInt(quantityChecked, 10);
  if (isNaN(checked) || checked < 1) return null;
  const rejected = Math.min(checked, majorCount + criticalCount);
  return {
    poSize: parseInt(poQuantity, 10) || null,
    quantityChecked: checked,
    quantityRejected: rejected,
    quantityApproved: checked - rejected
  };
}

/**
 * Pass/fail logic:
 *  - FAIL if any apparel measurement is outside tolerance (independent of everything else)
 *  - Pre-Production: no AQL sampling applies at all - just records defect counts found
 *    on the handful of hand-checked units.
 *  - Production: individual defective units are rejected (Major/Critical), the rest
 *    of the reviewed quantity is approved (including units with only Minor issues,
 *    which stay saleable). The report only fails outright if every single unit
 *    reviewed turned out defective - a partial defect rate does NOT auto-reject the
 *    whole PO; it's reflected in the Quantity Approved/Rejected recap instead.
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
    const preQty = parseInt(payload.preProductionUnitsChecked, 10);
    aql = {
      criticalCount, majorCount, minorCount, isFallback: true, isPreProduction: true,
      quantityChecked: isNaN(preQty) ? null : preQty,
      poSize: parseInt(payload.poQuantity, 10) || null
    };
  } else {
    const checked = parseInt(payload.actualUnitsChecked, 10);
    if (!isNaN(checked) && checked >= 1) {
      const recap = computeQuantityRecap(checked, majorCount, criticalCount, payload.poQuantity);
      if (recap.quantityRejected >= recap.quantityChecked) reasons.push('allRejected');
      aql = { criticalCount, majorCount, minorCount, isFallback: false, isActual: true, recap };
    } else {
      // No units-checked figure recorded yet - fall back to a simple heuristic so
      // the in-progress form still shows something reasonable.
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

module.exports = { computeOverallResult, isOutOfTolerance, formatStandard, collectAllDefects, sumDefectsBySeverity, computeQuantityRecap, CHECKLIST_KEYS };

