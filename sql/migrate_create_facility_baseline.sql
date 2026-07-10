-- =============================================================================
-- FacilityBaselineT — Cumulative ART baseline counts per facility
-- sql/migrate_create_facility_baseline.sql
--
-- PURPOSE:
--   Stores the historically-known cumulative number of patients ever started
--   on ART at each facility as of a specific cut-off date (BaselineDate).
--
--   The report engine uses this when a facility has not entered all historical
--   patient records into the system.  For any report period that is *after*
--   the baseline date, Section (i) is computed as:
--
--     Section_i_count = BaselineCount
--                     + patients entered in the system whose ARTStartDate
--                       is strictly AFTER BaselineDate and <= last day of
--                       the previous reporting period.
--
--   This lets a facility that starts using the system today still produce
--   accurate cumulative reports by entering one set of "opening balance"
--   figures rather than all historical patient records.
--
-- USAGE:
--   Run once in SSMS against the production database.
-- =============================================================================

USE [db_ac602a_v6nkwi3rvw];
GO

IF OBJECT_ID('FacilityBaselineT', 'U') IS NOT NULL
BEGIN
  PRINT 'FacilityBaselineT already exists — skipping.';
  RETURN;
END
GO

CREATE TABLE FacilityBaselineT
(
    -- Primary key
    FacilityBaselineID  INT              NOT NULL IDENTITY(1,1)
        CONSTRAINT PK_FacilityBaselineT PRIMARY KEY,

    -- One row per facility (enforced by unique index below)
    HealthFacilityID    INT              NOT NULL
        CONSTRAINT FK_FacilityBaselineT_HF
            FOREIGN KEY REFERENCES HealthFacilityT(HealthFacilityID),

    -- The date AS OF WHICH the counts below are accurate.
    -- Always stored as the LAST DAY of the chosen month (e.g. 2025-12-31).
    -- Reports whose period start is on or before this date cannot be generated.
    BaselineDate        DATE             NOT NULL,

    -- ── Cumulative ART count by age group × sex ──────────────────────────
    -- Age group index:  0=<1yr  1=1-4  2=5-9  3=10-14  4=15-19  5=20-24
    --                   6=25-29  7=30-34  8=35-39  9=40-44  10=45-49  11=50+
    -- _M = Male, _F = Female
    AgeGrp0_M    INT NOT NULL CONSTRAINT DF_FBT_AG0M  DEFAULT 0,
    AgeGrp0_F    INT NOT NULL CONSTRAINT DF_FBT_AG0F  DEFAULT 0,
    AgeGrp1_M    INT NOT NULL CONSTRAINT DF_FBT_AG1M  DEFAULT 0,
    AgeGrp1_F    INT NOT NULL CONSTRAINT DF_FBT_AG1F  DEFAULT 0,
    AgeGrp2_M    INT NOT NULL CONSTRAINT DF_FBT_AG2M  DEFAULT 0,
    AgeGrp2_F    INT NOT NULL CONSTRAINT DF_FBT_AG2F  DEFAULT 0,
    AgeGrp3_M    INT NOT NULL CONSTRAINT DF_FBT_AG3M  DEFAULT 0,
    AgeGrp3_F    INT NOT NULL CONSTRAINT DF_FBT_AG3F  DEFAULT 0,
    AgeGrp4_M    INT NOT NULL CONSTRAINT DF_FBT_AG4M  DEFAULT 0,
    AgeGrp4_F    INT NOT NULL CONSTRAINT DF_FBT_AG4F  DEFAULT 0,
    AgeGrp5_M    INT NOT NULL CONSTRAINT DF_FBT_AG5M  DEFAULT 0,
    AgeGrp5_F    INT NOT NULL CONSTRAINT DF_FBT_AG5F  DEFAULT 0,
    AgeGrp6_M    INT NOT NULL CONSTRAINT DF_FBT_AG6M  DEFAULT 0,
    AgeGrp6_F    INT NOT NULL CONSTRAINT DF_FBT_AG6F  DEFAULT 0,
    AgeGrp7_M    INT NOT NULL CONSTRAINT DF_FBT_AG7M  DEFAULT 0,
    AgeGrp7_F    INT NOT NULL CONSTRAINT DF_FBT_AG7F  DEFAULT 0,
    AgeGrp8_M    INT NOT NULL CONSTRAINT DF_FBT_AG8M  DEFAULT 0,
    AgeGrp8_F    INT NOT NULL CONSTRAINT DF_FBT_AG8F  DEFAULT 0,
    AgeGrp9_M    INT NOT NULL CONSTRAINT DF_FBT_AG9M  DEFAULT 0,
    AgeGrp9_F    INT NOT NULL CONSTRAINT DF_FBT_AG9F  DEFAULT 0,
    AgeGrp10_M   INT NOT NULL CONSTRAINT DF_FBT_AG10M DEFAULT 0,
    AgeGrp10_F   INT NOT NULL CONSTRAINT DF_FBT_AG10F DEFAULT 0,
    AgeGrp11_M   INT NOT NULL CONSTRAINT DF_FBT_AG11M DEFAULT 0,
    AgeGrp11_F   INT NOT NULL CONSTRAINT DF_FBT_AG11F DEFAULT 0,

    -- CTX / Dapsone totals as of BaselineDate
    CTXTotal        INT  NOT NULL CONSTRAINT DF_FBT_CTX     DEFAULT 0,
    DapsoneTotal    INT  NOT NULL CONSTRAINT DF_FBT_Dapsone DEFAULT 0,

    -- When StartedFromZero = 1 the facility explicitly confirmed that they
    -- had zero patients before the baseline date.  The UI suppresses repeated
    -- "missing baseline" alerts for this facility.
    StartedFromZero BIT  NOT NULL CONSTRAINT DF_FBT_SFZ     DEFAULT 0,

    -- Optional free-text note (e.g. "Confirmed by facility manager, Jan 2026")
    Notes           NVARCHAR(500) NULL,

    -- Audit
    CreatedByUserTID  UNIQUEIDENTIFIER NULL,
    CreatedOn         DATETIME2        NOT NULL CONSTRAINT DF_FBT_CreatedOn DEFAULT GETDATE(),
    LastModByUserTID  UNIQUEIDENTIFIER NULL,
    LastModOn         DATETIME2        NOT NULL CONSTRAINT DF_FBT_LastModOn DEFAULT GETDATE()
);
GO

-- One baseline record per facility
CREATE UNIQUE INDEX UX_FacilityBaselineT_Facility
    ON FacilityBaselineT(HealthFacilityID);
GO

PRINT 'FacilityBaselineT created successfully.';
GO
