/**
 * db.js — SQLite database layer using sql.js (WebAssembly SQLite)
 *
 * Responsibilities:
 *  1. Initialize the sql.js engine and create (or restore) the SQLite database.
 *  2. Expose CRUD helpers: insertPatient, getAllPatients, deletePatient.
 *  3. Persist the in-memory SQLite database to IndexedDB after every write
 *     so data survives page reloads and browser restarts.
 *  4. Restore the database from IndexedDB on startup.
 */

// ─── IndexedDB constants ───────────────────────────────────────────────────
const IDB_NAME    = 'PatientPWA';   // IndexedDB database name
const IDB_VERSION = 1;              // database version
const IDB_STORE   = 'sqliteStore';  // object store name
const IDB_KEY     = 'db';          // the single key we use to store the blob

// ─── Module-level state ────────────────────────────────────────────────────
let _db  = null;   // the sql.js Database instance (in-memory SQLite)
let _SQL = null;   // the sql.js module (needed to create new DB instances)

// ─── IndexedDB helpers ────────────────────────────────────────────────────

/**
 * Opens (or creates) the IndexedDB database and returns a Promise<IDBDatabase>.
 */
function openIDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);

    // Create object store on first run or version upgrade
    request.onupgradeneeded = (event) => {
      const idb = event.target.result;
      if (!idb.objectStoreNames.contains(IDB_STORE)) {
        idb.createObjectStore(IDB_STORE);
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror   = (event) => reject(event.target.error);
  });
}

/**
 * Saves a Uint8Array (the serialised SQLite file) into IndexedDB.
 * @param {Uint8Array} data
 */
async function saveToIDB(data) {
  const idb = await openIDB();
  return new Promise((resolve, reject) => {
    const tx      = idb.transaction(IDB_STORE, 'readwrite');
    const store   = tx.objectStore(IDB_STORE);
    const request = store.put(data, IDB_KEY);
    request.onsuccess = () => resolve();
    request.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * Loads the SQLite blob from IndexedDB.
 * Returns a Uint8Array if found, or null if no data has been saved yet.
 * @returns {Promise<Uint8Array|null>}
 */
async function loadFromIDB() {
  const idb = await openIDB();
  return new Promise((resolve, reject) => {
    const tx      = idb.transaction(IDB_STORE, 'readonly');
    const store   = tx.objectStore(IDB_STORE);
    const request = store.get(IDB_KEY);
    request.onsuccess = (e) => resolve(e.target.result || null);
    request.onerror   = (e) => reject(e.target.error);
  });
}

// ─── SQLite schema ────────────────────────────────────────────────────────

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS patients (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT    NOT NULL,
    age     INTEGER NOT NULL,
    sex     TEXT    NOT NULL,
    address TEXT    NOT NULL,
    phone   TEXT    NOT NULL
  );
`;

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Initialises sql.js and the SQLite database.
 * Must be awaited before calling any other db function.
 *
 * Flow:
 *  1. Load the sql.js WASM module.
 *  2. Try to restore a previously saved database from IndexedDB.
 *  3. If none exists, create a fresh in-memory database.
 *  4. Ensure the "patients" table exists.
 */
async function initDB() {
  // 1. Boot the sql.js WASM engine.
  //    locateFile tells sql.js where to find the .wasm binary (same CDN).
  _SQL = await initSqlJs({
    locateFile: (filename) =>
      `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${filename}`
  });

  // 2. Attempt to restore from IndexedDB.
  const savedData = await loadFromIDB();

  if (savedData) {
    // Restore the full database from the saved binary blob.
    _db = new _SQL.Database(savedData);
    console.log('[DB] Restored database from IndexedDB.');
  } else {
    // First run: create a brand-new in-memory database.
    _db = new _SQL.Database();
    console.log('[DB] Created new in-memory database.');
  }

  // 3. Ensure the patients table exists (idempotent).
  _db.run(CREATE_TABLE_SQL);

  // 4. Persist the fresh schema immediately so the next load can restore it.
  await _persistDB();
}

/**
 * Serialises the in-memory SQLite database and saves it to IndexedDB.
 * Called internally after every write operation.
 */
async function _persistDB() {
  if (!_db) return;
  const data = _db.export(); // returns Uint8Array — the raw SQLite file bytes
  await saveToIDB(data);
}

/**
 * Inserts a new patient record.
 * @param {{ name: string, age: number, sex: string, address: string, phone: string }} patient
 * @returns {Promise<number>} The auto-generated row ID.
 */
async function insertPatient({ name, age, sex, address, phone }) {
  _db.run(
    `INSERT INTO patients (name, age, sex, address, phone)
     VALUES (?, ?, ?, ?, ?);`,
    [name, age, sex, address, phone]
  );

  // Retrieve the rowid of the last inserted row
  const result = _db.exec('SELECT last_insert_rowid() AS id;');
  const id     = result[0].values[0][0];

  // Persist the updated database to IndexedDB
  await _persistDB();

  console.log(`[DB] Inserted patient id=${id}`);
  return id;
}

/**
 * Returns all patient records, newest first.
 * @param {string} [searchTerm=''] Optional search filter applied to name and phone.
 * @returns {{ id, name, age, sex, address, phone }[]}
 */
function getAllPatients(searchTerm = '') {
  let sql    = 'SELECT * FROM patients';
  const params = [];

  if (searchTerm.trim()) {
    // Case-insensitive partial match on name or phone
    sql += ` WHERE name LIKE ? OR phone LIKE ?`;
    const like = `%${searchTerm.trim()}%`;
    params.push(like, like);
  }

  sql += ' ORDER BY id DESC;';

  const results = _db.exec(sql, params);

  if (!results.length) return [];   // table is empty or no match

  const { columns, values } = results[0];

  // Map each row array to a named object
  return values.map((row) =>
    Object.fromEntries(columns.map((col, i) => [col, row[i]]))
  );
}

/**
 * Deletes a patient by their ID.
 * @param {number} id
 */
async function deletePatient(id) {
  _db.run('DELETE FROM patients WHERE id = ?;', [id]);
  await _persistDB();
  console.log(`[DB] Deleted patient id=${id}`);
}
