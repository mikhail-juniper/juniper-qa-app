const { computeAqlPlan } = require('./aql');
// Fail thresholds live alongside the AQL tables - see failThresholds there.
const aqlTable = require('../config/aql.json');

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
/* Severity is derived from where an issue was recorded, mirroring the report
 * app: a Step 5 question answered Fail is MAJOR, everything logged in Step 6 is
 * MINOR, and nothing is critical any more. Without reading payload.inspection
 * the server saw zero defects on every new-format report and passed it. */
function collectAllDefects(payload) {
  const all = [];
  const cd = payload.categoryData || {};
  const inspection = payload.inspection || {};

  /* Severity comes from the submitted payload, which baked in the question
   * bank's classification at inspection time. The old assumption that every
   * Step 5 failure was major no longer holds - the QA team classed those as
   * critical - and reports submitted before this change carry no severity, so
   * they keep the old default. */
  const sevOf = (v, fallback) =>
    (v === 'critical' || v === 'major' || v === 'minor') ? v : fallback;

  (inspection.sections || []).forEach((section) => {
    (section.questions || []).forEach((q) => {
      if (q.status !== 'fail') return;
      all.push({
        id: q.id,
        description: q.title,
        severity: sevOf(q.severity, 'major'),
        unitsAffected: parseInt(q.unitsAffected, 10) || 1
      });
    });
  });

  (inspection.issueSections || []).forEach((section) => {
    (section.issues || []).forEach((issue) => {
      all.push({
        id: issue.id,
        description: issue.description,
        severity: sevOf(issue.severity, 'minor'),
        unitsAffected: parseInt(issue.unitsAffected, 10) || 1
      });
    });
  });

  // Legacy: reports submitted before the question-bank rework.
  CHECKLIST_KEYS.forEach((key) => {
    const item = cd[key];
    if (item && Array.isArray(item.defects)) {
      item.defects.forEach((d) => all.push(d));
    }
  });
  (payload.additionalIssues || []).forEach((d) => all.push(d));

  /* Apply the disposition decisions, mirroring applyDisposition() in
   * public/app.js. Repaired-on-site units are good now and rejected units are
   * not shipped, so both stop counting; factory-fix units stay and are what a
   * Revised Unit Report later clears.
   *
   * Without this the server would score the raw findings while the inspector
   * was shown the resolved ones - so a report that legitimately passed on
   * screen would be filed as a fail, which is the disagreement that matters
   * most because the server's verdict is what sets the PO status and prints
   * on the PDF. */
  const byId = {};
  ((payload.inspection && payload.inspection.dispositions) || []).forEach((d) => { byId[d.id] = d; });

  return all.map((defect) => {
    const d = byId[defect.id];
    if (!d || !d.choice) return defect;
    const flagged = parseInt(defect.unitsAffected, 10) || 1;
    if (d.choice === 'rejected') return { ...defect, unitsAffected: 0, resolution: 'rejected' };
    if (d.choice === 'repaired') {
      const fixed = Math.min(flagged, parseInt(d.unitsRepaired, 10) || 0);
      return { ...defect, unitsAffected: Math.max(0, flagged - fixed), unitsRepaired: fixed, resolution: 'repaired' };
    }
    return { ...defect, resolution: 'factory' };
  }).filter((d) => (parseInt(d.unitsAffected, 10) || 0) > 0);
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

/** Mirrors the client-side helper of the same name: prefers the actual
 *  measurement recorded on this PO's own Golden Sample (since that's the
 *  real approved baseline production should match), falling back to the
 *  generic fit template only when no established value exists for that
 *  size/point. Used by both the live "out of tolerance" flagging and the
 *  final pass/fail determination, so the two always agree with each other. */
function establishedStandardFor(sizeName, point, fitKey, fitDef, establishedSizing) {
  if (establishedSizing && establishedSizing.fit === fitKey && establishedSizing.sizeRows) {
    const row = establishedSizing.sizeRows.find((r) => r.size === sizeName);
    if (row && row.measured && row.measured[point] !== undefined && row.measured[point] !== '') {
      return row.measured[point];
    }
  }
  const generic = fitDef.sizes[sizeName];
  return generic ? generic[point] : undefined;
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
function computeOverallResult(payload, fitsConfig, establishedSizing) {
  const reasons = [];

  if (payload.category === 'apparel' && payload.categoryData && payload.categoryData.fit && fitsConfig) {
    const fitDef = fitsConfig.fits[payload.categoryData.fit];
    const tol = fitsConfig.toleranceCm || 1.27;
    if (fitDef) {
      const customPointKeys = (establishedSizing && establishedSizing.fit === payload.categoryData.fit && Array.isArray(establishedSizing.customPoints))
        ? establishedSizing.customPoints.map((cp) => cp.key)
        : [];
      const allPoints = fitDef.points.concat(customPointKeys);
      const rows = payload.categoryData.sizeRows || [];
      outer: for (const row of rows) {
        for (const point of allPoints) {
          const standard = establishedStandardFor(row.size, point, payload.categoryData.fit, fitDef, establishedSizing);
          const measured = row.measured && row.measured[point] !== undefined && row.measured[point] !== ''
            ? parseFloat(row.measured[point]) : null;
          if (isOutOfTolerance(standard, measured, tol)) {
            reasons.push('tolerance');
            break outer;
          }
        }
      }
    }
  }

  const allDefects = collectAllDefects(payload);
  const { critical: criticalCount, major: majorCount, minor: minorCount } = sumDefectsBySeverity(allDefects);

  /* Mirrors rateFailures() in public/app.js - the two MUST agree, since the
   * server's verdict is what sets the PO status, files the PDF result and
   * prints the banner. Thresholds are a percentage of units INSPECTED;
   * exceeding fails, equalling passes. Critical is computed, never chosen:
   * a defect is escalated when every inspected unit is affected. */
  const countDefectsByUnit = (unitsChecked) => {
    const out = { critical: { units: 0 }, major: { units: 0 }, minor: { units: 0 } };
    allDefects.forEach((d) => {
      const b = out[d.severity];
      if (!b) return;
      const n = parseInt(d.unitsAffected, 10);
      b.units += isNaN(n) || n < 1 ? 1 : n;
    });
    const cap = (v) => (unitsChecked ? Math.min(v, unitsChecked) : v);
    ['critical', 'major', 'minor'].forEach((k) => { out[k].defectiveUnits = cap(out[k].units); });
    out.totalDefectiveUnits = cap(out.critical.units + out.major.units + out.minor.units);
    return out;
  };

  const thresholds = (aqlTable && aqlTable.failThresholds) || {};
  const th = {
    criticalPct: thresholds.criticalPct !== undefined ? thresholds.criticalPct : 0,
    majorPct: thresholds.majorPct !== undefined ? thresholds.majorPct : 1.5,
    minorPct: thresholds.minorPct !== undefined ? thresholds.minorPct : 4
  };

  const applyThresholds = (checked) => {
    if (!checked || checked < 1) return null;
    const counts = countDefectsByUnit(checked);
    const pct = (n) => (n / checked) * 100;
    /* Critical is assigned per question now, not computed from "every unit
     * affected". With a 0% threshold, one critical unit fails the report. */
    const isCritical = counts.critical.defectiveUnits > 0;
    const rates = { critical: pct(counts.critical.defectiveUnits), major: pct(counts.major.defectiveUnits), minor: pct(counts.minor.defectiveUnits) };
    if (rates.critical > th.criticalPct) reasons.push('thresholdCritical');
    if (rates.major > th.majorPct) reasons.push('thresholdMajor');
    if (rates.minor > th.minorPct) reasons.push('thresholdMinor');
    return { counts, rates, isCritical, thresholds: th };
  };

  let aql = null;

  if (payload.qaType === 'pre_production') {
    // Pre-production is a small hand-check of a few units (at least one per size) -
    // formal AQL sampling doesn't apply here at all.
    const preQty = parseInt(payload.preProductionUnitsChecked, 10);
    const checked = isNaN(preQty) || preQty < 1 ? null : preQty;
    const rated = applyThresholds(checked);
    aql = {
      criticalCount, majorCount, minorCount, isFallback: true, isPreProduction: true,
      quantityChecked: checked,
      poSize: parseInt(payload.poQuantity, 10) || null,
      counts: rated ? rated.counts : null,
      rates: rated ? rated.rates : null,
      isCritical: rated ? rated.isCritical : false,
      thresholds: th
    };
  } else {
    const checked = parseInt(payload.actualUnitsChecked, 10);
    if (!isNaN(checked) && checked >= 1) {
      const recap = computeQuantityRecap(checked, majorCount, criticalCount, payload.poQuantity);
      const rated = applyThresholds(checked);
      aql = {
        criticalCount, majorCount, minorCount, isFallback: false, isActual: true, recap,
        counts: rated ? rated.counts : null,
        rates: rated ? rated.rates : null,
        isCritical: rated ? rated.isCritical : false,
        thresholds: th
      };
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
function isOutOfTolerance(standard, measured, toleranceCm) {
  if (standard === undefined || standard === null) return false;
  if (measured === null || measured === undefined || isNaN(measured)) return false;

  if (typeof standard === 'object') {
    const min = parseFloat(standard.min);
    const max = parseFloat(standard.max);
    if (isNaN(min) || isNaN(max)) return false;
    return measured < (min - toleranceCm) || measured > (max + toleranceCm);
  }

  const std = parseFloat(standard);
  if (isNaN(std) || std === 0) return false;
  return Math.abs(measured - std) > toleranceCm;
}

/** Formats a standard value (number or range) for display, e.g. '27"' or '47-48.5"'. */
function formatStandard(standard) {
  if (standard === undefined || standard === null) return '-';
  if (typeof standard === 'object') {
    if (standard.min === undefined || standard.max === undefined) return '-';
    return `${standard.min}-${standard.max} cm`;
  }
  const n = parseFloat(standard);
  if (isNaN(n) || n === 0) return '-';
  return `${n} cm`;
}

module.exports = { computeOverallResult, isOutOfTolerance, formatStandard, collectAllDefects, sumDefectsBySeverity, computeQuantityRecap, CHECKLIST_KEYS, establishedStandardFor };

