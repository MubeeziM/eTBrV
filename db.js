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

// ─── Silence verbose logs in production ───────────────────────────────────
// Mirrors the same guard in app.js — db.js may be loaded standalone in tests.
if (typeof location !== 'undefined' &&
    location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
  // eslint-disable-next-line no-console
  console.log = console.info = console.debug = () => {};
}

// ─── IndexedDB constants ───────────────────────────────────────────────────
let _idbName  = 'PatientPWA';   // IndexedDB database name — updated by setIDBUser() after login
const IDB_VERSION    = 2;              // database version
const IDB_STORE      = 'sqliteStore';  // object store name for SQLite blob
const IDB_AUTH_STORE = 'authStore';    // object store for offline PIN credential
const IDB_KEY     = 'db';          // the single key we use to store the blob

// ─── IndexedDB encryption ─────────────────────────────────────────────────
//
// Patient records are encrypted with AES-256-GCM before being written to
// IndexedDB and decrypted on read.  This prevents the data being visible
// to anyone who opens DevTools → Application → IndexedDB, or who copies
// the browser profile directory from a lost / stolen device.
//
// Key derivation
// ──────────────
//   PBKDF2 / SHA-256, 100 000 iterations.
//   password : userTID  (unique per user, read from art.user in localStorage)
//   salt     : deviceSalt (32-byte random, generated once per device and
//              stored in localStorage['art.deviceSalt']) concatenated with
//              the fixed string '|art-etbr-pwa-db-v1'.
//
//   Both inputs survive browser restarts so the key is re-derivable fully
//   offline.  The derived key is cached in sessionStorage for the lifetime
//   of the tab to avoid repeating the 100k-iteration derivation on every
//   database write.
//
// Encrypted blob format  (stored in sqliteStore under key 'db')
// ──────────────────────
//   Byte 0-1   : 0x01 0x01 — magic marker (distinguishes encrypted blobs
//                from legacy SQLite files, which start with "SQLite format 3")
//   Byte 2-13  : 12-byte random AES-GCM IV (nonce)
//   Byte 14+   : AES-GCM ciphertext (+ 16-byte GCM authentication tag)
//
// Backward compatibility
// ──────────────────────
//   Existing unencrypted blobs are detected by the SQLite magic header and
//   loaded as-is.  They are silently re-encrypted the next time the DB is
//   saved.  No manual migration step is needed.
//
// Security note
// ─────────────
//   This protects against an attacker who obtains ONLY the IndexedDB files.
//   An attacker with full device access (localStorage + IndexedDB) could
//   in principle re-derive the key.  Full protection against a compromised
//   device would require server-issued keys, which is incompatible with
//   offline operation.
// ──────────────────────────────────────────────────────────────────────────

const ENC_MAGIC      = new Uint8Array([0x01, 0x01]);
const ENC_MAGIC_LEN  = 2;
const ENC_IV_LEN     = 12;
const ENC_HEADER_LEN = ENC_MAGIC_LEN + ENC_IV_LEN;   // 14 bytes
const DB_KEY_SESSION = 'art.dbKey';                   // sessionStorage — cached key (hex)
const DEVICE_SALT_LS = 'art.deviceSalt';              // localStorage   — per-device salt (hex)

/** Return the hex-encoded per-device salt, generating it on first call. */
function _getOrCreateDeviceSalt() {
  let salt = localStorage.getItem(DEVICE_SALT_LS);
  if (!salt) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    salt = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(DEVICE_SALT_LS, salt);
  }
  return salt;
}

function _hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function _bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derives (or returns a cached) AES-GCM key for the current user.
 * Reads userTID from localStorage['art.user'] automatically.
 * Returns null if no userTID is available (e.g., before first login).
 * @returns {Promise<CryptoKey|null>}
 */
async function _getDbEncryptionKey() {
  // Check session cache — avoids re-running 100k PBKDF2 iterations per save
  const cached = sessionStorage.getItem(DB_KEY_SESSION);
  if (cached) {
    try {
      return await crypto.subtle.importKey(
        'raw', _hexToBytes(cached),
        { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
      );
    } catch { sessionStorage.removeItem(DB_KEY_SESSION); /* stale — re-derive */ }
  }

  // Read userTID from the stored user profile
  let userTID;
  try {
    const profile = JSON.parse(localStorage.getItem('art.user') || '{}');
    userTID = profile.userTID;
  } catch { /* ignore */ }
  if (!userTID) return null;

  const enc        = new TextEncoder();
  const deviceSalt = _getOrCreateDeviceSalt();
  const saltBytes  = enc.encode(deviceSalt + '|art-etbr-pwa-db-v1');

  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(userTID), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,   // extractable only so we can cache the raw bytes in sessionStorage
    ['encrypt', 'decrypt']
  );

  // Cache the raw bytes in sessionStorage for the tab lifetime
  const raw = await crypto.subtle.exportKey('raw', key);
  sessionStorage.setItem(DB_KEY_SESSION, _bytesToHex(new Uint8Array(raw)));

  // Return a non-extractable copy for actual use
  return crypto.subtle.importKey(
    'raw', new Uint8Array(raw),
    { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
  );
}

/** Returns true if the blob carries the encrypted-format header. */
function _isEncryptedBlob(data) {
  return data instanceof Uint8Array
      && data.length > ENC_HEADER_LEN
      && data[0] === ENC_MAGIC[0]
      && data[1] === ENC_MAGIC[1];
}

/** Encrypt a Uint8Array.  Returns the encrypted blob with header prepended. */
async function _encryptBlob(key, plaintext) {
  const iv        = crypto.getRandomValues(new Uint8Array(ENC_IV_LEN));
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const out       = new Uint8Array(ENC_HEADER_LEN + cipherBuf.byteLength);
  out.set(ENC_MAGIC, 0);
  out.set(iv, ENC_MAGIC_LEN);
  out.set(new Uint8Array(cipherBuf), ENC_HEADER_LEN);
  return out;
}

/** Decrypt a blob produced by _encryptBlob.  Returns the plaintext Uint8Array. */
async function _decryptBlob(key, data) {
  const iv         = data.slice(ENC_MAGIC_LEN, ENC_HEADER_LEN);
  const ciphertext = data.slice(ENC_HEADER_LEN);
  const plain      = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new Uint8Array(plain);
}

/**
 * Normalises a raw userName into a safe IDB name suffix.
 * If the value looks like an email address, only the local part (before '@') is used.
 * Characters outside [a-z0-9._-] are replaced with '_'.
 */
function _userNameToIdbSuffix(raw) {
  if (!raw) return '';
  const local = raw.includes('@') ? raw.split('@')[0] : raw;
  return local.toLowerCase().replace(/[^a-z0-9._-]/g, '_');
}

/**
 * Scopes the IndexedDB database to a specific user so that different accounts
 * on the same device each get their own physically separate database and
 * patient data can never mix across facilities on a shared device.
 * Must be called before initDB().
 *
 * @param {string} userName  Raw userName from the login response.
 */
function setIDBUser(userName) {
  const suffix = _userNameToIdbSuffix(userName);
  _idbName = suffix ? `PatientPWA_${suffix}` : 'PatientPWA';
  console.log(`[IDB] Database scoped to: ${_idbName}`);
}

// ─── Module-level state ────────────────────────────────────────────────────
let _db  = null;   // the sql.js Database instance (in-memory SQLite)
let _SQL = null;   // the sql.js module (needed to create new DB instances)

// ─── Utility helpers ──────────────────────────────────────────────────────

function generateGUID() { return crypto.randomUUID(); }

function normalizeGUID(value) {
  return typeof value === 'string' ? value.toLowerCase() : value;
}

function calcBMI(weightKg, heightCm) {
  if (!weightKg || !heightCm || heightCm === 0) return null;
  return Math.round((weightKg / Math.pow(heightCm / 100, 2)) * 10) / 10;
}

function calcVisitMonth(artStartDateStr, visitDateStr) {
  if (!artStartDateStr || !visitDateStr) return 0;
  const start = new Date(artStartDateStr);
  const visit = new Date(visitDateStr);
  return (visit.getFullYear() - start.getFullYear()) * 12 +
         (visit.getMonth() - start.getMonth());
}

function _now() { return new Date().toISOString(); }

// ─── IndexedDB helpers ────────────────────────────────────────────────────

/**
 * Opens (or creates) the IndexedDB database and returns a Promise<IDBDatabase>.
 */
function openIDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(_idbName, IDB_VERSION);
    console.log(`[IDB] opening '${_idbName}' v${IDB_VERSION}`);    // each user gets their own DB

    // Create object stores on first run or version upgrade
    request.onupgradeneeded = (event) => {
      console.log(`[IDB] onupgradeneeded: ${event.oldVersion} → ${event.newVersion}`);
      const idb = event.target.result;
      if (!idb.objectStoreNames.contains(IDB_STORE)) {
        idb.createObjectStore(IDB_STORE);
        console.log('[IDB] created store:', IDB_STORE);
      }
      if (!idb.objectStoreNames.contains(IDB_AUTH_STORE)) {
        idb.createObjectStore(IDB_AUTH_STORE);
        console.log('[IDB] created store:', IDB_AUTH_STORE);
      }
    };

    request.onblocked = (event) => {
      console.warn('[IDB] open blocked — old connection still open:', event);
    };

    request.onsuccess = (event) => {
      console.log('[IDB] opened OK, version:', event.target.result.version);
      resolve(event.target.result);
    };
    request.onerror   = (event) => {
      console.error('[IDB] open error:', event.target.error);
      reject(event.target.error);
    };
  });
}

/**
 * Saves a Uint8Array (the serialised SQLite file) into IndexedDB.
 * The data is encrypted with AES-256-GCM before storage.
 * If no encryption key is available (no logged-in user) the data is stored
 * as plaintext so the app can continue to function.
 * @param {Uint8Array} data
 */
