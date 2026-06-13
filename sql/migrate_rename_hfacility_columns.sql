-- =============================================================================
--  Migration: Rename HFacilityID/HFacility → HealthFacilityID/HealthFacility
--
--  Applies to: HealthFacilityT (PK + name column)
--              DataSourceT     (FK column that references HealthFacilityT)
--
--  Run once in SSMS on the live database.
--  Safe to re-run — each block checks whether the old column name still exists
--  before attempting the rename.
--
--  NOTE: SQL Server automatically updates foreign-key constraint metadata after
--  sp_rename, but any stored procedures, views, or functions that reference the
--  old column names by name must be recompiled / recreated separately.
--  vwGeogAreaQ uses SELECT dbo.HealthFacilityT.* so it resolves column names
--  dynamically — no action required for that view.
-- =============================================================================

USE [db_ac602a_v6nkwi3rvw];
GO

-- 1. HealthFacilityT.HFacilityID → HealthFacilityID
IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE  object_id = OBJECT_ID('HealthFacilityT') AND name = 'HFacilityID'
)
BEGIN
    EXEC sp_rename 'HealthFacilityT.HFacilityID', 'HealthFacilityID', 'COLUMN';
    PRINT 'Renamed HealthFacilityT.HFacilityID → HealthFacilityID';
END
ELSE
    PRINT 'HealthFacilityT.HFacilityID not found — already renamed or never existed.';
GO

-- 2. HealthFacilityT.HFacility → HealthFacility
IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE  object_id = OBJECT_ID('HealthFacilityT') AND name = 'HFacility'
)
BEGIN
    EXEC sp_rename 'HealthFacilityT.HFacility', 'HealthFacility', 'COLUMN';
    PRINT 'Renamed HealthFacilityT.HFacility → HealthFacility';
END
ELSE
    PRINT 'HealthFacilityT.HFacility not found — already renamed or never existed.';
GO

-- 3. DataSourceT.HFacilityID → HealthFacilityID
IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE  object_id = OBJECT_ID('DataSourceT') AND name = 'HFacilityID'
)
BEGIN
    EXEC sp_rename 'DataSourceT.HFacilityID', 'HealthFacilityID', 'COLUMN';
    PRINT 'Renamed DataSourceT.HFacilityID → HealthFacilityID';
END
ELSE
    PRINT 'DataSourceT.HFacilityID not found — already renamed or never existed.';
GO

-- 4. Add StateID to HealthFacilityT if not yet present
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE  object_id = OBJECT_ID('HealthFacilityT') AND name = 'StateID'
)
BEGIN
    ALTER TABLE HealthFacilityT
        ADD StateID INTEGER NOT NULL CONSTRAINT DF_HealthFacilityT_StateID DEFAULT 0;
    PRINT 'Added HealthFacilityT.StateID';
END
ELSE
    PRINT 'HealthFacilityT.StateID already exists — skipping.';
GO

PRINT 'Migration complete.';
GO
