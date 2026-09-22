/**
 * A reusable SQLite row store, for the stores that grow per purchase order.
 *
 * WHY THIS EXISTS
 * Orders moved to SQLite (lib/orderDb.js) because a single JSON file read and
 * rewritten on every operation does not survive a 4,700-PO history. Three other
 * stores have the same shape and the same problem. Measured with realistic
 * records at that history:
 *
 *   approvalStore             4,700 records   44.1 MB   562 ms per edit
 *   componentDefinitionStore 18,800 records    9.8 MB    88 ms per edit
 *   submissionLog             9,400 records    8.3 MB    59 ms per edit
 *
 * approvalStore is the urgent one - marginally worse than orders were, because
 * each PO carries three approval stages with comment threads.
 *
 * WHAT THIS IS NOT
 * Not a relational decomposition. Each record is one row whose `data` column
 * holds exactly the object the rest of the app already passes around, so the
 * normalising and hydrating functions in each store keep working untouched.
 * The extra columns exist only so lookups happen in SQL rather than by loading
 * everything and calling .find().
 *
 * better-sqlite3 is synchronous, which is what lets these stores keep their
 * existing synchronous API instead of every caller becoming async.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/**
 * @param opts.dataDir   where the .db lives (the persistent disk)
 * @param opts.file      database filename
 * @param opts.table     table name
 * @param opts.idOf      record -> primary key
 * @param opts.columns   { columnName: record => value } indexed lookup columns
 * @param opts.legacyPath  JSON file to import once, then keep as a rollback
 */
function createRowStore(opts) {
  const { dataDir, file, table, idOf, columns = {}, legacyPath } = opts;
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, file);
  const db = new Database(dbPath);

  /* WAL for concurrent reads during a write. It creates -wal and -shm sidecar
   * files, which is why checkpoint() exists and why the backup calls it.
   *
   * This is also the first thing that touches the disk, so a full or
   * read-only volume surfaces here as a raw SqliteError with no indication of
   * what is actually wrong. Translate it: "database or disk is full" thrown
   * from a PRAGMA on an empty database is never a database problem. */
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  } catch (err) {
    if (err && err.code === 'SQLITE_FULL') {
      throw new Error(
        `Cannot open ${dbPath}: the disk is full.\n`
        + '  This is the persistent disk holding DATA_DIR, not a database fault.\n'
        + '  Free space or grow the volume, then redeploy. Likely consumers:\n'
        + '    - scheduled-backups/ (weekly zips of the whole data directory)\n'
        + '    - submissions/ and issue-photos/ (report PDFs and evidence)\n'
        + '    - the legacy *.json files kept as migration rollbacks\n'
        + `  Original error: ${err.message}`
      );
    }
    if (err && (err.code === 'SQLITE_READONLY' || err.code === 'SQLITE_CANTOPEN')) {
      throw new Error(
        `Cannot open ${dbPath}: the path is not writable.\n`
        + '  Check DATA_DIR points at the mounted persistent disk.\n'
        + `  Original error: ${err.message}`
      );
    }
    throw err;
  }

  const colNames = Object.keys(columns);
  const colDefs = colNames.map((c) => `${c} TEXT`).join(', ');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY${colDefs ? ', ' + colDefs : ''}, data TEXT NOT NULL
    );
    ${colNames.map((c) => `CREATE INDEX IF NOT EXISTS idx_${table}_${c} ON ${table}(${c});`).join('\n')}
  `);

  const allCols = ['id', ...colNames, 'data'];
  const UPSERT = `
    INSERT INTO ${table} (${allCols.join(', ')})
    VALUES (${allCols.map((c) => '@' + c).join(', ')})
    ON CONFLICT(id) DO UPDATE SET
      ${[...colNames, 'data'].map((c) => `${c}=excluded.${c}`).join(', ')}`;

  const rowFor = (record) => {
    const row = { id: String(idOf(record)), data: JSON.stringify(record) };
    colNames.forEach((c) => {
      const v = columns[c](record);
      row[c] = v === undefined || v === null ? null : String(v);
    });
    return row;
  };

  const parse = (r) => (r ? JSON.parse(r.data) : null);
  const stmtUpsert = db.prepare(UPSERT);

  const api = {
    count: () => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
    all: () => db.prepare(`SELECT data FROM ${table}`).all().map(parse),
    get: (id) => parse(db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(String(id))),

    /** Rows matching one indexed column - the whole point of the columns map. */
    findBy: (column, value) => {
      if (!colNames.includes(column)) throw new Error(`${column} is not an indexed column on ${table}`);
      return db.prepare(`SELECT data FROM ${table} WHERE ${column} = ?`).all(String(value)).map(parse);
    },

    /** One record in, one row written. The change that matters. */
    save: (record) => { stmtUpsert.run(rowFor(record)); return record; },

    remove: (id) => db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(String(id)).changes > 0,

    /** Wholesale replace in one transaction - migration and restore only. */
    replaceAll: (records) => {
      const run = db.transaction((rows) => {
        db.prepare(`DELETE FROM ${table}`).run();
        rows.forEach((r) => stmtUpsert.run(rowFor(r)));
      });
      run(records);
      return records.length;
    },

    /* Fold the WAL into the .db file. A backup that copies a live WAL database
     * without this restores short of recent writes, or refuses to open - and
     * that only surfaces when someone actually needs the backup. */
    checkpoint: () => {
      try { db.pragma('wal_checkpoint(TRUNCATE)'); }
      catch (err) { console.error(`SQLite checkpoint failed for ${table}:`, err.message || err); }
    },

    path: dbPath
  };

  /* One-time import from the old flat file. No-ops once the table has rows, so
   * it is safe on every boot, and the JSON is left in place as the rollback.
   *
   * Called explicitly by each store AFTER its module finishes loading, never at
   * require time: hydrating functions read constants declared further down
   * their own modules, and running this too early throws a temporal-dead-zone
   * error that a surrounding catch would swallow - leaving the app up and the
   * table empty. That has happened before. */
  api.migrateOnce = (hydrate) => {
    if (api.count() > 0) return { migrated: 0, reason: 'already populated' };
    if (!legacyPath || !fs.existsSync(legacyPath)) return { migrated: 0, reason: 'no legacy file' };
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    } catch (err) {
      console.error(`Could not parse ${legacyPath}, leaving it alone:`, err.message || err);
      return { migrated: 0, reason: 'unreadable' };
    }
    if (!Array.isArray(raw) || !raw.length) return { migrated: 0, reason: 'empty' };
    const n = api.replaceAll(hydrate ? raw.map(hydrate) : raw);
    console.log(`Imported ${n} record(s) from ${path.basename(legacyPath)} into ${table}. `
      + 'The JSON file has been left in place as a rollback copy.');
    return { migrated: n, reason: null };
  };

  return api;
}

module.exports = { createRowStore };
