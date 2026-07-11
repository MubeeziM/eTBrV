using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using PatientSyncApi.Services;

namespace PatientSyncApi.Controllers;

/// <summary>
/// Endpoints for migrating legacy TB patient records into the new database.
///
/// SECURITY:
///   - All endpoints require a valid JWT ([Authorize]).
///   - The triggering user's GUID is recorded in MigratedFacilitiesT for audit.
///   - No legacy credentials or connection strings are ever returned to clients.
/// </summary>
[ApiController]
[Route("api/legacy-migration")]
[Authorize]
public sealed class LegacyMigrationController : ControllerBase
{
    private readonly IServiceScopeFactory        _scopeFactory;
    private readonly MigrationProgressService    _progressService;
    private readonly IConfiguration              _config;
    private readonly ILogger<LegacyMigrationController> _logger;

    public LegacyMigrationController(
        IServiceScopeFactory        scopeFactory,
        MigrationProgressService    progressService,
        IConfiguration              config,
        ILogger<LegacyMigrationController> logger)
    {
        _scopeFactory    = scopeFactory;
        _progressService = progressService;
        _config          = config;
        _logger          = logger;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GET /api/legacy-migration/facilities
    //  Returns all DataSourceIDs from legacy DB with patient counts and status.
    // ─────────────────────────────────────────────────────────────────────────
    [HttpGet("facilities")]
    public async Task<IActionResult> GetFacilities(CancellationToken ct)
    {
        var newConnStr    = _config.GetConnectionString("DefaultConnection")!;
        var legacyConnStr = _config.GetConnectionString("LegacyConnection")!;

        try
        {
            // Facility info from new DB — use vwGeogAreaQ which already filters
            // eTBrDHIS=1 and excludes training/special facilities (same as geo-tree).
            // DataSourceID == HealthFacilityID by design (see migrate_sync_datasource_from_facilities.sql).
            var facilityInfo = new Dictionary<int, (string Name, string County, string State, string StateShort)>();
            await using (var conn = new SqlConnection(newConnStr))
            {
                await conn.OpenAsync(ct);
                await using var cmd = conn.CreateCommand();
                cmd.CommandText = """
                    SELECT v.HealthFacilityID,
                           v.HealthFacility,
                           v.County,
                           COALESCE(v.State, '')      AS State,
                           COALESCE(s.StateShort, '') AS StateShort
                    FROM   vwGeogAreaQ v
                    LEFT JOIN StateT s ON s.StateID = v.StateID
                    """;
                await using var rdr = await cmd.ExecuteReaderAsync(ct);
                while (await rdr.ReadAsync(ct))
                    facilityInfo[rdr.GetInt32(0)] = (
                        rdr.IsDBNull(1) ? string.Empty : rdr.GetString(1),
                        rdr.IsDBNull(2) ? string.Empty : rdr.GetString(2),
                        rdr.IsDBNull(3) ? string.Empty : rdr.GetString(3),
                        rdr.IsDBNull(4) ? string.Empty : rdr.GetString(4)
                    );
            }

            // Already-migrated entries
            var migrated = new Dictionary<int, (DateTime migratedOn, int patients, int followUps, DateTime? lastDeltaSyncOn, int? lastDeltaSyncPatients, int? lastDeltaSyncFollowUps)>();
            await using (var conn = new SqlConnection(newConnStr))
            {
                await conn.OpenAsync(ct);
                await using var cmd = conn.CreateCommand();
                cmd.CommandText =
                    "SELECT DataSourceID, MigratedOn, PatientsImported, FollowUpsImported, " +
                    "LastDeltaSyncOn, LastDeltaSyncPatients, LastDeltaSyncFollowUps " +
                    "FROM MigratedFacilitiesT";
                await using var rdr = await cmd.ExecuteReaderAsync(ct);
                while (await rdr.ReadAsync(ct))
                    migrated[rdr.GetInt32(0)] = (
                        rdr.GetDateTime(1),
                        rdr.GetInt32(2),
                        rdr.GetInt32(3),
                        rdr.IsDBNull(4) ? (DateTime?)null : rdr.GetDateTime(4),
                        rdr.IsDBNull(5) ? (int?)null      : rdr.GetInt32(5),
                        rdr.IsDBNull(6) ? (int?)null      : rdr.GetInt32(6)
                    );
            }

            // Patient counts from legacy DB
            var legacyCounts = new Dictionary<int, int>();
            await using (var conn = new SqlConnection(legacyConnStr))
            {
                await conn.OpenAsync(ct);
                await using var cmd = conn.CreateCommand();
                cmd.CommandText =
                    "SELECT DataSourceID, COUNT(*) FROM PtDetailsT WHERE ISNULL(Deleted,0)=0 GROUP BY DataSourceID";
                await using var rdr = await cmd.ExecuteReaderAsync(ct);
                while (await rdr.ReadAsync(ct))
                    legacyCounts[rdr.GetInt32(0)] = rdr.GetInt32(1);
            }

            // Only include facilities that exist in HealthFacilityT (eTBrDHIS=1).
            // Legacy counts for IDs not in facilityInfo are silently excluded —
            // those are orphaned legacy entries with no matching new-DB facility.
            var rows = facilityInfo
                .Where(kv => legacyCounts.GetValueOrDefault(kv.Key, 0) > 0 || migrated.ContainsKey(kv.Key))
                .OrderBy(kv => kv.Value.State)
                .ThenBy(kv => kv.Value.County)
                .ThenBy(kv => kv.Value.Name)
                .Select(kv =>
                {
                    var id         = kv.Key;
                    var fi         = kv.Value;
                    var isMigrated = migrated.ContainsKey(id);
                    var progress   = _progressService.Get(id);
                    legacyCounts.TryGetValue(id, out var legacyCount);
                    return new
                    {
                        dataSourceId           = id,
                        facilityName           = fi.Name,
                        county                 = fi.County,
                        state                  = fi.State,
                        stateShort             = fi.StateShort,
                        legacyPatients         = legacyCount,
                        isMigrated,
                        migratedOn             = isMigrated ? (DateTime?)migrated[id].migratedOn         : null,
                        importedPatients       = isMigrated ? (int?)migrated[id].patients                : null,
                        importedFollowUps      = isMigrated ? (int?)migrated[id].followUps               : null,
                        lastDeltaSyncOn        = isMigrated ? migrated[id].lastDeltaSyncOn               : null,
                        lastDeltaSyncPatients  = isMigrated ? migrated[id].lastDeltaSyncPatients         : null,
                        lastDeltaSyncFollowUps = isMigrated ? migrated[id].lastDeltaSyncFollowUps        : null,
                        progressStatus         = progress.Status,
                        progressPct            = progress.Pct,
                        progressMsg            = progress.Message,
                    };
                })
                .ToList();

            return Ok(rows);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load facility list for migration management.");
            return StatusCode(500, new { error = "Could not load facility list. See server logs." });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  POST /api/legacy-migration/facility/{dataSourceId}
    //  Starts background import. Returns 202 immediately.
    //  Poll /facility/{id}/progress for live updates.
    // ─────────────────────────────────────────────────────────────────────────
    [HttpPost("facility/{dataSourceId:int}")]
    public async Task<IActionResult> MigrateFacility(
        int dataSourceId,
        CancellationToken ct)
    {
        if (dataSourceId <= 0)
            return BadRequest(new { error = "dataSourceId must be a positive integer." });

        var userGuid = GetCurrentUserGuid();

        // Guard: already migrated?
        using var checkScope = _scopeFactory.CreateScope();
        var checkSvc = checkScope.ServiceProvider.GetRequiredService<LegacyMigrationService>();
        if (await checkSvc.IsFacilityAlreadyMigratedAsync(dataSourceId, ct))
            return Conflict(new { error = $"DataSourceID {dataSourceId} has already been migrated." });

        // Guard: already running or queued?
        if (_progressService.Get(dataSourceId).Status is "running" or "queued")
            return Conflict(new { error = $"Migration for DataSourceID {dataSourceId} is already in progress or queued." });

        _logger.LogInformation(
            "Migration started (background): DataSourceID={DataSourceId}, RequestedBy={UserId}.",
            dataSourceId, userGuid);

        // Fire-and-forget — do NOT pass request CancellationToken to background job.
        _ = Task.Run(async () =>
        {
            _progressService.Update(dataSourceId, s => {
                s.Status  = "queued";
                s.Message = "Waiting for another migration to complete\u2026";
            });
            await _progressService.MigrationLock.WaitAsync();
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var svc = scope.ServiceProvider.GetRequiredService<LegacyMigrationService>();
                try
                {
                    await svc.MigrateFacilityAsync(dataSourceId, userGuid, CancellationToken.None);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex,
                        "Unhandled error in background migration for DataSourceID={DataSourceId}.", dataSourceId);
                    _progressService.Update(dataSourceId, s =>
                    {
                        s.Status  = "error";
                        s.Message = "Unexpected error. See server logs.";
                    });
                }
            }
            finally
            {
                _progressService.MigrationLock.Release();
            }
        });

        return Accepted(new
        {
            message      = $"Migration started for DataSourceID {dataSourceId}. Poll /progress for updates.",
            dataSourceId,
        });
    }

    // ─────────────────────────────────────────────────────────────────────────    //  POST /api/legacy-migration/facility/{dataSourceId}/delta
    //  Syncs records modified in the legacy DB after 2026-06-30.
    //  Requires the facility to be already fully migrated.
    //  Returns 202 immediately; poll /progress for live updates.
    // ───────────────────────────────────────────────────────────────────────────
    [HttpPost("facility/{dataSourceId:int}/delta")]
    public async Task<IActionResult> DeltaSyncFacility(
        int dataSourceId,
        CancellationToken ct)
    {
        if (dataSourceId <= 0)
            return BadRequest(new { error = "dataSourceId must be a positive integer." });

        var userGuid = GetCurrentUserGuid();

        // Guard: must be fully migrated first
        using var checkScope = _scopeFactory.CreateScope();
        var checkSvc = checkScope.ServiceProvider.GetRequiredService<LegacyMigrationService>();
        if (!await checkSvc.IsFacilityAlreadyMigratedAsync(dataSourceId, ct))
            return Conflict(new { error = $"DataSourceID {dataSourceId} has not been fully migrated yet. Run the full migration first." });

        // Guard: already running?
        var currentStatus = _progressService.Get(dataSourceId).Status;
        if (currentStatus is "running" or "delta-running" or "queued")
            return Conflict(new { error = $"A migration or delta sync for DataSourceID {dataSourceId} is already in progress or queued." });

        _logger.LogInformation(
            "Delta sync started (background): DataSourceID={DataSourceId}, RequestedBy={UserId}.",
            dataSourceId, userGuid);

        _ = Task.Run(async () =>
        {
            _progressService.Update(dataSourceId, s => {
                s.Status  = "queued";
                s.Message = "Waiting for another migration to complete\u2026";
            });
            await _progressService.MigrationLock.WaitAsync();
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var svc = scope.ServiceProvider.GetRequiredService<LegacyMigrationService>();
                try
                {
                    await svc.DeltaSyncFacilityAsync(dataSourceId, userGuid, CancellationToken.None);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex,
                        "Unhandled error in background delta sync for DataSourceID={DataSourceId}.", dataSourceId);
                    _progressService.Update(dataSourceId, s =>
                    {
                        s.Status  = "error";
                        s.Message = "Unexpected error during delta sync. See server logs.";
                    });
                }
            }
            finally
            {
                _progressService.MigrationLock.Release();
            }
        });

