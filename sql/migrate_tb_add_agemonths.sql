-- =============================================================================
-- migrate_tb_add_agemonths.sql
--
-- Adds the AgeMonths column to PtDetailsT (TB register) if it does not already
-- exist.  Run this if PtDetailsT was created before this column was defined in
-- create_tb_register.sql.
--
-- Safe to re-run (guarded by OBJECT_ID / COL_LENGTH check).
-- =============================================================================

USE [db_ac602a_v6nkwi3rvw];
GO

IF COL_LENGTH('PtDetailsT', 'AgeMonths') IS NULL
BEGIN
    ALTER TABLE PtDetailsT
        ADD AgeMonths INTEGER NULL;

    PRINT 'AgeMonths column added to PtDetailsT.';
END
ELSE
BEGIN
    PRINT 'AgeMonths column already exists in PtDetailsT — skipped.';
END
GO
