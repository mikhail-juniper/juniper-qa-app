/**
 * User accounts, roles and permissions.
 *
 * Deliberately separated from *how* someone proves who they are. A user
 * record holds identity links for each supported method:
 *
 *   passwordHash  - the current shared/per-user password login
 *   googleSub     - Google OAuth subject id (Juniper staff)
 *   wechatOpenId  - WeChat Official Account OpenID (China team, suppliers)
 *   wecomUserId   - WeCom member id, if that route is taken later
 *
 * Adding Google or WeChat later means writing the identity link onto an
 * existing user, not reworking permissions. That's the whole point of doing
 * this layer first.
 *
 * Roles
 *   admin     - everything, including managing users
 *   internal  - Juniper staff: full order/QA access, no user management
 *   qa        - QA/QC staff: reporting and approvals, read-only on orders
 *   supplier  - scoped to their own supplier's POs only
 *
 * Stored on the persistent disk, not in config/, so accounts survive deploys.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { DATA_DIR } = require('./submissionLog');

const USERS_PATH = path.join(DATA_DIR, 'users.json');

const ROLES = ['admin', 'internal', 'qa', 'supplier'];

/**
 * What each role may do. Checked by name at the route level rather than
 * with ad-hoc role comparisons scattered through the code, so the rules are
 * all visible in one place and easy to audit.
 */
const ROLE_PERMISSIONS = {
  admin: [
    'orders:read', 'orders:write', 'orders:delete',
    'qa:read', 'qa:write', 'approvals:write',
    'catalog:read', 'catalog:write',
    'finances:read', 'dispatch:send',
    'settings:read', 'settings:write', 'users:manage'
  ],
  // Everything except settings.
  internal: [
    'orders:read', 'orders:write',
    'qa:read', 'qa:write', 'approvals:write',
    'catalog:read', 'catalog:write',
    'finances:read', 'dispatch:send'
  ],
  // QA reporting and approvals only. orders:read is still needed because a
  // report has to load the PO it's written against - but no order pages.
  qa: [
    'orders:read',
    'qa:read', 'qa:write', 'approvals:write'
  ],
  // Suppliers see only their own POs - enforced by scoping, not just by
  // which permissions they hold (see scopeOrdersForUser).
  supplier: ['orders:read', 'qa:read']
};

/**
 * Which pages each role may open, and where they land after login. Enforced
 * server-side on .html requests as well as used to build the sidebar, so
 * hiding a nav link isn't the only thing keeping someone out.
 *
 * '*' means every page.
 */
const ROLE_PAGES = {
  admin: ['*'],
  internal: [
    'order-management.html', 'reporting.html', 'approval.html', 'reports.html',
    'clients.html', 'sizing-charts.html', 'analytics.html', 'index.html'
  ],
  qa: ['reporting.html', 'approval.html', 'reports.html', 'index.html'],
  // Suppliers get their own purpose-built page rather than a filtered
  // version of the internal one.
  supplier: ['supplier-orders.html']
};

const ROLE_LANDING = {
  admin: '/order-management.html',
  internal: '/order-management.html',
  qa: '/reporting.html',
  supplier: '/supplier-orders.html'
};

/** True if this role may open the given page filename. */
function canOpenPage(user, pageName) {
  const allowed = ROLE_PAGES[(user && user.role) || ''] || [];
  if (allowed.includes('*')) return true;
  return allowed.includes(pageName);
}

