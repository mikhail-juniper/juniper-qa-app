/**
 * Recommends an Inspection Level + Point Check % range for a report, based on:
 *   - the Creator's QA Tier (config/creatorTiers.json)
 *   - the chosen Product Complexity/Risk (High/Medium/Low)
 *   - the PO's estimated dollar value (PO Quantity x per-unit cost), bucketed into
 *     a PO Size band (config/aqlRecommendation.json)
 * This does not affect the formal ANSI/ASQ Z1.4 Accept/Reject math (lib/aql.js) -
 * it only suggests which Inspection Level to feed into that system, plus a
 * secondary "Point Check %" figure the company tracks for its own records.
 *
 * Per-unit cost preference order:
 *   1. A real factory price from a matching Order Management PO for this SKU
 *      (stored in RMB, converted to USD here) - the actual number, when one
 *      exists.
 *   2. The manual per-category/subcategory estimate in config/unitCosts.json -
 *      a fallback for SKUs that don't have PO data yet.
 */

function getUnitCost(category, subcategory, unitCosts) {
  if (!unitCosts) return null;
  if (category === 'other') return unitCosts.otherCategoryFlat;
  const catCosts = unitCosts.categories && unitCosts.categories[category];
  if (!catCosts) return null;
  if (subcategory && catCosts[subcategory] !== undefined) return catCosts[subcategory];
  return catCosts.other !== undefined ? catCosts.other : null;
}

/** Real factory price (RMB) for this SKU from Order Management, if any
 *  order for it has one set - converted to USD using the configured rate.
 *  Most recent matching order wins if there's more than one. */
function getRealUnitCostUsd(sku, unitCosts, findOrdersBySku) {
  if (!sku || typeof findOrdersBySku !== 'function') return null;
  const rate = (unitCosts && unitCosts.rmbToUsdRate) || null;
  if (!rate) return null;
  const matches = findOrdersBySku(sku) || [];
  const withPrice = matches.find((o) => o.mainComponent && o.mainComponent.factoryPrice);
  if (!withPrice) return null;
  return Math.round(withPrice.mainComponent.factoryPrice * rate * 10000) / 10000;
}

function computeOrderValue(category, subcategory, poQuantity, unitCosts, sku, findOrdersBySku) {
  const qty = parseInt(poQuantity, 10);
  const realCost = getRealUnitCostUsd(sku, unitCosts, findOrdersBySku);
  const cost = realCost !== null ? realCost : getUnitCost(category, subcategory, unitCosts);
  if (isNaN(qty) || qty < 1 || cost === null || cost === undefined) return null;
  return qty * cost;
}

function getPoSizeBand(orderValue, aqlRecConfig) {
  if (orderValue === null || orderValue === undefined || !aqlRecConfig) return null;
  const band = aqlRecConfig.poSizeBands.find((b) => orderValue >= b.min && (b.max === null || orderValue < b.max));
  return band ? band.key : null;
}

function getCreatorTier(creatorName, creatorTiersConfig) {
  if (!creatorTiersConfig) return null;
  if (creatorName && creatorTiersConfig.tiers[creatorName] !== undefined) {
    return creatorTiersConfig.tiers[creatorName];
  }
  return creatorTiersConfig.defaultTier;
}

/**
 * Full recommendation given everything known about the report so far.
 * Returns { orderValue, poSizeBand, tier, pointCheck, inspectionLevel } or null
 * if any required input is missing.
 */
function getRecommendation({ category, subcategory, poQuantity, creator, risk, sku }, { unitCosts, aqlRecConfig, creatorTiersConfig, findOrdersBySku }) {
  const orderValue = computeOrderValue(category, subcategory, poQuantity, unitCosts, sku, findOrdersBySku);
  if (orderValue === null) return null;
  const poSizeBand = getPoSizeBand(orderValue, aqlRecConfig);
  if (!poSizeBand) return null;
  const tier = getCreatorTier(creator, creatorTiersConfig);
  if (!tier) return null;
  const riskKey = (risk || 'medium').toLowerCase();
  const tierTable = aqlRecConfig.table[String(tier)];
  if (!tierTable || !tierTable[riskKey] || !tierTable[riskKey][poSizeBand]) return null;
  const cell = tierTable[riskKey][poSizeBand];
  return {
    orderValue,
    poSizeBand,
    tier,
    pointCheck: cell.pointCheck,
    inspectionLevel: cell.inspectionLevel
  };
}

module.exports = { getUnitCost, getRealUnitCostUsd, computeOrderValue, getPoSizeBand, getCreatorTier, getRecommendation };
