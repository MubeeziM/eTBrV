-- =============================================================================
--  Migration: Add SubRecID and LocationID to HealthFacilityT, update vwGeogAreaQ
--
--  Run in SSMS AFTER migrate_create_state_and_geo_view.sql has been applied.
--  Safe to re-run — each step is guarded by an existence check.
--
--  Purpose:
--    SubRecID   — identifies the NGO Sub-Recipient that supports the facility.
--                  0 = not NGO-supported.
--    LocationID — identifies the NGO's regional office / field location that
--                  covers the facility.  0 = not applicable.
--
--  These two columns are used by the geo-tree endpoint to filter facilities
--  based on which user is logged in:
--    • NGO national users  → WHERE SubRecID = @subRecID
--    • NGO state / county  → WHERE SubRecID = @subRecID AND LocationID = @locationID
-- =============================================================================

USE [db_ac602a_v6nkwi3rvw];
GO

-- 1. Add SubRecID
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE  object_id = OBJECT_ID('HealthFacilityT') AND name = 'SubRecID'
)
BEGIN
    ALTER TABLE HealthFacilityT
        ADD SubRecID INTEGER NOT NULL CONSTRAINT DF_HealthFacilityT_SubRecID DEFAULT 0;
    PRINT 'Added HealthFacilityT.SubRecID';
END
ELSE
    PRINT 'HealthFacilityT.SubRecID already exists — skipping.';
GO

-- 2. Add LocationID
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE  object_id = OBJECT_ID('HealthFacilityT') AND name = 'LocationID'
)
BEGIN
    ALTER TABLE HealthFacilityT
        ADD LocationID INTEGER NOT NULL CONSTRAINT DF_HealthFacilityT_LocationID DEFAULT 0;
    PRINT 'Added HealthFacilityT.LocationID';
END
ELSE
    PRINT 'HealthFacilityT.LocationID already exists — skipping.';
GO

-- 3. Recreate vwGeogAreaQ to expose SubRecID and LocationID
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
           COALESCE(s.State,   '') AS State,
           hf.SubRecID,
           hf.LocationID
    FROM   HealthFacilityT hf
    LEFT JOIN CountyT c ON hf.CountyID = c.CountyID
    LEFT JOIN StateT  s ON hf.StateID  = s.StateID
    WHERE  hf.HealthFacilityID NOT IN (0, 15, 17, 435)
      AND  COALESCE(s.State, '') NOT LIKE '%Training%';
GO

PRINT 'vwGeogAreaQ recreated with SubRecID and LocationID.';
GO
