-- =============================================================================
-- Migration: Create DHIS_LogT in db_ac602a_v6nkwi3rvw (new eTBr database)
--
-- Table name and schema deliberately mirror [db_ac602a_etbrss].[dbo].[DHIS_LogT]
-- (the legacy WebForms system) so that historical log rows can be bulk-copied
-- into this table with no column mapping changes required.
--
-- Column notes:
--   ActivityDate     OLE Automation date stored as FLOAT, matching the legacy
--                    system's CONVERT(float,getdate()) convention.
--                    C#: DateTime.UtcNow.ToOADate() → write; DateTime.FromOADate()
--                    → read back.
--
--   SubmittedUsingID 1 = old WebForms system (legacy rows).
--                    2 = new eTBr API (this system).
--
--   SuccessID        1 = DHIS2 responded with SUCCESS, 0 = error / HTTP failure.
--
--   HasChanged       Legacy flag — was this value revised after first submission?
--                    Set to 0 (false) by this system; reserved for future use.
--
--   DataSet          DHIS2 dataSet UID (e.g. CF or TO dataset ID).
--
--   UseTraining      Whether the training server was targeted for this submission.
--
--   SentByUserTID    JWT sub claim (GUID) of the submitting user — extended audit.
--
--   Dhis2Response    Raw HTTP response body from DHIS2 (truncated to 4000 chars).
--
-- Run ONCE in SSMS. Safe to re-run (IF OBJECT_ID guard for first-time creates;
-- conditional ADD COLUMN blocks for databases that ran an earlier version).
-- =============================================================================

USE [db_ac602a_v6nkwi3rvw];
GO

IF OBJECT_ID('DHIS_LogT', 'U') IS NULL
BEGIN
    CREATE TABLE DHIS_LogT (
        LogID               INT IDENTITY(1,1) NOT NULL
                                CONSTRAINT PK_DHIS_LogT
                                PRIMARY KEY CLUSTERED (LogID DESC),

        dataElement         VARCHAR(255) NULL,
        period              VARCHAR(255) NULL,
        orgUnit             VARCHAR(255) NULL,
        categoryOptionCombo VARCHAR(255) NULL,
        attributeOptionCombo VARCHAR(255) NULL,
        DataValue           INT          NULL,
        HealthFacilityID    INT          NULL,

        -- OLE Automation date (float days since 1899-12-30), same default as legacy
        ActivityDate        FLOAT        NULL
            CONSTRAINT DF_DHIS_LogT_ActivityDate
            DEFAULT (CONVERT(float, GETDATE())),

        UserID              INT          NULL,

        HasChanged          BIT          NULL
            CONSTRAINT DF_DHIS_LogT_HasChanged DEFAULT 0,

        -- 1 = old WebForms system, 2 = new eTBr API
        SubmittedUsingID    INT          NULL
            CONSTRAINT DF_DHIS_LogT_SubmittedUsingID DEFAULT 2,

        -- 1 = SUCCESS, 0 = failure  (mirrors legacy SuccessID semantics)
        SuccessID           INT          NULL
            CONSTRAINT DF_DHIS_LogT_SuccessID DEFAULT 1,

        -- Extended audit columns (new eTBr system; no equivalent in legacy rows)
        DataSet             VARCHAR(255) NULL,
        UseTraining         BIT          NULL
            CONSTRAINT DF_DHIS_LogT_UseTraining DEFAULT 1,
        SentByUserTID       UNIQUEIDENTIFIER NULL,
        Dhis2Response       VARCHAR(4000) NULL
    );

    CREATE INDEX IX_DHIS_LogT_OrgUnit      ON DHIS_LogT (orgUnit, period);
    CREATE INDEX IX_DHIS_LogT_ActivityDate ON DHIS_LogT (ActivityDate DESC);
END
GO

-- ── Add extended columns to any database that ran an earlier version ─────────
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID('DHIS_LogT') AND name = 'DataSet')
    ALTER TABLE DHIS_LogT ADD DataSet VARCHAR(255) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID('DHIS_LogT') AND name = 'UseTraining')
    ALTER TABLE DHIS_LogT ADD UseTraining BIT NULL
        CONSTRAINT DF_DHIS_LogT_UseTraining DEFAULT 1;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID('DHIS_LogT') AND name = 'SentByUserTID')
    ALTER TABLE DHIS_LogT ADD SentByUserTID UNIQUEIDENTIFIER NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID('DHIS_LogT') AND name = 'Dhis2Response')
    ALTER TABLE DHIS_LogT ADD Dhis2Response VARCHAR(4000) NULL;
GO

PRINT 'DHIS_LogT created/updated (or already existed).';
GO
