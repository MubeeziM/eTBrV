-- =============================================================================
-- migrate_add_last_seen_at.sql
--
-- Adds LastSeenAt to UserT so the API can track which users are currently
-- active (used by GET /api/auth/sessions and POST /api/auth/heartbeat).
--
-- Run ONCE in SSMS against the production database.
-- Safe to run multiple times — checks for column existence first.
-- =============================================================================

USE [db_ac602a_v6nkwi3rvw];
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('UserT') AND name = 'LastSeenAt'
)
BEGIN
    ALTER TABLE UserT ADD LastSeenAt DATETIME NULL;
    PRINT 'LastSeenAt column added to UserT.';
END
ELSE
BEGIN
    PRINT 'LastSeenAt already exists — skipping.';
END
GO
