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
          const std = parseFloat(standard[point]);
          const measured = row.measured && row.measured[point] !== undefined && row.measured[point] !== ''
            ? parseFloat(row.measured[point]) : null;
          if (!isNaN(std) && std !== 0 && measured !== null && !isNaN(measured)) {
            if (Math.abs(measured - std) > tol) {
              reasons.push('tolerance');
              break outer;
            }
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

module.exports = { computeOverallResult };
