-- ─────────────────────────────────────────────────────────────────────────────
--  migrate_add_avatar_to_usert.sql
--  Adds AvatarBase64 column to UserT for storing user profile pictures.
--  The column is nullable VARCHAR(MAX) — stores a data-URI like:
--    data:image/jpeg;base64,/9j/4AAQ...
--  Run once per environment. Safe to skip if the column already exists.
-- ─────────────────────────────────────────────────────────────────────────────
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID(N'UserT') AND name = N'AvatarBase64'
)
BEGIN
    ALTER TABLE UserT ADD AvatarBase64 NVARCHAR(MAX) NULL;
END
