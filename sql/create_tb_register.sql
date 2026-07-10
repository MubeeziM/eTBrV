-- =============================================================================
-- Unit TB Register — SQL Server Schema
-- sql/create_tb_register.sql
--
-- Creates all lookup tables, the three core TB register tables (PtDetailsT,
-- PtFollowUpT, PresumptiveCaseT), and supporting indexes.
--
-- Run ONCE in SSMS against the central production database.  Safe to re-run:
-- a guard at the top skips the script when the tables already exist.
--
-- Prerequisites: create_patients_table.sql must have been run first
-- (it creates SexT, CountyT, StateT, HealthFacilityT, DataSourceT).
--
-- Target database: db_ac602a_v6nkwi3rvw
-- =============================================================================

USE [db_ac602a_v6nkwi3rvw];
GO

-- Each CREATE TABLE below is guarded with IF OBJECT_ID() IS NULL,
-- making this script safe to re-run (idempotent) on any database state.
GO

-- =============================================================================
-- LOOKUP / REFERENCE TABLES
--
-- Convention (matches ART register):
--   • Each table has an ID=0 row ('Not recorded') so that NOT NULL DEFAULT 0
--     FK columns are always valid.
--   • Fixed-ID tables (etbrss compatibility) use plain INTEGER PK.
--   • All IDs and OrderBy values match the source etbrss database exactly.
-- =============================================================================

-- ── Sputum smear microscopy result ──────────────────────────────────────────
-- Fixed IDs: no IDENTITY — must match etbrss SputumResultT for import compat.
IF OBJECT_ID('SputumResultT', 'U') IS NULL
BEGIN
    CREATE TABLE SputumResultT (
        SputumResultID  INTEGER NOT NULL CONSTRAINT PK_SputumResultT PRIMARY KEY,
        SputumResult    NVARCHAR(255) NULL,
        OrderBy         INTEGER NULL
    );
    INSERT INTO SputumResultT (SputumResultID, SputumResult, OrderBy) VALUES
        (0, N'Not recorded',    0),
        (1, N'Scanty AFBs Seen',2),
        (2, N'No AFB Seen',     1),
        (3, N'Select One',      7),
        (4, N'1+ AFBs Seen',    3),
        (5, N'2+ AFBs Seen',    4),
        (6, N'3+ AFBs Seen',    5),
        (7, N'NO Smear Done',   6);
END

-- ── Method of diagnosis (register column 15) ─────────────────────────────────
IF OBJECT_ID('DiagMethodT', 'U') IS NULL
BEGIN
    CREATE TABLE DiagMethodT (
        DiagMethodID  INTEGER NOT NULL CONSTRAINT PK_DiagMethodT PRIMARY KEY,
        DiagMethod    VARCHAR(255) NULL,
        OrderID       INTEGER NULL
    );
    INSERT INTO DiagMethodT (DiagMethodID, DiagMethod, OrderID) VALUES
        (0, N'Not recorded',                          0),
        (1, N'GeneXpert',                             1),
        (2, N'Smear Microscopy',                      2),
        (3, N'TB LAM',                                3),
        (4, N'Truenat',                               4),
        (5, N'Others:- Chest Xray/Clinically etc',    5);
END

-- ── GeneXpert / Xpert result ─────────────────────────────────────────────────
IF OBJECT_ID('XpertResultT', 'U') IS NULL
BEGIN
    CREATE TABLE XpertResultT (
        XpertResultID    INTEGER NOT NULL CONSTRAINT PK_XpertResultT PRIMARY KEY,
        XpertResult      NVARCHAR(255) NULL,
        FullXpertResult  NVARCHAR(255) NULL
    );
    INSERT INTO XpertResultT (XpertResultID, XpertResult, FullXpertResult) VALUES
        (0, N'Not recorded', N'Not recorded'),
        (1, N'Not Done',     N'Not Done'),
        (2, N'N',            N'N: MTB not detected'),
        (3, N'T',            N'T: MTB detected rifampicin resistance not detected'),
        (4, N'TI',           N'TI: MTB detected rifampicin resistance indeterminate'),
        (5, N'RR',           N'RR: MTB detected rifampicin resistance detected'),
        (6, N'I',            N'I: Invalid/Error/No result'),
        (7, N'Select One',   N'Select One');
END

