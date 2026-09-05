/**
 * Two-way Purchase Order sync between Asana and this ERP.
 *
 * Direction of truth, per field, is deliberate (see config/asanaPoSync.json
 * for the name mapping):
 *
 *   Asana -> ERP   (pulled on demand by the "Sync from Asana" button on the
 *                   New PO form, keyed off the PO number)
 *     Creator, PD, Sourcer, Product Dev Owner, SKU (Main), Order Quantity,
 *     Fulfill By / Target Fulfill Date, Fulfillment Channel (which decides
 *     the ERP warehouse), Unit Cost (RMB)
 *
 *   ERP -> Asana   (pushed automatically whenever the order changes)
 *     PO Status, QA/QC Drive Link, Estimated Fulfill Date, PO Administrator,
 *     Factory code, Manufacturability Risk, Proposed Inspection %,
 *     QA Check Percentage, Inspection Result, Actual Fulfill Date,
 *     Completion Date, Manufacturing Partner (always "JC")
 *
 * Fields Asana owns outright (PO Type, Launch Type, Sample Link, Buffer,
 * Type) are never touched from here.
 *
 * Everything is best-effort: Asana being unreachable, unconfigured, or
 * missing a field must never block or fail work happening in the ERP.
 */
const fs = require('fs');
const path = require('path');
const asanaClient = require('./asanaClient');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'asanaPoSync.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error('Failed to read config/asanaPoSync.json:', err.message || err);
    return null;
  }
}

function isConfigured() {
  return !!process.env.ASANA_ACCESS_TOKEN;
}

/** Case-insensitive lookup in a plain object keyed by display name. */
function pick(obj, key) {
  if (!obj || !key) return null;
  const want = String(key).trim().toLowerCase();
  const hit = Object.keys(obj).find((k) => String(k).trim().toLowerCase() === want);
  return hit ? obj[hit] : null;
}

function toIsoDate(value) {
  if (!value) return null;
  // Asana date fields already come back as YYYY-MM-DD; free-text dates
  // ("Late September (September 25)") are left for a human to interpret
  // rather than guessed at.
  const m = String(value).match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

/**
 * Pull the Asana-owned fields for one PO number into the shape the ERP's
 * New PO form expects. Returns null when nothing matched, so the caller can
 * tell "no such PO in Asana" apart from "found but empty".
 */
async function pullFromAsana(poNumber) {
  const cfg = loadConfig();
  if (!cfg) return { ok: false, error: 'Asana sync config could not be read.' };
  if (!isConfigured()) return { ok: false, error: 'ASANA_ACCESS_TOKEN is not set on the server.' };
  if (!cfg.projectGid) {
    return { ok: false, error: 'No Asana projectGid configured - set it in config/asanaPoSync.json.' };
  }

  const task = await asanaClient.findTaskByPoNumber(cfg.projectGid, poNumber);
  if (!task) return { ok: false, notFound: true, error: `No Asana task found for PO ${poNumber}.` };

  const f = cfg.fieldNames || {};
  const vals = asanaClient.readCustomFields(task);

  // Fulfillment Channel decides the warehouse, so resolve it to a real
  // warehouse record rather than passing the raw channel through.
  const channel = pick(vals, f.fulfillmentChannel);
  let warehouse = null;
  if (channel) {
    const map = cfg.fulfillmentChannelWarehouses || {};
    const key = Object.keys(map).find((k) => k.toLowerCase() === String(channel).trim().toLowerCase());
    if (key) warehouse = { channel, ...map[key] };
  }

  // "Fulfill By" is free text ("Late September (September 25)") while
  // "Target Fulfill Date" is a real date field - prefer the date, keep the
  // text around so the form can show what Asana actually says.
  const targetDate = toIsoDate(pick(vals, f.targetFulfillDate));
  const fulfillByText = pick(vals, f.fulfillBy);

  const qty = pick(vals, f.orderQuantity);

  return {
    ok: true,
    taskGid: task.gid,
    taskName: task.name || '',
    fields: {
      creator: pick(vals, f.creator) || null,
      productDevelopmentLead: pick(vals, f.pd) || pick(vals, f.productDevOwner) || null,
      productDevOwner: pick(vals, f.productDevOwner) || null,
      sourcer: pick(vals, f.sourcer) || null,
      sku: pick(vals, f.skuMain) || null,
      orderQuantity: qty === null || qty === '' ? null : Number(qty),
      fulfillmentRequestDate: targetDate,
      fulfillByText: fulfillByText || null,
      fulfillmentChannel: channel || null,
      warehouse,
      unitCostRmb: pick(vals, f.unitCostRmb) || null,
      poStatusAsana: pick(vals, f.poStatus) || null
    },
    // Everything Asana had, for display/debugging in the UI.
    raw: vals
  };
}

/**
 * Build the ERP -> Asana payload for one order. Split out from the push so
 * it can be unit-tested and inspected without hitting the network.
 *
 * `extras` carries values that don't live on the order record itself:
 *   approvalLink, proposedInspectionPct, qaCheckPercentage, inspectionResult
 */
function buildPushPayload(order, extras = {}) {
  const cfg = loadConfig();
  if (!cfg || !order) return {};
  const f = cfg.fieldNames || {};
  const out = {};
  const put = (fieldKey, value) => {
    const name = f[fieldKey];
    // undefined means "leave this field alone" - only send what we know.
    if (name && value !== undefined) out[name] = value;
  };

  const mappedStatus = pick(cfg.poStatusMap || {}, order.status);
  if (mappedStatus) put('poStatus', mappedStatus);

  put('manufacturingPartner', (cfg.constants || {}).manufacturingPartner);
  put('poAdministrator', order.buyer || undefined);
  put('factoryCode', (order.supplier && order.supplier.code) || undefined);

  const risk = order.productRisk ? pick(cfg.riskMap || {}, order.productRisk) : null;
  if (risk) put('manufacturabilityRisk', risk);

  // Required warehouse arrival is what Asana calls the estimated fulfill date.
  put('estimatedFulfillDate', order.desiredEntryDate || undefined);
  put('targetFulfillDate', order.fulfillmentRequestDate || undefined);

  // Dates driven by status transitions, stamped when the order reaches them.
  put('actualFulfillDate', order.deliveredAt ? String(order.deliveredAt).slice(0, 10) : undefined);
  put('completionDate', order.poCompletedAt ? String(order.poCompletedAt).slice(0, 10) : undefined);

  if (extras.approvalLink) put('qaqcDriveLink', extras.approvalLink);
  if (extras.proposedInspectionPct !== undefined) put('proposedInspectionPct', extras.proposedInspectionPct);
  if (extras.qaCheckPercentage !== undefined) put('qaCheckPercentage', extras.qaCheckPercentage);
  if (extras.inspectionResult !== undefined) put('inspectionResult', extras.inspectionResult);

  return out;
}

/** Push the ERP-owned fields for one order onto its Asana task. */
async function pushToAsana(order, extras = {}) {
  if (!order || !order.asanaTaskGid) return { ok: false, skipped: 'no Asana task linked' };
  if (!isConfigured()) return { ok: false, skipped: 'ASANA_ACCESS_TOKEN not set' };
  const payload = buildPushPayload(order, extras);
  if (!Object.keys(payload).length) return { ok: false, skipped: 'nothing to sync' };
  try {
    return await asanaClient.setFieldsByName(order.asanaTaskGid, payload);
  } catch (err) {
    console.error('Asana push failed:', err.message || err);
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = { loadConfig, isConfigured, pullFromAsana, buildPushPayload, pushToAsana };
