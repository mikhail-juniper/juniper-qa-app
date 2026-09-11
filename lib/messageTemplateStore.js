/**
 * Editable message templates for sending purchase orders to suppliers.
 *
 * Each template holds a SEPARATELY AUTHORED English and Chinese version -
 * they are never machine-translated from one another. A PO message carries
 * commercial terms, and a mistranslated quantity or delivery date is a real
 * problem, so both versions are written and reviewed by a person.
 *
 * Stored under DATA_DIR (the persistent disk) rather than config/, because
 * anything written into config/ is part of the repo and gets overwritten on
 * the next deploy.
 *
 * Bodies support {{placeholders}} - see PLACEHOLDERS below - which are
 * filled in from the PO at send time.
 */
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { DATA_DIR } = require('./submissionLog');

const TEMPLATES_PATH = path.join(DATA_DIR, 'messageTemplates.json');

/** Placeholders a template body/subject may use. Shown in the Settings UI
 *  so template authors know what's available. */
const PLACEHOLDERS = [
  'poNumber', 'componentName', 'sku', 'quantity', 'unitPrice', 'total',
  'deliveryDate', 'address', 'contactName', 'supplierName', 'portalLink',
  'senderName', 'senderEmail'
];

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  ensureDir();
  if (!fs.existsSync(TEMPLATES_PATH)) return null; // null = never seeded
  try {
    const parsed = JSON.parse(fs.readFileSync(TEMPLATES_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Failed to parse messageTemplates.json - starting fresh:', err);
    return [];
  }
}

function saveAll(entries) {
  ensureDir();
  fs.writeFileSync(TEMPLATES_PATH, JSON.stringify(entries, null, 2));
}

/** The template shipped by default: the same message the app generated
 *  before templates existed, so nothing changes until someone edits it. */
const BILINGUAL_PO_KEY = 'standard-bilingual-po';

/** The bilingual PO message, as an editable template. Both language sides
 *  carry the same text because the message itself is bilingual - factories
 *  read the Chinese, we read the English, in one message. */
function bilingualPoTemplate() {
  const now = new Date().toISOString();
  const body = [
    '采购订单 Purchase Order: {{poNumber}}',
    '',
    '{{contactName}} 您好 / Hello {{contactName}},',
    '',
    '请确认以下采购订单内容。 / Please confirm the following purchase order details.',
    '',
    '产品 / Item:        {{componentName}}',
    'SKU:                {{sku}}',
    '数量 / Quantity:     {{quantity}}',
    '单价 / Unit price:   {{unitPrice}}',
    '总额 / Total:        {{total}}',
    '交货日期 / Delivery: {{deliveryDate}}',
    '收货地址 / Ship to:  {{address}}',
    '',
    '在线查看此订单 / View this order online:',
    '{{portalLink}}',
    '',
    '如有任何问题请回复此消息。 / Please reply to this message with any questions.',
    '',
    'Juniper Creates'
  ].join('\n');
  const subject = '采购订单 / Purchase Order {{poNumber}} - {{componentName}}';
  return {
    id: uuidv4(),
    key: BILINGUAL_PO_KEY,
    name: 'Standard purchase order (bilingual)',
    isDefault: true,
    en: { subject, body },
    zh: { subject, body },
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Add the bilingual template once, for installs seeded before it existed.
 * Existing templates are left untouched - someone may have edited them -
 * and this only takes over as the default if nothing else claims it.
 */
function ensureBilingualDefault() {
  const entries = loadAll();
  if (entries.some((t) => t.key === BILINGUAL_PO_KEY)) return entries;
  /* This becomes the default, demoting whatever held it. That's deliberate:
   * the bilingual message is what factories already receive, and the
   * previously seeded template was single-language - leaving it in charge
   * would silently change every PO message. Older templates are kept, just
   * no longer default, so nothing anyone wrote is lost. */
  const tpl = bilingualPoTemplate();
  entries.forEach((t) => { t.isDefault = false; });
  entries.push(tpl);
  saveAll(entries);
  return entries;
}

/** The template the copy buttons use: the one marked default, else the first. */
function getDefaultTemplate() {
  const entries = ensureBilingualDefault();
  return entries.find((t) => t.isDefault) || entries[0] || null;
}

function defaultTemplates() {
  const now = new Date().toISOString();
  return [{
    id: uuidv4(),
    name: 'Standard purchase order',
    isDefault: true,
    en: {
      subject: 'Purchase Order {{poNumber}} - {{componentName}}',
      body: [
        'Hello {{contactName}},',
        '',
        'Please confirm the following purchase order details.',
        '',
        'Item:          {{componentName}}',
        'SKU:           {{sku}}',
        'Quantity:      {{quantity}}',
        'Unit price:    {{unitPrice}}',
        'Total:         {{total}}',
        'Delivery date: {{deliveryDate}}',
        'Ship to:       {{address}}',
        '',
        '',
        'View this order online: {{portalLink}}',
        '',
        'Please reply to this message with any questions.',
        '',
        '{{senderName}}',
        'Juniper Creates'
      ].join('\n')
    },
    zh: {
      subject: '采购订单 {{poNumber}} - {{componentName}}',
      body: [
        '{{contactName}} 您好，',
        '',
        '请确认以下采购订单内容。',
        '',
        '产品：      {{componentName}}',
        'SKU：       {{sku}}',
        '数量：      {{quantity}}',
        '单价：      {{unitPrice}}',
        '总额：      {{total}}',
        '交货日期：  {{deliveryDate}}',
        '收货地址：  {{address}}',
        '',
        '',
        '在线查看此订单：{{portalLink}}',
        '',
        '如有任何问题请回复此消息。',
        '',
        '{{senderName}}',
        'Juniper Creates'
      ].join('\n')
    },
    createdAt: now,
    updatedAt: now
  }];
}

function listTemplates() {
  let entries = loadAll();
  if (entries === null) {          // first run - seed the default
    entries = defaultTemplates();
    saveAll(entries);
  }
  return entries;
}

function getTemplate(id) {
  return listTemplates().find((t) => t.id === id) || null;
}

function normalizeSide(side) {
  side = side || {};
  return { subject: side.subject || '', body: side.body || '' };
}

function createTemplate(data) {
  const entries = listTemplates();
  const now = new Date().toISOString();
  const entry = {
    id: uuidv4(),
    name: data.name || 'Untitled template',
    isDefault: false,
    en: normalizeSide(data.en),
    zh: normalizeSide(data.zh),
    createdAt: now,
    updatedAt: now
  };
  entries.push(entry);
  saveAll(entries);
  return entry;
}

function updateTemplate(id, patch) {
  const entries = listTemplates();
  const idx = entries.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const next = { ...entries[idx], ...patch, updatedAt: new Date().toISOString() };
  if (patch.en) next.en = normalizeSide(patch.en);
  if (patch.zh) next.zh = normalizeSide(patch.zh);
  next.id = entries[idx].id; // never let an id be patched out from under us
  entries[idx] = next;
  saveAll(entries);
  return next;
}

function deleteTemplate(id) {
  const entries = listTemplates();
  const next = entries.filter((t) => t.id !== id);
  if (next.length === entries.length) return false;
  saveAll(next);
  return true;
}

/** Substitute {{placeholders}}. Unknown placeholders are left as-is rather
 *  than blanked, so a typo in a template is visible instead of silently
 *  producing an empty line in a message to a factory. */
function fill(text, values) {
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(values, key) && values[key] !== null && values[key] !== undefined
      ? String(values[key])
      : match
  ));
}

/** Render one side ('en' | 'zh') of a template against a value bag. */
function render(template, lang, values) {
  const side = (template && template[lang === 'en' ? 'en' : 'zh']) || { subject: '', body: '' };
  return { subject: fill(side.subject, values), body: fill(side.body, values) };
}

module.exports = {
  BILINGUAL_PO_KEY, ensureBilingualDefault, getDefaultTemplate,
  PLACEHOLDERS, listTemplates, getTemplate, createTemplate, updateTemplate,
  deleteTemplate, render, fill, TEMPLATES_PATH
};
