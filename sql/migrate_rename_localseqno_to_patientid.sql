-- =============================================================================
--  Migration: Rename LocalSeqNo → PatientID in PtDetailsARTT
--
--  Run once in SSMS. sp_rename is safe to re-run if guarded — the IF block
--  checks the current column name before renaming.
-- =============================================================================

USE [db_ac602a_v6nkwi3rvw];
GO

IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('PtDetailsARTT')
      AND name      = 'LocalSeqNo'
)
BEGIN
    EXEC sp_rename 'PtDetailsARTT.LocalSeqNo', 'PatientID', 'COLUMN';
    PRINT 'Column renamed: LocalSeqNo → PatientID';
END
ELSE
    PRINT 'Column LocalSeqNo not found — already renamed or never existed.';
GO
