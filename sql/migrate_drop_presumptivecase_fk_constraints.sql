-- =============================================================================
--  Migration: Drop geographic FK constraints on PresumptiveCaseT
--
--  Root cause: PresumptiveCaseT was created with FK constraints referencing
--  DataSourceT, CountyT, and HealthFacilityT. Those tables start at ID=1
--  (no row 0). National/super users get DataSourceID=0 from the JWT claim
--  (facility_id=0), causing SQL error 547 on every presumptive case sync.
--  CountyID can also resolve to 0 when HealthFacilityT.CountyID is 0.
--
--  Fix: drop the FK constraints so arbitrary IDs are accepted, and make
--  DataSourceID / CountyID nullable so the API can store NULL for users
--  not linked to a specific facility.
--
--  Mirrors the fix already applied to PtDetailsARTT via
--  migrate_seed_datasource_zero.sql.
--
--  Run once in SSMS against db_ac602a_v6nkwi3rvw. Safe to re-run.
-- =============================================================================

USE [db_ac602a_v6nkwi3rvw];
GO

-- 1. Drop FK to DataSourceT
IF EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = 'FK_PresumptiveCaseT_DS'
      AND parent_object_id = OBJECT_ID('PresumptiveCaseT')
)
    ALTER TABLE PresumptiveCaseT DROP CONSTRAINT FK_PresumptiveCaseT_DS;
GO

-- 2. Drop FK to CountyT
IF EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = 'FK_PresumptiveCaseT_County'
      AND parent_object_id = OBJECT_ID('PresumptiveCaseT')
)
    ALTER TABLE PresumptiveCaseT DROP CONSTRAINT FK_PresumptiveCaseT_County;
GO

-- 3. Make DataSourceID nullable (NULL = user has no facility assigned)
IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id  = OBJECT_ID('PresumptiveCaseT')
      AND name       = 'DataSourceID'
      AND is_nullable = 0
)
BEGIN
    DECLARE @dfDS NVARCHAR(200) = (
        SELECT dc.name FROM sys.default_constraints dc
        JOIN sys.columns c ON c.default_object_id = dc.object_id
        WHERE c.object_id = OBJECT_ID('PresumptiveCaseT') AND c.name = 'DataSourceID'
    );
    IF @dfDS IS NOT NULL
        EXEC('ALTER TABLE PresumptiveCaseT DROP CONSTRAINT ' + @dfDS);

    ALTER TABLE PresumptiveCaseT ALTER COLUMN DataSourceID INTEGER NULL;
    PRINT 'PresumptiveCaseT.DataSourceID made nullable.';
END
GO

-- 4. Make CountyID nullable
IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id  = OBJECT_ID('PresumptiveCaseT')
      AND name       = 'CountyID'
      AND is_nullable = 0
)
BEGIN
    DECLARE @dfCo NVARCHAR(200) = (
        SELECT dc.name FROM sys.default_constraints dc
        JOIN sys.columns c ON c.default_object_id = dc.object_id
        WHERE c.object_id = OBJECT_ID('PresumptiveCaseT') AND c.name = 'CountyID'
    );
    IF @dfCo IS NOT NULL
        EXEC('ALTER TABLE PresumptiveCaseT DROP CONSTRAINT ' + @dfCo);

    ALTER TABLE PresumptiveCaseT ALTER COLUMN CountyID INTEGER NULL;
    PRINT 'PresumptiveCaseT.CountyID made nullable.';
END
GO

PRINT 'Migration complete: PresumptiveCaseT FK constraints dropped.';
