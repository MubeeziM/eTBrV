-- =============================================================================
--  Audit trigger on PtDetailsARTT → LogT
--  Purpose : Safety-net that captures data changes which bypass the API
--            (e.g. direct DBA edits, bulk imports, emergency fixes).
--            Normal sync operations are logged by AuditService in the API.
--
--  Design decisions
--  ──────────────────────────────────────────────────────────────────────────
--  • Combined INSERT + UPDATE trigger — one object, fewer maintenance points.
--  • UPDATE branch only fires when one or more *meaningful clinical fields*
--    actually changed value.  HasChanged, LastModOn, and other housekeeping
--    columns are intentionally excluded to avoid a LogT row for every sync
--    that touches nothing substantive.
--  • Notes are prefixed with [DB] to distinguish trigger-generated entries
--    from API-generated ones written by AuditService.
--  • UserTID is taken from EnteredByID (the original creator GUID stored in the
--    row) because SQL Server triggers run under the service account and cannot
--    see the end-user's session. The API-level AuditService has the full user
--    context for all writes that go through the API.
--  • The trigger is set-based (handles multi-row batches from bulk sync).
--  • SET NOCOUNT ON prevents the trigger from sending extra row-count messages
--    that could interfere with the calling transaction.
-- =============================================================================

CREATE OR ALTER TRIGGER [dbo].[trg_PtDetailsARTT_Audit]
ON  [dbo].[PtDetailsARTT]
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;

    IF NOT EXISTS (SELECT 1 FROM INSERTED) RETURN;

    -- ── INSERT branch: new patient records ───────────────────────────────────
    -- Fires when the MERGE's WHEN NOT MATCHED branch runs (first-time sync of
    -- a patient, or a direct INSERT by a DBA/import script).
    INSERT INTO [dbo].[LogT] (PtDetailsTID, Notes, UserTID)
    SELECT
        CAST(i.PtDetailsTID AS nvarchar(36)),
        N'[DB] New patient record created. ART No: ' + ISNULL(NULLIF(LTRIM(RTRIM(i.ARTNo)), ''), 'N/A'),
        CAST(i.EnteredByID AS nvarchar(36))
    FROM INSERTED i
    WHERE NOT EXISTS (
        SELECT 1 FROM DELETED d WHERE d.PtDetailsTID = i.PtDetailsTID
    );

    -- ── UPDATE branch: only when meaningful clinical data actually changed ───
    -- Compares the 8 most auditable fields.  If none of them changed (routine
    -- sync stamping LastModOn / HasChanged), no row is written to LogT.
    INSERT INTO [dbo].[LogT] (PtDetailsTID, Notes, UserTID)
    SELECT
        CAST(i.PtDetailsTID AS nvarchar(36)),

        -- Build a readable change summary using CASE expressions.
        N'[DB] Patient updated. ART No: ' + ISNULL(NULLIF(LTRIM(RTRIM(i.ARTNo)), ''), 'N/A')

        -- Soft-delete / restore  ──────────────────────────────────────────────
        + CASE
            WHEN ISNULL(d.Deleted, 0) = 0 AND ISNULL(i.Deleted, 0) = 1 THEN N' | Record SOFT-DELETED'
            WHEN ISNULL(d.Deleted, 0) = 1 AND ISNULL(i.Deleted, 0) = 0 THEN N' | Record RESTORED'
            ELSE N''
          END

        -- Name change ─────────────────────────────────────────────────────────
        + CASE
            WHEN ISNULL(i.PtName, '') <> ISNULL(d.PtName, '')
            THEN N' | Name: "' + ISNULL(d.PtName, '') + N'" → "' + ISNULL(i.PtName, '') + N'"'
            ELSE N''
          END

        -- Age change ──────────────────────────────────────────────────────────
        + CASE
            WHEN ISNULL(CAST(i.Age AS nvarchar(10)), '') <> ISNULL(CAST(d.Age AS nvarchar(10)), '')
            THEN N' | Age: ' + ISNULL(CAST(d.Age AS nvarchar(10)), '?')
                 + N' → ' + ISNULL(CAST(i.Age AS nvarchar(10)), '?')
            ELSE N''
          END

        -- ART number change ───────────────────────────────────────────────────
        + CASE
            WHEN ISNULL(LTRIM(RTRIM(i.ARTNo)), '') <> ISNULL(LTRIM(RTRIM(d.ARTNo)), '')
            THEN N' | ART No changed'
            ELSE N''
          END

        -- ART start date change ───────────────────────────────────────────────
        + CASE
            WHEN ISNULL(CAST(i.ARTStartDate AS nvarchar(30)), '')
              <> ISNULL(CAST(d.ARTStartDate AS nvarchar(30)), '')
            THEN N' | ART Start Date changed'
            ELSE N''
          END

        -- Facility (NearestHFID) change ───────────────────────────────────────
        + CASE
            WHEN ISNULL(i.NearestHFID, 0) <> ISNULL(d.NearestHFID, 0)
            THEN N' | Facility changed (HF ' + CAST(ISNULL(d.NearestHFID, 0) AS nvarchar(10))
                 + N' → ' + CAST(ISNULL(i.NearestHFID, 0) AS nvarchar(10)) + N')'
            ELSE N''
          END

        -- WHO clinical stage change ───────────────────────────────────────────
        + CASE
            WHEN ISNULL(i.WHOStageID, 0) <> ISNULL(d.WHOStageID, 0)
            THEN N' | WHO Stage: ' + CAST(ISNULL(d.WHOStageID, 0) AS nvarchar(5))
                 + N' → ' + CAST(ISNULL(i.WHOStageID, 0) AS nvarchar(5))
            ELSE N''
          END

        -- TB status change ────────────────────────────────────────────────────
        + CASE
            WHEN ISNULL(i.TBStatusID, 0) <> ISNULL(d.TBStatusID, 0)
            THEN N' | TB Status: ' + CAST(ISNULL(d.TBStatusID, 0) AS nvarchar(5))
                 + N' → ' + CAST(ISNULL(i.TBStatusID, 0) AS nvarchar(5))
            ELSE N''
          END,

        -- UserTID: best available identifier is the original creator's GUID.
        -- The actual editor is captured by AuditService for API-mediated writes.
        CAST(i.EnteredByID AS nvarchar(36))

    FROM INSERTED i
    INNER JOIN DELETED d ON i.PtDetailsTID = d.PtDetailsTID
    WHERE
        -- Only write a row when at least one meaningful field actually changed.
           ISNULL(i.Deleted, 0)                          <> ISNULL(d.Deleted, 0)
        OR ISNULL(i.PtName, '')                        <> ISNULL(d.PtName, '')
        OR ISNULL(i.Age, -1)                             <> ISNULL(d.Age, -1)
        OR ISNULL(LTRIM(RTRIM(i.ARTNo)), '')             <> ISNULL(LTRIM(RTRIM(d.ARTNo)), '')
        OR ISNULL(CAST(i.ARTStartDate AS nvarchar(30)), '') <> ISNULL(CAST(d.ARTStartDate AS nvarchar(30)), '')
        OR ISNULL(i.NearestHFID, 0)                      <> ISNULL(d.NearestHFID, 0)
        OR ISNULL(i.WHOStageID, 0)                       <> ISNULL(d.WHOStageID, 0)
        OR ISNULL(i.TBStatusID, 0)                       <> ISNULL(d.TBStatusID, 0);

END;
GO

-- =============================================================================
--  Hard-delete safety net on PtDetailsARTT
--  Captures rows that are physically removed (rare — normal flow uses Deleted=1).
--  Useful if a DBA or import script ever runs DELETE directly.
-- =============================================================================

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
