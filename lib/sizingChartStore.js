/**
 * Persistent store for sizing charts - standards that live independently of
 * any single PO (unlike Products/Components, which are just derived views
 * over existing order data). Mirrors QingFlow's "Size chart" basic-info app.
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./submissionLog');

const CHARTS_PATH = path.join(DATA_DIR, 'sizingCharts.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  ensureDir();
  if (!fs.existsSync(CHARTS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(CHARTS_PATH, 'utf8'));
  } catch (err) {
    console.error('Failed to parse sizing chart store - starting fresh. Original error:', err);
    return [];
  }
}

function saveAll(entries) {
  ensureDir();
  fs.writeFileSync(CHARTS_PATH, JSON.stringify(entries, null, 2));
}

function listCharts() {
  return loadAll().sort((a, b) => a.name.localeCompare(b.name));
}

function getChart(id) {
  return loadAll().find((c) => c.id === id) || null;
}

function createChart(data) {
  const entries = loadAll();
  const now = new Date().toISOString();
  const entry = {
    id: data.id,
    name: data.name || 'Untitled sizing chart',
    productLine: data.productLine || 'toys',
    notes: data.notes || '',
    sizes: Array.isArray(data.sizes) ? data.sizes : [],
    createdAt: now,
    updatedAt: now
  };
  entries.push(entry);
  saveAll(entries);
  return entry;
}

function updateChart(id, patch) {
  const entries = loadAll();
  const idx = entries.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  entries[idx] = { ...entries[idx], ...patch, updatedAt: new Date().toISOString() };
  saveAll(entries);
  return entries[idx];
}

function deleteChart(id) {
  const entries = loadAll();
  const next = entries.filter((c) => c.id !== id);
  saveAll(next);
  return next.length !== entries.length;
}

module.exports = { listCharts, getChart, createChart, updateChart, deleteChart };
