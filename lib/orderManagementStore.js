/**
 * Persistent store for the Order Management Hub - the rebuild of the
 * QingFlow "Order Management" workspace, living as a section of this app.
 *
 * A PO record is the parent. Main component + accessory detail live nested
 * on the same record (unlike QingFlow, which split them into separate
 * linked apps joined only by Order Number) so the parent always reflects
 * current status - see the workflow spec's "parent PO stays in sync"
 * decision. Status transitions are manual (also per that spec), so this
 * store just persists whatever a person sets, plus an audit trail of every
 * change for the change-log requirement.
 */
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const componentDefinitions = require('./componentDefinitionStore');
const { DATA_DIR } = require('./submissionLog');
// Keeps the Products/Components directory (catalogStore) in sync any time
// an order introduces a new SKU or part - see catalogStore.syncFromOrder.
// catalogStore has no dependency back on this module, so this is safe.
const catalogStore = require('./catalogStore');
// Same idea for the Fabric Library - keeps Fabric Codes/Types in sync any
// time an order's Main Component Specifications introduces a new one.
const fabricLibraryStore = require('./fabricLibraryStore');

const ORDERS_PATH = path.join(DATA_DIR, 'orderManagement.json');
/* Orders live in SQLite now - see lib/orderDb.js for why. ORDERS_PATH is kept
 * because it's still the migration source and the rollback copy. */
const orderDb = require('./orderDb');
orderDb.init(DATA_DIR);

const ORDER_FILES_DIR = path.join(DATA_DIR, 'order-management-files');

const FILE_CATEGORIES = ['Style picture', 'Design document', 'Packing list', 'Other'];
const PRODUCT_LINES = ['toys', 'clothing', 'other'];

// Mirrors the 5 status pills observed in QingFlow, plus a starting state
// for orders that haven't been approved into production yet.
const STATUSES = [
  'New Request',
  'Order Placed',
  'PP Quality Inspection',
  'In Production',
  'Bulk Quality Inspection',
  // Post-bulk-inspection production/finishing, before anything ships - this
  // is the step a completed Bulk report advances into.
  'Final Production',
  'In Transportation',
  'Delivered',
  'Completed'
];

// Report status values for the two QA/QC stages, and what main order status
// each one drives the PO to. Kept here (rather than in the route handler) so
// both the API and any future automation share one source of truth.
const REPORT_STATUSES = ['Pending', 'In Progress', 'Completed'];
// A report moving to In Progress puts the order into that inspection stage.
// Completing the report deliberately does NOT advance any further: the order
// only leaves an inspection stage once Product Development signs off on it
// (see advanceOnPdApproval), because a finished report is not the same thing
// as an approved one.
const REPORT_STATUS_TO_ORDER_STATUS = {
  preProduction: { 'In Progress': 'PP Quality Inspection' },
  bulk: { 'In Progress': 'Bulk Quality Inspection' }
};

// What a PD sign-off on each approval stage advances the order to.
const PD_APPROVAL_TO_ORDER_STATUS = {
  preProductionApproval: 'In Production',
  bulkApproval: 'Final Production'
};

// One-time migration map for orders saved under the old status labels -
// applied on load so existing orders keep a valid, meaningfully-equivalent
// status instead of falling off the tracker entirely.
const LEGACY_STATUS_MAP = {
  'New request': 'New Request',
  'Order placed': 'Order Placed',
  'In production': 'In Production',
  'During quality inspection': 'Bulk Quality Inspection',
  'During transport': 'In Transportation',
  'Confirm receipt of goods': 'Delivered',
  'Completed': 'Completed'
};

// Sub-component POs run a much simpler lifecycle than a full PO - there's no
// inspection or PD approval stage on a hang tag - so they get their own
// shorter list rather than reusing the main STATUSES.
const ACCESSORY_STATUSES = [
  'New Request',
  'Order Placed',
  'In Production',
  'In Transportation',
  'Completed'
];

/** One QA/QC report stage block. `status` is manually settable (and also
 *  set automatically when a report passes); the rest is populated from the
 *  submitted report so the panel can link the finished PDF. */
/** What the report link was configured with at PO setup: which conditional
 *  checks apply to this product, plus any one-off custom questions. Null until
 *  someone runs Setup Report Link - a report opened before that is treated as
 *  having no additional questions, which is the safe default. */
function normalizeQaReportSetup(s) {
  if (!s || typeof s !== 'object') return null;
  const checks = Array.isArray(s.checks)
    ? s.checks.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim())
    : [];
  const custom = (Array.isArray(s.custom) ? s.custom : [])
    .filter((c) => c && typeof c === 'object' && String(c.text || '').trim())
    .map((c, i) => ({
      id: String(c.id || `custom_${i + 1}`),
      text: String(c.text).trim(),
      requirePhoto: !!c.requirePhoto,
      requireVideo: !!c.requireVideo
    }));
  // Nothing ticked and nothing written is still a deliberate "no extras" -
  // configuredAt is what tells the UI setup has happened.
  return {
    configuredAt: s.configuredAt || new Date().toISOString(),
    configuredBy: s.configuredBy || '',
    checks,
    custom
  };
}

function normalizeQaReport(r) {
  r = r || {};
  return {
    status: REPORT_STATUSES.includes(r.status) ? r.status : 'Pending',
    submissionId: r.submissionId || null,
    pdfUrl: r.pdfUrl || '',
    result: r.result || '',
    submittedAt: r.submittedAt || null,
    /* Token for the unauthenticated factory link to this one stage. */
    accessToken: r.accessToken || '',
    accessTokenIssuedAt: r.accessTokenIssuedAt || null,
    setup: normalizeQaReportSetup(r.setup)
  };
}

/** Save the report-link setup for one stage and move that stage to In Progress,
 *  which is what the team expects to see once a link has been handed out. */
function setQaReportSetup(id, stage, setup, actor) {
  if (!REPORT_STATUS_TO_ORDER_STATUS[stage]) return null;
  const order = getOrderById(id);
  if (!order) return null;
  const normalized = normalizeQaReportSetup({ ...setup, configuredBy: actor || (setup && setup.configuredBy) || '' });
  const report = { ...order.qaReports[stage], setup: normalized };
  // Only nudge Pending forward - a stage already Completed must not be
  // dragged back just because someone re-opened the setup dialog.
  if (report.status === 'Pending') report.status = 'In Progress';
  const patch = { qaReports: { ...order.qaReports, [stage]: report } };
  const mapped = REPORT_STATUS_TO_ORDER_STATUS[stage][report.status];
  if (mapped) {
    const currentIdx = STATUSES.indexOf(order.status);
    const mappedIdx = STATUSES.indexOf(mapped);
    if (mappedIdx > currentIdx) patch.status = mapped;
  }
  const label = stage === 'preProduction' ? 'Pre-Production' : 'Bulk';
  return updateOrder(id, patch, actor, `${label} report link set up`);
}

/**
 * Keep component definitions and a PO's components in step.
 *
 * Called whenever components are written. Two directions on purpose:
 *   1. anything the PO knows is recorded on the definition, so the spec
 *      accumulates instead of living on one order
 *   2. anything the PO is missing is filled in from the definition, so a
 *      reorder inherits the artwork rather than needing it re-uploaded
 *
 * Keyed on the PO's own SKU + the part name. Definitions are per-SKU, so a
 * PO without a SKU is skipped rather than creating an unkeyable record.
 */
/**
 * Fill a PO's empty Product Documentation slots from the SKU's component
 * definitions.
 *
 * Once the handoff import has recorded the hang tag artwork against a SKU,
 * every later PO for that product should show it without re-importing.
 * Empty-only: a PO that has its own file for a slot keeps it.
 *
 * The mapping mirrors the import's own label rules, so a definition named
 * "Hang Tag" lands in the Hang Tag slot and "Plush Bag" in Packaging.
 */
const DEFINITION_DOC_SLOTS = [
  [/^manufacturing\s*drawing/i, 'manufacturingDrawing'],
  [/^washing\s*tag/i, 'washingTagUrl'],
  [/^(hang\s*tag|hangtag|swing\s*tag)/i, 'hangTagUrl'],
  [/^(packaging|.*\bbag\b|.*\bcard\b|.*\bsleeve\b|.*\bbox\b|.*\binsert\b)/i, 'packagingUrl']
];

