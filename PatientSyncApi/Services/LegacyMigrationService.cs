using Microsoft.Data.SqlClient;
using PatientSyncApi.Models;

namespace PatientSyncApi.Services;

/// <summary>
/// Reads patient and follow-up records from the legacy Access-sourced SQL Server
/// database (db_ac602a_etbrss) and imports them into the new database
/// (db_ac602a_v6nkwi3rvw) for a single DataSourceID (facility).
///
/// KEY DECISIONS (agreed during architecture review):
///  - Legacy PtDetailsTID values are custom strings (not GUIDs). A new
///    uniqueidentifier is assigned in the new DB; the original string is
///    preserved in the LegacyTID column so we can re-link follow-up records.
///  - Dates in the legacy DB are Access OLE Automation integers counted from
///    the Access epoch 1899-12-30. Converting: DATEADD(day, intValue, '1899-12-30').
///  - Lookup IDs (SexID, TbTypeID, RegimenID, etc.) are consistent between
///    the two databases — no remapping required.
///  - Once a DataSourceID is inserted into MigratedFacilitiesT the bridge
///    logic stops reading that facility from the legacy DB, preventing duplicates.
///  - The entire import for a facility runs inside a single transaction; if
///    anything fails the new DB is unchanged.
/// </summary>
public sealed class LegacyMigrationService
{
    private readonly string _newConnStr;
    private readonly string _legacyConnStr;
    private readonly ILogger<LegacyMigrationService> _logger;
    private readonly MigrationProgressService _progress;

    // Access OLE Automation epoch — the integer 0 in the legacy DB equals this date.
    private static readonly DateTime AccessEpoch = new DateTime(1899, 12, 30);

    public LegacyMigrationService(
        IConfiguration config,
        MigrationProgressService progress,
        ILogger<LegacyMigrationService> logger)
    {
        _newConnStr = config.GetConnectionString("DefaultConnection")
            ?? throw new InvalidOperationException("DefaultConnection is not configured.");
        _legacyConnStr = config.GetConnectionString("LegacyConnection")
            ?? throw new InvalidOperationException("LegacyConnection is not configured.");
        _progress = progress;
        _logger = logger;
    }

    // ── Public result type ────────────────────────────────────────────────────

    public sealed record MigrationResult(
        bool   Success,
        int    PatientsImported,
        int    FollowUpsImported,
        string Message);

    // ── Public entry point ────────────────────────────────────────────────────

    /// <summary>
    /// Migrates all records for <paramref name="dataSourceId"/> from the legacy
    /// database into the new database and marks the facility as migrated.
    /// Safe to call multiple times — already-migrated facilities are rejected.
    /// </summary>
    public async Task<MigrationResult> MigrateFacilityAsync(
        int    dataSourceId,
        Guid   triggeredByUserId,
        CancellationToken ct = default)
    {
        // ── Guard: already migrated? ──────────────────────────────────────
        if (await IsFacilityAlreadyMigratedAsync(dataSourceId, ct))
        {
            return new MigrationResult(false, 0, 0,
                $"DataSourceID {dataSourceId} has already been migrated.");
        }

        // ── Count total so the progress bar has a denominator ─────────────
        var total = await CountLegacyPatientsAsync(dataSourceId, ct);
        _progress.Update(dataSourceId, s => {
            s.Status        = "running";
            s.TotalPatients = total;
            s.ImportedPatients  = 0;
            s.ImportedFollowUps = 0;
            s.Message       = $"Importing {total} patients…";
        });

        // ── Read from legacy DB ───────────────────────────────────────────
        _logger.LogInformation("Reading legacy records for DataSourceID={DataSourceId}.", dataSourceId);
        var (patients, followUpsByLegacyTID) =
            await ReadLegacyDataAsync(dataSourceId, ct);

        _logger.LogInformation(
            "Legacy read complete: {PatientCount} patients, {FollowUpCount} follow-ups.",
            patients.Count, followUpsByLegacyTID.Count);

        // ── Write to new DB (single transaction) ─────────────────────────
        await using var conn = new SqlConnection(_newConnStr);
        await conn.OpenAsync(ct);
        await using var tx = (SqlTransaction)await conn.BeginTransactionAsync(ct);

        try
        {
            // Ensure DataSourceT has a row for this facility. PtDetailsT.DataSourceID has
            // a FK to DataSourceT (FK_TBPtDetailsT_DS), so the row must exist before any
            // patient INSERTs. DataSourceT is normally populated by
            // migrate_sync_datasource_from_facilities.sql, but facilities added to
            // HealthFacilityT afterwards will be missing. This is a safe, idempotent upsert.
            await using (var syncCmd = NewCmd(conn))
            {
                syncCmd.Transaction = tx;
                syncCmd.CommandText = """
                    INSERT INTO DataSourceT (DataSourceID, DataSource)
                    SELECT h.HealthFacilityID, h.HealthFacility
                    FROM   HealthFacilityT h
                    WHERE  h.HealthFacilityID = @DataSourceID
                      AND  NOT EXISTS (
                          SELECT 1 FROM DataSourceT WHERE DataSourceID = @DataSourceID
                      )
                    """;
                syncCmd.Parameters.AddWithValue("@DataSourceID", dataSourceId);
                var inserted = await syncCmd.ExecuteNonQueryAsync(ct);
                if (inserted > 0)
                    _logger.LogInformation(
                        "Auto-synced DataSourceT entry for DataSourceID={DataSourceId}.", dataSourceId);
            }

            // Pre-load already-imported records to support resuming interrupted migrations.
            // Transactions are atomic in SQL Server; a crash mid-way rolls back automatically.
            // This pre-load handles the rare edge-case where partial data somehow exists.
            var guidByLegacyTID = new Dictionary<string, Guid>(patients.Count);
            await using (var preCmd = NewCmd(conn))
            {
                preCmd.Transaction = tx;
                preCmd.CommandText =
                    "SELECT LegacyTID, PtDetailsTID FROM PtDetailsT " +
                    "WHERE DataSourceID = @DataSourceID AND LegacyTID IS NOT NULL";
                preCmd.Parameters.AddWithValue("@DataSourceID", dataSourceId);
                await using var rdr2 = await preCmd.ExecuteReaderAsync(ct);
                while (await rdr2.ReadAsync(ct))
                    guidByLegacyTID[rdr2.GetString(0)] = rdr2.GetGuid(1);
            }

            var existingFollowUpTIDs = new HashSet<string>(StringComparer.Ordinal);
            await using (var preFuCmd = NewCmd(conn))
            {
                preFuCmd.Transaction = tx;
                preFuCmd.CommandText = """
                    SELECT fu.LegacyTID
                    FROM   PtFollowUpT fu
                    JOIN   PtDetailsT  pt ON fu.PtDetailsTID = pt.PtDetailsTID
                    WHERE  pt.DataSourceID = @DataSourceID
                      AND  fu.LegacyTID IS NOT NULL
                    """;
                preFuCmd.Parameters.AddWithValue("@DataSourceID", dataSourceId);
                await using var rdr3 = await preFuCmd.ExecuteReaderAsync(ct);
                while (await rdr3.ReadAsync(ct))
                    existingFollowUpTIDs.Add(rdr3.GetString(0));
            }

            int patientsImported  = guidByLegacyTID.Count;
            int followUpsImported = existingFollowUpTIDs.Count;

            if (patientsImported > 0)
                _logger.LogInformation(
                    "Resume: {Patients} patients and {FollowUps} follow-ups already imported for DataSourceID={DataSourceId}.",
                    patientsImported, followUpsImported, dataSourceId);

            foreach (var (legacyTID, patient) in patients)
            {
                if (guidByLegacyTID.ContainsKey(legacyTID))
                    continue; // already imported — skip

                var newGuid = Guid.NewGuid();
                guidByLegacyTID[legacyTID] = newGuid;

                await InsertPatientAsync(conn, tx, patient, newGuid, legacyTID, dataSourceId, ct);
                patientsImported++;
                _progress.Update(dataSourceId, s => s.ImportedPatients = patientsImported);
            }

            foreach (var (legacyPatientTID, followUp) in followUpsByLegacyTID)
            {
                if (!guidByLegacyTID.TryGetValue(legacyPatientTID, out var newPatientGuid))
                {
                    // Follow-up references a patient that wasn't included in this
                    // DataSourceID batch — skip it safely.
                    _logger.LogWarning(
                        "Skipping follow-up: parent LegacyTID '{LegacyTID}' not found in patient batch.",
                        legacyPatientTID);
                    continue;
                }

                if (existingFollowUpTIDs.Contains(followUp.LegacyFollowUpTID))
                    continue; // already imported — skip

                await InsertFollowUpAsync(conn, tx, followUp, newPatientGuid, ct);
                followUpsImported++;
                _progress.Update(dataSourceId, s => s.ImportedFollowUps = followUpsImported);
            }

            // ── Presumptive cases ─────────────────────────────────────────
            int presumptiveImported = 0;
            try
            {
                var legacyCases = await ReadLegacyPresumptiveCasesAsync(dataSourceId, null, ct);
                presumptiveImported = await UpsertPresumptiveCasesAsync(conn, tx, legacyCases, dataSourceId, false, ct);
            }
            catch (Exception pcEx)
            {
                // Non-fatal: old DB may not have PresumptiveCaseT or the table
                // may have a different schema — log and continue.
                _logger.LogWarning(pcEx,
                    "Could not migrate presumptive cases for DataSourceID={DataSourceId} (non-fatal).",
                    dataSourceId);
            }

            // Mark facility as migrated — bridge logic will now exclude this
            // DataSourceID from legacy DB queries.
            await MarkFacilityMigratedAsync(
                conn, tx, dataSourceId, triggeredByUserId,
                patientsImported, followUpsImported, ct);

            await tx.CommitAsync(ct);

            _logger.LogInformation(
                "Migration committed: DataSourceID={DataSourceId}, " +
                "patients={Patients}, followUps={FollowUps}, presumptiveCases={PC}.",
                dataSourceId, patientsImported, followUpsImported, presumptiveImported);

            var successMsg = $"Migrated {patientsImported} patients, {followUpsImported} follow-ups" +
                             (presumptiveImported > 0 ? $", {presumptiveImported} presumptive case(s)" : "") +
                             $" for DataSourceID {dataSourceId}.";
            _progress.Update(dataSourceId, s => {
                s.Status            = "done";
                s.ImportedPatients  = patientsImported;
                s.ImportedFollowUps = followUpsImported;
                s.Message           = successMsg;
            });

            return new MigrationResult(true, patientsImported, followUpsImported, successMsg);
        }
        catch (Exception ex)
        {
            await tx.RollbackAsync(ct);
            _logger.LogError(ex,
                "Migration failed for DataSourceID={DataSourceId}. Transaction rolled back.",
                dataSourceId);
            var detail   = ex.Message.Length > 120 ? ex.Message[..117] + "\u2026" : ex.Message;
            var errorMsg = $"Failed: {detail}";
            _progress.Update(dataSourceId, s => {
                s.Status  = "error";
                s.Message = errorMsg;
            });
            return new MigrationResult(false, 0, 0, errorMsg);
        }
    }

