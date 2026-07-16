-- =============================================================================
-- migrate_add_avatar_to_usert.sql
--
-- Adds the AvatarBase64 column to UserT so users can upload a profile picture.
-- The column stores the full data URI (e.g. "data:image/jpeg;base64,...").
-- The API enforces a 200 KB decoded-size limit before writing.
--
-- Safe to run multiple times (idempotent — skips if column already exists).
-- =============================================================================

IF NOT EXISTS (
    SELECT 1
    FROM   sys.columns
    WHERE  object_id = OBJECT_ID('dbo.UserT')
      AND  name      = 'AvatarBase64'
)
BEGIN
    ALTER TABLE dbo.UserT
        ADD AvatarBase64 NVARCHAR(MAX) NULL;

    PRINT 'Column AvatarBase64 added to UserT.';
END
ELSE
BEGIN
    PRINT 'Column AvatarBase64 already exists in UserT — skipped.';
END
GO
