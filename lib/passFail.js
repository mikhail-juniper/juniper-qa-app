/**
 * Rough automatic pass/fail logic:
 *  - FAIL if any apparel measurement is outside tolerance
 *  - FAIL if there are 3 or more "minor" issues
 *  - FAIL if there is 1 or more "major" or "critical" issue
 *  - otherwise PASS
 * This is intentionally simple/conservative - it's meant to flag things for a
 * human reviewer, not to be the final word.
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

  const issues = payload.issues || [];
  const minorCount = issues.filter((i) => i.severity === 'minor').length;
  const majorCriticalCount = issues.filter((i) => i.severity === 'major' || i.severity === 'critical').length;

  if (minorCount >= 3) reasons.push('minor');
  if (majorCriticalCount >= 1) reasons.push('major');

  return {
    overall: reasons.length ? 'fail' : 'pass',
    reasons
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

module.exports = { computeOverallResult, isOutOfTolerance, formatStandard };

