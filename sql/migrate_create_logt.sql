-- =============================================================================
--  Migration: Create LogT audit table + audit triggers on PtDetailsARTT
--
--  Run this ONCE against the production/staging database before deploying
--  the updated API (which uses AuditService to write to LogT).
--
--  Safe to re-run: each block is guarded by an existence check or uses
--  CREATE OR ALTER.
-- =============================================================================

-- ── 1. Create LogT if it does not already exist ───────────────────────────
IF OBJECT_ID('dbo.LogT', 'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[LogT] (
        LogID        BIGINT          NOT NULL IDENTITY(1,1),
        CONSTRAINT [LogT$PrimaryKey] PRIMARY KEY CLUSTERED ([LogID] DESC),
        LoggedOn     DATETIME2(3)    NOT NULL CONSTRAINT DF_LogT_LoggedOn DEFAULT GETDATE(),
        PtDetailsTID NVARCHAR(36)    NULL,
        Notes        NVARCHAR(4000)  NOT NULL DEFAULT '',
        UserTID      NVARCHAR(36)    NULL
    );

    -- Index to look up audit history for a specific patient quickly
    CREATE INDEX IX_LogT_PtDetailsTID ON dbo.LogT (PtDetailsTID)
        WHERE PtDetailsTID IS NOT NULL;

    -- Index to look up all actions by a specific user quickly
    CREATE INDEX IX_LogT_UserTID       ON dbo.LogT (UserTID)
        WHERE UserTID IS NOT NULL;

    -- Index to support time-range queries on the audit log
    CREATE INDEX IX_LogT_LoggedOn      ON dbo.LogT (LoggedOn DESC);

    PRINT 'LogT created.';
END
ELSE
    PRINT 'LogT already exists — skipped.';
GO

-- ── 2. INSERT + UPDATE trigger ────────────────────────────────────────────
-- (Taken verbatim from create_audit_trigger.sql)

