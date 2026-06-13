-- =============================================================================
--  Migration: Drop geographic FK constraints on PtDetailsT and make
--             DataSourceID / CountyID nullable
--
--  Root cause: PtDetailsT was created with FK constraints referencing
--  DataSourceT, CountyT, and HealthFacilityT. Those tables start at ID=1
--  (no row 0). Users without a facility assignment get DataSourceID=0 from
--  the JWT claim, causing SQL error 547 on every sync.
--
--  Fix: drop the FK constraints so arbitrary IDs (or NULL) are accepted,
--  and make DataSourceID / CountyID nullable so the API can store NULL
--  for users not yet linked to a facility.
--
--  Run once in SSMS. Safe to re-run — every step is guarded.
-- =============================================================================

USE [db_ac602a_v6nkwi3rvw];
GO

-- 1. Drop FK to DataSourceT
IF EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = 'FK_PtDetailsT_DS'
      AND parent_object_id = OBJECT_ID('PtDetailsT')
)
    ALTER TABLE PtDetailsT DROP CONSTRAINT FK_PtDetailsT_DS;

-- 2. Drop FK to CountyT
IF EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = 'FK_PtDetailsT_County'
      AND parent_object_id = OBJECT_ID('PtDetailsT')
)
    ALTER TABLE PtDetailsT DROP CONSTRAINT FK_PtDetailsT_County;

-- 3. Drop FK to HealthFacilityT (NearestHFID column)
IF EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = 'FK_PtDetailsT_HF'
      AND parent_object_id = OBJECT_ID('PtDetailsT')
)
    ALTER TABLE PtDetailsT DROP CONSTRAINT FK_PtDetailsT_HF;

-- 4. Make DataSourceID nullable (NULL = user has no facility assigned)
IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('PtDetailsT')
      AND name      = 'DataSourceID'
      AND is_nullable = 0
)
BEGIN
    -- Remove DEFAULT constraint first (required before altering column)
    DECLARE @dfDS NVARCHAR(200) = (
        SELECT dc.name FROM sys.default_constraints dc
        JOIN sys.columns c ON c.default_object_id = dc.object_id
        WHERE c.object_id = OBJECT_ID('PtDetailsT') AND c.name = 'DataSourceID'
    );
    IF @dfDS IS NOT NULL
        EXEC('ALTER TABLE PtDetailsT DROP CONSTRAINT ' + @dfDS);

    ALTER TABLE PtDetailsT ALTER COLUMN DataSourceID INTEGER NULL;
    PRINT 'DataSourceID made nullable.';
END

-- 5. Make CountyID nullable
IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('PtDetailsT')
      AND name      = 'CountyID'
      AND is_nullable = 0
)
BEGIN
    DECLARE @dfCo NVARCHAR(200) = (
        SELECT dc.name FROM sys.default_constraints dc
        JOIN sys.columns c ON c.default_object_id = dc.object_id
        WHERE c.object_id = OBJECT_ID('PtDetailsT') AND c.name = 'CountyID'
    );
    IF @dfCo IS NOT NULL
        EXEC('ALTER TABLE PtDetailsT DROP CONSTRAINT ' + @dfCo);

    ALTER TABLE PtDetailsT ALTER COLUMN CountyID INTEGER NULL;
    PRINT 'CountyID made nullable.';
END

GO
PRINT 'Migration complete.';
GO

