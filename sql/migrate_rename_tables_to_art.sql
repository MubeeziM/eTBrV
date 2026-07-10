-- ============================================================
--  Migration: Rename ART tables to include ART suffix
--  PtDetailsT   → PtDetailsARTT
--  PtFollowUpT  → PtFollowUpARTT
--  RegimenT     → RegimenARTT
--
--  Run this script ONCE against the live SQL Server database.
--  sp_rename preserves all data, indexes, and FK constraints
--  (constraint names are kept as-is; rename them separately if
--   cleanliness is required).
--  After running this script, deploy the updated application
--  code (API + PWA) that references the new table names.
-- ============================================================

USE [db_ac602a_v6nkwi3rvw];
GO

-- ── Sanity check: abort if tables are already renamed ────────────────────

IF OBJECT_ID('PtDetailsARTT',  'U') IS NOT NULL
   AND OBJECT_ID('PtFollowUpARTT', 'U') IS NOT NULL
   AND OBJECT_ID('RegimenARTT',    'U') IS NOT NULL
BEGIN
    PRINT 'Tables already renamed — nothing to do.';
    RETURN;
END

-- ── Rename RegimenT → RegimenARTT ────────────────────────────────────────
IF OBJECT_ID('RegimenT', 'U') IS NOT NULL
BEGIN
    EXEC sp_rename 'RegimenT', 'RegimenARTT';
    PRINT 'Renamed: RegimenT → RegimenARTT';
END
ELSE
    PRINT 'WARNING: RegimenT not found — skipping.';

-- ── Rename PtDetailsT → PtDetailsARTT ───────────────────────────────────
IF OBJECT_ID('PtDetailsT', 'U') IS NOT NULL
BEGIN
    EXEC sp_rename 'PtDetailsT', 'PtDetailsARTT';
    PRINT 'Renamed: PtDetailsT → PtDetailsARTT';
END
ELSE
    PRINT 'WARNING: PtDetailsT not found — skipping.';

-- ── Rename PtFollowUpT → PtFollowUpARTT ─────────────────────────────────
IF OBJECT_ID('PtFollowUpT', 'U') IS NOT NULL
BEGIN
    EXEC sp_rename 'PtFollowUpT', 'PtFollowUpARTT';
    PRINT 'Renamed: PtFollowUpT → PtFollowUpARTT';
END
ELSE
    PRINT 'WARNING: PtFollowUpT not found — skipping.';

-- ── Re-apply audit triggers on PtDetailsARTT ────────────────────────────
-- The trigger definitions reference the old table name; drop them and
-- re-run create_audit_trigger.sql (which has been updated to use
-- PtDetailsARTT) after running this migration.

IF OBJECT_ID('trg_PtDetailsT_Audit',        'TR') IS NOT NULL
    DROP TRIGGER [dbo].[trg_PtDetailsT_Audit];
IF OBJECT_ID('trg_PtDetailsT_Delete_Audit', 'TR') IS NOT NULL
    DROP TRIGGER [dbo].[trg_PtDetailsT_Delete_Audit];

PRINT 'Old audit triggers dropped — re-run create_audit_trigger.sql to recreate them on PtDetailsARTT.';
PRINT '';
PRINT 'Migration complete.';
GO