CREATE OR ALTER TRIGGER [dbo].[trg_PtDetailsARTT_Audit]
ON  [dbo].[PtDetailsARTT]
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;

    IF NOT EXISTS (SELECT 1 FROM INSERTED) RETURN;

    -- INSERT branch: new patient records
    INSERT INTO [dbo].[LogT] (PtDetailsTID, Notes, UserTID)
    SELECT
        CAST(i.PtDetailsTID AS nvarchar(36)),
        N'[DB] New patient record created. ART No: ' + ISNULL(NULLIF(LTRIM(RTRIM(i.ARTNo)), ''), 'N/A'),
        CAST(i.EnteredByID AS nvarchar(36))
    FROM INSERTED i
    WHERE NOT EXISTS (
        SELECT 1 FROM DELETED d WHERE d.PtDetailsTID = i.PtDetailsTID
    );

    -- UPDATE branch: only when meaningful clinical data actually changed
    INSERT INTO [dbo].[LogT] (PtDetailsTID, Notes, UserTID)
    SELECT
        CAST(i.PtDetailsTID AS nvarchar(36)),

        N'[DB] Patient updated. ART No: ' + ISNULL(NULLIF(LTRIM(RTRIM(i.ARTNo)), ''), 'N/A')

        + CASE
            WHEN ISNULL(d.Deleted, 0) = 0 AND ISNULL(i.Deleted, 0) = 1 THEN N' | Record SOFT-DELETED'
            WHEN ISNULL(d.Deleted, 0) = 1 AND ISNULL(i.Deleted, 0) = 0 THEN N' | Record RESTORED'
            ELSE N''
          END
        + CASE
            WHEN ISNULL(i.PtName, '') <> ISNULL(d.PtName, '')
            THEN N' | Name: "' + ISNULL(d.PtName, '') + N'" → "' + ISNULL(i.PtName, '') + N'"'
            ELSE N''
          END
        + CASE
            WHEN ISNULL(CAST(i.Age AS nvarchar(10)), '') <> ISNULL(CAST(d.Age AS nvarchar(10)), '')
            THEN N' | Age: ' + ISNULL(CAST(d.Age AS nvarchar(10)), '?')
                 + N' → ' + ISNULL(CAST(i.Age AS nvarchar(10)), '?')
            ELSE N''
          END
        + CASE
            WHEN ISNULL(LTRIM(RTRIM(i.ARTNo)), '') <> ISNULL(LTRIM(RTRIM(d.ARTNo)), '')
            THEN N' | ART No changed'
            ELSE N''
          END
        + CASE
            WHEN ISNULL(CAST(i.ARTStartDate AS nvarchar(30)), '')
              <> ISNULL(CAST(d.ARTStartDate AS nvarchar(30)), '')
            THEN N' | ART Start Date changed'
            ELSE N''
          END
        + CASE
            WHEN ISNULL(i.NearestHFID, 0) <> ISNULL(d.NearestHFID, 0)
            THEN N' | Facility changed (HF ' + CAST(ISNULL(d.NearestHFID, 0) AS nvarchar(10))
                 + N' → ' + CAST(ISNULL(i.NearestHFID, 0) AS nvarchar(10)) + N')'
            ELSE N''
          END
        + CASE
            WHEN ISNULL(i.WHOStageID, 0) <> ISNULL(d.WHOStageID, 0)
            THEN N' | WHO Stage: ' + CAST(ISNULL(d.WHOStageID, 0) AS nvarchar(5))
                 + N' → ' + CAST(ISNULL(i.WHOStageID, 0) AS nvarchar(5))
            ELSE N''
          END
        + CASE
            WHEN ISNULL(i.TBStatusID, 0) <> ISNULL(d.TBStatusID, 0)
            THEN N' | TB Status: ' + CAST(ISNULL(d.TBStatusID, 0) AS nvarchar(5))
                 + N' → ' + CAST(ISNULL(i.TBStatusID, 0) AS nvarchar(5))
            ELSE N''
          END,

        CAST(i.EnteredByID AS nvarchar(36))

    FROM INSERTED i
    INNER JOIN DELETED d ON i.PtDetailsTID = d.PtDetailsTID
    WHERE
           ISNULL(i.Deleted, 0)                            <> ISNULL(d.Deleted, 0)
        OR ISNULL(i.PtName, '')                          <> ISNULL(d.PtName, '')
        OR ISNULL(i.Age, -1)                               <> ISNULL(d.Age, -1)
        OR ISNULL(LTRIM(RTRIM(i.ARTNo)), '')               <> ISNULL(LTRIM(RTRIM(d.ARTNo)), '')
        OR ISNULL(CAST(i.ARTStartDate AS nvarchar(30)), '') <> ISNULL(CAST(d.ARTStartDate AS nvarchar(30)), '')
        OR ISNULL(i.NearestHFID, 0)                        <> ISNULL(d.NearestHFID, 0)
        OR ISNULL(i.WHOStageID, 0)                         <> ISNULL(d.WHOStageID, 0)
        OR ISNULL(i.TBStatusID, 0)                         <> ISNULL(d.TBStatusID, 0);

END;
GO

-- ── 3. Hard-delete safety-net trigger ────────────────────────────────────

CREATE OR ALTER TRIGGER [dbo].[trg_PtDetailsARTT_Delete_Audit]
ON  [dbo].[PtDetailsARTT]
AFTER DELETE
AS
BEGIN
    SET NOCOUNT ON;

    IF NOT EXISTS (SELECT 1 FROM DELETED) RETURN;

    INSERT INTO [dbo].[LogT] (PtDetailsTID, Notes, UserTID)
    SELECT
        CAST(d.PtDetailsTID AS nvarchar(36)),
        N'[DB] Patient record HARD-DELETED. ART No: ' + ISNULL(NULLIF(LTRIM(RTRIM(d.ARTNo)), ''), 'N/A')
        + N' | Deleted by DB user: ' + SYSTEM_USER,
        CAST(d.EnteredByID AS nvarchar(36))
    FROM DELETED d;

END;
GO

PRINT 'Audit triggers created/updated on PtDetailsARTT.';
GO
