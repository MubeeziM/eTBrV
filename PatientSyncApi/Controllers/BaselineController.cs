using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using PatientSyncApi.Models;
using System.Security.Claims;

namespace PatientSyncApi.Controllers;

/// <summary>
/// Manages facility-level ART baseline data.
///
/// SECURITY:
///   - [Authorize] on all endpoints — unauthenticated callers receive 401.
///   - Facility staff (facility_id claim > 0) are locked to their own facility.
///   - Write operations (PUT) require the caller to have write privileges
///     (facility staff or NGO field staff).
///   - All SQL uses parameterised queries — no string concatenation of user input.
/// </summary>
[ApiController]
[Route("api/baseline")]
[Authorize]
public sealed class BaselineController : ControllerBase
{
    // Column names for the 24 age-group × sex count fields.
    // Index n maps to ageGroup n/2, sex = n%2 (0=Male, 1=Female).
    private static readonly string[] CountColumns =
        Enumerable.Range(0, 12)
                  .SelectMany(ag => new[] { $"AgeGrp{ag}_M", $"AgeGrp{ag}_F" })
                  .ToArray();  // length = 24

    private static readonly string CountColumnList  = string.Join(", ", CountColumns);
    private static readonly string CountParamList   = string.Join(", ", Enumerable.Range(0, 24).Select(i => $"@C{i}"));
    private static readonly string CountSetClause   = string.Join(", ", CountColumns.Select((col, i) => $"{col} = @C{i}"));

    private readonly string _connectionString;
    private readonly ILogger<BaselineController> _logger;

    public BaselineController(
        IConfiguration config,
        ILogger<BaselineController> logger)
    {
        _connectionString = config.GetConnectionString("DefaultConnection")
            ?? throw new InvalidOperationException("DefaultConnection is not configured.");
        _logger = logger;
    }

    // ──────────────────────────────────────────────────────────────────────
    //  GET /api/baseline/{facilityId}
    //  Returns the baseline record for the facility, or 404 if not set.
    // ──────────────────────────────────────────────────────────────────────
    [HttpGet("{facilityId:int}")]
    public async Task<IActionResult> Get(int facilityId)
    {
        if (facilityId <= 0)
            return BadRequest(new { error = "Invalid facility ID." });

        if (!CanAccessFacility(facilityId))
            return Forbid();

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        var sql = $"""
            SELECT b.BaselineDate, {CountColumnList},
                   b.CTXTotal_M, b.CTXTotal_F, b.DapsoneTotal_M, b.DapsoneTotal_F,
                   b.StartedFromZero, b.Notes,
                   hf.HealthFacility
            FROM   FacilityBaselineT b
            JOIN   HealthFacilityT   hf ON hf.HealthFacilityID = b.HealthFacilityID
            WHERE  b.HealthFacilityID = @FacId
            """;

        await using var cmd = new SqlCommand(sql, conn);
        cmd.Parameters.AddWithValue("@FacId", facilityId);

        await using var rdr = await cmd.ExecuteReaderAsync();
        if (!await rdr.ReadAsync())
            return NotFound(new { error = "No baseline data found for this facility." });

        var dto = new FacilityBaselineDto
        {
            HealthFacilityID = facilityId,
            FacilityName     = rdr.GetString(rdr.GetOrdinal("HealthFacility")),
            BaselineDate     = DateOnly.FromDateTime(rdr.GetDateTime(rdr.GetOrdinal("BaselineDate")))
                                       .ToString("yyyy-MM-dd"),
            Counts           = new int[24],
            CTXTotalM        = rdr.GetInt32(rdr.GetOrdinal("CTXTotal_M")),
            CTXTotalF        = rdr.GetInt32(rdr.GetOrdinal("CTXTotal_F")),
            DapsoneTotalM    = rdr.GetInt32(rdr.GetOrdinal("DapsoneTotal_M")),
            DapsoneTotalF    = rdr.GetInt32(rdr.GetOrdinal("DapsoneTotal_F")),
            StartedFromZero  = rdr.GetBoolean(rdr.GetOrdinal("StartedFromZero")),
            Notes            = rdr.IsDBNull(rdr.GetOrdinal("Notes"))
                                   ? null
                                   : rdr.GetString(rdr.GetOrdinal("Notes")),
        };

        for (int i = 0; i < 24; i++)
            dto.Counts[i] = rdr.GetInt32(rdr.GetOrdinal(CountColumns[i]));

        return Ok(dto);
    }