-- ── HIV test result ───────────────────────────────────────────────────────────
-- Fixed IDs (not IDENTITY) — must match etbrss HIVResultT.
IF OBJECT_ID('HIVResultT', 'U') IS NULL
BEGIN
    CREATE TABLE HIVResultT (
        HIVResultID  INTEGER NOT NULL CONSTRAINT PK_HIVResultT PRIMARY KEY,
        HIVResult    NVARCHAR(255) NULL,
        OrderBy      INTEGER NULL
    );
    INSERT INTO HIVResultT (HIVResultID, HIVResult, OrderBy) VALUES
        (0, N'Not recorded',     0),
        (1, N'Negative',         1),
        (2, N'Positive',         2),
        (3, N'Select One',       4),
        (4, N'Not Done/Unknown', 3);
END

-- ── TB site type: Pulmonary (P) / Extra-pulmonary (EP) ───────────────────────
-- Fixed IDs: 1=P, 3=EP, 4=Select One (gap at 2 matches etbrss — intentional).
-- SSMA_TimeStamp from Access removed; PK added.
IF OBJECT_ID('TbTypeT', 'U') IS NULL
BEGIN
    CREATE TABLE TbTypeT (
        TbTypeID  INTEGER NOT NULL CONSTRAINT PK_TbTypeT PRIMARY KEY,
        TbType    NVARCHAR(255) NULL
    );
    INSERT INTO TbTypeT (TbTypeID, TbType) VALUES
        (0, N'Not recorded'),
        (1, N'P'),
        (3, N'EP'),
        (4, N'Select One');
END

-- ── Patient type (register column 11) ────────────────────────────────────────
IF OBJECT_ID('PtTypeT', 'U') IS NULL
BEGIN
    CREATE TABLE PtTypeT (
        PtTypeID     INTEGER NOT NULL CONSTRAINT PK_PtTypeT PRIMARY KEY,
        PtType       NVARCHAR(255) NULL,
        PtTypeShort  VARCHAR(10) NULL
    );
    INSERT INTO PtTypeT (PtTypeID, PtType, PtTypeShort) VALUES
        (0, N'Not recorded',          N''),
        (1, N'New',                   N'N'),
        (2, N'Relapse',               N'R'),
        (3, N'After Failure',         N'F'),
        (4, N'Treatment Interrupted', N'D'),
        (5, N'Transfer In',           N'TI'),
        (6, N'Others',                N'O'),
        (7, N'Select One',            N'');
END

-- ── Treatment outcome (register columns 24–29) ───────────────────────────────
IF OBJECT_ID('OutcomeT', 'U') IS NULL
BEGIN
    CREATE TABLE OutcomeT (
        OutcomeID  INTEGER NOT NULL CONSTRAINT PK_OutcomeT PRIMARY KEY,
        Outcome    NVARCHAR(255) NULL
    );
    INSERT INTO OutcomeT (OutcomeID, Outcome) VALUES
        (0, N'Not recorded'),
        (1, N'Cured'),
        (2, N'Completed'),
        (3, N'Died'),
        (4, N'Treatment Failure'),
        (5, N'Lost To Follow Up'),
        (6, N'Not Evaluated'),
        (7, N'Select One');
END

