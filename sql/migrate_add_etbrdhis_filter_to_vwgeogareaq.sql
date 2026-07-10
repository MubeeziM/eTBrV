-- =============================================================================
--  Migration: Filter vwGeogAreaQ to HIV-care facilities only (eTBrDHIS = 1)
--
--  Background:
--    Not all facilities in HealthFacilityT are involved in HIV care.
--    The eTBrDHIS flag (INTEGER, 0/1) marks those that are.
--    Only facilities with eTBrDHIS = 1 should appear in the geo-tree,
--    during data entry, or as selectable report organisation units.
--
--  Run in SSMS AFTER migrate_add_subrecid_locationid_to_hfacility.sql.
--  Safe to re-run — the view is dropped and recreated unconditionally.
-- =============================================================================

USE [db_ac602a_v6nkwi3rvw];
GO

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
      AND  COALESCE(s.State, '') NOT LIKE '%Training%'
      AND  hf.eTBrDHIS = 1;
GO

PRINT 'vwGeogAreaQ recreated — restricted to eTBrDHIS = 1 facilities.';
GO

-- Verification — confirm only HIV-care facilities are returned
SELECT COUNT(*) AS FacilityCount FROM vwGeogAreaQ;
GO

PRINT 'Migration complete.';
GO
