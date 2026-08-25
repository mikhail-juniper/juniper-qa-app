const aqlTable = require('../config/aql.json');

// JS stringifies 4.0 as "4", 1.0 as "1", etc. - but our table's JSON keys keep the
// decimal (e.g. "4.0") to match the published standard's notation. Map explicitly
// instead of relying on Number->String conversion.
const AQL_KEY_PAIRS = [
  [0.065, '0.065'], [0.10, '0.10'], [0.15, '0.15'], [0.25, '0.25'], [0.40, '0.40'],
  [0.65, '0.65'], [1.0, '1.0'], [1.5, '1.5'], [2.5, '2.5'], [4.0, '4.0'], [6.5, '6.5']
];
function resolveAqlKey(aqlValue) {
  const n = parseFloat(aqlValue);
  if (isNaN(n)) return null;
  const found = AQL_KEY_PAIRS.find(([num]) => Math.abs(num - n) < 0.0001);
  return found ? found[1] : null;
}

/** Given a lot size and General Inspection Level (I/II/III), returns the sample size code letter. */
function getCodeLetter(lotSize, level = 'II') {
  const n = parseInt(lotSize, 10);
  if (isNaN(n) || n < 2) return null;
  const row = aqlTable.tableA.rows.find((r) => n >= r.lotMin && (r.lotMax === null || n <= r.lotMax));
  return row ? row[level] : null;
}

/**
 * Given a code letter and an AQL value, returns { sampleSize, ac, re, codeLetterUsed }.
 * If the exact cell has no direct plan (the standard's "arrow" cells), this follows
 * the nearest defined cell in the same AQL column - toward smaller code letters first
 * (matches the standard's "arrow up" convention, which is what applies for the high-AQL/
 * large-sample dashes you hit with our default AQL 2.5/4.0 at larger lot sizes), falling
 * back to larger code letters if nothing smaller is defined either.
 *
 * Note: when this has to search to a different code letter than the one implied by lot
 * size, the *nominal* sample size for that specific AQL column shrinks or grows to match
 * the row it resolves to. In practice, inspect at least the largest sample size across
 * whichever AQL columns (major/minor) you're checking - see computeAqlPlan below, which
 * already does this for you.
 */
function getPlan(codeLetter, aqlValue) {
  if (!codeLetter) return null;
  const order = aqlTable.codeLetterOrder;
  const idx = order.indexOf(codeLetter);
  if (idx === -1) return null;
  const aqlKey = resolveAqlKey(aqlValue);
  if (!aqlKey) return null;

  const cellAt = (i) => {
    const letter = order[i];
    const row = aqlTable.tableB[letter];
    if (!row) return null;
    const plan = row.plans[aqlKey];
    if (!plan) return null;
    return { sampleSize: row.sampleSize, ac: plan[0], re: plan[1], codeLetterUsed: letter };
  };

  // Exact cell first.
  const exact = cellAt(idx);
  if (exact) return exact;

  // Search toward smaller code letters (up).
  for (let i = idx - 1; i >= 0; i--) {
    const hit = cellAt(i);
    if (hit) return hit;
  }
  // Fall back to larger code letters (down).
  for (let i = idx + 1; i < order.length; i++) {
    const hit = cellAt(i);
    if (hit) return hit;
  }
  return null;
}

/**
 * Full AQL plan for an inspection: given lot size + inspection level + chosen AQL values
 * for major/minor defects, returns the code letter, each defect type's plan, and the
 * sample size to actually pull (the largest across major/minor/critical, so one physical
 * sample satisfies all three Ac/Re checks at once).
 * Critical defects always use Ac=0/Re=1 (zero tolerance) at whatever the base sample size is.
 */
function computeAqlPlan({ lotSize, inspectionLevel = 'II', majorAql = 2.5, minorAql = 4.0 }) {
  const codeLetter = getCodeLetter(lotSize, inspectionLevel);
  if (!codeLetter) return null;

  const majorPlan = getPlan(codeLetter, majorAql);
  const minorPlan = getPlan(codeLetter, minorAql);
  if (!majorPlan || !minorPlan) return null;

  const sampleSize = Math.max(majorPlan.sampleSize, minorPlan.sampleSize);
  const criticalPlan = { sampleSize, ac: 0, re: 1, codeLetterUsed: codeLetter };

  return {
    lotSize: parseInt(lotSize, 10),
    inspectionLevel,
    codeLetter,
    sampleSize,
    majorAql,
    minorAql,
    critical: criticalPlan,
    major: majorPlan,
    minor: minorPlan
  };
}

/**
 * Given an actual number of units physically inspected (rather than the formal
 * lot-size-derived sample size), finds the largest code letter whose standard
 * sample size is still <= that actual count. This lets Accept/Reject thresholds
 * reflect what was really checked - e.g. checking 200 vs 1000 units off the same
 * PO gives a different (smaller) acceptable defect count, since fewer units were
 * inspected. Code letters are in strictly increasing sample-size order, so a
 * forward scan works.
 */
function getEffectiveCodeLetterFromCount(actualCount) {
  const order = aqlTable.codeLetterOrder;
  let best = null;
  for (const letter of order) {
    const row = aqlTable.tableB[letter];
    if (row.sampleSize <= actualCount) best = letter;
    else break;
  }
  return best;
}

/**
 * Full AQL plan based on the ACTUAL number of units inspected (entered directly,
 * not derived from a percentage), used once that real figure is known - this is
 * what should determine pass/fail, not the theoretical/recommended sample size.
 */
function computeActualAqlPlan({ actualUnitsChecked, majorAql = 2.5, minorAql = 4.0 }) {
  const actualCount = parseInt(actualUnitsChecked, 10);
  if (isNaN(actualCount) || actualCount < 2) return null;
  const codeLetter = getEffectiveCodeLetterFromCount(actualCount);
  if (!codeLetter) return null;
  const majorPlan = getPlan(codeLetter, majorAql);
  const minorPlan = getPlan(codeLetter, minorAql);
  if (!majorPlan || !minorPlan) return null;
  return {
    actualCount,
    majorAql,
    minorAql,
    critical: { sampleSize: actualCount, ac: 0, re: 1, codeLetterUsed: codeLetter },
    major: majorPlan,
    minor: minorPlan
  };
}

module.exports = { getCodeLetter, getPlan, computeAqlPlan, getEffectiveCodeLetterFromCount, computeActualAqlPlan };
