-- =============================================================================
--  Migration: Create StateT table and vwGeogAreaQ view on SQL Server
--
--  Run in SSMS AFTER migrate_rename_hfacility_columns.sql has been applied.
--  Safe to re-run — each object is created only if it does not already exist.
-- =============================================================================

USE [db_ac602a_v6nkwi3rvw];
GO

-- 1. StateT — geographic state / zone / region lookup
IF OBJECT_ID('StateT', 'U') IS NULL
BEGIN
    CREATE TABLE StateT (
        StateID  INTEGER NOT NULL CONSTRAINT PK_StateT PRIMARY KEY,
        State    VARCHAR(60) NOT NULL
    );
    PRINT 'Created StateT';

    INSERT INTO StateT VALUES (0, 'Not configured');
    PRINT 'Seeded StateT';
END
ELSE
    PRINT 'StateT already exists — skipping.';
GO

-- 2. Ensure HealthFacilityT.StateID exists (should already exist from prior migration)
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

-- 3. vwGeogAreaQ — flat view consumed by the PWA geo-tree endpoint
IF OBJECT_ID('vwGeogAreaQ', 'V') IS NOT NULL
BEGIN
    DROP VIEW vwGeogAreaQ;
    PRINT 'Dropped existing vwGeogAreaQ';
END
GO

CREATE VIEW vwGeogAreaQ AS
    SELECT hf.HealthFacilityID,
           hf.HealthFacility,
           hf.CountyID,
           COALESCE(c.County,  '') AS County,
           hf.StateID,
           COALESCE(s.State,   '') AS State
    FROM   HealthFacilityT hf
    LEFT JOIN CountyT c ON hf.CountyID = c.CountyID
    LEFT JOIN StateT  s ON hf.StateID  = s.StateID
    WHERE  hf.HealthFacilityID NOT IN (0, 15, 17, 435)
      AND  COALESCE(s.State, '') NOT LIKE '%Training%';
GO

PRINT 'Created vwGeogAreaQ';
GO

-- Verification — shows a sample from the view (expect at least the 0-row)
SELECT TOP 10
    HealthFacilityID, HealthFacility, CountyID, County, StateID, State
FROM vwGeogAreaQ
ORDER BY State, County, HealthFacility;
GO

PRINT 'Migration complete.';
GO