    // ── Public: Delta sync ─────────────────────────────────────────────────────

    /// <summary>
    /// Syncs records modified in the legacy DB after the cut-off date
    /// (2026-06-30) into the new DB for a single DataSourceID.
    /// Requires the facility to have already been fully migrated.
    /// Records whose PtDetailsT.LastModOn is after the cut-off are upserted:
    /// inserted if new, updated (all fields) if already present.
    /// Follow-ups are synced using PtDetailsT.LastModOn as a proxy since
    /// PtFollowUpT has no LastModOn — any edit in the legacy system updates
    /// the parent PtDetailsT.LastModOn automatically.
    /// </summary>
    public async Task<MigrationResult> DeltaSyncFacilityAsync(
        int  dataSourceId,
        Guid triggeredByUserId,
        CancellationToken ct = default)
    {
        // ── Guard: must already be fully migrated ─────────────────────────
        if (!await IsFacilityAlreadyMigratedAsync(dataSourceId, ct))
        {
            return new MigrationResult(false, 0, 0,
                $"DataSourceID {dataSourceId} has not been fully migrated yet. " +
                "Run the full migration first.");
        }

        var cutoff = new DateTime(2026, 6, 30, 0, 0, 0, DateTimeKind.Utc);

        // ── Count for progress bar ────────────────────────────────────────
        var total = await CountDeltaPatientsAsync(dataSourceId, cutoff, ct);
        _progress.Update(dataSourceId, s => {
            s.Status            = "delta-running";
            s.TotalPatients     = total;
            s.ImportedPatients  = 0;
            s.ImportedFollowUps = 0;
            s.Message           = $"Delta sync: {total} changed patient(s) to process\u2026";
        });

        // ── Read from legacy DB ───────────────────────────────────────────
        _logger.LogInformation(
            "Delta sync started for DataSourceID={DataSourceId} (cutoff {Cutoff:yyyy-MM-dd}).",
            dataSourceId, cutoff);

        var (patients, followUpsByLegacyTID) =
            await ReadDeltaDataAsync(dataSourceId, cutoff, ct);

        _logger.LogInformation(
            "Delta read complete: {PatientCount} patients, {FollowUpCount} follow-ups.",
            patients.Count, followUpsByLegacyTID.Count);

        // ── Write to new DB (single transaction) ─────────────────────────
        await using var conn = new SqlConnection(_newConnStr);
        await conn.OpenAsync(ct);
        await using var tx = (SqlTransaction)await conn.BeginTransactionAsync(ct);

        try
        {
            // Load existing LegacyTID → new GUID map for this facility
            var guidByLegacyTID = new Dictionary<string, Guid>(patients.Count);
            await using (var preCmd = NewCmd(conn))
            {
                preCmd.Transaction = tx;
                preCmd.CommandText =
                    "SELECT LegacyTID, PtDetailsTID FROM PtDetailsT " +
                    "WHERE DataSourceID = @DataSourceID AND LegacyTID IS NOT NULL";
                preCmd.Parameters.AddWithValue("@DataSourceID", dataSourceId);
                await using var rdr = await preCmd.ExecuteReaderAsync(ct);
                while (await rdr.ReadAsync(ct))
                    guidByLegacyTID[rdr.GetString(0)] = rdr.GetGuid(1);
            }

            // Load existing follow-up LegacyTIDs for this facility so we
            // can decide INSERT vs UPDATE for each follow-up.
            var existingFollowUpTIDs = new HashSet<string>(StringComparer.Ordinal);
            await using (var preFuCmd = NewCmd(conn))
            {
                preFuCmd.Transaction = tx;
                preFuCmd.CommandText = """
                    SELECT fu.LegacyTID
                    FROM   PtFollowUpT fu
                    JOIN   PtDetailsT  pt ON fu.PtDetailsTID = pt.PtDetailsTID
                    WHERE  pt.DataSourceID = @DataSourceID
                      AND  fu.LegacyTID IS NOT NULL
                    """;
                preFuCmd.Parameters.AddWithValue("@DataSourceID", dataSourceId);
                await using var rdr2 = await preFuCmd.ExecuteReaderAsync(ct);
                while (await rdr2.ReadAsync(ct))
                    existingFollowUpTIDs.Add(rdr2.GetString(0));
            }

            int patientsUpserted  = 0;
            int followUpsUpserted = 0;

            foreach (var (legacyTID, patient) in patients)
            {
                if (guidByLegacyTID.TryGetValue(legacyTID, out var existingGuid))
                {
                    // Record already exists — overwrite all fields from legacy
                    await UpdatePatientAsync(conn, tx, patient, existingGuid, dataSourceId, ct);
                }
                else
                {
                    // New record added after cut-off — insert it
                    var newGuid = Guid.NewGuid();
                    guidByLegacyTID[legacyTID] = newGuid;
                    await InsertPatientAsync(conn, tx, patient, newGuid, legacyTID, dataSourceId, ct);
                }

                patientsUpserted++;
                _progress.Update(dataSourceId, s => s.ImportedPatients = patientsUpserted);
            }

            foreach (var (legacyPatientTID, followUp) in followUpsByLegacyTID)
            {
                if (!guidByLegacyTID.TryGetValue(legacyPatientTID, out var newPatientGuid))
                {
                    _logger.LogWarning(
                        "Delta: skipping follow-up \u2014 parent LegacyTID '{LegacyTID}' not found.",
                        legacyPatientTID);
                    continue;
                }

                if (existingFollowUpTIDs.Contains(followUp.LegacyFollowUpTID))
                    await UpdateFollowUpAsync(conn, tx, followUp, ct);
                else
                    await InsertFollowUpAsync(conn, tx, followUp, newPatientGuid, ct);

                followUpsUpserted++;
                _progress.Update(dataSourceId, s => s.ImportedFollowUps = followUpsUpserted);
            }

            // ── Delta: presumptive cases ──────────────────────────────────
            int presumptiveUpserted = 0;
            try
            {
                // cutoff 46203 = June 30 2026 (Access/legacy date serial);
                // overwrite=true so legacy changes after that date win over earlier imports.
                var legacyCases = await ReadLegacyPresumptiveCasesAsync(dataSourceId, 46203, ct);
                presumptiveUpserted = await UpsertPresumptiveCasesAsync(conn, tx, legacyCases, dataSourceId, true, ct);
            }
            catch (Exception pcEx)
            {
                _logger.LogWarning(pcEx,
                    "Could not delta-sync presumptive cases for DataSourceID={DataSourceId} (non-fatal).",
                    dataSourceId);
            }

            // Stamp the delta sync timestamp on MigratedFacilitiesT
            await UpdateDeltaSyncStatsAsync(conn, tx, dataSourceId, patientsUpserted, followUpsUpserted, ct);

            await tx.CommitAsync(ct);

            _logger.LogInformation(
                "Delta sync committed: DataSourceID={DataSourceId}, " +
                "patients={Patients}, followUps={FollowUps}, presumptiveCases={PC}.",
                dataSourceId, patientsUpserted, followUpsUpserted, presumptiveUpserted);

            var successMsg =
                $"Delta sync: {patientsUpserted} patient(s) and {followUpsUpserted} follow-up(s)" +
                (presumptiveUpserted > 0 ? $", {presumptiveUpserted} presumptive case(s)" : "") +
                $" synced for DataSourceID {dataSourceId}.";

            _progress.Update(dataSourceId, s => {
                s.Status            = "delta-done";
                s.ImportedPatients  = patientsUpserted;
                s.ImportedFollowUps = followUpsUpserted;
                s.Message           = successMsg;
            });

            return new MigrationResult(true, patientsUpserted, followUpsUpserted, successMsg);
        }
        catch (Exception ex)
        {
            await tx.RollbackAsync(ct);
            _logger.LogError(ex,
                "Delta sync failed for DataSourceID={DataSourceId}. Transaction rolled back.",
                dataSourceId);
            var detail   = ex.Message.Length > 120 ? ex.Message[..117] + "\u2026" : ex.Message;
            var errorMsg = $"Delta sync failed: {detail}";
            _progress.Update(dataSourceId, s => {
                s.Status  = "error";
                s.Message = errorMsg;
            });
            return new MigrationResult(false, 0, 0, errorMsg);
        }
    }

