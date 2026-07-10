-- =============================================================================
--  Migration: Add Deleted column to patient tables for soft-delete support
--
--  Run in SSMS.  Safe to re-run — each step is guarded by an existence check.
--
--  Soft-delete rules:
--    Deleted = 0  →  active record (default)
--    Deleted = 1  →  soft-deleted; hidden in UI, excluded from reports
--
--  Records are never hard-deleted.  Deletion sets Deleted = 1 and
--  HasChanged = 1 so the change propagates on the next PWA sync.
--  Authorised users can undelete a record by setting Deleted = 0.
-- =============================================================================

USE [db_ac602a_v6nkwi3rvw];
GO

-- PtDetailsARTT — main patient record
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE  object_id = OBJECT_ID('PtDetailsARTT') AND name = 'Deleted'
)
BEGIN
    ALTER TABLE PtDetailsARTT
        ADD Deleted BIT NOT NULL CONSTRAINT DF_PtDetailsARTT_Deleted DEFAULT 0;
    PRINT 'Added PtDetailsARTT.Deleted';
END
ELSE
    PRINT 'PtDetailsARTT.Deleted already exists — skipping.';
GO

-- PtFollowUpARTT — follow-up visit records
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE  object_id = OBJECT_ID('PtFollowUpARTT') AND name = 'Deleted'
)
BEGIN
    ALTER TABLE PtFollowUpARTT
        ADD Deleted BIT NOT NULL CONSTRAINT DF_PtFollowUpARTT_Deleted DEFAULT 0;
    PRINT 'Added PtFollowUpARTT.Deleted';
END
ELSE
    PRINT 'PtFollowUpARTT.Deleted already exists — skipping.';
GO

-- Create index for efficient filtering of non-deleted records
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE  object_id = OBJECT_ID('PtDetailsARTT') AND name = 'IX_PtDetailsARTT_Deleted'
)
BEGIN
    CREATE INDEX IX_PtDetailsARTT_Deleted ON PtDetailsARTT(Deleted);
    PRINT 'Created index IX_PtDetailsARTT_Deleted';
END
GO

PRINT 'Soft-delete columns added successfully.';
GO
