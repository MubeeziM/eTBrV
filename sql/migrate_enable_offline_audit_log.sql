-- =============================================================================
--  Migration: Enable offline audit log sync from the PWA to LogT
--
--  The LogT table already exists (created by migrate_create_logt.sql).
--  This script adds nothing new to the server schema — the existing LogT
--  table is reused for offline audit entries sent by the PWA.
--
--  PURPOSE:
--    When the PWA is used offline it writes every patient data change and
--    Excel export to a local AuditLogT table (SQLite / IndexedDB).
--    On the next successful sync the PWA POSTs those rows to:
--
--        POST /api/audit-logs
--
--    The AuditLogsController inserts each row into LogT with:
--        • LoggedOn     = the device timestamp of the action
--        • Notes        = "[PWA-OFFLINE] <ACTION>: <description> (by <user>)"
--        • UserTID      = JWT sub claim (server-verified, cannot be spoofed)
--        • PtDetailsTID = patient GUID if applicable
--
--  HOW TO SEARCH FOR OFFLINE ENTRIES:
--
--    -- All offline audit entries (any action):
--    SELECT * FROM LogT WHERE Notes LIKE '[PWA-OFFLINE]%' ORDER BY LoggedOn DESC;
--
--    -- Offline Excel exports only:
--    SELECT * FROM LogT WHERE Notes LIKE '[PWA-OFFLINE] EXPORT%' ORDER BY LoggedOn DESC;
--
--    -- All activity for a specific patient:
--    SELECT * FROM LogT WHERE PtDetailsTID = '<guid>' ORDER BY LoggedOn DESC;
--
--    -- All activity by a specific user:
--    SELECT u.UserName, l.*
--    FROM   LogT l
--    JOIN   UsersT u ON u.UserTID = l.UserTID
--    WHERE  l.UserTID = '<user-guid>'
--    ORDER  BY l.LoggedOn DESC;
--
--  REQUIRED STEPS:
--    1. Verify that migrate_create_logt.sql has already been run.
--    2. Deploy the updated PatientSyncApi (includes AuditLogsController.cs).
--    3. Deploy the updated PWA (includes AuditLogT schema + insertAuditLog).
--    No schema changes are needed — this is documentation only.
-- =============================================================================

-- ── Verify LogT exists ────────────────────────────────────────────────────
IF OBJECT_ID('dbo.LogT', 'U') IS NULL
BEGIN
    RAISERROR(
        'LogT does not exist. Run migrate_create_logt.sql first, then re-run this script.',
        16, 1
    );
    RETURN;
END

-- ── Verify the AuditLogsController endpoint is registered ─────────────────
-- (Informational check only — cannot verify from SQL)
PRINT 'LogT exists and is ready to receive offline audit log entries from the PWA.';
PRINT 'Ensure PatientSyncApi has been deployed with AuditLogsController.cs included.';
PRINT '';
PRINT 'Offline audit entries will appear in LogT with Notes starting with [PWA-OFFLINE].';
GO