function applyDefinitionsToDocSlots(order) {
  const sku = order && order.mainComponent && order.mainComponent.sku;
  if (!sku) return [];
  const filled = [];
  const claimed = new Set();
  try {
    componentDefinitions.listDefinitions({ sku }).forEach((def) => {
      if (!def.designDocUrl) return;
      // Match on the bare type, not the product-qualified display name.
      const matchOn = String(def.partType || def.partName || '').trim();
      const hit = DEFINITION_DOC_SLOTS.find(([re]) => re.test(matchOn));
      if (!hit || claimed.has(hit[1])) return;
      const slot = hit[1];
      const current = order.mainComponent[slot];
      if (current === null || current === undefined || String(current) === '') {
        order.mainComponent[slot] = def.designDocUrl;
        claimed.add(slot);
        filled.push(`${def.partName} -> ${slot}`);
      }
    });
  } catch (err) {
    console.error('Could not apply component definitions to doc slots:', err.message || err);
  }
  return filled;
}

/** The separator between the product name and the part type. A dash rather
 *  than a space because names like "Test Plush Plush Bag" were unreadable. */
const PART_NAME_SEPARATOR = ' - ';

/** Remove a leading product name from a part name, so "Test Plush - Hang Tag"
 *  gives back "Hang Tag". Returns the name unchanged when it isn't prefixed.
 *
 *  Handles the older space-only form ("Test Plush Hang Tag") as well, so a PO
 *  saved under the previous convention converts cleanly on its next save
 *  instead of becoming "Test Plush - Test Plush Hang Tag". */
function stripProductPrefix(productName, partName) {
  const name = String(partName || '').trim();
  const product = String(productName || '').trim();
  if (!product || !name) return name;
  const norm = (v) => String(v).toLowerCase().replace(/\s+/g, ' ');
  const lowerName = norm(name);
  const lowerProduct = norm(product);

  // Longest separator first, so " - " isn't matched by the bare " " rule and
  // left dangling on the front of the type.
  for (const sep of [' - ', ' -', '- ', ' ']) {
    const prefix = lowerProduct + sep;
    if (!lowerName.startsWith(prefix)) continue;
    const stripped = name.slice(prefix.length).trim();
    // Guard against a part named exactly the product name, which would
    // otherwise strip to nothing.
    if (stripped) return stripped;
  }
  return name;
}

/** "Hang Tag" on the Test Plush PO is stored as "Test Plush Hang Tag".
 *  Idempotent: re-saving an already-qualified name doesn't stack prefixes, and
 *  a name the buyer already typed in full isn't doubled up. */
function qualifyPartName(productName, partType) {
  const type = String(partType || '').trim();
  const product = String(productName || '').trim();
  if (!type) return '';
  if (!product) return type;
  const norm = (v) => v.toLowerCase().replace(/\s+/g, ' ');
  if (norm(type).startsWith(norm(product))) return type;
  return `${product}${PART_NAME_SEPARATOR}${type}`;
}

function syncComponentDefinitions(order, actor) {
  const sku = order && order.mainComponent && order.mainComponent.sku;
  if (!sku || !Array.isArray(order.accessories)) return;
  const productName = (order.mainComponent && order.mainComponent.name) || '';
  order.accessories.forEach((a) => {
    if (!a || !a.partName) return;
    /* Derive the bare type by stripping the product prefix rather than
     * trusting the client to send it. The edit form only posts partName, so
     * relying on a client-supplied partType meant that on the second save it
     * quietly became the already-qualified name - and the doc-slot matchers,
     * which test the type, would stop matching. Deriving is idempotent. */
    a.partType = stripProductPrefix(productName, a.partName);
    a.partName = qualifyPartName(productName, a.partType);
    try {
      componentDefinitions.upsertFromAccessory(sku, a, actor);
      const { definitionId } = componentDefinitions.applyToAccessory(sku, a);
      if (definitionId) a.definitionId = definitionId;
    } catch (err) {
      // Never let the library block saving the order itself.
      console.error('Component definition sync failed for', a.partName, err.message || err);
    }
  });
}

function normalizeAccessory(a) {
  a = a || {};
  return {
    id: a.id || uuidv4(),
    /* partName is the qualified, display name ("Test Plush Hang Tag").
     * partType is the bare type the buyer actually typed ("Hang Tag").
     *
     * Both are kept because they answer different questions. partName makes a
     * component identifiable in the Components list, which was otherwise ten
     * rows all reading "Hang Tag". partType is what the doc-slot and relink
     * matchers test against - matching on the qualified name would mean
     * regexes that have to cope with an arbitrary product name in front, which
     * is exactly the kind of thing that fails quietly.
     *
     * Records written before this change have no partType, so it falls back to
     * partName, which for them is the bare type. No migration needed. */
    partName: a.partName || '',
    partType: a.partType || a.partName || '',
    // Link to the reusable spec in componentDefinitionStore, set on save.
    definitionId: a.definitionId || null,
    // Sub-components are simple parts, so risk defaults to low rather than
    // making someone set it on every hang tag.
    productRisk: a.productRisk || 'low',
    // Warehousing for this component's own shipment (see the sub-PO panel's
    // Warehouse Breakdown). shipToAddress mirrors the main component's
    // supplier address when unset.
    warehouseAddress: a.warehouseAddress || '',
    shipToAddress: a.shipToAddress || '',
    specifications: a.specifications || '',
    dimensions: a.dimensions || '',
    dimensionsLength: a.dimensionsLength || '',
    dimensionsWidth: a.dimensionsWidth || '',
    dimensionsHeight: a.dimensionsHeight || '',
    material: a.material || '',
    quantity: a.quantity || null,
    unitPrice: a.unitPrice || null,
    totalPrice: a.totalPrice || (a.quantity && a.unitPrice ? Math.round(a.quantity * a.unitPrice * 100) / 100 : null),
    shippingCost: a.shippingCost || null,
    expectedDeliveryDate: a.expectedDeliveryDate || null,
    supplierName: a.supplierName || '',
    supplierContact: a.supplierContact || '',
    deliveryAddress: a.deliveryAddress || '',
    waybillNumber: a.waybillNumber || '',
    shipmentQuantity: a.shipmentQuantity || null,
    refundOrderNumber: a.refundOrderNumber || '',
    remark: a.remark || '',
    status: ACCESSORY_STATUSES.includes(a.status) ? a.status : ACCESSORY_STATUSES[0],
    imageUrl: a.imageUrl || '',
    designDocUrl: a.designDocUrl || ''
  };
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ORDER_FILES_DIR, { recursive: true });
}

function hydrateOrder(e) {
  if (LEGACY_STATUS_MAP[e.status]) e.status = LEGACY_STATUS_MAP[e.status];
  e.supplier = e.supplier || { name: '', contact: '', code: '' };
  e.mainComponent = e.mainComponent || {};
  e.mainComponent.sizeDistribution = e.mainComponent.sizeDistribution || [];
  e.accessories = Array.isArray(e.accessories) ? e.accessories.map(normalizeAccessory) : [];
  e.costs = e.costs || { assemblyFee: 0, laborCosts: 0, transportationFees: 0, otherExpenses: 0 };
  e.settlement = e.settlement || { status: 'Pending', amount: null, paidDate: null, componentPayments: {} };
  e.settlement.componentPayments = e.settlement.componentPayments || {};
  e.fulfillment = e.fulfillment || {};
  e.fulfillment.replacementSizes = e.fulfillment.replacementSizes || [];
  e.files = Array.isArray(e.files) ? e.files : [];
  e.changeLog = Array.isArray(e.changeLog) ? e.changeLog : [];
  // QA/QC fields, merged in from the retired poStore - default older
  // records that predate this merge so consumers never see `undefined`.
  e.category = e.category || null;
  e.subcategory = e.subcategory || null;
  e.creator = e.creator || '';
  e.productDevelopmentLead = e.productDevelopmentLead || '';
  e.sizesIncluded = Array.isArray(e.sizesIncluded) ? e.sizesIncluded : [];
  e.fitKey = e.fitKey || null;
  e.fitSizes = Array.isArray(e.fitSizes) ? e.fitSizes : [];
  e.asanaTaskLink = e.asanaTaskLink || null;
  e.asanaTaskGid = e.asanaTaskGid || null;
  // One-time migration: an older single-value bulk progress becomes the
  // first entry in the log, so switching to a log doesn't lose it.
  if (e.factoryUpdates && e.factoryUpdates.bulkShipmentProgress
      && (!e.factoryUpdates.bulkProgressLog || !e.factoryUpdates.bulkProgressLog.length)) {
    e.factoryUpdates.bulkProgressLog = [{
      text: e.factoryUpdates.bulkShipmentProgress,
      at: e.factoryUpdates.updatedAt || e.updatedAt || new Date().toISOString(),
      by: e.factoryUpdates.updatedBy || 'Supplier'
    }];
  }
  e.productRisk = e.productRisk || null;
  return e;
}