    // ── Count legacy patients for a DataSourceID ─────────────────────────────

    public async Task<int> CountLegacyPatientsAsync(int dataSourceId, CancellationToken ct = default)
    {
        await using var conn = new SqlConnection(_legacyConnStr);
        await conn.OpenAsync(ct);
        await using var cmd = NewCmd(conn);
        cmd.CommandText =
            "SELECT COUNT(*) FROM PtDetailsT WHERE DataSourceID = @DataSourceID AND ISNULL(Deleted,0)=0";
        cmd.Parameters.AddWithValue("@DataSourceID", dataSourceId);
        var result = await cmd.ExecuteScalarAsync(ct);
        return result is int i ? i : 0;
    }

    // ── Count delta patients (modified after cut-off) ─────────────────────────

    public async Task<int> CountDeltaPatientsAsync(
        int dataSourceId, DateTime cutoff, CancellationToken ct = default)
    {
        await using var conn = new SqlConnection(_legacyConnStr);
        await conn.OpenAsync(ct);
        await using var cmd = NewCmd(conn);
        cmd.CommandText =
            "SELECT COUNT(*) FROM PtDetailsT " +
            "WHERE DataSourceID = @DataSourceID AND ISNULL(Deleted,0)=0 AND LastModOn > @Cutoff";
        cmd.Parameters.AddWithValue("@DataSourceID", dataSourceId);
        cmd.Parameters.AddWithValue("@Cutoff",       cutoff);
        var result = await cmd.ExecuteScalarAsync(ct);
        return Convert.ToInt32(result);
    }

    // ── Check already migrated ────────────────────────────────────────────────

    public async Task<bool> IsFacilityAlreadyMigratedAsync(
        int dataSourceId, CancellationToken ct = default)
    {
        await using var conn = new SqlConnection(_newConnStr);
        await conn.OpenAsync(ct);
        await using var cmd = NewCmd(conn);
        cmd.CommandText =
            "SELECT 1 FROM MigratedFacilitiesT WHERE DataSourceID = @DataSourceID";
        cmd.Parameters.AddWithValue("@DataSourceID", dataSourceId);
        var result = await cmd.ExecuteScalarAsync(ct);
        return result is not null;
    }

    // ── Read all legacy records for one DataSourceID ──────────────────────────

    private async Task<(
        Dictionary<string, LegacyPatientRow> patients,
        List<(string legacyPatientTID, LegacyFollowUpRow followUp)> followUps)>
        ReadLegacyDataAsync(int dataSourceId, CancellationToken ct)
    {
        var patients  = new Dictionary<string, LegacyPatientRow>();
        var followUps = new List<(string, LegacyFollowUpRow)>();

        await using var conn = new SqlConnection(_legacyConnStr);
        await conn.OpenAsync(ct);

        // ── Patients ──────────────────────────────────────────────────────
        await using (var cmd = NewCmd(conn))
        {
            cmd.CommandText = """
                SELECT
                    PtDetailsTID,
                    DataSourceID,
                    NearestHFID,
                    CountyID,
                    CountryID,
                    Deleted,
                    RegDate,
                    UnitTBNo,
                    PtName,
                    Age,
                    SexID,
                    ReferredByID,
                    Village,
                    Boma,
                    Payam,
                    County,
                    PtPhone,
                    TbTypeID,
                    PtTypeID,
                    TIHF,
                    TICounty,
                    DateRxStarted,
                    RegimenID,
                    DiagMethodID
                FROM  PtDetailsT
                WHERE DataSourceID = @DataSourceID
                  AND ISNULL(Deleted, 0) = 0
                """;
            cmd.Parameters.AddWithValue("@DataSourceID", dataSourceId);

            await using var rdr = await cmd.ExecuteReaderAsync(ct);
            while (await rdr.ReadAsync(ct))
            {
                var legacyTID = rdr.GetString(0);
                patients[legacyTID] = new LegacyPatientRow
                {
                    DataSourceID   = rdr.IsDBNull(1)  ? 0    : rdr.GetInt32(1),
                    NearestHFID    = rdr.IsDBNull(2)  ? 0    : rdr.GetInt32(2),
                    CountyID       = rdr.IsDBNull(3)  ? 0    : rdr.GetInt32(3),
                    CountryID      = rdr.IsDBNull(4)  ? 1    : rdr.GetInt32(4),
                    Deleted        = rdr.IsDBNull(5)  ? false: rdr.GetBoolean(5),
                    RegDate        = AccessIntToDate(rdr.IsDBNull(6)  ? (int?)null : rdr.GetInt32(6)),
                    UnitTBNo       = rdr.IsDBNull(7)  ? null : rdr.GetString(7),
                    PtName         = rdr.IsDBNull(8)  ? ""   : rdr.GetString(8),
                    Age            = rdr.IsDBNull(9)  ? 0    : (int)Math.Round(rdr.GetDouble(9)),
                    SexID          = rdr.IsDBNull(10) ? 0    : rdr.GetInt32(10),
                    ReferredByID   = rdr.IsDBNull(11) ? 0    : rdr.GetInt32(11),
                    Village        = rdr.IsDBNull(12) ? null : rdr.GetString(12),
                    Boma           = rdr.IsDBNull(13) ? null : rdr.GetString(13),
                    Payam          = rdr.IsDBNull(14) ? null : rdr.GetString(14),
                    County         = rdr.IsDBNull(15) ? null : rdr.GetString(15),
                    PtPhone        = rdr.IsDBNull(16) ? null : rdr.GetString(16),
                    TbTypeID       = rdr.IsDBNull(17) ? 0    : rdr.GetInt32(17),
                    PtTypeID       = rdr.IsDBNull(18) ? 0    : rdr.GetInt32(18),
                    TIHF           = rdr.IsDBNull(19) ? null : rdr.GetString(19),
                    TICounty       = rdr.IsDBNull(20) ? null : rdr.GetString(20),
                    DateRxStarted  = AccessIntToDate(rdr.IsDBNull(21) ? (int?)null : rdr.GetInt32(21)),
                    RegimenID      = rdr.IsDBNull(22) ? 0    : rdr.GetInt32(22),
                    DiagMethodID   = rdr.IsDBNull(23) ? 0    : rdr.GetInt32(23),
                };
            }
        }

        if (patients.Count == 0)
            return (patients, followUps);

        // ── Follow-ups (for all patients in this DataSourceID batch) ──────
        // Use a temp list of legacy TIDs to filter follow-ups efficiently.
        await using (var cmd = NewCmd(conn))
        {
            // Build a simple IN list of the legacy patient TIDs. We do this
            // with a temp table to avoid extremely long parameter lists.
            cmd.CommandText = """
                SELECT
                    f.PtFollowUpTID,
                    f.PtDetailsTID,
                    f.Mon0Date,
                    f.Mon0LabNo,
                    f.Mon0LabResultID,
                    f.Mon0XpertResultID,
                    f.Mon0XpertResultDate,
                    f.HIVTestDate,
                    f.HIVTestResultID,
                    f.DSTResult,
                    f.Mon2Date,
                    f.Mon2LabNo,
                    f.Mon2LabResultID,
                    f.Mon3Date,
                    f.Mon3LabNo,
                    f.Mon3LabResultID,
                    f.Mon5Date,
                    f.Mon5LabNo,
                    f.Mon5LabResultID,
                    f.Mon6Date,
                    f.Mon6LabNo,
                    f.Mon6LabResultID,
                    f.OutcomeID,
                    f.OutcomeDate,
                    f.TOHF,
                    f.TOCounty,
                    f.OnART,
                    f.ARTDate,
                    f.OnCPT,
                    f.CPTDate,
                    f.MovedTo2ndLine,
                    f.Remarks
                FROM  PtFollowUpT f
                INNER JOIN PtDetailsT p
                    ON p.PtDetailsTID = f.PtDetailsTID
                WHERE p.DataSourceID = @DataSourceID
                  AND ISNULL(p.Deleted, 0) = 0
                """;
            cmd.Parameters.AddWithValue("@DataSourceID", dataSourceId);

            await using var rdr = await cmd.ExecuteReaderAsync(ct);
            while (await rdr.ReadAsync(ct))
            {
                var legacyFollowUpTID = rdr.IsDBNull(0) ? Guid.NewGuid().ToString() : rdr.GetString(0);
                var legacyPatientTID  = rdr.IsDBNull(1) ? string.Empty             : rdr.GetString(1);

                followUps.Add((legacyPatientTID, new LegacyFollowUpRow
                {
                    LegacyFollowUpTID   = legacyFollowUpTID,
                    Mon0Date            = AccessIntToDate(rdr.IsDBNull(2)  ? (int?)null : rdr.GetInt32(2)),
                    Mon0LabNo           = rdr.IsDBNull(3)  ? null : rdr.GetString(3),
                    Mon0LabResultID     = rdr.IsDBNull(4)  ? 0    : rdr.GetInt32(4),
                    Mon0XpertResultID   = rdr.IsDBNull(5)  ? 0    : rdr.GetInt32(5),
                    Mon0XpertResultDate = AccessIntToDate(rdr.IsDBNull(6)  ? (int?)null : rdr.GetInt32(6)),
                    HIVTestDate         = AccessIntToDate(rdr.IsDBNull(7)  ? (int?)null : rdr.GetInt32(7)),
                    HIVTestResultID     = rdr.IsDBNull(8)  ? 0    : rdr.GetInt32(8),
                    DSTResult           = rdr.IsDBNull(9)  ? null : rdr.GetString(9),
                    Mon2Date            = AccessIntToDate(rdr.IsDBNull(10) ? (int?)null : rdr.GetInt32(10)),
                    Mon2LabNo           = rdr.IsDBNull(11) ? null : rdr.GetString(11),
                    Mon2LabResultID     = rdr.IsDBNull(12) ? 0    : rdr.GetInt32(12),
                    Mon3Date            = AccessIntToDate(rdr.IsDBNull(13) ? (int?)null : rdr.GetInt32(13)),
                    Mon3LabNo           = rdr.IsDBNull(14) ? null : rdr.GetString(14),
                    Mon3LabResultID     = rdr.IsDBNull(15) ? 0    : rdr.GetInt32(15),
                    Mon5Date            = AccessIntToDate(rdr.IsDBNull(16) ? (int?)null : rdr.GetInt32(16)),
                    Mon5LabNo           = rdr.IsDBNull(17) ? null : rdr.GetString(17),
                    Mon5LabResultID     = rdr.IsDBNull(18) ? 0    : rdr.GetInt32(18),
                    Mon6Date            = AccessIntToDate(rdr.IsDBNull(19) ? (int?)null : rdr.GetInt32(19)),
                    Mon6LabNo           = rdr.IsDBNull(20) ? null : rdr.GetString(20),
                    Mon6LabResultID     = rdr.IsDBNull(21) ? 0    : rdr.GetInt32(21),
                    OutcomeID           = rdr.IsDBNull(22) ? 0    : rdr.GetInt32(22),
                    OutcomeDate         = AccessIntToDate(rdr.IsDBNull(23) ? (int?)null : rdr.GetInt32(23)),
                    TOHF                = rdr.IsDBNull(24) ? null : rdr.GetString(24),
                    TOCounty            = rdr.IsDBNull(25) ? null : rdr.GetString(25),
                    OnART               = rdr.IsDBNull(26) ? 0    : rdr.GetInt32(26),
                    ARTDate             = AccessIntToDate(rdr.IsDBNull(27) ? (int?)null : rdr.GetInt32(27)),
                    OnCPT               = rdr.IsDBNull(28) ? 0    : rdr.GetInt32(28),
                    CPTDate             = AccessIntToDate(rdr.IsDBNull(29) ? (int?)null : rdr.GetInt32(29)),
                    MovedTo2ndLine      = rdr.IsDBNull(30) ? false: rdr.GetBoolean(30),
                    Remarks             = rdr.IsDBNull(31) ? null : rdr.GetString(31),
                }));
            }
        }

        return (patients, followUps);
    }