async function saveToIDB(data) {
  let toStore = data;
  try {
    const key = await _getDbEncryptionKey();
    if (key) {
      toStore = await _encryptBlob(key, data);
    } else {
      console.warn('[IDB] No encryption key available — storing plaintext DB');
    }
  } catch (err) {
    console.error('[IDB] Encryption failed — storing plaintext DB:', err);
  }
  const idb = await openIDB();
  return new Promise((resolve, reject) => {
    const tx      = idb.transaction(IDB_STORE, 'readwrite');
    const store   = tx.objectStore(IDB_STORE);
    const request = store.put(toStore, IDB_KEY);
    request.onsuccess = () => resolve();
    request.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * Loads the SQLite blob from IndexedDB and decrypts it if necessary.
 * Handles three cases:
 *   1. Encrypted blob  — decrypt with the derived key.
 *   2. Legacy plaintext blob (SQLite magic header) — return as-is; the DB
 *      will be re-encrypted on the next _persistDB() call.
 *   3. Nothing stored  — return null (fresh install / new user).
 * @returns {Promise<Uint8Array|null>}
 */
async function loadFromIDB() {
  const idb = await openIDB();
  const raw = await new Promise((resolve, reject) => {
    const tx      = idb.transaction(IDB_STORE, 'readonly');
    const store   = tx.objectStore(IDB_STORE);
    const request = store.get(IDB_KEY);
    request.onsuccess = (e) => resolve(e.target.result || null);
    request.onerror   = (e) => reject(e.target.error);
  });

  if (!raw) return null;

  if (_isEncryptedBlob(raw)) {
    const key = await _getDbEncryptionKey();
    if (!key) {
      // No key available — cannot decrypt.  Return null so the app
      // re-initialises from server data on next sync rather than crashing.
      console.warn('[IDB] Encrypted blob found but no decryption key — DB will be re-synced from server');
      return null;
    }
    try {
      return await _decryptBlob(key, raw);
    } catch (err) {
      console.error('[IDB] Decryption failed (wrong key or corrupted data) — DB will be re-synced from server:', err);
      return null;
    }
  }

  // Legacy unencrypted blob — use as-is; will be re-encrypted on next save
  console.log('[IDB] Legacy unencrypted DB detected — will encrypt on next save');
  return raw;
}

// ─── Offline PIN helpers (IndexedDB authStore) ───────────────────────────

/**
 * Persists the offline PIN credential record.
 * @param {{ hash:string, salt:string, iterations:number, failCount:number, lockedUntil:number|null, userTID:string, userName:string }} data
 */
async function saveOfflinePin(data) {
  const idb = await openIDB();
  return new Promise((resolve, reject) => {
    const tx    = idb.transaction(IDB_AUTH_STORE, 'readwrite');
    const store = tx.objectStore(IDB_AUTH_STORE);
    const req   = store.put(data, 'offlinePin');
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * Loads the offline PIN credential record, or null if not set.
 * @returns {Promise<{hash:string, salt:string, iterations:number, failCount:number, lockedUntil:number|null, userTID:string, userName:string}|null>}
 */
async function loadOfflinePin() {
  console.log('[PIN] loadOfflinePin: opening IDB...');
  const idb = await openIDB();
  return new Promise((resolve, reject) => {
    const tx    = idb.transaction(IDB_AUTH_STORE, 'readonly');
    const store = tx.objectStore(IDB_AUTH_STORE);
    const req   = store.get('offlinePin');
    req.onsuccess = (e) => {
      console.log('[PIN] loadOfflinePin result:', e.target.result ?? null);
      resolve(e.target.result ?? null);
    };
    req.onerror   = (e) => {
      console.error('[PIN] loadOfflinePin error:', e.target.error);
      reject(e.target.error);
    };
  });
}

/** Removes the offline PIN credential from IndexedDB. */
async function clearOfflinePin() {
  const idb = await openIDB();
  return new Promise((resolve, reject) => {
    const tx    = idb.transaction(IDB_AUTH_STORE, 'readwrite');
    const store = tx.objectStore(IDB_AUTH_STORE);
    const req   = store.delete('offlinePin');
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

// ─── SQLite schema ────────────────────────────────────────────────────────

const CREATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS SexT (SexID INTEGER PRIMARY KEY, Sex TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS OccupationT (OccupationID INTEGER PRIMARY KEY, Occupation TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS KeyPopuT (KeyPopuID INTEGER PRIMARY KEY, KeyPopu TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS WHOStageT (WHOStageID INTEGER PRIMARY KEY, WHOStage TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS BreastfeedingT (BreastfeedingID INTEGER PRIMARY KEY, Breastfeeding TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS CPTDrugT (CPTDrugID INTEGER PRIMARY KEY, CPTDrug TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS RegimenCategoryT (RegimenCategoryID INTEGER PRIMARY KEY, RegimenCategory TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS RegimenARTT (
    RegimenID INTEGER PRIMARY KEY, RegimenCode TEXT NOT NULL,
    Regimen TEXT NOT NULL, RegimenCategoryID INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS RegimenChangeReasonT (RegimenChangeReasonID INTEGER PRIMARY KEY, RegimenChangeReason TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS FollowUpStatusT (FollowUpStatusID INTEGER PRIMARY KEY, FollowUpStatus TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS TBStatusT (TBStatusID INTEGER PRIMARY KEY, TBStatus TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS StopReasonT (StopReasonID INTEGER PRIMARY KEY, StopReason TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS StateT (StateID INTEGER PRIMARY KEY, State TEXT NOT NULL DEFAULT '', StateShort TEXT DEFAULT '');
  CREATE TABLE IF NOT EXISTS CountyT (CountyID INTEGER PRIMARY KEY, County TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS HealthFacilityT (HealthFacilityID INTEGER PRIMARY KEY, HealthFacility TEXT NOT NULL DEFAULT '', CountyID INTEGER NOT NULL DEFAULT 0, StateID INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS DataSourceT (DataSourceID INTEGER PRIMARY KEY, DataSource TEXT NOT NULL, HealthFacilityID INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS UsersT (UserTID TEXT PRIMARY KEY, UserName TEXT NOT NULL);
  CREATE VIEW IF NOT EXISTS vwGeogAreaQ AS
    SELECT hf.HealthFacilityID,
           hf.HealthFacility,
           hf.CountyID,
           COALESCE(c.County, '')        AS County,
           hf.StateID,
           COALESCE(s.State,  '')        AS State,
           COALESCE(s.StateShort, '')    AS StateShort
    FROM   HealthFacilityT hf
    LEFT JOIN CountyT c ON hf.CountyID = c.CountyID
    LEFT JOIN StateT  s ON hf.StateID  = s.StateID
    WHERE  hf.HealthFacilityID > 0;

  CREATE TABLE IF NOT EXISTS PtDetailsARTT (
    PtDetailsTID         TEXT PRIMARY KEY,
    PatientID            INTEGER,
    NearestHFID          INTEGER NOT NULL DEFAULT 0,
    DataSourceID         INTEGER NOT NULL DEFAULT 0,
    CountyID             INTEGER NOT NULL DEFAULT 0,
    EnteredByID          TEXT    NOT NULL DEFAULT '',
    HasChanged           INTEGER NOT NULL DEFAULT 1,
    LastModOn            TEXT    NOT NULL DEFAULT '',
    CreatedOn            TEXT    NOT NULL DEFAULT '',
    Deleted              INTEGER NOT NULL DEFAULT 0,
    HIVRetest            INTEGER NOT NULL DEFAULT 0,
    ARTNo                TEXT    NOT NULL DEFAULT '',
    ARTStartDate         TEXT,
    DateEnrolledInCare   TEXT,
    PtName               TEXT    NOT NULL DEFAULT '',
    ResidenceAddress     TEXT,
    Phone1               TEXT,
    Phone2               TEXT,
    OccupationID         INTEGER NOT NULL DEFAULT 0,
    OccupationOther      TEXT,
    KeyPopuID            INTEGER NOT NULL DEFAULT 0,
    KeyPopuOther         TEXT,
    Age                  INTEGER NOT NULL DEFAULT 0,
    DateOfBirth          TEXT,
    SexID                INTEGER NOT NULL DEFAULT 0,
    WeightKg             REAL,
    HeightCm             REAL,
    MUACCm               REAL,
    BMI                  REAL,
    WHOStageID           INTEGER NOT NULL DEFAULT 0,
    CD4Value             REAL,
    CD4IsPercent         INTEGER NOT NULL DEFAULT 0,
    CPTStartDate         TEXT,
    CPTDrugID            INTEGER NOT NULL DEFAULT 0,
    TBRxStartDate        TEXT,
    UnitTBNo             TEXT,
    TBStatusID           INTEGER NOT NULL DEFAULT 0,
    BreastfeedingID      INTEGER NOT NULL DEFAULT 0,
    IsTransferIn         INTEGER NOT NULL DEFAULT 0,
    TransferFromFacility TEXT,
    GuardianName         TEXT,
    GuardianPhone1       TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS UQ_PtDetailsARTT_ARTNo ON PtDetailsARTT (ARTNo);

  CREATE TABLE IF NOT EXISTS INHProphylaxisT (
    INHProphylaxisTID TEXT PRIMARY KEY,
    PtDetailsTID      TEXT NOT NULL,
    SequenceNo        INTEGER NOT NULL DEFAULT 0,
    INHDate           TEXT,
    EnteredByID       TEXT NOT NULL DEFAULT '',
    HasChanged        INTEGER NOT NULL DEFAULT 1,
    LastModOn         TEXT NOT NULL DEFAULT '',
    CreatedOn         TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS IDX_INHProphylaxisT_PtID ON INHProphylaxisT (PtDetailsTID);

  CREATE TABLE IF NOT EXISTS PMTCTPregnancyT (
    PMTCTPregnancyTID  TEXT PRIMARY KEY,
    PtDetailsTID       TEXT NOT NULL,
    PregnancyNo        INTEGER NOT NULL DEFAULT 0,
    ANCNo              TEXT,
    DeliveryDate       TEXT,
    MotherReceivedART  INTEGER NOT NULL DEFAULT 0,
    InfantReceivedARVs INTEGER NOT NULL DEFAULT 0,
    EnteredByID        TEXT NOT NULL DEFAULT '',
    HasChanged         INTEGER NOT NULL DEFAULT 1,
    LastModOn          TEXT NOT NULL DEFAULT '',
    CreatedOn          TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS IDX_PMTCTPregnancyT_PtID ON PMTCTPregnancyT (PtDetailsTID);

  CREATE TABLE IF NOT EXISTS RegimenHistoryT (
    RegimenHistoryTID TEXT PRIMARY KEY,
    PtDetailsTID      TEXT NOT NULL,
    RegimenLine       INTEGER NOT NULL DEFAULT 0,
    SequenceNo        INTEGER NOT NULL DEFAULT 0,
    RegimenID         INTEGER NOT NULL DEFAULT 0,
    ChangeReasonID    INTEGER NOT NULL DEFAULT 0,
    OtherReasonText   TEXT,
    EventDate         TEXT,
    EnteredByID       TEXT NOT NULL DEFAULT '',
    HasChanged        INTEGER NOT NULL DEFAULT 1,
    LastModOn         TEXT NOT NULL DEFAULT '',
    CreatedOn         TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS IDX_RegimenHistoryT_PtID ON RegimenHistoryT (PtDetailsTID);

  CREATE TABLE IF NOT EXISTS PtFollowUpARTT (
    PtFollowUpTID    TEXT PRIMARY KEY,
    PtDetailsTID     TEXT NOT NULL,
    VisitDate        TEXT,
    VisitMonth       INTEGER NOT NULL DEFAULT 0,
    FollowUpStatusID INTEGER NOT NULL DEFAULT 0,
    RegimenID        INTEGER NOT NULL DEFAULT 0,
    TBStatusID       INTEGER NOT NULL DEFAULT 0,
    StopReasonID     INTEGER NOT NULL DEFAULT 0,
    StopOtherText    TEXT,
    WeeksInterrupted INTEGER NOT NULL DEFAULT 0,
    WeightKg         REAL,
    HeightCm         REAL,
    BMI              REAL,
    CPTDrugID        INTEGER NOT NULL DEFAULT 0,
    CD4Value         REAL,
    CD4IsPercent     INTEGER NOT NULL DEFAULT 0,
    ViralLoad        INTEGER DEFAULT 0,
    Notes            TEXT,
    EnteredByID      TEXT NOT NULL DEFAULT '',
    HasChanged       INTEGER NOT NULL DEFAULT 1,
    LastModOn        TEXT NOT NULL DEFAULT '',
    CreatedOn        TEXT NOT NULL DEFAULT '',
    Deleted          INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS IDX_PtFollowUpARTT_PtID ON PtFollowUpARTT (PtDetailsTID);

  -- ── TB Register lookup tables ──────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS SputumResultT (SputumResultID INTEGER PRIMARY KEY, SputumResult TEXT, OrderBy INTEGER);
  CREATE TABLE IF NOT EXISTS DiagMethodT   (DiagMethodID   INTEGER PRIMARY KEY, DiagMethod TEXT, OrderID INTEGER);
  CREATE TABLE IF NOT EXISTS XpertResultT  (XpertResultID  INTEGER PRIMARY KEY, XpertResult TEXT, FullXpertResult TEXT);
  CREATE TABLE IF NOT EXISTS HIVResultT    (HIVResultID    INTEGER PRIMARY KEY, HIVResult TEXT, OrderBy INTEGER);
  CREATE TABLE IF NOT EXISTS TbTypeT       (TbTypeID       INTEGER PRIMARY KEY, TbType TEXT);
  CREATE TABLE IF NOT EXISTS PtTypeT       (PtTypeID       INTEGER PRIMARY KEY, PtType TEXT, PtTypeShort TEXT);
  CREATE TABLE IF NOT EXISTS OutcomeT      (OutcomeID      INTEGER PRIMARY KEY, Outcome TEXT);
  CREATE TABLE IF NOT EXISTS RegimenT      (RegimenID      INTEGER PRIMARY KEY, Regimen TEXT, OrderByID INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS ReferredByT   (ReferredByID   INTEGER PRIMARY KEY, ReferredBy TEXT);
  CREATE TABLE IF NOT EXISTS MonthT        (MonthID        INTEGER PRIMARY KEY, MonthName TEXT);
  CREATE TABLE IF NOT EXISTS YearT         (YearID         INTEGER PRIMARY KEY, YearName INTEGER);

  -- ── TB Register main tables ────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS PtDetailsT (
    PtDetailsTID    TEXT PRIMARY KEY,
    PatientID       INTEGER,
    NearestHFID     INTEGER NOT NULL DEFAULT 0,
    DataSourceID    INTEGER NOT NULL DEFAULT 0,
    CountyID        INTEGER NOT NULL DEFAULT 0,
    EnteredByID     TEXT,
    HasChanged      INTEGER NOT NULL DEFAULT 1,
    Deleted         INTEGER NOT NULL DEFAULT 0,
    LastModOn       TEXT    NOT NULL DEFAULT '',
    CreatedOn       TEXT    NOT NULL DEFAULT '',
    RegDate         TEXT,
    UnitTBNo        TEXT,
    PtName          TEXT    NOT NULL DEFAULT '',
    DateOfBirth     TEXT,
    Age             INTEGER NOT NULL DEFAULT 0,
    AgeMonths       INTEGER,
    SexID           INTEGER NOT NULL DEFAULT 0,
    ReferredByID    INTEGER NOT NULL DEFAULT 0,
    Village         TEXT,
    Boma            TEXT,
    Payam           TEXT,
    County          TEXT,
    PtPhone         TEXT,
    TbTypeID        INTEGER NOT NULL DEFAULT 0,
    PtTypeID        INTEGER NOT NULL DEFAULT 0,
    TIHF            TEXT,
    TICounty        TEXT,
    DateRxStarted   TEXT,
    RegimenID       INTEGER NOT NULL DEFAULT 0,
    DiagMethodID    INTEGER NOT NULL DEFAULT 0,
    CountryID       INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS IX_PtDetailsT_PtName      ON PtDetailsT(PtName);
  CREATE INDEX IF NOT EXISTS IX_PtDetailsT_HasChanged  ON PtDetailsT(HasChanged);
  CREATE INDEX IF NOT EXISTS IX_PtDetailsT_NearestHFID ON PtDetailsT(NearestHFID);

  CREATE TABLE IF NOT EXISTS PtFollowUpT (
    PtFollowUpTID       TEXT PRIMARY KEY,
    PtFollowUpID        INTEGER,
    PtDetailsTID        TEXT NOT NULL,
    HasChanged          INTEGER NOT NULL DEFAULT 1,
    Deleted             INTEGER NOT NULL DEFAULT 0,
    LastModOn           TEXT    NOT NULL DEFAULT '',
    CreatedOn           TEXT    NOT NULL DEFAULT '',
    EnteredByID         TEXT,
    Mon0Date            TEXT,
    Mon0LabNo           TEXT,
    Mon0LabResultID     INTEGER NOT NULL DEFAULT 0,
    Mon0XpertResultID   INTEGER NOT NULL DEFAULT 0,
    Mon0XpertResultDate TEXT,
    HIVTestDate         TEXT,
    HIVTestResultID     INTEGER NOT NULL DEFAULT 0,
    DSTResult           TEXT,
    Mon2Date            TEXT,
    Mon2LabNo           TEXT,
    Mon2LabResultID     INTEGER NOT NULL DEFAULT 0,
    Mon3Date            TEXT,
    Mon3LabNo           TEXT,
    Mon3LabResultID     INTEGER NOT NULL DEFAULT 0,
    Mon5Date            TEXT,
    Mon5LabNo           TEXT,
    Mon5LabResultID     INTEGER NOT NULL DEFAULT 0,
    Mon6Date            TEXT,
    Mon6LabNo           TEXT,
    Mon6LabResultID     INTEGER NOT NULL DEFAULT 0,
    OutcomeID           INTEGER NOT NULL DEFAULT 0,
    OutcomeDate         TEXT,
    TOHF                TEXT,
    TOCounty            TEXT,
    OnART               INTEGER NOT NULL DEFAULT 0,
    ARTDate             TEXT,
    OnCPT               INTEGER NOT NULL DEFAULT 0,
    CPTDate             TEXT,
    MovedTo2ndLine      INTEGER NOT NULL DEFAULT 0,
    Remarks             TEXT
  );
  CREATE INDEX IF NOT EXISTS IX_PtFollowUpT_PtDetailsTID ON PtFollowUpT(PtDetailsTID);
  CREATE INDEX IF NOT EXISTS IX_PtFollowUpT_HasChanged   ON PtFollowUpT(HasChanged);

  CREATE TABLE IF NOT EXISTS PresumptiveCaseT (
    PresumptiveCaseTID TEXT PRIMARY KEY,
    PresumptiveCaseID  INTEGER,
    PresumptiveCase    INTEGER,
    MonthID            INTEGER,
    YearID             INTEGER,
    NearestHFID        INTEGER NOT NULL DEFAULT 0,
    DataSourceID       INTEGER NOT NULL DEFAULT 0,
    CountyID           INTEGER NOT NULL DEFAULT 0,
    LocationID         INTEGER DEFAULT 0,
    SubRecID           INTEGER DEFAULT 0,
    HasChanged         INTEGER NOT NULL DEFAULT 1,
    Uploaded           INTEGER NOT NULL DEFAULT 0,
    Imported           INTEGER NOT NULL DEFAULT 0,
    LastModOn          TEXT    NOT NULL DEFAULT '',
    EnteredByID        TEXT
  );
  CREATE INDEX IF NOT EXISTS IX_PresumptiveCaseT_HF ON PresumptiveCaseT(NearestHFID, YearID, MonthID);

  -- Offline audit log: every patient-data change and export is recorded here
  -- and pushed to the server's LogT table on the next successful sync.
  CREATE TABLE IF NOT EXISTS AuditLogT (
    AuditLogID   INTEGER PRIMARY KEY AUTOINCREMENT,
    LoggedOn     TEXT    NOT NULL,
    Action       TEXT    NOT NULL DEFAULT '',
    PtDetailsTID TEXT,
    Notes        TEXT    NOT NULL DEFAULT '',
    UserTID      TEXT,
    UserName     TEXT,
    Synced       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS IX_AuditLogT_Synced   ON AuditLogT(Synced);
  CREATE INDEX IF NOT EXISTS IX_AuditLogT_LoggedOn ON AuditLogT(LoggedOn DESC)
`;

const SEED_SQL = `
  INSERT OR IGNORE INTO SexT VALUES (0,'Not recorded'),(1,'Male'),(2,'Female');
  INSERT OR IGNORE INTO OccupationT VALUES
    (0,'Not recorded'),(1,'Unemployed'),(2,'Student'),(3,'Housewife'),
    (4,'Salaried Employee'),(5,'Military personnel'),
    (6,'Other Uniformed forces (Police, Prisons, Wildlife, Fire Brigade etc.)'),
    (7,'Business'),(8,'Farmer'),(9,'Other (specify)');
  INSERT OR IGNORE INTO KeyPopuT VALUES
    (0,'Not recorded'),(1,'FSW'),(2,'MSM'),(3,'IDU'),
    (4,'Other (Specify)'),(5,'N/A - Not applicable');
  INSERT OR IGNORE INTO WHOStageT VALUES
    (0,'Not recorded'),(1,'Stage I'),(2,'Stage II'),(3,'Stage III'),(4,'Stage IV');
  INSERT OR IGNORE INTO BreastfeedingT VALUES
    (0,'Not recorded'),(1,'No'),(2,'Yes'),(3,'N/A');
  INSERT OR IGNORE INTO CPTDrugT VALUES
    (0,'Not given'),(1,'CTX (Cotrimoxazole)'),(2,'Dapsone');
  INSERT OR IGNORE INTO RegimenCategoryT VALUES
    (0,'Not recorded'),(1,'Adult 1st Line'),(2,'Adult 2nd Line'),
    (3,'Child 1st Line'),(4,'Child 2nd Line');
  INSERT OR IGNORE INTO RegimenARTT VALUES
    (1,'1a','AZT/3TC+EFV',1),(2,'1b','AZT/3TC/NVP',1),
    (3,'1c','TDF/3TC/DTG',1),(4,'1d','ABC/3TC (600/300)/DTG',1),
    (5,'1e','AZT/3TC+DTG',1),(6,'1f','TDF/3TC/EFV',1),
    (7,'1g','TDF/3TC+NVP',1),(8,'1h','TDF/FTC/EFV',1),(9,'1J','TDF/FTC+NVP',1),
    (10,'2a','AZT/3TC+DTG',2),(11,'2b','ABC/3TC+DTG',2),
    (12,'2c','TDF/3TC+LPV/r',2),(13,'2d','TDF/3TC+ATV/r',2),
    (14,'2e','TDF/FTC+LPV/r',2),(15,'2f','TDF/FTC-ATV/r',2),
    (16,'2g','TDF/3TC+LPV/r',2),(17,'2h','AZT/3TC+ATV/r',2),
    (18,'2i','ABC/3TC+LPV/r',2),(19,'2J','ABC/3TC+ATV/r',2),(20,'2k','TDF/3TC/DTG',2),
    (21,'4a','AZT/3TC/NVP',3),(22,'4b','AZT/3TC+EFV',3),
    (23,'4c','ABC/3TC (120/60)+LPV/r',3),(24,'4d','ABC/3TC (120/60)/DTG',3),
    (25,'4f','ABC/3TC+NVP',3),(26,'4g','ABC/3TC (120/60)+EFV (200mg)',3),
    (27,'4h','TDF/3TC+EFV',3),(28,'4i','ABC/3TC+LPV/r',3),
    (29,'4j','AZT/3TC(60/30)+LPV/r',3),(30,'4k','TDF/3TC+NVP',3),(31,'4l','ABC/3TC+AZT',3),
    (32,'5a','AZT/3TC+LPV/r',4),(33,'5b','AZT/3TC+RAL',4),
    (34,'5c','ABC/3TC (120/60)+RAL',4),(35,'5d','AZT/3TC+ATV/r',4),
    (36,'5e','ABC/3TC+ATV/r',4),(37,'5f','TDF/3TC+ATV/r',4),
    (38,'5g','AZT/3TC+DTG',4),(39,'5h','ABC/3TC+DTG',4),(40,'5i','ABC/3TC+LPV/r',4);
  INSERT OR IGNORE INTO RegimenChangeReasonT VALUES
    (0,'N/A'),(1,'Toxicity/side effects'),(2,'Pregnancy'),
    (3,'Risk of pregnancy'),(4,'Due to new TB'),(5,'New drug available'),
    (6,'Drug out of stock'),(7,'Other reason (specify)'),
    (8,'Clinical treatment failure'),(9,'Immunologic failure'),(10,'Virologic failure');
  INSERT OR IGNORE INTO FollowUpStatusT VALUES
    (0,'Not recorded'),(1,'On ART'),(2,'Dead'),(3,'Stop'),
    (4,'Missed'),(5,'LTFU - Lost to Follow Up'),(6,'TO - Transferred Out');
  INSERT OR IGNORE INTO TBStatusT VALUES
    (0,'Not recorded'),(1,'No signs'),(2,'Pre TB (Presumptive TB)'),
    (3,'INH (on INH prophylaxis)'),(4,'TB Rx (on TB treatment)'),(5,'ND - Not Done');
  INSERT OR IGNORE INTO StopReasonT VALUES
    (0,'N/A'),(1,'Toxicity/side effects'),(2,'Pregnancy'),
    (3,'Treatment failure'),(4,'Poor adherence'),(5,'Illness, hospitalization'),
    (6,'Drugs out of stock'),(7,'Patient lack finances'),
    (8,'Other patient decision'),(9,'Planned treatment interruption'),(10,'Other');
  INSERT OR IGNORE INTO CountyT VALUES (0,'Not configured');
  INSERT OR IGNORE INTO HealthFacilityT VALUES (0,'Not configured',0,0);
  INSERT OR IGNORE INTO DataSourceT VALUES (0,'Not configured',0);

  -- ── TB Register lookup seeds ───────────────────────────────────────────────
  INSERT OR IGNORE INTO SputumResultT VALUES
    (0,'Not recorded',0),(1,'Scanty AFBs Seen',2),(2,'No AFB Seen',1),
    (3,'Select One',7),(4,'1+ AFBs Seen',3),(5,'2+ AFBs Seen',4),
    (6,'3+ AFBs Seen',5),(7,'NO Smear Done',6);
  INSERT OR IGNORE INTO DiagMethodT VALUES
    (0,'Not recorded',0),(1,'GeneXpert',1),(2,'Smear Microscopy',2),
    (3,'TB LAM',3),(4,'Truenat',4),(5,'Others:- Chest Xray/Clinically etc',5);
  INSERT OR IGNORE INTO XpertResultT VALUES
    (0,'Not recorded','Not recorded'),(1,'Not Done','Not Done'),
    (2,'N','N: MTB not detected'),
    (3,'T','T: MTB detected rifampicin resistance not detected'),
    (4,'TI','TI: MTB detected rifampicin resistance indeterminate'),
    (5,'RR','RR: MTB detected rifampicin resistance detected'),
    (6,'I','I: Invalid/Error/No result'),(7,'Select One','Select One');
  INSERT OR IGNORE INTO HIVResultT VALUES
    (0,'Not recorded',0),(1,'Negative',1),(2,'Positive',2),
    (3,'Select One',4),(4,'Not Done/Unknown',3);
  INSERT OR IGNORE INTO TbTypeT VALUES
    (0,'Not recorded'),(1,'P'),(3,'EP'),(4,'Select One');
  INSERT OR IGNORE INTO PtTypeT VALUES
    (0,'Not recorded',''),(1,'New','N'),(2,'Relapse','R'),(3,'After Failure','F'),
    (4,'Treatment Interrupted','D'),(5,'Transfer In','TI'),(6,'Others','O'),(7,'Select One','');
  INSERT OR IGNORE INTO OutcomeT VALUES
    (0,'Not recorded'),(1,'Cured'),(2,'Completed'),(3,'Died'),
    (4,'Treatment Failure'),(5,'Lost To Follow Up'),(6,'Not Evaluated'),(7,'Select One');
  INSERT OR IGNORE INTO RegimenT VALUES
    (0,'Not recorded',0),(1,'2HRZE/4RH',1),(2,'2SHRZE/1HRZE/5RHE',2),
    (3,'2HRZE/10RH',3),(4,'Select One',6),(5,'2RHZE/2RH',4),(6,'2RHE/7RH',5);
  INSERT OR IGNORE INTO ReferredByT VALUES
    (0,'Not recorded'),(1,'Self'),(2,'Community Member'),(3,'Public Facility'),
    (4,'Private Clinic/Hospital'),(5,'HHPs'),(6,'Others'),(7,'Select One');
  INSERT OR IGNORE INTO MonthT VALUES
    (1,'January'),(2,'February'),(3,'March'),(4,'April'),(5,'May'),(6,'June'),
    (7,'July'),(8,'August'),(9,'September'),(10,'October'),(11,'November'),(12,'December');
  INSERT OR IGNORE INTO YearT VALUES
    (1,2015),(2,2016),(3,2017),(4,2018),(5,2019),(6,2020),(7,2021),
    (8,2022),(9,2023),(10,2024),(11,2025),(12,2026),(13,2027)
`;

// ─── Public API ───────────────────────────────────────────────────────────

async function initDB() {
  _SQL = await initSqlJs({
    locateFile: (filename) =>
      `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${filename}`
  });

  const savedData = await loadFromIDB();

  if (savedData) {
    _db = new _SQL.Database(savedData);
    console.log('[DB] Restored database from IndexedDB.');
  } else {
    _db = new _SQL.Database();
    console.log('[DB] Created new in-memory database.');
  }

  // Migration: rename old patients table if new schema not yet created
  const legacyResult = _db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='patients'`);
  const newResult    = _db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='PtDetailsARTT'`);
  const hasLegacy = legacyResult.length > 0 && legacyResult[0].values.length > 0;
  const hasNew    = newResult.length > 0 && newResult[0].values.length > 0;
  if (hasLegacy && !hasNew) {
    _db.run(`ALTER TABLE patients RENAME TO patients_legacy`);
    console.log('[DB] Migrated: patients → patients_legacy');
  }

  // Migration: rename PtDetailsT/PtFollowUpT/RegimenT to their ART-suffixed names.
  // Guard: only rename if PtDetailsARTT does NOT already exist — after the TB register
  // was added, PtDetailsT is the TB table and must NOT be renamed.
  {
    const hasTB  = _db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='PtDetailsT'`);
    const hasART = _db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='PtDetailsARTT'`);
    if (hasTB.length && hasTB[0].values.length && !(hasART.length && hasART[0].values.length)) {
      _db.run('ALTER TABLE PtDetailsT RENAME TO PtDetailsARTT');
      console.log('[DB] Migrated: PtDetailsT → PtDetailsARTT');
    }
  }
  {
    const hasTB  = _db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='PtFollowUpT'`);
    const hasART = _db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='PtFollowUpARTT'`);
    if (hasTB.length && hasTB[0].values.length && !(hasART.length && hasART[0].values.length)) {
      _db.run('ALTER TABLE PtFollowUpT RENAME TO PtFollowUpARTT');
      console.log('[DB] Migrated: PtFollowUpT → PtFollowUpARTT');
    }
  }
  {
    const hasTB  = _db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='RegimenT'`);
    const hasART = _db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='RegimenARTT'`);
    if (hasTB.length && hasTB[0].values.length && !(hasART.length && hasART[0].values.length)) {
      _db.run('ALTER TABLE RegimenT RENAME TO RegimenARTT');
      console.log('[DB] Migrated: RegimenT → RegimenARTT');
    }
  }

  _db.exec(CREATE_SCHEMA_SQL);

  // Must run StateID migration BEFORE SEED_SQL because SEED_SQL inserts
  // 4 values into HealthFacilityT and would fail on a 3-column old DB.
  try { _db.run('ALTER TABLE HealthFacilityT ADD COLUMN StateID INTEGER NOT NULL DEFAULT 0'); }
  catch (_) { /* already has the column — ignore */ }

  try { _db.run('ALTER TABLE StateT ADD COLUMN StateShort TEXT DEFAULT \'\''); }
  catch (_) { /* column already exists — ignore */ }

  _db.exec(SEED_SQL);

  // ── Extend YearT dynamically so the dropdown never hits a hard-coded ceiling ──
  // YearID sequence: YearID = year - 2014  (1 = 2015, 13 = 2027, …)
  {
    const endYear = new Date().getFullYear() + 2;
    for (let yr = 2015; yr <= endYear; yr++) {
      const id = yr - 2014;
      _db.run('INSERT OR IGNORE INTO YearT (YearID, YearName) VALUES (?, ?)', [id, yr]);
    }
  }

  // ── Schema migrations for existing databases ───────────────────────
  // Add StateID to HealthFacilityT if it was created before this column existed.
  try { _db.run('ALTER TABLE HealthFacilityT ADD COLUMN StateID INTEGER NOT NULL DEFAULT 0'); }
  catch (_) { /* column already exists — ignore */ }
  // Rename HFacilityID/HFacility → HealthFacilityID/HealthFacility (and matching FK in DataSourceT).
  try { _db.run('ALTER TABLE HealthFacilityT RENAME COLUMN HFacilityID TO HealthFacilityID'); } catch (_) {}
  try { _db.run('ALTER TABLE HealthFacilityT RENAME COLUMN HFacility   TO HealthFacility');   } catch (_) {}
  try { _db.run('ALTER TABLE DataSourceT    RENAME COLUMN HFacilityID TO HealthFacilityID'); } catch (_) {}
  // If RENAME COLUMN failed (old SQLite or unexpected schema), drop & recreate HealthFacilityT.
  // The table is always re-populated from the server via upsertGeoAreaData, so no data is lost.
  {
    const hfPragma = _db.exec('PRAGMA table_info(HealthFacilityT)');
    const hfCols   = hfPragma.length ? hfPragma[0].values.map(r => r[1]) : [];
    if (!hfCols.includes('HealthFacilityID')) {
      _db.run('DROP TABLE IF EXISTS HealthFacilityT');
      _db.exec('CREATE TABLE HealthFacilityT (HealthFacilityID INTEGER PRIMARY KEY, HealthFacility TEXT NOT NULL DEFAULT \'\', CountyID INTEGER NOT NULL DEFAULT 0, StateID INTEGER NOT NULL DEFAULT 0)');
      _db.run("INSERT OR IGNORE INTO HealthFacilityT VALUES (0,'Not configured',0,0)");
      console.log('[DB] Rebuilt HealthFacilityT with correct column names.');
    }
  }
  // Add soft-delete column to PtDetailsARTT and PtFollowUpARTT for existing databases.
  try { _db.run('ALTER TABLE PtDetailsARTT  ADD COLUMN Deleted INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
  try { _db.run('ALTER TABLE PtFollowUpARTT ADD COLUMN Deleted INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
  // Add PatientID to PtDetailsARTT if it was created before this column existed.
  try { _db.run('ALTER TABLE PtDetailsARTT ADD COLUMN PatientID INTEGER'); } catch (_) {}
  // Rename FullName → PtName in PtDetailsARTT.
  try { _db.run('ALTER TABLE PtDetailsARTT RENAME COLUMN FullName TO PtName'); } catch (_) {}
  // Add AgeMonths to TB patient table for existing databases.
  try { _db.run('ALTER TABLE PtDetailsT ADD COLUMN AgeMonths INTEGER'); } catch (_) {}
  // Always drop and recreate vwGeogAreaQ so view definition changes take effect
  // on existing databases (CREATE VIEW IF NOT EXISTS won't update stale definitions).
  _db.run('DROP VIEW IF EXISTS vwGeogAreaQ');
  _db.exec(CREATE_SCHEMA_SQL.match(/CREATE VIEW IF NOT EXISTS vwGeogAreaQ[\s\S]+?;/)[0]);

  await _persistDB();
  window._patientDb = _db; // exposed so offline report generators can query without a db.js import
  console.log('[DB] Schema and seed data ready.');
}

async function _persistDB() {
  if (!_db) return;
  const data = _db.export();
  await saveToIDB(data);
}

// ─── PtDetailsARTT ──────────────────────────────────────────────────────────

async function insertPtDetails(data) {
  const tid = generateGUID();
  const now = _now();
  const bmi = calcBMI(data.WeightKg, data.HeightCm);
  _db.run(`
    INSERT INTO PtDetailsARTT (
      PtDetailsTID, PatientID, NearestHFID, DataSourceID, CountyID, EnteredByID,
      HasChanged, LastModOn, CreatedOn,
      HIVRetest, ARTNo, ARTStartDate, DateEnrolledInCare,
      PtName, ResidenceAddress, Phone1, Phone2,
      OccupationID, OccupationOther, KeyPopuID, KeyPopuOther,
      Age, DateOfBirth, SexID,
      WeightKg, HeightCm, MUACCm, BMI,
      WHOStageID, CD4Value, CD4IsPercent,
      CPTStartDate, CPTDrugID, TBRxStartDate, UnitTBNo, TBStatusID,
      BreastfeedingID, IsTransferIn, TransferFromFacility,
      GuardianName, GuardianPhone1
    ) VALUES (
      ?,(SELECT COALESCE(MAX(PatientID),0)+1 FROM PtDetailsARTT),?,?,?,?,1,?,?,
      ?,?,?,?,
      ?,?,?,?,
      ?,?,?,?,
      ?,?,?,
      ?,?,?,?,
      ?,?,?,
      ?,?,?,?,?,
      ?,?,?,
      ?,?
    )`,
    [
      tid, data.NearestHFID||0, data.DataSourceID||0, data.CountyID||0, data.EnteredByID||'',
      now, now,
      data.HIVRetest||0, data.ARTNo||'', data.ARTStartDate||null, data.DateEnrolledInCare||null,
      data.PtName||'', data.ResidenceAddress||null, data.Phone1||null, data.Phone2||null,
      data.OccupationID||0, data.OccupationOther||null, data.KeyPopuID||0, data.KeyPopuOther||null,
      data.Age||0, data.DateOfBirth||null, data.SexID||0,
      data.WeightKg||null, data.HeightCm||null, data.MUACCm||null, bmi,
      data.WHOStageID||0, data.CD4Value||null, data.CD4IsPercent||0,
      data.CPTStartDate||null, data.CPTDrugID||0, data.TBRxStartDate||null, data.UnitTBNo||null, data.TBStatusID||0,
      data.BreastfeedingID||0, data.IsTransferIn||0, data.TransferFromFacility||null,
      data.GuardianName||null, data.GuardianPhone1||null
    ]
  );
  await _persistDB();
  console.log(`[DB] insertPtDetails: ${tid}`);
  return tid;
}

function getAllPtDetails(searchTerm = '') {
  let sql = `
    SELECT p.PtDetailsTID, p.PatientID, p.ARTNo, p.PtName, p.Age,
           s.Sex, p.Phone1, p.ARTStartDate, p.HasChanged, p.CreatedOn,
           p.NearestHFID, hf.HealthFacility
    FROM PtDetailsARTT p
    LEFT JOIN SexT s ON p.SexID = s.SexID
    LEFT JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID
    WHERE p.Deleted = 0
  `;
  const params = [];
  if (searchTerm.trim()) {
    sql += ` AND (p.PtName LIKE ? OR p.ARTNo LIKE ? OR COALESCE(p.Phone1,'') LIKE ? OR COALESCE(p.Phone2,'') LIKE ?)`;
    const like = `%${searchTerm.trim()}%`;
    params.push(like, like, like, like);
  }
  sql += ' ORDER BY p.CreatedOn DESC';
  const results = _db.exec(sql, params);
  if (!results.length) return [];
  const { columns, values } = results[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

/** Returns soft-deleted patients for the Deleted Records management view. */
function getAllDeletedPtDetails() {
  const results = _db.exec(`
    SELECT p.PtDetailsTID, p.PatientID, p.ARTNo, p.PtName, p.Age, s.Sex, p.ARTStartDate, p.LastModOn, hf.HealthFacility
    FROM PtDetailsARTT p LEFT JOIN SexT s ON p.SexID = s.SexID 
    LEFT JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID 
    WHERE p.Deleted = 1
    ORDER BY p.LastModOn DESC
  `);
  if (!results.length) return [];
  const { columns, values } = results[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

function getPtDetails(ptDetailsTID) {
  const r = _db.exec('SELECT * FROM PtDetailsARTT WHERE PtDetailsTID = ?', [ptDetailsTID]);
  if (!r.length || !r[0].values.length) return null;
  const { columns, values } = r[0];
  return Object.fromEntries(columns.map((c, i) => [c, values[0][i]]));
}

/**
 * Returns ALL columns for every patient — used by the sync payload so no
 * clinical field is accidentally omitted.  Do not use for UI rendering
 * (use getAllPtDetails instead, which joins the sex label and is leaner).
 */
function getAllPtDetailsForSync() {
  const r = _db.exec('SELECT * FROM PtDetailsARTT WHERE HasChanged = 1 ORDER BY CreatedOn');
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

async function updatePtDetails(ptDetailsTID, data) {
  const now = _now();
  const bmi = calcBMI(data.WeightKg, data.HeightCm);
  _db.run(`
    UPDATE PtDetailsARTT SET
      HasChanged = 1, LastModOn = ?,
      HIVRetest = ?, ARTNo = ?, ARTStartDate = ?, DateEnrolledInCare = ?,
      PtName = ?, ResidenceAddress = ?, Phone1 = ?, Phone2 = ?,
      OccupationID = ?, OccupationOther = ?, KeyPopuID = ?, KeyPopuOther = ?,
      Age = ?, DateOfBirth = ?, SexID = ?,
      WeightKg = ?, HeightCm = ?, MUACCm = ?, BMI = ?,
      WHOStageID = ?, CD4Value = ?, CD4IsPercent = ?,
      CPTStartDate = ?, CPTDrugID = ?, TBRxStartDate = ?, UnitTBNo = ?, TBStatusID = ?,
      BreastfeedingID = ?, IsTransferIn = ?, TransferFromFacility = ?,
      GuardianName = ?, GuardianPhone1 = ?
    WHERE PtDetailsTID = ?`,
    [
      now,
      data.HIVRetest||0, data.ARTNo||'', data.ARTStartDate||null, data.DateEnrolledInCare||null,
      data.PtName||'', data.ResidenceAddress||null, data.Phone1||null, data.Phone2||null,
      data.OccupationID||0, data.OccupationOther||null, data.KeyPopuID||0, data.KeyPopuOther||null,
      data.Age||0, data.DateOfBirth||null, data.SexID||0,
      data.WeightKg||null, data.HeightCm||null, data.MUACCm||null, bmi,
      data.WHOStageID||0, data.CD4Value||null, data.CD4IsPercent||0,
      data.CPTStartDate||null, data.CPTDrugID||0, data.TBRxStartDate||null, data.UnitTBNo||null, data.TBStatusID||0,
      data.BreastfeedingID||0, data.IsTransferIn||0, data.TransferFromFacility||null,
      data.GuardianName||null, data.GuardianPhone1||null,
      ptDetailsTID
    ]
  );
  await _persistDB();
  console.log(`[DB] updatePtDetails: ${ptDetailsTID}`);
}

async function deletePtSubRecords(ptDetailsTID) {
  for (const tbl of ['INHProphylaxisT', 'PMTCTPregnancyT', 'RegimenHistoryT']) {
    _db.run(`DELETE FROM ${tbl} WHERE PtDetailsTID = ?`, [ptDetailsTID]);
  }
  await _persistDB();
  console.log(`[DB] deletePtSubRecords: ${ptDetailsTID}`);
}

async function deletePtDetails(ptDetailsTID) {
  // Soft delete: mark as deleted and flag for sync so the server is updated.
  const now = _now();
  _db.run(
    'UPDATE PtDetailsARTT SET Deleted = 1, HasChanged = 1, LastModOn = ? WHERE PtDetailsTID = ?',
    [now, ptDetailsTID]
  );
  await _persistDB();
  console.log(`[DB] deletePtDetails (soft): ${ptDetailsTID}`);
}

/** Restore a soft-deleted patient record. */
async function undeletePtDetails(ptDetailsTID) {
  const now = _now();
  _db.run(
    'UPDATE PtDetailsARTT SET Deleted = 0, HasChanged = 1, LastModOn = ? WHERE PtDetailsTID = ?',
    [now, ptDetailsTID]
  );
  await _persistDB();
  console.log(`[DB] undeletePtDetails: ${ptDetailsTID}`);
}

async function deleteVisit(ptFollowUpTID) {
  _db.run('DELETE FROM PtFollowUpARTT WHERE PtFollowUpTID = ?', [ptFollowUpTID]);
  await _persistDB();
}

async function updateFollowUp(ptFollowUpTID, data, artStartDate) {
  const now = _now();
  const visitMonth = calcVisitMonth(artStartDate, data.VisitDate);
  const bmi = calcBMI(data.WeightKg, data.HeightCm);
  _db.run(`
    UPDATE PtFollowUpARTT SET
      HasChanged = 1, LastModOn = ?,
      VisitDate = ?, VisitMonth = ?,
      FollowUpStatusID = ?, RegimenID = ?, TBStatusID = ?,
      StopReasonID = ?, StopOtherText = ?, WeeksInterrupted = ?,
      WeightKg = ?, HeightCm = ?, BMI = ?, CPTDrugID = ?,
      CD4Value = ?, CD4IsPercent = ?, ViralLoad = ?, Notes = ?
    WHERE PtFollowUpTID = ?`,
    [
      now,
      data.VisitDate||null, visitMonth,
      data.FollowUpStatusID||0, data.RegimenID||0, data.TBStatusID||0,
      data.StopReasonID||0, data.StopOtherText||null, data.WeeksInterrupted||0,
      data.WeightKg||null, data.HeightCm||null, bmi, data.CPTDrugID||0,
      data.CD4Value||null, data.CD4IsPercent||0, data.ViralLoad||null, data.Notes||null,
      ptFollowUpTID
    ]
  );
  // Bump the parent so the next sync includes this patient.
  _db.run('UPDATE PtDetailsARTT SET HasChanged = 1, LastModOn = ? WHERE PtDetailsTID = ?',
    [now, data.PtDetailsTID]);
  await _persistDB();
  console.log(`[DB] updateFollowUp: ${ptFollowUpTID}`);
}

// ─── INHProphylaxisT ─────────────────────────────────────────────────────

async function insertINH({ PtDetailsTID, SequenceNo, INHDate, EnteredByID = '' }) {
  const tid = generateGUID(), now = _now();
  _db.run(
    `INSERT INTO INHProphylaxisT
     (INHProphylaxisTID,PtDetailsTID,SequenceNo,INHDate,EnteredByID,HasChanged,LastModOn,CreatedOn)
     VALUES (?,?,?,?,?,1,?,?)`,
    [tid, PtDetailsTID, SequenceNo||0, INHDate||null, EnteredByID, now, now]
  );
  await _persistDB();
  return tid;
}

function getINH(ptDetailsTID) {
  const r = _db.exec(
    'SELECT * FROM INHProphylaxisT WHERE PtDetailsTID = ? ORDER BY SequenceNo',
    [ptDetailsTID]
  );
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

async function deleteINH(inhTID) {
  _db.run('DELETE FROM INHProphylaxisT WHERE INHProphylaxisTID = ?', [inhTID]);
  await _persistDB();
}

// ─── PMTCTPregnancyT ─────────────────────────────────────────────────────

async function insertPMTCT(data) {
  const tid = generateGUID(), now = _now();
  _db.run(
    `INSERT INTO PMTCTPregnancyT
     (PMTCTPregnancyTID,PtDetailsTID,PregnancyNo,ANCNo,DeliveryDate,
      MotherReceivedART,InfantReceivedARVs,EnteredByID,HasChanged,LastModOn,CreatedOn)
     VALUES (?,?,?,?,?,?,?,?,1,?,?)`,
    [tid, data.PtDetailsTID, data.PregnancyNo||0, data.ANCNo||null, data.DeliveryDate||null,
     data.MotherReceivedART||0, data.InfantReceivedARVs||0, data.EnteredByID||'', now, now]
  );
  await _persistDB();
  return tid;
}

function getPMTCT(ptDetailsTID) {
  const r = _db.exec(
    'SELECT * FROM PMTCTPregnancyT WHERE PtDetailsTID = ? ORDER BY PregnancyNo',
    [ptDetailsTID]
  );
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

async function deletePMTCT(pTID) {
  _db.run('DELETE FROM PMTCTPregnancyT WHERE PMTCTPregnancyTID = ?', [pTID]);
  await _persistDB();
}

// ─── RegimenHistoryT ─────────────────────────────────────────────────────

async function insertRegimenHistory(data) {
  const tid = generateGUID(), now = _now();
  _db.run(
    `INSERT INTO RegimenHistoryT
     (RegimenHistoryTID,PtDetailsTID,RegimenLine,SequenceNo,RegimenID,
      ChangeReasonID,OtherReasonText,EventDate,EnteredByID,HasChanged,LastModOn,CreatedOn)
     VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`,
    [tid, data.PtDetailsTID, data.RegimenLine||0, data.SequenceNo||0, data.RegimenID||0,
     data.ChangeReasonID||0, data.OtherReasonText||null, data.EventDate||null,
     data.EnteredByID||'', now, now]
  );
  await _persistDB();
  return tid;
}

function getRegimenHistory(ptDetailsTID) {
  const r = _db.exec(
    `SELECT rh.*, rt.RegimenCode, rt.Regimen, rc.RegimenChangeReason
     FROM RegimenHistoryT rh
     LEFT JOIN RegimenARTT rt ON rh.RegimenID = rt.RegimenID
     LEFT JOIN RegimenChangeReasonT rc ON rh.ChangeReasonID = rc.RegimenChangeReasonID
     WHERE rh.PtDetailsTID = ?
     ORDER BY rh.RegimenLine, rh.SequenceNo`,
    [ptDetailsTID]
  );
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

// ─── PtFollowUpARTT ─────────────────────────────────────────────────────────

async function insertFollowUp(data, artStartDate) {
  const tid = generateGUID(), now = _now();
  const visitMonth = calcVisitMonth(artStartDate, data.VisitDate);
  const bmi = calcBMI(data.WeightKg, data.HeightCm);
  _db.run(
    `INSERT INTO PtFollowUpARTT (
      PtFollowUpTID,PtDetailsTID,VisitDate,VisitMonth,
      FollowUpStatusID,RegimenID,TBStatusID,StopReasonID,StopOtherText,
      WeeksInterrupted,WeightKg,HeightCm,BMI,CPTDrugID,
      CD4Value,CD4IsPercent,ViralLoad,Notes,
      EnteredByID,HasChanged,LastModOn,CreatedOn
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    [
      tid, data.PtDetailsTID, data.VisitDate||null, visitMonth,
      data.FollowUpStatusID||0, data.RegimenID||0, data.TBStatusID||0,
      data.StopReasonID||0, data.StopOtherText||null, data.WeeksInterrupted||0,
      data.WeightKg||null, data.HeightCm||null, bmi, data.CPTDrugID||0,
      data.CD4Value||null, data.CD4IsPercent||0, data.ViralLoad||null, data.Notes||null,
      data.EnteredByID||'', now, now
    ]
  );
  // A new follow-up must also flag the parent so the next sync includes this patient.
  _db.run(
    'UPDATE PtDetailsARTT SET HasChanged = 1, LastModOn = ? WHERE PtDetailsTID = ?',
    [now, data.PtDetailsTID]
  );
  await _persistDB();
  return tid;
}

function getFollowUps(ptDetailsTID) {
  const r = _db.exec(
    `SELECT fu.*, fs.FollowUpStatus, rt.RegimenCode, rt.Regimen, ts.TBStatus
     FROM PtFollowUpARTT fu
     LEFT JOIN FollowUpStatusT fs ON fu.FollowUpStatusID = fs.FollowUpStatusID
     LEFT JOIN RegimenARTT rt ON fu.RegimenID = rt.RegimenID
     LEFT JOIN TBStatusT ts ON fu.TBStatusID = ts.TBStatusID
     WHERE fu.PtDetailsTID = ?
     ORDER BY fu.VisitDate`,
    [ptDetailsTID]
  );
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

// ─── Lookup helper ────────────────────────────────────────────────────────

function getLookupAll(tableName) {
  const allowed = [
    // ART register lookups
    'SexT','OccupationT','KeyPopuT','WHOStageT','BreastfeedingT','CPTDrugT',
    'RegimenCategoryT','RegimenARTT','RegimenChangeReasonT','FollowUpStatusT',
    'TBStatusT','StopReasonT','CountyT','HealthFacilityT','DataSourceT',
    // TB register lookups
    'SputumResultT','DiagMethodT','XpertResultT','HIVResultT','TbTypeT',
    'PtTypeT','OutcomeT','RegimenT','ReferredByT','MonthT','YearT'
  ];
  if (!allowed.includes(tableName)) throw new Error(`Unknown lookup table: ${tableName}`);
  const r = _db.exec(`SELECT * FROM ${tableName} ORDER BY 1`);
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

// ─── Geographic area (facility tree) helpers ──────────────────────────────

/**
 * Upsert fresh geo-tree data from the server into the three normalised tables
 * (StateT, CountyT, HealthFacilityT).  The SQLite view vwGeogAreaQ then
 * reflects the updated data automatically — no separate flat cache needed.
 *
 * @param {Array<{healthFacilityID,healthFacility,countyID,county,stateID,state}>} items
 */
function upsertGeoAreaData(items) {
  if (!_db) throw new Error('DB not ready');

  // Collect unique states and counties to avoid redundant writes
  const states   = new Map();   // stateID  → { name, short }
  const counties = new Map();   // countyID → countyName
  for (const it of items) {
    if (it.stateID  && !states.has(it.stateID))    states.set(it.stateID,   { name: it.state, short: it.stateShort ?? '' });
    if (it.countyID && !counties.has(it.countyID)) counties.set(it.countyID, it.county);
  }

  // Upsert states
  const stmtState = _db.prepare('INSERT OR REPLACE INTO StateT (StateID, State, StateShort) VALUES (?,?,?)');
  for (const [id, s] of states)   stmtState.run([id, s.name, s.short]);
  stmtState.free();

  // Upsert counties
  const stmtCounty = _db.prepare('INSERT OR REPLACE INTO CountyT (CountyID, County) VALUES (?,?)');
  for (const [id, name] of counties) stmtCounty.run([id, name]);
  stmtCounty.free();

  // Upsert facilities
  const stmtFac = _db.prepare(
    'INSERT OR REPLACE INTO HealthFacilityT (HealthFacilityID, HealthFacility, CountyID, StateID) VALUES (?,?,?,?)'
  );
  for (const it of items)
    stmtFac.run([it.healthFacilityID, it.healthFacility, it.countyID, it.stateID]);
  stmtFac.free();

  _persistDB();
}

/**
 * Return all rows from vwGeogAreaQ ordered by State → County → Facility.
 * The view joins HealthFacilityT + CountyT + StateT.
 * @returns {Array<{HealthFacilityID,HealthFacility,CountyID,County,StateID,State}>}
 */
function getGeoAreaData() {
  if (!_db) return [];
  const r = _db.exec(
    'SELECT HealthFacilityID, HealthFacility, CountyID, County, StateID, State FROM vwGeogAreaQ ORDER BY State, County, HealthFacility'
  );
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

// ─── General-purpose query helper ────────────────────────────────────────

/**
 * Execute a read-only SQL query against the local SQLite database.
 * Returns an array of plain row objects.  params is an array of positional
 * bind values matching '?' placeholders in the SQL string.
 */
function dbExec(sql, params = []) {
  if (!_db) return [];
  const results = _db.exec(sql, params);
  if (!results.length) return [];
  const { columns, values } = results[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

// ─── Export ───────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
//  TB TREATMENT MONITORING
//  1 TB month = 28 days throughout all queries below.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates facility IDs: accepts only positive integers.
 * Called before any ID is interpolated into SQL to prevent injection.
 */
function _monSafeFacilityIDs(ids) {
  if (!ids || !ids.length) return [];
  return ids.map(Number).filter(id => Number.isInteger(id) && id > 0);
}

/**
 * Builds an AND-clause to filter by facility IDs.
 * Returns empty string when ids is empty (= no filter).
 * IDs are validated as positive integers before interpolation.
 */
function _monFacilityFilter(ids, alias) {
  alias = alias || 'p';
  const safe = _monSafeFacilityIDs(ids);
  return safe.length ? 'AND ' + alias + '.NearestHFID IN (' + safe.join(',') + ')' : '';
}

/**
 * Maps a sql.js result set to an array of row objects.
 */
function _monRows(r) {
  if (!r || !r.length) return [];
  const cols = r[0].columns;
  const vals = r[0].values;
  return vals.map(function(row) {
    var obj = {};
    for (var i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
    return obj;
  });
}

/**
 * Core sputum follow-up query builder.
 * DaysLate = days since DateRxStarted minus reviewDayOffset
 *   positive = overdue (missed mode filter applies grace window)
 *   zero/negative = still on schedule (due mode)
 *
 * @param {number}         reviewDayOffset - e.g. 56 for 2-month check (28×2)
 * @param {number}         gracePeriod     - missed-mode window in days
 * @param {'missed'|'due'} mode
 * @param {number[]}       facilityIDs     - empty = all
 * @param {string}         extraWhere      - additional SQL fragments (internal, safe)
 */
function _tbMonSputumQuery(reviewDayOffset, gracePeriod, mode, facilityIDs, extraWhere, dayExprOverride, orderByOverride) {
  if (!_db) return [];
  var hf = _monFacilityFilter(facilityIDs);
  var dayExpr;
  if (dayExprOverride) {
    dayExpr = dayExprOverride;
  } else {
    var offsetStr = String(reviewDayOffset);
    // Weekend adjustment: if the ideal review date (DateRxStarted + offset) falls on
    // Saturday (%w=6) shift to Monday (+2); if Sunday (%w=0) shift to Monday (+1).
    dayExpr = "CAST(julianday('now') - julianday(p.DateRxStarted) AS INTEGER) - " + offsetStr
      + " - CASE strftime('%w', date(p.DateRxStarted, '+" + offsetStr + " days'))"
      + " WHEN '6' THEN 2 WHEN '0' THEN 1 ELSE 0 END";
  }
  var modeFilter = mode === 'missed'
    ? 'AND (' + dayExpr + ') > 0 AND (' + dayExpr + ') <= ' + gracePeriod
    : 'AND (' + dayExpr + ') <= 0';

  var sql = [
    'SELECT p.PtDetailsTID, p.UnitTBNo, p.RegDate, p.PtName, p.Age,',
    '       p.Village, p.Payam, p.PtPhone, p.PtTypeID, p.NearestHFID,',
    '       s.Sex, pt.PtTypeShort,',
    '       COALESCE(hf.HealthFacility,\'\') AS HealthFacility,',
    '       (' + dayExpr + ') AS DaysLate',
    'FROM PtDetailsT p',
    'LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID = fu.PtDetailsTID AND fu.Deleted = 0',
    'LEFT JOIN SexT         s  ON p.SexID  = s.SexID',
    'LEFT JOIN PtTypeT      pt ON p.PtTypeID = pt.PtTypeID',
    'LEFT JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID',
    'WHERE p.Deleted = 0',
    "  AND p.DateRxStarted IS NOT NULL AND p.DateRxStarted != ''",
    '  AND p.TbTypeID IN (1, 2)',
    '  AND p.PtTypeID <> 5',
    '  AND p.Age > 4',
    "  AND p.PtName IS NOT NULL AND p.PtName != ''",
    '  AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.OutcomeID, 0) IN (0, 7))',
    '  AND (COALESCE(fu.Mon0LabResultID, 0) IN (1,4,5,6)',
    '       OR COALESCE(fu.Mon0XpertResultID, 0) IN (3,4,5))',
    '  ' + extraWhere,
    '  ' + hf,
    '  ' + modeFilter,
    'ORDER BY ' + (orderByOverride || ('DaysLate ' + (mode === 'due' ? 'DESC' : 'ASC') + ', p.PtName'))
  ].join('\n');

  try {
    return _monRows(_db.exec(sql));
  } catch (e) {
    console.error('[MonDB] sputum query error:', e.message);
    return [];
  }
}

/** Sputum @ 2 months (56 days): bacteriologically confirmed, no Mon2 smear yet. */
function getTBMonSputum2(mode, facilityIDs) {
  return _tbMonSputumQuery(56, 28, mode, facilityIDs,
    "AND (fu.PtFollowUpTID IS NULL OR fu.Mon2Date IS NULL OR fu.Mon2Date = ''"
    + " OR COALESCE(fu.Mon2LabResultID, 0) IN (0, 3, 7))"
    + " AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.Mon3LabResultID, 0) IN (0, 3, 7))",
    null);
}

/**
 * Sputum @ 3 months: ideal date = Mon2Date+28 when available, else DateRxStarted+84.
 * Includes patients where 2-month smear was positive, not done, or unrecorded
 * (excludes only smear-negative (2) or contaminated (7) 2-month results).
 */
function getTBMonSputum3(mode, facilityIDs) {
  var ideal = "COALESCE(date(fu.Mon2Date, '+28 days'), date(p.DateRxStarted, '+84 days'))";
  var dayExpr = "CAST(julianday('now') - julianday(" + ideal + ") AS INTEGER)"
    + " - CASE strftime('%w', " + ideal + ")"
    + " WHEN '6' THEN 2 WHEN '0' THEN 1 ELSE 0 END";
  return _tbMonSputumQuery(84, 56, mode, facilityIDs,
    "AND COALESCE(fu.Mon2LabResultID, 0) NOT IN (2, 7)" +
    " AND (fu.PtFollowUpTID IS NULL OR fu.Mon3Date IS NULL OR fu.Mon3Date = ''" +
    " OR COALESCE(fu.Mon3LabResultID, 0) IN (0, 3, 7))",
    dayExpr);
}

/** Sputum @ 5 months (140 days). DS-TB only (TbTypeID = 1).
 *  Ideal date = COALESCE(DateRxStarted, RegDate) + 140 days (with weekend adjustment).
 *  Includes patients where Mon5 result is null or "Not Done" (3).
 */
function getTBMonSputum5(mode, facilityIDs) {
  if (!_db) return [];
  var hf   = _monFacilityFilter(facilityIDs);
  var base = "COALESCE(p.DateRxStarted, p.RegDate)";
  var dayExpr = "CAST(julianday('now') - julianday(" + base + ") AS INTEGER) - 140"
    + " - CASE strftime('%w', date(" + base + ", '+140 days'))"
    + " WHEN '6' THEN 2 WHEN '0' THEN 1 ELSE 0 END";
  var modeFilter = mode === 'missed'
    ? 'AND (' + dayExpr + ') > 0 AND (' + dayExpr + ') <= 28'
    : 'AND (' + dayExpr + ') <= 0';

  var sql = [
    'SELECT p.PtDetailsTID, p.UnitTBNo, p.RegDate, p.PtName, p.Age,',
    '       p.Village, p.Payam, p.PtPhone, p.PtTypeID, p.NearestHFID,',
    '       s.Sex, pt.PtTypeShort,',
    "       COALESCE(hf.HealthFacility,'') AS HealthFacility,",
    '       (' + dayExpr + ') AS DaysLate',
    'FROM PtDetailsT p',
    'LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID = fu.PtDetailsTID AND fu.Deleted = 0',
    'LEFT JOIN SexT         s  ON p.SexID  = s.SexID',
    'LEFT JOIN PtTypeT      pt ON p.PtTypeID = pt.PtTypeID',
    'LEFT JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID',
    'WHERE p.Deleted = 0',
    '  AND p.TbTypeID = 1',
    '  AND p.PtTypeID <> 5',
    '  AND p.Age > 4',
    "  AND p.PtName IS NOT NULL AND p.PtName != ''",
    '  AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.OutcomeID, 0) IN (0, 7))',
    '  AND (COALESCE(fu.Mon0LabResultID, 0) IN (1,4,5,6)',
    '       OR COALESCE(fu.Mon0XpertResultID, 0) IN (3,4,5))',
    '  AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.Mon5LabResultID, 0) IN (0, 3))',
    '  ' + hf,
    '  ' + modeFilter,
    'ORDER BY DaysLate ' + (mode === 'due' ? 'DESC' : 'ASC') + ', p.PtName'
  ].join('\n');

  try {
    return _monRows(_db.exec(sql));
  } catch (e) {
    console.error('[MonDB] sputum5 query error:', e.message);
    return [];
  }
}

/**
 * Sputum @ 6 months. DS-TB only (TbTypeID = 1).
 * Ideal date = COALESCE(Mon5Date + 28, DateRxStarted + 168) with weekend adjustment.
 * Includes patients where Mon6 result is null or "Not Done" (3).
 */
function getTBMonSputum6(mode, facilityIDs) {
  if (!_db) return [];
  var hf    = _monFacilityFilter(facilityIDs);
  var ideal = "COALESCE(date(fu.Mon5Date, '+28 days'), date(p.DateRxStarted, '+168 days'))";
  var dayExpr = "CAST(julianday('now') - julianday(" + ideal + ") AS INTEGER)"
    + " - CASE strftime('%w', " + ideal + ")"
    + " WHEN '6' THEN 2 WHEN '0' THEN 1 ELSE 0 END";
  var modeFilter = mode === 'missed'
    ? 'AND (' + dayExpr + ') > 0 AND (' + dayExpr + ') <= 56'
    : 'AND (' + dayExpr + ') <= 0';

  var sql = [
    'SELECT p.PtDetailsTID, p.UnitTBNo, p.RegDate, p.PtName, p.Age,',
    '       p.Village, p.Payam, p.PtPhone, p.PtTypeID, p.NearestHFID,',
    '       s.Sex, pt.PtTypeShort,',
    "       COALESCE(hf.HealthFacility,'') AS HealthFacility,",
    '       (' + dayExpr + ') AS DaysLate',
    'FROM PtDetailsT p',
    'LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID = fu.PtDetailsTID AND fu.Deleted = 0',
    'LEFT JOIN SexT         s  ON p.SexID  = s.SexID',
    'LEFT JOIN PtTypeT      pt ON p.PtTypeID = pt.PtTypeID',
    'LEFT JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID',
    'WHERE p.Deleted = 0',
    "  AND p.DateRxStarted IS NOT NULL AND p.DateRxStarted != ''",
    '  AND p.TbTypeID = 1',
    '  AND p.PtTypeID <> 5',
    '  AND p.Age > 4',
    "  AND p.PtName IS NOT NULL AND p.PtName != ''",
    '  AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.OutcomeID, 0) IN (0, 7))',
    '  AND (COALESCE(fu.Mon0LabResultID, 0) IN (1,4,5,6)',
    '       OR COALESCE(fu.Mon0XpertResultID, 0) IN (3,4,5))',
    '  AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.Mon6LabResultID, 0) IN (0, 3))',
    '  ' + hf,
    '  ' + modeFilter,
    'ORDER BY DaysLate ' + (mode === 'due' ? 'DESC' : 'ASC') + ', p.PtName'
  ].join('\n');

  try {
    return _monRows(_db.exec(sql));
  } catch (e) {
    console.error('[MonDB] sputum6 query error:', e.message);
    return [];
  }
}

/**
 * Sputum @ 8 months. TbTypeID = 1 (Pulmonary only — EP cases do not have sputum smears).
 * Ideal date = COALESCE(Mon6Date + 56, DateRxStarted + 224) with weekend adjustment.
 * Includes patients where Mon6 result is null or "Not Done" (3).
 */
function getTBMonSputum8(mode, facilityIDs) {
  if (!_db) return [];
  var hf    = _monFacilityFilter(facilityIDs);
  var ideal = "COALESCE(date(fu.Mon6Date, '+56 days'), date(p.DateRxStarted, '+224 days'))";
  var dayExpr = "CAST(julianday('now') - julianday(" + ideal + ") AS INTEGER)"
    + " - CASE strftime('%w', " + ideal + ")"
    + " WHEN '6' THEN 2 WHEN '0' THEN 1 ELSE 0 END";
  var modeFilter = mode === 'missed'
    ? 'AND (' + dayExpr + ') > 0 AND (' + dayExpr + ') <= 56'
    : 'AND (' + dayExpr + ') <= 0';

  var sql = [
    'SELECT p.PtDetailsTID, p.UnitTBNo, p.RegDate, p.PtName, p.Age,',
    '       p.Village, p.Payam, p.PtPhone, p.PtTypeID, p.NearestHFID,',
    '       s.Sex, pt.PtTypeShort,',
    "       COALESCE(hf.HealthFacility,'') AS HealthFacility,",
    '       (' + dayExpr + ') AS DaysLate',
    'FROM PtDetailsT p',
    'LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID = fu.PtDetailsTID AND fu.Deleted = 0',
    'LEFT JOIN SexT         s  ON p.SexID  = s.SexID',
    'LEFT JOIN PtTypeT      pt ON p.PtTypeID = pt.PtTypeID',
    'LEFT JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID',
    'WHERE p.Deleted = 0',
    "  AND p.DateRxStarted IS NOT NULL AND p.DateRxStarted != ''",
    '  AND p.TbTypeID = 1',
    '  AND p.PtTypeID <> 5',
    '  AND p.Age > 4',
    "  AND p.PtName IS NOT NULL AND p.PtName != ''",
    '  AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.OutcomeID, 0) IN (0, 7))',
    '  AND (COALESCE(fu.Mon0LabResultID, 0) IN (1,4,5,6)',
    '       OR COALESCE(fu.Mon0XpertResultID, 0) IN (3,4,5))',
    '  AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.Mon6LabResultID, 0) IN (0, 3))',
    '  ' + hf,
    '  ' + modeFilter,
    'ORDER BY DaysLate ' + (mode === 'due' ? 'DESC' : 'ASC') + ', p.PtName'
  ].join('\n');

  try {
    return _monRows(_db.exec(sql));
  } catch (e) {
    console.error('[MonDB] sputum8 query error:', e.message);
    return [];
  }
}

/** HIV testing due: active TB patients not yet tested (HIVTestResultID 0, 4 or missing). */
function getTBMonHIV(facilityIDs) {
  if (!_db) return [];
  var hf = _monFacilityFilter(facilityIDs);
  var sql = [
    'SELECT p.PtDetailsTID, p.UnitTBNo, p.RegDate, p.PtName, p.Age,',
    '       p.Village, p.Payam, p.PtPhone, p.PtTypeID, p.NearestHFID,',
    '       s.Sex, pt.PtTypeShort,',
    '       COALESCE(hf.HealthFacility,\'\') AS HealthFacility',
    'FROM PtDetailsT p',
    'LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID = fu.PtDetailsTID AND fu.Deleted = 0',
    'LEFT JOIN SexT         s  ON p.SexID  = s.SexID',
    'LEFT JOIN PtTypeT      pt ON p.PtTypeID = pt.PtTypeID',
    'LEFT JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID',
    'WHERE p.Deleted = 0',
    "  AND p.DateRxStarted IS NOT NULL AND p.DateRxStarted != ''",
    "  AND p.PtName IS NOT NULL AND p.PtName != ''",
    // TODO(user-prefs): 365-day limit on RegDate — make configurable in user preferences
    "  AND CAST(julianday('now') - julianday(p.RegDate) AS INTEGER) <= 365",
    '  AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.OutcomeID, 0) IN (0, 7))',
    '  AND (fu.PtFollowUpTID IS NULL',
    '       OR COALESCE(fu.HIVTestResultID, 0) IN (0, 3, 4))',
    '  ' + hf,
    'ORDER BY p.RegDate DESC'
  ].join('\n');
  try { return _monRows(_db.exec(sql)); } catch (e) { console.error('[MonDB] HIV query:', e.message); return []; }
}

/** CPT due: HIV-positive active patients who have not started CPT. */
function getTBMonCPT(facilityIDs) {
  if (!_db) return [];
  var hf = _monFacilityFilter(facilityIDs);
  var sql = [
    'SELECT p.PtDetailsTID, p.UnitTBNo, p.RegDate, p.PtName, p.Age,',
    '       p.Village, p.Payam, p.PtPhone, p.PtTypeID, p.NearestHFID,',
    '       s.Sex, pt.PtTypeShort,',
    '       COALESCE(hf.HealthFacility,\'\') AS HealthFacility',
    'FROM PtDetailsT p',
    'INNER JOIN PtFollowUpT fu ON p.PtDetailsTID = fu.PtDetailsTID AND fu.Deleted = 0',
    'LEFT JOIN SexT         s  ON p.SexID  = s.SexID',
    'LEFT JOIN PtTypeT      pt ON p.PtTypeID = pt.PtTypeID',
    'LEFT JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID',
    'WHERE p.Deleted = 0',
    "  AND p.DateRxStarted IS NOT NULL AND p.DateRxStarted != ''",
    "  AND p.PtName IS NOT NULL AND p.PtName != ''",
    // TODO(user-prefs): 365-day limit on RegDate — make configurable in user preferences
    "  AND CAST(julianday('now') - julianday(p.RegDate) AS INTEGER) <= 365",
    '  AND COALESCE(fu.OutcomeID, 0) IN (0, 7)',
    '  AND fu.HIVTestResultID = 2',
    '  AND COALESCE(fu.OnCPT, 0) = 0',
    '  ' + hf,
    'ORDER BY p.RegDate DESC'
  ].join('\n');
  try { return _monRows(_db.exec(sql)); } catch (e) { console.error('[MonDB] CPT query:', e.message); return []; }
}

/** ART due: HIV-positive active patients who have not started ART. */
function getTBMonART(facilityIDs) {
  if (!_db) return [];
  var hf = _monFacilityFilter(facilityIDs);
  var sql = [
    'SELECT p.PtDetailsTID, p.UnitTBNo, p.RegDate, p.PtName, p.Age,',
    '       p.Village, p.Payam, p.PtPhone, p.PtTypeID, p.NearestHFID,',
    '       s.Sex, pt.PtTypeShort,',
    '       COALESCE(hf.HealthFacility,\'\') AS HealthFacility',
    'FROM PtDetailsT p',
    'INNER JOIN PtFollowUpT fu ON p.PtDetailsTID = fu.PtDetailsTID AND fu.Deleted = 0',
    'LEFT JOIN SexT         s  ON p.SexID  = s.SexID',
    'LEFT JOIN PtTypeT      pt ON p.PtTypeID = pt.PtTypeID',
    'LEFT JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID',
    'WHERE p.Deleted = 0',
    "  AND p.DateRxStarted IS NOT NULL AND p.DateRxStarted != ''",
    "  AND p.PtName IS NOT NULL AND p.PtName != ''",
    // TODO(user-prefs): 365-day limit on RegDate — make configurable in user preferences
    "  AND CAST(julianday('now') - julianday(p.RegDate) AS INTEGER) <= 365",
    '  AND COALESCE(fu.OutcomeID, 0) IN (0, 7)',
    '  AND fu.HIVTestResultID = 2',
    '  AND COALESCE(fu.OnART, 0) = 0',
    '  ' + hf,
    'ORDER BY p.RegDate DESC'
  ].join('\n');
  try { return _monRows(_db.exec(sql)); } catch (e) { console.error('[MonDB] ART query:', e.message); return []; }
}

/**
 * DOTS outcome missing: patients who started treatment long ago with no outcome.
 * New cases (PtTypeID 1): > 168 days (6 TB months × 28)
 * Retreatment cases (PtTypeID 2/3/4): > 252 days (9 TB months × 28)
 */
function getTBMonOutcomeMissing(facilityIDs) {
  if (!_db) return [];
  var hf = _monFacilityFilter(facilityIDs);
  var sql = [
    'SELECT p.PtDetailsTID, p.UnitTBNo, p.RegDate, p.PtName, p.Age,',
    '       p.Village, p.Payam, p.PtPhone, p.PtTypeID, p.NearestHFID,',
    '       s.Sex, pt.PtTypeShort,',
    '       COALESCE(hf.HealthFacility,\'\') AS HealthFacility,',
    "       CAST(julianday('now') - julianday(p.DateRxStarted) AS INTEGER) AS DaysSinceStart",
    'FROM PtDetailsT p',
    'LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID = fu.PtDetailsTID AND fu.Deleted = 0',
    'LEFT JOIN SexT         s  ON p.SexID  = s.SexID',
    'LEFT JOIN PtTypeT      pt ON p.PtTypeID = pt.PtTypeID',
    'LEFT JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID',
    'WHERE p.Deleted = 0',
    "  AND p.DateRxStarted IS NOT NULL AND p.DateRxStarted != ''",
    "  AND p.PtName IS NOT NULL AND p.PtName != ''",
    '  AND p.PtTypeID <> 5',
    '  AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.OutcomeID, 0) IN (0, 7))',
    '  AND (',
    // TODO(user-prefs): day bounds for outcome — make configurable in user preferences
    "    (p.PtTypeID = 1 AND CAST(julianday('now')-julianday(p.DateRxStarted) AS INTEGER) BETWEEN 168 AND 270)",
    '    OR',
    "    (p.PtTypeID <> 1 AND CAST(julianday('now')-julianday(p.DateRxStarted) AS INTEGER) BETWEEN 224 AND 320)",
    '  )',
    '  ' + hf,
    'ORDER BY p.RegDate DESC'
  ].join('\n');
  try { return _monRows(_db.exec(sql)); } catch (e) { console.error('[MonDB] outcome query:', e.message); return []; }
}

/**
 * Returns patient rows for the given monitoring category and mode.
 * @param {string}   category  - '2month'|'3month'|'5month'|'6month'|'8month'|'hiv'|'cpt'|'art'|'hhp'|'outcome'
 * @param {string}   mode      - 'missed' | 'due'
 * @param {number[]} facilityIDs - empty = all facilities
 */
function getTBMonList(category, mode, facilityIDs) {
  switch (category) {
    case '2month':  return getTBMonSputum2(mode, facilityIDs);
    case '3month':  return getTBMonSputum3(mode, facilityIDs);
    case '5month':  return getTBMonSputum5(mode, facilityIDs);
    case '6month':  return getTBMonSputum6(mode, facilityIDs);
    case '8month':  return getTBMonSputum8(mode, facilityIDs);
    case 'hiv':     return getTBMonHIV(facilityIDs);
    case 'cpt':     return getTBMonCPT(facilityIDs);
    case 'art':     return getTBMonART(facilityIDs);
    case 'hhp':     return [];   // placeholder — HHP tracking not yet in schema
    case 'outcome': return getTBMonOutcomeMissing(facilityIDs);
    default:        return [];
  }
}

/**
 * Computes counts for all monitoring categories in a single call.
 * 'mode' affects only the sputum-examination categories.
 */
function getTBMonCounts(facilityIDs, mode) {
  return {
    sputum2:  getTBMonSputum2(mode, facilityIDs).length,
    sputum3:  getTBMonSputum3(mode, facilityIDs).length,
    sputum5:  getTBMonSputum5(mode, facilityIDs).length,
    sputum6:  getTBMonSputum6(mode, facilityIDs).length,
    sputum8:  getTBMonSputum8(mode, facilityIDs).length,
    hiv:      getTBMonHIV(facilityIDs).length,
    cpt:      getTBMonCPT(facilityIDs).length,
    art:      getTBMonART(facilityIDs).length,
    hhp:      0,
    outcome:  getTBMonOutcomeMissing(facilityIDs).length
  };
}

/**
 * Returns facilities that have at least one non-deleted TB patient locally.
 * Optionally filtered by stateID and/or countyID (positive integers).
 */
function getMonitoringFacilities(stateID, countyID) {
  if (!_db) return [];
  var stateInt  = stateID  ? Number(stateID)  : 0;
  var countyInt = countyID ? Number(countyID) : 0;
  var where = '';
  if (stateInt  > 0) where += ' AND hf.StateID = '  + stateInt;
  if (countyInt > 0) where += ' AND hf.CountyID = ' + countyInt;
  var sql = [
    'SELECT DISTINCT hf.HealthFacilityID, hf.HealthFacility, hf.StateID, hf.CountyID',
    'FROM PtDetailsT p',
    'INNER JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID',
    'WHERE p.Deleted = 0 AND hf.HealthFacilityID > 0' + where,
    'ORDER BY hf.HealthFacility'
  ].join('\n');
  try { return _monRows(_db.exec(sql)); } catch (e) { console.error('[MonDB] facilities:', e.message); return []; }
}

/** Returns distinct states that have TB patients in the local DB. */
function getMonitoringStates() {
  if (!_db) return [];
  var sql = [
    'SELECT DISTINCT s.StateID, s.State',
    'FROM PtDetailsT p',
    'INNER JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID',
    'INNER JOIN StateT s ON hf.StateID = s.StateID',
    'WHERE p.Deleted = 0',
    'ORDER BY s.State'
  ].join('\n');
  try { return _monRows(_db.exec(sql)); } catch (e) { console.error('[MonDB] states:', e.message); return []; }
}

/**
 * Returns distinct counties that have TB patients in the local DB.
 * Optionally filtered by stateID.
 */
function getMonitoringCounties(stateID) {
  if (!_db) return [];
  var stateInt = stateID ? Number(stateID) : 0;
  var stateWhere = stateInt > 0 ? ' AND hf.StateID = ' + stateInt : '';
  var sql = [
    'SELECT DISTINCT c.CountyID, c.County',
    'FROM PtDetailsT p',
    'INNER JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID',
    'INNER JOIN CountyT c ON hf.CountyID = c.CountyID',
    'WHERE p.Deleted = 0' + stateWhere,
    'ORDER BY c.County'
  ].join('\n');
  try { return _monRows(_db.exec(sql)); } catch (e) { console.error('[MonDB] counties:', e.message); return []; }
}

/**
 * Returns facility metadata (with county and state names) for a given facility ID.
 * Used when navigating from monitoring to the data-entry register.
 */
function getMonitoringFacilityInfo(facilityID) {
  if (!_db) return null;
  var id = Number(facilityID);
  if (!id || id < 1) return null;
  var sql = 'SELECT HealthFacilityID, HealthFacility, CountyID, County, StateID, State' +
            ' FROM vwGeogAreaQ WHERE HealthFacilityID = ' + id + ' LIMIT 1';
  try {
    var rows = _monRows(_db.exec(sql));
    return rows.length ? rows[0] : null;
  } catch (e) {
    console.error('[MonDB] facilityInfo:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  DATA QUALITY CHECKS  (DS-TB Register)
// ─────────────────────────────────────────────────────────────────────────────

function _dqSafeFacilityIDs(ids) {
  if (!ids || !ids.length) return [];
  return ids.map(Number).filter(function(id) { return Number.isInteger(id) && id > 0; });
}

function _dqFacilityFilter(ids, alias) {
  var a    = alias || 'p';
  var safe = _dqSafeFacilityIDs(ids);
  return safe.length ? 'AND ' + a + '.NearestHFID IN (' + safe.join(',') + ')' : '';
}

function _dqRows(r) {
  if (!r || !r.length) return [];
  var cols = r[0].columns;
  return r[0].values.map(function(row) {
    var obj = {};
    for (var i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
    return obj;
  });
}

/** Convenience: run a COUNT SQL and return the integer result. */
function _dqCount(sql) {
  try {
    var r = _db.exec(sql);
    return (r && r.length && r[0].values.length) ? (r[0].values[0][0] || 0) : 0;
  } catch (e) {
    console.error('[DQ] count error:', e.message, sql.substring(0, 100));
    return 0;
  }
}

/**
 * Standard FROM + JOINs block shared by most quality-check queries.
 * Alias 'p' for PtDetailsT.
 */
var _DQ_JOINS = [
  'FROM PtDetailsT p',
  'LEFT JOIN SexT          s  ON p.SexID        = s.SexID',
  'LEFT JOIN PtTypeT       pt ON p.PtTypeID     = pt.PtTypeID',
  'LEFT JOIN TbTypeT       tt ON p.TbTypeID     = tt.TbTypeID',
  'LEFT JOIN DiagMethodT   dm ON p.DiagMethodID = dm.DiagMethodID',
  'LEFT JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID',
].join('\n');

/** Standard SELECT columns for quality-check patient rows. */
var _DQ_COLS = [
  'p.PtDetailsTID, p.UnitTBNo, p.RegDate, p.PtName, p.Age, p.AgeMonths,',
  'p.Village, p.Payam, p.PtPhone, p.SexID, p.TbTypeID, p.PtTypeID,',
  'p.DiagMethodID, p.DateRxStarted, p.NearestHFID,',
  "COALESCE(s.Sex,'')         AS Sex,",
  "COALESCE(pt.PtTypeShort,'') AS PtTypeShort,",
  "COALESCE(tt.TbType,'')     AS TbType,",
  "COALESCE(dm.DiagMethod,'') AS DiagMethod,",
  "COALESCE(hf.HealthFacility,'') AS HealthFacility",
].join('\n       ');

/** All non-deleted DS-TB patients. */
function getDQAllPatients(facilityIDs) {
  if (!_db) return [];
  var hf  = _dqFacilityFilter(facilityIDs, 'p');
  var sql = 'SELECT ' + _DQ_COLS + '\n' + _DQ_JOINS + '\nWHERE p.Deleted = 0 ' + hf + '\nORDER BY p.PtName';
  try { return _dqRows(_db.exec(sql)); }
  catch (e) { console.error('[DQ] all:', e.message); return []; }
}

/**
 * Patients who may have been entered twice — another record exists with the
 * same PtName, Age, SexID, UnitTBNo, AND RegDate within the facility set.
 */
function getDQDuplicates(facilityIDs) {
  if (!_db) return [];
  var outerHF = _dqFacilityFilter(facilityIDs, 'p');
  var innerHF = _dqFacilityFilter(facilityIDs, 'd');
  var sql = [
    'SELECT ' + _DQ_COLS,
    _DQ_JOINS,
    'WHERE p.Deleted = 0 ' + outerHF,
    "AND p.PtName != ''",
    // 365-day rolling window — TODO: configurable via user preferences
    "AND CAST(julianday('now') - julianday(p.RegDate) AS INTEGER) < 365",
    'AND EXISTS (',
    '  SELECT 1 FROM PtDetailsT d',
    '  WHERE d.Deleted = 0 AND d.PtDetailsTID != p.PtDetailsTID ' + innerHF,
    "  AND d.PtName != ''",
    '  AND UPPER(TRIM(d.PtName))      = UPPER(TRIM(p.PtName))',
    '  AND COALESCE(d.Age, -1)        = COALESCE(p.Age, -1)',
    '  AND COALESCE(d.PtTypeID, -1)   = COALESCE(p.PtTypeID, -1)',
    "  AND COALESCE(d.RegDate, '')    = COALESCE(p.RegDate, '')",
    ')',
    'ORDER BY p.PtName, p.RegDate',
  ].join('\n');
  try { return _dqRows(_db.exec(sql)); }
  catch (e) { console.error('[DQ] duplicates:', e.message); return []; }
}

/**
 * Build the shared CTE SQL prefix for the "skipped during data entry" gap analysis.
 *
 * BACKGROUND (ported from a 10-year-old MS Access / VBA implementation):
 *
 * Unit TB numbers are serial integers that reset to 1 every calendar year and
 * are unique only within a single health facility.  If a facility's register
 * shows numbers 1 … 100, all 100 records should exist in the system.  Any gap
 * (e.g., 88 exists and 90 exists but 89 does not) means patient #89 was
 * written in the paper register but never entered digitally.
 *
 * NORMALISATION:
 * The same number can be stored in many formats:
 *   21  →  021  →  021/26  →  021/2026  →  021-RUM  →  021\2026
 * SQLite's CAST(text AS INTEGER) stops at the first non-digit character, so
 * it automatically strips slashes, dashes, and year/acronym suffixes.
 * Backslashes are replaced with forward slashes first for consistency.
 * The result (TBNoB) is filtered to 0 < TBNoB < 2000 to reject:
 *   • non-numeric strings (CAST returns 0 for 'ABC' etc.)
 *   • year-first formats like '2026/021' where CAST gives 2026, not 21
 *
 * SCOPE:
 *   • Transfer-In patients (PtTypeID = 5) are excluded — they arrive with a
 *     number from their origin facility and do not occupy a slot in the new
 *     register.
 *   • Only the current and previous calendar year are examined; patients
 *     complete treatment within 2 years, so older TB numbers are irrelevant.
 *
 * ALGORITHM:
 *   1. normalized — extract TBNoB from every eligible record
 *   2. valid      — keep only sensible serial numbers (0 < TBNoB < 2000)
 *   3. ranges     — find MIN/MAX TBNoB per (facility, year)
 *   4. ideal      — recursive CTE generates every integer MIN…MAX (the
 *                   "ideal" sequence that should exist)
 *   5. gaps       — left-join ideal against valid; unmatched slots are gaps
 *
 * @param {string} hfFilter  SQL fragment "AND p.NearestHFID IN (...)" or ''
 * @param {number} minYear   Earliest RegYear to include (usually currentYear - 1)
 * @returns {string}  Complete CTE block, ready for a SELECT … FROM gaps suffix
 */
function _dqSkippedCTE(hfFilter, minYear) {
  return [
    'WITH RECURSIVE',
    'normalized AS (',
    '  SELECT',
    '    p.PtDetailsTID,',
    '    p.NearestHFID,',
    "    CAST(strftime('%Y', p.RegDate) AS INTEGER) AS RegYear,",
    "    CAST(REPLACE(COALESCE(p.UnitTBNo,''), '\\', '/') AS INTEGER) AS TBNoB",
    '  FROM PtDetailsT p',
    '  WHERE p.Deleted = 0',
    '    AND p.NearestHFID IS NOT NULL',
    '    AND p.PtTypeID <> 5',
    "    AND p.RegDate IS NOT NULL AND p.RegDate != ''",
    "    AND CAST(strftime('%Y', p.RegDate) AS INTEGER) >= " + minYear,
    "    AND p.UnitTBNo IS NOT NULL AND p.UnitTBNo != ''",
    '    ' + hfFilter,
    '),',
    'valid AS (',
    '  SELECT PtDetailsTID, NearestHFID, RegYear, TBNoB',
    '  FROM normalized',
    '  WHERE TBNoB > 0 AND TBNoB < 10000 AND NOT (TBNoB BETWEEN 2000 AND 2099)',
    '),',
    'ranges AS (',
    '  SELECT NearestHFID, RegYear, MIN(TBNoB) AS MinNo, MAX(TBNoB) AS MaxNo',
    '  FROM valid',
    '  GROUP BY NearestHFID, RegYear',
    '),',
    'ideal(NearestHFID, RegYear, SeqNo, MaxNo) AS (',
    '  SELECT NearestHFID, RegYear, MinNo, MaxNo FROM ranges WHERE MaxNo > 0',
    '  UNION ALL',
    '  SELECT NearestHFID, RegYear, SeqNo + 1, MaxNo FROM ideal WHERE SeqNo < MaxNo',
    '),',
    'gaps AS (',
    '  SELECT i.NearestHFID, i.RegYear, i.SeqNo AS MissingTBNo',
    '  FROM ideal i',
    '  LEFT JOIN valid v',
    '         ON v.NearestHFID = i.NearestHFID',
    '        AND v.RegYear     = i.RegYear',
    '        AND v.TBNoB       = i.SeqNo',
    '  WHERE v.PtDetailsTID IS NULL',
    ')',
  ].join('\n');
}

/**
 * Returns gap rows — TB number slots that should exist (based on the
 * MIN…MAX range per facility+year) but have no matching patient record.
 * Each row: { NearestHFID, RegYear, MissingTBNo, HealthFacility }
 */
function getDQSkipped(facilityIDs) {
  if (!_db) return [];
  var hfFilter = _dqFacilityFilter(facilityIDs, 'p');
  var minYear  = new Date().getFullYear() - 1;
  var sql = _dqSkippedCTE(hfFilter, minYear) + '\n' + [
    'SELECT',
    '  g.NearestHFID,',
    '  g.RegYear,',
    '  g.MissingTBNo,',
    "  COALESCE(hf.HealthFacility, '') AS HealthFacility",
    'FROM gaps g',
    'LEFT JOIN HealthFacilityT hf ON hf.HealthFacilityID = g.NearestHFID',
    'ORDER BY g.RegYear DESC, g.MissingTBNo DESC, hf.HealthFacility ASC',
  ].join('\n');
  try { return _dqRows(_db.exec(sql)); }
  catch (e) { console.error('[DQ] skipped:', e.message); return []; }
}

/**
 * Patients sharing the same normalized TB number within a facility+year.
 * Normalizes UnitTBNo → TBNoB the same way _dqSkippedCTE does, so raw values
 * like '002' and '02/2026' resolve to the same (NearestHFID, RegYear, TBNoB=2)
 * and are correctly detected as duplicates.
 */
function getDQSameTBNo(facilityIDs) {
  if (!_db) return [];
  var hf  = _dqFacilityFilter(facilityIDs, 'p');
  var sql = [
    'WITH normalized AS (',
    '  SELECT',
    '    p.PtDetailsTID,',
    '    p.NearestHFID,',
    "    CAST(strftime('%Y', p.RegDate) AS INTEGER) AS RegYear,",
    "    CAST(REPLACE(COALESCE(p.UnitTBNo,''), '\\', '/') AS INTEGER) AS TBNoB",
    '  FROM PtDetailsT p',
    "  WHERE p.Deleted = 0 AND p.UnitTBNo IS NOT NULL AND p.UnitTBNo != ''",
    "    AND p.RegDate IS NOT NULL AND p.RegDate != ''",
    '    ' + hf,
    '),',
    'dupes AS (',
    '  SELECT NearestHFID, RegYear, TBNoB',
    '  FROM normalized WHERE TBNoB > 0',
    '  GROUP BY NearestHFID, RegYear, TBNoB HAVING COUNT(*) > 1',
    ')',
    'SELECT ' + _DQ_COLS,
    _DQ_JOINS,
    'JOIN normalized n  ON n.PtDetailsTID = p.PtDetailsTID',
    'JOIN dupes      dk ON dk.NearestHFID = n.NearestHFID',
    '                  AND dk.RegYear     = n.RegYear',
    '                  AND dk.TBNoB       = n.TBNoB',
    'WHERE p.Deleted = 0 ' + hf,
    'ORDER BY n.RegYear DESC, n.TBNoB, p.RegDate',
  ].join('\n');
  try { return _dqRows(_db.exec(sql)); }
  catch (e) { console.error('[DQ] sametbno:', e.message); return []; }
}

/**
 * Patients declared Cured but who were NOT bacteriologically confirmed.
 * Only bacteriologically-confirmed cases may be declared Cured; others should
 * be recorded as Treatment Completed.
 *
 * Smear-positive codes:  Mon0LabResultID  IN (1,4,5,6)  — Scanty, 1+, 2+, 3+
 * Xpert-positive codes:  Mon0XpertResultID IN (3,4,5)   — T, TI, RR
 */
function getDQSmearNegCured(facilityIDs) {
  if (!_db) return [];
  var hf  = _dqFacilityFilter(facilityIDs, 'p');
  var sql = [
    'SELECT ' + _DQ_COLS + ",",
    "       COALESCE(o.Outcome,'') AS Outcome",
    'FROM PtDetailsT p',
    'LEFT JOIN PtFollowUpT    fu ON p.PtDetailsTID = fu.PtDetailsTID AND fu.Deleted = 0',
    'LEFT JOIN SexT           s  ON p.SexID        = s.SexID',
    'LEFT JOIN PtTypeT        pt ON p.PtTypeID     = pt.PtTypeID',
    'LEFT JOIN TbTypeT        tt ON p.TbTypeID     = tt.TbTypeID',
    'LEFT JOIN DiagMethodT    dm ON p.DiagMethodID = dm.DiagMethodID',
    'LEFT JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID',
    'LEFT JOIN OutcomeT        o  ON fu.OutcomeID  = o.OutcomeID',
    'WHERE p.Deleted = 0',
    '  AND p.PtTypeID <> 5',                                         // exclude Transfer-In
    '  AND p.DateRxStarted IS NOT NULL',
    '  AND COALESCE(fu.OutcomeID, 0) = 1',                           // Cured
    '  AND COALESCE(fu.Mon0LabResultID, 0) NOT IN (1,4,5,6)',        // not smear-positive
    '  AND COALESCE(fu.Mon0XpertResultID, 0) NOT IN (3,4,5)',        // not Xpert-positive
    "  AND ((p.PtTypeID = 1 AND CAST(julianday('now') - julianday(p.DateRxStarted) AS INTEGER) BETWEEN 180 AND 540)",
    "   OR  (p.PtTypeID <> 1 AND CAST(julianday('now') - julianday(p.DateRxStarted) AS INTEGER) BETWEEN 240 AND 600))",
    '  ' + hf,
    'ORDER BY p.PtName',
  ].join('\n');
  try { return _dqRows(_db.exec(sql)); }
  catch (e) { console.error('[DQ] smearcured:', e.message); return []; }
}

/**
 * Patients with one or more key registration fields missing:
 * Age = 0, Sex not set, TB Site not set, Patient Type not set, or Reg Date missing.
 * Returns a MissingFields string built inside SQL.
 */
function getDQMissingRegInfo(facilityIDs) {
  if (!_db) return [];
  var hf  = _dqFacilityFilter(facilityIDs, 'p');
  var missingExpr = [
    "RTRIM(",
    "  CASE WHEN p.PtName IS NULL OR p.PtName = ''          THEN 'Patient Name, '        ELSE '' END ||",
    "  CASE WHEN p.UnitTBNo IS NULL OR TRIM(p.UnitTBNo) = '' THEN 'Unit TB No, '          ELSE '' END ||",
    "  CASE WHEN p.Age = 0 OR p.Age IS NULL                 THEN 'Age, '                 ELSE '' END ||",
    "  CASE WHEN p.SexID IN (0,3) OR p.SexID IS NULL        THEN 'Sex, '                 ELSE '' END ||",
    "  CASE WHEN p.TbTypeID IN (0,4) OR p.TbTypeID IS NULL  THEN 'TB Site, '             ELSE '' END ||",
    "  CASE WHEN p.PtTypeID IN (0,7) OR p.PtTypeID IS NULL  THEN 'Patient Type, '        ELSE '' END ||",
    "  CASE WHEN p.NearestHFID IS NULL OR p.NearestHFID = 0 THEN 'Treatment Facility, '  ELSE '' END ||",
    "  CASE WHEN p.RegDate IS NULL OR p.RegDate = ''        THEN 'Reg Date, '            ELSE '' END ||",
    "  CASE WHEN p.DateRxStarted IS NULL OR p.DateRxStarted = '' THEN 'Rx Start Date, '  ELSE '' END ||",
    "  CASE WHEN p.DiagMethodID = 0 OR p.DiagMethodID IS NULL THEN 'Diag Method, '       ELSE '' END,",
    "', ') AS MissingFields",
  ].join('\n       ');
  var sql = [
    'SELECT ' + _DQ_COLS + ',',
    '       ' + missingExpr,
    _DQ_JOINS,
    'WHERE p.Deleted = 0',
    "  AND (p.RegDate IS NULL OR p.RegDate = '' OR p.RegDate >= date('now', '-540 days'))",
    "  AND (p.PtName IS NULL OR p.PtName = ''",
    "       OR p.UnitTBNo IS NULL OR TRIM(p.UnitTBNo) = ''",
    '       OR p.Age = 0 OR p.Age IS NULL',
    '       OR p.SexID IN (0,3) OR p.SexID IS NULL',
    '       OR p.TbTypeID IN (0,4) OR p.TbTypeID IS NULL',
    '       OR p.PtTypeID IN (0,7) OR p.PtTypeID IS NULL',
    '       OR p.NearestHFID IS NULL OR p.NearestHFID = 0',
    "       OR p.RegDate IS NULL OR p.RegDate = ''",
    "       OR p.DateRxStarted IS NULL OR p.DateRxStarted = ''",
    '       OR p.DiagMethodID = 0 OR p.DiagMethodID IS NULL)',
    '  ' + hf,
    'ORDER BY p.PtName',
  ].join('\n');
  try { return _dqRows(_db.exec(sql)); }
  catch (e) { console.error('[DQ] missingreg:', e.message); return []; }
}

/**
 * Patients who are past their expected treatment end date with no DOTS outcome
 * recorded (OutcomeID = 0, 7, or no follow-up row at all).
 *
 * Treatment durations: New (PtTypeID=1) 180–540 days, Retreatment/Others 240–600 days.
 * PtTypeID IN (0,5,7) excluded (unknown / Transfer-In / placeholder).
 */
function getDQNoOutcome(facilityIDs) {
  if (!_db) return [];
  var hf  = _dqFacilityFilter(facilityIDs, 'p');
  var days = "CAST(julianday('now') - julianday(p.DateRxStarted) AS INTEGER)";
  var sql = [
    'SELECT ' + _DQ_COLS + ',',
    "       COALESCE(o.Outcome,'') AS Outcome,",
    '       ' + days + ' AS DaysSinceStart',
    'FROM PtDetailsT p',
    'LEFT JOIN PtFollowUpT    fu ON p.PtDetailsTID = fu.PtDetailsTID AND fu.Deleted = 0',
    'LEFT JOIN SexT           s  ON p.SexID        = s.SexID',
    'LEFT JOIN PtTypeT        pt ON p.PtTypeID     = pt.PtTypeID',
    'LEFT JOIN TbTypeT        tt ON p.TbTypeID     = tt.TbTypeID',
    'LEFT JOIN DiagMethodT    dm ON p.DiagMethodID = dm.DiagMethodID',
    'LEFT JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID',
    'LEFT JOIN OutcomeT        o  ON fu.OutcomeID  = o.OutcomeID',
    'WHERE p.Deleted = 0',
    "  AND p.DateRxStarted IS NOT NULL AND p.DateRxStarted != ''",
    "  AND p.PtName IS NOT NULL AND p.PtName != ''",
    '  AND p.PtTypeID NOT IN (0, 5, 7)',
    '  AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.OutcomeID, 0) IN (0, 7))',
    // TODO: configurable via user preferences — DQ_NOOUTCOME_DAYS: new 180–540, retreatment 240–600
    '  AND (',
    '    (p.PtTypeID = 1          AND ' + days + ' BETWEEN 180 AND 540)',
    '    OR',
    '    (p.PtTypeID IN (2,3,4,6) AND ' + days + ' BETWEEN 240 AND 600)',
    '  )',
    '  ' + hf,
    'ORDER BY p.DateRxStarted DESC',
  ].join('\n');
  try { return _dqRows(_db.exec(sql)); }
  catch (e) { console.error('[DQ] nooutcome:', e.message); return []; }
}

/** Patients with no TB diagnostic method recorded (DiagMethodID = 0 or null). */
function getDQDiagMethodMissing(facilityIDs) {
  if (!_db) return [];
  var hf  = _dqFacilityFilter(facilityIDs, 'p');
  var sql = [
    'SELECT ' + _DQ_COLS,
    _DQ_JOINS,
    'WHERE p.Deleted = 0 AND COALESCE(p.DiagMethodID, 0) = 0' +
    " AND CAST(julianday('now') - julianday(p.RegDate) AS INTEGER) < 180 " + hf,
    'ORDER BY p.PtName',
  ].join('\n');
  try { return _dqRows(_db.exec(sql)); }
  catch (e) { console.error('[DQ] diagmethod:', e.message); return []; }
}

/**
 * Patients registered more than 14 days ago but with no treatment start date.
 * Suggests the patient was registered but treatment was never initiated or recorded.
 */
function getDQNoTreatmentStart(facilityIDs) {
  if (!_db) return [];
  var hf  = _dqFacilityFilter(facilityIDs, 'p');
  var sql = [
    'SELECT ' + _DQ_COLS + ',',
    "       CAST(julianday('now') - julianday(p.RegDate) AS INTEGER) AS DaysSinceReg",
    _DQ_JOINS,
    'WHERE p.Deleted = 0',
    "  AND (p.DateRxStarted IS NULL OR p.DateRxStarted = '')",
    "  AND p.RegDate IS NOT NULL AND p.RegDate != ''",
    "  AND CAST(julianday('now') - julianday(p.RegDate) AS INTEGER) > 14",
    "  AND CAST(julianday('now') - julianday(p.RegDate) AS INTEGER) < 180",
    '  ' + hf,
    'ORDER BY p.RegDate',
  ].join('\n');
  try { return _dqRows(_db.exec(sql)); }
  catch (e) { console.error('[DQ] norxstart:', e.message); return []; }
}

/** Soft-deleted patients (Deleted = 1) — can be restored. */
function getDQDeletedPatients(facilityIDs) {
  if (!_db) return [];
  var hf  = _dqFacilityFilter(facilityIDs, 'p');
  var sql = [
    'SELECT ' + _DQ_COLS,
    _DQ_JOINS,
    'WHERE p.Deleted = 1 ' + hf,
    'ORDER BY p.PtName',
  ].join('\n');
  try { return _dqRows(_db.exec(sql)); }
  catch (e) { console.error('[DQ] deleted:', e.message); return []; }
}

// ─── Pre-Report Data Quality Checks (date-range filtered) ─────────────────

/**
 * Returns DQ issue counts filtered to the date ranges of a specific TB quarterly report.
 *
 * CF period (cfStart–cfEnd)  — registration-based checks: duplicates, missing info, diag method, same TB no.
 * TO period (toStart–toEnd)  — outcome-based checks: patients from one year ago who should have outcomes.
 * cfYear                     — used to scope the skipped-TB-number check to the relevant years.
 *
 * @param {number[]} facilityIDs
 * @param {string}   cfStart   YYYY-MM-DD
 * @param {string}   cfEnd     YYYY-MM-DD
 * @param {string}   toStart   YYYY-MM-DD
 * @param {string}   toEnd     YYYY-MM-DD
 * @param {number}   cfYear    Calendar year of the CF period
 */
function getDQCountsForReport(facilityIDs, cfStart, cfEnd, toStart, toEnd, cfYear, scStart, scEnd) {
  if (!_db) return { duplicates:0, sametbno:0, missingreg:0, diagmethod:0, scmissed2:0, scmissed3:0, nooutcome:0, smearcured:0, skipped:0 };

  var outerHF = _dqFacilityFilter(facilityIDs, 'p');
  var innerHF = _dqFacilityFilter(facilityIDs, 'd');
  var cfF = " AND p.RegDate >= '" + cfStart + "' AND p.RegDate <= '" + cfEnd + "'";
  var toF = " AND p.DateRxStarted >= '" + toStart + "' AND p.DateRxStarted <= '" + toEnd + "'";
  var scF = (scStart && scEnd) ? " AND p.DateRxStarted >= '" + scStart + "' AND p.DateRxStarted <= '" + scEnd + "'" : '';
  var minYear = (cfYear || new Date().getFullYear()) - 1;

  return {
    duplicates: _dqCount(
      'SELECT COUNT(*) FROM PtDetailsT p WHERE p.Deleted = 0 ' + outerHF + cfF +
      " AND p.PtName != ''" +
      ' AND EXISTS (SELECT 1 FROM PtDetailsT d' +
      '  WHERE d.Deleted = 0 AND d.PtDetailsTID != p.PtDetailsTID ' + innerHF +
      "  AND d.PtName != '' AND UPPER(TRIM(d.PtName)) = UPPER(TRIM(p.PtName))" +
      '  AND COALESCE(d.Age,-1)      = COALESCE(p.Age,-1)' +
      '  AND COALESCE(d.PtTypeID,-1) = COALESCE(p.PtTypeID,-1)' +
      "  AND COALESCE(d.RegDate,'')  = COALESCE(p.RegDate,''))"),

    sametbno: _dqCount(
      "WITH norm AS (SELECT p.PtDetailsTID, p.NearestHFID, CAST(strftime('%Y',p.RegDate) AS INTEGER) AS RegYear," +
      " CAST(REPLACE(COALESCE(p.UnitTBNo,''),'\\','/') AS INTEGER) AS TBNoB" +
      " FROM PtDetailsT p WHERE p.Deleted=0 AND p.UnitTBNo IS NOT NULL AND p.UnitTBNo!=''" +
      " AND p.RegDate IS NOT NULL AND p.RegDate!='' AND p.RegDate>='" + cfStart + "' AND p.RegDate<='" + cfEnd + "' " + outerHF + '),' +
      'dupes AS (SELECT NearestHFID,RegYear,TBNoB FROM norm WHERE TBNoB>0 GROUP BY NearestHFID,RegYear,TBNoB HAVING COUNT(*)>1)' +
      ' SELECT COUNT(*) FROM norm n JOIN dupes dk ON dk.NearestHFID=n.NearestHFID AND dk.RegYear=n.RegYear AND dk.TBNoB=n.TBNoB WHERE n.TBNoB>0'),

    missingreg: _dqCount(
      'SELECT COUNT(*) FROM PtDetailsT p WHERE p.Deleted=0 ' + outerHF + cfF +
      " AND (p.PtName IS NULL OR p.PtName='' OR p.Age=0 OR p.Age IS NULL" +
      " OR p.SexID=0 OR p.TbTypeID=0 OR p.PtTypeID=0 OR p.RegDate IS NULL OR p.RegDate=''" +
      " OR p.DateRxStarted IS NULL OR p.DateRxStarted='' OR p.DiagMethodID=0)"),

    diagmethod: _dqCount(
      'SELECT COUNT(*) FROM PtDetailsT p WHERE p.Deleted=0 AND COALESCE(p.DiagMethodID,0)=0 ' + outerHF + cfF),

    scmissed2: _dqCount(
      'SELECT COUNT(*) FROM PtDetailsT p LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0' +
      ' WHERE p.Deleted=0' + scF +
      ' AND p.PtTypeID=1 AND p.TbTypeID=1' +
      ' AND (COALESCE(fu.Mon0LabResultID,0) IN (1,4,5,6) OR COALESCE(fu.Mon0XpertResultID,0) IN (3,4,5))' +
      ' AND COALESCE(fu.Mon2LabResultID,0) IN (0,3,7) ' + outerHF),

    scmissed3: _dqCount(
      'SELECT COUNT(*) FROM PtDetailsT p LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0' +
      ' WHERE p.Deleted=0' + scF +
      ' AND p.PtTypeID=1 AND p.TbTypeID=1' +
      ' AND (COALESCE(fu.Mon0LabResultID,0) IN (1,4,5,6) OR COALESCE(fu.Mon0XpertResultID,0) IN (3,4,5))' +
      ' AND COALESCE(fu.Mon2LabResultID,0) IN (1,4,5,6)' +
      ' AND COALESCE(fu.Mon3LabResultID,0) IN (0,3,7) ' + outerHF),

    nooutcome: _dqCount(
      'SELECT COUNT(*) FROM PtDetailsT p LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0' +
      ' WHERE p.Deleted=0' + toF +
      " AND p.DateRxStarted IS NOT NULL AND p.DateRxStarted!=''" +
      ' AND p.PtTypeID NOT IN (0,5,7)' +
      ' AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.OutcomeID,0) IN (0,7))' +
      " AND ((p.PtTypeID=1 AND CAST(julianday('now')-julianday(p.DateRxStarted) AS INTEGER)>168)" +
      "   OR (p.PtTypeID IN (2,3,4,6) AND CAST(julianday('now')-julianday(p.DateRxStarted) AS INTEGER)>224)) " + outerHF),

    smearcured: _dqCount(
      'SELECT COUNT(*) FROM PtDetailsT p LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0' +
      ' WHERE p.Deleted=0 AND p.PtTypeID <> 5' + toF +
      ' AND COALESCE(fu.OutcomeID,0)=1' +
      ' AND COALESCE(fu.Mon0LabResultID,0) NOT IN (1,4,5,6)' +
      ' AND COALESCE(fu.Mon0XpertResultID,0) NOT IN (3,4,5) ' + outerHF),

    skipped: _dqCount(
      _dqSkippedCTE(outerHF, minYear) + '\nSELECT COUNT(*) FROM gaps'),
  };
}

/**
 * Returns the patient list for a given DQ category, filtered to the report date ranges.
 * Used by the pre-report DQ modal's detail panel.
 *
 * @param {string}   category    One of: duplicates|sametbno|missingreg|diagmethod|nooutcome|smearcured|skipped
 * @param {number[]} facilityIDs
 * @param {string}   cfStart     YYYY-MM-DD  (registration period start)
 * @param {string}   cfEnd       YYYY-MM-DD  (registration period end)
 * @param {string}   toStart     YYYY-MM-DD  (treatment-outcome period start)
 * @param {string}   toEnd       YYYY-MM-DD  (treatment-outcome period end)
 * @param {number}   cfYear      Calendar year of the CF period (skipped check)
 */
function getDQListForReport(category, facilityIDs, cfStart, cfEnd, toStart, toEnd, cfYear, scStart, scEnd) {
  if (!_db) return [];
  var outerHF = _dqFacilityFilter(facilityIDs, 'p');
  var innerHF = _dqFacilityFilter(facilityIDs, 'd');
  var cfF     = " AND p.RegDate >= '" + cfStart + "' AND p.RegDate <= '" + cfEnd + "'";
  var toF     = " AND p.DateRxStarted >= '" + toStart + "' AND p.DateRxStarted <= '" + toEnd + "'";
  var scF     = (scStart && scEnd) ? " AND p.DateRxStarted >= '" + scStart + "' AND p.DateRxStarted <= '" + scEnd + "'" : '';
  var minYear = (cfYear || new Date().getFullYear()) - 1;

  try {
    switch (category) {
      case 'duplicates': return _dqRows(_db.exec([
        'SELECT ' + _DQ_COLS, _DQ_JOINS,
        'WHERE p.Deleted=0' + cfF + ' ' + outerHF,
        "AND p.PtName!=''",
        'AND EXISTS (SELECT 1 FROM PtDetailsT d WHERE d.Deleted=0 AND d.PtDetailsTID!=p.PtDetailsTID ' + innerHF,
        "  AND d.PtName!='' AND UPPER(TRIM(d.PtName))=UPPER(TRIM(p.PtName))",
        '  AND COALESCE(d.Age,-1)=COALESCE(p.Age,-1) AND COALESCE(d.SexID,-1)=COALESCE(p.SexID,-1)',
        "  AND COALESCE(d.UnitTBNo,'')=COALESCE(p.UnitTBNo,'') AND COALESCE(d.RegDate,'')=COALESCE(p.RegDate,''))",
        'ORDER BY p.PtName, p.RegDate',
      ].join('\n')));

      case 'sametbno': return _dqRows(_db.exec([
        "WITH norm AS (SELECT p.PtDetailsTID, p.NearestHFID, CAST(strftime('%Y',p.RegDate) AS INTEGER) AS RegYear,",
        "  CAST(REPLACE(COALESCE(p.UnitTBNo,''),'\\','/') AS INTEGER) AS TBNoB",
        "  FROM PtDetailsT p WHERE p.Deleted=0 AND p.UnitTBNo IS NOT NULL AND p.UnitTBNo!=''",
        "  AND p.RegDate IS NOT NULL AND p.RegDate!='' AND p.RegDate>='" + cfStart + "' AND p.RegDate<='" + cfEnd + "' " + outerHF + '),',
        'dupes AS (SELECT NearestHFID,RegYear,TBNoB FROM norm WHERE TBNoB>0 GROUP BY NearestHFID,RegYear,TBNoB HAVING COUNT(*)>1)',
        'SELECT ' + _DQ_COLS, _DQ_JOINS,
        'JOIN norm n ON n.PtDetailsTID=p.PtDetailsTID',
        'JOIN dupes dk ON dk.NearestHFID=n.NearestHFID AND dk.RegYear=n.RegYear AND dk.TBNoB=n.TBNoB',
        'WHERE p.Deleted=0 ' + outerHF,
        'ORDER BY n.RegYear DESC, n.TBNoB, p.RegDate',
      ].join('\n')));

      case 'missingreg': return _dqRows(_db.exec([
        'SELECT ' + _DQ_COLS + ',',
        "       RTRIM(CASE WHEN p.PtName IS NULL OR p.PtName='' THEN 'Patient Name, ' ELSE '' END ||",
        "       CASE WHEN p.UnitTBNo IS NULL OR TRIM(p.UnitTBNo)='' THEN 'Unit TB No, ' ELSE '' END ||",
        "       CASE WHEN p.Age=0 OR p.Age IS NULL THEN 'Age, ' ELSE '' END ||",
        "       CASE WHEN p.SexID IN (0,3) OR p.SexID IS NULL THEN 'Sex, ' ELSE '' END ||",
        "       CASE WHEN p.TbTypeID IN (0,4) OR p.TbTypeID IS NULL THEN 'TB Site, ' ELSE '' END ||",
        "       CASE WHEN p.PtTypeID IN (0,7) OR p.PtTypeID IS NULL THEN 'Patient Type, ' ELSE '' END ||",
        "       CASE WHEN p.NearestHFID IS NULL OR p.NearestHFID=0 THEN 'Treatment Facility, ' ELSE '' END ||",
        "       CASE WHEN p.RegDate IS NULL OR p.RegDate='' THEN 'Reg Date, ' ELSE '' END ||",
        "       CASE WHEN p.DateRxStarted IS NULL OR p.DateRxStarted='' THEN 'Rx Start, ' ELSE '' END ||",
        "       CASE WHEN p.DiagMethodID=0 OR p.DiagMethodID IS NULL THEN 'Diag Method, ' ELSE '' END, ', ') AS MissingFields",
        _DQ_JOINS,
        'WHERE p.Deleted=0' + cfF + ' ' + outerHF,
        "AND (p.PtName IS NULL OR p.PtName='' OR p.UnitTBNo IS NULL OR TRIM(p.UnitTBNo)=''",
        '   OR p.Age=0 OR p.Age IS NULL',
        '   OR p.SexID IN (0,3) OR p.SexID IS NULL',
        '   OR p.TbTypeID IN (0,4) OR p.TbTypeID IS NULL',
        '   OR p.PtTypeID IN (0,7) OR p.PtTypeID IS NULL',
        '   OR p.NearestHFID IS NULL OR p.NearestHFID=0',
        "   OR p.RegDate IS NULL OR p.RegDate=''",
        "   OR p.DateRxStarted IS NULL OR p.DateRxStarted='' OR p.DiagMethodID=0 OR p.DiagMethodID IS NULL)",
        'ORDER BY p.PtName',
      ].join('\n')));

      case 'diagmethod': return _dqRows(_db.exec([
        'SELECT ' + _DQ_COLS, _DQ_JOINS,
        'WHERE p.Deleted=0 AND COALESCE(p.DiagMethodID,0)=0' + cfF + ' ' + outerHF,
        'ORDER BY p.PtName',
      ].join('\n')));

      case 'scmissed2': return _dqRows(_db.exec([
        'SELECT ' + _DQ_COLS,
        'FROM PtDetailsT p',
        'LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0',
        'LEFT JOIN SexT s ON p.SexID=s.SexID LEFT JOIN PtTypeT pt ON p.PtTypeID=pt.PtTypeID',
        'LEFT JOIN TbTypeT tt ON p.TbTypeID=tt.TbTypeID LEFT JOIN DiagMethodT dm ON p.DiagMethodID=dm.DiagMethodID',
        'LEFT JOIN HealthFacilityT hf ON p.NearestHFID=hf.HealthFacilityID',
        'WHERE p.Deleted=0 AND p.PtTypeID=1 AND p.TbTypeID=1' + scF,
        '  AND (COALESCE(fu.Mon0LabResultID,0) IN (1,4,5,6) OR COALESCE(fu.Mon0XpertResultID,0) IN (3,4,5))',
        '  AND COALESCE(fu.Mon2LabResultID,0) IN (0,3,7) ' + outerHF,
        'ORDER BY p.DateRxStarted',
      ].join('\n')));

      case 'scmissed3': return _dqRows(_db.exec([
        'SELECT ' + _DQ_COLS,
        'FROM PtDetailsT p',
        'LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0',
        'LEFT JOIN SexT s ON p.SexID=s.SexID LEFT JOIN PtTypeT pt ON p.PtTypeID=pt.PtTypeID',
        'LEFT JOIN TbTypeT tt ON p.TbTypeID=tt.TbTypeID LEFT JOIN DiagMethodT dm ON p.DiagMethodID=dm.DiagMethodID',
        'LEFT JOIN HealthFacilityT hf ON p.NearestHFID=hf.HealthFacilityID',
        'WHERE p.Deleted=0 AND p.PtTypeID=1 AND p.TbTypeID=1' + scF,
        '  AND (COALESCE(fu.Mon0LabResultID,0) IN (1,4,5,6) OR COALESCE(fu.Mon0XpertResultID,0) IN (3,4,5))',
        '  AND COALESCE(fu.Mon2LabResultID,0) IN (1,4,5,6)',
        '  AND COALESCE(fu.Mon3LabResultID,0) IN (0,3,7) ' + outerHF,
        'ORDER BY p.DateRxStarted',
      ].join('\n')));

      case 'nooutcome': {
        var days = "CAST(julianday('now')-julianday(p.DateRxStarted) AS INTEGER)";
        return _dqRows(_db.exec([
          'SELECT ' + _DQ_COLS + ", p.RegimenID, COALESCE(o.Outcome,'') AS Outcome, " + days + ' AS DaysSinceStart',
          'FROM PtDetailsT p',
          'LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0',
          'LEFT JOIN SexT s ON p.SexID=s.SexID LEFT JOIN PtTypeT pt ON p.PtTypeID=pt.PtTypeID',
          'LEFT JOIN TbTypeT tt ON p.TbTypeID=tt.TbTypeID LEFT JOIN DiagMethodT dm ON p.DiagMethodID=dm.DiagMethodID',
          'LEFT JOIN HealthFacilityT hf ON p.NearestHFID=hf.HealthFacilityID LEFT JOIN OutcomeT o ON fu.OutcomeID=o.OutcomeID',
          'WHERE p.Deleted=0' + toF,
          "  AND p.DateRxStarted IS NOT NULL AND p.DateRxStarted!='' AND p.PtTypeID NOT IN (0,5,7)",
          '  AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.OutcomeID,0) IN (0,7))',
          '  AND ((p.PtTypeID=1 AND ' + days + '>168) OR (p.PtTypeID IN (2,3,4,6) AND ' + days + '>224))',
          '  ' + outerHF, 'ORDER BY p.DateRxStarted',
        ].join('\n')));
      }

      case 'smearcured': return _dqRows(_db.exec([
        "SELECT " + _DQ_COLS + ", COALESCE(o.Outcome,'') AS Outcome",
        'FROM PtDetailsT p',
        'LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0',
        'LEFT JOIN SexT s ON p.SexID=s.SexID LEFT JOIN PtTypeT pt ON p.PtTypeID=pt.PtTypeID',
        'LEFT JOIN TbTypeT tt ON p.TbTypeID=tt.TbTypeID LEFT JOIN DiagMethodT dm ON p.DiagMethodID=dm.DiagMethodID',
        'LEFT JOIN HealthFacilityT hf ON p.NearestHFID=hf.HealthFacilityID LEFT JOIN OutcomeT o ON fu.OutcomeID=o.OutcomeID',
        'WHERE p.Deleted=0 AND p.PtTypeID <> 5' + toF,
        '  AND COALESCE(fu.OutcomeID,0)=1',
        '  AND COALESCE(fu.Mon0LabResultID,0) NOT IN (1,4,5,6)',
        '  AND COALESCE(fu.Mon0XpertResultID,0) NOT IN (3,4,5) ' + outerHF,
        'ORDER BY p.PtName',
      ].join('\n')));

      case 'skipped': {
        var hfFilter = _dqFacilityFilter(facilityIDs, 'p');
        return _dqRows(_db.exec(
          _dqSkippedCTE(hfFilter, minYear) + '\n' + [
            'SELECT g.NearestHFID, g.RegYear, g.MissingTBNo,',
            "  COALESCE(hf.HealthFacility,'') AS HealthFacility",
            'FROM gaps g LEFT JOIN HealthFacilityT hf ON hf.HealthFacilityID=g.NearestHFID',
            'ORDER BY g.RegYear DESC, g.MissingTBNo DESC, hf.HealthFacility ASC',
          ].join('\n')
        ));
      }

      default: return [];
    }
  } catch (e) {
    console.error('[DQ] getDQListForReport:', e.message);
    return [];
  }
}

/**
 * Dispatches to the correct list function for the given category key.
 * @param {string}   category
 * @param {number[]} facilityIDs  — empty = all facilities (no filter)
 */
function getDQList(category, facilityIDs) {
  switch (category) {
    case 'all':         return getDQAllPatients(facilityIDs);
    case 'duplicates':  return getDQDuplicates(facilityIDs);
    case 'skipped':     return getDQSkipped(facilityIDs);
    case 'sametbno':    return getDQSameTBNo(facilityIDs);
    case 'smearcured':  return getDQSmearNegCured(facilityIDs);
    case 'missingreg':  return getDQMissingRegInfo(facilityIDs);
    case 'nooutcome':    return getDQNoOutcome(facilityIDs);
    case 'diagmethod':   return getDQDiagMethodMissing(facilityIDs);
    case 'norxstart':   return getDQNoTreatmentStart(facilityIDs);
    case 'deleted':     return getDQDeletedPatients(facilityIDs);
    default:            return [];
  }
}

/**
 * Returns counts for all quality-check categories in one call.
 * Uses COUNT(*) queries for efficiency rather than fetching all rows.
 */
function getDQCounts(facilityIDs) {
  if (!_db) return { all:0, duplicates:0, skipped:0, sametbno:0, smearcured:0, missingreg:0, nooutcome:0, diagmethod:0, norxstart:0, deleted:0 };

  var outerHF = _dqFacilityFilter(facilityIDs, 'p');
  var innerHF = _dqFacilityFilter(facilityIDs, 'd');

  return {
    all: _dqCount(
      'SELECT COUNT(*) FROM PtDetailsT p WHERE p.Deleted = 0 ' + outerHF),

    duplicates: _dqCount(
      'SELECT COUNT(*) FROM PtDetailsT p WHERE p.Deleted = 0 ' + outerHF +
      " AND p.PtName != ''" +
      // 365-day rolling window — TODO: configurable via user preferences
      " AND CAST(julianday('now') - julianday(p.RegDate) AS INTEGER) < 365" +
      ' AND EXISTS (' +
      '  SELECT 1 FROM PtDetailsT d' +
      '  WHERE d.Deleted = 0 AND d.PtDetailsTID != p.PtDetailsTID ' + innerHF +
      "  AND d.PtName != ''" +
      '  AND UPPER(TRIM(d.PtName))      = UPPER(TRIM(p.PtName))' +
      '  AND COALESCE(d.Age, -1)        = COALESCE(p.Age, -1)' +
      '  AND COALESCE(d.PtTypeID, -1)   = COALESCE(p.PtTypeID, -1)' +
      "  AND COALESCE(d.RegDate, '')    = COALESCE(p.RegDate, '')" +
      ')'),

    skipped: _dqCount(
      _dqSkippedCTE(outerHF, new Date().getFullYear() - 1) +
      '\nSELECT COUNT(*) FROM gaps'),

    sametbno: _dqCount(
      'WITH normalized AS (' +
      " SELECT p.PtDetailsTID, p.NearestHFID," +
      " CAST(strftime('%Y', p.RegDate) AS INTEGER) AS RegYear," +
      " CAST(REPLACE(COALESCE(p.UnitTBNo,''), '\\', '/') AS INTEGER) AS TBNoB" +
      ' FROM PtDetailsT p' +
      " WHERE p.Deleted = 0 AND p.UnitTBNo IS NOT NULL AND p.UnitTBNo != ''" +
      " AND p.RegDate IS NOT NULL AND p.RegDate != ''" +
      // 365-day rolling window — TODO: configurable via user preferences
      " AND CAST(julianday('now') - julianday(p.RegDate) AS INTEGER) < 365" +
      ' ' + outerHF + '),' +
      'dupes AS (' +
      ' SELECT NearestHFID, RegYear, TBNoB FROM normalized WHERE TBNoB > 0' +
      ' GROUP BY NearestHFID, RegYear, TBNoB HAVING COUNT(*) > 1)' +
      ' SELECT COUNT(*) FROM normalized n' +
      ' JOIN dupes dk ON dk.NearestHFID = n.NearestHFID' +
      ' AND dk.RegYear = n.RegYear AND dk.TBNoB = n.TBNoB' +
      ' WHERE n.TBNoB > 0'),


    smearcured: _dqCount(
      'SELECT COUNT(*) FROM PtDetailsT p' +
      ' LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID = fu.PtDetailsTID AND fu.Deleted = 0' +
      ' WHERE p.Deleted = 0' +
      ' AND p.PtTypeID <> 5' +
      ' AND p.DateRxStarted IS NOT NULL' +
      ' AND COALESCE(fu.OutcomeID, 0) = 1' +
      ' AND COALESCE(fu.Mon0LabResultID, 0) NOT IN (1,4,5,6)' +
      ' AND COALESCE(fu.Mon0XpertResultID, 0) NOT IN (3,4,5)' +
      " AND ((p.PtTypeID = 1 AND CAST(julianday('now') - julianday(p.DateRxStarted) AS INTEGER) BETWEEN 180 AND 540)" +
      "  OR  (p.PtTypeID <> 1 AND CAST(julianday('now') - julianday(p.DateRxStarted) AS INTEGER) BETWEEN 240 AND 600))" +
      ' ' + outerHF),

    missingreg: _dqCount(
      'SELECT COUNT(*) FROM PtDetailsT p WHERE p.Deleted = 0 ' + outerHF +
      " AND (p.RegDate IS NULL OR p.RegDate = '' OR p.RegDate >= date('now', '-180 days'))" +
      " AND (p.PtName IS NULL OR p.PtName = ''"+
      " OR p.UnitTBNo IS NULL OR TRIM(p.UnitTBNo) = ''"+
      ' OR p.Age = 0 OR p.Age IS NULL' +
      ' OR p.SexID IN (0,3) OR p.SexID IS NULL' +
      ' OR p.TbTypeID IN (0,4) OR p.TbTypeID IS NULL' +
      ' OR p.PtTypeID IN (0,7) OR p.PtTypeID IS NULL' +
      ' OR p.NearestHFID IS NULL OR p.NearestHFID = 0' +
      " OR p.RegDate IS NULL OR p.RegDate = ''"+
      " OR p.DateRxStarted IS NULL OR p.DateRxStarted = ''"+
      ' OR p.DiagMethodID = 0 OR p.DiagMethodID IS NULL)'),

    // TODO: configurable via user preferences — DQ_NOOUTCOME_DAYS: new 180–540, retreatment 240–600
    nooutcome: _dqCount(
      'SELECT COUNT(*) FROM PtDetailsT p' +
      ' LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID = fu.PtDetailsTID AND fu.Deleted = 0' +
      ' WHERE p.Deleted = 0' +
      " AND p.DateRxStarted IS NOT NULL AND p.DateRxStarted != ''" +
      " AND p.PtName IS NOT NULL AND p.PtName != ''" +
      ' AND p.PtTypeID NOT IN (0, 5, 7)' +
      ' AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.OutcomeID, 0) IN (0, 7))' +
      " AND ((p.PtTypeID = 1 AND CAST(julianday('now') - julianday(p.DateRxStarted) AS INTEGER) BETWEEN 180 AND 540)" +
      "   OR (p.PtTypeID IN (2,3,4,6) AND CAST(julianday('now') - julianday(p.DateRxStarted) AS INTEGER) BETWEEN 240 AND 600))" +
      ' ' + outerHF),

    diagmethod: _dqCount(
      'SELECT COUNT(*) FROM PtDetailsT p WHERE p.Deleted = 0' +
      " AND COALESCE(p.DiagMethodID, 0) = 0 AND CAST(julianday('now') - julianday(p.RegDate) AS INTEGER) < 180 " + outerHF),

    norxstart: _dqCount(
      'SELECT COUNT(*) FROM PtDetailsT p WHERE p.Deleted = 0' +
      " AND (p.DateRxStarted IS NULL OR p.DateRxStarted = '')" +
      " AND p.RegDate IS NOT NULL AND p.RegDate != ''" +
      " AND CAST(julianday('now') - julianday(p.RegDate) AS INTEGER) > 14" +
      " AND CAST(julianday('now') - julianday(p.RegDate) AS INTEGER) < 180" +
      ' ' + outerHF),

    deleted: _dqCount(
      'SELECT COUNT(*) FROM PtDetailsT p WHERE p.Deleted = 1 ' + outerHF),
  };
}

function exportDB() {
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'art-register.sqlite';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  console.log('[DB] Exported as art-register.sqlite');
}

// ─── Sync getters for child tables ───────────────────────────────────────

/**
 * Returns all INH prophylaxis rows for the given patient TIDs — used in the full sync payload.
 * @param {string[]} ptDetailsTIDs
 * @returns {Object[]}
 */
function getAllINHForSync(ptDetailsTIDs) {
  if (!ptDetailsTIDs || !ptDetailsTIDs.length) return [];
  const placeholders = ptDetailsTIDs.map(() => '?').join(',');
  const r = _db.exec(
    `SELECT * FROM INHProphylaxisT WHERE PtDetailsTID IN (${placeholders}) ORDER BY PtDetailsTID, SequenceNo`,
    ptDetailsTIDs
  );
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

/**
 * Returns all PMTCT pregnancy rows for the given patient TIDs — used in the full sync payload.
 * @param {string[]} ptDetailsTIDs
 * @returns {Object[]}
 */
function getAllPMTCTForSync(ptDetailsTIDs) {
  if (!ptDetailsTIDs || !ptDetailsTIDs.length) return [];
  const placeholders = ptDetailsTIDs.map(() => '?').join(',');
  const r = _db.exec(
    `SELECT * FROM PMTCTPregnancyT WHERE PtDetailsTID IN (${placeholders}) ORDER BY PtDetailsTID, PregnancyNo`,
    ptDetailsTIDs
  );
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

/**
 * Returns all regimen history rows for the given patient TIDs — used in the full sync payload.
 * @param {string[]} ptDetailsTIDs
 * @returns {Object[]}
 */
function getAllRegimenHistoryForSync(ptDetailsTIDs) {
  if (!ptDetailsTIDs || !ptDetailsTIDs.length) return [];
  const placeholders = ptDetailsTIDs.map(() => '?').join(',');
  const r = _db.exec(
    `SELECT * FROM RegimenHistoryT WHERE PtDetailsTID IN (${placeholders}) ORDER BY PtDetailsTID, RegimenLine, SequenceNo`,
    ptDetailsTIDs
  );
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

/**
 * Returns all follow-up visit rows for the given patient TIDs — used in the full sync payload.
 * @param {string[]} ptDetailsTIDs
 * @returns {Object[]}
 */
function getAllFollowUpsForSync(ptDetailsTIDs) {
  if (!ptDetailsTIDs || !ptDetailsTIDs.length) return [];
  const placeholders = ptDetailsTIDs.map(() => '?').join(',');
  const r = _db.exec(
    `SELECT * FROM PtFollowUpARTT WHERE PtDetailsTID IN (${placeholders}) ORDER BY PtDetailsTID, VisitDate`,
    ptDetailsTIDs
  );
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

/**
 * After a successful sync, marks all records for the given patient TIDs as
 * HasChanged = 0 on the local device.  This prevents re-syncing unchanged
 * records on the next sync — they will be re-flagged HasChanged = 1 whenever
 * they are edited again.
 * @param {string[]} ptDetailsTIDs
 */
async function markRecordsSynced(ptDetailsTIDs) {
  if (!ptDetailsTIDs || !ptDetailsTIDs.length) return;
  const placeholders = ptDetailsTIDs.map(() => '?').join(',');
  _db.run(
    `UPDATE PtDetailsARTT SET HasChanged = 0 WHERE PtDetailsTID IN (${placeholders})`,
    ptDetailsTIDs
  );
  for (const tbl of ['INHProphylaxisT', 'PMTCTPregnancyT', 'RegimenHistoryT', 'PtFollowUpARTT']) {
    _db.run(
      `UPDATE ${tbl} SET HasChanged = 0 WHERE PtDetailsTID IN (${placeholders})`,
      ptDetailsTIDs
    );
  }
  await _persistDB();
  console.log(`[DB] markRecordsSynced: ${ptDetailsTIDs.length} patient(s) marked clean.`);
}

// ─── PtDetailsT (TB Register) ────────────────────────────────────────────────

async function insertPtDetailsTB(data) {
  const tid = generateGUID();
  const now = _now();
  _db.run(`
    INSERT INTO PtDetailsT (
      PtDetailsTID, PatientID, NearestHFID, DataSourceID, CountyID, EnteredByID,
      HasChanged, LastModOn, CreatedOn,
      RegDate, UnitTBNo, PtName, DateOfBirth, Age, AgeMonths,
      SexID, ReferredByID, Village, Boma, Payam, County, PtPhone,
      TbTypeID, PtTypeID, TIHF, TICounty,
      DateRxStarted, RegimenID, DiagMethodID, CountryID
    ) VALUES (
      ?,(SELECT COALESCE(MAX(PatientID),0)+1 FROM PtDetailsT),?,?,?,?,1,?,?,
      ?,?,?,?,?,?,
      ?,?,?,?,?,?,?,
      ?,?,?,?,
      ?,?,?,?
    )`,
    [
      tid, data.NearestHFID||0, data.DataSourceID||0, data.CountyID||0, data.EnteredByID||'',
      now, now,
      data.RegDate||null, data.UnitTBNo||null, data.PtName||'', data.DateOfBirth||null, data.Age||0, data.AgeMonths??null,
      data.SexID||0, data.ReferredByID||0,
      data.Village||null, data.Boma||null, data.Payam||null, data.County||null, data.PtPhone||null,
      data.TbTypeID||0, data.PtTypeID||0, data.TIHF||null, data.TICounty||null,
      data.DateRxStarted||null, data.RegimenID||0, data.DiagMethodID||0, data.CountryID||1
    ]
  );
  await _persistDB();
  console.log(`[DB] insertPtDetailsTB: ${tid}`);
  return tid;
}

function getAllPtDetailsTB(searchTerm = '') {
  const term = `%${searchTerm}%`;
  const r = _db.exec(`
    SELECT p.*, s.Sex, tt.TbType, pt.PtType, pt.PtTypeShort, hf.HealthFacility
    FROM PtDetailsT p
    LEFT JOIN SexT   s  ON p.SexID   = s.SexID
    LEFT JOIN TbTypeT tt ON p.TbTypeID = tt.TbTypeID
    LEFT JOIN PtTypeT pt ON p.PtTypeID = pt.PtTypeID
    LEFT JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID
    WHERE p.Deleted = 0
      AND (? = '%%' OR p.PtName LIKE ? OR p.UnitTBNo LIKE ? OR p.PtPhone LIKE ?)
    ORDER BY p.RegDate IS NULL, p.RegDate DESC, p.PatientID DESC`,
    [term, term, term, term]
  );
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

function getAllDeletedPtDetailsTB() {
  const r = _db.exec('SELECT p.*, s.Sex, tt.TbType, pt.PtType, pt.PtTypeShort, hf.HealthFacility FROM PtDetailsT p LEFT JOIN SexT   s  ON p.SexID   = s.SexID LEFT JOIN TbTypeT tt ON p.TbTypeID = tt.TbTypeID LEFT JOIN PtTypeT pt ON p.PtTypeID = pt.PtTypeID LEFT JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID WHERE p.Deleted = 1');
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

function getPtDetailsTB(ptDetailsTID) {
  const r = _db.exec('SELECT * FROM PtDetailsT WHERE PtDetailsTID = ?', [ptDetailsTID]);
  if (!r.length || !r[0].values.length) return null;
  const { columns, values } = r[0];
  return Object.fromEntries(columns.map((c, i) => [c, values[0][i]]));
}

function getAllPtDetailsTBForSync() {
  const r = _db.exec('SELECT * FROM PtDetailsT WHERE HasChanged = 1 ORDER BY CreatedOn');
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

/**
 * Cross-register patient search.
 * Searches both ART (PtDetailsARTT) and TB (PtDetailsT) registers.
 *
 * @param {string} term       - search term (name, ID, phone, facility)
 * @param {'ART'|'TB'|null} register - limit to one register, or null for both
 * @returns {Array<{Register,PtDetailsTID,PtName,PatientNo,Age,Sex,Phone,HealthFacility,NearestHFID}>}
 */
function searchAllPatients(term = '', register = null) {
  if (!_db) return [];
  const t = term.trim();
  if (!t) return [];
  const like = `%${t}%`;
  const rows = [];

  if (!register || register === 'ART') {
    try {
      const r = _db.exec(`
        SELECT 'ART'               AS Register,
               p.PtDetailsTID,
               p.PtName,
               p.ARTNo             AS PatientNo,
               p.Age,
               COALESCE(s.Sex,'') AS Sex,
               COALESCE(p.Phone1,'') AS Phone,
               COALESCE(hf.HealthFacility,'') AS HealthFacility,
               p.NearestHFID
        FROM   PtDetailsARTT p
        LEFT JOIN SexT            s  ON p.SexID        = s.SexID
        LEFT JOIN HealthFacilityT hf ON p.NearestHFID  = hf.HealthFacilityID
        WHERE  p.Deleted = 0
          AND (p.PtName LIKE ? OR p.ARTNo LIKE ?
               OR COALESCE(p.Phone1,'') LIKE ? OR COALESCE(p.Phone2,'') LIKE ?
               OR COALESCE(hf.HealthFacility,'') LIKE ?)
        ORDER BY p.PtName ASC`,
        [like, like, like, like, like]);
      if (r.length) {
        const { columns, values } = r[0];
        rows.push(...values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]]))));
      }
    } catch (e) { console.error('[DB] searchAllPatients ART:', e.message); }
  }

  if (!register || register === 'TB') {
    try {
      const r = _db.exec(`
        SELECT 'TB'                AS Register,
               p.PtDetailsTID,
               p.PtName,
               p.UnitTBNo         AS PatientNo,
               p.Age,
               COALESCE(s.Sex,'') AS Sex,
               COALESCE(p.PtPhone,'') AS Phone,
               COALESCE(hf.HealthFacility,'') AS HealthFacility,
               p.NearestHFID
        FROM   PtDetailsT p
        LEFT JOIN SexT            s  ON p.SexID        = s.SexID
        LEFT JOIN HealthFacilityT hf ON p.NearestHFID  = hf.HealthFacilityID
        WHERE  p.Deleted = 0
          AND (p.PtName LIKE ? OR p.UnitTBNo LIKE ?
               OR COALESCE(p.PtPhone,'') LIKE ?
               OR COALESCE(hf.HealthFacility,'') LIKE ?)
        ORDER BY p.PtName ASC`,
        [like, like, like, like]);
      if (r.length) {
        const { columns, values } = r[0];
        rows.push(...values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]]))));
      }
    } catch (e) { console.error('[DB] searchAllPatients TB:', e.message); }
  }

  // Sort interleaved results by name
  rows.sort((a, b) => (a.PtName || '').localeCompare(b.PtName || ''));
  return rows;
}

async function updatePtDetailsTB(ptDetailsTID, data) {
  const now = _now();
  const ptDetailsTIDNormalized = normalizeGUID(ptDetailsTID);
  _db.run(`
    UPDATE PtDetailsT SET
      HasChanged = 1, LastModOn = ?,
      RegDate = ?, UnitTBNo = ?, PtName = ?, DateOfBirth = ?, Age = ?, AgeMonths = ?,
      SexID = ?, ReferredByID = ?, Village = ?, Boma = ?, Payam = ?, County = ?, PtPhone = ?,
      TbTypeID = ?, PtTypeID = ?, TIHF = ?, TICounty = ?,
      DateRxStarted = ?, RegimenID = ?, DiagMethodID = ?
    WHERE PtDetailsTID = ?`,
    [
      now,
      data.RegDate||null, data.UnitTBNo||null, data.PtName||'', data.DateOfBirth||null, data.Age||0, data.AgeMonths??null,
      data.SexID||0, data.ReferredByID||0,
      data.Village||null, data.Boma||null, data.Payam||null, data.County||null, data.PtPhone||null,
      data.TbTypeID||0, data.PtTypeID||0, data.TIHF||null, data.TICounty||null,
      data.DateRxStarted||null, data.RegimenID||0, data.DiagMethodID||0,
      ptDetailsTIDNormalized
    ]
  );
  await _persistDB();
  console.log(`[DB] updatePtDetailsTB: ${ptDetailsTIDNormalized}`);
}

async function deletePtDetailsTB(ptDetailsTID) {
  const now = _now();
  const ptDetailsTIDNormalized = normalizeGUID(ptDetailsTID);
  _db.run(
    'UPDATE PtDetailsT SET Deleted = 1, HasChanged = 1, LastModOn = ? WHERE PtDetailsTID = ?',
    [now, ptDetailsTIDNormalized]
  );
  await _persistDB();
  console.log(`[DB] deletePtDetailsTB (soft): ${ptDetailsTIDNormalized}`);
}

async function undeletePtDetailsTB(ptDetailsTID) {
  const now = _now();
  const ptDetailsTIDNormalized = normalizeGUID(ptDetailsTID);
  _db.run(
    'UPDATE PtDetailsT SET Deleted = 0, HasChanged = 1, LastModOn = ? WHERE PtDetailsTID = ?',
    [now, ptDetailsTIDNormalized]
  );
  await _persistDB();
  console.log(`[DB] undeletePtDetailsTB: ${ptDetailsTIDNormalized}`);
}

// ─── PtFollowUpT (TB Register) ────────────────────────────────────────────────

async function upsertPtFollowUpTB(data) {
  // One follow-up record per patient — INSERT or full REPLACE.
  const ptDetailsTIDNormalized = normalizeGUID(data.PtDetailsTID);
  const existing = getPtFollowUpTB(ptDetailsTIDNormalized);
  const tid = existing ? existing.PtFollowUpTID : generateGUID();
  const now = _now();
  _db.run(`
    INSERT OR REPLACE INTO PtFollowUpT (
      PtFollowUpTID, PtDetailsTID,
      HasChanged, Deleted, LastModOn, CreatedOn, EnteredByID,
      Mon0Date, Mon0LabNo, Mon0LabResultID,
      Mon0XpertResultID, Mon0XpertResultDate,
      HIVTestDate, HIVTestResultID, DSTResult,
      Mon2Date, Mon2LabNo, Mon2LabResultID,
      Mon3Date, Mon3LabNo, Mon3LabResultID,
      Mon5Date, Mon5LabNo, Mon5LabResultID,
      Mon6Date, Mon6LabNo, Mon6LabResultID,
      OutcomeID, OutcomeDate, TOHF, TOCounty,
      OnART, ARTDate, OnCPT, CPTDate,
      MovedTo2ndLine, Remarks
    ) VALUES (
      ?,?,1,0,?,?,?,
      ?,?,?,?,?,?,?,?,
      ?,?,?,?,?,?,?,?,?,?,?,?,
      ?,?,?,?,?,?,?,?,?,?
    )`,

    [
      tid, ptDetailsTIDNormalized, now, existing ? existing.CreatedOn : now, data.EnteredByID||'',
      data.Mon0Date||null, data.Mon0LabNo||null, data.Mon0LabResultID||0,
      data.Mon0XpertResultID||0, data.Mon0XpertResultDate||null,
      data.HIVTestDate||null, data.HIVTestResultID||0, data.DSTResult||null,
      data.Mon2Date||null, data.Mon2LabNo||null, data.Mon2LabResultID||0,
      data.Mon3Date||null, data.Mon3LabNo||null, data.Mon3LabResultID||0,
      data.Mon5Date||null, data.Mon5LabNo||null, data.Mon5LabResultID||0,
      data.Mon6Date||null, data.Mon6LabNo||null, data.Mon6LabResultID||0,
      data.OutcomeID||0, data.OutcomeDate||null, data.TOHF||null, data.TOCounty||null,
      data.OnART||0, data.ARTDate||null, data.OnCPT||0, data.CPTDate||null,
      data.MovedTo2ndLine||0, data.Remarks||null
    ]
  );
  // Flag parent patient for sync
  _db.run(
    'UPDATE PtDetailsT SET HasChanged = 1, LastModOn = ? WHERE PtDetailsTID = ?',
    [now, ptDetailsTIDNormalized]
  );
  await _persistDB();
  console.log(`[DB] upsertPtFollowUpTB: ${tid}`);
  return tid;
}

function getPtFollowUpTB(ptDetailsTID) {
  const r = _db.exec(
    `SELECT fu.*,
       sr0.SputumResult AS Mon0SmearResult,
       xr.XpertResult   AS Mon0XpertResult,
       hiv.HIVResult,
       sr2.SputumResult AS Mon2SmearResult,
       sr3.SputumResult AS Mon3SmearResult,
       sr5.SputumResult AS Mon5SmearResult,
       sr6.SputumResult AS Mon6SmearResult,
       oc.Outcome
     FROM PtFollowUpT fu
     LEFT JOIN SputumResultT sr0 ON fu.Mon0LabResultID   = sr0.SputumResultID
     LEFT JOIN XpertResultT  xr  ON fu.Mon0XpertResultID = xr.XpertResultID
     LEFT JOIN HIVResultT    hiv ON fu.HIVTestResultID   = hiv.HIVResultID
     LEFT JOIN SputumResultT sr2 ON fu.Mon2LabResultID   = sr2.SputumResultID
     LEFT JOIN SputumResultT sr3 ON fu.Mon3LabResultID   = sr3.SputumResultID
     LEFT JOIN SputumResultT sr5 ON fu.Mon5LabResultID   = sr5.SputumResultID
     LEFT JOIN SputumResultT sr6 ON fu.Mon6LabResultID   = sr6.SputumResultID
     LEFT JOIN OutcomeT      oc  ON fu.OutcomeID         = oc.OutcomeID
     WHERE fu.PtDetailsTID = ?`,
    [ptDetailsTID]
  );
  if (!r.length || !r[0].values.length) return null;
  const { columns, values } = r[0];
  return Object.fromEntries(columns.map((c, i) => [c, values[0][i]]));
}

function getAllPtFollowUpTBForSync(ptDetailsTIDs) {
  if (!ptDetailsTIDs || !ptDetailsTIDs.length) return [];
  const placeholders = ptDetailsTIDs.map(() => '?').join(',');
  const r = _db.exec(
    `SELECT * FROM PtFollowUpT WHERE PtDetailsTID IN (${placeholders}) ORDER BY PtDetailsTID`,
    ptDetailsTIDs
  );
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

// ─── PresumptiveCaseT (TB Register) ──────────────────────────────────────────

async function upsertPresumptiveCase(data) {
  // One row per facility per month/year — find existing by (NearestHFID, MonthID, YearID).
  const existingR = _db.exec(
    'SELECT PresumptiveCaseTID FROM PresumptiveCaseT WHERE NearestHFID = ? AND MonthID = ? AND YearID = ?',
    [data.NearestHFID, data.MonthID, data.YearID]
  );
  const existing = existingR.length && existingR[0].values.length
    ? { tid: existingR[0].values[0][0] }
    : null;
  const tid = existing ? existing.tid : generateGUID();
  const now = _now();
  _db.run(`
    INSERT OR REPLACE INTO PresumptiveCaseT (
      PresumptiveCaseTID, PresumptiveCase, MonthID, YearID,
      NearestHFID, DataSourceID, CountyID, LocationID, SubRecID,
      HasChanged, Uploaded, Imported, LastModOn, EnteredByID
    ) VALUES (?,?,?,?,?,?,?,?,?,1,0,0,?,?)`,
    [
      tid, data.PresumptiveCase||0, data.MonthID, data.YearID,
      data.NearestHFID||0, data.DataSourceID||0, data.CountyID||0,
      data.LocationID||0, data.SubRecID||0,
      now, data.EnteredByID||''
    ]
  );
  await _persistDB();
  console.log(`[DB] upsertPresumptiveCase: HF=${data.NearestHFID} Month=${data.MonthID} Year=${data.YearID}`);
  return tid;
}

function getPresumptiveCases(nearestHFID, yearID) {
  const r = _db.exec(
    `SELECT pc.*, m.MonthName, y.YearName
     FROM PresumptiveCaseT pc
     LEFT JOIN MonthT m ON pc.MonthID = m.MonthID
     LEFT JOIN YearT  y ON pc.YearID  = y.YearID
     WHERE pc.NearestHFID = ? AND pc.YearID = ?
     ORDER BY pc.MonthID`,
    [nearestHFID, yearID]
  );
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

function getAllPresumptiveCasesForSync(nearestHFID) {
  const r = _db.exec(
    'SELECT * FROM PresumptiveCaseT WHERE NearestHFID = ? AND HasChanged = 1 ORDER BY YearID, MonthID',
    [nearestHFID]
  );
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

async function markTBRecordsSynced(ptDetailsTIDs) {
  if (!ptDetailsTIDs || !ptDetailsTIDs.length) return;
  const placeholders = ptDetailsTIDs.map(() => '?').join(',');
  _db.run(
    `UPDATE PtDetailsT  SET HasChanged = 0 WHERE PtDetailsTID IN (${placeholders})`,
    ptDetailsTIDs
  );
  _db.run(
    `UPDATE PtFollowUpT SET HasChanged = 0 WHERE PtDetailsTID IN (${placeholders})`,
    ptDetailsTIDs
  );
  await _persistDB();
  console.log(`[DB] markTBRecordsSynced: ${ptDetailsTIDs.length} patient(s) marked clean.`);
}

/** Returns every PresumptiveCaseT row that has local unsaved changes (HasChanged=1). */
function getAllPresumptiveCasesForSyncAll() {
  const r = _db.exec('SELECT * FROM PresumptiveCaseT WHERE HasChanged = 1 ORDER BY YearID, MonthID');
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

/** Marks a set of PresumptiveCaseTIDs as synced (HasChanged = 0). */
async function markPresumptiveCasesSynced(tids) {
  if (!tids || !tids.length) return;
  const placeholders = tids.map(() => '?').join(',');
  _db.run(`UPDATE PresumptiveCaseT SET HasChanged = 0 WHERE PresumptiveCaseTID IN (${placeholders})`, tids);
  await _persistDB();
  console.log(`[DB] markPresumptiveCasesSynced: ${tids.length} record(s) marked clean.`);
}

/**
 * Merges presumptive case records received from the server into the local DB.
 * INSERT OR IGNORE for new records; UPDATE (when not locally modified) for existing ones.
 * Returns the count of rows inserted or updated.
 */
async function importPresumptiveCasesFromServer(cases) {
  if (!cases || !cases.length) return 0;
  let count = 0;
  for (const c of cases) {
    if (c.PresumptiveCaseTID) c.PresumptiveCaseTID = c.PresumptiveCaseTID.toLowerCase();
    _db.run(`
      INSERT OR IGNORE INTO PresumptiveCaseT (
        PresumptiveCaseTID, PresumptiveCase, MonthID, YearID,
        NearestHFID, DataSourceID, CountyID, LocationID, SubRecID,
        HasChanged, Uploaded, Imported, LastModOn, EnteredByID
      ) VALUES (?,?,?,?,?,?,?,0,0,0,0,0,?,?)`,
      [
        c.PresumptiveCaseTID, c.PresumptiveCase ?? 0, c.MonthID, c.YearID,
        c.NearestHFID || 0, c.DataSourceID || 0, c.CountyID || 0,
        c.LastModOn || _now(), c.EnteredByID || '',
      ]
    );
    if (_db.getRowsModified() > 0) {
      count++;
    } else {
      // Server wins, but only overwrite if user has not made local changes.
      _db.run(`
        UPDATE PresumptiveCaseT SET
          PresumptiveCase=?, LastModOn=?
        WHERE PresumptiveCaseTID=? AND HasChanged=0`,
        [c.PresumptiveCase ?? 0, c.LastModOn || _now(), c.PresumptiveCaseTID]
      );
      if (_db.getRowsModified() > 0) count++;
    }
  }
  await _persistDB();
  console.log(`[DB] importPresumptiveCasesFromServer: ${count} upserted of ${cases.length} record(s).`);
  return count;
}

// ─── Offline Audit Log ───────────────────────────────────────────────────────────────────────

/**
 * Inserts one audit log entry into the local AuditLogT table, then persists
 * the SQLite database to IndexedDB.  Called after every patient data mutation
 * and every Excel export.
 *
 * NEVER throws — logging must never break the calling operation.
 *
 * @param {{ action:string, ptDetailsTID?:string, notes?:string, userTID?:string, userName?:string }} entry
 */
async function insertAuditLog(entry) {
  if (!_db) return;
  try {
    _db.run(
      `INSERT INTO AuditLogT (LoggedOn, Action, PtDetailsTID, Notes, UserTID, UserName, Synced)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [
        _now(),
        entry.action       || '',
        entry.ptDetailsTID || null,
        (entry.notes       || '').slice(0, 2000),
        entry.userTID      || null,
        (entry.userName    || '').slice(0, 200) || null,
      ]
    );
    await _persistDB();
  } catch (err) {
    console.warn('[AuditLog] insertAuditLog failed:', err);
  }
}

/**
 * Returns up to 500 unsynced audit log entries (Synced = 0).
 * Used by _pushAuditLogs() to build the batch sent to the server.
 * @returns {Object[]}
 */
function getPendingAuditLogs() {
  if (!_db) return [];
  try {
    const rows = _db.exec(
      'SELECT AuditLogID, LoggedOn, Action, PtDetailsTID, Notes, UserTID, UserName FROM AuditLogT WHERE Synced = 0 ORDER BY AuditLogID ASC LIMIT 500'
    );
    if (!rows.length) return [];
    const { columns, values } = rows[0];
    return values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
  } catch {
    return [];
  }
}

/**
 * Marks a batch of audit log entries as successfully synced (Synced = 1).
 * @param {number[]} ids  AuditLogID values returned by getPendingAuditLogs.
 */
async function markAuditLogsSynced(ids) {
  if (!_db || !ids.length) return;
  try {
    const placeholders = ids.map(() => '?').join(',');
    _db.run(`UPDATE AuditLogT SET Synced = 1 WHERE AuditLogID IN (${placeholders})`, ids);
    await _persistDB();
  } catch (err) {
    console.warn('[AuditLog] markAuditLogsSynced failed:', err);
  }
}

// ─── Backward-compat shims ────────────────────────────────────────────────

function getAllPatients(s) { return getAllPtDetails(s); }
async function insertPatient(data) { return insertPtDetails(data); }
async function deletePatient() { console.warn('[DB] deletePatient() is deprecated; use deletePtDetails(guid).'); }

// ─── Server recovery helpers ──────────────────────────────────────────────

/**
 * Imports a FullSyncPayload returned by GET /api/patients/mine into the local
 * SQLite database.  Uses INSERT OR IGNORE so existing local records are never
 * overwritten — the user's local edits always take priority.
 *
 * All imported records are stamped HasChanged=0 because they are already on
 * the server; there is nothing new to sync back.
 *
 * @param {{patients, inhRecords, pmtctRecords, regimenHistory, followUps}} payload
 * @returns {number} number of patient records that were actually inserted
 */
async function importFullPayloadFromServer(payload) {
  const {
    patients       = [],
    inhRecords     = [],
    pmtctRecords   = [],
    regimenHistory = [],
    followUps      = [],
  } = payload;

  let inserted = 0;
  let updated  = 0;

  // ── PtDetailsARTT ────────────────────────────────────────────────────────
  // Strategy: INSERT if the record is new; otherwise UPDATE only when the local
  // copy has NOT been locally modified (HasChanged = 0) AND the server version is
  // newer (server LastModOn > local LastModOn).  This ensures changes made on
  // other devices are reflected here while unsynced local edits are preserved.
  for (const p of patients) {
    // Normalize GUIDs to lowercase — SQL Server CAST(uniqueidentifier) returns uppercase
    // but crypto.randomUUID() produces lowercase; SQLite TEXT comparison is case-sensitive.
    if (p.PtDetailsTID) p.PtDetailsTID = p.PtDetailsTID.toLowerCase();
    if (p.EnteredByID)  p.EnteredByID  = p.EnteredByID.toLowerCase();
    const bmi = p.BMI ?? calcBMI(p.WeightKg, p.HeightCm);

    // Step 1 — insert only if this PtDetailsTID does not exist locally yet.
    _db.run(`
      INSERT OR IGNORE INTO PtDetailsARTT (
        PtDetailsTID, NearestHFID, DataSourceID, CountyID, EnteredByID,
        HasChanged, LastModOn, CreatedOn, Deleted,
        HIVRetest, ARTNo, ARTStartDate, DateEnrolledInCare,
        PtName, ResidenceAddress, Phone1, Phone2,
        OccupationID, OccupationOther, KeyPopuID, KeyPopuOther,
        Age, DateOfBirth, SexID,
        WeightKg, HeightCm, MUACCm, BMI,
        WHOStageID, CD4Value, CD4IsPercent,
        CPTStartDate, CPTDrugID, TBRxStartDate, UnitTBNo, TBStatusID,
        BreastfeedingID, IsTransferIn, TransferFromFacility,
        GuardianName, GuardianPhone1
      ) VALUES (
        ?,?,?,?,?,
        0,?,?,?,
        ?,?,?,?,
        ?,?,?,?,
        ?,?,?,?,
        ?,?,?,
        ?,?,?,?,
        ?,?,?,
        ?,?,?,?,?,
        ?,?,?,
        ?,?
      )`,
      [
        p.PtDetailsTID,
        p.NearestHFID || 0, p.DataSourceID || 0, p.CountyID || 0, p.EnteredByID || '',
        p.LastModOn || _now(), p.CreatedOn || _now(), p.Deleted || 0,
        p.HIVRetest || 0, p.ARTNo || '', p.ARTStartDate || null, p.DateEnrolledInCare || null,
        p.PtName || '', p.ResidenceAddress || null, p.Phone1 || null, p.Phone2 || null,
        p.OccupationID || 0, p.OccupationOther || null, p.KeyPopuID || 0, p.KeyPopuOther || null,
        p.Age || 0, p.DateOfBirth || null, p.SexID || 0,
        p.WeightKg ?? null, p.HeightCm ?? null, p.MUACCm ?? null, bmi,
        p.WHOStageID || 0, p.CD4Value ?? null, p.CD4IsPercent || 0,
        p.CPTStartDate || null, p.CPTDrugID || 0, p.TBRxStartDate || null,
        p.UnitTBNo || null, p.TBStatusID || 0,
        p.BreastfeedingID || 0, p.IsTransferIn || 0, p.TransferFromFacility || null,
        p.GuardianName || null, p.GuardianPhone1 || null,
      ]
    );

    if (_db.getRowsModified() > 0) {
      inserted++;
    } else {
      // Step 2 — record already exists locally: update it only if it has not been
      // locally modified AND the server's version is genuinely newer.
      _db.run(`
        UPDATE PtDetailsARTT SET
          HasChanged = 0, LastModOn = ?, Deleted = ?,
          NearestHFID = ?, DataSourceID = ?, CountyID = ?, EnteredByID = ?,
          HIVRetest = ?, ARTNo = ?, ARTStartDate = ?, DateEnrolledInCare = ?,
          PtName = ?, ResidenceAddress = ?, Phone1 = ?, Phone2 = ?,
          OccupationID = ?, OccupationOther = ?, KeyPopuID = ?, KeyPopuOther = ?,
          Age = ?, DateOfBirth = ?, SexID = ?,
          WeightKg = ?, HeightCm = ?, MUACCm = ?, BMI = ?,
          WHOStageID = ?, CD4Value = ?, CD4IsPercent = ?,
          CPTStartDate = ?, CPTDrugID = ?,
          TBRxStartDate = ?, UnitTBNo = ?, TBStatusID = ?,
          BreastfeedingID = ?, IsTransferIn = ?, TransferFromFacility = ?,
          GuardianName = ?, GuardianPhone1 = ?
        WHERE PtDetailsTID = ?
          AND HasChanged = 0
          AND LastModOn < ?`,
        [
          p.LastModOn || _now(), p.Deleted || 0,
          p.NearestHFID || 0, p.DataSourceID || 0, p.CountyID || 0, p.EnteredByID || '',
          p.HIVRetest || 0, p.ARTNo || '', p.ARTStartDate || null, p.DateEnrolledInCare || null,
          p.PtName || '', p.ResidenceAddress || null, p.Phone1 || null, p.Phone2 || null,
          p.OccupationID || 0, p.OccupationOther || null, p.KeyPopuID || 0, p.KeyPopuOther || null,
          p.Age || 0, p.DateOfBirth || null, p.SexID || 0,
          p.WeightKg ?? null, p.HeightCm ?? null, p.MUACCm ?? null, bmi,
          p.WHOStageID || 0, p.CD4Value ?? null, p.CD4IsPercent || 0,
          p.CPTStartDate || null, p.CPTDrugID || 0,
          p.TBRxStartDate || null, p.UnitTBNo || null, p.TBStatusID || 0,
          p.BreastfeedingID || 0, p.IsTransferIn || 0, p.TransferFromFacility || null,
          p.GuardianName || null, p.GuardianPhone1 || null,
          p.PtDetailsTID, p.LastModOn || _now(),
        ]
      );
      if (_db.getRowsModified() > 0) updated++;
    }
  }

  // ── INHProphylaxisT ──────────────────────────────────────────────────────
  for (const r of inhRecords) {
    if (r.INHProphylaxisTID) r.INHProphylaxisTID = r.INHProphylaxisTID.toLowerCase();
    if (r.PtDetailsTID)     r.PtDetailsTID     = r.PtDetailsTID.toLowerCase();
    _db.run(
      `INSERT OR IGNORE INTO INHProphylaxisT
       (INHProphylaxisTID,PtDetailsTID,SequenceNo,INHDate,EnteredByID,HasChanged,LastModOn,CreatedOn)
       VALUES (?,?,?,?,?,0,?,?)`,
      [r.INHProphylaxisTID, r.PtDetailsTID, r.SequenceNo || 0, r.INHDate || null,
       r.EnteredByID || '', r.LastModOn || _now(), r.CreatedOn || _now()]
    );
    if (_db.getRowsModified() === 0) {
      _db.run(
        `UPDATE INHProphylaxisT SET
           HasChanged=0, LastModOn=?, SequenceNo=?, INHDate=?, EnteredByID=?
         WHERE INHProphylaxisTID=? AND HasChanged=0 AND LastModOn < ?`,
        [r.LastModOn || _now(), r.SequenceNo || 0, r.INHDate || null, r.EnteredByID || '',
         r.INHProphylaxisTID, r.LastModOn || _now()]
      );
    }
  }

  // ── PMTCTPregnancyT ──────────────────────────────────────────────────────
  for (const r of pmtctRecords) {
    if (r.PMTCTPregnancyTID) r.PMTCTPregnancyTID = r.PMTCTPregnancyTID.toLowerCase();
    if (r.PtDetailsTID)      r.PtDetailsTID      = r.PtDetailsTID.toLowerCase();
    _db.run(
      `INSERT OR IGNORE INTO PMTCTPregnancyT
       (PMTCTPregnancyTID,PtDetailsTID,PregnancyNo,ANCNo,DeliveryDate,
        MotherReceivedART,InfantReceivedARVs,EnteredByID,HasChanged,LastModOn,CreatedOn)
       VALUES (?,?,?,?,?,?,?,?,0,?,?)`,
      [r.PMTCTPregnancyTID, r.PtDetailsTID, r.PregnancyNo || 0, r.ANCNo || null,
       r.DeliveryDate || null, r.MotherReceivedART || 0, r.InfantReceivedARVs || 0,
       r.EnteredByID || '', r.LastModOn || _now(), r.CreatedOn || _now()]
    );
    if (_db.getRowsModified() === 0) {
      _db.run(
        `UPDATE PMTCTPregnancyT SET
           HasChanged=0, LastModOn=?, PregnancyNo=?, ANCNo=?, DeliveryDate=?,
           MotherReceivedART=?, InfantReceivedARVs=?, EnteredByID=?
         WHERE PMTCTPregnancyTID=? AND HasChanged=0 AND LastModOn < ?`,
        [r.LastModOn || _now(), r.PregnancyNo || 0, r.ANCNo || null, r.DeliveryDate || null,
         r.MotherReceivedART || 0, r.InfantReceivedARVs || 0, r.EnteredByID || '',
         r.PMTCTPregnancyTID, r.LastModOn || _now()]
      );
    }
  }

  // ── RegimenHistoryT ──────────────────────────────────────────────────────
  for (const r of regimenHistory) {
    if (r.RegimenHistoryTID) r.RegimenHistoryTID = r.RegimenHistoryTID.toLowerCase();
    if (r.PtDetailsTID)      r.PtDetailsTID      = r.PtDetailsTID.toLowerCase();
    _db.run(
      `INSERT OR IGNORE INTO RegimenHistoryT
       (RegimenHistoryTID,PtDetailsTID,RegimenLine,SequenceNo,RegimenID,
        ChangeReasonID,OtherReasonText,EventDate,EnteredByID,HasChanged,LastModOn,CreatedOn)
       VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`,
      [r.RegimenHistoryTID, r.PtDetailsTID, r.RegimenLine || 0, r.SequenceNo || 0,
       r.RegimenID || 0, r.ChangeReasonID || 0, r.OtherReasonText || null,
       r.EventDate || null, r.EnteredByID || '', r.LastModOn || _now(), r.CreatedOn || _now()]
    );
    if (_db.getRowsModified() === 0) {
      _db.run(
        `UPDATE RegimenHistoryT SET
           HasChanged=0, LastModOn=?, RegimenLine=?, SequenceNo=?, RegimenID=?,
           ChangeReasonID=?, OtherReasonText=?, EventDate=?, EnteredByID=?
         WHERE RegimenHistoryTID=? AND HasChanged=0 AND LastModOn < ?`,
        [r.LastModOn || _now(), r.RegimenLine || 0, r.SequenceNo || 0, r.RegimenID || 0,
         r.ChangeReasonID || 0, r.OtherReasonText || null, r.EventDate || null, r.EnteredByID || '',
         r.RegimenHistoryTID, r.LastModOn || _now()]
      );
    }
  }

  // ── PtFollowUpARTT ───────────────────────────────────────────────────────
  for (const r of followUps) {
    if (r.PtFollowUpTID) r.PtFollowUpTID = r.PtFollowUpTID.toLowerCase();
    if (r.PtDetailsTID)  r.PtDetailsTID  = r.PtDetailsTID.toLowerCase();
    _db.run(
      `INSERT OR IGNORE INTO PtFollowUpARTT
       (PtFollowUpTID,PtDetailsTID,VisitDate,VisitMonth,
        FollowUpStatusID,RegimenID,TBStatusID,StopReasonID,StopOtherText,
        WeeksInterrupted,WeightKg,HeightCm,BMI,CPTDrugID,
        CD4Value,CD4IsPercent,ViralLoad,Notes,Deleted,
        EnteredByID,HasChanged,LastModOn,CreatedOn)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
      [r.PtFollowUpTID, r.PtDetailsTID, r.VisitDate || null, r.VisitMonth || 0,
       r.FollowUpStatusID || 0, r.RegimenID || 0, r.TBStatusID || 0,
       r.StopReasonID || 0, r.StopOtherText || null, r.WeeksInterrupted || 0,
       r.WeightKg ?? null, r.HeightCm ?? null, r.BMI ?? null, r.CPTDrugID || 0,
       r.CD4Value ?? null, r.CD4IsPercent || 0, r.ViralLoad || null, r.Notes || null,
       r.Deleted || 0, r.EnteredByID || '', r.LastModOn || _now(), r.CreatedOn || _now()]
    );
    if (_db.getRowsModified() === 0) {
      _db.run(
        `UPDATE PtFollowUpARTT SET
           HasChanged=0, LastModOn=?,
           VisitDate=?, VisitMonth=?, FollowUpStatusID=?, RegimenID=?,
           TBStatusID=?, StopReasonID=?, StopOtherText=?, WeeksInterrupted=?,
           WeightKg=?, HeightCm=?, BMI=?, CPTDrugID=?,
           CD4Value=?, CD4IsPercent=?, ViralLoad=?, Notes=?, Deleted=?
         WHERE PtFollowUpTID=? AND HasChanged=0 AND LastModOn < ?`,
        [r.LastModOn || _now(),
         r.VisitDate || null, r.VisitMonth || 0, r.FollowUpStatusID || 0, r.RegimenID || 0,
         r.TBStatusID || 0, r.StopReasonID || 0, r.StopOtherText || null, r.WeeksInterrupted || 0,
         r.WeightKg ?? null, r.HeightCm ?? null, r.BMI ?? null, r.CPTDrugID || 0,
         r.CD4Value ?? null, r.CD4IsPercent || 0, r.ViralLoad || null, r.Notes || null,
         r.Deleted || 0,
         r.PtFollowUpTID, r.LastModOn || _now()]
      );
    }
  }

  await _persistDB();

  // Assign PatientID to any records that still have NULL (imported records, or records
  // restored after a cache clear).  Order by date of enrolment ascending so the oldest
  // enrolment gets the lowest ID and the most recent gets the highest — mirroring how
  // locally-entered records are numbered.  New IDs always sit above the existing MAX
  // so they never collide with PatientIDs already assigned by insertPtDetails.
  _db.run(`
    UPDATE PtDetailsARTT
    SET PatientID =
      (SELECT COALESCE(MAX(pb.PatientID), 0) FROM PtDetailsARTT pb WHERE pb.PatientID IS NOT NULL)
      + (SELECT COUNT(*) FROM PtDetailsARTT p2
           WHERE p2.PatientID IS NULL
             AND (
               COALESCE(p2.DateEnrolledInCare, p2.ARTStartDate, p2.CreatedOn, '0000-00-00') <
                 COALESCE(PtDetailsARTT.DateEnrolledInCare, PtDetailsARTT.ARTStartDate, PtDetailsARTT.CreatedOn, '0000-00-00')
               OR (
                 COALESCE(p2.DateEnrolledInCare, p2.ARTStartDate, p2.CreatedOn, '0000-00-00') =
                   COALESCE(PtDetailsARTT.DateEnrolledInCare, PtDetailsARTT.ARTStartDate, PtDetailsARTT.CreatedOn, '0000-00-00')
                 AND p2.PtDetailsTID < PtDetailsARTT.PtDetailsTID
               )
             )
        ) + 1
    WHERE PatientID IS NULL
  `);
  await _persistDB();

  console.log(`[DB] importFullPayloadFromServer: ${inserted} inserted, ${updated} updated of ${patients.length} patients from server.`);
  return inserted + updated;  // callers use this to decide whether to re-render
}

/**
 * Imports a TB payload returned by GET /api/tb-patients/mine into the local
 * SQLite database.  Uses INSERT OR IGNORE so existing local records are never
 * overwritten — unsynced local edits always take priority.
 *
 * @param {{patients, followUps}} payload
 * @returns {number} number of records actually inserted or updated
 */
async function importTBPayloadFromServer(payload) {
  const { patients = [], followUps = [] } = payload;
  let inserted = 0;
  let updated  = 0;

  // ── PtDetailsT ───────────────────────────────────────────────────────────
  for (const p of patients) {
    // Normalize GUIDs to lowercase — SQL Server CAST(uniqueidentifier) returns uppercase
    // but crypto.randomUUID() produces lowercase; SQLite TEXT comparison is case-sensitive.
    if (p.PtDetailsTID) p.PtDetailsTID = p.PtDetailsTID.toLowerCase();
    if (p.EnteredByID)  p.EnteredByID  = p.EnteredByID.toLowerCase();
    _db.run(`
      INSERT OR IGNORE INTO PtDetailsT (
        PtDetailsTID, PatientID, NearestHFID, DataSourceID, CountyID, EnteredByID,
        HasChanged, LastModOn, CreatedOn, Deleted,
        RegDate, UnitTBNo, PtName, DateOfBirth, Age, AgeMonths,
        SexID, ReferredByID, Village, Boma, Payam, County, PtPhone,
        TbTypeID, PtTypeID, TIHF, TICounty,
        DateRxStarted, RegimenID, DiagMethodID, CountryID
      ) VALUES (
        ?, (SELECT COALESCE(MAX(PatientID),0)+1 FROM PtDetailsT),
        ?,?,?,?, 0,?,?,?,
        ?,?,?,?,?,?,
        ?,?,?,?,?,?,?,
        ?,?,?,?,
        ?,?,?,?
      )`,
      [
        p.PtDetailsTID,
        p.NearestHFID || 0, p.DataSourceID || 0, p.CountyID || 0, p.EnteredByID || '',
        p.LastModOn || _now(), p.CreatedOn || _now(), p.Deleted || 0,
        p.RegDate || null, p.UnitTBNo || null, p.PtName || '', p.DateOfBirth || null,
        p.Age || 0, p.AgeMonths ?? null,
        p.SexID || 0, p.ReferredByID || 0,
        p.Village || null, p.Boma || null, p.Payam || null, p.County || null, p.PtPhone || null,
        p.TbTypeID || 0, p.PtTypeID || 0, p.TIHF || null, p.TICounty || null,
        p.DateRxStarted || null, p.RegimenID || 0, p.DiagMethodID || 0, p.CountryID || 1,
      ]
    );
    if (_db.getRowsModified() > 0) {
      inserted++;
    } else {
      _db.run(`
        UPDATE PtDetailsT SET
          HasChanged=0, LastModOn=?, Deleted=?,
          NearestHFID=?, DataSourceID=?, CountyID=?,
          RegDate=?, UnitTBNo=?, PtName=?, DateOfBirth=?, Age=?, AgeMonths=?,
          SexID=?, ReferredByID=?,
          Village=?, Boma=?, Payam=?, County=?, PtPhone=?,
          TbTypeID=?, PtTypeID=?, TIHF=?, TICounty=?,
          DateRxStarted=?, RegimenID=?, DiagMethodID=?
        WHERE PtDetailsTID=? AND HasChanged=0`,
        [
          p.LastModOn || _now(), p.Deleted || 0,
          p.NearestHFID || 0, p.DataSourceID || 0, p.CountyID || 0,
          p.RegDate || null, p.UnitTBNo || null, p.PtName || '', p.DateOfBirth || null,
          p.Age || 0, p.AgeMonths ?? null,
          p.SexID || 0, p.ReferredByID || 0,
          p.Village || null, p.Boma || null, p.Payam || null, p.County || null, p.PtPhone || null,
          p.TbTypeID || 0, p.PtTypeID || 0, p.TIHF || null, p.TICounty || null,
          p.DateRxStarted || null, p.RegimenID || 0, p.DiagMethodID || 0,
          p.PtDetailsTID,
        ]
      );
      if (_db.getRowsModified() > 0) updated++;
    }
  }

  // ── PtFollowUpT ──────────────────────────────────────────────────────────
  for (const f of followUps) {
    if (f.PtFollowUpTID) f.PtFollowUpTID = f.PtFollowUpTID.toLowerCase();
    if (f.PtDetailsTID)  f.PtDetailsTID  = f.PtDetailsTID.toLowerCase();
    _db.run(`
      INSERT OR IGNORE INTO PtFollowUpT (
        PtFollowUpTID, PtDetailsTID, HasChanged, Deleted, LastModOn, CreatedOn, EnteredByID,
        Mon0Date, Mon0LabNo, Mon0LabResultID, Mon0XpertResultID, Mon0XpertResultDate,
        HIVTestDate, HIVTestResultID, DSTResult,
        Mon2Date, Mon2LabNo, Mon2LabResultID,
        Mon3Date, Mon3LabNo, Mon3LabResultID,
        Mon5Date, Mon5LabNo, Mon5LabResultID,
        Mon6Date, Mon6LabNo, Mon6LabResultID,
        OutcomeID, OutcomeDate, TOHF, TOCounty,
        OnART, ARTDate, OnCPT, CPTDate, MovedTo2ndLine, Remarks
      ) VALUES (
        ?,?,0,?,?,?,?,
        ?,?,?,?,?,?,?,?,
        ?,?,?,?,?,?,?,?,?,?,?,?,
        ?,?,?,?,?,?,?,?,?,?
      )`,
      [
        f.PtFollowUpTID, f.PtDetailsTID, f.Deleted || 0,
        f.LastModOn || _now(), f.CreatedOn || _now(), f.EnteredByID || '',
        f.Mon0Date || null, f.Mon0LabNo || null, f.Mon0LabResultID || 0,
        f.Mon0XpertResultID || 0, f.Mon0XpertResultDate || null,
        f.HIVTestDate || null, f.HIVTestResultID || 0, f.DSTResult || null,
        f.Mon2Date || null, f.Mon2LabNo || null, f.Mon2LabResultID || 0,
        f.Mon3Date || null, f.Mon3LabNo || null, f.Mon3LabResultID || 0,
        f.Mon5Date || null, f.Mon5LabNo || null, f.Mon5LabResultID || 0,
        f.Mon6Date || null, f.Mon6LabNo || null, f.Mon6LabResultID || 0,
        f.OutcomeID || 0, f.OutcomeDate || null, f.TOHF || null, f.TOCounty || null,
        f.OnART || 0, f.ARTDate || null, f.OnCPT || 0, f.CPTDate || null,
        f.MovedTo2ndLine || 0, f.Remarks || null,
      ]
    );
    if (_db.getRowsModified() === 0) {
      _db.run(`
        UPDATE PtFollowUpT SET
          HasChanged=0, LastModOn=?, Deleted=?,
          Mon0Date=?, Mon0LabNo=?, Mon0LabResultID=?, Mon0XpertResultID=?, Mon0XpertResultDate=?,
          HIVTestDate=?, HIVTestResultID=?, DSTResult=?,
          Mon2Date=?, Mon2LabNo=?, Mon2LabResultID=?,
          Mon3Date=?, Mon3LabNo=?, Mon3LabResultID=?,
          Mon5Date=?, Mon5LabNo=?, Mon5LabResultID=?,
          Mon6Date=?, Mon6LabNo=?, Mon6LabResultID=?,
          OutcomeID=?, OutcomeDate=?, TOHF=?, TOCounty=?,
          OnART=?, ARTDate=?, OnCPT=?, CPTDate=?, MovedTo2ndLine=?, Remarks=?
        WHERE PtFollowUpTID=? AND HasChanged=0`,
        [
          f.LastModOn || _now(), f.Deleted || 0,
          f.Mon0Date || null, f.Mon0LabNo || null, f.Mon0LabResultID || 0,
          f.Mon0XpertResultID || 0, f.Mon0XpertResultDate || null,
          f.HIVTestDate || null, f.HIVTestResultID || 0, f.DSTResult || null,
          f.Mon2Date || null, f.Mon2LabNo || null, f.Mon2LabResultID || 0,
          f.Mon3Date || null, f.Mon3LabNo || null, f.Mon3LabResultID || 0,
          f.Mon5Date || null, f.Mon5LabNo || null, f.Mon5LabResultID || 0,
          f.Mon6Date || null, f.Mon6LabNo || null, f.Mon6LabResultID || 0,
          f.OutcomeID || 0, f.OutcomeDate || null, f.TOHF || null, f.TOCounty || null,
          f.OnART || 0, f.ARTDate || null, f.OnCPT || 0, f.CPTDate || null,
          f.MovedTo2ndLine || 0, f.Remarks || null,
          f.PtFollowUpTID,
        ]
      );
    }
  }

  await _persistDB();
  console.log(`[DB] importTBPayloadFromServer: ${inserted} inserted, ${updated} updated of ${patients.length} TB patients from server.`);
  return inserted + updated;
}

/**
 * Checks the local DB for a patient whose ARTNo exactly matches (case-insensitive).
 * Used for real-time duplicate detection while the form is being filled in.
 *
 * @param {string}      artNo      - ART number to check.
 * @param {string|null} excludeTID - PtDetailsTID to exclude (edit mode).
 * @returns {Object|null} First matching active patient, or null.
 */
function checkDuplicateARTNo(artNo, excludeTID = null) {
  if (!artNo || !artNo.trim()) return null;
  let sql = `
    SELECT p.PtDetailsTID, p.ARTNo, p.PtName, p.Age, s.Sex, p.ARTStartDate
    FROM PtDetailsARTT p
    LEFT JOIN SexT s ON p.SexID = s.SexID
    WHERE LOWER(TRIM(p.ARTNo)) = LOWER(TRIM(?)) AND p.Deleted = 0`;
  const params = [artNo];
  if (excludeTID) { sql += ' AND p.PtDetailsTID != ?'; params.push(excludeTID); }
  const r = _db.exec(sql, params);
  if (!r.length || !r[0].values.length) return null;
  const { columns, values } = r[0];
  return Object.fromEntries(columns.map((c, i) => [c, values[0][i]]));
}

/**
 * Checks the local DB for patients with the same name, age AND sex.
 * Used for real-time duplicate detection — catches cases where the same patient
 * is being entered with a different (or missing) ART number.
 *
 * @param {string}      fullName   - Full name to match (case-insensitive, trimmed).
 * @param {number}      age        - Age in years.
 * @param {number}      sexId      - SexID (1 = Male, 2 = Female).
 * @param {string|null} excludeTID - PtDetailsTID to exclude (edit mode).
 * @returns {Object[]} Matching active patients (may be empty).
 */
function checkDuplicateName(fullName, age, sexId, excludeTID = null) {
  if (!fullName || !fullName.trim() || age < 0 || sexId <= 0) return [];
  let sql = `
    SELECT p.PtDetailsTID, p.ARTNo, p.PtName, p.Age, s.Sex, p.ARTStartDate
    FROM PtDetailsARTT p
    LEFT JOIN SexT s ON p.SexID = s.SexID
    WHERE LOWER(TRIM(p.PtName)) = LOWER(TRIM(?))
      AND p.Age = ? AND p.SexID = ? AND p.Deleted = 0`;
  const params = [fullName, age, sexId];
  if (excludeTID) { sql += ' AND p.PtDetailsTID != ?'; params.push(excludeTID); }
  const r = _db.exec(sql, params);
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

