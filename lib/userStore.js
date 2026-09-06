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
    wechatOpenId: u.wechatOpenId || null,
    wecomUserId: u.wecomUserId || null,
    lastLoginAt: u.lastLoginAt || null,
    createdAt: u.createdAt || new Date().toISOString(),
    updatedAt: u.updatedAt || new Date().toISOString()
  };
}

/** Never send password hashes to the client. */
function publicView(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return { ...rest, hasPassword: !!passwordHash };
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
  // normalize() drops unknown keys, so re-attach the hash it doesn't own.
  entries[idx].passwordHash = merged.passwordHash || null;
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

module.exports = {
  ROLES, ROLE_PERMISSIONS, ROLE_PAGES, ROLE_LANDING, canOpenPage, landingPageFor, USERS_PATH,
  listUsers, getUser, findByEmail, findByIdentity, createUser, updateUser,
  deleteUser, authenticate, recordLogin, hashPassword, verifyPassword,
  permissionsFor, can, scopeOrdersForUser, canSeeOrder, publicView, normalize
};