    // ── Read delta records (modified after cut-off) from legacy DB ─────────────

    private async Task<(
        Dictionary<string, LegacyPatientRow> patients,
        List<(string legacyPatientTID, LegacyFollowUpRow followUp)> followUps)>
        ReadDeltaDataAsync(int dataSourceId, DateTime cutoff, CancellationToken ct)
    {
        var patients  = new Dictionary<string, LegacyPatientRow>();
        var followUps = new List<(string, LegacyFollowUpRow)>();

        await using var conn = new SqlConnection(_legacyConnStr);
        await conn.OpenAsync(ct);

        // ── Delta Patients ────────────────────────────────────────────────
        await using (var cmd = NewCmd(conn))
        {
            cmd.CommandText = """
                SELECT
                    PtDetailsTID,
                    DataSourceID,
                    NearestHFID,
                    CountyID,
                    CountryID,
                    Deleted,
                    RegDate,
                    UnitTBNo,
                    PtName,
                    Age,
                    SexID,
                    ReferredByID,
                    Village,
                    Boma,
                    Payam,
                    County,
                    PtPhone,
                    TbTypeID,
                    PtTypeID,
                    TIHF,
                    TICounty,
                    DateRxStarted,
                    RegimenID,
                    DiagMethodID
                FROM  PtDetailsT
                WHERE DataSourceID = @DataSourceID
                  AND ISNULL(Deleted, 0) = 0
                  AND LastModOn > @Cutoff
                """;
            cmd.Parameters.AddWithValue("@DataSourceID", dataSourceId);
            cmd.Parameters.AddWithValue("@Cutoff",       cutoff);

            await using var rdr = await cmd.ExecuteReaderAsync(ct);
            while (await rdr.ReadAsync(ct))
            {
                var legacyTID = rdr.GetString(0);
                patients[legacyTID] = new LegacyPatientRow
                {
                    DataSourceID   = rdr.IsDBNull(1)  ? 0     : rdr.GetInt32(1),
                    NearestHFID    = rdr.IsDBNull(2)  ? 0     : rdr.GetInt32(2),
                    CountyID       = rdr.IsDBNull(3)  ? 0     : rdr.GetInt32(3),
                    CountryID      = rdr.IsDBNull(4)  ? 1     : rdr.GetInt32(4),
                    Deleted        = rdr.IsDBNull(5)  ? false : rdr.GetBoolean(5),
                    RegDate        = AccessIntToDate(rdr.IsDBNull(6)  ? (int?)null : rdr.GetInt32(6)),
                    UnitTBNo       = rdr.IsDBNull(7)  ? null  : rdr.GetString(7),
                    PtName         = rdr.IsDBNull(8)  ? ""    : rdr.GetString(8),
                    Age            = rdr.IsDBNull(9)  ? 0     : (int)Math.Round(rdr.GetDouble(9)),
                    SexID          = rdr.IsDBNull(10) ? 0     : rdr.GetInt32(10),
                    ReferredByID   = rdr.IsDBNull(11) ? 0     : rdr.GetInt32(11),
                    Village        = rdr.IsDBNull(12) ? null  : rdr.GetString(12),
                    Boma           = rdr.IsDBNull(13) ? null  : rdr.GetString(13),
                    Payam          = rdr.IsDBNull(14) ? null  : rdr.GetString(14),
                    County         = rdr.IsDBNull(15) ? null  : rdr.GetString(15),
                    PtPhone        = rdr.IsDBNull(16) ? null  : rdr.GetString(16),
                    TbTypeID       = rdr.IsDBNull(17) ? 0     : rdr.GetInt32(17),
                    PtTypeID       = rdr.IsDBNull(18) ? 0     : rdr.GetInt32(18),
                    TIHF           = rdr.IsDBNull(19) ? null  : rdr.GetString(19),
                    TICounty       = rdr.IsDBNull(20) ? null  : rdr.GetString(20),
                    DateRxStarted  = AccessIntToDate(rdr.IsDBNull(21) ? (int?)null : rdr.GetInt32(21)),
                    RegimenID      = rdr.IsDBNull(22) ? 0     : rdr.GetInt32(22),
                    DiagMethodID   = rdr.IsDBNull(23) ? 0     : rdr.GetInt32(23),
                };
            }
        }

        if (patients.Count == 0)
            return (patients, followUps);

        // ── Follow-ups for the delta patients ─────────────────────────────
        // Filter via the parent join so only follow-ups belonging to
        // delta patients (LastModOn > cutoff) are fetched.
        await using (var cmd = NewCmd(conn))
        {
            cmd.CommandText = """
                SELECT
                    f.PtFollowUpTID,
                    f.PtDetailsTID,
                    f.Mon0Date,
                    f.Mon0LabNo,
                    f.Mon0LabResultID,
                    f.Mon0XpertResultID,
                    f.Mon0XpertResultDate,
                    f.HIVTestDate,
                    f.HIVTestResultID,
                    f.DSTResult,
                    f.Mon2Date,
                    f.Mon2LabNo,
                    f.Mon2LabResultID,
                    f.Mon3Date,
                    f.Mon3LabNo,
                    f.Mon3LabResultID,
                    f.Mon5Date,
                    f.Mon5LabNo,
                    f.Mon5LabResultID,
                    f.Mon6Date,
                    f.Mon6LabNo,
                    f.Mon6LabResultID,
                    f.OutcomeID,
                    f.OutcomeDate,
                    f.TOHF,
                    f.TOCounty,
                    f.OnART,
                    f.ARTDate,
                    f.OnCPT,
                    f.CPTDate,
                    f.MovedTo2ndLine,
                    f.Remarks
                FROM  PtFollowUpT f
                INNER JOIN PtDetailsT p
                    ON p.PtDetailsTID = f.PtDetailsTID
                WHERE p.DataSourceID = @DataSourceID
                  AND ISNULL(p.Deleted, 0) = 0
                  AND p.LastModOn > @Cutoff
                """;
            cmd.Parameters.AddWithValue("@DataSourceID", dataSourceId);
            cmd.Parameters.AddWithValue("@Cutoff",       cutoff);

            await using var rdr = await cmd.ExecuteReaderAsync(ct);
            while (await rdr.ReadAsync(ct))
            {
                var legacyFollowUpTID = rdr.IsDBNull(0) ? Guid.NewGuid().ToString() : rdr.GetString(0);
                var legacyPatientTID  = rdr.IsDBNull(1) ? string.Empty             : rdr.GetString(1);

                followUps.Add((legacyPatientTID, new LegacyFollowUpRow
                {
                    LegacyFollowUpTID   = legacyFollowUpTID,
                    Mon0Date            = AccessIntToDate(rdr.IsDBNull(2)  ? (int?)null : rdr.GetInt32(2)),
                    Mon0LabNo           = rdr.IsDBNull(3)  ? null : rdr.GetString(3),
                    Mon0LabResultID     = rdr.IsDBNull(4)  ? 0    : rdr.GetInt32(4),
                    Mon0XpertResultID   = rdr.IsDBNull(5)  ? 0    : rdr.GetInt32(5),
                    Mon0XpertResultDate = AccessIntToDate(rdr.IsDBNull(6)  ? (int?)null : rdr.GetInt32(6)),
                    HIVTestDate         = AccessIntToDate(rdr.IsDBNull(7)  ? (int?)null : rdr.GetInt32(7)),
                    HIVTestResultID     = rdr.IsDBNull(8)  ? 0    : rdr.GetInt32(8),
                    DSTResult           = rdr.IsDBNull(9)  ? null : rdr.GetString(9),
                    Mon2Date            = AccessIntToDate(rdr.IsDBNull(10) ? (int?)null : rdr.GetInt32(10)),
                    Mon2LabNo           = rdr.IsDBNull(11) ? null : rdr.GetString(11),
                    Mon2LabResultID     = rdr.IsDBNull(12) ? 0    : rdr.GetInt32(12),
                    Mon3Date            = AccessIntToDate(rdr.IsDBNull(13) ? (int?)null : rdr.GetInt32(13)),
                    Mon3LabNo           = rdr.IsDBNull(14) ? null : rdr.GetString(14),
                    Mon3LabResultID     = rdr.IsDBNull(15) ? 0    : rdr.GetInt32(15),
                    Mon5Date            = AccessIntToDate(rdr.IsDBNull(16) ? (int?)null : rdr.GetInt32(16)),
                    Mon5LabNo           = rdr.IsDBNull(17) ? null : rdr.GetString(17),
                    Mon5LabResultID     = rdr.IsDBNull(18) ? 0    : rdr.GetInt32(18),
                    Mon6Date            = AccessIntToDate(rdr.IsDBNull(19) ? (int?)null : rdr.GetInt32(19)),
                    Mon6LabNo           = rdr.IsDBNull(20) ? null : rdr.GetString(20),
                    Mon6LabResultID     = rdr.IsDBNull(21) ? 0    : rdr.GetInt32(21),
                    OutcomeID           = rdr.IsDBNull(22) ? 0    : rdr.GetInt32(22),
                    OutcomeDate         = AccessIntToDate(rdr.IsDBNull(23) ? (int?)null : rdr.GetInt32(23)),
                    TOHF                = rdr.IsDBNull(24) ? null : rdr.GetString(24),
                    TOCounty            = rdr.IsDBNull(25) ? null : rdr.GetString(25),
                    OnART               = rdr.IsDBNull(26) ? 0    : rdr.GetInt32(26),
                    ARTDate             = AccessIntToDate(rdr.IsDBNull(27) ? (int?)null : rdr.GetInt32(27)),
                    OnCPT               = rdr.IsDBNull(28) ? 0    : rdr.GetInt32(28),
                    CPTDate             = AccessIntToDate(rdr.IsDBNull(29) ? (int?)null : rdr.GetInt32(29)),
                    MovedTo2ndLine      = rdr.IsDBNull(30) ? false: rdr.GetBoolean(30),
                    Remarks             = rdr.IsDBNull(31) ? null : rdr.GetString(31),
                }));
            }
        }

        return (patients, followUps);
    }

