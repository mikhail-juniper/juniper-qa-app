/**
 * Persistent store for Suppliers as real master data (not just derived from
 * orders) - matching QingFlow's "Supplier Information" basic-info table,
 * which carries far more fields than a PO ever needs to reference.
 *
 * Field set is based directly on the columns visible in that QingFlow table:
 * Supplier Name, Supplier Contact, Mailing address, Shipping address,
 * Vendor Code, Product type, Company Name, Contact name, Phone Number,
 * WeChat, Address, Dollar or RMB. One column ("Bus...") was cut off in the
 * screenshot we worked from - modeled here as a free-text "businessInfo"
 * field; worth confirming what that column actually was and renaming if
 * it's something more specific (e.g. business license number).
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./submissionLog');

const SUPPLIERS_PATH = path.join(DATA_DIR, 'suppliers.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  ensureDir();
  if (!fs.existsSync(SUPPLIERS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(SUPPLIERS_PATH, 'utf8'));
  } catch (err) {
    console.error('Failed to parse supplier store - starting fresh. Original error:', err);
    return [];
  }
}

function saveAll(entries) {
  ensureDir();
  fs.writeFileSync(SUPPLIERS_PATH, JSON.stringify(entries, null, 2));
}

function listSuppliers() {
  return loadAll().sort((a, b) => a.name.localeCompare(b.name));
}

function getSupplier(id) {
  return loadAll().find((s) => s.id === id) || null;
}

function createSupplier(data) {
  const entries = loadAll();
  const now = new Date().toISOString();
  const entry = {
    id: data.id,
    name: data.name || '',
    companyName: data.companyName || '',
    vendorCode: data.vendorCode || '',
    productType: data.productType || '',
    contactName: data.contactName || '',
    phoneNumber: data.phoneNumber || '',
    wechat: data.wechat || '',
    mailingAddress: data.mailingAddress || '',
    shippingAddress: data.shippingAddress || '',
    currency: data.currency || 'RMB',
    businessInfo: data.businessInfo || '',
    notes: data.notes || '',
    createdAt: now,
    updatedAt: now
  };
  entries.push(entry);
  saveAll(entries);
  return entry;
}

function updateSupplier(id, patch) {
  const entries = loadAll();
  const idx = entries.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  entries[idx] = { ...entries[idx], ...patch, updatedAt: new Date().toISOString() };
  saveAll(entries);
  return entries[idx];
}

function deleteSupplier(id) {
  const entries = loadAll();
  const next = entries.filter((s) => s.id !== id);
  saveAll(next);
  return next.length !== entries.length;
}

module.exports = { listSuppliers, getSupplier, createSupplier, updateSupplier, deleteSupplier };
