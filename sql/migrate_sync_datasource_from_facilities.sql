-- =============================================================================
-- migrate_sync_datasource_from_facilities.sql
--
-- Populates DataSourceT with one row per HealthFacilityT entry.
-- DataSourceT.DataSourceID must equal HealthFacilityT.HealthFacilityID for the
-- server-side MERGE to satisfy the FK_TBPtDetailsT_DS (and FK_PtDetailsARTT_DS)
-- foreign key constraints.
--
-- Safe to re-run — inserts only rows that do not already exist.
-- =============================================================================

USE [db_ac602a_v6nkwi3rvw];
GO

INSERT INTO DataSourceT (DataSourceID, DataSource, HealthFacilityID)
SELECT
    h.HealthFacilityID,
    h.HealthFacility,
    h.HealthFacilityID
FROM HealthFacilityT h
WHERE h.HealthFacilityID > 0
  AND NOT EXISTS (
      SELECT 1 FROM DataSourceT d WHERE d.DataSourceID = h.HealthFacilityID
  );

PRINT CAST(@@ROWCOUNT AS VARCHAR) + ' row(s) inserted into DataSourceT.';
GO