    // Truncate a string to a maximum column length, returning DBNull for null.
    private static object ColStr(string? s, int max) =>
        s is null ? DBNull.Value : s.Length > max ? (object)s[..max] : s;

    // Create a SqlCommand with a long timeout suitable for migration operations.
    private static SqlCommand NewCmd(SqlConnection c)
    {
        var cmd = c.CreateCommand();
        cmd.CommandTimeout = 600; // 10 minutes — avoids timeouts on large facility imports
        return cmd;
    }

    // ── Insert a single patient into the new DB ───────────────────────────────

    private static async Task InsertPatientAsync(
        SqlConnection conn,
        SqlTransaction tx,
        LegacyPatientRow p,
        Guid newGuid,
        string legacyTID,
        int dataSourceId,
        CancellationToken ct)
    {
        await using var cmd = NewCmd(conn);
        cmd.Transaction = tx;
        cmd.CommandText = """
            INSERT INTO PtDetailsT (
                PtDetailsTID, DataSourceID, NearestHFID, CountyID, CountryID,
                HasChanged, Deleted, LastModOn, CreatedOn,
                RegDate, UnitTBNo, PtName, Age,
                SexID, ReferredByID, Village, Boma, Payam, County, PtPhone,
                TbTypeID, PtTypeID, TIHF, TICounty,
                DateRxStarted, RegimenID, DiagMethodID,
                LegacyTID
            ) VALUES (
                @PtDetailsTID, @DataSourceID,
                COALESCE((SELECT TOP 1 HealthFacilityID FROM HealthFacilityT WHERE HealthFacilityID = @NearestHFID), @DataSourceID),
                @CountyID, @CountryID,
                0, @Deleted, SYSUTCDATETIME(), SYSUTCDATETIME(),
                @RegDate, @UnitTBNo, @PtName, @Age,
                COALESCE((SELECT TOP 1 SexID        FROM SexT        WHERE SexID        = @SexID),        0),
                COALESCE((SELECT TOP 1 ReferredByID FROM ReferredByT WHERE ReferredByID = @ReferredByID), 0),
                @Village, @Boma, @Payam, @County, @PtPhone,
                COALESCE((SELECT TOP 1 TbTypeID     FROM TbTypeT     WHERE TbTypeID     = @TbTypeID),     0),
                COALESCE((SELECT TOP 1 PtTypeID     FROM PtTypeT     WHERE PtTypeID     = @PtTypeID),     0),
                @TIHF, @TICounty,
                @DateRxStarted,
                COALESCE((SELECT TOP 1 RegimenID    FROM RegimenT    WHERE RegimenID    = @RegimenID),    0),
                COALESCE((SELECT TOP 1 DiagMethodID FROM DiagMethodT WHERE DiagMethodID = @DiagMethodID), 0),
                @LegacyTID
            )
            """;

        cmd.Parameters.AddWithValue("@PtDetailsTID",  newGuid);
        cmd.Parameters.AddWithValue("@DataSourceID",  dataSourceId);
        cmd.Parameters.AddWithValue("@NearestHFID",   p.NearestHFID);
        cmd.Parameters.AddWithValue("@CountyID",      p.CountyID);
        cmd.Parameters.AddWithValue("@CountryID",     p.CountryID);
        cmd.Parameters.AddWithValue("@Deleted",       p.Deleted ? 1 : 0);
        cmd.Parameters.AddWithValue("@RegDate",       (object?)p.RegDate ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@UnitTBNo",      ColStr(p.UnitTBNo,  30));
        cmd.Parameters.AddWithValue("@PtName",        string.IsNullOrWhiteSpace(p.PtName) ? "(unknown)" : p.PtName.Length > 100 ? p.PtName[..100] : p.PtName);
        cmd.Parameters.AddWithValue("@Age",           p.Age);
        cmd.Parameters.AddWithValue("@SexID",         p.SexID);
        cmd.Parameters.AddWithValue("@ReferredByID",  p.ReferredByID);
        cmd.Parameters.AddWithValue("@Village",       ColStr(p.Village,  100));
        cmd.Parameters.AddWithValue("@Boma",          ColStr(p.Boma,     100));
        cmd.Parameters.AddWithValue("@Payam",         ColStr(p.Payam,    100));
        cmd.Parameters.AddWithValue("@County",        ColStr(p.County,   100));
        cmd.Parameters.AddWithValue("@PtPhone",       ColStr(p.PtPhone,   15));
        cmd.Parameters.AddWithValue("@TbTypeID",      p.TbTypeID);
        cmd.Parameters.AddWithValue("@PtTypeID",      p.PtTypeID);
        cmd.Parameters.AddWithValue("@TIHF",          ColStr(p.TIHF,     100));
        cmd.Parameters.AddWithValue("@TICounty",      ColStr(p.TICounty, 100));
        cmd.Parameters.AddWithValue("@DateRxStarted", (object?)p.DateRxStarted ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@RegimenID",     p.RegimenID);
        cmd.Parameters.AddWithValue("@DiagMethodID",  p.DiagMethodID);
        cmd.Parameters.AddWithValue("@LegacyTID",     legacyTID);

        await cmd.ExecuteNonQueryAsync(ct);
    }

    // ── Update an existing patient in the new DB (delta sync) ────────────────

    private static async Task UpdatePatientAsync(
        SqlConnection conn,
        SqlTransaction tx,
        LegacyPatientRow p,
        Guid existingGuid,
        int dataSourceId,
        CancellationToken ct)
    {
        await using var cmd = NewCmd(conn);
        cmd.Transaction = tx;
        cmd.CommandText = """
            UPDATE PtDetailsT SET
                NearestHFID   = COALESCE((SELECT TOP 1 HealthFacilityID FROM HealthFacilityT WHERE HealthFacilityID = @NearestHFID), @DataSourceID),
                CountyID      = @CountyID,
                CountryID     = @CountryID,
                Deleted       = @Deleted,
                LastModOn     = SYSUTCDATETIME(),
                HasChanged    = 1,
                RegDate       = @RegDate,
                UnitTBNo      = @UnitTBNo,
                PtName        = @PtName,
                Age           = @Age,
                SexID         = COALESCE((SELECT TOP 1 SexID        FROM SexT        WHERE SexID        = @SexID),        0),
                ReferredByID  = COALESCE((SELECT TOP 1 ReferredByID FROM ReferredByT WHERE ReferredByID = @ReferredByID), 0),
                Village       = @Village,
                Boma          = @Boma,
                Payam         = @Payam,
                County        = @County,
                PtPhone       = @PtPhone,
                TbTypeID      = COALESCE((SELECT TOP 1 TbTypeID     FROM TbTypeT     WHERE TbTypeID     = @TbTypeID),     0),
                PtTypeID      = COALESCE((SELECT TOP 1 PtTypeID     FROM PtTypeT     WHERE PtTypeID     = @PtTypeID),     0),
                TIHF          = @TIHF,
                TICounty      = @TICounty,
                DateRxStarted = @DateRxStarted,
                RegimenID     = COALESCE((SELECT TOP 1 RegimenID    FROM RegimenT    WHERE RegimenID    = @RegimenID),    0),
                DiagMethodID  = COALESCE((SELECT TOP 1 DiagMethodID FROM DiagMethodT WHERE DiagMethodID = @DiagMethodID), 0)
            WHERE PtDetailsTID = @PtDetailsTID
            """;

        cmd.Parameters.AddWithValue("@PtDetailsTID",   existingGuid);
        cmd.Parameters.AddWithValue("@DataSourceID",   dataSourceId);
        cmd.Parameters.AddWithValue("@NearestHFID",    p.NearestHFID);
        cmd.Parameters.AddWithValue("@CountyID",       p.CountyID);
        cmd.Parameters.AddWithValue("@CountryID",      p.CountryID);
        cmd.Parameters.AddWithValue("@Deleted",        p.Deleted ? 1 : 0);
        cmd.Parameters.AddWithValue("@RegDate",        (object?)p.RegDate       ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@UnitTBNo",       ColStr(p.UnitTBNo,  30));
        cmd.Parameters.AddWithValue("@PtName",         string.IsNullOrWhiteSpace(p.PtName) ? "(unknown)" : p.PtName.Length > 100 ? p.PtName[..100] : p.PtName);
        cmd.Parameters.AddWithValue("@Age",            p.Age);
        cmd.Parameters.AddWithValue("@SexID",          p.SexID);
        cmd.Parameters.AddWithValue("@ReferredByID",   p.ReferredByID);
        cmd.Parameters.AddWithValue("@Village",        ColStr(p.Village,  100));
        cmd.Parameters.AddWithValue("@Boma",           ColStr(p.Boma,     100));
        cmd.Parameters.AddWithValue("@Payam",          ColStr(p.Payam,    100));
        cmd.Parameters.AddWithValue("@County",         ColStr(p.County,   100));
        cmd.Parameters.AddWithValue("@PtPhone",        ColStr(p.PtPhone,   15));
        cmd.Parameters.AddWithValue("@TbTypeID",       p.TbTypeID);
        cmd.Parameters.AddWithValue("@PtTypeID",       p.PtTypeID);
        cmd.Parameters.AddWithValue("@TIHF",           ColStr(p.TIHF,     100));
        cmd.Parameters.AddWithValue("@TICounty",       ColStr(p.TICounty, 100));
        cmd.Parameters.AddWithValue("@DateRxStarted",  (object?)p.DateRxStarted ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@RegimenID",      p.RegimenID);
        cmd.Parameters.AddWithValue("@DiagMethodID",   p.DiagMethodID);

        await cmd.ExecuteNonQueryAsync(ct);
    }

    // ── Insert a single follow-up into the new DB ─────────────────────────────

    private static async Task InsertFollowUpAsync(
        SqlConnection conn,
        SqlTransaction tx,
        LegacyFollowUpRow f,
        Guid newPatientGuid,
        CancellationToken ct)
    {
        await using var cmd = NewCmd(conn);
        cmd.Transaction = tx;
        cmd.CommandText = """
            INSERT INTO PtFollowUpT (
                PtFollowUpTID, PtDetailsTID,
                HasChanged, Deleted, LastModOn, CreatedOn,
                Mon0Date, Mon0LabNo, Mon0LabResultID,
                Mon0XpertResultID, Mon0XpertResultDate,
                HIVTestDate, HIVTestResultID, DSTResult,
                Mon2Date, Mon2LabNo, Mon2LabResultID,
                Mon3Date, Mon3LabNo, Mon3LabResultID,
                Mon5Date, Mon5LabNo, Mon5LabResultID,
                Mon6Date, Mon6LabNo, Mon6LabResultID,
                OutcomeID, OutcomeDate, TOHF, TOCounty,
                OnART, ARTDate, OnCPT, CPTDate,
                MovedTo2ndLine, Remarks,
                LegacyTID
            ) VALUES (
                NEWID(), @PtDetailsTID,
                0, 0, SYSUTCDATETIME(), SYSUTCDATETIME(),
                @Mon0Date, @Mon0LabNo, @Mon0LabResultID,
                @Mon0XpertResultID, @Mon0XpertResultDate,
                @HIVTestDate, @HIVTestResultID, @DSTResult,
                @Mon2Date, @Mon2LabNo, @Mon2LabResultID,
                @Mon3Date, @Mon3LabNo, @Mon3LabResultID,
                @Mon5Date, @Mon5LabNo, @Mon5LabResultID,
                @Mon6Date, @Mon6LabNo, @Mon6LabResultID,
                @OutcomeID, @OutcomeDate, @TOHF, @TOCounty,
                @OnART, @ARTDate, @OnCPT, @CPTDate,
                @MovedTo2ndLine, @Remarks,
                @LegacyTID
            )
            """;

        cmd.Parameters.AddWithValue("@PtDetailsTID",        newPatientGuid);
        cmd.Parameters.AddWithValue("@Mon0Date",            (object?)f.Mon0Date            ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@Mon0LabNo",           ColStr(f.Mon0LabNo,  30));
        cmd.Parameters.AddWithValue("@Mon0LabResultID",     f.Mon0LabResultID);
        cmd.Parameters.AddWithValue("@Mon0XpertResultID",   f.Mon0XpertResultID);
        cmd.Parameters.AddWithValue("@Mon0XpertResultDate", (object?)f.Mon0XpertResultDate ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@HIVTestDate",         (object?)f.HIVTestDate         ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@HIVTestResultID",     f.HIVTestResultID);
        cmd.Parameters.AddWithValue("@DSTResult",           ColStr(f.DSTResult,  100));
        cmd.Parameters.AddWithValue("@Mon2Date",            (object?)f.Mon2Date            ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@Mon2LabNo",           ColStr(f.Mon2LabNo,  30));
        cmd.Parameters.AddWithValue("@Mon2LabResultID",     f.Mon2LabResultID);
        cmd.Parameters.AddWithValue("@Mon3Date",            (object?)f.Mon3Date            ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@Mon3LabNo",           ColStr(f.Mon3LabNo,  30));
        cmd.Parameters.AddWithValue("@Mon3LabResultID",     f.Mon3LabResultID);
        cmd.Parameters.AddWithValue("@Mon5Date",            (object?)f.Mon5Date            ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@Mon5LabNo",           ColStr(f.Mon5LabNo,  30));
        cmd.Parameters.AddWithValue("@Mon5LabResultID",     f.Mon5LabResultID);
        cmd.Parameters.AddWithValue("@Mon6Date",            (object?)f.Mon6Date            ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@Mon6LabNo",           ColStr(f.Mon6LabNo,  30));
        cmd.Parameters.AddWithValue("@Mon6LabResultID",     f.Mon6LabResultID);
        cmd.Parameters.AddWithValue("@OutcomeID",           f.OutcomeID);
        cmd.Parameters.AddWithValue("@OutcomeDate",         (object?)f.OutcomeDate         ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@TOHF",                ColStr(f.TOHF,       100));
        cmd.Parameters.AddWithValue("@TOCounty",            ColStr(f.TOCounty,   100));
        cmd.Parameters.AddWithValue("@OnART",               f.OnART);
        cmd.Parameters.AddWithValue("@ARTDate",             (object?)f.ARTDate             ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@OnCPT",               f.OnCPT);
        cmd.Parameters.AddWithValue("@CPTDate",             (object?)f.CPTDate             ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@MovedTo2ndLine",      f.MovedTo2ndLine ? 1 : 0);
        cmd.Parameters.AddWithValue("@Remarks",             ColStr(f.Remarks,    500));
        cmd.Parameters.AddWithValue("@LegacyTID",           f.LegacyFollowUpTID);

        await cmd.ExecuteNonQueryAsync(ct);
    }

    // ── Update an existing follow-up in the new DB (delta sync) ──────────────

    private static async Task UpdateFollowUpAsync(
        SqlConnection conn,
        SqlTransaction tx,
        LegacyFollowUpRow f,
        CancellationToken ct)
    {
        await using var cmd = NewCmd(conn);
        cmd.Transaction = tx;
        cmd.CommandText = """
            UPDATE PtFollowUpT SET
                LastModOn           = SYSUTCDATETIME(),
                HasChanged          = 1,
                Mon0Date            = @Mon0Date,
                Mon0LabNo           = @Mon0LabNo,
                Mon0LabResultID     = @Mon0LabResultID,
                Mon0XpertResultID   = @Mon0XpertResultID,
                Mon0XpertResultDate = @Mon0XpertResultDate,
                HIVTestDate         = @HIVTestDate,
                HIVTestResultID     = @HIVTestResultID,
                DSTResult           = @DSTResult,
                Mon2Date            = @Mon2Date,
                Mon2LabNo           = @Mon2LabNo,
                Mon2LabResultID     = @Mon2LabResultID,
                Mon3Date            = @Mon3Date,
                Mon3LabNo           = @Mon3LabNo,
                Mon3LabResultID     = @Mon3LabResultID,
                Mon5Date            = @Mon5Date,
                Mon5LabNo           = @Mon5LabNo,
                Mon5LabResultID     = @Mon5LabResultID,
                Mon6Date            = @Mon6Date,
                Mon6LabNo           = @Mon6LabNo,
                Mon6LabResultID     = @Mon6LabResultID,
                OutcomeID           = @OutcomeID,
                OutcomeDate         = @OutcomeDate,
                TOHF                = @TOHF,
                TOCounty            = @TOCounty,
                OnART               = @OnART,
                ARTDate             = @ARTDate,
                OnCPT               = @OnCPT,
                CPTDate             = @CPTDate,
                MovedTo2ndLine      = @MovedTo2ndLine,
                Remarks             = @Remarks
            WHERE LegacyTID = @LegacyTID
            """;

        cmd.Parameters.AddWithValue("@LegacyTID",           f.LegacyFollowUpTID);
        cmd.Parameters.AddWithValue("@Mon0Date",            (object?)f.Mon0Date            ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@Mon0LabNo",           ColStr(f.Mon0LabNo,  30));
        cmd.Parameters.AddWithValue("@Mon0LabResultID",     f.Mon0LabResultID);
        cmd.Parameters.AddWithValue("@Mon0XpertResultID",   f.Mon0XpertResultID);
        cmd.Parameters.AddWithValue("@Mon0XpertResultDate", (object?)f.Mon0XpertResultDate ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@HIVTestDate",         (object?)f.HIVTestDate         ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@HIVTestResultID",     f.HIVTestResultID);
        cmd.Parameters.AddWithValue("@DSTResult",           ColStr(f.DSTResult,  100));
        cmd.Parameters.AddWithValue("@Mon2Date",            (object?)f.Mon2Date            ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@Mon2LabNo",           ColStr(f.Mon2LabNo,  30));
        cmd.Parameters.AddWithValue("@Mon2LabResultID",     f.Mon2LabResultID);
        cmd.Parameters.AddWithValue("@Mon3Date",            (object?)f.Mon3Date            ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@Mon3LabNo",           ColStr(f.Mon3LabNo,  30));
        cmd.Parameters.AddWithValue("@Mon3LabResultID",     f.Mon3LabResultID);
        cmd.Parameters.AddWithValue("@Mon5Date",            (object?)f.Mon5Date            ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@Mon5LabNo",           ColStr(f.Mon5LabNo,  30));
        cmd.Parameters.AddWithValue("@Mon5LabResultID",     f.Mon5LabResultID);
        cmd.Parameters.AddWithValue("@Mon6Date",            (object?)f.Mon6Date            ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@Mon6LabNo",           ColStr(f.Mon6LabNo,  30));
        cmd.Parameters.AddWithValue("@Mon6LabResultID",     f.Mon6LabResultID);
        cmd.Parameters.AddWithValue("@OutcomeID",           f.OutcomeID);
        cmd.Parameters.AddWithValue("@OutcomeDate",         (object?)f.OutcomeDate         ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@TOHF",                ColStr(f.TOHF,       100));
        cmd.Parameters.AddWithValue("@TOCounty",            ColStr(f.TOCounty,   100));
        cmd.Parameters.AddWithValue("@OnART",               f.OnART);
        cmd.Parameters.AddWithValue("@ARTDate",             (object?)f.ARTDate             ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@OnCPT",               f.OnCPT);
        cmd.Parameters.AddWithValue("@CPTDate",             (object?)f.CPTDate             ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@MovedTo2ndLine",      f.MovedTo2ndLine ? 1 : 0);
        cmd.Parameters.AddWithValue("@Remarks",             ColStr(f.Remarks,    500));

        await cmd.ExecuteNonQueryAsync(ct);
    }

    // ── Mark facility as migrated ─────────────────────────────────────────────

    private static async Task MarkFacilityMigratedAsync(
        SqlConnection conn,
        SqlTransaction tx,
        int dataSourceId,
        Guid triggeredByUserId,
        int patientsImported,
        int followUpsImported,
        CancellationToken ct)
    {
        await using var cmd = NewCmd(conn);
        cmd.Transaction = tx;
        cmd.CommandText = """
            INSERT INTO MigratedFacilitiesT
                (DataSourceID, MigratedOn, MigratedByID, PatientsImported, FollowUpsImported)
            VALUES
                (@DataSourceID, SYSUTCDATETIME(), @MigratedByID, @PatientsImported, @FollowUpsImported)
            """;
        cmd.Parameters.AddWithValue("@DataSourceID",       dataSourceId);
        cmd.Parameters.AddWithValue("@MigratedByID",       triggeredByUserId == Guid.Empty
                                                               ? (object)DBNull.Value
                                                               : triggeredByUserId);
        cmd.Parameters.AddWithValue("@PatientsImported",   patientsImported);
        cmd.Parameters.AddWithValue("@FollowUpsImported",  followUpsImported);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    // ── Stamp delta sync stats on MigratedFacilitiesT ───────────────────────────

    private static async Task UpdateDeltaSyncStatsAsync(
        SqlConnection conn,
        SqlTransaction tx,
        int dataSourceId,
        int patientsUpserted,
        int followUpsUpserted,
        CancellationToken ct)
    {
        await using var cmd = NewCmd(conn);
        cmd.Transaction = tx;
        cmd.CommandText = """
            UPDATE MigratedFacilitiesT SET
                LastDeltaSyncOn        = SYSUTCDATETIME(),
                LastDeltaSyncPatients  = @Patients,
                LastDeltaSyncFollowUps = @FollowUps
            WHERE DataSourceID = @DataSourceID
            """;
        cmd.Parameters.AddWithValue("@DataSourceID", dataSourceId);
        cmd.Parameters.AddWithValue("@Patients",     patientsUpserted);
        cmd.Parameters.AddWithValue("@FollowUps",    followUpsUpserted);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    // ── Date conversion helper ────────────────────────────────────────────────

    /// <summary>
    /// Converts an Access OLE Automation date integer to a .NET DateTime.
    /// The Access epoch is 1899-12-30; integer 0 = that date.
    /// Returns null if <paramref name="accessInt"/> is null or 0 (unset).
    /// </summary>
    private static DateTime? AccessIntToDate(int? accessInt)
    {
        if (accessInt is null or 0) return null;
        return AccessEpoch.AddDays(accessInt.Value);
    }

    // ── Internal DTOs (legacy DB rows, not exposed to controllers) ────────────

    private sealed class LegacyPatientRow
    {
        public int      DataSourceID   { get; set; }
        public int      NearestHFID    { get; set; }
        public int      CountyID       { get; set; }
        public int      CountryID      { get; set; }
        public bool     Deleted        { get; set; }
        public DateTime? RegDate       { get; set; }
        public string?  UnitTBNo       { get; set; }
        public string   PtName         { get; set; } = string.Empty;
        public int      Age            { get; set; }
        public int      SexID          { get; set; }
        public int      ReferredByID   { get; set; }
        public string?  Village        { get; set; }
        public string?  Boma           { get; set; }
        public string?  Payam          { get; set; }
        public string?  County         { get; set; }
        public string?  PtPhone        { get; set; }
        public int      TbTypeID       { get; set; }
        public int      PtTypeID       { get; set; }
        public string?  TIHF           { get; set; }
        public string?  TICounty       { get; set; }
        public DateTime? DateRxStarted { get; set; }
        public int      RegimenID      { get; set; }
        public int      DiagMethodID   { get; set; }
    }

    private sealed class LegacyFollowUpRow
    {
        public string   LegacyFollowUpTID   { get; set; } = string.Empty;
        public DateTime? Mon0Date           { get; set; }
        public string?  Mon0LabNo           { get; set; }
        public int      Mon0LabResultID     { get; set; }
        public int      Mon0XpertResultID   { get; set; }
        public DateTime? Mon0XpertResultDate{ get; set; }
        public DateTime? HIVTestDate        { get; set; }
        public int      HIVTestResultID     { get; set; }
        public string?  DSTResult           { get; set; }
        public DateTime? Mon2Date           { get; set; }
        public string?  Mon2LabNo           { get; set; }
        public int      Mon2LabResultID     { get; set; }
        public DateTime? Mon3Date           { get; set; }
        public string?  Mon3LabNo           { get; set; }
        public int      Mon3LabResultID     { get; set; }
        public DateTime? Mon5Date           { get; set; }
        public string?  Mon5LabNo           { get; set; }
        public int      Mon5LabResultID     { get; set; }
        public DateTime? Mon6Date           { get; set; }
        public string?  Mon6LabNo           { get; set; }
        public int      Mon6LabResultID     { get; set; }
        public int      OutcomeID           { get; set; }
        public DateTime? OutcomeDate        { get; set; }
        public string?  TOHF                { get; set; }
        public string?  TOCounty            { get; set; }
        public int      OnART               { get; set; }
        public DateTime? ARTDate            { get; set; }
        public int      OnCPT               { get; set; }
        public DateTime? CPTDate            { get; set; }
        public bool     MovedTo2ndLine      { get; set; }
        public string?  Remarks             { get; set; }
    }

    // ── Presumptive case helpers ──────────────────────────────────────────────

    private sealed class LegacyPresumptiveCaseRow
    {
        public int  PresumptiveCase { get; set; }
        public int  MonthID         { get; set; }
        public int  YearID          { get; set; }
        public int  NearestHFID     { get; set; }
        public int  DataSourceID    { get; set; }
        public int  CountyID        { get; set; }
    }

    /// <summary>
    /// Reads all PresumptiveCaseT rows for <paramref name="dataSourceId"/>
    /// from the legacy database.  Returns an empty list if the table does not
    /// exist (graceful no-op for legacy DBs without presumptive data).
    /// </summary>
    private async Task<List<LegacyPresumptiveCaseRow>> ReadLegacyPresumptiveCasesAsync(
        int dataSourceId, int? cutoffSerialDate, CancellationToken ct)
    {
        var rows = new List<LegacyPresumptiveCaseRow>();
        await using var conn = new SqlConnection(_legacyConnStr);
        await conn.OpenAsync(ct);

        // Guard: check the table exists before querying it
        await using (var chkCmd = NewCmd(conn))
        {
            chkCmd.CommandText =
                "SELECT 1 FROM INFORMATION_SCHEMA.TABLES " +
                "WHERE TABLE_NAME = 'PresumptiveCaseT'";
            var exists = await chkCmd.ExecuteScalarAsync(ct);
            if (exists is null) return rows; // table absent in legacy DB
        }

        await using var cmd = NewCmd(conn);
        cmd.CommandText = cutoffSerialDate.HasValue
            ? """
              SELECT PresumptiveCase, MonthID, YearID, NearestHFID,
                     DataSourceID, ISNULL(CountyID, 0) AS CountyID
              FROM   PresumptiveCaseT
              WHERE  DataSourceID = @DataSourceID
                AND  LastModOn   >= @CutoffDate
              """
            : """
              SELECT PresumptiveCase, MonthID, YearID, NearestHFID,
                     DataSourceID, ISNULL(CountyID, 0) AS CountyID
              FROM   PresumptiveCaseT
              WHERE  DataSourceID = @DataSourceID
              """;
        cmd.Parameters.AddWithValue("@DataSourceID", dataSourceId);
        if (cutoffSerialDate.HasValue)
            cmd.Parameters.AddWithValue("@CutoffDate", cutoffSerialDate.Value);

        await using var rdr = await cmd.ExecuteReaderAsync(ct);
        while (await rdr.ReadAsync(ct))
        {
            rows.Add(new LegacyPresumptiveCaseRow
            {
                PresumptiveCase = rdr.IsDBNull(0) ? 0 : rdr.GetInt32(0),
                MonthID         = rdr.IsDBNull(1) ? 0 : rdr.GetInt32(1),
                YearID          = rdr.IsDBNull(2) ? 0 : rdr.GetInt32(2),
                NearestHFID     = rdr.IsDBNull(3) ? 0 : rdr.GetInt32(3),
                DataSourceID    = rdr.IsDBNull(4) ? 0 : rdr.GetInt32(4),
                CountyID        = rdr.IsDBNull(5) ? 0 : rdr.GetInt32(5),
            });
        }

        return rows;
    }

    /// <summary>
    /// Upserts a set of legacy presumptive case rows into the new PresumptiveCaseT.
    /// Keyed on (NearestHFID, MonthID, YearID) — one row per facility per month.
    /// Rows that do not exist are inserted; existing rows are left unchanged
    /// (the new-system value wins to avoid overwriting user edits).
    /// Returns the count of rows inserted.
    /// </summary>
    private static async Task<int> UpsertPresumptiveCasesAsync(
        SqlConnection conn,
        SqlTransaction tx,
        List<LegacyPresumptiveCaseRow> cases,
        int dataSourceId,
        bool overwrite,
        CancellationToken ct)
    {
        if (cases.Count == 0) return 0;
        int inserted = 0;

        const string sqlInsertOnly = """
            IF NOT EXISTS (
                SELECT 1 FROM PresumptiveCaseT
                WHERE NearestHFID = @NearestHFID
                  AND MonthID     = @MonthID
                  AND YearID      = @YearID
            )
            BEGIN
                INSERT INTO PresumptiveCaseT (
                    PresumptiveCaseTID, PresumptiveCase, MonthID, YearID,
                    NearestHFID, DataSourceID, CountyID,
                    HasChanged, Uploaded, Imported, LastModOn, EnteredByID)
                VALUES (
                    NEWID(), @PresumptiveCase, @MonthID, @YearID,
                    @NearestHFID, @DataSourceID, @CountyID,
                    0, 0, 1, GETDATE(), '00000000-0000-0000-0000-000000000000')
            END
            """;
        const string sqlUpsert = """
            IF EXISTS (
                SELECT 1 FROM PresumptiveCaseT
                WHERE NearestHFID = @NearestHFID
                  AND MonthID     = @MonthID
                  AND YearID      = @YearID
            )
                UPDATE PresumptiveCaseT
                SET    PresumptiveCase = @PresumptiveCase,
                       CountyID        = @CountyID,
                       LastModOn       = GETDATE(),
                       Imported        = 1
                WHERE  NearestHFID = @NearestHFID
                  AND  MonthID     = @MonthID
                  AND  YearID      = @YearID
            ELSE
                INSERT INTO PresumptiveCaseT (
                    PresumptiveCaseTID, PresumptiveCase, MonthID, YearID,
                    NearestHFID, DataSourceID, CountyID,
                    HasChanged, Uploaded, Imported, LastModOn, EnteredByID)
                VALUES (
                    NEWID(), @PresumptiveCase, @MonthID, @YearID,
                    @NearestHFID, @DataSourceID, @CountyID,
                    0, 0, 1, GETDATE(), '00000000-0000-0000-0000-000000000000')
            """;
        var sql = overwrite ? sqlUpsert : sqlInsertOnly;

        foreach (var c in cases)
        {
            if (c.MonthID <= 0 || c.YearID <= 0) continue;

            await using var cmd = new SqlCommand(sql, conn, tx);
            cmd.Parameters.AddWithValue("@NearestHFID",     c.NearestHFID);
            cmd.Parameters.AddWithValue("@MonthID",         c.MonthID);
            cmd.Parameters.AddWithValue("@YearID",          c.YearID);
            cmd.Parameters.AddWithValue("@PresumptiveCase", c.PresumptiveCase);
            cmd.Parameters.AddWithValue("@DataSourceID",    dataSourceId);
            cmd.Parameters.AddWithValue("@CountyID",        c.CountyID);
            var rows = await cmd.ExecuteNonQueryAsync(ct);
            inserted += rows;
        }

        return inserted;
    }
}
