-- =============================================================================
--  Migration: Drop HealthFacility FK constraint on PresumptiveCaseT
--
--  Root cause: PresumptiveCaseT.FK_PresumptiveCaseT_HF enforces that
--  NearestHFID must exist in HealthFacilityT.  During legacy data migration
--  the NearestHFID values from the old system do not match the HealthFacilityID
--  values in the new database, causing SQL error 547 on every MERGE INSERT.
--
--  The FK to DataSourceT and CountyT were already dropped by
--  migrate_drop_presumptivecase_fk_constraints.sql.  This script completes
--  the cleanup for the remaining HealthFacility FK so legacy migration and
--  delta sync can proceed without referential-integrity violations on HF IDs.
--
--  Run once in SSMS against db_ac602a_v6nkwi3rvw. Safe to re-run.
-- =============================================================================

USE [db_ac602a_v6nkwi3rvw];
GO

IF EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = 'FK_PresumptiveCaseT_HF'
      AND parent_object_id = OBJECT_ID('PresumptiveCaseT')
)
BEGIN
    ALTER TABLE PresumptiveCaseT DROP CONSTRAINT FK_PresumptiveCaseT_HF;
    PRINT 'FK_PresumptiveCaseT_HF dropped.';
END
ELSE
    PRINT 'FK_PresumptiveCaseT_HF not found — already dropped or never existed.';
GO
