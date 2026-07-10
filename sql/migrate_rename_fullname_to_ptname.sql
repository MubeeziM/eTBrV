-- =============================================================================
--  migrate_rename_fullname_to_ptname.sql
--  Renames PtDetailsARTT.FullName → PtName on the live SQL Server database.
--
--  Run order:
--    1. Run THIS script.
--    2. Re-run sql/create_audit_trigger.sql  (trigger references the column
--       by name and must be recreated).
-- =============================================================================

-- Step 1: Rename the column.
EXEC sp_rename 'PtDetailsARTT.FullName', 'PtName', 'COLUMN';
GO

-- Step 2: Drop the old index (index names are not automatically updated by
--         sp_rename) and recreate it with the new column name.
IF EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE  name = 'IX_PtDetailsARTT_FullName'
    AND    object_id = OBJECT_ID('PtDetailsARTT')
)
    DROP INDEX IX_PtDetailsARTT_FullName ON PtDetailsARTT;
GO

CREATE INDEX IX_PtDetailsARTT_PtName ON PtDetailsARTT(PtName);
GO

-- After this script succeeds, re-run sql/create_audit_trigger.sql.