    // ──────────────────────────────────────────────────────────────────────
    //  PUT /api/baseline/{facilityId}
    //  Creates or updates the baseline record for the facility.
    //  Write access: facility staff, NGO state/county field staff.
    // ──────────────────────────────────────────────────────────────────────
    [HttpPut("{facilityId:int}")]
    public async Task<IActionResult> Save(
        int facilityId,
        [FromBody] SaveBaselineRequest req)
    {
        if (facilityId <= 0)
            return BadRequest(new { error = "Invalid facility ID." });

        if (!CanAccessFacility(facilityId))
            return Forbid();

        if (!CanWrite())
            return StatusCode(403, new { error = "You do not have permission to save baseline data." });

        // Validate baseline date
        if (string.IsNullOrWhiteSpace(req.BaselineDate)
            || !DateOnly.TryParse(req.BaselineDate, out var bDate))
            return BadRequest(new { error = "BaselineDate must be a valid ISO date (yyyy-MM-dd)." });

        if (bDate.Year < 1990 || bDate.Year > 2100)
            return BadRequest(new { error = "BaselineDate is outside the expected range (1990–2100)." });

        // Validate counts
        if (req.Counts == null || req.Counts.Length != 24)
            return BadRequest(new { error = "Counts must be an array of exactly 24 non-negative integers." });

        if (req.Counts.Any(c => c < 0) || req.CTXTotalM < 0 || req.CTXTotalF < 0
            || req.DapsoneTotalM < 0 || req.DapsoneTotalF < 0)
            return BadRequest(new { error = "All counts must be non-negative." });

        // Sanitise notes — strip to null when empty
        var notes = string.IsNullOrWhiteSpace(req.Notes) ? null : req.Notes.Trim();
        if (notes?.Length > 500)
            return BadRequest(new { error = "Notes must be 500 characters or fewer." });

        // Resolve caller's TID for audit columns
        var userTidStr = User.FindFirstValue("sub");
        Guid? userTid  = Guid.TryParse(userTidStr, out var g) ? g : (Guid?)null;

        var sql = $"""
            MERGE FacilityBaselineT AS target
            USING (SELECT @FacId AS HealthFacilityID) AS source
              ON target.HealthFacilityID = source.HealthFacilityID
            WHEN MATCHED THEN
              UPDATE SET
                BaselineDate     = @BaselineDate,
                {CountSetClause},
                CTXTotal_M       = @CTXTotalM,
                CTXTotal_F       = @CTXTotalF,
                DapsoneTotal_M   = @DapsoneTotalM,
                DapsoneTotal_F   = @DapsoneTotalF,
                StartedFromZero  = @SFZ,
                Notes            = @Notes,
                LastModByUserTID = @UserTID,
                LastModOn        = GETDATE()
            WHEN NOT MATCHED THEN
              INSERT (HealthFacilityID, BaselineDate, {CountColumnList},
                      CTXTotal_M, CTXTotal_F, DapsoneTotal_M, DapsoneTotal_F,
                      StartedFromZero, Notes,
                      CreatedByUserTID, LastModByUserTID)
              VALUES (@FacId, @BaselineDate, {CountParamList},
                      @CTXTotalM, @CTXTotalF, @DapsoneTotalM, @DapsoneTotalF,
                      @SFZ, @Notes,
                      @UserTID, @UserTID);
            """;

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        await using var cmd = new SqlCommand(sql, conn);
        cmd.Parameters.AddWithValue("@FacId",       facilityId);
        cmd.Parameters.AddWithValue("@BaselineDate", bDate);
        cmd.Parameters.AddWithValue("@CTXTotalM",     req.CTXTotalM);
        cmd.Parameters.AddWithValue("@CTXTotalF",     req.CTXTotalF);
        cmd.Parameters.AddWithValue("@DapsoneTotalM", req.DapsoneTotalM);
        cmd.Parameters.AddWithValue("@DapsoneTotalF", req.DapsoneTotalF);
        cmd.Parameters.AddWithValue("@SFZ",          req.StartedFromZero);
        cmd.Parameters.AddWithValue("@Notes",        (object?)notes ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@UserTID",      (object?)userTid ?? DBNull.Value);

        for (int i = 0; i < 24; i++)
            cmd.Parameters.AddWithValue($"@C{i}", req.Counts[i]);

        await cmd.ExecuteNonQueryAsync();

        _logger.LogInformation(
            "Baseline saved for facility {FacId} (date={Date}) by {User}",
            facilityId, bDate,
            User.FindFirstValue(ClaimTypes.Name) ?? "unknown");

        return Ok(new { message = "Baseline data saved successfully." });
    }

    // ──────────────────────────────────────────────────────────────────────
    //  GET /api/baseline/check?facilityIds[]=n&startDate=YYYY-MM-DD
    //
    //  Pre-flight check before report generation.  Returns a list of warnings:
    //    "missing_baseline"      – facility has no baseline and StartedFromZero ≠ 1
    //    "period_before_baseline"– report period starts before the facility's baseline
    //    "outdated_baseline"     – patients in DB predate the baseline date
    // ──────────────────────────────────────────────────────────────────────
    [HttpGet("check")]
    public async Task<IActionResult> Check(
        [FromQuery] int[]? facilityIds,
        [FromQuery] string startDate = "")
    {
        var cleanIds = (facilityIds ?? []).Where(id => id > 0).Distinct().ToArray();
        if (cleanIds.Length == 0)
            return Ok(new { status = "ok", warnings = Array.Empty<BaselineWarning>() });

        DateOnly? periodStart = DateOnly.TryParse(startDate, out var ps) ? ps : null;

        // Build parameterised IN clause — never concatenate user values
        var paramNames = cleanIds.Select((_, i) => $"@FacId{i}").ToArray();
        var inClause   = string.Join(", ", paramNames);

        var sql = $"""
            SELECT hf.HealthFacilityID,
                   hf.HealthFacility,
                   b.BaselineDate,
                   b.StartedFromZero,
                   (
                       SELECT COUNT(*)
                       FROM   PtDetailsARTT p
                       WHERE  p.NearestHFID  = hf.HealthFacilityID
                         AND  p.Deleted      = 0
                         AND  p.ARTStartDate IS NOT NULL
                         AND  p.ARTStartDate <= b.BaselineDate
                   ) AS PatientsBeforeBaseline
            FROM   HealthFacilityT hf
            LEFT JOIN FacilityBaselineT b ON b.HealthFacilityID = hf.HealthFacilityID
            WHERE  hf.HealthFacilityID IN ({inClause})
            """;

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        await using var cmd = new SqlCommand(sql, conn);
        for (int i = 0; i < cleanIds.Length; i++)
            cmd.Parameters.AddWithValue($"@FacId{i}", cleanIds[i]);

        var warnings = new List<BaselineWarning>();

        await using var rdr = await cmd.ExecuteReaderAsync();
        while (await rdr.ReadAsync())
        {
            int    facId    = rdr.GetInt32(0);
            string facName  = rdr.GetString(1);
            bool   hasBase  = !rdr.IsDBNull(2);

            if (!hasBase)
            {
                // No baseline at all — warn unless StartedFromZero was set
                // (StartedFromZero can't be set without a baseline row, so if
                //  hasBase is false the facility simply has no record.)
                warnings.Add(new BaselineWarning
                {
                    Type         = "missing_baseline",
                    FacilityId   = facId,
                    FacilityName = facName,
                    Message      = $"{facName}: No baseline data has been configured. " +
                                   "Section (i) of the report may be incomplete or inaccurate.",
                });
                continue;
            }

            var  baselineDate         = DateOnly.FromDateTime(rdr.GetDateTime(2));
            bool startedFromZero      = rdr.GetBoolean(3);
            int  patientsBeforeBaseline = rdr.GetInt32(4);

            // Check report period vs baseline date
            if (periodStart.HasValue)
            {
                // prevEnd = day before periodStart; must be >= baselineDate for the
                // report to include any post-baseline data
                var prevEnd = periodStart.Value.AddDays(-1);
                if (prevEnd < baselineDate)
                {
                    warnings.Add(new BaselineWarning
                    {
                        Type         = "period_before_baseline",
                        FacilityId   = facId,
                        FacilityName = facName,
                        BaselineDate = baselineDate.ToString("yyyy-MM-dd"),
                        Message      = $"{facName}: The report period is before the baseline date " +
                                       $"({baselineDate:MMMM yyyy}). " +
                                       "Please configure an earlier baseline or choose a later report period.",
                    });
                    // Don't add outdated warning for same facility
                    continue;
                }
            }

            // Patients in DB predate the baseline — user may want to update it
            if (patientsBeforeBaseline > 0 && !startedFromZero)
            {
                warnings.Add(new BaselineWarning
                {
                    Type                   = "outdated_baseline",
                    FacilityId             = facId,
                    FacilityName           = facName,
                    BaselineDate           = baselineDate.ToString("yyyy-MM-dd"),
                    PatientsBeforeBaseline = patientsBeforeBaseline,
                    Message                = $"{facName}: {patientsBeforeBaseline} patient record(s) in the " +
                                             $"system predate the baseline ({baselineDate:MMMM yyyy}). " +
                                             "Consider updating the baseline to include this historical data.",
                });
            }
        }

        // Overall status: "error" if any warning blocks report generation,
        // "warning" for non-blocking issues, "ok" if all clear.
        string status = warnings.Any(w => w.Type == "period_before_baseline")
            ? "error"
            : warnings.Count > 0 ? "warning" : "ok";

        return Ok(new { status, warnings });
    }

    // ── Private helpers ───────────────────────────────────────────────────

    /// <summary>
    /// Returns false when a facility-scoped user tries to access another
    /// facility's data.  All other callers (county/state/national) are allowed
    /// to read any facility's baseline.
    /// </summary>
    private bool CanAccessFacility(int facilityId)
    {
        int.TryParse(User.FindFirstValue("facility_id"), out var userFacId);
        if (userFacId > 0 && userFacId != facilityId)
            return false;
        return true;
    }

    /// <summary>
    /// Mirrors the JS <c>userCanWrite()</c> logic:
    ///   - facility staff (facility_id > 0)
    ///   - NGO at state/county level (NGO role + StateCoordinator or CountySupervisor role)
    /// </summary>
    private bool CanWrite()
    {
        int.TryParse(User.FindFirstValue("facility_id"), out var facId);
        if (facId > 0) return true;

        bool isNgo   = User.IsInRole("NGO");
        bool isZonal = User.IsInRole("StateCoordinator");
        bool isDtls  = User.IsInRole("CountySupervisor");
        return isNgo && (isZonal || isDtls);
    }
}
