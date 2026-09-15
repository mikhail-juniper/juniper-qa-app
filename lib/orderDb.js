/**
 * SQLite storage for order records.
 *
 * WHY THIS EXISTS
 * The previous store kept every order in one JSON file, read whole and
 * rewritten whole on every operation. Measured with realistically-shaped
 * records, 4,700 orders is a 45MB file: ~386ms to parse, ~241ms to write, so
 * ~627ms for a single edit - and because Node is single-threaded, that blocks
 * every other request. Order Management calls the loader in 22 places, so one
 * page view could stack several full parses.
 *
 * WHAT CHANGED, AND WHAT DIDN'T
 * The record shape is untouched. Each order is a row whose `data` column holds
 * exactly the JSON object the rest of the app already passes around, so
 * hydrateOrder, normalizeAccessory, toQaShape, the doc-slot matching and every
 * caller keep working unmodified. The extra columns exist only so lookups and
 * filters happen in SQL instead of by loading everything and calling .find().
 *
 * better-sqlite3 is deliberate: its API is synchronous, so none of those 22
 * call sites (nor anything upstream in server.js) had to become async.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

let db = null;
let dbPath = null;

function init(dataDir) {
  if (db) return db;
  fs.mkdirSync(dataDir, { recursive: true });
  dbPath = path.join(dataDir, 'orderManagement.db');
  db = new Database(dbPath);

  /* WAL gives us concurrent reads during a write and far better write
   * throughput. It also creates -wal and -shm sidecar files, which matters for
   * the weekly backup - see checkpoint() below. */
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id            TEXT PRIMARY KEY,
      po_number     TEXT,
      sku           TEXT,
      product_line  TEXT,
      status        TEXT,
      supplier_name TEXT,
      created_at    TEXT,
      updated_at    TEXT,
      data          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_po      ON orders(po_number);
    CREATE INDEX IF NOT EXISTS idx_orders_sku     ON orders(sku);
    CREATE INDEX IF NOT EXISTS idx_orders_line    ON orders(product_line);
    CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
  `);
  return db;
}

/** The indexed columns are derived from the record, never set by callers, so
 *  they cannot drift out of step with what's in `data`. */
function columnsFor(entry) {
  const mc = entry.mainComponent || {};
  return {
    id: entry.id,
    po_number: entry.poNumber || null,
    sku: mc.sku || null,
    product_line: entry.productLine || null,
    status: entry.status || null,
    supplier_name: (entry.supplier && entry.supplier.name) || null,
    created_at: entry.createdAt || null,
    updated_at: entry.updatedAt || null,
    data: JSON.stringify(entry)
  };
}

const parse = (row) => (row ? JSON.parse(row.data) : null);

function count() {
  return db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
}

/** Every order. Still needed by list views and the financial rollups; the win
 *  is that the single-record paths below no longer go through here. */
function loadAll() {
  return db.prepare('SELECT data FROM orders ORDER BY created_at DESC').all().map(parse);
}

/**
 * Rows matching the indexed filters, newest first.
 *
 * Only productLine and status are pushed down; free-text search still filters
 * in JS because it spans fields inside the JSON blob. An unfiltered call still
 * parses every row - at 4,700 that is ~300ms. If the Order Management landing
 * page gets slow, pagination (LIMIT/OFFSET) is the next step, not more indexes.
 */
function query({ productLine, status } = {}) {
  const where = [];
  const args = [];
  if (productLine) { where.push('product_line = ?'); args.push(productLine); }
  if (status) { where.push('status = ?'); args.push(status); }
  const sql = 'SELECT data FROM orders'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...args).map(parse);
}

function getOne(id) {
  return parse(db.prepare('SELECT data FROM orders WHERE id = ?').get(id));
}

function findByPoNumber(poNumber, productLine) {
  const row = productLine
    ? db.prepare('SELECT data FROM orders WHERE po_number = ? AND product_line = ?').get(poNumber, productLine)
    : db.prepare('SELECT data FROM orders WHERE po_number = ?').get(poNumber);
  return parse(row);
}

function findBySku(sku) {
  return db.prepare('SELECT data FROM orders WHERE sku = ?').all(sku).map(parse);
}

const UPSERT = `
  INSERT INTO orders (id, po_number, sku, product_line, status, supplier_name, created_at, updated_at, data)
  VALUES (@id, @po_number, @sku, @product_line, @status, @supplier_name, @created_at, @updated_at, @data)
  ON CONFLICT(id) DO UPDATE SET
    po_number=excluded.po_number, sku=excluded.sku, product_line=excluded.product_line,
    status=excluded.status, supplier_name=excluded.supplier_name,
    created_at=excluded.created_at, updated_at=excluded.updated_at, data=excluded.data`;

/** One record in, one row written. This is the change that matters: a status
 *  edit used to rewrite 45MB. */
function saveOne(entry) {
  db.prepare(UPSERT).run(columnsFor(entry));
  return entry;
}

function deleteOne(id) {
  return db.prepare('DELETE FROM orders WHERE id = ?').run(id).changes > 0;
}

/** Wholesale replace, in one transaction. Only used by migration and by
 *  Restore-from-backup - never on a normal edit. */
function replaceAll(entries) {
  const stmt = db.prepare(UPSERT);
  const run = db.transaction((rows) => {
    db.prepare('DELETE FROM orders').run();
    rows.forEach((e) => stmt.run(columnsFor(e)));
  });
  run(entries);
  return entries.length;
}

/**
 * Fold the WAL back into the main .db file.
 *
 * The weekly backup zips the whole data directory. Copying a WAL-mode database
 * without checkpointing captures the .db without the pending -wal, which
 * restores as a database missing its most recent writes - or refuses to open.
 * That failure is invisible until someone actually needs the backup, so the
 * backup path calls this first.
 */
function checkpoint() {
  if (!db) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    console.error('SQLite checkpoint failed:', err.message || err);
  }
}

/**
 * One-time import from the old JSON file.
 *
 * Runs only when the table is empty, so it is safe on every boot. The JSON file
 * is deliberately left in place afterwards: it costs nothing and it is the
 * rollback if anything about the cutover turns out to be wrong.
 */
function migrateFromJson(jsonPath, hydrate) {
  if (count() > 0) return { migrated: 0, reason: 'database already populated' };
  if (!fs.existsSync(jsonPath)) return { migrated: 0, reason: 'no JSON file to import' };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    console.error('Could not parse the existing orderManagement.json - leaving it alone:', err.message || err);
    return { migrated: 0, reason: 'unreadable JSON' };
  }
  if (!Array.isArray(raw) || !raw.length) return { migrated: 0, reason: 'JSON file is empty' };
  const entries = raw.map((e) => (hydrate ? hydrate(e) : e));
  const n = replaceAll(entries);
  return { migrated: n, reason: null };
}

module.exports = {
  init, count, loadAll, query, getOne, findByPoNumber, findBySku,
  saveOne, deleteOne, replaceAll, checkpoint, migrateFromJson,
  get path() { return dbPath; }
};