function loadAll() {
  return orderDb.loadAll().map(hydrateOrder);
}

/* Kept for the wholesale paths (restore from backup). Normal edits go through
 * saveOne, which writes a single row instead of every order. */
function saveAll(entries) {
  orderDb.replaceAll(entries);
}

/** Fold the WAL into the .db file - called before the backup zips the data
 *  directory. See lib/orderDb.js checkpoint(). */
function checkpointDatabase() {
  orderDb.checkpoint();
}

/** Write one order. What almost every mutation should use. */
function saveOne(entry) {
  orderDb.saveOne(entry);
  return entry;
}

function logChange(entry, actor, action, details) {
  if (!Array.isArray(entry.changeLog)) entry.changeLog = [];
  entry.changeLog.unshift({
    timestamp: new Date().toISOString(),
    actor: actor || 'Unknown',
    action,
    details: details || null
  });
}

function createOrder(data, actor) {
  const entries = loadAll();
  const now = new Date().toISOString();
  const entry = {
    id: data.id,
    poNumber: data.poNumber || '',
    productLine: PRODUCT_LINES.includes(data.productLine) ? data.productLine : 'toys',
    status: data.status || 'New Request',
    buyer: data.buyer || '',
    orderPlacementDate: data.orderPlacementDate || null,
    desiredEntryDate: data.desiredEntryDate || null,
    manufacturerDeliveryDate: data.manufacturerDeliveryDate || null,
    // When fulfillment/warehouse needs this PO by - distinct from
    // desiredEntryDate (warehouse arrival) and manufacturerDeliveryDate
    // (factory handoff); this is the fulfillment team's own requested date.
    fulfillmentRequestDate: data.fulfillmentRequestDate || null,
    // Set once, by the "Complete PO" action (available once the status
    // stepper reaches its last step and settlement is fully Paid) - a
    // manual confirmation step rather than something inferred, since
    // "last status + paid" can briefly be true before someone's actually
    // checked everything over.
    poCompletedAt: data.poCompletedAt || null,
    // Stamped the first time the order reaches 'Delivered' - Asana's
    // "Actual Fulfill Date" syncs from this.
    deliveredAt: data.deliveredAt || null,
    // Stamped the first time the order reaches 'In Transportation' - this is
    // the "Actual Ship Date" the supplier table shows.
    inTransportationAt: data.inTransportationAt || null,
    // Notes for the factory, written when the PO is sent to them. Shown on
    // the supplier's own page (the "Remark" column in the old KingDocs).
    productionNotes: data.productionNotes || '',
    /* When Chloe wants this PO back in front of her. Set on a supplier call
     * when the factory promises something for a date - the one piece of
     * scheduling information no derived rule can know. */
    followUpDate: data.followUpDate || null,
    followUpNote: data.followUpNote || '',
    /* When this PO was last worked through on a supplier call. Without it a
     * list of 20 gives no way to tell which have been covered - the tab-per-PO
     * habit exists precisely because the sheet cannot show that. */
    lastCheckedInAt: data.lastCheckedInAt || null,
    /* When someone on the Juniper China side confirmed they had seen each PD
     * approval, keyed by stage. Approvals used to simply drop out of the
     * queue, so the one event the team is waiting for was also the one event
     * nothing told them about. */
    approvalSeen: (data.approvalSeen && typeof data.approvalSeen === 'object') ? data.approvalSeen : {},
    lastCheckedInBy: data.lastCheckedInBy || '',
    /* Fields the FACTORY fills in, not us. Kept in their own object so the
     * narrow supplier-write endpoint can whitelist exactly these and
     * nothing else. */
    factoryUpdates: {
      preProductionSampleDate: (data.factoryUpdates && data.factoryUpdates.preProductionSampleDate) || null,
      bulkSampleDate: (data.factoryUpdates && data.factoryUpdates.bulkSampleDate) || null,
      // Bulk progress is a running log rather than a single value - a
      // factory reports "stuffing done", then "in QC", then "ready to
      // ship". Each entry is timestamped and attributed.
      bulkProgressLog: Array.isArray(data.factoryUpdates && data.factoryUpdates.bulkProgressLog)
        ? data.factoryUpdates.bulkProgressLog
        : [],
      // Sample-ready dates: confirmed with the factory, entered by us.
      // Kept for records written before the log existed; migrated into the
      // log on first read so nothing typed previously is lost.
      bulkShipmentProgress: (data.factoryUpdates && data.factoryUpdates.bulkShipmentProgress) || '',
      updatedAt: (data.factoryUpdates && data.factoryUpdates.updatedAt) || null,
      updatedBy: (data.factoryUpdates && data.factoryUpdates.updatedBy) || ''
    },
    // Token for the no-login PD approval link (/a/<token>). Generated on
    // demand; rotating it invalidates any link already shared.
    approvalAccessToken: data.approvalAccessToken || '',
    approvalAccessTokenIssuedAt: data.approvalAccessTokenIssuedAt || null,
    // Audit trail of PO dispatches to suppliers: one entry per component
    // sent, so it's always clear who was told what and when.
    dispatchLog: Array.isArray(data.dispatchLog) ? data.dispatchLog : [],
    // Asana-owned fields carried into the ERP by the "Sync from Asana"
    // button. Sourcing lead has no other home in this app yet.
    sourcer: data.sourcer || null,
    fulfillmentChannel: data.fulfillmentChannel || null,
    supplier: {
      name: (data.supplier && data.supplier.name) || '',
      contact: (data.supplier && data.supplier.contact) || '',
      code: (data.supplier && data.supplier.code) || '',
      address: (data.supplier && data.supplier.address) || ''
    },
    mainComponent: {
      name: (data.mainComponent && data.mainComponent.name) || '',
      sku: (data.mainComponent && data.mainComponent.sku) || '',
      modelNumber: (data.mainComponent && data.mainComponent.modelNumber) || '',
      factoryPrice: (data.mainComponent && data.mainComponent.factoryPrice) || null,
      salesUnitPrice: (data.mainComponent && data.mainComponent.salesUnitPrice) || null,
      salesVolume: (data.mainComponent && data.mainComponent.salesVolume) || null,
      purchaseQuantity: (data.mainComponent && data.mainComponent.purchaseQuantity) || null,
      totalPurchasePrice: (data.mainComponent && data.mainComponent.totalPurchasePrice) || null,
      actualWeight: (data.mainComponent && data.mainComponent.actualWeight) || null,
      transportWeight: (data.mainComponent && data.mainComponent.transportWeight) || null,
      dimensions: (data.mainComponent && data.mainComponent.dimensions) || '',
      // Non-apparel only: numeric W/L/H, parallel to dimensionsTable being
      // the apparel-only sizing standard - each product line gets the
      // dimension shape that actually applies to it.
      dimensionsWidth: (data.mainComponent && data.mainComponent.dimensionsWidth) || null,
      dimensionsLength: (data.mainComponent && data.mainComponent.dimensionsLength) || null,
      dimensionsHeight: (data.mainComponent && data.mainComponent.dimensionsHeight) || null,
      fabricInfo: (data.mainComponent && data.mainComponent.fabricInfo) || '',
      component: (data.mainComponent && data.mainComponent.component) || '',
      washLabel: (data.mainComponent && data.mainComponent.washLabel) || '',
      productionPrecautions: (data.mainComponent && data.mainComponent.productionPrecautions) || '',
      manufacturingDrawing: (data.mainComponent && data.mainComponent.manufacturingDrawing) || '',
      washingTagUrl: (data.mainComponent && data.mainComponent.washingTagUrl) || '',
      // Hang tags get their own slot: a PO usually has both a hang tag and
      // separate packaging artwork, and one Packaging field meant the
      // second one had nowhere to go.
      hangTagUrl: (data.mainComponent && data.mainComponent.hangTagUrl) || '',
      packagingUrl: (data.mainComponent && data.mainComponent.packagingUrl) || '',
      dimensionsUrl: (data.mainComponent && data.mainComponent.dimensionsUrl) || '',
      /* Where the FULL file lives, keyed by slot field name. The slot's own
       * *Url now holds a rendered preview rather than the original, so without
       * this the original would be unreachable - "View file" would open a PNG
       * of page one and the Drive link recorded on the files[] entry would
       * never surface anywhere. */
      docSourceUrls: (data.mainComponent && typeof data.mainComponent.docSourceUrls === 'object'
        && data.mainComponent.docSourceUrls) || {},
      // Apparel-only: this PO's own editable copy of a sizing standard
      // (points/sizes/measurements) - the source of truth for this PO's
      // sizing + QA process, independent of the master standard in
      // fits.json once copied in, so it can be adjusted per-order.
      dimensionsTable: (data.mainComponent && data.mainComponent.dimensionsTable) || null,
      weightGrams: (data.mainComponent && data.mainComponent.weightGrams) || null,
      shippingWeightGrams: (data.mainComponent && data.mainComponent.shippingWeightGrams) || null,
      volumeWeightGrams: (data.mainComponent && data.mainComponent.volumeWeightGrams) || null,
      photoReference: (data.mainComponent && data.mainComponent.photoReference) || '',
      warehouse: (data.mainComponent && data.mainComponent.warehouse) || '',
      sizeDistribution: (data.mainComponent && data.mainComponent.sizeDistribution) || []
    },
    accessories: Array.isArray(data.accessories) ? data.accessories.map(normalizeAccessory) : [],
    // QA/QC report tracking, one block per inspection stage. Status drives
    // the main order status (see REPORT_STATUS_TO_ORDER_STATUS); the report
    // fields get filled in automatically when a report is submitted for
    // this PO so the finished PDF is downloadable straight from the panel.
    qaReports: {
      preProduction: normalizeQaReport(data.qaReports && data.qaReports.preProduction),
      bulk: normalizeQaReport(data.qaReports && data.qaReports.bulk)
    },
    fulfillment: {
      packingListNumber: (data.fulfillment && data.fulfillment.packingListNumber) || '',
      waybillNumber: (data.fulfillment && data.fulfillment.waybillNumber) || '',
      warehouseEntryDate: (data.fulfillment && data.fulfillment.warehouseEntryDate) || null,
      warehouseOverdue: (data.fulfillment && data.fulfillment.warehouseOverdue) || '',
      quantityReceived: (data.fulfillment && data.fulfillment.quantityReceived) || null,
      allAccessoriesReceived: (data.fulfillment && data.fulfillment.allAccessoriesReceived) || '',
      exceptionHandlingResults: (data.fulfillment && data.fulfillment.exceptionHandlingResults) || '',
      returnTrackingNumber: (data.fulfillment && data.fulfillment.returnTrackingNumber) || '',
      replacementSizes: (data.fulfillment && data.fulfillment.replacementSizes) || []
    },
    costs: {
      assemblyFee: (data.costs && data.costs.assemblyFee) || 0,
      laborCosts: (data.costs && data.costs.laborCosts) || 0,
      transportationFees: (data.costs && data.costs.transportationFees) || 0,
      otherExpenses: (data.costs && data.costs.otherExpenses) || 0
    },
    settlement: {
      status: 'Pending',
      amount: (data.settlement && data.settlement.amount) || null,
      paidDate: null,
      componentPayments: {}
    },
    files: [],
    changeLog: [],
    // ---- QA/QC fields (merged in from the retired poStore) ----
    // These live top-level, flat, matching what QA/QC reporting/approval/
    // consolidated-report code already expects, rather than nested under
    // mainComponent - keeps the translation layer for that code minimal.
    category: data.category || null, // finer than productLine: apparel/plush/bags/accessories/other
    subcategory: data.subcategory || null,
    creator: data.creator || '',
    productDevelopmentLead: data.productDevelopmentLead || '',
    sizesIncluded: Array.isArray(data.sizesIncluded) ? data.sizesIncluded : [],
    fitKey: data.fitKey || null,
    fitSizes: Array.isArray(data.fitSizes) ? data.fitSizes : [],
    asanaTaskLink: data.asanaTaskLink || null,
    asanaTaskGid: data.asanaTaskGid || null,
    productRisk: data.productRisk || null,
    createdAt: now,
    updatedAt: now
  };
  logChange(entry, actor, 'Created', `New ${entry.productLine} PO request`);
  // A brand-new PO for an existing SKU inherits that SKU's component specs,
  // including artwork already imported for an earlier PO of the product.
  syncComponentDefinitions(entry, actor);
  const inherited = applyDefinitionsToDocSlots(entry);
  if (inherited.length) {
    logChange(entry, 'Component library', 'Inherited artwork',
      `From previous POs for this SKU: ${inherited.join(', ')}`);
  }
  saveOne(entry);
  catalogStore.syncFromOrder(entry);
  fabricLibraryStore.syncFromOrder(entry);
  return entry;
}

