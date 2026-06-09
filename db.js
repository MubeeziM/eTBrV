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

// ─── Utility helpers ──────────────────────────────────────────────────────

function generateGUID() { return crypto.randomUUID(); }

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

const CREATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS SexT (SexID INTEGER PRIMARY KEY, Sex TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS OccupationT (OccupationID INTEGER PRIMARY KEY, Occupation TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS KeyPopuT (KeyPopuID INTEGER PRIMARY KEY, KeyPopu TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS WHOStageT (WHOStageID INTEGER PRIMARY KEY, WHOStage TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS BreastfeedingT (BreastfeedingID INTEGER PRIMARY KEY, Breastfeeding TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS CPTDrugT (CPTDrugID INTEGER PRIMARY KEY, CPTDrug TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS RegimenCategoryT (RegimenCategoryID INTEGER PRIMARY KEY, RegimenCategory TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS RegimenT (
    RegimenID INTEGER PRIMARY KEY, RegimenCode TEXT NOT NULL,
    Regimen TEXT NOT NULL, RegimenCategoryID INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS RegimenChangeReasonT (RegimenChangeReasonID INTEGER PRIMARY KEY, RegimenChangeReason TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS FollowUpStatusT (FollowUpStatusID INTEGER PRIMARY KEY, FollowUpStatus TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS TBStatusT (TBStatusID INTEGER PRIMARY KEY, TBStatus TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS StopReasonT (StopReasonID INTEGER PRIMARY KEY, StopReason TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS CountyT (CountyID INTEGER PRIMARY KEY, County TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS HealthFacilityT (HFacilityID INTEGER PRIMARY KEY, HFacility TEXT NOT NULL, CountyID INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS DataSourceT (DataSourceID INTEGER PRIMARY KEY, DataSource TEXT NOT NULL, HFacilityID INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS UsersT (UserTID TEXT PRIMARY KEY, UserName TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS PtDetailsT (
    PtDetailsTID         TEXT PRIMARY KEY,
    LocalSeqNo           INTEGER,
    NearestHFID          INTEGER NOT NULL DEFAULT 0,
    DataSourceID         INTEGER NOT NULL DEFAULT 0,
    CountyID             INTEGER NOT NULL DEFAULT 0,
    EnteredByID          TEXT    NOT NULL DEFAULT '',
    HasChanged           INTEGER NOT NULL DEFAULT 1,
    LastModOn            TEXT    NOT NULL DEFAULT '',
    CreatedOn            TEXT    NOT NULL DEFAULT '',
    HIVRetest            INTEGER NOT NULL DEFAULT 0,
    ARTNo                TEXT    NOT NULL DEFAULT '',
    ARTStartDate         TEXT,
    DateEnrolledInCare   TEXT,
    FullName             TEXT    NOT NULL DEFAULT '',
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
  CREATE UNIQUE INDEX IF NOT EXISTS UQ_PtDetailsT_ARTNo ON PtDetailsT (ARTNo);

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

  CREATE TABLE IF NOT EXISTS PtFollowUpT (
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
    ViralLoad        TEXT,
    Notes            TEXT,
    EnteredByID      TEXT NOT NULL DEFAULT '',
    HasChanged       INTEGER NOT NULL DEFAULT 1,
    LastModOn        TEXT NOT NULL DEFAULT '',
    CreatedOn        TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS IDX_PtFollowUpT_PtID ON PtFollowUpT (PtDetailsTID)
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
  INSERT OR IGNORE INTO RegimenT VALUES
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
  INSERT OR IGNORE INTO HealthFacilityT VALUES (0,'Not configured',0);
  INSERT OR IGNORE INTO DataSourceT VALUES (0,'Not configured',0)
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
  const newResult    = _db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='PtDetailsT'`);
  const hasLegacy = legacyResult.length > 0 && legacyResult[0].values.length > 0;
  const hasNew    = newResult.length > 0 && newResult[0].values.length > 0;
  if (hasLegacy && !hasNew) {
    _db.run(`ALTER TABLE patients RENAME TO patients_legacy`);
    console.log('[DB] Migrated: patients → patients_legacy');
  }

  _db.exec(CREATE_SCHEMA_SQL);
  _db.exec(SEED_SQL);
  await _persistDB();
  console.log('[DB] Schema and seed data ready.');
}

async function _persistDB() {
  if (!_db) return;
  const data = _db.export();
  await saveToIDB(data);
}

// ─── PtDetailsT ──────────────────────────────────────────────────────────

async function insertPtDetails(data) {
  const tid = generateGUID();
  const now = _now();
  const bmi = calcBMI(data.WeightKg, data.HeightCm);
  _db.run(`
    INSERT INTO PtDetailsT (
      PtDetailsTID, NearestHFID, DataSourceID, CountyID, EnteredByID,
      HasChanged, LastModOn, CreatedOn,
      HIVRetest, ARTNo, ARTStartDate, DateEnrolledInCare,
      FullName, ResidenceAddress, Phone1, Phone2,
      OccupationID, OccupationOther, KeyPopuID, KeyPopuOther,
      Age, DateOfBirth, SexID,
      WeightKg, HeightCm, MUACCm, BMI,
      WHOStageID, CD4Value, CD4IsPercent,
      CPTStartDate, CPTDrugID, TBRxStartDate, UnitTBNo, TBStatusID,
      BreastfeedingID, IsTransferIn, TransferFromFacility,
      GuardianName, GuardianPhone1
    ) VALUES (
      ?,?,?,?,?,1,?,?,
      ?,?,?,?,?,?,?,?,
      ?,?,?,?,?,?,?,
      ?,?,?,?,?,?,?,
      ?,?,?,?,?,?,?,?,?,?
    )`,
    [
      tid, data.NearestHFID||0, data.DataSourceID||0, data.CountyID||0, data.EnteredByID||'',
      now, now,
      data.HIVRetest||0, data.ARTNo||'', data.ARTStartDate||null, data.DateEnrolledInCare||null,
      data.FullName||'', data.ResidenceAddress||null, data.Phone1||null, data.Phone2||null,
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
    SELECT p.PtDetailsTID, p.LocalSeqNo, p.ARTNo, p.FullName, p.Age,
           s.Sex, p.Phone1, p.ARTStartDate, p.HasChanged, p.CreatedOn
    FROM PtDetailsT p
    LEFT JOIN SexT s ON p.SexID = s.SexID
  `;
  const params = [];
  if (searchTerm.trim()) {
    sql += ` WHERE p.FullName LIKE ? OR p.ARTNo LIKE ? OR COALESCE(p.Phone1,'') LIKE ? OR COALESCE(p.Phone2,'') LIKE ?`;
    const like = `%${searchTerm.trim()}%`;
    params.push(like, like, like, like);
  }
  sql += ' ORDER BY p.CreatedOn DESC';
  const results = _db.exec(sql, params);
  if (!results.length) return [];
  const { columns, values } = results[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

function getPtDetails(ptDetailsTID) {
  const r = _db.exec('SELECT * FROM PtDetailsT WHERE PtDetailsTID = ?', [ptDetailsTID]);
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
  const r = _db.exec('SELECT * FROM PtDetailsT ORDER BY CreatedOn');
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

async function updatePtDetails(ptDetailsTID, data) {
  const now = _now();
  const bmi = calcBMI(data.WeightKg, data.HeightCm);
  _db.run(`
    UPDATE PtDetailsT SET
      HasChanged = 1, LastModOn = ?,
      HIVRetest = ?, ARTNo = ?, ARTStartDate = ?, DateEnrolledInCare = ?,
      FullName = ?, ResidenceAddress = ?, Phone1 = ?, Phone2 = ?,
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
      data.FullName||'', data.ResidenceAddress||null, data.Phone1||null, data.Phone2||null,
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
  for (const tbl of ['INHProphylaxisT','PMTCTPregnancyT','RegimenHistoryT','PtFollowUpT']) {
    _db.run(`DELETE FROM ${tbl} WHERE PtDetailsTID = ?`, [ptDetailsTID]);
  }
  _db.run('DELETE FROM PtDetailsT WHERE PtDetailsTID = ?', [ptDetailsTID]);
  await _persistDB();
  console.log(`[DB] deletePtDetails: ${ptDetailsTID}`);
}

async function deleteVisit(ptFollowUpTID) {
  _db.run('DELETE FROM PtFollowUpT WHERE PtFollowUpTID = ?', [ptFollowUpTID]);
  await _persistDB();
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
     LEFT JOIN RegimenT rt ON rh.RegimenID = rt.RegimenID
     LEFT JOIN RegimenChangeReasonT rc ON rh.ChangeReasonID = rc.RegimenChangeReasonID
     WHERE rh.PtDetailsTID = ?
     ORDER BY rh.RegimenLine, rh.SequenceNo`,
    [ptDetailsTID]
  );
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

// ─── PtFollowUpT ─────────────────────────────────────────────────────────

async function insertFollowUp(data, artStartDate) {
  const tid = generateGUID(), now = _now();
  const visitMonth = calcVisitMonth(artStartDate, data.VisitDate);
  const bmi = calcBMI(data.WeightKg, data.HeightCm);
  _db.run(
    `INSERT INTO PtFollowUpT (
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
  await _persistDB();
  return tid;
}

function getFollowUps(ptDetailsTID) {
  const r = _db.exec(
    `SELECT fu.*, fs.FollowUpStatus, rt.RegimenCode, rt.Regimen, ts.TBStatus
     FROM PtFollowUpT fu
     LEFT JOIN FollowUpStatusT fs ON fu.FollowUpStatusID = fs.FollowUpStatusID
     LEFT JOIN RegimenT rt ON fu.RegimenID = rt.RegimenID
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
    'SexT','OccupationT','KeyPopuT','WHOStageT','BreastfeedingT','CPTDrugT',
    'RegimenCategoryT','RegimenT','RegimenChangeReasonT','FollowUpStatusT',
    'TBStatusT','StopReasonT','CountyT','HealthFacilityT','DataSourceT'
  ];
  if (!allowed.includes(tableName)) throw new Error(`Unknown lookup table: ${tableName}`);
  const r = _db.exec(`SELECT * FROM ${tableName} ORDER BY 1`);
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

// ─── Export ───────────────────────────────────────────────────────────────

function exportDB() {
  if (!_db) throw new Error('Database is not initialised yet. Please wait and try again.');
  const data = _db.export();
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

// ─── Backward-compat shims ────────────────────────────────────────────────

function getAllPatients(s) { return getAllPtDetails(s); }
async function insertPatient(data) { return insertPtDetails(data); }
async function deletePatient() { console.warn('[DB] deletePatient() is deprecated; use deletePtDetails(guid).'); }
