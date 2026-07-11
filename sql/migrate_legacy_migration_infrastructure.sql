-- ============================================================================
--  migrate_legacy_migration_infrastructure.sql
--  Run once against: db_ac602a_v6nkwi3rvw  (the NEW database)
--
--  What this script does:
--    1. Adds LegacyTID to PtDetailsT  — stores the original nvarchar PK from
--       the legacy Access-sourced database so records can never be double-imported.
--    2. Adds LegacyTID to PtFollowUpT — same purpose for follow-up records.
--    3. Creates MigratedFacilitiesT   — one row per DataSourceID once that
--       facility has been fully imported. Bridge logic queries this table to
--       decide whether to include a DataSourceID from the legacy DB.
-- ============================================================================

USE [db_ac602a_v6nkwi3rvw];
GO

-- ── 1. PtDetailsT: add LegacyTID ────────────────────────────────────────────
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE  object_id = OBJECT_ID('dbo.PtDetailsT')
    AND    name      = 'LegacyTID'
)
BEGIN
    ALTER TABLE [dbo].[PtDetailsT]
        ADD [LegacyTID] nvarchar(255) NULL;

    PRINT 'Column LegacyTID added to PtDetailsT.';
END
ELSE
    PRINT 'Column LegacyTID already exists in PtDetailsT — skipped.';
GO

-- Add a unique index so the same legacy record can never be imported twice.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE  object_id = OBJECT_ID('dbo.PtDetailsT')
    AND    name      = 'UQ_PtDetailsT_LegacyTID'
)
BEGIN
    CREATE UNIQUE NONCLUSTERED INDEX [UQ_PtDetailsT_LegacyTID]
        ON [dbo].[PtDetailsT] ([LegacyTID])
        WHERE [LegacyTID] IS NOT NULL;

    PRINT 'Unique index UQ_PtDetailsT_LegacyTID created on PtDetailsT.';
END
GO

-- ── 2. PtFollowUpT: add LegacyTID ───────────────────────────────────────────
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE  object_id = OBJECT_ID('dbo.PtFollowUpT')
    AND    name      = 'LegacyTID'
)
BEGIN
    ALTER TABLE [dbo].[PtFollowUpT]
        ADD [LegacyTID] nvarchar(255) NULL;

    PRINT 'Column LegacyTID added to PtFollowUpT.';
END
ELSE
    PRINT 'Column LegacyTID already exists in PtFollowUpT — skipped.';
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE  object_id = OBJECT_ID('dbo.PtFollowUpT')
    AND    name      = 'UQ_PtFollowUpT_LegacyTID'
)
BEGIN
    CREATE UNIQUE NONCLUSTERED INDEX [UQ_PtFollowUpT_LegacyTID]
        ON [dbo].[PtFollowUpT] ([LegacyTID])
        WHERE [LegacyTID] IS NOT NULL;

    PRINT 'Unique index UQ_PtFollowUpT_LegacyTID created on PtFollowUpT.';
END
GO

-- ── 3. Create MigratedFacilitiesT ───────────────────────────────────────────
IF NOT EXISTS (
    SELECT 1 FROM sys.tables
    WHERE  schema_id = SCHEMA_ID('dbo')
    AND    name      = 'MigratedFacilitiesT'
)
BEGIN
    CREATE TABLE [dbo].[MigratedFacilitiesT] (
        -- DataSourceID from the legacy database that has been fully imported.
        [DataSourceID]   int           NOT NULL,
        -- When the import was triggered (UTC).
        [MigratedOn]     datetime2(3)  NOT NULL CONSTRAINT [DF_MigratedFacilities_MigratedOn] DEFAULT SYSUTCDATETIME(),
        -- Optional: who triggered the migration (user GUID from new system).
        [MigratedByID]   uniqueidentifier NULL,
        -- How many patient rows were imported in this run.
        [PatientsImported]  int  NOT NULL DEFAULT 0,
        -- How many follow-up rows were imported in this run.
        [FollowUpsImported] int  NOT NULL DEFAULT 0,

        CONSTRAINT [PK_MigratedFacilitiesT] PRIMARY KEY CLUSTERED ([DataSourceID] ASC)
    );

    PRINT 'Table MigratedFacilitiesT created.';
END
ELSE
    PRINT 'Table MigratedFacilitiesT already exists — skipped.';
GO