        return Accepted(new
        {
            message      = $"Delta sync started for DataSourceID {dataSourceId}. Poll /progress for updates.",
            dataSourceId,
        });
    }

    // ───────────────────────────────────────────────────────────────────────────    //  GET /api/legacy-migration/facility/{dataSourceId}/progress
    //  Returns live progress. Poll every 3 s while status == "running".
    // ─────────────────────────────────────────────────────────────────────────
    [HttpGet("facility/{dataSourceId:int}/progress")]
    public IActionResult GetProgress(int dataSourceId)
    {
        if (dataSourceId <= 0)
            return BadRequest(new { error = "dataSourceId must be a positive integer." });

        var p = _progressService.Get(dataSourceId);
        return Ok(new
        {
            dataSourceId,
            status            = p.Status,
            totalPatients     = p.TotalPatients,
            importedPatients  = p.ImportedPatients,
            importedFollowUps = p.ImportedFollowUps,
            pct               = p.Pct,
            message           = p.Message,
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  GET /api/legacy-migration/facility/{dataSourceId}/status
    //  Kept for backward compatibility with PowerShell test commands.
    // ─────────────────────────────────────────────────────────────────────────
    [HttpGet("facility/{dataSourceId:int}/status")]
    public async Task<IActionResult> GetFacilityStatus(
        int dataSourceId,
        CancellationToken ct)
    {
        if (dataSourceId <= 0)
            return BadRequest(new { error = "dataSourceId must be a positive integer." });

        using var scope = _scopeFactory.CreateScope();
        var svc = scope.ServiceProvider.GetRequiredService<LegacyMigrationService>();
        var isMigrated = await svc.IsFacilityAlreadyMigratedAsync(dataSourceId, ct);
        return Ok(new { dataSourceId, migrated = isMigrated });
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  POST /api/legacy-migration/facility/{dataSourceId}/undo
    //  (Also reachable via DELETE /api/legacy-migration/facility/{dataSourceId}
    //   for API clients that support DELETE.)
    //  Removes all legacy-imported records for a facility and resets its
    //  migration status. SuperUser-only. Intended for testing / rollback.
    //  The LegacyTID IS NOT NULL guard prevents accidental deletion of records
    //  entered directly in the new system.
    // ─────────────────────────────────────────────────────────────────────────
    [HttpPost("facility/{dataSourceId:int}/undo")]
    [HttpDelete("facility/{dataSourceId:int}")]
    [Authorize(Roles = "SuperUser")]
    public async Task<IActionResult> DeleteFacilityMigration(int dataSourceId, CancellationToken ct)
    {
        if (dataSourceId <= 0)
            return BadRequest(new { error = "dataSourceId must be a positive integer." });

        var connStr = _config.GetConnectionString("DefaultConnection")!;
        try
        {
            await using var conn = new SqlConnection(connStr);
            await conn.OpenAsync(ct);
            await using var tx = (SqlTransaction)await conn.BeginTransactionAsync(ct);

            // Delete follow-ups linked to legacy-imported patients of this facility
            await using var cmd1 = conn.CreateCommand();
            cmd1.Transaction = tx;
            cmd1.CommandText = """
                DELETE fu
                FROM   PtFollowUpT fu
                JOIN   PtDetailsT  pt ON fu.PtDetailsTID = pt.PtDetailsTID
                WHERE  pt.DataSourceID = @DataSourceID
                  AND  pt.LegacyTID IS NOT NULL
                """;
            cmd1.Parameters.AddWithValue("@DataSourceID", dataSourceId);
            var deletedFollowUps = await cmd1.ExecuteNonQueryAsync(ct);

            // Delete legacy-imported patients
            await using var cmd2 = conn.CreateCommand();
            cmd2.Transaction = tx;
            cmd2.CommandText = """
                DELETE FROM PtDetailsT
                WHERE DataSourceID = @DataSourceID
                  AND LegacyTID IS NOT NULL
                """;
            cmd2.Parameters.AddWithValue("@DataSourceID", dataSourceId);
            var deletedPatients = await cmd2.ExecuteNonQueryAsync(ct);

            // Remove migration marker so the facility can be re-migrated
            await using var cmd3 = conn.CreateCommand();
            cmd3.Transaction = tx;
            cmd3.CommandText =
                "DELETE FROM MigratedFacilitiesT WHERE DataSourceID = @DataSourceID";
            cmd3.Parameters.AddWithValue("@DataSourceID", dataSourceId);
            await cmd3.ExecuteNonQueryAsync(ct);

            await tx.CommitAsync(ct);

            // Reset in-memory progress state
            _progressService.Update(dataSourceId, s => {
                s.Status            = "idle";
                s.TotalPatients     = 0;
                s.ImportedPatients  = 0;
                s.ImportedFollowUps = 0;
                s.Message           = string.Empty;
            });

            _logger.LogInformation(
                "Migration removed: DataSourceID={DataSourceId}, patients={Patients}, followUps={FollowUps}.",
                dataSourceId, deletedPatients, deletedFollowUps);

            return Ok(new
            {
                message          = $"Removed {deletedPatients} patients and {deletedFollowUps} follow-ups.",
                deletedPatients,
                deletedFollowUps,
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to remove migration for DataSourceID={DataSourceId}.", dataSourceId);
            return StatusCode(500, new { error = "Delete failed. No data was changed." });
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private Guid GetCurrentUserGuid()
    {
        var raw = User.FindFirstValue(ClaimTypes.NameIdentifier)
               ?? User.FindFirstValue(JwtRegisteredClaimNames.Sub)
               ?? string.Empty;
        return Guid.TryParse(raw, out var g) ? g : Guid.Empty;
    }
}