function landingPageFor(user) {
  return ROLE_LANDING[(user && user.role) || ''] || '/order-management.html';
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  ensureDir();
  if (!fs.existsSync(USERS_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Failed to parse users.json - treating as empty:', err);
    return [];
  }
}

function saveAll(entries) {
  ensureDir();
  fs.writeFileSync(USERS_PATH, JSON.stringify(entries, null, 2));
}

/** Salted hash. Not bcrypt - this app has no native-module build step and
 *  scrypt is in Node's stdlib, which is strong enough for this use. */
function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), useSalt, 64).toString('hex');
  return `${useSalt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !String(stored).includes(':')) return false;
  const [salt] = String(stored).split(':');
  const candidate = hashPassword(password, salt);
  // Constant-time compare so a wrong password can't be narrowed by timing.
  const a = Buffer.from(candidate);
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalize(u) {
  return {
    id: u.id,
    name: u.name || '',
    email: (u.email || '').trim().toLowerCase(),
    role: ROLES.includes(u.role) ? u.role : 'internal',
    active: u.active !== false,
    // Supplier users are pinned to one supplier record; everything they can
    // see is filtered through this.
    supplierId: u.supplierId || null,
    supplierName: u.supplierName || '',
    passwordHash: u.passwordHash || null,
    googleSub: u.googleSub || null,
    // Encrypted Gmail refresh token (lib/gmailSend). Never leaves the
    // server - publicView() strips it and exposes only a boolean.
    gmailRefreshToken: u.gmailRefreshToken || null,
    wechatOpenId: u.wechatOpenId || null,
    // Stable across every app under the same WeChat Open Platform account,
    // unlike openId which differs per app. Preferred for matching.
    wechatUnionId: u.wechatUnionId || null,
    wecomUserId: u.wecomUserId || null,
    lastLoginAt: u.lastLoginAt || null,
    createdAt: u.createdAt || new Date().toISOString(),
    updatedAt: u.updatedAt || new Date().toISOString()
  };
}

/** Never send password hashes to the client. */
function publicView(u) {
  if (!u) return null;
  const { passwordHash, gmailRefreshToken, ...rest } = u;
  return {
    ...rest,
    hasPassword: !!passwordHash,
    gmailConnected: !!gmailRefreshToken
  };
}

function listUsers() {
  return loadAll().map(normalize);
}

function getUser(id) {
  return listUsers().find((u) => u.id === id) || null;
}

function findByEmail(email) {
  const wanted = String(email || '').trim().toLowerCase();
  if (!wanted) return null;
  return listUsers().find((u) => u.email === wanted) || null;
}

/** Look a user up by any linked external identity. */
function findByIdentity(field, value) {
  if (!value) return null;
  const allowed = ['googleSub', 'wechatOpenId', 'wecomUserId'];
  if (!allowed.includes(field)) return null;
  return listUsers().find((u) => u[field] === value) || null;
}

function createUser(data) {
  const entries = loadAll();
  const now = new Date().toISOString();
  const entry = normalize({ ...data, id: uuidv4(), createdAt: now, updatedAt: now });
  if (data.password) entry.passwordHash = hashPassword(data.password);
  entries.push(entry);
  saveAll(entries);
  return entry;
}

function updateUser(id, patch) {
  const entries = loadAll();
  const idx = entries.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  const merged = { ...entries[idx], ...patch, id: entries[idx].id, updatedAt: new Date().toISOString() };
  if (patch.password) merged.passwordHash = hashPassword(patch.password);
  delete merged.password;
  entries[idx] = normalize(merged);
  // normalize() drops unknown keys, so re-attach the secrets it doesn't own.
  entries[idx].passwordHash = merged.passwordHash || null;
  entries[idx].gmailRefreshToken = merged.gmailRefreshToken || null;
  saveAll(entries);
  return entries[idx];
}

function deleteUser(id) {
  const entries = loadAll();
  const next = entries.filter((u) => u.id !== id);
  if (next.length === entries.length) return false;
  saveAll(next);
  return true;
}

function recordLogin(id) {
  const entries = loadAll();
  const idx = entries.findIndex((u) => u.id === id);
  if (idx === -1) return;
  entries[idx].lastLoginAt = new Date().toISOString();
  saveAll(entries);
}

/** Authenticate by email + password. Returns the user or null. */
function authenticate(email, password) {
  const user = findByEmail(email);
  if (!user || !user.active) return null;
  const stored = loadAll().find((u) => u.id === user.id);
  if (!stored || !stored.passwordHash) return null;
  if (!verifyPassword(password, stored.passwordHash)) return null;
  recordLogin(user.id);
  return user;
}

function permissionsFor(role) {
  return ROLE_PERMISSIONS[role] || [];
}

function can(user, permission) {
  if (!user) return false;
  if (user.active === false) return false;
  return permissionsFor(user.role).includes(permission);
}

/**
 * Narrow a list of orders to what this user is allowed to see. Internal
 * roles see everything; a supplier sees only orders where they're the main
 * supplier or supply one of the sub-components.
 */
function scopeOrdersForUser(user, orders) {
  if (!user || user.role !== 'supplier') return orders;
  const name = String(user.supplierName || '').trim().toLowerCase();
  if (!name) return [];
  return (orders || []).filter((o) => {
    const main = String((o.supplier && o.supplier.name) || '').trim().toLowerCase();
    if (main === name) return true;
    return (o.accessories || []).some(
      (a) => String(a.supplierName || '').trim().toLowerCase() === name);
  });
}

/** True if this user may see this specific order. */
function canSeeOrder(user, order) {
  if (!user || !order) return false;
  if (user.role !== 'supplier') return true;
  return scopeOrdersForUser(user, [order]).length === 1;
}

/**
 * Strip an order down to what a supplier may see.
 *
 * The supplier page only *renders* a few fields, but until this existed the
 * API still sent the whole order - costs, margins, settlement status and
 * rival suppliers' names were all sitting in the browser's network tab.
 * Redaction has to happen server-side; what the UI chooses to draw is not
 * access control.
 *
 * Included: identity, dates, quantity, the production documents, and only
 * the sub-components this supplier makes.
 * Excluded: all pricing and settlement, other suppliers' components, Asana
 * links, and the raw change log (a supplier-safe log is built instead).
 */
function redactOrderForSupplier(user, order) {
  if (!order) return null;
  if (!user || user.role !== 'supplier') return order;
  const name = String(user.supplierName || '').trim().toLowerCase();
  const mc = order.mainComponent || {};
  const isMainSupplier = String((order.supplier && order.supplier.name) || '').trim().toLowerCase() === name;
  const ownAccessories = (order.accessories || []).filter(
    (a) => String(a.supplierName || '').trim().toLowerCase() === name);

  // When the PO reached this supplier. Their own dispatch is the honest
  // answer; the order's placement date is the fallback.
  const dispatches = (order.dispatchLog || []).filter(
    (d) => String(d.supplierName || '').trim().toLowerCase() === name);
  const lastDispatch = dispatches
    .slice().sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))[0];

  // A log limited to things this factory is party to: when their PO was
  // sent, and the order's own status milestones. Never the raw change log,
  // which carries pricing edits and other suppliers' details.
  const log = [];
  dispatches.forEach((d) => log.push({
    at: d.sentAt,
    type: 'dispatch',
    text: `Purchase order sent for ${d.componentName || 'this order'} via ${d.channel}`
  }));
  (order.changeLog || [])
    .filter((c) => c.action === 'Status change' || /purchase order sent to factory/i.test(c.action || ''))
    .forEach((c) => log.push({
      at: c.timestamp,
      type: 'status',
      text: c.details || c.action
    }));
  log.sort((a, b) => new Date(b.at) - new Date(a.at));

  return {
    id: order.id,
    poNumber: order.poNumber,
    status: order.status,
    productLine: order.productLine,
    // "Order placement date" for a supplier means when it reached them.
    orderPlacementDate: (lastDispatch && lastDispatch.sentAt) || order.orderPlacementDate || null,
    manufacturerDeliveryDate: order.manufacturerDeliveryDate || null,
    orderDate: order.orderPlacementDate || null,
    // "Actual Ship Date" - when the order actually went into transit.
    inTransportationAt: order.inTransportationAt || null,
    // Notes we wrote for the factory when the PO went out.
    productionNotes: order.productionNotes || '',
    // The factory's own fields - the only part of the order they can edit.
    factoryUpdates: order.factoryUpdates || {},
    // Newest first, so the table can show the latest without sorting.
    bulkProgressLog: ((order.factoryUpdates && order.factoryUpdates.bulkProgressLog) || [])
      .slice().sort((a, b) => new Date(b.at) - new Date(a.at)),
    // Warehousing details the factory needs in order to ship.
    warehouseAddress: (order.mainComponent && order.mainComponent.warehouse) || '',
    packingListNumber: (order.fulfillment && order.fulfillment.packingListNumber) || '',
    mainComponent: isMainSupplier ? {
      name: mc.name || '',
      sku: mc.sku || '',
      purchaseQuantity: mc.purchaseQuantity ?? null,
      photoReference: mc.photoReference || '',
      manufacturingDrawing: mc.manufacturingDrawing || '',
      washingTagUrl: mc.washingTagUrl || '',
      packagingUrl: mc.packagingUrl || '',
      dimensionsUrl: mc.dimensionsUrl || '',
      dimensionsTable: mc.dimensionsTable || null,
      dimensionsLength: mc.dimensionsLength ?? null,
      dimensionsWidth: mc.dimensionsWidth ?? null,
      dimensionsHeight: mc.dimensionsHeight ?? null,
      weightGrams: mc.weightGrams ?? null,
      shippingWeightGrams: mc.shippingWeightGrams ?? null,
      volumeWeightGrams: mc.volumeWeightGrams ?? null,
      sizeDistribution: mc.sizeDistribution || []
    } : { name: (ownAccessories[0] && ownAccessories[0].partName) || '', sku: '', sizeDistribution: [] },
    /* Component strip for the supplier table: name + photo of every
     * sub-component on this PO. The main supplier assembles the product, so
     * they need to see all the parts - not just ones they supply. Name and
     * image only, so no other factory's pricing or contact leaks. */
    componentPhotos: isMainSupplier
      ? (order.accessories || []).map((a) => ({
        partName: a.partName || '',
        imageUrl: a.imageUrl || ''
      }))
      : [],
    // Only their own parts, and only the production-relevant fields.
    accessories: ownAccessories.map((a) => ({
      id: a.id,
      partName: a.partName || '',
      quantity: a.quantity ?? null,
      status: a.status || '',
      expectedDeliveryDate: a.expectedDeliveryDate || null,
      imageUrl: a.imageUrl || '',
      designDocUrl: a.designDocUrl || '',
      dimensionsLength: a.dimensionsLength ?? null,
      dimensionsWidth: a.dimensionsWidth ?? null,
      dimensionsHeight: a.dimensionsHeight ?? null
    })),
    supplierLog: log
  };
}

module.exports = {
  ROLES, ROLE_PERMISSIONS, ROLE_PAGES, ROLE_LANDING, canOpenPage, landingPageFor, USERS_PATH,
  listUsers, getUser, findByEmail, findByIdentity, createUser, updateUser,
  deleteUser, authenticate, recordLogin, hashPassword, verifyPassword,
  permissionsFor, can, scopeOrdersForUser, canSeeOrder, redactOrderForSupplier, publicView, normalize
};