function getOrderById(id) {
  const hit = orderDb.getOne(id);
  return hit ? hydrateOrder(hit) : null;
}

function getOrderByPoNumber(poNumber, productLine) {
  if (!poNumber) return null;
  const norm = String(poNumber).trim().toLowerCase();

  // Indexed exact match first - covers essentially every real lookup.
  const exact = orderDb.findByPoNumber(String(poNumber).trim(), productLine);
  if (exact) return hydrateOrder(exact);

  /* Fall back to the old case-insensitive scan. SQLite's = is case-sensitive
   * on text, and the previous implementation lower-cased both sides, so a PO
   * entered as "jtst01plu1-po1" would otherwise stop resolving. Rare enough
   * that paying for a scan here is fine. */
  return loadAll().find((e) =>
    e.poNumber && String(e.poNumber).trim().toLowerCase() === norm &&
    (!productLine || e.productLine === productLine)
  ) || null;
}

function getOrdersBySku(sku) {
  if (!sku) return [];
  const norm = String(sku).trim().toLowerCase();
  /* Narrowed by the sku index first. The case-insensitive filter is kept
   * because the column stores the SKU verbatim, so casing can differ. */
  return orderDb.findBySku(String(sku).trim()).map(hydrateOrder)
    .filter((e) => e.mainComponent && e.mainComponent.sku && String(e.mainComponent.sku).trim().toLowerCase() === norm)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/** Historical POs for a catalog product - matches by SKU when the
 *  product has one (the reliable key), falling back to an exact name
 *  match for older/manually-entered products that don't. */
function getOrdersForProduct(sku, name) {
  if (sku) return getOrdersBySku(sku);
  if (!name) return [];
  const norm = String(name).trim().toLowerCase();
  return loadAll()
    .filter((e) => e.mainComponent && e.mainComponent.name && String(e.mainComponent.name).trim().toLowerCase() === norm)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/** Historical POs that used a given component/accessory - matched by part
 *  name, narrowed by supplier when one is given (mirrors how
 *  catalogStore keys components: partName + supplierName together). */
/** All orders whose main component references one of the given fabric
 *  strings - field is 'fabricInfo' (Fabric Code) or 'component' (Fabric
 *  Type), values is the fabric entry's identifying strings (its value,
 *  plus pantone for imported swatches, so a PO entered either way still
 *  matches). Case-insensitive, newest first. */
function getOrdersForFabric(field, values) {
  const wanted = new Set((values || []).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean));
  if (!wanted.size) return [];
  return loadAll()
    .filter((o) => wanted.has(String((o.mainComponent && o.mainComponent[field]) || '').trim().toLowerCase()))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getOrdersForComponent(partName, supplierName) {  if (!partName) return [];
  const normPart = String(partName).trim().toLowerCase();
  const normSupplier = supplierName ? String(supplierName).trim().toLowerCase() : null;
  return loadAll()
    .filter((e) => (e.accessories || []).some((a) =>
      a.partName && String(a.partName).trim().toLowerCase() === normPart &&
      (!normSupplier || (a.supplierName && String(a.supplierName).trim().toLowerCase() === normSupplier))
    ))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/** Most recently-established apparel fit + its size list for a SKU, if any
 *  prior order for that SKU has had one set (normally via QA/QC Approval). */
function getEstablishedFitForSku(sku) {
  const orders = getOrdersBySku(sku).filter((o) => o.fitKey);
  return orders.length ? { fitKey: orders[0].fitKey, sizes: orders[0].fitSizes || [] } : null;
}

/** Flat, poStore-shaped view of an order for QA/QC reporting/approval/PDF
 *  code that was written against poStore's flat schema (sku, category,
 *  etc. at the top level) - keeps that code from needing to know or care
 *  that this data now actually lives on a nested Order Management record. */

/* ---- Derived next action ----
 *
 * Every PO has a next action, an owner and a date. Chloe's three workflows are
 * all filters over that, which is why it is computed once here rather than in
 * each view.
 *
 * Deliberately DERIVED, not a field someone maintains. A manual "waiting on"
 * column stops being true within a week, and a stale one is worse than none
 * because the whole point is to trust the queue without checking.
 *
 * followUpDate is the exception: it is the one thing no rule can know, because
 * it comes from what a factory promised on the phone. When set and due, it
 * outranks everything else.
 */
const ACTION_OWNERS = ['you', 'qa', 'pd', 'supplier', 'none'];

function daysBetween(a, b) {
  return Math.round((new Date(a) - new Date(b)) / 86400000);
}

function nextActionFor(order, approvalStatuses, today) {
  const now = today ? new Date(today) : new Date();
  const iso = (d) => (d ? String(d).slice(0, 10) : null);
  /* approvalStore returns camelCase values ('notStarted', 'waitingOnProductDev'),
   * so the default has to match that vocabulary - 'Not Started' matched nothing
   * and every unstarted stage silently fell through as no action at all. */
  const stageOf = (k) => (approvalStatuses && approvalStatuses[k]) || 'notStarted';

  // 1. An explicit follow-up that has come due beats any derived rule.
  if (order.followUpDate && new Date(order.followUpDate) <= now) {
    return { owner: 'you', kind: 'followUp', dueDate: iso(order.followUpDate),
      label: order.followUpNote || 'Follow up with the supplier',
      overdueBy: daysBetween(now, order.followUpDate) };
  }

  const qa = order.qaReports || {};
  const fu = order.factoryUpdates || {};

  /* 2. QA reporting, in the order the stages actually happen. A sample date
   *    that has arrived with no report link set up is the case that silently
   *    slips, so it is called out before anything else. */
  for (const [stage, dateField] of [['preProduction', 'preProductionSampleDate'], ['bulk', 'bulkSampleDate']]) {
    const r = qa[stage] || {};
    const ready = fu[dateField];
    if (r.status === 'Completed' || r.status === 'Skipped') continue;
    if (ready && new Date(ready) <= now && !r.setup) {
      return { owner: 'you', kind: 'qaSetupDue', stage, dueDate: iso(ready),
        label: `Set up the ${stage === 'bulk' ? 'bulk' : 'pre-production'} report link`,
        overdueBy: daysBetween(now, ready) };
    }
    if (r.setup && !r.submissionId) {
      return { owner: 'qa', kind: 'qaReportPending', stage, dueDate: iso(ready),
        label: `Waiting on the ${stage === 'bulk' ? 'bulk' : 'pre-production'} inspection`,
        overdueBy: ready ? daysBetween(now, ready) : 0 };
    }
    if (ready && !r.setup) {
      return { owner: 'you', kind: 'qaUpcoming', stage, dueDate: iso(ready),
        label: `Sample due ${iso(ready)} - schedule the inspection`,
        overdueBy: daysBetween(now, ready) };
    }
  }

  /* 3. PD approval.
   *
   * Split into work that has not STARTED (someone has to submit something)
   * and work that is IN FLIGHT (submitted, waiting on a decision). The first
   * kind is invisible otherwise: a new PO needing Golden Sample images, or a
   * finished inspection whose approval nobody has opened, sits in no queue at
   * all and only surfaces when someone remembers. Approved stages drop out
   * entirely - they are done. */
  const stageOrder = [
    ['sample', 'Golden Sample', null],
    ['preProduction', 'Pre-Production', 'preProduction'],
    ['bulk', 'Bulk', 'bulk']
  ];

  for (const [key, label, reportStage] of stageOrder) {
    const st = stageOf(key);
    if (st === 'approved' || st === 'approvedWithIssues' || st === 'notApplicable') continue;

    if (st === 'notStarted') {
      /* A stage can only be started once its input exists: the Golden Sample
       * needs the PO placed, the later stages need their inspection finished.
       * Anything else is not yet actionable and should not appear as a task. */
      if (!reportStage) {
        return { owner: 'you', kind: 'pdNeedsStart', stage: key, dueDate: null,
          label: `${label} approval not started - add the approved sample images`, overdueBy: 0 };
      }
      const report = qa[reportStage] || {};
      if (report.status === 'Completed') {
        return { owner: 'you', kind: 'pdNeedsStart', stage: key, dueDate: iso(report.submittedAt),
          label: `${label} inspection is done - submit it for approval`, overdueBy: 0 };
      }
      continue;
    }

    if (st === 'waitingOnProductDev') {
      return { owner: 'pd', kind: 'pdReview', stage: key, dueDate: null,
        label: `${label} approval waiting on Product Development`, overdueBy: 0 };
    }
    if (st === 'notApproved') {
      return { owner: 'you', kind: 'pdReply', stage: key, dueDate: null,
        label: `${label} approval was rejected - needs your response`, overdueBy: 0 };
    }
  }

  // 4. Placed but never sent to the factory.
  if (order.status && order.status !== 'New Request' && !(order.dispatchLog || []).length) {
    return { owner: 'you', kind: 'notDispatched', dueDate: iso(order.orderPlacementDate),
      label: 'Not yet sent to the supplier', overdueBy: 0 };
  }

  // 5. In production with a delivery date approaching.
  if (order.manufacturerDeliveryDate) {
    const d = daysBetween(now, order.manufacturerDeliveryDate);
    if (d >= -14) {
      return { owner: 'supplier', kind: 'delivery', dueDate: iso(order.manufacturerDeliveryDate),
        label: d > 0 ? `Delivery overdue by ${d} day(s)` : 'Delivery approaching', overdueBy: d };
    }
  }

  return { owner: 'none', kind: 'none', dueDate: null, label: '', overdueBy: 0 };
}

function toQaShape(order) {
  if (!order) return null;
  return {
    id: order.id,
    poNumber: order.poNumber,
    sku: order.mainComponent.sku,
    category: order.category,
    subcategory: order.subcategory,
    orderDate: order.orderPlacementDate,
    creator: order.creator,
    orderQuantity: order.mainComponent.purchaseQuantity,
    productTitle: order.mainComponent.name,
    productDevelopmentLead: order.productDevelopmentLead,
    sizesIncluded: order.sizesIncluded,
    fitKey: order.fitKey,
    fitSizes: order.fitSizes,
    asanaTaskLink: order.asanaTaskLink,
    asanaTaskGid: order.asanaTaskGid,
    productRisk: order.productRisk,
    // Everything the Order Management specialist sets up on the PO that
    // the PD Approval Sample stage should start from pre-filled, instead
    // of asking for it again from blank defaults: factory code (OM's
    // Supplier Code), the PO's own sizing table (apparel), and plain
    // L/W/H dimensions (non-apparel).
    factoryCode: (order.supplier && order.supplier.code) || '',
    // Whoever administers this PO in Order Management. Shown on the PD
    // Approval form instead of asking for a QA lead again.
    orderManagementSpecialist: order.buyer || '',
    dimensionsTable: order.mainComponent.dimensionsTable || null,
    dimensionsLength: order.mainComponent.dimensionsLength || null,
    dimensionsWidth: order.mainComponent.dimensionsWidth || null,
    dimensionsHeight: order.mainComponent.dimensionsHeight || null,
    // Approved finished weight, for the plush weight check on the Sizing step.
    weightGrams: order.mainComponent.weightGrams || null,
    /* Both stages' report-link setups. The report app picks the one matching
     * its mode. Null means Setup Report Link was never run for that stage, in
     * which case the report proceeds with no additional questions. */
    qaSetup: {
      preProduction: (order.qaReports && order.qaReports.preProduction && order.qaReports.preProduction.setup) || null,
      bulk: (order.qaReports && order.qaReports.bulk && order.qaReports.bulk.setup) || null
    },
    /* Whether each stage has already been reported on, so the report link can
     * show the completed state instead of silently starting a second report
     * against a PO that has already been signed off. */
    qaSubmitted: ['preProduction', 'bulk'].reduce((acc, stage) => {
      const r = (order.qaReports && order.qaReports[stage]) || {};
      acc[stage] = r.submissionId
        ? { submissionId: r.submissionId, pdfUrl: r.pdfUrl || '', result: r.result || '', submittedAt: r.submittedAt || null }
        : null;
      return acc;
    }, {}),
    createdAt: order.createdAt
  };
}

function listSuppliers(productLine) {
  const entries = loadAll().filter((e) => !productLine || e.productLine === productLine);
  const byKey = new Map();
  entries.forEach((e) => {
    const name = e.supplier && e.supplier.name;
    if (!name) return;
    const key = name.trim().toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, {
        name: e.supplier.name,
        contact: e.supplier.contact || '',
        code: e.supplier.code || '',
        productLines: new Set(),
        orderCount: 0
      });
    }
    const rec = byKey.get(key);
    rec.orderCount += 1;
    rec.productLines.add(e.productLine);
    // Prefer the most recently-seen contact/code in case it changed.
    if (e.supplier.contact) rec.contact = e.supplier.contact;
    if (e.supplier.code) rec.code = e.supplier.code;
  });
  return Array.from(byKey.values())
    .map((r) => ({ ...r, productLines: Array.from(r.productLines) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Manufacturing Cost is a PER-UNIT figure: the main component's own unit
// price plus every sub-component's per-unit price. Quantities only enter
// the picture once, at the Total PO Cost step below - not here.
function computeManufacturingCostPerUnit(order) {
  const mc = order.mainComponent || {};
  const mainUnitCost = Number(mc.factoryPrice) || 0;
  const subComponentUnitCosts = (order.accessories || []).reduce((sum, a) => sum + (Number(a.unitPrice) || 0), 0);
  return Math.round((mainUnitCost + subComponentUnitCosts) * 10000) / 10000;
}

// Total PO Cost = Manufacturing Cost x Order Quantity, plus every flat
// (not-per-unit) additional cost: each sub-component's own shipping cost
// (to the main factory), the warehousing shipping cost (to the warehouse),
// and the additional assembly/labor/other fees.
function computeOrderTotal(order) {
  const mc = order.mainComponent || {};
  const orderQuantity = Number(mc.purchaseQuantity) || 0;
  const manufacturingCostPerUnit = computeManufacturingCostPerUnit(order);
  const subComponentShippingTotal = (order.accessories || []).reduce((sum, a) => sum + (Number(a.shippingCost) || 0), 0);
  const costs = order.costs || {};
  const flatFeesTotal = (Number(costs.assemblyFee) || 0) + (Number(costs.laborCosts) || 0) +
    (Number(costs.transportationFees) || 0) + (Number(costs.otherExpenses) || 0) + subComponentShippingTotal;
  return Math.round((manufacturingCostPerUnit * orderQuantity + flatFeesTotal) * 100) / 100;
}

function computeTotalPricePerUnit(order) {
  const mc = order.mainComponent || {};
  const orderQuantity = Number(mc.purchaseQuantity) || 0;
  if (!orderQuantity) return null;
  return Math.round((computeOrderTotal(order) / orderQuantity) * 10000) / 10000;
}

function monthKeyFor(order) {
  const d = order.orderPlacementDate || order.desiredEntryDate || order.createdAt;
  if (!d) return 'Undated';
  const date = new Date(d);
  if (isNaN(date)) return 'Undated';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function getMonthlyFinancials() {
  const entries = loadAll();
  const byMonth = new Map();
  entries.forEach((e) => {
    const key = monthKeyFor(e);
    if (!byMonth.has(key)) byMonth.set(key, { month: key, total: 0, paid: 0, pending: 0, orderCount: 0 });
    const total = computeOrderTotal(e);
    const bucket = byMonth.get(key);
    bucket.total += total;
    bucket.orderCount += 1;
    if (e.settlement && e.settlement.status === 'Paid') bucket.paid += total;
    else bucket.pending += total;
  });
  return Array.from(byMonth.values())
    .map((b) => ({ ...b, total: round2(b.total), paid: round2(b.paid), pending: round2(b.pending) }))
    .sort((a, b) => (a.month < b.month ? 1 : -1)); // most recent first; "Undated" sorts oddly but rare
}

function round2(n) { return Math.round(n * 100) / 100; }

function getCounts() {
  const all = loadAll();
  // Category tiles exclude POs that haven't been sent to the factory yet -
  // those live in the PO Requests section. The counts must match what the
  // tiles actually list, or the header number disagrees with the rows.
  const entries = all.filter((e) => e.status !== 'New Request');
  const accessoryCount = (line) => entries
    .filter((e) => e.productLine === line)
    .reduce((sum, e) => sum + (e.accessories ? e.accessories.length : 0), 0);
  return {
    toys: entries.filter((e) => e.productLine === 'toys').length,
    clothing: entries.filter((e) => e.productLine === 'clothing').length,
    other: entries.filter((e) => e.productLine === 'other').length,
    toysAccessories: accessoryCount('toys'),
    clothingAccessories: accessoryCount('clothing'),
    otherAccessories: accessoryCount('other'),
    suppliers: listSuppliers().length,
    settlementPending: entries.filter((e) => e.settlement && e.settlement.status === 'Pending').length,
    // Counted from the unfiltered list, since this is the PO Requests total.
    newRequests: all.filter((e) => e.status === 'New Request').length
  };
}

function listOrders({ productLine, status, search } = {}) {
  /* productLine and status are indexed columns, so filtering happens in SQL
   * and only matching rows get parsed. Unfiltered still costs a full scan -
   * see the note on pagination in lib/orderDb.js. */
  let entries = orderDb.query({ productLine, status }).map(hydrateOrder);
  if (search) {
    const norm = String(search).trim().toLowerCase();
    entries = entries.filter((e) =>
      (e.poNumber || '').toLowerCase().includes(norm) ||
      (e.supplier && (e.supplier.name || '').toLowerCase().includes(norm)) ||
      (e.mainComponent && (e.mainComponent.name || '').toLowerCase().includes(norm)) ||
      (e.mainComponent && (e.mainComponent.sku || '').toLowerCase().includes(norm))
    );
  }
  return entries.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function updateOrder(id, patch, actor, actionLabel) {
  /* Fetch just this order rather than all of them. The one-element array keeps
   * the existing entries[idx] body below working unchanged. */
  const only = orderDb.getOne(id);
  if (!only) return null;
  const entries = [hydrateOrder(only)];
  const idx = 0;
  const before = entries[idx];
  const merged = { ...before, ...patch, updatedAt: new Date().toISOString() };
  // Deep-merge the known nested objects rather than clobbering them.
  ['supplier', 'mainComponent', 'costs', 'settlement', 'fulfillment', 'qaReports', 'factoryUpdates'].forEach((key) => {
    if (patch[key]) merged[key] = { ...before[key], ...patch[key] };
  });
  if (patch.accessories) {
    merged.accessories = patch.accessories.map(normalizeAccessory);
    // Record what this PO knows, and inherit what it doesn't.
    syncComponentDefinitions(merged, actor);
  }
  // Adding a waybill number means the goods have shipped, so advance the
  // order to In Transportation - but only forward, and only when the
  // waybill is genuinely new (not on every later save of the same value).
  const newWaybill = patch.fulfillment && patch.fulfillment.waybillNumber;
  if (newWaybill && String(newWaybill).trim() && !String(before.fulfillment.waybillNumber || '').trim()) {
    const currentIdx = STATUSES.indexOf(merged.status);
    const transitIdx = STATUSES.indexOf('In Transportation');
    if (transitIdx > currentIdx) merged.status = 'In Transportation';
  }
  // Stamp the delivery date the first time the order reaches Delivered, so
  // Asana's "Actual Fulfill Date" has something real to sync from. Only set
  // once - a later status edit shouldn't rewrite history.
  if (merged.status === 'In Transportation' && !merged.inTransportationAt) {
    merged.inTransportationAt = new Date().toISOString();
  }
  if (merged.status === 'Delivered' && !merged.deliveredAt) {
    merged.deliveredAt = new Date().toISOString();
  }
  // Same for completion: reaching the final status is what Asana's
  // "Completion Date" tracks, so stamp it here as well as from the
  // Complete PO button (whichever happens first wins).
  if (merged.status === 'Completed' && !merged.poCompletedAt) {
    merged.poCompletedAt = new Date().toISOString();
  }
  logChange(merged, actor, actionLabel || 'Updated', summarizeChange(before, patch));
  entries[idx] = merged;
  saveOne(merged);
  // Only worth re-syncing when the fields that could introduce a new
  // product/part actually changed - avoids a wasted disk read+scan on
  // every unrelated update (status changes, settlement, etc.).
  if (patch.mainComponent || patch.accessories || patch.productLine || patch.supplier) {
    catalogStore.syncFromOrder(merged);
  }
  if (patch.mainComponent) fabricLibraryStore.syncFromOrder(merged);
  return merged;
}

function summarizeChange(before, patch) {
  if (patch.status && patch.status !== before.status) {
    return `Status: "${before.status}" → "${patch.status}"`;
  }
  if (patch.settlement && patch.settlement.status) {
    return `Settlement: "${before.settlement.status}" → "${patch.settlement.status}"`;
  }
  if (patch.accessories) {
    return `Accessories/parts updated (${patch.accessories.length} item${patch.accessories.length === 1 ? '' : 's'})`;
  }
  if (patch.fulfillment) {
    return 'Fulfillment/tracking details updated';
  }
  return null;
}

function setStatus(id, status, actor) {
  return updateOrder(id, { status }, actor, 'Status change');
}

/** Set one QA/QC stage's report status, and advance the main order status
 *  to match (In Progress -> that inspection stage, Completed -> the step
 *  after it). Only ever moves the order forward: if the PO is already past
 *  the mapped status, it's left alone so a late report edit can't drag a
 *  shipped order backwards. */
function setQaReportStatus(id, stage, status, actor) {
  if (!REPORT_STATUS_TO_ORDER_STATUS[stage]) return null;
  if (!REPORT_STATUSES.includes(status)) return null;
  const order = getOrderById(id);
  if (!order) return null;
  const patch = { qaReports: { ...order.qaReports, [stage]: { ...order.qaReports[stage], status } } };
  const mapped = REPORT_STATUS_TO_ORDER_STATUS[stage][status];
  if (mapped) {
    const currentIdx = STATUSES.indexOf(order.status);
    const mappedIdx = STATUSES.indexOf(mapped);
    if (mappedIdx > currentIdx) patch.status = mapped;
  }
  const label = stage === 'preProduction' ? 'Pre-Production' : 'Bulk';
  return updateOrder(id, patch, actor, `${label} report ${status}`);
}

/** Called when a QA/QC report is submitted for a PO: files the finished
 *  PDF against the matching stage, and if the inspection passed, marks
 *  that stage Completed (which advances the main status). A fail leaves
 *  the stage In Progress so the issue stays visible and actionable. */
function attachSubmittedReport(poNumber, { stage, submissionId, pdfUrl, result }, actor) {
  const order = getOrderByPoNumber(poNumber);
  if (!order || !REPORT_STATUS_TO_ORDER_STATUS[stage]) return null;
  const passed = String(result || '').toLowerCase() === 'pass';
  const report = {
    ...order.qaReports[stage],
    status: passed ? 'Completed' : 'In Progress',
    submissionId: submissionId || null,
    pdfUrl: pdfUrl || '',
    result: result || '',
    submittedAt: new Date().toISOString()
  };
  const patch = { qaReports: { ...order.qaReports, [stage]: report } };
  const mapped = REPORT_STATUS_TO_ORDER_STATUS[stage][report.status];
  if (mapped) {
    const currentIdx = STATUSES.indexOf(order.status);
    const mappedIdx = STATUSES.indexOf(mapped);
    if (mappedIdx > currentIdx) patch.status = mapped;
  }
  const label = stage === 'preProduction' ? 'Pre-Production' : 'Bulk';
  return updateOrder(order.id, patch, actor || 'System', `${label} report submitted (${result || 'no result'})`);
}


/**
 * Permanently delete a purchase order, along with its uploaded files on
 * disk. Returns the deleted record (so the caller can log/report what went)
 * or null if there was no such order.
 *
 * This is a hard delete on purpose - the UI gates it behind typing the PO
 * number - but note it does NOT remove:
 *   - QA/QC report submissions for this PO (they're an audit trail, and are
 *     keyed by PO number rather than order id, so a re-created PO with the
 *     same number will pick its history back up)
 *   - catalog/fabric-library entries this order happened to introduce
 *     (they're shared reference data, not owned by one order)
 */
function deleteOrder(id, actor) {
  /* Fetch just this order rather than all of them. The one-element array keeps
   * the existing entries[idx] body below working unchanged. */
  const only = orderDb.getOne(id);
  if (!only) return null;
  const entries = [hydrateOrder(only)];
  const idx = 0;
  const [removed] = entries.splice(idx, 1);
  orderDb.deleteOne(id);
  // Best-effort cleanup of this order's upload folder; a failure here must
  // not make the delete look like it failed, since the record is already gone.
  try {
    const dir = path.join(ORDER_FILES_DIR, id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error(`Deleted order ${id} but could not remove its files:`, err.message || err);
  }
  console.log(`Order deleted: ${removed.poNumber} (${id}) by ${actor || 'unknown'}`);
  return removed;
}

/**
 * Append a dated entry to the bulk shipment progress log.
 *
 * Written by the Juniper team, not the factory - the supplier page shows
 * these read-only. Append-only on purpose: it's a record of what was
 * observed and when, so entries aren't editable or removable afterwards.
 *
 * (The storage lives under `factoryUpdates` for historical reasons - it was
 * originally supplier-maintained. The key name is kept so existing records
 * don't need migrating.)
 */
function addProgressNote(id, text, actor) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  /* Fetch just this order rather than all of them. The one-element array keeps
   * the existing entries[idx] body below working unchanged. */
  const only = orderDb.getOne(id);
  if (!only) return null;
  const entries = [hydrateOrder(only)];
  const idx = 0;
  const current = entries[idx].factoryUpdates || {};
  entries[idx].factoryUpdates = {
    ...current,
    bulkProgressLog: [
      ...(Array.isArray(current.bulkProgressLog) ? current.bulkProgressLog : []),
      { text: clean, at: new Date().toISOString(), by: actor || 'Web user' }
    ],
    updatedAt: new Date().toISOString(),
    updatedBy: actor || 'Web user'
  };
  entries[idx].updatedAt = new Date().toISOString();
  logChange(entries[idx], actor, 'Bulk shipment progress', clean.slice(0, 80));
  saveOne(entries[idx]);
  return entries[idx];
}

/**
 * Move an order forward when Product Development approves an inspection
 * stage. Called after a PD decision is recorded on the approval record.
 * Only moves forward, and only for the two stages that gate production.
 */
function advanceOnPdApproval(poNumber, stageKey, actor) {
  const target = PD_APPROVAL_TO_ORDER_STATUS[stageKey];
  if (!target) return null;
  const order = getOrderByPoNumber(poNumber);
  if (!order) return null;
  const currentIdx = STATUSES.indexOf(order.status);
  const targetIdx = STATUSES.indexOf(target);
  if (targetIdx <= currentIdx) return order; // already at or past this point
  const label = stageKey === 'preProductionApproval' ? 'Pre-Production' : 'Bulk';
  return updateOrder(order.id, { status: target }, actor || 'System',
    `${label} approved by Product Development`);
}

/**
 * Sending the main component's purchase order to its factory is what marks
 * the order as placed. Sub-component dispatches deliberately don't do this:
 * a hang-tag order going out doesn't mean the product itself is on order.
 *
 * Only ever moves the order forward, so re-sending a PO to chase a factory
 * can't drag a job that's already in production back to Order Placed.
 */
function advanceOnMainPoDispatch(id, actor) {
  const order = getOrderById(id);
  if (!order) return null;
  const currentIdx = STATUSES.indexOf(order.status);
  const targetIdx = STATUSES.indexOf('Order Placed');
  if (targetIdx <= currentIdx) return order;
  const patch = { status: 'Order Placed' };
  // An order that's just been placed should carry the date it was placed;
  // the field locks in the UI once set, so only fill it when it's empty.
  if (!order.orderPlacementDate) patch.orderPlacementDate = new Date().toISOString().slice(0, 10);
  return updateOrder(id, patch, actor || 'System', 'Purchase order sent to factory');
}

/**
 * Sending a sub-component's purchase order places that component's own
 * order - the mirror of advanceOnMainPoDispatch, but scoped to the one
 * accessory rather than the parent PO. The parent's status is untouched:
 * a hang tag being ordered says nothing about the product itself.
 *
 * Only moves forward, using the shorter ACCESSORY_STATUSES lifecycle.
 */
function advanceAccessoryOnDispatch(orderId, accessoryId, actor) {
  const order = getOrderById(orderId);
  if (!order) return null;
  const accessory = (order.accessories || []).find((a) => String(a.id) === String(accessoryId));
  if (!accessory) return null;
  const currentIdx = ACCESSORY_STATUSES.indexOf(accessory.status);
  const targetIdx = ACCESSORY_STATUSES.indexOf('Order Placed');
  if (targetIdx <= currentIdx) return order; // already at or past this point
  const accessories = order.accessories.map((a) =>
    (String(a.id) === String(accessoryId) ? { ...a, status: 'Order Placed' } : a));
  return updateOrder(orderId, { accessories }, actor || 'System',
    `${accessory.partName || 'Component'} purchase order sent to factory`);
}

function setSettlement(id, settlementStatus, actor) {
  const patch = { settlement: { status: settlementStatus } };
  if (settlementStatus === 'Paid') patch.settlement.paidDate = new Date().toISOString();
  return updateOrder(id, patch, actor, 'Settlement change');
}

/**
 * Append a plain note to an order's change log.
 *
 * For outcomes that aren't field changes - an automatic import reporting
 * what it did or why it did nothing. Without this, a background job that
 * silently no-ops leaves no trace anywhere the team can see.
 */
function logNote(id, actor, message) {
  /* Fetch just this order rather than all of them. The one-element array keeps
   * the existing entries[idx] body below working unchanged. */
  const only = orderDb.getOne(id);
  if (!only) return null;
  const entries = [hydrateOrder(only)];
  const idx = 0;
  logChange(entries[idx], actor, 'Note', message);
  entries[idx].updatedAt = new Date().toISOString();
  saveOne(entries[idx]);
  return entries[idx];
}

function addFile(id, file, actor) {
  /* Fetch just this order rather than all of them. The one-element array keeps
   * the existing entries[idx] body below working unchanged. */
  const only = orderDb.getOne(id);
  if (!only) return null;
  const entries = [hydrateOrder(only)];
  const idx = 0;
  if (!Array.isArray(entries[idx].files)) entries[idx].files = [];
  entries[idx].files.push(file);
  entries[idx].updatedAt = new Date().toISOString();
  logChange(entries[idx], actor, 'File added', `${file.category}: ${file.originalName}`);
  saveOne(entries[idx]);
  return entries[idx];
}

function removeFile(id, fileId, actor) {
  /* Fetch just this order rather than all of them. The one-element array keeps
   * the existing entries[idx] body below working unchanged. */
  const only = orderDb.getOne(id);
  if (!only) return null;
  const entries = [hydrateOrder(only)];
  const idx = 0;
  const file = (entries[idx].files || []).find((f) => f.id === fileId);
  entries[idx].files = (entries[idx].files || []).filter((f) => f.id !== fileId);
  entries[idx].updatedAt = new Date().toISOString();
  if (file) {
    logChange(entries[idx], actor, 'File removed', `${file.category}: ${file.originalName}`);
    const diskPath = path.join(ORDER_FILES_DIR, id, file.storedName);
    fs.unlink(diskPath, () => {}); // best-effort; don't fail the request if this errors
  }
  saveOne(entries[idx]);
  return entries[idx];
}

function listProducts(productLine) {
  const entries = loadAll().filter((e) => !productLine || e.productLine === productLine);
  const byKey = new Map();
  entries.forEach((e) => {
    const mc = e.mainComponent || {};
    if (!mc.name && !mc.sku) return;
    const key = (mc.sku || mc.name).trim().toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, {
        name: mc.name || '(unnamed)',
        sku: mc.sku || '',
        modelNumber: mc.modelNumber || '',
        productLine: e.productLine,
        factoryPrice: mc.factoryPrice,
        salesUnitPrice: mc.salesUnitPrice,
        poCount: 0,
        examplePoId: e.id
      });
    }
    byKey.get(key).poCount += 1;
  });
  return Array.from(byKey.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function listComponents(productLine) {
  const entries = loadAll().filter((e) => !productLine || e.productLine === productLine);
  const byKey = new Map();
  entries.forEach((e) => {
    (e.accessories || []).forEach((a) => {
      if (!a.partName) return;
      const key = `${a.partName}::${a.supplierName || ''}`.trim().toLowerCase();
      if (!byKey.has(key)) {
        byKey.set(key, {
          partName: a.partName,
          partType: a.partType || a.partName,
          material: a.material || '',
          supplierName: a.supplierName || '',
          unitPrice: a.unitPrice,
          productLine: e.productLine,
          useCount: 0,
          examplePoId: e.id,
          exampleAccessoryId: a.id
        });
      }
      byKey.get(key).useCount += 1;
    });
  });
  return Array.from(byKey.values()).sort((a, b) => a.partName.localeCompare(b.partName));
}

function getFieldHistory() {
  const entries = loadAll();
  const collect = (getter) => {
    const set = new Set();
    entries.forEach((e) => {
      const v = getter(e);
      if (v && String(v).trim()) set.add(String(v).trim());
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  };
  return {
    supplierNames: collect((e) => e.supplier && e.supplier.name),
    fabricCodes: collect((e) => e.mainComponent && e.mainComponent.fabricInfo),
    fabricTypes: collect((e) => e.mainComponent && e.mainComponent.component),
    washLabels: collect((e) => e.mainComponent && e.mainComponent.washLabel),
    manufacturingDrawings: collect((e) => e.mainComponent && e.mainComponent.manufacturingDrawing)
  };
}


/* One-time import from the old flat file.
 *
 * Deliberately at the very bottom of the module: hydrateOrder reads constants
 * (LEGACY_STATUS_MAP among them) that are declared further down, so running
 * this beside the orderDb.init() call above threw a temporal-dead-zone error.
 * The catch swallowed it and the app booted with an empty database - which
 * looks exactly like "all the orders are gone". Hence also the louder logging
 * on failure: a migration that silently does nothing is the worst outcome here.
 */
try {
  const res = orderDb.migrateFromJson(ORDERS_PATH, hydrateOrder);
  if (res.migrated) {
    console.log(`Imported ${res.migrated} order(s) from orderManagement.json into SQLite. `
      + 'The JSON file has been left in place as a rollback copy.');
  }
} catch (err) {
  console.error('ORDER STORE MIGRATION FAILED - the app is running against an empty '
    + 'order database. The JSON file is untouched; fix this before saving anything.', err);
}

module.exports = {
  STATUSES, ACCESSORY_STATUSES, REPORT_STATUSES, FILE_CATEGORIES, PRODUCT_LINES, ORDER_FILES_DIR, createOrder, getOrderById, getOrderByPoNumber,
  getOrdersBySku, getEstablishedFitForSku, toQaShape, setQaReportStatus, setQaReportSetup, attachSubmittedReport,
  listOrders, updateOrder, setStatus, setSettlement, deleteOrder, addProgressNote, advanceOnPdApproval, advanceOnMainPoDispatch, advanceAccessoryOnDispatch, addFile, removeFile, logNote, applyDefinitionsToDocSlots, logNote, listSuppliers, listProducts,
  listComponents, getCounts, computeOrderTotal, computeManufacturingCostPerUnit, computeTotalPricePerUnit,
  getMonthlyFinancials, getFieldHistory, ORDERS_PATH, checkpointDatabase, nextActionFor, ACTION_OWNERS, getOrdersForProduct, getOrdersForComponent, getOrdersForFabric
};