-- ── TB treatment regimen (register column 13) ────────────────────────────────
-- Fixed IDs (not IDENTITY) — must match etbrss RegimenT for import compat.
-- Note: this is the TB RegimenT, distinct from the ART RegimenARTT.
-- PK named PK_TBRegimenT to avoid clash with PK_RegimenT still on RegimenARTT.
IF OBJECT_ID('RegimenT', 'U') IS NULL
BEGIN
    CREATE TABLE RegimenT (
        RegimenID   INTEGER NOT NULL CONSTRAINT PK_TBRegimenT PRIMARY KEY,
        Regimen     NVARCHAR(255) NULL,
        OrderByID   INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO RegimenT (RegimenID, Regimen, OrderByID) VALUES
        (0, N'Not recorded',       0),
        (1, N'2HRZE/4RH',          1),
        (2, N'2SHRZE/1HRZE/5RHE',  2),
        (3, N'2HRZE/10RH',         3),
        (4, N'Select One',         6),
        (5, N'2RHZE/2RH',          4),
        (6, N'2RHE/7RH',           5);
END

-- ── Referral source (register column 6) ──────────────────────────────────────
IF OBJECT_ID('ReferredByT', 'U') IS NULL
BEGIN
    CREATE TABLE ReferredByT (
        ReferredByID  INTEGER NOT NULL CONSTRAINT PK_ReferredByT PRIMARY KEY,
        ReferredBy    NVARCHAR(255) NULL
    );
    INSERT INTO ReferredByT (ReferredByID, ReferredBy) VALUES
        (0, N'Not recorded'),
        (1, N'Self'),
        (2, N'Community Member'),
        (3, N'Public Facility'),
        (4, N'Private Clinic/Hospital'),
        (5, N'HHPs'),
        (6, N'Others'),
        (7, N'Select One');
END

-- ── Month (for PresumptiveCaseT) ──────────────────────────────────────────────
IF OBJECT_ID('MonthT', 'U') IS NULL
BEGIN
    CREATE TABLE MonthT (
        MonthID    INTEGER NOT NULL CONSTRAINT PK_MonthT PRIMARY KEY,
        MonthName  NVARCHAR(255) NULL
    );
    INSERT INTO MonthT (MonthID, MonthName) VALUES
        (1,  N'January'),  (2,  N'February'), (3,  N'March'),
        (4,  N'April'),    (5,  N'May'),      (6,  N'June'),
        (7,  N'July'),     (8,  N'August'),   (9,  N'September'),
        (10, N'October'),  (11, N'November'), (12, N'December');
END

-- ── Year (for PresumptiveCaseT) ───────────────────────────────────────────────
IF OBJECT_ID('YearT', 'U') IS NULL
BEGIN
    CREATE TABLE YearT (
        YearID    INTEGER NOT NULL CONSTRAINT PK_YearT PRIMARY KEY,
        YearName  INTEGER NULL
    );
    INSERT INTO YearT (YearID, YearName) VALUES
        (1,  2015), (2,  2016), (3,  2017), (4,  2018),
        (5,  2019), (6,  2020), (7,  2021), (8,  2022),
        (9,  2023), (10, 2024), (11, 2025), (12, 2026),
        (13, 2027);
END
GO

-- =============================================================================
-- MAIN TABLE: PtDetailsT
--
-- Improvements vs. old etbrss PtDetailsT:
--   • PtDetailsTID upgraded nvarchar(255) → UNIQUEIDENTIFIER (NEWSEQUENTIALID)
--   • Age [float] → Age INT + DateOfBirth DATE (DOB-driven calculation)
--   • RegDate, DateRxStarted: INT → DATE
--   • Proper FK constraints to all lookup tables
--   • Sync fields standardised: HasChanged, Deleted, LastModOn, CreatedOn,
--     EnteredByID (server-stamped from JWT)
--   • Removed Access artifacts: Imported, SentDate, Downloaded, Uploaded,
--     PtLanguageID
--   • Address columns (Village, Boma, Payam, County) kept as-is for import
--     compatibility; NearestHFID = treating facility (from facility selector)
-- =============================================================================

-- PK/FK names prefixed TB to avoid clash with same-named constraints on PtDetailsARTT
-- (sp_rename does not rename constraints when a table is renamed).
IF OBJECT_ID('PtDetailsT', 'U') IS NULL
BEGIN
    CREATE TABLE PtDetailsT (

        -- ── Identity & sync ──────────────────────────────────────────────────────
        PtDetailsTID    UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID()
                            CONSTRAINT PK_TBPtDetailsT PRIMARY KEY,
        PatientID       INTEGER IDENTITY(1,1) NOT NULL,
        NearestHFID     INTEGER NOT NULL DEFAULT 0
                            CONSTRAINT FK_TBPtDetailsT_HF     REFERENCES HealthFacilityT(HealthFacilityID),
        DataSourceID    INTEGER NOT NULL DEFAULT 0
                            CONSTRAINT FK_TBPtDetailsT_DS     REFERENCES DataSourceT(DataSourceID),
        CountyID        INTEGER NOT NULL DEFAULT 0
                            CONSTRAINT FK_TBPtDetailsT_County REFERENCES CountyT(CountyID),
        EnteredByID     UNIQUEIDENTIFIER NULL,
        HasChanged      INTEGER NOT NULL DEFAULT 1,
        Deleted         BIT     NOT NULL DEFAULT 0,
        LastModOn       DATETIME2(3) NOT NULL DEFAULT GETDATE(),
        CreatedOn       DATETIME2(3) NOT NULL DEFAULT GETDATE(),

        -- ── Register column 1: Registration date ─────────────────────────────────
        RegDate         DATE NULL,

        -- ── Register column 2: TB treatment register number ──────────────────────
        UnitTBNo        VARCHAR(30) NULL,

        -- ── Register column 3: Patient name ──────────────────────────────────────
        PtName          VARCHAR(100) NOT NULL,

        -- ── Register column 4: Age ───────────────────────────────────────────────
        -- DateOfBirth drives Age when available; Age entered manually otherwise.
        DateOfBirth     DATE NULL,
        Age             INTEGER NOT NULL DEFAULT 0,
        -- Months component for infants under 1 year (0–11). NULL when not applicable.
        AgeMonths       INTEGER NULL,

        -- ── Register column 5: Sex ───────────────────────────────────────────────
        SexID           INTEGER NOT NULL DEFAULT 0
                            CONSTRAINT FK_TBPtDetailsT_Sex REFERENCES SexT(SexID),

        -- ── Register column 6: Referred by ───────────────────────────────────────
        ReferredByID    INTEGER NOT NULL DEFAULT 0
                            CONSTRAINT FK_TBPtDetailsT_Ref REFERENCES ReferredByT(ReferredByID),

        -- ── Register column 7: Complete physical address ─────────────────────────
        -- Village, Boma, Payam = where the patient lives (free text).
        -- County here is the patient's home county (free text), distinct from
        -- CountyID above which is the treating facility's county (server-resolved).
        Village         VARCHAR(100) NULL,
        Boma            VARCHAR(100) NULL,
        Payam           VARCHAR(100) NULL,
        County          VARCHAR(100) NULL,

        -- ── Register column 8: Telephone ─────────────────────────────────────────
        PtPhone         VARCHAR(15) NULL,

        -- ── Register column 9: Treatment health facility → NearestHFID above ─────

        -- ── Register column 10: Site P / EP ──────────────────────────────────────
        TbTypeID        INTEGER NOT NULL DEFAULT 0
                            CONSTRAINT FK_TBPtDetailsT_TbType REFERENCES TbTypeT(TbTypeID),

        -- ── Register column 11: Type of patient ──────────────────────────────────
        PtTypeID        INTEGER NOT NULL DEFAULT 0
                            CONSTRAINT FK_TBPtDetailsT_PtType REFERENCES PtTypeT(PtTypeID),
        TIHF            VARCHAR(100) NULL,   -- Transfer-in: source health facility name
        TICounty        VARCHAR(100) NULL,   -- Transfer-in: source county name

        -- ── Register column 12: Date treatment started ───────────────────────────
        DateRxStarted   DATE NULL,

        -- ── Register column 13: Treatment regimen ────────────────────────────────
        RegimenID       INTEGER NOT NULL DEFAULT 0
                            CONSTRAINT FK_TBPtDetailsT_Regimen REFERENCES RegimenT(RegimenID),

        -- ── Register column 15: Method of diagnosis ──────────────────────────────
        DiagMethodID    INTEGER NOT NULL DEFAULT 0
                            CONSTRAINT FK_TBPtDetailsT_Diag REFERENCES DiagMethodT(DiagMethodID),

        -- ── Administrative ───────────────────────────────────────────────────────
        CountryID       INTEGER NOT NULL DEFAULT 1

    );

    CREATE INDEX IX_PtDetailsT_PtName      ON PtDetailsT(PtName);
    CREATE INDEX IX_PtDetailsT_UnitTBNo    ON PtDetailsT(UnitTBNo);
    CREATE INDEX IX_PtDetailsT_HasChanged  ON PtDetailsT(HasChanged);
    CREATE INDEX IX_PtDetailsT_NearestHFID ON PtDetailsT(NearestHFID);
END
GO

-- =============================================================================
-- CHILD TABLE: PtFollowUpT
--
-- One row per patient — stores all smear follow-up results, HIV/Xpert at
-- baseline, treatment outcome, ART/CPT activities, and remarks.
--
-- Improvements vs. old etbrss PtFollowUpT:
--   • PtFollowUpTID: nvarchar(255) → UNIQUEIDENTIFIER
--   • PtDetailsTID:  nvarchar(255) → UNIQUEIDENTIFIER FK → PtDetailsT
--   • All date INT fields → DATE
--   • SSMA_TimeStamp removed; replaced with LastModOn + CreatedOn
--   • HasChanged, Deleted, EnteredByID added (standard sync fields)
--   • FK constraints added for all lookup ID columns
--   • Remarks widened to VARCHAR(500)
--   • "Mon6" = End-of-treatment smear (legacy naming preserved for import compat)
-- =============================================================================

-- PK/FK names prefixed TB to avoid clash with same-named constraints on PtFollowUpARTT.
IF OBJECT_ID('PtFollowUpT', 'U') IS NULL
BEGIN
    CREATE TABLE PtFollowUpT (

        -- ── Identity & sync ──────────────────────────────────────────────────────
        PtFollowUpTID       UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID()
                                CONSTRAINT PK_TBPtFollowUpT PRIMARY KEY,
        PtFollowUpID        INTEGER IDENTITY(1,1) NOT NULL,
        PtDetailsTID        UNIQUEIDENTIFIER NOT NULL
                                CONSTRAINT FK_TBPtFollowUpT_PtDetails REFERENCES PtDetailsT(PtDetailsTID),
        HasChanged          INTEGER NOT NULL DEFAULT 1,
        Deleted             BIT     NOT NULL DEFAULT 0,
        LastModOn           DATETIME2(3) NOT NULL DEFAULT GETDATE(),
        CreatedOn           DATETIME2(3) NOT NULL DEFAULT GETDATE(),
        EnteredByID         UNIQUEIDENTIFIER NULL,

        -- ── Register column 14: Before treatment ─────────────────────────────────
        Mon0Date            DATE NULL,
        Mon0LabNo           VARCHAR(30) NULL,
        Mon0LabResultID     INTEGER NOT NULL DEFAULT 0
                                CONSTRAINT FK_TBPtFollowUpT_Mon0Smear REFERENCES SputumResultT(SputumResultID),
        Mon0XpertResultID   INTEGER NOT NULL DEFAULT 0
                                CONSTRAINT FK_TBPtFollowUpT_Mon0Xpert REFERENCES XpertResultT(XpertResultID),
        Mon0XpertResultDate DATE NULL,
        HIVTestDate         DATE NULL,
        HIVTestResultID     INTEGER NOT NULL DEFAULT 0
                                CONSTRAINT FK_TBPtFollowUpT_HIV      REFERENCES HIVResultT(HIVResultID),
        DSTResult           VARCHAR(100) NULL,   -- Drug susceptibility testing (free text)

        -- ── Register columns 16–17: 2nd month follow-up ──────────────────────────
        Mon2Date            DATE NULL,
        Mon2LabNo           VARCHAR(30) NULL,
        Mon2LabResultID     INTEGER NOT NULL DEFAULT 0
                                CONSTRAINT FK_TBPtFollowUpT_Mon2Smear REFERENCES SputumResultT(SputumResultID),

        -- ── Register columns 18–19: 3rd month follow-up ──────────────────────────
        Mon3Date            DATE NULL,
        Mon3LabNo           VARCHAR(30) NULL,
        Mon3LabResultID     INTEGER NOT NULL DEFAULT 0
                                CONSTRAINT FK_TBPtFollowUpT_Mon3Smear REFERENCES SputumResultT(SputumResultID),

        -- ── Register columns 20–21: 5th month follow-up ──────────────────────────
        Mon5Date            DATE NULL,
        Mon5LabNo           VARCHAR(30) NULL,
        Mon5LabResultID     INTEGER NOT NULL DEFAULT 0
                                CONSTRAINT FK_TBPtFollowUpT_Mon5Smear REFERENCES SputumResultT(SputumResultID),

        -- ── Register columns 22–23: End of treatment ("Mon6" = legacy name) ──────
        Mon6Date            DATE NULL,
        Mon6LabNo           VARCHAR(30) NULL,
        Mon6LabResultID     INTEGER NOT NULL DEFAULT 0
                                CONSTRAINT FK_TBPtFollowUpT_Mon6Smear REFERENCES SputumResultT(SputumResultID),

        -- ── Register columns 24–29: Treatment outcome ────────────────────────────
        OutcomeID           INTEGER NOT NULL DEFAULT 0
                                CONSTRAINT FK_TBPtFollowUpT_Outcome   REFERENCES OutcomeT(OutcomeID),
        OutcomeDate         DATE NULL,
        TOHF                VARCHAR(100) NULL,   -- Transfer-out: destination facility
        TOCounty            VARCHAR(100) NULL,   -- Transfer-out: destination county

        -- ── Register column 30: ART (TB/HIV activity) ────────────────────────────
        OnART               INTEGER NOT NULL DEFAULT 0,
        ARTDate             DATE NULL,

        -- ── Register column 31: CPT (TB/HIV activity) ────────────────────────────
        OnCPT               INTEGER NOT NULL DEFAULT 0,
        CPTDate             DATE NULL,

        -- ── Register column 32: Moved to second-line regimen ─────────────────────
        MovedTo2ndLine      BIT NOT NULL DEFAULT 0,

        -- ── Register column 33: Remarks / Comments ───────────────────────────────
        Remarks             VARCHAR(500) NULL

        -- Register column 34 (Provide Initial) is captured server-side via
        -- EnteredByID (JWT claim) — no separate column needed.

    );

    CREATE INDEX IX_PtFollowUpT_PtDetailsTID ON PtFollowUpT(PtDetailsTID);
    CREATE INDEX IX_PtFollowUpT_HasChanged   ON PtFollowUpT(HasChanged);
END
GO

-- =============================================================================
-- AGGREGATE TABLE: PresumptiveCaseT
--
-- One row per facility per month/year — monthly count of presumptive TB cases
-- examined at the facility.
--
-- Improvements vs. old etbrss PresumptiveCaseT:
--   • PresumptiveCaseTID: nvarchar(255) → UNIQUEIDENTIFIER
--   • SSMA_TimeStamp removed; replaced with LastModOn DATETIME2(3)
--   • FK constraints added for MonthID, YearID, NearestHFID, etc.
--   • LocationID, SubRecID retained as nullable for import compatibility
--   • Unique constraint prevents duplicate monthly entries per facility
-- =============================================================================

IF OBJECT_ID('PresumptiveCaseT', 'U') IS NULL
BEGIN
    CREATE TABLE PresumptiveCaseT (

        -- ── Identity & sync ──────────────────────────────────────────────────────
        PresumptiveCaseTID  UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID()
                                CONSTRAINT PK_PresumptiveCaseT PRIMARY KEY,
        PresumptiveCaseID   INTEGER IDENTITY(1,1) NOT NULL,

        -- ── Tally data ────────────────────────────────────────────────────────────
        PresumptiveCase     INTEGER NULL,           -- count of presumptive cases this month

        -- ── Period ────────────────────────────────────────────────────────────────
        MonthID             INTEGER NULL
                                CONSTRAINT FK_PresumptiveCaseT_Month  REFERENCES MonthT(MonthID),
        YearID              INTEGER NULL
                                CONSTRAINT FK_PresumptiveCaseT_Year   REFERENCES YearT(YearID),

        -- ── Facility hierarchy ───────────────────────────────────────────────────
        NearestHFID         INTEGER NOT NULL DEFAULT 0
                                CONSTRAINT FK_PresumptiveCaseT_HF     REFERENCES HealthFacilityT(HealthFacilityID),
        DataSourceID        INTEGER NOT NULL DEFAULT 0
                                CONSTRAINT FK_PresumptiveCaseT_DS     REFERENCES DataSourceT(DataSourceID),
        CountyID            INTEGER NOT NULL DEFAULT 0
                                CONSTRAINT FK_PresumptiveCaseT_County REFERENCES CountyT(CountyID),

        -- ── Legacy fields retained for import compatibility ───────────────────────
        LocationID          INTEGER NULL DEFAULT 0,
        SubRecID            INTEGER NULL DEFAULT 0,

        -- ── Sync flags ────────────────────────────────────────────────────────────
        HasChanged          BIT NOT NULL DEFAULT 1,
        Uploaded            BIT NOT NULL DEFAULT 0,
        Imported            BIT NOT NULL DEFAULT 0,
        LastModOn           DATETIME2(3) NOT NULL DEFAULT GETDATE(),
        EnteredByID         UNIQUEIDENTIFIER NULL,

        -- ── Prevent duplicate monthly entries per facility ────────────────────────
        CONSTRAINT UQ_PresumptiveCaseT_Period UNIQUE (MonthID, YearID, NearestHFID)

    );

    CREATE INDEX IX_PresumptiveCaseT_HF ON PresumptiveCaseT(NearestHFID, YearID, MonthID);
END
GO

PRINT '';
PRINT 'Unit TB Register schema created successfully.';
PRINT '';
PRINT 'Tables created:';
PRINT '  Lookups : SputumResultT, DiagMethodT, XpertResultT, HIVResultT,';
PRINT '            TbTypeT, PtTypeT, OutcomeT, RegimenT, ReferredByT,';
PRINT '            MonthT, YearT';
PRINT '  Main    : PtDetailsT, PtFollowUpT, PresumptiveCaseT';
PRINT '';
PRINT 'Next steps:';
PRINT '  1. Run create_audit_trigger.sql to add audit triggers on PtDetailsT.';
PRINT '  2. Deploy updated application code (API + PWA).';
GO
