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

-- PtDetailsT — main patient record
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE  object_id = OBJECT_ID('PtDetailsT') AND name = 'Deleted'
)
BEGIN
    ALTER TABLE PtDetailsT
        ADD Deleted BIT NOT NULL CONSTRAINT DF_PtDetailsT_Deleted DEFAULT 0;
    PRINT 'Added PtDetailsT.Deleted';
END
ELSE
    PRINT 'PtDetailsT.Deleted already exists — skipping.';
GO

-- PtFollowUpT — follow-up visit records
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE  object_id = OBJECT_ID('PtFollowUpT') AND name = 'Deleted'
)
BEGIN
    ALTER TABLE PtFollowUpT
        ADD Deleted BIT NOT NULL CONSTRAINT DF_PtFollowUpT_Deleted DEFAULT 0;
    PRINT 'Added PtFollowUpT.Deleted';
END
ELSE
    PRINT 'PtFollowUpT.Deleted already exists — skipping.';
GO

-- Create index for efficient filtering of non-deleted records
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE  object_id = OBJECT_ID('PtDetailsT') AND name = 'IX_PtDetailsT_Deleted'
)
BEGIN
    CREATE INDEX IX_PtDetailsT_Deleted ON PtDetailsT(Deleted);
    PRINT 'Created index IX_PtDetailsT_Deleted';
END
GO

PRINT 'Soft-delete columns added successfully.';
GO
